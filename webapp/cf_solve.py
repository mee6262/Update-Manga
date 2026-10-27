"""ผ่านหน้าตรวจของ Cloudflare ("รอสักครู่..." / cf-mitigated: challenge) แล้วพิมพ์คุกกี้ + User-Agent เป็น JSON

requests/curl_cffi/Chromium ธรรมดาไม่ผ่าน (ทดสอบกับ dark-manga 23 ต.ค.: 403 ทุกแบบ) แต่ camoufox (Firefox ที่ดัดแปลงลายนิ้วมือ)
ผ่านแบบไม่มีหน้าจอในราว 20 วิ — คุกกี้ cf_clearance ที่ได้ใช้กับ requests ต่อได้ถ้าส่ง User-Agent เดียวกันจาก IP เดียวกัน
scraper.py เรียกไฟล์นี้เป็น process แยก (เบราว์เซอร์ไม่อยู่ใน process ของเว็บ) พร้อม timeout

ติดตั้ง: pip install "camoufox[geoip]" แล้ว python -m camoufox fetch
ใช้: python cf_solve.py <url>
ผลลัพธ์ (stdout): {"ua": "...", "cookies": {"cf_clearance": "...", ...}}
    หรือ {"ua": "...", "cookies": {...}, "no_challenge": true} = เปิดได้เลยไม่มีหน้าตรวจ (เว็บเลิกตรวจแล้ว)
"""
import ctypes
import json
import os
import sys
import time
from urllib.parse import urlparse

from camoufox import DefaultAddons
from camoufox.sync_api import Camoufox

WAIT_SECONDS = 45
ATTEMPTS = 2  # camoufox สุ่มลายนิ้วมือใหม่ทุกครั้ง บางชุดไม่ผ่าน (VPS 23 ต.ค.: ผ่าน 4 จาก 6) → ลองชุดใหม่อีกครั้ง
# VPS RAM 4 GB: รอบที่ต้องลอง 2 ครั้ง Firefox กินถึง 1.7 GB เหลือ RAM ว่าง 68-143 MB → ทั้งเครื่อง swap
# เว็บเราไม่ตอบ healthz (27 ต.ค. 08:06, 20:35 / 25 ต.ค. 08:18 ตรงกับช่วงแก้หน้าตรวจทุกครั้ง)
# → RAM ว่างไม่ถึงนี้ไม่เปิดเบราว์เซอร์ (รอสักพัก แล้วค่อยยอมแพ้ให้ scraper เว้น 30 นาทีลองใหม่)
MIN_FREE_MB = 1000
RAM_WAIT_SECONDS = 30


def solve(url: str) -> dict:
    host = urlparse(url).hostname or ""
    # VPS 2 CPU / RAM 4 GB: Firefox ปกติแตกหลาย process + โหลดรูปทั้งหน้า → เว็บเราตอบ healthz ช้าสุด 23.6 วิ ระหว่างแก้
    # ไม่โหลดรูป + content process เดียว (หน้าตรวจไม่ต้องใช้รูป)
    # ไม่ใส่ uBlock + ปิด process เสริมของ Firefox (prelaunch/socket/RDD/GPU): 27 ต.ค. ทดสอบ 4 รอบ
    # Firefox สูงสุด 678-748 MB (เดิม 886-945 MB) ผ่านใน 18-22 วิ คุกกี้ใช้กับ requests ได้ทุกรอบ
    with Camoufox(headless=True, block_images=True, i_know_what_im_doing=True, exclude_addons=[DefaultAddons.UBO],
                  firefox_user_prefs={"dom.ipc.processCount": 1, "fission.autostart": False,
                                      "browser.cache.disk.enable": False, "dom.ipc.processPrelaunch.enabled": False,
                                      "network.process.enabled": False, "media.rdd-process.enabled": False,
                                      "layers.gpu-process.enabled": False, "browser.sessionhistory.max_total_viewers": 0,
                                      "extensions.webextensions.remote": False}) as browser:
        page = browser.new_page()
        ua = page.evaluate("navigator.userAgent")  # อ่านก่อนเปิดเว็บ: ผ่านหน้าตรวจแล้วหน้าเปลี่ยน evaluate พัง
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        # up-manga (25 ต.ค.): เคยตรวจแล้วเลิก → ต่ออายุคุกกี้ทุก 30 นาทีรอ cf_clearance ไม่มีวันมา จนหมดเวลา
        if not _is_challenge(page) and not any(c["name"] == "cf_clearance" for c in page.context.cookies()):
            page.wait_for_timeout(3000)  # หน้าตรวจบางแบบขึ้นช้ากว่า domcontentloaded
            if not _is_challenge(page):
                return {"ua": ua, "cookies": _jar(page, host), "no_challenge": True}
        deadline = time.time() + WAIT_SECONDS
        while time.time() < deadline:
            cookies = page.context.cookies()
            if any(c["name"] == "cf_clearance" for c in cookies):
                break
            page.wait_for_timeout(1000)
        else:
            raise RuntimeError(f"ไม่ผ่านหน้าตรวจ Cloudflare ใน {WAIT_SECONDS} วิ")
        page.wait_for_timeout(1500)  # ให้หน้าจริงตั้งคุกกี้อื่นที่ต้องใช้คู่กันให้ครบ
        return {"ua": ua, "cookies": _jar(page, host)}


def _free_mb() -> int | None:
    if os.name != "nt":
        return None

    class MemoryStatus(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong)] + [
            (name, ctypes.c_ulonglong) for name in ("total", "avail", "page_total", "page_avail", "virt_total", "virt_avail", "ext")]
    status = MemoryStatus()
    status.dwLength = ctypes.sizeof(MemoryStatus)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        return None
    return status.avail // 2**20


def _wait_for_ram():
    """รอ RAM ว่างพอเปิด Firefox — รอบสองต้องรอ Firefox ของรอบแรกปิดให้หมดก่อน ไม่งั้นสองตัวซ้อนกัน"""
    deadline = time.time() + RAM_WAIT_SECONDS
    while True:
        free = _free_mb()
        if free is None or free >= MIN_FREE_MB:
            return
        if time.time() >= deadline:
            raise RuntimeError(f"RAM ว่างเหลือ {free} MB (ต้องการ {MIN_FREE_MB}) ไม่เปิดเบราว์เซอร์ กันเว็บค้าง")
        time.sleep(2)


def _jar(page, host: str) -> dict:
    return {c["name"]: c["value"] for c in page.context.cookies() if host.endswith(c["domain"].lstrip("."))}


def _is_challenge(page) -> bool:
    """หน้าตรวจของ Cloudflare ("Just a moment..." / "รอสักครู่...") — ชื่อหน้า หรือสคริปต์ challenge-platform"""
    try:
        title = (page.title() or "").lower()
        return ("just a moment" in title or "รอสักครู่" in title
                or page.locator("script[src*='challenge-platform']").count() > 0)
    except Exception:
        return True  # อ่านไม่ได้ (หน้ากำลังเปลี่ยน) = ถือว่ายังตรวจอยู่ ใช้ทางเดิม


if __name__ == "__main__":
    for attempt in range(ATTEMPTS):
        try:
            _wait_for_ram()
            print(json.dumps(solve(sys.argv[1])))
            break
        except Exception as e:
            print(f"รอบ {attempt + 1}: {e}", file=sys.stderr, flush=True)
            if attempt + 1 == ATTEMPTS:
                raise SystemExit(str(e))
