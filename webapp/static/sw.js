// Service worker มีหน้าที่เดียวคือรับ/แสดงแจ้งเตือน — ตั้งใจไม่มี fetch handler (ไม่แคชหน้าเว็บ) เพื่อไม่ไป
// ยุ่งกับระบบแคชเดิม (static ?v=, ETag, auto-reload เมื่อมีเวอร์ชันใหม่) ที่ทำงานดีอยู่แล้ว

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : "" };
  }
  // iOS บังคับว่าทุก push ต้องแสดงแจ้งเตือนเสมอ ถ้าไม่แสดงหลายครั้งระบบจะตัดสิทธิ์ push ของเว็บทิ้ง
  event.waitUntil(
    self.registration.showNotification(data.title || "Update Manga", {
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
