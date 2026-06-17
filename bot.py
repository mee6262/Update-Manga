import os
import re
import json
import requests
from playwright.sync_api import sync_playwright

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
DB_FILE = "manga_db.json"
LIST_FILE = "manga_list.txt"

# เว็บกลุ่ม slow-manga / go-manga / up-manga / tanuki-manga ใช้ธีมเดียวกัน แต่คำเรียก "ตอนล่าสุด"
# ไม่เหมือนกันทุกเว็บ: go-manga/up-manga ใช้ "อ่านตอนล่าสุด" ส่วน slow-manga/tanuki-manga ใช้ "ตอนใหม่"
# จับทั้งสองคำไว้เผื่อ
LATEST_CHAPTER_SELECTOR = 'a:has-text("ตอนล่าสุด"), a:has-text("ตอนใหม่")'

# selector สำรองสำหรับดึงรูปปก ถ้าไม่เจอ og:image
COVER_FALLBACK_SELECTORS = [
    ".summary_image img",
    ".tab-summary img",
    ".thumb img",
    "img.wp-post-image",
]

def load_db():
    if os.path.exists(DB_FILE):
        with open(DB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_db(data):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

# ฟังก์ชันอ่านรายชื่อมังงะจากไฟล์ txt
def load_manga_list():
    mangas = []
    if not os.path.exists(LIST_FILE):
        print(f"❌ ไม่พบไฟล์ {LIST_FILE}")
        return mangas

    with open(LIST_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):  # ข้ามบรรทัดว่างหรือคอมเมนต์
                continue
            if "|" in line:
                parts = line.split("|")
                name = parts[0].strip()
                url = parts[1].strip()
                mangas.append({"name": name, "url": url})
    return mangas

def get_latest_chapter_text(page):
    """ดึงข้อความ 'ตอนที่ X' จากลิงก์ 'อ่านตอนล่าสุด' (รูปแบบที่ใช้ตรงกันในเว็บกลุ่มนี้)"""
    try:
        latest_link = page.locator(LATEST_CHAPTER_SELECTOR).first
        if latest_link.count() > 0:
            text = latest_link.inner_text().strip()
            match = re.search(r"ตอนที่\s*\S+", text)
            return match.group(0) if match else text
    except Exception:
        pass
    return None

def get_cover_image(page):
    """พยายามดึงรูปปกจากหน้าเว็บ ลอง og:image ก่อน แล้วค่อย fallback เป็น selector รูปทั่วไป"""
    try:
        og_image = page.locator('meta[property="og:image"]').first
        if og_image.count() > 0:
            content = og_image.get_attribute("content")
            if content:
                return content
    except Exception:
        pass

    for sel in COVER_FALLBACK_SELECTORS:
        try:
            img = page.locator(sel).first
            if img.count() > 0:
                src = img.get_attribute("src")
                if src:
                    return src
        except Exception:
            continue

    return None

def send_telegram(manga_name, chapter, image_url=None):
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        return

    # สไตล์ A: เรียบสั้นสุด -> ชื่อเรื่อง + ตอนล่าสุด ไม่มีลิงก์
    caption = f"📚 {manga_name}\n{chapter}"

    try:
        if image_url:
            telegram_url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendPhoto"
            payload = {
                "chat_id": TELEGRAM_CHAT_ID,
                "photo": image_url,
                "caption": caption,
            }
        else:
            # ถ้าหารูปปกไม่เจอ ให้ fallback ไปส่งเป็นข้อความล้วน
            telegram_url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
            payload = {
                "chat_id": TELEGRAM_CHAT_ID,
                "text": caption,
            }

        resp = requests.post(telegram_url, json=payload)
        if not resp.ok:
            print(f"⚠️ Telegram ส่งไม่สำเร็จ: {resp.status_code} {resp.text}")
    except Exception as e:
        print(f"⚠️ Telegram Error: {str(e)}")

def main():
    db = load_db()
    manga_list = load_manga_list()

    if not manga_list:
        print("📭 ไม่มีรายชื่อมังงะให้ตรวจสอบ")
        return

    has_updates = False

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080}
        )
        page = context.new_page()

        for manga in manga_list:
            name = manga["name"]
            url = manga["url"]

            try:
                print(f"🔍 กำลังตรวจสอบ: {name}...")
                page.goto(url, wait_until="load", timeout=45000)

                try:
                    page.wait_for_selector(LATEST_CHAPTER_SELECTOR, timeout=10000)
                except Exception:
                    pass

                current_chap = get_latest_chapter_text(page)

                if not current_chap:
                    print(f"❌ หาจุดแสดงข้อมูลตอนล่าสุดไม่เจอในเรื่อง: {name}")
                    continue

                print(f"✨ เจอตอนล่าสุด: {current_chap}")

                if name not in db:
                    db[name] = current_chap
                    has_updates = True
                    print(f"✅ บันทึกตอนตั้งต้นของ {name} สำเร็จ")
                elif db[name] != current_chap:
                    db[name] = current_chap
                    has_updates = True
                    image_url = get_cover_image(page)
                    send_telegram(name, current_chap, image_url)

            except Exception as e:
                print(f"⚠️ เกิดข้อผิดพลาดกับเรื่อง {name}: {str(e)}")
                continue

        browser.close()

    if has_updates:
        save_db(db)
    print("🏁 บอททำงานเสร็จสิ้นกระบวนการ")

if __name__ == "__main__":
    main()
