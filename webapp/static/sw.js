// Service worker: รับ/แสดงแจ้งเตือน + แคชให้เปิดเร็วและเปิดได้ตอนเน็ตหลุด (แบบแอป)
// ไม่ยุ่งกับระบบแคชเดิม (static ?v=, ETag, auto-reload เมื่อมีเวอร์ชันใหม่):
// - หน้าเว็บ (/) : ดึงจากเน็ตก่อนเสมอ ได้แล้วเก็บสำเนาไว้ — เน็ตหลุดค่อยใช้สำเนาล่าสุด
// - /static/*?v= : ชื่อไฟล์เปลี่ยนทุกเวอร์ชันอยู่แล้ว ใช้จากแคชได้เลย (cache-first)
// - API / รูป / วิดีโอ : ไม่แตะ ปล่อยเบราว์เซอร์จัดการตามปกติ
const CACHE = "meemanga-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate" && url.pathname === "/") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        // เก็บเฉพาะหน้าเว็บจริง (ไม่เก็บหน้า login ที่ถูก redirect มา)
        if (res.ok && !res.redirected) (await caches.open(CACHE)).put("/", res.clone());
        return res;
      } catch (e) {
        return (await caches.match("/")) || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.startsWith("/static/") && url.searchParams.has("v")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        // เก็บแค่เวอร์ชันล่าสุดของแต่ละไฟล์ — ลบ ?v= เก่าของไฟล์เดียวกันทิ้ง แคชไม่บวมขึ้นเรื่อย ๆ
        for (const old of await cache.keys()) {
          const o = new URL(old.url);
          if (o.pathname === url.pathname && o.search !== url.search) await cache.delete(old);
        }
        await cache.put(req, res.clone());
      }
      return res;
    })());
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : "" };
  }
  // iOS บังคับว่าทุก push ต้องแสดงแจ้งเตือนเสมอ ถ้าไม่แสดงหลายครั้งระบบจะตัดสิทธิ์ push ของเว็บทิ้ง
  event.waitUntil(
    self.registration.showNotification(data.title || "Mee+", {
      body: data.body || "มีตอนใหม่",
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: "/static/icon-192.png",
      badge: "/static/icon-192.png",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // มีหน้าเว็บเปิดค้างอยู่แล้ว ใช้หน้านั้น (ไม่เปิดแท็บซ้อน)
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          await client.focus();
          client.postMessage({ type: "open", url });
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
