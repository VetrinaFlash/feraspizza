import { HttpError, json, readJson } from "./lib/http.js";
import { ensureDb, getSettings } from "./lib/db.js";
import { currentAdmin, login, logout, changePassword, rateLimit } from "./lib/auth.js";
import { publicMenu, publicConfig, createOrder, orderForCustomer, adminOrders, updateOrderStatus, stats } from "./lib/orders.js";
import {
  adminMenu, saveCategory, deleteCategory, saveProduct, patchProduct, deleteProduct, reorder,
  uploadImage, serveImage, saveSettings, customers, customersCsv,
} from "./lib/admin.js";
import { runPendingPush, registerDevice, unregisterDevice, sendTest, pushStatus } from "./lib/push.js";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "font-src 'self'; img-src 'self' data: blob: https:; connect-src 'self'; " +
    "frame-src https://www.google.com https://maps.google.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

const MAX_BODY = { "/api/admin/images": 1_400_000 };

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Non servire mai sorgenti o file di configurazione.
  if (/^\/(?:src|scripts|node_modules|\.git)(?:\/|$)|\.(?:toml|sql|md)$/i.test(path))
    return new Response("Not found", { status: 404 });

  if (path.startsWith("/img/")) {
    await ensureDb(env);
    return serveImage(env, path.slice(5));
  }

  if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

  // ---- Protezioni comuni per le API ----
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new HttpError("Metodo non consentito", 405);
  if (method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) throw new HttpError("Origine non autorizzata", 403);
    const limit = MAX_BODY[path] || 64 * 1024;
    if (Number(request.headers.get("Content-Length") || 0) > limit) throw new HttpError("Richiesta troppo grande", 413);
    if (method !== "DELETE" && !/^application\/json\b/i.test(request.headers.get("Content-Type") || ""))
      throw new HttpError("Richiesto application/json", 415);
  }

  await ensureDb(env);

  // ---- API pubbliche ----
  if (path === "/api/config" && method === "GET") return json(await publicConfig(env));
  if (path === "/api/menu" && method === "GET") return json(await publicMenu(env), 200, { "Cache-Control": "no-cache" });
  if (path === "/api/orders" && method === "POST") {
    if (!(await rateLimit(env, request, "order", 30, 600))) throw new HttpError("Troppi ordini in poco tempo. Chiamaci per completare.", 429);
    const result = await createOrder(env, await readJson(request), url.origin);
    ctx.waitUntil(runPendingPush(env).catch((e) => console.error("push", e?.name)));
    return json({ ok: true, ...result });
  }
  if (path === "/api/order" && method === "GET")
    return json(await orderForCustomer(env, url.searchParams.get("id"), url.searchParams.get("t")));

  // ---- Admin ----
  if (path === "/api/admin/login" && method === "POST") return login(env, request);
  if (path === "/api/admin/logout" && method === "POST") return logout(env, request);

  if (!path.startsWith("/api/admin/")) throw new HttpError("Non trovato", 404);
  const admin = await currentAdmin(env, request);
  if (!admin) throw new HttpError("Accesso richiesto", 401);

  const body = () => readJson(request);
  const key = method + " " + path.slice("/api/admin".length);
  switch (key) {
    case "GET /me": return json({ ok: true, username: admin.username });
    case "POST /password": return changePassword(env, request, admin);

    case "GET /orders": return json(await adminOrders(env, url));
    case "PATCH /orders": return json(await updateOrderStatus(env, await body()));

    case "GET /menu": return json(await adminMenu(env));
    case "POST /categories": return json(await saveCategory(env, await body()));
    case "DELETE /categories": return json(await deleteCategory(env, url.searchParams.get("id")));
    case "POST /products": return json(await saveProduct(env, await body()));
    case "PATCH /products": return json(await patchProduct(env, await body()));
    case "DELETE /products": return json(await deleteProduct(env, url.searchParams.get("id")));
    case "POST /reorder": return json(await reorder(env, await body()));
    case "POST /images": return json(await uploadImage(env, await body()));

    case "GET /settings": return json({ settings: await getSettings(env) });
    case "PUT /settings": return json(await saveSettings(env, await body()));

    case "GET /customers": return json(await customers(env, url));
    case "GET /customers.csv": return customersCsv(env);
    case "GET /stats": return json(await stats(env, url));

    case "GET /push": return json(await pushStatus(env, url.origin));
    case "POST /push": {
      const b = await body();
      try {
        if (b.action === "subscribe") return json(await registerDevice(env, url.origin, b.subscription, b.label));
        if (b.action === "unsubscribe") return json(await unregisterDevice(env, b.endpoint));
        if (b.action === "test") return json(await sendTest(env, url.origin, b.endpoint));
      } catch (e) {
        throw new HttpError(String(e?.message || "Errore notifiche").slice(0, 160), 400);
      }
      throw new HttpError("Operazione non valida");
    }
  }
  throw new HttpError("Non trovato", 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.protocol === "http:" && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) {
      url.protocol = "https:";
      return Response.redirect(url.href, 308);
    }
    let response;
    try {
      response = await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) response = json({ ok: false, error: e.message }, e.status);
      else {
        console.error("Errore richiesta", url.pathname, e?.name, e?.message);
        response = json({ ok: false, error: "Errore temporaneo del servizio. Riprova." }, 500);
      }
    }
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    if (/^\/(admin|api\/admin)/.test(url.pathname)) headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureDb(env);
      await runPendingPush(env);
    })());
  },
};
