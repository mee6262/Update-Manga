# Update-Manga

เว็บแอปติดตามตอนใหม่ของมังงะที่ชอบ จากกลุ่มเว็บธีมเดียวกัน (slow-manga, go-manga, up-manga, tanuki-manga
และเว็บอื่นที่ใช้ธีม "mangareader" เดียวกัน) — ดูรายการที่อัปเดต อ่านในหน้าเว็บได้เลย มีแจ้ง `NEW!`
สำหรับตอนที่ยังไม่ได้กดอ่าน และตั้งค่าเพิ่ม/ลบเรื่องที่ติดตามได้

โค้ดเดิม (`bot.py`, ใช้ playwright ส่งแจ้งเตือนเข้า Telegram) ยังอยู่ในโฟลเดอร์หลักเหมือนเดิม
แต่ **เว็บแอปใหม่ส่งแจ้งเตือน Telegram เองได้แล้วในตัว** (ดูหัวข้อ "แจ้งเตือน Telegram" ด้านล่าง)
โดยใช้ข้อมูลชุดเดียวกับที่แสดงในเว็บ (`webapp/data/manga.json`) — แนะนำให้ใช้เว็บแอปแทน `bot.py`
ไปเลยเพื่อไม่ให้ข้อมูลสองชุดเพี้ยนกัน (`bot.py` อ่าน/เขียน `manga_list.txt` + `manga_db.json`
คนละไฟล์กับเว็บแอป ถ้าเพิ่ม/ลบเรื่องผ่านหน้า "ตั้งค่า" ของเว็บ `bot.py` จะไม่รู้ด้วย) จะยังเก็บ
`bot.py` ไว้เป็น reference หรือลบทิ้งก็ได้ แต่ไม่ควรรันทั้งสองพร้อมกันเพราะจะได้แจ้งเตือนซ้ำ

## รันทดสอบบนเครื่อง (dev)

เว็บแอปไม่ต้องใช้ playwright เลย ใช้ `webapp/requirements.txt` แทน `requirements.txt` ที่ root
(อันนั้นเป็นของ `bot.py` เดิม):

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r webapp/requirements.txt

cd webapp
python3 migrate.py      # ครั้งแรกครั้งเดียว: ย้ายข้อมูลจาก manga_list.txt / manga_db.json เดิม
python3 app.py          # เปิดที่ http://127.0.0.1:5050
```

## เข้าสู่ระบบ (login)

เว็บแอปมีหน้า login ในตัว (จำเครื่อง 90 วัน ไม่ต้อง login ซ้ำทุกครั้งแบบ Basic Auth) เปิดใช้โดยตั้งใน `.env`:

```
WEB_USERNAME=ชื่อผู้ใช้ที่ต้องการ
WEB_PASSWORD=รหัสผ่านที่ต้องการ
SECRET_KEY=<สุ่มด้วยคำสั่งด้านล่าง>
```

สร้าง `SECRET_KEY` ด้วย:

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

**ต้องตั้ง `SECRET_KEY` ให้คงที่เสมอ** ถ้าปล่อยว่างแอปจะสุ่มใหม่ทุกครั้งที่รีสตาร์ท ทำให้ทุกคน
หลุด login ต้องล็อกอินใหม่หมด — ถ้าปล่อย `WEB_USERNAME`/`WEB_PASSWORD` ว่างทั้งคู่ จะไม่มี login เลย
(ใช้ตอน dev บนเครื่องตัวเองได้ แต่ **อย่าปล่อยว่างตอน deploy ขึ้น VPS**)

ถ้าใช้ Caddy อยู่แล้ว **เอา `basic_auth` block ออกจาก Caddyfile ได้เลย** (ซ้ำซ้อนกับ login ของแอป)
เหลือแค่ HTTPS + reverse proxy พอ:

```
yourdomain.com {
    reverse_proxy 127.0.0.1:5050
}
```

## Deploy บน VPS

แอปนี้ต้องตั้ง `WEB_USERNAME`/`WEB_PASSWORD` ไว้ก่อนเปิดให้เข้าถึงจากอินเทอร์เน็ต (ดูหัวข้อด้านบน)
ไม่งั้นใครก็ตามที่รู้ IP/URL จะเพิ่ม-ลบรายการหรือดูรายการอ่านของเราได้ นอกจากนี้แนะนำอย่างใดอย่างหนึ่งเพิ่ม:

- วางหลัง Caddy/nginx พร้อม HTTPS (ดูตัวอย่าง Caddyfile ด้านบน), หรือ
- จำกัดด้วย firewall ให้เข้าได้เฉพาะ IP ของตัวเอง, หรือ
- เข้าผ่าน SSH tunnel / VPN เท่านั้น (ไม่เปิดพอร์ตสาธารณะเลย)

ขั้นตอน:

```bash
# 1. clone และติดตั้ง
git clone https://github.com/mee6262/Update-Manga /opt/Update-Manga
cd /opt/Update-Manga
python3 -m venv .venv
source .venv/bin/activate
pip install -r webapp/requirements.txt

# 2. migrate ข้อมูลครั้งแรก (ถ้ามี manga_list.txt/manga_db.json เดิม)
cd webapp
python3 migrate.py

# 3. รันด้วย gunicorn (ไม่ใช้ dev server ของ Flask ใน production)
../.venv/bin/gunicorn -w 2 -b 127.0.0.1:5050 app:app
```

ให้รันเป็น service ถาวร: copy `deploy/manga-webapp.service` ไปที่ `/etc/systemd/system/`
(แก้ path/user ให้ตรงกับเครื่องจริงก่อน) แล้ว

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now manga-webapp
```

จากนั้นตั้ง nginx เป็น reverse proxy ไปที่ `127.0.0.1:5050` พร้อม Basic Auth ตามที่แนะนำด้านบน

### รีเฟรชอัตโนมัติเป็นระยะ

หน้าเว็บมีปุ่ม "รีเฟรชทั้งหมด" ให้กดเองได้ แต่ถ้าอยากให้ข้อมูลอัปเดตอัตโนมัติ ตั้ง cron เรียก
`webapp/refresh_cron.py` (สคริปต์นี้ยิง POST ไปที่ `/api/refresh_all` ของ service ที่รันอยู่):

```cron
*/30 * * * * /opt/Update-Manga/.venv/bin/python /opt/Update-Manga/webapp/refresh_cron.py >> /var/log/manga_refresh.log 2>&1
```

## Deploy บน Windows VPS

ต่างจาก Linux ตรงที่: ใช้ `webapp/requirements.txt` เหมือนกัน (ข้าม playwright โดยอัตโนมัติ ไม่ต้องมี
Visual C++ Build Tools), ใช้ `waitress` แทน `gunicorn` (gunicorn รันบน Windows ไม่ได้), และใช้
**Task Scheduler** แทน systemd/cron

```powershell
cd C:\Project\Update-Manga
py -m venv .venv
.venv\Scripts\activate
pip install -r webapp\requirements.txt

cd webapp
python migrate.py
copy ..\.env.example ..\.env
notepad ..\.env          # ใส่ TELEGRAM_TOKEN / TELEGRAM_CHAT_ID

python run_windows.py    # ทดสอบก่อน เปิด http://127.0.0.1:5050 ดู แล้ว Ctrl+C ปิด
```

จากนั้นตั้ง Task Scheduler 2 ตัว:

1. **รัน webapp ถาวร**: Create Task → Trigger "At startup" → Action: Program
   `C:\Project\Update-Manga\.venv\Scripts\python.exe`, Arguments `run_windows.py`,
   Start in `C:\Project\Update-Manga\webapp` → ติ๊ก "Run whether user is logged on or not"
2. **รีเฟรชอัตโนมัติ**: Create Task → Trigger "Daily", repeat every 30 minutes, indefinitely →
   Action: Program `C:\Project\Update-Manga\.venv\Scripts\python.exe`,
   Arguments `webapp\refresh_cron.py`, Start in `C:\Project\Update-Manga`

กันเข้าถึงจากอินเทอร์เน็ต: บล็อกพอร์ต 5050 ที่ Windows Firewall แล้วเข้าเว็บผ่าน RDP บนตัว VPS เอง
(`http://127.0.0.1:5050`) หรือถ้าอยากเข้าจากนอกบ้านด้วย แนะนำ Cloudflare Tunnel แทนการเปิดพอร์ตตรง ๆ

## แจ้งเตือน Telegram

เว็บแอปจะส่งข้อความ Telegram อัตโนมัติทุกครั้งที่ scrape แล้วเจอว่าตอนล่าสุดเปลี่ยนไปจากที่รู้ล่าสุด
(ไม่ว่าจะกดปุ่ม "รีเฟรชทั้งหมด" เอง, กด "รีเฟรช" รายเรื่อง, หรือมาจาก cron/`refresh_cron.py`) —
จะไม่แจ้งตอนเพิ่งเพิ่มเรื่องใหม่ครั้งแรก (ยังไม่มีของเก่าให้เทียบ)

ตั้งค่า:

1. คุย กับ [@BotFather](https://t.me/BotFather) ใน Telegram แล้วพิมพ์ `/newbot` จะได้ `TELEGRAM_TOKEN`
2. ส่งข้อความอะไรก็ได้คุยกับบอทที่สร้าง 1 ข้อความ แล้วเปิด
   `https://api.telegram.org/bot<TOKEN>/getUpdates` ในเบราว์เซอร์ จะเห็น `"chat":{"id": ...}`
   เอาเลขนั้นมาเป็น `TELEGRAM_CHAT_ID`
3. คัดลอก `.env.example` เป็น `.env` แล้วใส่ค่าทั้งสองตัวลงไป (อยู่ที่ root ของโปรเจกต์ ข้าง ๆ
   โฟลเดอร์ `webapp/` — ไฟล์ `.env` ไม่ถูก commit ขึ้น git)

ตัวแอป (`app.py`) โหลด `.env` เองอัตโนมัติทุกครั้งที่เริ่มรัน (ทั้ง dev และ production, ทั้ง Windows/Linux)
ไม่ต้อง `export`/`set` เองเลย — แค่มีไฟล์ `.env` วางไว้ที่ root ของโปรเจกต์ก็พอ รีสตาร์ทแอปหลังแก้ `.env`
ทุกครั้ง (`sudo systemctl restart manga-webapp` บน Linux service, หรือรัน task ใหม่บน Windows)

## โครงสร้างข้อมูล

- `webapp/data/manga.json` — รายชื่อเรื่องที่ติดตาม + ตอนล่าสุดที่ทราบ
- `webapp/data/read_state.json` — ตอนล่าสุดที่ "อ่านแล้ว" ต่อเรื่อง (ไม่ commit ขึ้น git เพราะเป็นข้อมูลส่วนตัว)
- `webapp/data/chapters/` — cache รายการรูปของแต่ละตอนที่เคยเปิดอ่าน
- `webapp/data/image_domains.json` — โดเมน CDN รูปภาพที่เจอจากการ scrape จริง (ใช้จำกัดสิทธิ์ image proxy)
