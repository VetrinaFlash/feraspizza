export class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });

export async function readJson(request) {
  try {
    const data = await request.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw 0;
    return data;
  } catch {
    throw new HttpError("Richiesta non valida", 400);
  }
}

export function str(value, label, { max = 200, required = false, min = 0 } = {}) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new HttpError(label + " non valido");
  const v = value.trim();
  if (v.length > max) throw new HttpError(label + " troppo lungo");
  if (required && v.length < Math.max(1, min)) throw new HttpError(label + " obbligatorio");
  return v;
}

export function int(value, label, { min = 0, max = 1e9 } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(label + " non valido");
  return n;
}

export async function sha256(value) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

// ---- Ora locale (Europe/Rome) ----
export function romeNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Rome",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday,
  };
}

export const toMinutes = (hhmm) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const fromMinutes = (n) =>
  String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
