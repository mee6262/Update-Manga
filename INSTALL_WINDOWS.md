# คู่มือติดตั้ง Update-Manga บนเครื่อง Windows ใหม่

ทำตามลำดับจากบนลงล่าง ทุกคำสั่งรันใน **PowerShell แบบ Run as Administrator**
ตัวอย่างใช้โฟลเดอร์ `C:\Project\Update-Manga` ถ้าใช้ที่อื่นให้เปลี่ยนทุกจุดให้ตรงกัน

ใช้เวลาราว 20-30 นาที

---

## 1. ติดตั้งโปรแกรมที่ต้องใช้

| โปรแกรม | ดาวน์โหลด | หมายเหตุ |
|---|---|---|
| Python **3.10 ขึ้นไป** (แนะนำ 3.12) | https://www.python.org/downloads/windows/ | ตอนติดตั้งเลือก **Customize installation** → ติ๊ก **Install Python for all users** และ **Add Python to environment variables** |
| Git for Windows | https://git-scm.com/download/win | ค่า default ทั้งหมดได้เลย |

ต้องติดตั้ง Python แบบ **for all users** เพราะ Task Scheduler จะรันเว็บด้วยบัญชี SYSTEM ถ้าติดตั้งไว้แค่
ในบัญชีผู้ใช้ตัวเอง บาง config จะเรียก Python ไม่เจอ

ปิดแล้วเปิด PowerShell ใหม่ แล้วเช็ค:

```powershell
python --version ; git --version
```

---

## 2. ดึงโค้ดและติดตั้ง dependency

```powershell
mkdir C:\Project -Force ; cd C:\Project
git clone https://github.com/mee6262/Update-Manga
cd C:\Project\Update-Manga
python -m venv .venv
.venv\Scripts\pip install -r webapp\requirements.txt
```

ถ้า `pip install` ติดที่ Pillow (ตัวย่อรูปปก) ข้ามไปก่อนได้ เว็บยังใช้งานได้ปกติ แค่จะไม่ย่อรูปปกให้

---

## 3. ตั้งค่า `.env`

```powershell
copy .env.example .env
notepad .env
```

| ค่า | ต้องใส่ไหม | ใส่อะไร |
|---|---|---|
| `SECRET_KEY` | **ต้องใส่** | ค่าสุ่ม (คำสั่งด้านล่าง) — ถ้าย้ายเครื่อง **ใช้ค่าเดิมจากเครื่องเก่า** ผู้ใช้จะได้ไม่หลุด login |
| `CRON_TOKEN` | **ต้องใส่** | ค่าสุ่มอีกตัว (ไม่ซ้ำกับ SECRET_KEY) ไม่งั้นรีเฟรชอัตโนมัติจะโดนปฏิเสธ |
| `WEB_USERNAME` / `WEB_PASSWORD` | ใส่ถ้าเริ่มใหม่ | ใช้สร้างบัญชี admin คนแรกตอนรันครั้งแรกเท่านั้น (ถ้าย้ายข้อมูลจากเครื่องเก่า ข้ามได้) |
| `TELEGRAM_TOKEN` / `TELEGRAM_CHAT_ID` | ถ้าอยากได้แจ้งเตือน | วิธีขอดูในไฟล์ `.env.example` |

สร้างค่าสุ่ม (รัน 2 ครั้ง เอาไปใส่ SECRET_KEY กับ CRON_TOKEN):

```powershell
.venv\Scripts\python -c "import secrets; print(secrets.token_hex(32))"
```

---

## 4. ย้ายข้อมูลจากเครื่องเก่า (ข้ามได้ถ้าเริ่มใหม่ทั้งหมด)

คัดลอกจาก `webapp\data\` ของเครื่องเก่ามาไว้ที่เดียวกันบนเครื่องใหม่ **ก่อนรันเว็บครั้งแรก**:

| ไฟล์/โฟลเดอร์ | คืออะไร | จำเป็นไหม |
|---|---|---|
| `manga.json` | เรื่องทั้งหมด + รายชื่อตอน | **จำเป็น** — ตัวที่ติดมากับ git เป็นของเก่า |
| `users.json` | บัญชีผู้ใช้ + รหัสผ่าน | **จำเป็น** |
| `categories.json` | หมวดหมู่ทั้งหมด (ชื่อ + ลำดับ) | **จำเป็น** ถ้าตั้งหมวดหมู่ไว้ |
| `users\` (ทั้งโฟลเดอร์) | ติดตามเรื่องไหน / อ่านถึงไหน / ตำแหน่งอ่านค้าง ของแต่ละคน | **จำเป็น** |
| `vapid_private.pem` | กุญแจแจ้งเตือนมือถือ (Web Push) | **จำเป็น** ถ้ามีคนเปิดแจ้งเตือนไว้ ไม่งั้นทุกเครื่องต้องกดเปิดใหม่ |
| `image_domains.json` | โดเมนรูปที่อนุญาตให้พร็อกซี | ควรเอามา |
| `chapters\`, `covers\` | แคชหน้าตอน/ปก | ไม่จำเป็น สร้างใหม่เองได้ |
| `logs\` | log เก่า | ไม่ต้องเอามา |

และเอา `.env` จากเครื่องเก่ามาด้วยจะง่ายที่สุด (แทนข้อ 3)

---

## 5. ทดสอบรันด้วยมือ

```powershell
cd C:\Project\Update-Manga\webapp
..\.venv\Scripts\python run_windows.py
```

เปิดเบราว์เซอร์บนเครื่องนั้นไปที่ http://127.0.0.1:5050 ต้องเห็นหน้า login แล้วเข้าได้
เช็คแล้วกด **Ctrl+C** ปิดก่อน ไปตั้งให้รันเองในข้อถัดไป

---

## 6. ตั้งให้รันเองตอนเปิดเครื่อง (Task Scheduler)

ต้องมี 2 งาน: ตัวเว็บ และตัวรีเฟรชหาตอนใหม่ทุก 30 นาที คัดลอกทั้งก้อนไปวางรันได้เลย:

```powershell
$root = "C:\Project\Update-Manga"
$py = "$root\.venv\Scripts\python.exe"
# ไม่มีเวลาหยุด (ค่า default ของ Windows คือหยุดเองหลัง 3 วัน) + ถ้าล้มให้เริ่มใหม่ทุก 1 นาที
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$trigger = New-ScheduledTaskTrigger -AtStartup

Register-ScheduledTask -TaskName "Manga Webapp" -Trigger $trigger -Settings $settings `
  -User "SYSTEM" -RunLevel Highest `
  -Action (New-ScheduledTaskAction -Execute $py -Argument "run_windows.py" -WorkingDirectory "$root\webapp")

Register-ScheduledTask -TaskName "Manga Refresh" -Trigger $trigger -Settings $settings `
  -User "SYSTEM" -RunLevel Highest `
  -Action (New-ScheduledTaskAction -Execute $py -Argument "refresh_loop.py" -WorkingDirectory "$root\webapp")

Start-ScheduledTask -TaskName "Manga Webapp"
Start-ScheduledTask -TaskName "Manga Refresh"
```

- รันด้วยบัญชี SYSTEM = ทำงานได้แม้ไม่มีใคร login เข้าเครื่อง ไม่ต้องเก็บรหัสผ่าน Windows ไว้ใน task
- `run_windows.py` คอยเช็คตัวเองทุก 20 วิ ถ้าเว็บค้างเกิน ~1 นาทีจะรีสตาร์ทตัวเอง ไม่ต้องเข้าไปสั่งเอง
- ถ้าเคยสร้าง task ชื่อนี้ไว้แล้ว ลบก่อนด้วย `Unregister-ScheduledTask -TaskName "Manga Webapp" -Confirm:$false`

---

## 7. เปิดให้เข้าจากภายนอกด้วยโดเมน (Caddy)

ตัวเว็บฟังแค่ `127.0.0.1:5050` (เข้าได้เฉพาะในเครื่อง) ต้องมี Caddy เป็นหน้าด่าน ทำ HTTPS ให้อัตโนมัติ

1. ตั้ง DNS ของโดเมน (A record) ชี้มาที่ IP ของเครื่องนี้ให้เรียบร้อยก่อน
2. ดาวน์โหลด `caddy.exe` (Windows amd64) จาก https://caddyserver.com/download วางไว้ที่ `C:\Caddy\`
3. สร้างไฟล์ `C:\Caddy\Caddyfile` (เปลี่ยน `yourdomain.com` เป็นโดเมนจริง):

```
yourdomain.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:5050
}
```

4. เปิดพอร์ต 80/443 และตั้งให้ Caddy รันเองตอนเปิดเครื่อง:

```powershell
New-NetFirewallRule -DisplayName "Caddy HTTP/HTTPS" -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "Caddy" -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -User "SYSTEM" -RunLevel Highest `
  -Action (New-ScheduledTaskAction -Execute "C:\Caddy\caddy.exe" -Argument "run --config C:\Caddy\Caddyfile" -WorkingDirectory "C:\Caddy")
Start-ScheduledTask -TaskName "Caddy"
```

ถ้า VPS มี firewall ของผู้ให้บริการ (หน้าเว็บจัดการ VPS) ต้องเปิดพอร์ต 80/443 ที่นั่นด้วย
**ไม่ต้องเปิดพอร์ต 5050** เพราะเว็บรับเฉพาะจากในเครื่องอยู่แล้ว

---

## 8. เช็คว่าทุกอย่างทำงาน

```powershell
Get-ScheduledTask -TaskName "Manga Webapp","Manga Refresh","Caddy" | Select TaskName, State
Invoke-WebRequest http://127.0.0.1:5050/healthz -UseBasicParsing | Select StatusCode, Content
```

ต้องได้ State = `Running` ทั้ง 3 ตัว และ healthz ตอบ `200 ok` จากนั้น:

- เปิด `https://yourdomain.com` จากมือถือ → login ได้ มีกุญแจ HTTPS
- ถ้าเริ่มใหม่: login ด้วย WEB_USERNAME/WEB_PASSWORD → แท็บตั้งค่า → เพิ่มเรื่อง
- กดปุ่มรีเฟรชทั้งหมดหนึ่งรอบ ให้ระบบดึงตอนล่าสุดและสร้างแคช

---

## 9. อัปเดตโค้ดครั้งต่อ ๆ ไป

```powershell
cd C:\Project\Update-Manga ; git pull
```

- แก้แค่ `app.js` / `style.css` → pull อย่างเดียวพอ หน้าเว็บโหลดตัวเองใหม่ให้
- แก้ไฟล์ `.py` หรือ template → ต้องรีสตาร์ทด้วย:

```powershell
Stop-ScheduledTask -TaskName "Manga Webapp" ; Start-ScheduledTask -TaskName "Manga Webapp"
```

- ถ้ามี dependency ใหม่ → `.venv\Scripts\pip install -r webapp\requirements.txt` ก่อนรีสตาร์ท

---

## ปัญหาที่พบบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| task ขึ้น Ready ไม่ใช่ Running | เปิดดู `webapp\data\logs\supervisor.log` และ `webapp.log` มักเป็น path ผิด หรือ pip install ไม่ครบ |
| เปิดโดเมนแล้วขึ้น 502 | Caddy ทำงานแต่เว็บไม่ทำงาน → เช็ค task "Manga Webapp" |
| เปิดโดเมนไม่ได้เลย / HTTPS ไม่ขึ้น | DNS ยังไม่ชี้มาเครื่องนี้ หรือพอร์ต 80/443 ยังไม่เปิด (ทั้ง Windows Firewall และของผู้ให้บริการ VPS) |
| ทุกคนหลุด login หลังย้ายเครื่อง | `SECRET_KEY` ไม่ตรงกับเครื่องเก่า → เอาค่าเดิมมาใส่แล้วรีสตาร์ท |
| ไม่มีตอนใหม่เข้ามาเลย | task "Manga Refresh" ไม่ทำงาน หรือ `CRON_TOKEN` ว่าง/ไม่ตรง → ดู log |
| ไม่มีแจ้งเตือน Telegram | ใส่ TELEGRAM_TOKEN/CHAT_ID หรือยัง และบัญชี admin ต้องติดตามเรื่องนั้นอยู่ |
| หน้าเว็บค้างจอขาว | ระบบรีสตาร์ทตัวเองภายใน ~1 นาที ถ้าเกิดบ่อย ส่ง `webapp\data\logs\hang-dumps.log` มาให้ดู |
