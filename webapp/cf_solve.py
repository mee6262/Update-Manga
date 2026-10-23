"""ผ่านหน้าตรวจของ Cloudflare ("รอสักครู่..." / cf-mitigated: challenge) แล้วพิมพ์คุกกี้ + User-Agent เป็น JSON

requests/curl_cffi/Chromium ธรรมดาไม่ผ่าน (ทดสอบกับ dark-manga 23 ต.ค.: 403 ทุกแบบ) แต่ camoufox (Firefox ที่ดัดแปลงลายนิ้วมือ)
ผ่านแบบไม่มีหน้าจอในราว 20 วิ — คุกกี้ cf_clearance ที่ได้ใช้กับ requests ต่อได้ถ้าส่ง User-Agent เดียวกันจาก IP เดียวกัน
scraper.py เรียกไฟล์นี้เป็น process แยก (เบราว์เซอร์ไม่อยู่ใน process ของเว็บ) พร้อม timeout

ติดตั้ง: pip install "camoufox[geoip]" แล้ว python -m camoufox fetch
ใช้: python cf_solve.py <url>
ผลลัพธ์ (stdout): {"ua": "...", "cookies": {"cf_clearance": "...", ...}}
"""
import json
import sys
import time
from urllib.parse import urlparse

from camoufox.sync_api import Camoufox

WAIT_SECONDS = 60


def solve(url: str) -> dict:
    host = urlparse(url).hostname or ""
    with Camoufox(headless=True) as browser:
        page = browser.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        deadline = time.time() + WAIT_SECONDS
        while time.time() < deadline:
            cookies = page.context.cookies()
            if any(c["name"] == "cf_clearance" for c in cookies):
                break
            page.wait_for_timeout(1000)
        else:
            raise SystemExit(f"ไม่ผ่านหน้าตรวจ Cloudflare ใน {WAIT_SECONDS} วิ")
        page.wait_for_timeout(1500)  # ให้หน้าจริงตั้งคุกกี้อื่นที่ต้องใช้คู่กันให้ครบ
        jar = {c["name"]: c["value"] for c in page.context.cookies()
               if host.endswith(c["domain"].lstrip("."))}
        return {"ua": page.evaluate("navigator.userAgent"), "cookies": jar}


if __name__ == "__main__":
    print(json.dumps(solve(sys.argv[1])))
