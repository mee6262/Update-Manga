import os
import requests

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

def main():
    print("🚀 เริ่มทำการทดสอบส่งข้อความเข้า Telegram...")
    print(f"Checking Token: {'มีข้อมูล' if TELEGRAM_TOKEN else 'ว่างเปล่า❌'}")
    print(f"Checking Chat ID: {'มีข้อมูล' if TELEGRAM_CHAT_ID else 'ว่างเปล่า❌'}")
    
    msg = "🎯 <b>บอทมังงะของคุณมี่เปิดใช้งานสำเร็จ!</b>\nนี่คือข้อความทดสอบระบบส่งแจ้งเตือนครับ"
    
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": msg,
        "parse_mode": "HTML"
    }
    
    response = requests.post(url, json=payload)
    print(f"Response Status Code: {response.status_code}")
    print(f"Response Text: {response.text}")

if __name__ == "__main__":
    main()
