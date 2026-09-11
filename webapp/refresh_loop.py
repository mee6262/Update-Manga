"""รันตัวเองค้างไว้ตลอด เช็คตอนใหม่ทุก 30 นาที (ใช้แทน Task Scheduler repeat-trigger
ซึ่งไม่เสถียรบางเครื่อง — หยุดยิงเองเงียบ ๆ โดยไม่มี error ให้เห็น)

ตั้ง Task Scheduler แค่ trigger เดียวคือ "At startup" ให้รันไฟล์นี้ (ไม่ใช่ refresh_cron.py)
แล้วปล่อยให้ loop ข้างในนี้จัดการเรื่องรอ 30 นาทีเอง เหมือนกับที่ "Manga Webapp"
(run_windows.py) เป็น process เดียวรันค้างไว้ตลอดเช่นกัน
"""
import time
import traceback

import refresh_cron

INTERVAL_SECONDS = 30 * 60


def main():
    while True:
        print(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} เริ่มเช็คตอนใหม่ ===", flush=True)
        try:
            refresh_cron.main()
        except SystemExit:
            pass  # refresh_cron.main() เรียก sys.exit(1) ตอนล้มเหลว ไม่ให้ process ทั้งตัวตายตาม
        except Exception:
            traceback.print_exc()

        print(f"--- รอ {INTERVAL_SECONDS // 60} นาทีก่อนเช็ครอบถัดไป ---", flush=True)
        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
