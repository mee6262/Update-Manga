"""เปิดหน้า Reels ของเพจ Facebook ด้วย Chromium แบบไม่มีหน้าจอ (ไม่ล็อกอิน) แล้วพิมพ์ลิงก์ reel ล่าสุดเป็น JSON

Facebook ใส่รายการคลิปด้วย JavaScript — requests ธรรมดาได้ 0 คลิป จึงต้องใช้เบราว์เซอร์จริง
ไม่ล็อกอินเห็นแค่ราว 10 คลิปล่าสุด (เลื่อนต่อจะเจอหน้าต่างให้ล็อกอิน) — พอสำหรับเช็คทุก 2 ชั่วโมง
app.py เรียกไฟล์นี้เป็น process แยก (ไม่ให้ Chromium อยู่ใน process ของเว็บ) พร้อม timeout

ใช้: python fb_reels_watch.py <ลิงก์หน้า reels ของเพจ>
ผลลัพธ์ (stdout): {"reels": ["https://www.facebook.com/reel/123...", ...]} เรียงใหม่→เก่า
"""
import json
import re
import sys

from playwright.sync_api import sync_playwright

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"


def newest_reels(page_url: str) -> list[str]:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page(user_agent=UA, locale="th-TH", viewport={"width": 1280, "height": 1600})
            page.goto(page_url, wait_until="domcontentloaded", timeout=45000)
            try:
                page.wait_for_selector('a[href*="/reel/"]', timeout=25000)
            except Exception:
                pass  # ไม่เจอ = คืนรายการว่าง ให้ฝั่งเว็บบันทึกว่าเช็คแล้วไม่พบ
            page.wait_for_timeout(2000)
            hrefs = page.eval_on_selector_all('a[href*="/reel/"]', "els => els.map(e => e.href)")
        finally:
            browser.close()
    seen = []
    for href in hrefs:
        match = re.search(r"/reel/(\d{6,})", href)
        url = match and f"https://www.facebook.com/reel/{match.group(1)}"
        if url and url not in seen:
            seen.append(url)
    return seen


if __name__ == "__main__":
    print(json.dumps({"reels": newest_reels(sys.argv[1])}))
