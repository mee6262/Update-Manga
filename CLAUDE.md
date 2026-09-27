# CLAUDE.md — Update-Manga

## ตอบ/ทำงาน
- ตอบไทย สั้น: ผล → ตัวเลขยืนยัน → สิ่งที่ผู้ใช้ต้องทำ ไม่มีคำนำ/สรุปซ้ำ ไม่ echo โค้ดที่เพิ่งเขียน
- คำสั่งที่เกี่ยวกันรวบเป็น call เดียว
- production = **Windows VPS** → คำสั่งให้ผู้ใช้เป็น PowerShell เท่านั้น (ไม่มี systemctl/bash)
- ผู้ใช้สั่ง push = push ตรงเข้า `main` (VPS `git pull` จาก main)

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

## ทดสอบ (ไม่มี test suite)
- รันใน sandbox เสมอ: copy webapp → scratchpad; user ทดสอบสร้างด้วย `werkzeug.security.generate_password_hash`
- `import app` รัน migration แก้ data/manga.json จริง → เผลอแล้ว `git checkout -- webapp/data/manga.json`
- เว็บจำลอง = mangareader (`#chapterlist` + `ts_reader.run(...)`) + flag file จำลอง 522/ค้าง/ตอนหลอก
- ฆ่า process ใช้ `pkill -if` — venv python โชว์เป็น `Python` ตัวใหญ่ `pkill -f python` ไม่เจอ → เทสต์ไปโดนเซิร์ฟเวอร์ตัวเก่า
- zsh: glob ที่ไม่เจอไฟล์ = คำสั่งทั้งบรรทัดล้ม → ระบุชื่อไฟล์ตรง
- UI: browser pane viewport 0x0 → resize ก่อน; pane ซ่อน = rAF ไม่ทำงาน → เรียกฟังก์ชันตรงแทนรอ scroll event
- waitress ลองบน mac ได้ (`pip install waitress`)
- เว็บจริงไว้ regression: go-manga, up-manga (URL จาก data/manga.json), niceoppai, manga-lc

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
