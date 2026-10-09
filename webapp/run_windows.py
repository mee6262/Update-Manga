"""รันเว็บแอปแบบ production บน Windows ด้วย waitress (gunicorn ใช้บน Windows ไม่ได้)
ใช้แทนคำสั่ง gunicorn ในคู่มือฝั่ง Linux — ดู README หัวข้อ Deploy บน Windows VPS

    python run_windows.py           ตัวคุม: รันเซิร์ฟเวอร์เป็น process ลูก แล้วคอยเช็คว่ายังตอบอยู่ไหม
                                    ถ้าค้าง/ตายเองจะรีสตาร์ทให้อัตโนมัติ (Task Scheduler ใช้คำสั่งนี้)
    python run_windows.py --serve   รันเซิร์ฟเวอร์ตรง ๆ ไม่มีตัวคุม (ไว้ดีบัก)

log อยู่ที่ webapp/data/logs/ — webapp.log (เซิร์ฟเวอร์), supervisor.log (ตัวคุม: รีสตาร์ทเมื่อไหร่ เพราะอะไร)
และ hang-dumps.log (ภาพรวมว่าแต่ละ thread ค้างอยู่ตรงไหนตอนที่เซิร์ฟเวอร์ไม่ตอบ ไว้หาต้นเหตุ)
"""
import faulthandler
import logging
import os
import subprocess
import sys
import threading
import time
import urllib.request
from logging.handlers import RotatingFileHandler
from pathlib import Path

HOST, PORT = "127.0.0.1", 5050
# งานเกือบทั้งหมดคือรอเน็ต (พร็อกซีรูป/ดึงหน้าเว็บ) ตอนหนึ่งมีรูปหลายสิบใบ ถ้ารับได้ทีละ 4 คำขอ (ค่า default)
# จะต่อคิวกันยาวจนทั้งเว็บหน่วงตาม
THREADS = 16

HEALTH_URL = f"http://{HOST}:{PORT}/healthz"
CHECK_EVERY = 20       # วินาที
HEALTH_TIMEOUT = 10
FAILS_BEFORE_RESTART = 3  # ไม่ตอบติดกัน 3 รอบ (~1 นาที) ถึงจะรีสตาร์ท กันรีสตาร์ทเพราะช้าแค่ชั่วครู่
STARTUP_GRACE = 30     # ช่วงแรกหลังสตาร์ทยังไม่เช็ค (กำลังโหลดข้อมูล)

LOG_DIR = Path(__file__).parent / "data" / "logs"
DUMP_REQUEST = LOG_DIR / "dump-now.flag"


def _setup_logging(filename: str) -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    handlers = [RotatingFileHandler(LOG_DIR / filename, maxBytes=5_000_000, backupCount=3, encoding="utf-8")]
    console = sys.__stdout__
    if console is not None:
        try:
            # console ของ Windows อาจเป็น cp874/cp1252 พิมพ์อีโมจิ/บางตัวอักษรไม่ได้แล้ว error ทั้งบรรทัด
            console.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
        handlers.append(logging.StreamHandler(console))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s", handlers=handlers)
    return logging.getLogger("manga")


class _PrintToLog:
    """ให้ print() ในโค้ดแอป (เช่น "⚠️ ดึงข้อมูลไม่สำเร็จ") ลงไฟล์ log ด้วย — ตอนรันจาก Task Scheduler
    ไม่มีหน้าจอให้ดู ถ้าไม่เก็บลงไฟล์ ข้อความพวกนี้หายหมด"""

    def __init__(self, logger: logging.Logger, level: int):
        self.logger, self.level = logger, level
        self._buf = ""
        self._lock = threading.Lock()

    def write(self, text: str) -> int:
        with self._lock:
            self._buf += text
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                if line.strip():
                    self.logger.log(self.level, line)
        return len(text)

    def flush(self):
        pass


# ---------- process ลูก: ตัวเซิร์ฟเวอร์จริง ----------

def serve():
    log = _setup_logging("webapp.log")
    sys.stdout = _PrintToLog(logging.getLogger("app"), logging.INFO)
    sys.stderr = _PrintToLog(logging.getLogger("app"), logging.ERROR)
    dump_path = LOG_DIR / "hang-dumps.log"
    # หมุนไฟล์ตอนเริ่ม (ไฟล์นี้เขียนตรง ไม่ผ่าน RotatingFileHandler) — เก็บของเก่าไว้ 1 ชุด
    try:
        if dump_path.stat().st_size > 5_000_000:
            dump_path.replace(dump_path.with_suffix(".log.1"))
    except OSError:
        pass
    dump_file = open(dump_path, "a", encoding="utf-8")

    def watch_dump_requests():
        # thread แยกของตัวเอง ทำงานได้แม้ thread ของ waitress จะค้างหมดทุกตัว
        while True:
            time.sleep(2)
            if DUMP_REQUEST.exists():
                dump_file.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} เซิร์ฟเวอร์ไม่ตอบ: ภาพรวมทุก thread =====\n")
                dump_file.flush()
                faulthandler.dump_traceback(file=dump_file, all_threads=True)
                dump_file.flush()
                DUMP_REQUEST.unlink(missing_ok=True)

    def exit_when_supervisor_gone():
        # ตัวคุมถือท่อ stdin ของเราไว้ ถ้าตัวคุมถูกปิด (เช่น Stop-ScheduledTask) ท่อจะปิดตาม — ต้องปิดตัวเอง
        # ด้วย ไม่งั้นบน Windows process ลูกจะค้างอยู่แล้วยึดพอร์ตไว้ สั่ง Start ใหม่จะเปิดไม่ขึ้น
        if sys.__stdin__ is None:
            return
        try:
            sys.__stdin__.buffer.read()
        except Exception:
            pass
        os._exit(0)

    threading.Thread(target=watch_dump_requests, daemon=True).start()
    if "--supervised" in sys.argv:
        threading.Thread(target=exit_when_supervisor_gone, daemon=True).start()

    from waitress import serve as waitress_serve

    import app as app_module

    log.info("เริ่มเซิร์ฟเวอร์ที่ http://%s:%s (threads=%s)", HOST, PORT, THREADS)
    waitress_serve(app_module.app, host=HOST, port=PORT, threads=THREADS)


# ---------- process แม่: ตัวคุม ----------

def _healthy() -> bool:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=HEALTH_TIMEOUT) as resp:
            return resp.status == 200
    except Exception:
        return False


def supervise():
    log = _setup_logging("supervisor.log")
    print(f"กำลังรันที่ http://{HOST}:{PORT} (กด Ctrl+C เพื่อหยุด) — log อยู่ที่ {LOG_DIR}")
    no_window = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    while True:
        child = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "--serve", "--supervised"],
            cwd=os.path.dirname(os.path.abspath(__file__)),
            stdin=subprocess.PIPE,
            creationflags=no_window,
        )
        log.info("เริ่มเซิร์ฟเวอร์ (pid %s)", child.pid)
        started, fails = time.monotonic(), 0
        try:
            while child.poll() is None:
                time.sleep(CHECK_EVERY)
                if time.monotonic() - started < STARTUP_GRACE or child.poll() is not None:
                    continue
                if _healthy():
                    fails = 0
                    continue
                fails += 1
                log.warning("เซิร์ฟเวอร์ไม่ตอบ (%s/%s)", fails, FAILS_BEFORE_RESTART)
                if fails >= FAILS_BEFORE_RESTART:
                    # ขอให้เซิร์ฟเวอร์บันทึกว่าแต่ละ thread ค้างอยู่ตรงไหนก่อนปิด ไว้หาต้นเหตุทีหลัง
                    DUMP_REQUEST.touch()
                    time.sleep(5)
                    log.error("เซิร์ฟเวอร์ค้างเกิน %s วินาที รีสตาร์ทให้อัตโนมัติ (ดู hang-dumps.log)",
                              CHECK_EVERY * FAILS_BEFORE_RESTART)
                    child.kill()
                    child.wait()
                    break
            else:
                log.error("เซิร์ฟเวอร์หยุดทำงานเอง (exit code %s) เริ่มใหม่ให้อัตโนมัติ", child.returncode)
        except KeyboardInterrupt:
            child.kill()
            return
        time.sleep(5)


if __name__ == "__main__":
    if "--serve" in sys.argv:
        serve()
    else:
        supervise()
