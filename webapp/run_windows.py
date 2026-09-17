"""รันเว็บแอปแบบ production บน Windows ด้วย waitress (gunicorn ใช้บน Windows ไม่ได้)
ใช้แทนคำสั่ง gunicorn ในคู่มือฝั่ง Linux — ดู README หัวข้อ Deploy บน Windows VPS
"""
from waitress import serve

import app as app_module

if __name__ == "__main__":
    print("กำลังรันที่ http://127.0.0.1:5050 (กด Ctrl+C เพื่อหยุด)")
    # threads มากกว่าค่า default (4) เพราะงานเกือบทั้งหมดคือรอเน็ต (พร็อกซีรูป/ดึงหน้าเว็บ)
    # ตอนหนึ่งมีรูปหลายสิบใบ ถ้ารับได้ทีละ 4 คำขอจะต่อคิวกันยาวจนทั้งเว็บหน่วงตาม
    serve(app_module.app, host="127.0.0.1", port=5050, threads=16, channel_timeout=300)
