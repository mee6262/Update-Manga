// Cloudflare Worker: ส่งต่อท่อนวิดีโอ HLS ให้ตัวเล่นในแอป (Anime108) — วิดีโอวิ่งผ่าน Cloudflare ไม่ผ่าน VPS
//
// ทำไมต้องมี: โฮสต์ท่อนวิดีโอของ 108player เปิด CORS ให้แค่ main.108player.com → hls.js ในหน้าเว็บเราโหลดตรงไม่ได้
// Worker นี้ดึงท่อนให้แล้วตอบพร้อม CORS (หัวรูป WebP ที่แปะหน้าท่อน hls.js ข้ามเองได้ ไม่ต้องตัด)
//
// กันใช้เป็นพร็อกซีสาธารณะ: รับเฉพาะลิงก์ที่เซิร์ฟเวอร์แอปเซ็นไว้ (HMAC-SHA256 ด้วยรหัสลับ KEY ที่ตรงกับ
// VIDEO_PROXY_KEY ใน .env) และยังไม่หมดอายุ — ลิงก์: /s?u=<ลิงก์ท่อน>&e=<หมดอายุ unix>&k=<ลายเซ็น 32 hex>
//
// deploy: cd tools; npx wrangler@4 deploy (ตั้งอยู่ที่ https://mee-video.mee6262.workers.dev)
// หรือวางเอง: Cloudflare → Workers & Pages → สร้าง Worker → วางไฟล์นี้ทั้งไฟล์ → Deploy
//      Settings → Variables and Secrets → เพิ่ม Secret ชื่อ KEY = ค่าเดียวกับ VIDEO_PROXY_KEY

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const PLAYER = "https://main.108player.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Max-Age": "86400" } });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return text("method not allowed", 405);
    const q = new URL(request.url).searchParams;
    const u = q.get("u") || "";
    const e = Number(q.get("e"));
    const k = q.get("k") || "";
    if (!env.KEY) return text("worker: ยังไม่ได้ตั้ง Secret ชื่อ KEY", 500);
    if (!u.startsWith("https://") || !(e > Date.now() / 1000) || !(await signatureOk(env.KEY, `${e}\n${u}`, k))) {
      return text("forbidden", 403);
    }
    const headers = { "User-Agent": UA, Referer: `${PLAYER}/`, Origin: PLAYER };
    const range = request.headers.get("Range");
    if (range) headers.Range = range;
    let up;
    try {
      up = await fetch(u, { method: request.method, headers });
    } catch (err) {
      return text(`upstream error: ${err}`, 502);
    }
    if (up.status !== 200 && up.status !== 206) return text(`upstream ${up.status}`, 502);
    const out = new Headers(CORS);
    for (const h of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
      const v = up.headers.get(h);
      if (v) out.set(h, v);
    }
    out.set("Content-Type", "video/mp2t");
    out.set("Cache-Control", "public, max-age=86400");
    return new Response(up.body, { status: up.status, headers: out });
  },
};

function text(body, status) {
  return new Response(body, { status, headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } });
}

async function signatureOk(secret, message, sig) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  const want = Array.from(mac.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  if (sig.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
