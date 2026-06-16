import os
import json
import requests
from playwright.sync_api import sync_playwright

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
DB_FILE = "manga_db.json"

def load_db():
    if os.path.exists(DB_FILE):
        with open(DB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_db(data):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

def send_telegram(manga_name, chapter, url):
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        print("❌ ไม่พบ TELEGRAM_TOKEN หรือ TELEGRAM_CHAT_ID ข้ามการแจ้งเตือน")
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
        response = requests.post(telegram_url, json=payload)
        if response.status_code != 200:
            print(f"❌ ส่งข้อความเข้า Telegram ล้มเหลว: {response.text}")
    except Exception as e:
        print(f"⚠️ เกิดข้อผิดพลาดในการเชื่อมต่อ Telegram: {str(e)}")

def main():
    db = load_db()
    
    manga_list = [
        {
            "name": "What a Bountiful Harvest, Demon Lord",
            "url": "https://www.slow-manga.net/manga/what-a-bountiful-harvest-demon-lord/",
            "selector": ".wp-manga-chapter a, .chapter-link a, li.chapter a, .chapternum" 
        },
        {
            "name": "Disastrous Necromancer",
            "url": "https://www.go-manga.com/disastrous-necromancer/",
            "selector": ".wp-manga-chapter a, .chapter-link a, li.chapter a, .chapternum"
        },
        {
            "name": "Level 1 Player",
            "url": "https://www.up-manga.com/level-1-player/",
            "selector": ".wp-manga-chapter a, .chapter-link a, li.chapter a, .chapternum"
        },
        {
            "name": "Magic Emperor",
            "url": "https://www.tanuki-manga.net/manga/magic-emperor/",
            "selector": ".wp-manga-chapter a, .chapter-link a, li.chapter a, .chapternum"
        }
    ]
    
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
                # เพิ่มความอึดให้บอท รอโหลดข้อมูลนานขึ้นเล็กน้อย
                page.goto(url, wait_until="load", timeout=45000)
                
                # บังคับให้รอตัว Selector แสดงตัวบนหน้าเว็บ ป้องกันการดึงข้อมูลตอนเว็บยังโหลดไม่เสร็จ
                page.wait_for_selector(selector, timeout=10000)
                latest_chap_element = page.locator(selector).first
                
                if latest_chap_element and latest_chap_element.count() > 0:
                    current_chap = latest_chap_element.inner_text().strip()
                    # ถ้าดึงมาแล้วดันได้ค่าว่าง ให้ข้ามไปก่อนเพื่อป้องกันฐานข้อมูลพัง
                    if not current_chap:
                        print(f"⚠️ ข้อความที่ดึงได้จาก {name} เป็นค่าว่าง ข้ามข้อมูลนี้")
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
                # 🛑 จุดสำคัญ: ดักจับและแสดง Error แต่ไม่สั่งให้สคริปต์หยุดทำงาน เพื่อให้เรื่องอื่นทำงานต่อได้
                print(f"⚠️ เกิดข้อผิดพลาดกับเรื่อง {name}: {str(e)}")
                continue
                
        browser.close()
        
    if has_updates:
        save_db(db)
    print("🏁 บอททำงานเสร็จสิ้นกระบวนการ")

if __name__ == "__main__":
    main()
