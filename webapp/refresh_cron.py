"""สคริปต์เรียก /api/refresh_all เป็นระยะ (ใช้กับ cron บน VPS)
ตัวอย่างการตั้ง cron ทุก 30 นาที (ดูรายละเอียดใน README):
  */30 * * * * /path/to/webapp/.venv/bin/python /path/to/webapp/refresh_cron.py >> /var/log/manga_refresh.log 2>&1
"""
import os
import sys

import requests

BASE_URL = os.environ.get("MANGA_APP_URL", "http://127.0.0.1:5050")


def main():
    try:
        resp = requests.post(f"{BASE_URL}/api/refresh_all", timeout=300)
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
