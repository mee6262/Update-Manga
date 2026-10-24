"""ผ่านหน้าตรวจของ Cloudflare ("รอสักครู่..." / cf-mitigated: challenge) แล้วพิมพ์คุกกี้ + User-Agent เป็น JSON

requests/curl_cffi/Chromium ธรรมดาไม่ผ่าน (ทดสอบกับ dark-manga 23 ต.ค.: 403 ทุกแบบ) แต่ camoufox (Firefox ที่ดัดแปลงลายนิ้วมือ)
ผ่านแบบไม่มีหน้าจอในราว 20 วิ — คุกกี้ cf_clearance ที่ได้ใช้กับ requests ต่อได้ถ้าส่ง User-Agent เดียวกันจาก IP เดียวกัน
scraper.py เรียกไฟล์นี้เป็น process แยก (เบราว์เซอร์ไม่อยู่ใน process ของเว็บ) พร้อม timeout

ติดตั้ง: pip install "camoufox[geoip]" แล้ว python -m camoufox fetch
ใช้: python cf_solve.py <url>
ผลลัพธ์ (stdout): {"ua": "...", "cookies": {"cf_clearance": "...", ...}}
    หรือ {"ua": "...", "cookies": {...}, "no_challenge": true} = เปิดได้เลยไม่มีหน้าตรวจ (เว็บเลิกตรวจแล้ว)
"""
import json
import sys
import time
from urllib.parse import urlparse

from camoufox.sync_api import Camoufox

WAIT_SECONDS = 45
ATTEMPTS = 2  # camoufox สุ่มลายนิ้วมือใหม่ทุกครั้ง บางชุดไม่ผ่าน (VPS 23 ต.ค.: ผ่าน 4 จาก 6) → ลองชุดใหม่อีกครั้ง


def solve(url: str) -> dict:
    host = urlparse(url).hostname or ""
    # VPS 2 CPU / RAM 4 GB: Firefox ปกติแตกหลาย process + โหลดรูปทั้งหน้า → เว็บเราตอบ healthz ช้าสุด 23.6 วิ ระหว่างแก้
    # ไม่โหลดรูป + content process เดียว (หน้าตรวจไม่ต้องใช้รูป)
    with Camoufox(headless=True, block_images=True, i_know_what_im_doing=True,
                  firefox_user_prefs={"dom.ipc.processCount": 1, "fission.autostart": False,
                                      "browser.cache.disk.enable": False}) as browser:
        page = browser.new_page()
        ua = page.evaluate("navigator.userAgent")  # อ่านก่อนเปิดเว็บ: ผ่านหน้าตรวจแล้วหน้าเปลี่ยน evaluate พัง
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        # up-manga (25 ต.ค.): เคยตรวจแล้วเลิก → ต่ออายุคุกกี้ทุก 30 นาทีรอ cf_clearance ไม่มีวันมา จนหมดเวลา
        if not _is_challenge(page) and not any(c["name"] == "cf_clearance" for c in page.context.cookies()):
            page.wait_for_timeout(3000)  # หน้าตรวจบางแบบขึ้นช้ากว่า domcontentloaded
            if not _is_challenge(page):
                return {"ua": ua, "cookies": _jar(page, host), "no_challenge": True}
        deadline = time.time() + WAIT_SECONDS
        while time.time() < deadline:
            cookies = page.context.cookies()
            if any(c["name"] == "cf_clearance" for c in cookies):
                break
            page.wait_for_timeout(1000)
        else:
            raise RuntimeError(f"ไม่ผ่านหน้าตรวจ Cloudflare ใน {WAIT_SECONDS} วิ")
        page.wait_for_timeout(1500)  # ให้หน้าจริงตั้งคุกกี้อื่นที่ต้องใช้คู่กันให้ครบ
        return {"ua": ua, "cookies": _jar(page, host)}


def _jar(page, host: str) -> dict:
    return {c["name"]: c["value"] for c in page.context.cookies() if host.endswith(c["domain"].lstrip("."))}


def _is_challenge(page) -> bool:
    """หน้าตรวจของ Cloudflare ("Just a moment..." / "รอสักครู่...") — ชื่อหน้า หรือสคริปต์ challenge-platform"""
    try:
        title = (page.title() or "").lower()
        return ("just a moment" in title or "รอสักครู่" in title
                or page.locator("script[src*='challenge-platform']").count() > 0)
    except Exception:
        return True  # อ่านไม่ได้ (หน้ากำลังเปลี่ยน) = ถือว่ายังตรวจอยู่ ใช้ทางเดิม


if __name__ == "__main__":
    for attempt in range(ATTEMPTS):
        try:
            print(json.dumps(solve(sys.argv[1])))
            break
        except Exception as e:
            print(f"รอบ {attempt + 1}: {e}", file=sys.stderr, flush=True)
            if attempt + 1 == ATTEMPTS:
                raise SystemExit(str(e))
