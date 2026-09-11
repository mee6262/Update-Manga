"""แจ้งเตือน Telegram เมื่อมีตอนใหม่ (ย้ายมาจาก bot.py เดิม ใช้ในเส้นทาง refresh ของเว็บแอป)"""
import os

import requests


def send_telegram(manga_name: str, chapter: str, image_url: str | None = None):
    # อ่านตอนเรียกใช้จริง (ไม่ใช่ตอน import) เผื่อ .env ยังโหลดไม่เสร็จตอน import module นี้
    token = os.environ.get("TELEGRAM_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        return

    caption = f"📚 {manga_name}\n{chapter}"

    try:
        if image_url:
            url = f"https://api.telegram.org/bot{token}/sendPhoto"
            payload = {"chat_id": chat_id, "photo": image_url, "caption": caption}
        else:
            url = f"https://api.telegram.org/bot{token}/sendMessage"
            payload = {"chat_id": chat_id, "text": caption}

        resp = requests.post(url, json=payload, timeout=15)
        if not resp.ok:
            print(f"⚠️ Telegram ส่งไม่สำเร็จ: {resp.status_code} {resp.text}")
    except Exception as e:
        print(f"⚠️ Telegram Error: {e}")
