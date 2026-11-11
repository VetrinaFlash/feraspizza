/* Fera's Pizza_Lab — service worker per le notifiche del pannello. Nessuna cache offline. */
self.addEventListener("install", (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let info = {};
    try { info = event.data?.json() || {}; } catch { info = { body: event.data?.text() || "" }; }
    if (info.kind !== "order" && info.kind !== "test") return;
    const target = new URL(typeof info.url === "string" ? info.url : "/admin.html", self.location.origin);
    const url = target.origin === self.location.origin && target.pathname === "/admin.html" ? target.pathname + target.hash : "/admin.html";
    await self.registration.showNotification(String(info.title || "Fera's · nuovo ordine").slice(0, 110), {
      body: String(info.body || "Apri il pannello").slice(0, 200),
      icon: "/assets/icon-192.png", badge: "/assets/icon-192.png",
      tag: String(info.eventId || "fp-" + Date.now()), requireInteraction: info.kind === "order",
      vibrate: [300, 120, 300, 120, 600], data: { url },
    });
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: "push", kind: info.kind }));
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(event.notification.data?.url || "/admin.html", self.location.origin);
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins.find((c) => new URL(c.url).pathname === "/admin.html") || wins[0];
    if (w) { try { await w.focus(); w.postMessage({ type: "open-orders" }); return; } catch {} }
    await self.clients.openWindow(url.href);
  })());
});
