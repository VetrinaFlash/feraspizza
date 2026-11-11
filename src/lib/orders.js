import { HttpError, str, int, sha256, randomToken, romeNow, toMinutes, fromMinutes } from "./http.js";
import { getSettings, ingredientsOf, parseExtras, PUBLIC_SETTING_KEYS } from "./db.js";
import { enqueuePush } from "./push.js";

export const STATUSES = ["nuovo", "accettato", "pronto", "completato", "annullato"];
const ACTIVE = ["nuovo", "accettato", "pronto"];

// ---------- Menu pubblico ----------
export async function publicMenu(env) {
  const cats = (await env.DB.prepare("SELECT id,name,description,removable,extras_json FROM categories WHERE active=1 ORDER BY sort,id").all()).results;
  const prods = (await env.DB.prepare(
    "SELECT id,category_id,name,description,price_cents,image_id,tags,available FROM products WHERE active=1 ORDER BY sort,id").all()).results;
  return cats.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    extras: parseExtras(c.extras_json),
    products: prods.filter((p) => p.category_id === c.id).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price_cents: p.price_cents,
      image: p.image_id ? "/img/" + p.image_id : null,
      tags: p.tags ? p.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      available: !!p.available,
      ingredients: c.removable ? ingredientsOf(p.description) : [],
    })),
  })).filter((c) => c.products.length);
}

// ---------- Orari e fasce ----------
function todayRanges(settings, now) {
  if ((settings.closed_dates || []).includes(now.day)) return [];
  const ranges = (settings.hours || {})[now.weekday] || [];
  return ranges.map(([a, b]) => {
    const start = toMinutes(a);
    let end = toMinutes(b);
    if (start === null || end === null) return null;
    if (end <= start) end = 24 * 60 - 1; // chiusura dopo mezzanotte: fasce fino alle 23:59
    return [start, end];
  }).filter(Boolean);
}

export async function availability(env, settings, date = new Date()) {
  const now = romeNow(date);
  const ranges = todayRanges(settings, now);
  const counts = {};
  if (settings.slot_capacity > 0) {
    const rows = (await env.DB.prepare(
      "SELECT slot,COUNT(*) AS n FROM orders WHERE day=? AND status<>'annullato' GROUP BY slot").bind(now.day).all()).results;
    for (const r of rows) counts[r.slot] = r.n;
  }
  const step = Math.max(5, Number(settings.slot_minutes) || 15);
  const build = (lead) => {
    const out = [];
    const earliest = now.minutes + lead;
    for (const [start, end] of ranges) {
      // La prima fascia utile parte dall'apertura + tempo di preparazione.
      let t = Math.max(start + lead, Math.ceil(earliest / step) * step);
      t = Math.ceil(t / step) * step;
      for (; t <= end; t += step) {
        const slot = fromMinutes(t);
        if (settings.slot_capacity > 0 && (counts[slot] || 0) >= settings.slot_capacity) continue;
        out.push(slot);
      }
    }
    return out;
  };
  const openNow = ranges.some(([s, e]) => now.minutes >= s && now.minutes <= e);
  const laterToday = ranges.some(([, e]) => now.minutes < e);
  const takeaway = settings.takeaway_enabled ? build(Number(settings.prep_minutes) || 20) : [];
  const delivery = settings.delivery_enabled ? build(Number(settings.delivery_minutes) || 40) : [];
  const paused = !!settings.ordering_paused;
  return {
    paused,
    openNow,
    accepting: !paused && (takeaway.length > 0 || delivery.length > 0),
    todayHours: ranges.map(([s, e]) => [fromMinutes(s), fromMinutes(e)]),
    slots: { takeaway, delivery },
    laterToday,
  };
}

export async function publicConfig(env) {
  const settings = await getSettings(env);
  const pub = Object.fromEntries(PUBLIC_SETTING_KEYS.map((k) => [k, settings[k]]));
  return { settings: pub, availability: await availability(env, settings) };
}

// ---------- Creazione ordine (prezzi calcolati SOLO lato server) ----------
const normPhone = (p) => p.replace(/[^\d+]/g, "");

export async function createOrder(env, body, origin) {
  const settings = await getSettings(env);
  const avail = await availability(env, settings);
  if (avail.paused) throw new HttpError(settings.pause_message || "Ordini online in pausa", 409);

  const type = body.orderType === "delivery" ? "delivery" : body.orderType === "takeaway" ? "takeaway" : null;
  if (!type) throw new HttpError("Scegli asporto o consegna");
  if (type === "delivery" && !settings.delivery_enabled) throw new HttpError("La consegna a domicilio non è attiva", 409);
  if (type === "takeaway" && !settings.takeaway_enabled) throw new HttpError("L'asporto non è attivo", 409);

  const slot = str(body.slot, "Orario", { max: 5, required: true });
  if (!avail.slots[type].includes(slot))
    throw new HttpError("L'orario scelto non è più disponibile: scegline un altro.", 409);

  const name = str(body.name, "Nome", { max: 80, required: true, min: 2 });
  const phone = str(body.phone, "Telefono", { max: 25, required: true });
  if (!/^\+?[\d ()./-]{6,25}$/.test(phone) || normPhone(phone).replace("+", "").length < 6)
    throw new HttpError("Numero di telefono non valido");
  const address = type === "delivery" ? str(body.address, "Indirizzo di consegna", { max: 200, required: true, min: 5 }) : "";
  const notes = str(body.notes, "Note", { max: 500 });
  const payment = body.payment === "pos" ? "pos" : body.payment === "contanti" ? "contanti" : null;
  if (!payment || (payment === "pos" && !settings.payment_pos) || (payment === "contanti" && !settings.payment_cash))
    throw new HttpError("Metodo di pagamento non valido");

  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) throw new HttpError("Il carrello è vuoto");
  const ids = [...new Set(body.items.map((l) => Number(l?.productId)))];
  if (ids.some((id) => !Number.isInteger(id))) throw new HttpError("Prodotto non valido");
  const rows = (await env.DB.prepare(
    `SELECT p.id,p.name,p.description,p.price_cents,p.available,c.removable,c.extras_json FROM products p
     JOIN categories c ON c.id=p.category_id WHERE p.active=1 AND c.active=1 AND p.id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids).all()).results;
  const byId = new Map(rows.map((r) => [r.id, r]));

  let subtotal = 0, qtyTotal = 0;
  const items = body.items.map((line) => {
    const p = byId.get(Number(line.productId));
    if (!p) throw new HttpError("Un prodotto non è più nel menu: aggiorna la pagina.", 409);
    if (!p.available) throw new HttpError(`"${p.name}" è terminato per oggi: rimuovilo dal carrello.`, 409);
    const qty = int(line.qty, "Quantità", { min: 1, max: 30 });
    qtyTotal += qty;
    const allowedRemove = p.removable ? ingredientsOf(p.description) : [];
    const removed = Array.isArray(line.removed) ? [...new Set(line.removed)] : [];
    if (removed.some((r) => !allowedRemove.includes(r))) throw new HttpError("Modifica non valida su " + p.name);
    const extrasAll = parseExtras(p.extras_json);
    const extrasPicked = Array.isArray(line.extras) ? [...new Set(line.extras)] : [];
    const extras = extrasPicked.map((n) => {
      const e = extrasAll.find((x) => x.name === n);
      if (!e) throw new HttpError("Aggiunta non valida su " + p.name);
      return e;
    });
    const unit = p.price_cents + extras.reduce((s, e) => s + e.price_cents, 0);
    subtotal += unit * qty;
    return {
      productId: p.id, name: p.name, qty, unit_cents: unit,
      removed, extras: extras.map((e) => e.name), note: str(line.note, "Nota prodotto", { max: 140 }),
    };
  });
  if (qtyTotal > 80) throw new HttpError("Per ordini così grandi chiamaci al telefono");

  const discount = Math.round(subtotal * Math.min(50, Math.max(0, Number(settings.online_discount_percent) || 0)) / 100);
  let delivery = 0;
  if (type === "delivery") {
    if (subtotal < (settings.delivery_min_cents || 0))
      throw new HttpError(`Per la consegna l'ordine minimo è di ${(settings.delivery_min_cents / 100).toFixed(2).replace(".", ",")} €`);
    const free = settings.free_delivery_over_cents > 0 && subtotal >= settings.free_delivery_over_cents;
    delivery = free ? 0 : settings.delivery_fee_cents || 0;
  }
  const total = subtotal - discount + delivery;

  const now = Date.now();
  const day = romeNow().day;
  const id = "FP-" + crypto.randomUUID();
  const token = randomToken(24);
  const phoneKey = normPhone(phone);
  const res = await env.DB.batch([
    env.DB.prepare(`INSERT INTO orders(id,number,day,token_hash,customer_name,customer_phone,order_type,address,slot,items_json,
      subtotal_cents,discount_cents,delivery_cents,total_cents,payment,notes,status,created_at,updated_at)
      VALUES(?,(SELECT COALESCE(MAX(number),0)+1 FROM orders WHERE day=?),?,?,?,?,?,?,?,?,?,?,?,?,?,?,'nuovo',?,?) RETURNING number`)
      .bind(id, day, day, await sha256(token), name, phone, type, address, slot, JSON.stringify(items),
        subtotal, discount, delivery, total, payment, notes, now, now),
    env.DB.prepare(`INSERT INTO customers(phone,name,address,order_count,spent_cents,first_at,last_at) VALUES(?,?,?,1,?,?,?)
      ON CONFLICT(phone) DO UPDATE SET name=excluded.name,address=CASE WHEN excluded.address<>'' THEN excluded.address ELSE address END,
      order_count=order_count+1,spent_cents=spent_cents+excluded.spent_cents,last_at=excluded.last_at`)
      .bind(phoneKey, name, address, total, now, now),
  ]);
  const number = res[0].results[0].number;

  await enqueuePush(env, origin, {
    id: "order:" + id,
    title: `🍕 Nuovo ordine #${number} · ${(total / 100).toFixed(2).replace(".", ",")} €`,
    body: `${type === "delivery" ? "Consegna" : "Asporto"} alle ${slot} · ${name}`,
    target: "/admin.html#ordini",
  });
  return { id, token, number };
}

export async function orderForCustomer(env, id, token) {
  if (typeof id !== "string" || !/^FP-[0-9a-f-]{36}$/.test(id) || typeof token !== "string" || !/^[a-f0-9]{48}$/.test(token))
    throw new HttpError("Ordine non trovato", 404);
  const o = await env.DB.prepare("SELECT * FROM orders WHERE id=? AND token_hash=?").bind(id, await sha256(token)).first();
  if (!o) throw new HttpError("Ordine non trovato", 404);
  const settings = await getSettings(env);
  return {
    number: o.number, status: o.status, type: o.order_type, slot: o.slot, day: o.day,
    name: o.customer_name, address: o.address, payment: o.payment, notes: o.notes,
    items: JSON.parse(o.items_json), subtotal_cents: o.subtotal_cents, discount_cents: o.discount_cents,
    delivery_cents: o.delivery_cents, total_cents: o.total_cents, cancel_reason: o.cancel_reason,
    created_at: o.created_at, updated_at: o.updated_at,
    shop_phone: settings.shop_phone, shop_whatsapp: settings.shop_whatsapp, shop_address: settings.shop_address,
  };
}

// ---------- Admin ----------
const adminShape = (o) => ({ ...o, items: JSON.parse(o.items_json), items_json: undefined, token_hash: undefined });

export async function adminOrders(env, url) {
  const date = url.searchParams.get("date");
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError("Data non valida");
    const rows = (await env.DB.prepare("SELECT * FROM orders WHERE day=? ORDER BY number DESC").bind(date).all()).results;
    return { orders: rows.map(adminShape) };
  }
  // Vista live: ordini di oggi + eventuali ordini ancora aperti dei giorni precedenti.
  const today = romeNow().day;
  const rows = (await env.DB.prepare(
    `SELECT * FROM orders WHERE day=? OR status IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 300`)
    .bind(today, ...ACTIVE).all()).results;
  return { today, orders: rows.map(adminShape), serverTime: Date.now() };
}

export async function updateOrderStatus(env, body) {
  const id = str(body.id, "Ordine", { max: 60, required: true });
  if (!STATUSES.includes(body.status)) throw new HttpError("Stato non valido");
  const reason = body.status === "annullato" ? str(body.reason, "Motivo", { max: 200 }) : "";
  const o = await env.DB.prepare("SELECT status,total_cents,customer_phone FROM orders WHERE id=?").bind(id).first();
  if (!o) throw new HttpError("Ordine non trovato", 404);
  const stmts = [env.DB.prepare("UPDATE orders SET status=?,cancel_reason=?,updated_at=? WHERE id=?").bind(body.status, reason, Date.now(), id)];
  // Un ordine annullato non conta nella spesa del cliente (e viceversa se ripristinato).
  const key = normPhone(o.customer_phone);
  if (body.status === "annullato" && o.status !== "annullato")
    stmts.push(env.DB.prepare("UPDATE customers SET order_count=MAX(0,order_count-1),spent_cents=MAX(0,spent_cents-?) WHERE phone=?").bind(o.total_cents, key));
  if (o.status === "annullato" && body.status !== "annullato")
    stmts.push(env.DB.prepare("UPDATE customers SET order_count=order_count+1,spent_cents=spent_cents+? WHERE phone=?").bind(o.total_cents, key));
  await env.DB.batch(stmts);
  return { ok: true };
}

export async function stats(env, url) {
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
  const since = new Date(Date.now() - (days - 1) * 86400000);
  const from = romeNow(since).day;
  const rows = (await env.DB.prepare(
    "SELECT day,order_type,total_cents,items_json,slot FROM orders WHERE day>=? AND status<>'annullato'").bind(from).all()).results;
  const byDay = {}, products = {}, hours = {};
  let revenue = 0, delivery = 0;
  for (const r of rows) {
    revenue += r.total_cents;
    if (r.order_type === "delivery") delivery++;
    byDay[r.day] ??= { orders: 0, revenue: 0 };
    byDay[r.day].orders++;
    byDay[r.day].revenue += r.total_cents;
    const h = r.slot.slice(0, 2) + ":00";
    hours[h] = (hours[h] || 0) + 1;
    for (const it of JSON.parse(r.items_json)) {
      products[it.name] ??= { qty: 0, revenue: 0 };
      products[it.name].qty += it.qty;
      products[it.name].revenue += it.qty * it.unit_cents;
    }
  }
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = romeNow(new Date(Date.now() - i * 86400000)).day;
    series.push({ day: d, ...(byDay[d] || { orders: 0, revenue: 0 }) });
  }
  return {
    days, from, orders: rows.length, revenue, delivery, takeaway: rows.length - delivery,
    average: rows.length ? Math.round(revenue / rows.length) : 0,
    series,
    top: Object.entries(products).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.qty - a.qty).slice(0, 10),
    hours: Object.entries(hours).sort().map(([hour, n]) => ({ hour, n })),
  };
}
