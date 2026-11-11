/*
 * Web Push con WebCrypto (RFC 8291 / RFC 8292), nessun servizio esterno a pagamento.
 * Derivato dall'implementazione N'Farinati. La consegna conferma l'accettazione
 * da parte del servizio push del browser, non la visualizzazione sul telefono.
 */
import { sha256 } from "./http.js";

const enc = new TextEncoder();
const ALLOWED = /^(?:fcm(?:-[a-z0-9]+)?\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|(?:[a-z0-9-]+\.)?push\.apple\.com|(?:[a-z0-9-]+\.)?notify\.windows\.com)$/i;

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const decode = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length > 512)
    throw Error("Chiave Web Push non valida");
  const v = value.replace(/=+$/, "");
  const s = atob(v.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(v.length / 4) * 4, "="));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const keyOk = (value, length, uncompressed = false) => {
  try {
    const b = decode(String(value || "").trim());
    return b.length === length && (!uncompressed || b[0] === 4);
  } catch { return false; }
};

export const pushConfigured = (env) => keyOk(env.VAPID_PUBLIC_KEY, 65, true) && keyOk(env.VAPID_PRIVATE_KEY, 32);

export function allowedEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.hash &&
      endpoint.length <= 2048 && ALLOWED.test(u.hostname);
  } catch { return false; }
}

function validate(sub) {
  if (!sub || typeof sub !== "object" || !allowedEndpoint(sub.endpoint)) throw Error("Servizio push non supportato da questo browser");
  const p = decode(sub.keys?.p256dh), a = decode(sub.keys?.auth);
  if (p.length !== 65 || p[0] !== 4 || a.length !== 16) throw Error("Chiavi push del dispositivo non valide");
  return { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth };
}

export async function buildPushRequest(message, sub, env, now = Date.now()) {
  const vapidPublic = decode(env.VAPID_PUBLIC_KEY.trim()), vapidPrivate = decode(env.VAPID_PRIVATE_KEY.trim());
  const userPublic = decode(sub.p256dh), authSecret = decode(sub.auth);
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const remote = await crypto.subtle.importKey("raw", userPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: remote }, pair.privateKey, 256));
  const sharedKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF", hash: "SHA-256", salt: authSecret,
    info: concat(enc.encode("WebPush: info\0"), userPublic, localPublic),
  }, sharedKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cek = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("Content-Encoding: aes128gcm\0") }, ikmKey, 128);
  const nonce = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("Content-Encoding: nonce\0") }, ikmKey, 96);
  const plain = concat(enc.encode(JSON.stringify(message)), Uint8Array.of(2));
  const aes = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, plain));
  const body = concat(salt, new Uint8Array([0, 0, 16, 0, 65]), localPublic, cipher);

  const signKey = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", x: b64url(vapidPublic.slice(1, 33)), y: b64url(vapidPublic.slice(33, 65)), d: b64url(vapidPrivate), ext: false,
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(sub.endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "mailto:admin@example.com",
  })));
  const signed = header + "." + claims;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signKey, enc.encode(signed)));
  return {
    url: sub.endpoint,
    init: {
      method: "POST",
      headers: {
        Authorization: `vapid t=${signed}.${b64url(sig)}, k=${b64url(vapidPublic)}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "3600",
        Urgency: "high",
      },
      body,
    },
  };
}

export async function registerDevice(env, origin, raw, label = "") {
  const sub = validate(raw);
  const id = await sha256(sub.endpoint), now = Date.now();
  await env.DB.prepare(`INSERT INTO push_subscriptions(id,origin,endpoint,p256dh,auth,active,label,created_ms,updated_ms)
    VALUES(?,?,?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET origin=excluded.origin,p256dh=excluded.p256dh,
    auth=excluded.auth,active=1,label=excluded.label,updated_ms=excluded.updated_ms,last_error=''`)
    .bind(id, origin, sub.endpoint, sub.p256dh, sub.auth, String(label).slice(0, 80), now, now).run();
  return { ok: true };
}

export async function unregisterDevice(env, endpoint) {
  if (!allowedEndpoint(endpoint)) throw Error("Dispositivo non valido");
  await env.DB.prepare("UPDATE push_subscriptions SET active=0,updated_ms=? WHERE id=?").bind(Date.now(), await sha256(endpoint)).run();
  return { ok: true };
}

export async function enqueuePush(env, origin, { id, title, body, target }) {
  await env.DB.prepare("INSERT OR IGNORE INTO push_events(id,origin,title,body,target,created_ms) VALUES(?,?,?,?,?,?)")
    .bind(id, origin, String(title).slice(0, 110), String(body).slice(0, 240), target, Date.now()).run();
}

/** Invia gli eventi in coda (massimo 15 minuti di vita: un ordine vecchio non va più notificato). */
export async function runPendingPush(env, { now = Date.now(), fetcher = fetch } = {}) {
  if (!pushConfigured(env)) return { sent: 0, reason: "vapid_missing" };
  const claimed = (await env.DB.prepare(`UPDATE push_events SET claim_until_ms=?,attempts=attempts+1
    WHERE id IN (SELECT id FROM push_events WHERE delivered_ms IS NULL AND next_attempt_ms<=? AND claim_until_ms<?
    AND created_ms>? ORDER BY created_ms LIMIT 10) RETURNING *`)
    .bind(now + 60000, now, now, now - 15 * 60000).all()).results || [];
  let sent = 0;
  for (const ev of claimed) {
    const subs = (await env.DB.prepare("SELECT id,endpoint,p256dh,auth FROM push_subscriptions WHERE origin=? AND active=1")
      .bind(ev.origin).all()).results || [];
    let errors = 0;
    for (const sub of subs) {
      const done = await env.DB.prepare("SELECT 1 FROM push_deliveries WHERE event_id=? AND subscription_id=?").bind(ev.id, sub.id).first();
      if (done) continue;
      try {
        const { url, init } = await buildPushRequest(
          { kind: "order", title: ev.title, body: ev.body, url: ev.target, eventId: ev.id }, sub, env, now);
        const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(6500) });
        if (res.status === 404 || res.status === 410) {
          await env.DB.prepare("UPDATE push_subscriptions SET active=0,last_error=? WHERE id=?").bind("scaduta " + res.status, sub.id).run();
          continue;
        }
        if (!res.ok) {
          errors++;
          await env.DB.prepare("UPDATE push_subscriptions SET last_error=? WHERE id=?").bind("provider " + res.status, sub.id).run();
          continue;
        }
        await env.DB.prepare("INSERT OR IGNORE INTO push_deliveries(event_id,subscription_id,sent_ms) VALUES(?,?,?)").bind(ev.id, sub.id, now).run();
        sent++;
      } catch (e) {
        errors++;
        console.error("push failed", e?.name);
      }
    }
    if (!errors) await env.DB.prepare("UPDATE push_events SET delivered_ms=?,claim_until_ms=0 WHERE id=?").bind(now, ev.id).run();
    else await env.DB.prepare("UPDATE push_events SET claim_until_ms=0,next_attempt_ms=?,last_error='retry' WHERE id=?")
      .bind(now + Math.min(600000, 15000 * 2 ** Math.min(ev.attempts, 6)), ev.id).run();
  }
  return { sent, processed: claimed.length };
}

export async function sendTest(env, origin, endpoint) {
  if (!pushConfigured(env)) throw Error("Chiavi VAPID non configurate su Cloudflare");
  if (!allowedEndpoint(endpoint)) throw Error("Dispositivo non valido");
  const sub = await env.DB.prepare("SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE id=? AND active=1")
    .bind(await sha256(endpoint)).first();
  if (!sub) throw Error("Questo dispositivo non è attivo per le notifiche");
  const { url, init } = await buildPushRequest({
    kind: "test", title: "🔔 Prova notifiche Fera's", body: "Le notifiche dei nuovi ordini arriveranno così.",
    url: "/admin.html", eventId: "test-" + crypto.randomUUID(),
  }, sub, env);
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(6500) });
  if (!res.ok) throw Error("Servizio push non disponibile (" + res.status + ")");
  return { ok: true };
}

export async function pushStatus(env, origin) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE origin=? AND active=1").bind(origin).first();
  return {
    configured: pushConfigured(env),
    publicKey: pushConfigured(env) ? env.VAPID_PUBLIC_KEY.trim() : null,
    devices: Number(row?.n || 0),
  };
}
