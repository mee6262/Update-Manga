import os
import re
import json
import time
import requests
from playwright.sync_api import sync_playwright

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
DB_FILE = "manga_db.json"
LIST_FILE = "manga_list.txt"

# เว็บกลุ่ม slow-manga / go-manga / up-manga / tanuki-manga ใช้ธีมเดียวกัน แต่คำเรียก "ตอนล่าสุด"
# ไม่เหมือนกันทุกเว็บ: go-manga/up-manga ใช้ "อ่านตอนล่าสุด" ส่วน slow-manga/tanuki-manga ใช้ "ตอนใหม่"
# จับทั้งสองคำไว้เผื่อ รวมถึง "ล่าสุด" แบบสั้น
LATEST_CHAPTER_SELECTOR = (
    'a:has-text("ตอนล่าสุด"), '
    'a:has-text("ตอนใหม่"), '
    'a:has-text("ล่าสุด")'
)

# selector สำรองสำหรับดึงรูปปก ถ้าไม่เจอ og:image
COVER_FALLBACK_SELECTORS = [
    ".summary_image img",
    ".tab-summary img",
    ".thumb img",
    "img.wp-post-image",
]

MAX_RETRIES = 3          # จำนวนครั้ง retry สูงสุดต่อเรื่อง
RETRY_DELAY = 3          # วินาทีที่รอก่อน retry
REQUEST_DELAY = 1.5      # วินาทีที่หน่วงระหว่างเรื่อง (ป้องกันถูก block)


def load_db() -> dict:
    if os.path.exists(DB_FILE):
        with open(DB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_db(data: dict):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)


def load_manga_list() -> list[dict]:
    """อ่านรายชื่อมังงะจากไฟล์ txt รูปแบบ  ชื่อ | URL"""
    mangas = []
    if not os.path.exists(LIST_FILE):
        print(f"❌ ไม่พบไฟล์ {LIST_FILE}")
        return mangas

    seen_names = set()
    with open(LIST_FILE, "r", encoding="utf-8") as f:
        for lineno, line in enumerate(f, start=1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "|" not in line:
                print(f"⚠️ บรรทัด {lineno} รูปแบบผิด (ไม่มี '|') — ข้ามไป: {line!r}")
                continue

            # แยกเฉพาะ 2 ส่วนแรก เผื่อ URL มี '|' ด้วย
            parts = line.split("|", maxsplit=1)
            name = parts[0].strip()
            url = parts[1].strip()

            if not name or not url:
                print(f"⚠️ บรรทัด {lineno} ชื่อหรือ URL ว่าง — ข้ามไป")
                continue

            if name in seen_names:
                print(f"⚠️ ชื่อซ้ำในไฟล์: {name!r} (บรรทัด {lineno}) — ข้ามไป")
                continue

            seen_names.add(name)
            mangas.append({"name": name, "url": url})

    return mangas


def get_latest_chapter_text(page) -> str | None:
    """ดึงข้อความ 'ตอนที่ X' จากลิงก์ล่าสุด"""
    try:
        latest_link = page.locator(LATEST_CHAPTER_SELECTOR).first
        if latest_link.count() > 0:
            text = latest_link.inner_text().strip()
            match = re.search(r"ตอนที่\s*\S+", text)
            return match.group(0) if match else text
    except Exception:
        pass
    return None


def get_cover_image(page) -> str | None:
    """พยายามดึงรูปปกจากหน้าเว็บ ลอง og:image ก่อน แล้วค่อย fallback"""
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


def send_telegram(manga_name: str, chapter: str, image_url: str | None = None):
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        print("⚠️ ไม่พบ TELEGRAM_TOKEN หรือ TELEGRAM_CHAT_ID — ข้ามการแจ้งเตือน")
        return

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
            telegram_url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
            payload = {
                "chat_id": TELEGRAM_CHAT_ID,
                "text": caption,
            }

        resp = requests.post(telegram_url, json=payload, timeout=15)
        if not resp.ok:
            print(f"⚠️ Telegram ส่งไม่สำเร็จ: {resp.status_code} {resp.text}")
        else:
            print(f"📨 แจ้งเตือน Telegram สำเร็จ: {manga_name}")
    except Exception as e:
        print(f"⚠️ Telegram Error: {e}")


def scrape_manga(context, url: str) -> tuple[str | None, str | None]:
    """
    เปิด page ใหม่ทุกครั้ง scrape แล้วปิด
    คืนค่า (chapter_text, cover_image_url)
    """
    page = context.new_page()
    try:
        page.goto(url, wait_until="load", timeout=45000)
        try:
            page.wait_for_selector(LATEST_CHAPTER_SELECTOR, timeout=10000)
        except Exception:
            pass  # ถ้า selector ไม่โผล่ก็ลองดึงข้อมูลต่อไปก่อน

        chapter = get_latest_chapter_text(page)
        cover = get_cover_image(page) if chapter else None
        return chapter, cover
    finally:
        page.close()


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
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1920, "height": 1080},
        )

        for idx, manga in enumerate(manga_list):
            name = manga["name"]
            url = manga["url"]

            # หน่วงระหว่างเรื่องเพื่อไม่ให้ถูก rate-limit (ยกเว้นเรื่องแรก)
            if idx > 0:
                time.sleep(REQUEST_DELAY)

            current_chap = None
            cover_url = None
            success = False

            for attempt in range(1, MAX_RETRIES + 1):
                try:
                    print(f"🔍 [{idx+1}/{len(manga_list)}] ตรวจสอบ: {name} (ครั้งที่ {attempt})...")
                    current_chap, cover_url = scrape_manga(context, url)
                    success = True
                    break
                except Exception as e:
                    print(f"⚠️ เกิดข้อผิดพลาดกับเรื่อง {name} (ครั้งที่ {attempt}): {e}")
                    if attempt < MAX_RETRIES:
                        print(f"   ⏳ รอ {RETRY_DELAY} วินาทีแล้ว retry...")
                        time.sleep(RETRY_DELAY)

            if not success:
                print(f"❌ ข้ามเรื่อง {name} หลัง retry {MAX_RETRIES} ครั้ง")
                continue

            if not current_chap:
                print(f"❌ หาตอนล่าสุดไม่เจอในเรื่อง: {name} — ลอง selector เพิ่มเติมใน LATEST_CHAPTER_SELECTOR")
                continue

            print(f"✨ เจอตอนล่าสุด: {current_chap}")

            if name not in db:
                db[name] = current_chap
                has_updates = True
                print(f"✅ บันทึกตอนตั้งต้นของ {name}: {current_chap}")
            elif db[name] != current_chap:
                print(f"🆕 อัปเดตใหม่! {name}: {db[name]} → {current_chap}")
                db[name] = current_chap
                has_updates = True
                send_telegram(name, current_chap, cover_url)
            else:
                print(f"⏸️  ยังไม่มีตอนใหม่: {name} ({current_chap})")

        browser.close()

    if has_updates:
        save_db(db)
        print("💾 บันทึก DB เรียบร้อย")

    print("🏁 บอททำงานเสร็จสิ้นกระบวนการ")


if __name__ == "__main__":
    main()
