import os
import json
import requests
from playwright.sync_api import sync_playwright

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
DB_FILE = "manga_db.json"
LIST_FILE = "manga_list.txt"

# ตัวจับพิกัดโครงสร้างเว็บแบบครอบจักรวาล (สำหรับเว็บมังงะทั่วไปและค่ายที่คุณมี่อ่าน)
DEFAULT_SELECTOR = ".wp-manga-chapter a, .chapter-link a, li.chapter a, .chapternum"

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
            if not line or line.startswith("#"): # ข้ามบรรทัดว่างหรือคอมเมนต์
                continue
            if "|" in line:
                parts = line.split("|")
                name = parts[0].strip()
                url = parts[1].strip()
                mangas.append({"name": name, "url": url, "selector": DEFAULT_SELECTOR})
    return mangas

def send_telegram(manga_name, chapter, url):
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        return
    
    msg = (
        f"📚 <b>มังงะอัปเดตตอนใหม่!</b>\n"
        f"📌 <b>เรื่อง:</b> {manga_name}\n"
        f"🆙 <b>ตอนล่าสุด:</b> {chapter}\n"
        f"🔗 <a href='{url}'>คลิกเพื่ออ่านที่นี่</a>"
    )
    
    telegram_url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": msg,
        "parse_mode": "HTML",
        "disable_web_page_preview": False
    }
    
    try:
        requests.post(telegram_url, json=payload)
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
            selector = manga["selector"]
            
            try:
                print(f"🔍 กำลังตรวจสอบ: {name}...")
                page.goto(url, wait_until="load", timeout=45000)
                
                page.wait_for_selector(selector, timeout=10000)
                latest_chap_element = page.locator(selector).first
                
                if latest_chap_element and latest_chap_element.count() > 0:
                    current_chap = latest_chap_element.inner_text().strip()
                    if not current_chap:
                        continue
                        
                    print(f"✨ เจอตอนล่าสุด: {current_chap}")
                    
                    if name not in db:
                        db[name] = current_chap
                        has_updates = True
                        print(f"✅ บันทึกตอนตั้งต้นของ {name} สำเร็จ")
                    elif db[name] != current_chap:
                        db[name] = current_chap
                        has_updates = True
                        send_telegram(name, current_chap, url)
                else:
                    print(f"❌ หาจุดแสดงข้อมูลตอนล่าสุดไม่เจอในเรื่อง: {name}")
                    
            except Exception as e:
                print(f"⚠️ เกิดข้อผิดพลาดกับเรื่อง {name}: {str(e)}")
                continue
                
        browser.close()
        
    if has_updates:
        save_db(db)
    print("🏁 บอททำงานเสร็จสิ้นกระบวนการ")

if __name__ == "__main__":
    main()
