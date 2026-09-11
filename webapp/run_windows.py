"""รันเว็บแอปแบบ production บน Windows ด้วย waitress (gunicorn ใช้บน Windows ไม่ได้)
ใช้แทนคำสั่ง gunicorn ในคู่มือฝั่ง Linux — ดู README หัวข้อ Deploy บน Windows VPS
"""
from waitress import serve

import app as app_module

if __name__ == "__main__":
    print("กำลังรันที่ http://127.0.0.1:5050 (กด Ctrl+C เพื่อหยุด)")
    serve(app_module.app, host="127.0.0.1", port=5050)
