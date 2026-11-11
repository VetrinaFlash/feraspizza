import { HttpError, json, readJson, sha256, randomToken } from "./http.js";

export const ADMIN_USER = "FERAS";
// Hash della password iniziale (la password in chiaro NON è nel repository).
// Si usa solo finché non esiste una password salvata in D1; poi si cambia dal pannello.
const BOOTSTRAP_HASH = "pbkdf2-sha256$100000$522569a9ef8bd2a341b82f82a752e503$09fbdcd4dca151a3c8182cb5d7a2fbcbaec4bfc5d89b0e71b5026106c62aec51";
const COOKIE = "__Host-feras_admin";
const TTL_MS = 365 * 24 * 3600 * 1000; // dispositivo fidato: un anno, rinnovato con l'uso
const RENEW_MS = 30 * 24 * 3600 * 1000;
const ITER = 100000;

async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", iterations: ITER, salt: new TextEncoder().encode(salt) }, key, 256);
  return [...new Uint8Array(bits)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password) {
  const salt = randomToken(16);
  return `pbkdf2-sha256$${ITER}$${salt}$${await pbkdf2(password, salt)}`;
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function verify(password, encoded) {
  const [alg, iter, salt, hash] = String(encoded).split("$");
  if (alg !== "pbkdf2-sha256" || Number(iter) !== ITER || !salt) return false;
  return safeEqual(await pbkdf2(password, salt), hash || "");
}

const tokenFrom = (request) => {
  const entry = (request.headers.get("Cookie") || "").split(";").map((s) => s.trim())
    .find((s) => s.startsWith(COOKIE + "="));
  const t = entry ? entry.slice(COOKIE.length + 1) : "";
  return /^[a-f0-9]{64}$/.test(t) ? t : null;
};

const cookie = (token, maxAgeSec) =>
  `${COOKIE}=${token}; HttpOnly; Secure; Path=/; Max-Age=${maxAgeSec}; SameSite=Strict`;

export async function currentAdmin(env, request) {
  const token = tokenFrom(request);
  if (!token) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare("SELECT username,expires_at FROM admin_sessions WHERE token_hash=?").bind(hash).first();
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at <= now) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(hash).run();
    return null;
  }
  if (row.expires_at - now < RENEW_MS)
    await env.DB.prepare("UPDATE admin_sessions SET expires_at=? WHERE token_hash=?").bind(now + TTL_MS, hash).run();
  return { username: row.username };
}

export async function rateLimit(env, request, scope, limit, seconds) {
  const now = Date.now();
  const win = Math.floor(now / (seconds * 1000));
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const key = await sha256(`${scope}:${ip}:${win}`);
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits(key,hits,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits",
  ).bind(key, (win + 1) * seconds * 1000).first();
  if (Math.random() < 0.05)
    await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at<?").bind(now).run();
  return row.hits <= limit;
}

export async function login(env, request) {
  if (!(await rateLimit(env, request, "login", 10, 900)))
    throw new HttpError("Troppi tentativi. Riprova tra 15 minuti.", 429);
  const body = await readJson(request);
  const username = typeof body.username === "string" ? body.username.trim().toUpperCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || username.length > 60 || !password || password.length > 200)
    throw new HttpError("Utente o password errati", 401);

  const row = await env.DB.prepare("SELECT password_hash FROM admin_credentials WHERE username=?").bind(username).first();
  let ok = false;
  if (row) ok = await verify(password, row.password_hash);
  else if (username === ADMIN_USER) {
    // Primo accesso: secret ADMIN_PASSWORD se impostato, altrimenti la password iniziale; poi salvata come hash in D1.
    ok = env.ADMIN_PASSWORD ? safeEqual(password, String(env.ADMIN_PASSWORD)) : await verify(password, BOOTSTRAP_HASH);
    if (ok)
      await env.DB.prepare("INSERT OR IGNORE INTO admin_credentials(username,password_hash) VALUES(?,?)")
        .bind(ADMIN_USER, await hashPassword(password)).run();
  }
  if (!ok) throw new HttpError("Utente o password errati", 401);

  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO admin_sessions(token_hash,username,expires_at,created_at) VALUES(?,?,?,?)")
    .bind(await sha256(token), username, now + TTL_MS, now).run();
  return json({ ok: true }, 200, { "Set-Cookie": cookie(token, TTL_MS / 1000) });
}

export async function logout(env, request) {
  const token = tokenFrom(request);
  if (token) await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(await sha256(token)).run();
  return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
}

export async function changePassword(env, request, admin) {
  const body = await readJson(request);
  const current = String(body.current || ""), next = String(body.next || "");
  if (next.length < 8 || next.length > 200) throw new HttpError("La nuova password deve avere almeno 8 caratteri");
  const row = await env.DB.prepare("SELECT password_hash FROM admin_credentials WHERE username=?").bind(admin.username).first();
  if (!row || !(await verify(current, row.password_hash))) throw new HttpError("La password attuale non è corretta", 403);
  const keep = await sha256(tokenFrom(request) || "");
  await env.DB.batch([
    env.DB.prepare("UPDATE admin_credentials SET password_hash=? WHERE username=?").bind(await hashPassword(next), admin.username),
    // Disconnette tutti gli altri dispositivi.
    env.DB.prepare("DELETE FROM admin_sessions WHERE username=? AND token_hash<>?").bind(admin.username, keep),
  ]);
  return json({ ok: true });
}
