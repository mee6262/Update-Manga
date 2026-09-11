"""สคริปต์เรียก /api/refresh_all เป็นระยะ (ใช้กับ cron บน VPS)
ตัวอย่างการตั้ง cron ทุก 30 นาที (ดูรายละเอียดใน README):
  */30 * * * * /path/to/webapp/.venv/bin/python /path/to/webapp/refresh_cron.py >> /var/log/manga_refresh.log 2>&1
"""
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

BASE_URL = os.environ.get("MANGA_APP_URL", "http://127.0.0.1:5050")
CRON_TOKEN = os.environ.get("CRON_TOKEN")


def main():
    try:
        headers = {"X-Cron-Token": CRON_TOKEN} if CRON_TOKEN else {}
        resp = requests.post(f"{BASE_URL}/api/refresh_all", headers=headers, timeout=300)
        resp.raise_for_status()
        data = resp.json()
        print(f"อัปเดตใหม่ {len(data['updated_ids'])} เรื่อง, ผิดพลาด {len(data['failed'])} เรื่อง")
        for f in data["failed"]:
            print(f"  ⚠️ {f['name']}: {f['error']}")
    except Exception as e:
        print(f"❌ refresh_all ล้มเหลว: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
