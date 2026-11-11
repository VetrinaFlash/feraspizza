import { SEED_MENU, DEFAULT_SETTINGS } from "./seed.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    removable INTEGER NOT NULL DEFAULT 1,
    extras_json TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL,
    image_id TEXT,
    tags TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    available INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS products_cat_idx ON products(category_id, sort)`,
  `CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    number INTEGER NOT NULL,
    day TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    order_type TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    slot TEXT NOT NULL,
    items_json TEXT NOT NULL,
    subtotal_cents INTEGER NOT NULL,
    discount_cents INTEGER NOT NULL DEFAULT 0,
    delivery_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL,
    payment TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'nuovo',
    cancel_reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS orders_day_idx ON orders(day, number)`,
  `CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS customers (
    phone TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    order_count INTEGER NOT NULL DEFAULT 0,
    spent_cents INTEGER NOT NULL DEFAULT 0,
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admin_credentials (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY, origin TEXT NOT NULL, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, label TEXT NOT NULL DEFAULT '',
    created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, last_error TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS push_events (
    id TEXT PRIMARY KEY, origin TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, target TEXT NOT NULL,
    created_ms INTEGER NOT NULL, delivered_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_ms INTEGER NOT NULL DEFAULT 0, claim_until_ms INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS push_deliveries (
    event_id TEXT NOT NULL, subscription_id TEXT NOT NULL, sent_ms INTEGER NOT NULL, PRIMARY KEY(event_id, subscription_id)
  )`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

const ready = new WeakMap();

/** Crea le tabelle e, solo la prima volta, inserisce menu e impostazioni. Idempotente. */
export function ensureDb(env) {
  if (!env.DB) throw new Error("Binding D1 'DB' mancante");
  if (ready.has(env.DB)) return ready.get(env.DB);
  const work = (async () => {
    await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
    const seeded = await env.DB.prepare("SELECT value FROM meta WHERE key='seeded'").first();
    if (seeded) return;
    const stmts = [];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS))
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)").bind(key, JSON.stringify(value)));
    await env.DB.batch(stmts);
    const now = Date.now();
    let catSort = 0;
    for (const cat of SEED_MENU) {
      const row = await env.DB.prepare(
        "INSERT INTO categories(name,description,sort,removable) VALUES(?,?,?,?) RETURNING id",
      ).bind(cat.name, cat.description || "", (catSort += 10), cat.removable === false ? 0 : 1).first();
      let sort = 0;
      await env.DB.batch(
        cat.products.map(([name, desc, price, tags]) =>
          env.DB.prepare(
            "INSERT INTO products(category_id,name,description,price_cents,tags,sort,created_at) VALUES(?,?,?,?,?,?,?)",
          ).bind(row.id, name, desc, Math.round(price * 100), tags, (sort += 10), now),
        ),
      );
    }
    await env.DB.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('seeded',?)").bind(String(now)).run();
  })();
  ready.set(env.DB, work);
  work.catch(() => ready.delete(env.DB));
  return work;
}

export async function getSettings(env) {
  const rows = (await env.DB.prepare("SELECT key,value FROM settings").all()).results || [];
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { /* valore corrotto: resta il default */ }
  }
  return out;
}

export const PUBLIC_SETTING_KEYS = [
  "ordering_paused", "pause_message", "hours", "closed_dates", "takeaway_enabled", "delivery_enabled",
  "delivery_fee_cents", "delivery_min_cents", "free_delivery_over_cents", "delivery_area", "prep_minutes",
  "delivery_minutes", "online_discount_percent", "payment_cash", "payment_pos", "announcement",
  "shop_phone", "shop_whatsapp", "shop_address", "shop_email", "instagram_url", "facebook_url",
];

export const ingredientsOf = (description) =>
  String(description || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s.length <= 60 && !/^lattina$/i.test(s));

export function parseExtras(value) {
  try {
    const list = JSON.parse(value || "[]");
    return Array.isArray(list)
      ? list.filter((e) => e && typeof e.name === "string" && Number.isInteger(e.price_cents))
      : [];
  } catch {
    return [];
  }
}
