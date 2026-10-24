# CLAUDE.md — Update-Manga

## ตอบ/ทำงาน
- ตอบไทย สั้น: ผล → ตัวเลขยืนยัน → สิ่งที่ผู้ใช้ต้องทำ ไม่มีคำนำ/สรุปซ้ำ ไม่ echo โค้ดที่เพิ่งเขียน
- คำสั่งที่เกี่ยวกันรวบเป็น call เดียว
- production = **Windows VPS** → คำสั่งให้ผู้ใช้เป็น PowerShell เท่านั้น (ไม่มี systemctl/bash)
- ผู้ใช้สั่ง push = push ตรงเข้า `main` (VPS `git pull` จาก main)
- รันอยู่ที่ไหน: cwd `C:\Project\Update-Manga` = **บน VPS (production จริง)** → ทำตามหัวข้อ "บน VPS" ด้านล่าง; อื่น ๆ = mac

## อ่านไฟล์
- app.py 1.3k / app.js 1.1k / scraper.py 470 บรรทัด → ห้ามอ่านทั้งไฟล์: `grep -n` แล้ว `sed -n 'a,bp'` หรือ token-savior `find_symbol` / `get_function_source`
- cat ได้เฉพาะไฟล์ < 60 บรรทัด ไม่รู้ความยาว → `wc -l` ก่อน
- ห้ามใช้ memory_* ของ token-savior
- RTK ตัดผลเทสต์จนไม่ครบ → `rtk proxy <cmd>` ซ้ำก่อนสรุป

## แผนที่โค้ด (webapp/)
- app.py — routes + ตรรกะหลัก: `refresh_from_sources` (รวมหลายแหล่ง, alts, ตัดตอนหลอก) → `_apply_refresh` → `_commit_refreshes`; อ่านตอน `get_chapter` → `_load_chapter_from_any`; `proxy_image`; `index` ฝัง BOOT
- scraper.py — `fetch` (host-down memo, throttle ต่อโฮสต์, Session ต่อ thread); `parse_index_page` ลำดับ: `#chapterlist` → `a.chrow` (niceoppai หลายหน้า) → Madara ajax; `parse_chapter_page`: ts_reader → `.reading-content`/`#readerarea`/`#image-container` (อ่าน data-src ก่อน src)
- storage.py — ไฟล์ JSON + cache ตาม mtime, `state_lock`, cache ตอน/ปก
- static/app.js — SPA ไม่มี build; templates/index.html ฝัง `window.__BOOT__`
- run_windows.py — ตัวคุม + waitress ลูก, `/healthz`, log ที่ data/logs/
- data/manga.json **ถูก track ใน git**; chapters/ covers/ users/ logs/ ignore

## Invariants (ห้ามพัง)
- `storage.load_*()` คืน object ที่แชร์ทั้ง process → จะแก้แล้ว save ต้อง `fresh=True`; ข้อมูลรายคนครอบ `storage.state_lock`
- ห้ามยิง network ระหว่าง load→save ของ manga.json หรือใน state_lock (ดึงก่อน แล้ว load fresh ตอน save)
- ตัวตนตอน = `_chapter_key` (เลขตอน) ไม่ใช่ URL; read_keys/last_scroll อิง key; chapters เรียงใหม่→เก่า; `alts` = ลิงก์แหล่งสำรอง
- ตอนใหม่ตัดสินด้วย `_is_new_chapter` (เลขเพิ่มจริง) ห้ามเทียบข้อความ
- ตอนหลอก: รูปจริง < `MIN_REAL_IMAGES`(3) → ตัดทิ้ง, ห้าม cache
- `?peek=1` ห้ามมาร์คอ่าน
- network ใหม่: เช็ค `scraper.host_is_down`/`host_is_stalled` ก่อน + timeout แบบ (connect, read) — ยิงค้างทำ thread waitress หมด = เว็บจอขาว
- ห้ามเปิด `SESSION_REFRESH_EACH_REQUEST` (แคชรูปในเบราว์เซอร์พัง)
- static ได้ `?v=mtime` อัตโนมัติ; `build_id` นับแค่ app.js/style.css (หน้าเว็บ auto-reload เมื่อเปลี่ยน)

## ทดสอบ
- unittest: `python -m unittest discover -s webapp/tests` (รันจากสำเนาชั่วคราว ไม่แตะ data จริง)
- รันใน sandbox เสมอ: copy webapp → scratchpad (VPS: `$env:TEMP\manga-sandbox`); user ทดสอบสร้างด้วย `werkzeug.security.generate_password_hash`
- `import app` รัน migration แก้ data/manga.json จริง → เผลอแล้ว `git checkout -- webapp/data/manga.json`
- เว็บจำลอง = mangareader (`#chapterlist` + `ts_reader.run(...)`) + flag file จำลอง 522/ค้าง/ตอนหลอก
- (mac) ฆ่า process ใช้ `pkill -if` — venv python โชว์เป็น `Python` ตัวใหญ่ `pkill -f python` ไม่เจอ → เทสต์ไปโดนเซิร์ฟเวอร์ตัวเก่า
- (mac) zsh: glob ที่ไม่เจอไฟล์ = คำสั่งทั้งบรรทัดล้ม → ระบุชื่อไฟล์ตรง
- UI: browser pane viewport 0x0 → resize ก่อน; pane ซ่อน = rAF ไม่ทำงาน → เรียกฟังก์ชันตรงแทนรอ scroll event
- waitress ลองบน mac ได้ (`pip install waitress`)
- เว็บจำลอง/เซิร์ฟเวอร์ทดสอบ: `SECRET_KEY` คงที่ ไม่งั้นรีสตาร์ทแล้ว session หลุด (POST ได้ 401 = ผู้เยี่ยมชม)
- เว็บจริงไว้ regression: go-manga, up-manga (URL จาก data/manga.json), niceoppai, manga-lc

## บน VPS (Windows Server, PowerShell)
- เชลล์ของ Claude = **Git Bash** (`CLAUDE_CODE_USE_POWERSHELL_TOOL=0` ใน `~/.claude/settings.json` → RTK บีบทุกคำสั่ง) ใช้ path `/c/Project/Update-Manga`
  - คำสั่ง Windows (`*-ScheduledTask`, `Start-Process -PassThru`/`Stop-Process -Id`, `Get-CimInstance`) → `powershell.exe -NoProfile -Command "..."`
  - แก้ไฟล์ด้วย Edit/Write เท่านั้น (ไม่ใช้ `Set-Content`/`sed` กับไทย); python พิมพ์ไทยได้เพราะตั้ง `PYTHONIOENCODING=utf-8` ไว้
  - คำสั่งที่บอกให้มี่รันเอง ยังเป็น PowerShell ตามเดิม
- นี่คือเว็บที่มี่ใช้จริง: ทดสอบใน `$env:TEMP\manga-sandbox` + พอร์ตอื่น (เช่น 5099) เท่านั้น — ห้าม `import app` ในโฟลเดอร์จริง
  (รัน migration ใส่ data จริงขณะเซิร์ฟเวอร์ตัวจริงเขียนอยู่)
- python = `.venv\Scripts\python.exe`; process ทดสอบเปิดด้วย `Start-Process -PassThru` แล้วฆ่าด้วย PID
  ห้าม `Stop-Process -Name python` (โดนเซิร์ฟเวอร์จริง)
- log: `webapp\data\logs\webapp.log` (เซิร์ฟเวอร์), `supervisor.log` (รีสตาร์ทเมื่อไร เพราะอะไร) — อ่านด้วย `Get-Content -Tail 200`
  เว็บล่ม/จอขาว: ดู supervisor.log + `/healthz` ก่อนแก้; `[client-viewport]` = รายงานเมนูลอยจาก iPhone
- รีสตาร์ท (`Stop-ScheduledTask`/`Start-ScheduledTask "Manga Webapp"`) = เว็บดับชั่วครู่ → ถามมี่ก่อนทุกครั้ง
- git: `git pull` ก่อนเริ่มแก้; แก้เสร็จ commit + push เข้า main จากบน VPS เลย (mac ต้อง pull ก่อนทำงานต่อ)
  data/manga.json ถูกแอปแก้ตลอด → ห้าม add/commit/checkout/stash ทิ้ง; ใช้ `git add <ไฟล์>` ระบุชื่อเท่านั้น
- **ข้อมูลผู้ใช้** (`webapp\data\` ทั้งโฟลเดอร์ + `.env`: บัญชี/รหัสผ่าน hash, ประวัติอ่าน-ดู, คลังวิดีโอ, คอมเมนต์) กู้คืนไม่ได้ถ้าหาย
  - ห้าม: `git clean` (ทุกแบบ), `git reset --hard`, `git stash -u/-a`, `git checkout -- .`, ลบ/ย้ายไฟล์ใน data ด้วยมือ
  - ก่อนแก้โค้ดที่ migrate/เขียนโครงไฟล์ใน data ใหม่ หรือก่อนแก้ data ด้วยมือ → รัน `tools\backup_data.ps1` ก่อน
  - ห้ามแสดง `.env`, password hash, ข้อมูลรายคนในแชตเกินที่จำเป็นต่อการแก้ปัญหา
- ปรับแต่ง Windows: บอกค่าเดิมก่อนเปลี่ยน + ถามก่อนทุกอย่างที่ต้องรีบูต หรือแตะ firewall / RDP / SSH / บัญชีผู้ใช้ / เครือข่าย
  (ตั้งผิดแล้วล็อกตัวเองออกจากเครื่อง) — เปลี่ยนทีละอย่างแล้วเช็คว่ายังเข้าเครื่องได้

## Deploy (VPS: `C:\Project\Update-Manga`, task "Manga Webapp")
- แก้ .py/template → `git pull` + Stop/Start task; แก้แค่ app.js/style.css → `git pull` พอ
- dependency ใหม่ → `.venv\Scripts\pip install -r webapp\requirements.txt`
- ทุกครั้งที่ push แจ้ง: commit hash + ต้องรีสตาร์ทไหม + คำสั่ง PowerShell

## Commit
- ภาษาไทย: ต้นเหตุ + ตัวเลขจากการทดสอบ ไม่มีคำโฆษณา
- `git status` ก่อน add; ห้าม commit data/manga.json ที่ถูกแก้จากการทดสอบ

## ห้ามย่อ แม้เปลืองโทเคน
- ทำให้อาการเกิดซ้ำก่อนแก้ แล้ววัดตัวเลขหลังแก้
- แตะ app.py/scraper.py → regression: สลับแหล่งเมื่อเว็บล่ม, ตอนหลอก, ตำแหน่งอ่านค้าง, เว็บจริงข้างบน
- caveat/ข้อจำกัดที่ผู้ใช้ต้องรู้
