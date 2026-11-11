import { HttpError, str, int, randomToken } from "./http.js";
import { getSettings, parseExtras } from "./db.js";
import { DEFAULT_SETTINGS } from "./seed.js";

// ---------- Menu ----------
export async function adminMenu(env) {
  const categories = (await env.DB.prepare("SELECT * FROM categories ORDER BY sort,id").all()).results
    .map((c) => ({ ...c, extras: parseExtras(c.extras_json), extras_json: undefined }));
  const products = (await env.DB.prepare("SELECT * FROM products ORDER BY sort,id").all()).results;
  return { categories, products };
}

const cents = (v, label) => {
  const n = Math.round(Number(String(v).replace(",", ".")) * 100);
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new HttpError(label + " non valido");
  return n;
};

function cleanExtras(list) {
  if (!Array.isArray(list) || list.length > 40) throw new HttpError("Aggiunte non valide");
  return list.map((e) => ({ name: str(e?.name, "Nome aggiunta", { max: 60, required: true }), price_cents: cents(e?.price ?? e?.price_cents / 100, "Prezzo aggiunta") }));
}

export async function saveCategory(env, body) {
  const name = str(body.name, "Nome categoria", { max: 60, required: true });
  const description = str(body.description, "Descrizione", { max: 200 });
  const extras = JSON.stringify(cleanExtras(body.extras || []));
  const active = body.active === false ? 0 : 1, removable = body.removable === false ? 0 : 1;
  if (body.id) {
    const id = int(body.id, "Categoria", { min: 1 });
    await env.DB.prepare("UPDATE categories SET name=?,description=?,active=?,removable=?,extras_json=? WHERE id=?")
      .bind(name, description, active, removable, extras, id).run();
    return { ok: true, id };
  }
  const max = await env.DB.prepare("SELECT COALESCE(MAX(sort),0)+10 AS s FROM categories").first();
  const row = await env.DB.prepare("INSERT INTO categories(name,description,sort,active,removable,extras_json) VALUES(?,?,?,?,?,?) RETURNING id")
    .bind(name, description, max.s, active, removable, extras).first();
  return { ok: true, id: row.id };
}

export async function deleteCategory(env, id) {
  id = int(id, "Categoria", { min: 1 });
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE category_id=?").bind(id).first();
  if (n.n > 0) throw new HttpError("Sposta o elimina prima i prodotti di questa categoria", 409);
  await env.DB.prepare("DELETE FROM categories WHERE id=?").bind(id).run();
  return { ok: true };
}

export async function saveProduct(env, body) {
  const category_id = int(body.category_id, "Categoria", { min: 1 });
  if (!(await env.DB.prepare("SELECT id FROM categories WHERE id=?").bind(category_id).first())) throw new HttpError("Categoria inesistente");
  const name = str(body.name, "Nome prodotto", { max: 80, required: true });
  const description = str(body.description, "Ingredienti", { max: 400 });
  const price = cents(body.price, "Prezzo");
  const tags = (Array.isArray(body.tags) ? body.tags : String(body.tags || "").split(","))
    .map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 6).map((t) => t.slice(0, 24)).join(",");
  let image_id = body.image_id || null;
  if (image_id !== null && !/^[a-f0-9]{32}$/.test(image_id)) throw new HttpError("Immagine non valida");
  const active = body.active === false ? 0 : 1, available = body.available === false ? 0 : 1;
  if (body.id) {
    const id = int(body.id, "Prodotto", { min: 1 });
    const old = await env.DB.prepare("SELECT category_id,image_id FROM products WHERE id=?").bind(id).first();
    if (!old) throw new HttpError("Prodotto non trovato", 404);
    const stmts = [env.DB.prepare("UPDATE products SET category_id=?,name=?,description=?,price_cents=?,tags=?,image_id=?,active=?,available=? WHERE id=?")
      .bind(category_id, name, description, price, tags, image_id, active, available, id)];
    if (old.category_id !== category_id)
      stmts.push(env.DB.prepare("UPDATE products SET sort=(SELECT COALESCE(MAX(sort),0)+10 FROM products WHERE category_id=?) WHERE id=?").bind(category_id, id));
    if (old.image_id && old.image_id !== image_id) stmts.push(env.DB.prepare("DELETE FROM images WHERE id=?").bind(old.image_id));
    await env.DB.batch(stmts);
    return { ok: true, id };
  }
  const row = await env.DB.prepare(`INSERT INTO products(category_id,name,description,price_cents,tags,image_id,active,available,sort,created_at)
    VALUES(?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+10 FROM products WHERE category_id=?),?) RETURNING id`)
    .bind(category_id, name, description, price, tags, image_id, active, available, category_id, Date.now()).first();
  return { ok: true, id: row.id };
}

export async function patchProduct(env, body) {
  const id = int(body.id, "Prodotto", { min: 1 });
  const fields = [];
  const values = [];
  if (typeof body.available === "boolean") { fields.push("available=?"); values.push(body.available ? 1 : 0); }
  if (typeof body.active === "boolean") { fields.push("active=?"); values.push(body.active ? 1 : 0); }
  if (!fields.length) throw new HttpError("Nessuna modifica");
  await env.DB.prepare(`UPDATE products SET ${fields.join(",")} WHERE id=?`).bind(...values, id).run();
  return { ok: true };
}

export async function deleteProduct(env, id) {
  id = int(id, "Prodotto", { min: 1 });
  const p = await env.DB.prepare("SELECT image_id FROM products WHERE id=?").bind(id).first();
  const stmts = [env.DB.prepare("DELETE FROM products WHERE id=?").bind(id)];
  if (p?.image_id) stmts.push(env.DB.prepare("DELETE FROM images WHERE id=?").bind(p.image_id));
  await env.DB.batch(stmts);
  return { ok: true };
}

export async function reorder(env, body) {
  const table = body.type === "categories" ? "categories" : body.type === "products" ? "products" : null;
  if (!table || !Array.isArray(body.ids) || body.ids.length > 300) throw new HttpError("Ordinamento non valido");
  await env.DB.batch(body.ids.map((id, i) => env.DB.prepare(`UPDATE ${table} SET sort=? WHERE id=?`).bind((i + 1) * 10, int(id, "ID", { min: 1 }))));
  return { ok: true };
}

// ---------- Immagini (salvate in D1, già ridimensionate dal browser) ----------
export async function uploadImage(env, body) {
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ""));
  if (!m) throw new HttpError("Formato immagine non supportato");
  const bin = atob(m[2]);
  if (bin.length > 900 * 1024) throw new HttpError("Immagine troppo pesante");
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const id = randomToken(16);
  await env.DB.prepare("INSERT INTO images(id,mime,data,created_at) VALUES(?,?,?,?)").bind(id, m[1], bytes, Date.now()).run();
  return { ok: true, id };
}

export async function serveImage(env, id) {
  if (!/^[a-f0-9]{32}$/.test(id)) return new Response("Not found", { status: 404 });
  const row = await env.DB.prepare("SELECT mime,data FROM images WHERE id=?").bind(id).first();
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(row.data), {
    headers: { "Content-Type": row.mime, "Cache-Control": "public, max-age=31536000, immutable" },
  });
}

// ---------- Impostazioni ----------
const VALIDATORS = {
  ordering_paused: "bool", takeaway_enabled: "bool", delivery_enabled: "bool", payment_cash: "bool", payment_pos: "bool", sound_enabled: "bool",
  pause_message: 200, delivery_area: 300, announcement: 200, shop_phone: 30, shop_whatsapp: 30, shop_address: 160, shop_email: 120,
  instagram_url: 200, facebook_url: 200,
  delivery_fee_cents: [0, 5000], delivery_min_cents: [0, 20000], free_delivery_over_cents: [0, 50000],
  prep_minutes: [5, 180], delivery_minutes: [10, 240], slot_minutes: [5, 60], slot_capacity: [0, 200], online_discount_percent: [0, 50],
};

export async function saveSettings(env, body) {
  const stmts = [];
  for (const [key, value] of Object.entries(body)) {
    const rule = VALIDATORS[key];
    let v;
    if (key === "hours") {
      if (!value || typeof value !== "object") throw new HttpError("Orari non validi");
      v = {};
      for (let d = 0; d < 7; d++) {
        const list = value[d] || [];
        if (!Array.isArray(list) || list.length > 3) throw new HttpError("Orari non validi");
        v[d] = list.map((r) => {
          if (!Array.isArray(r) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r[0]) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r[1]))
            throw new HttpError("Formato orario non valido (usa HH:MM)");
          return [r[0], r[1]];
        });
      }
    } else if (key === "closed_dates") {
      if (!Array.isArray(value) || value.length > 120 || value.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw new HttpError("Date di chiusura non valide");
      v = [...new Set(value)].sort();
    } else if (rule === "bool") {
      v = !!value;
    } else if (typeof rule === "number") {
      v = str(value, key, { max: rule });
      if (key.endsWith("_url") && v && !/^https:\/\/[^\s]+$/.test(v)) throw new HttpError("Il link deve iniziare con https://");
    } else if (Array.isArray(rule)) {
      v = int(value, key, { min: rule[0], max: rule[1] });
    } else continue; // chiave sconosciuta: ignorata
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").bind(key, JSON.stringify(v)));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, settings: await getSettings(env) };
}

export const defaultKeys = Object.keys(DEFAULT_SETTINGS);

// ---------- Clienti ----------
export async function customers(env, url) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 60);
  const page = Math.max(1, Math.min(1000, Number(url.searchParams.get("page")) || 1));
  const sort = { recenti: "last_at DESC", ordini: "order_count DESC", spesa: "spent_cents DESC" }[url.searchParams.get("sort")] || "last_at DESC";
  const where = q ? "WHERE name LIKE ? OR phone LIKE ?" : "";
  const args = q ? [`%${q}%`, `%${q.replace(/[^\d+]/g, "") || q}%`] : [];
  const rows = (await env.DB.prepare(`SELECT * FROM customers ${where} ORDER BY ${sort} LIMIT 50 OFFSET ?`).bind(...args, (page - 1) * 50).all()).results;
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM customers ${where}`).bind(...args).first();
  return { customers: rows, total: total.n, page };
}

export async function customersCsv(env) {
  const rows = (await env.DB.prepare("SELECT * FROM customers ORDER BY last_at DESC").all()).results;
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // niente formule in Excel
    return `"${s.replace(/"/g, '""')}"`;
  };
  const date = (ms) => new Date(ms).toLocaleDateString("it-IT", { timeZone: "Europe/Rome" });
  const lines = [["Nome", "Telefono", "Indirizzo", "Ordini", "Spesa totale €", "Primo ordine", "Ultimo ordine"].map(cell).join(";")];
  for (const r of rows)
    lines.push([r.name, r.phone, r.address, r.order_count, (r.spent_cents / 100).toFixed(2).replace(".", ","), date(r.first_at), date(r.last_at)].map(cell).join(";"));
  return new Response("﻿" + lines.join("\r\n"), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="clienti-feras.csv"', "Cache-Control": "no-store" },
  });
}
