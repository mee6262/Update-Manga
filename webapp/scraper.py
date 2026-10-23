"""
Scraper สำหรับกลุ่มเว็บที่ใช้ธีมเดียวกับ slow-manga / go-manga / up-manga / tanuki-manga
ใช้ requests ธรรมดา (ไม่ต้องใช้ playwright) เพราะข้อมูลที่ต้องการ render มาใน HTML/JS อยู่แล้ว
"""
import functools
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
import urllib3
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7",
}

COVER_FALLBACK_SELECTORS = [
    ".series-thumb img",  # oremanga.net (ไม่มี og:image)
    ".summary_image img",
    ".tab-summary img",
    ".thumb img",
    "img.wp-post-image",
]

TIMEOUT = 20


_local = threading.local()

# กันใช้เซิร์ฟเวอร์ยิงเข้าที่อยู่ภายใน (127.0.0.1, 192.168.x, 169.254.169.254 ฯลฯ) ผ่านลิงก์ที่ผู้ใช้ส่งมา
# หรือที่เว็บต้นทางฝังไว้ — ตั้ง ALLOW_PRIVATE_FETCH=1 ตอนทดสอบกับเว็บจำลองบนเครื่องตัวเอง
ALLOW_PRIVATE_FETCH = os.environ.get("ALLOW_PRIVATE_FETCH") == "1"
_public_host_memo: dict[str, tuple[bool, float]] = {}


def is_public_url(url: str) -> bool:
    """http(s) และชื่อโฮสต์ resolve แล้วเป็นที่อยู่สาธารณะทั้งหมด (จำผลไว้ 10 นาที)"""
    try:
        parts = urlparse(url)
        host = (parts.hostname or "").lower()
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not host:
        return False
    if ALLOW_PRIVATE_FETCH:
        return True
    now = time.monotonic()
    memo = _public_host_memo.get(host)
    if memo and memo[1] > now:
        return memo[0]
    try:
        infos = socket.getaddrinfo(host, None)
        ok = bool(infos) and all(ipaddress.ip_address(info[4][0].split("%")[0]).is_global for info in infos)
    except (OSError, ValueError):
        ok = False
    _public_host_memo[host] = (ok, now + 600)
    return ok


class BlockedURL(requests.exceptions.InvalidURL):
    pass


def check_public(url: str):
    if not is_public_url(url):
        raise BlockedURL(f"ไม่อนุญาตให้เข้าถึงที่อยู่นี้: {urlparse(url).hostname}")


def guard_redirect(resp, *args, **kwargs):
    """hook ของ requests — ถูกเรียกกับทุกคำตอบรวมถึง 302 ก่อนตามไป: ปลายทางต้องเป็นที่อยู่สาธารณะด้วย"""
    if resp.is_redirect:
        check_public(urljoin(resp.url, resp.headers.get("Location", "")))
    return resp


def session() -> requests.Session:
    """Session ต่อ thread (requests.Session ไม่ thread-safe เต็มที่) ใช้ keep-alive ซ้ำกับเว็บ/CDN
    เดิม ไม่ต้องจับมือ TCP+TLS ใหม่ทุกรูป/ทุกหน้า"""
    s = getattr(_local, "session", None)
    if s is None:
        s = requests.Session()
        adapter = HTTPAdapter(pool_connections=16, pool_maxsize=16)
        s.mount("http://", adapter)
        s.mount("https://", adapter)
        s.hooks["response"].append(guard_redirect)
        _local.session = s
    return s


_host_next_at: dict[str, float] = {}
_host_lock = threading.Lock()


def throttle(url: str, min_interval: float):
    """เว้นระยะคำขอไปโฮสต์เดียวกันอย่างน้อย min_interval วินาที (กันโดน block) แต่โฮสต์ต่างกัน
    ยิงพร้อมกันได้ — ทำให้รีเฟรชทั้งหมดเร็วขึ้นโดยไม่ถล่มเว็บใดเว็บหนึ่ง"""
    host = urlparse(url).netloc
    with _host_lock:
        now = time.monotonic()
        start = max(now, _host_next_at.get(host, 0.0))
        _host_next_at[host] = start + min_interval
    if start > now:
        time.sleep(start - now)


def domain_of(url: str) -> str:
    return urlparse(url).netloc


# จำว่าเว็บไหนเพิ่งล่ม (เชื่อมต่อไม่ได้ / timeout / 5xx เช่น Cloudflare 522, 523) ไว้ช่วงหนึ่ง —
# เว็บที่ล่มแบบนี้มักค้างรอเกือบ 20 วิก่อนจะตอบ error ถ้าไม่จำไว้ ทุกคำขอที่ไปเว็บนั้นจะต้องรอเก้อซ้ำ ๆ
# ทั้งตอนผู้ใช้เปิดอ่านและตอนรีเฟรช พอพ้นเวลาจะกลับไปลองใหม่เองเผื่อเว็บฟื้นแล้ว
HOST_DOWN_SECONDS = 10 * 60
_host_down_until: dict[str, float] = {}


def _host_key(url: str) -> str:
    return urlparse(url).netloc.lower()


def host_is_down(url: str) -> bool:
    return _host_down_until.get(_host_key(url), 0.0) > time.monotonic()


# ผลดึงหน้าเรื่องรอบล่าสุดต่อเว็บ (หน้าแอดมิน "เว็บต้นทาง") — 403 จาก Cloudflare ไม่เข้า host-down ข้างบน
# เดิมเลยขึ้น "ปกติ" ทั้งที่ดึงไม่ได้ทุกเรื่อง; เก็บในหน่วยความจำพอ (รีเฟรชรอบหน้าก็ได้ค่าใหม่)
_index_result: dict[str, dict] = {}


def record_index_result(url: str, error: Exception | None):
    code = re.search(r"\b([45]\d\d)\b", str(error)) if error else None
    if code and code.group(1) in ("404", "410"):
        return  # หน้านี้หน้าเดียวหาย (ลิงก์ผิด/เรื่องถูกลบ) ไม่ใช่เว็บมีปัญหา — ไม่งั้นทุกเรื่องในเว็บนี้ขึ้นแดง
    _index_result[_host_key(url)] = {
        "at": datetime.now(timezone.utc).isoformat(),
        "error": (code.group(1) if code else (str(error) or error.__class__.__name__)[:60]) if error else None,
    }


def index_result(url: str) -> dict | None:
    return _index_result.get(_host_key(url))


# Cloudflare หน้าตรวจ ("รอสักครู่...", cf-mitigated: challenge) → ให้ cf_solve.py (camoufox, process แยก) ผ่านให้
# แล้วจำคุกกี้ cf_clearance + User-Agent คู่กันไว้ต่อเว็บ ทุกคำขอไปเว็บนั้น (หน้าเรื่อง/ตอน/รูป) ส่งคู่นี้ไปด้วย
# แก้แบบเบื้องหลังเสมอ: คำขอที่โดนตรวจล้มทันทีเหมือนเดิม ไม่รอเบราว์เซอร์ 20-60 วิ (กัน thread waitress หมด)
# เรื่องถัดไปในรอบรีเฟรชเดียวกัน / ครั้งหน้าที่เปิดอ่าน ก็ได้คุกกี้ใหม่แล้ว
CF_SOLVE_TIMEOUT = 180  # cf_solve.py ลองได้ 2 รอบ (VPS: รอบเดียว ~30 วิ, ต้องใช้รอบสอง 115-133 วิ)
CF_RETRY_SECONDS = 30 * 60  # แก้ไม่ผ่าน/ยังไม่ได้ติดตั้ง camoufox → เว้นก่อนลองใหม่ (เปิดเบราว์เซอร์กิน CPU/RAM)
CF_FILE = Path(__file__).with_name("data") / "cf_clearance.json"
_cf_lock = threading.Lock()
_cf_solving: set[str] = set()
_cf_retry_at: dict[str, float] = {}
_cf_last_error: dict[str, str] = {}
try:
    _cf_clearance: dict[str, dict] = json.loads(CF_FILE.read_text(encoding="utf-8"))
except (OSError, ValueError):
    _cf_clearance = {}


CF_RENEW_SECONDS = 100 * 60  # dark-manga: คุกกี้อยู่ ~2 ชม. (23:04 → แก้ใหม่ 01:09) → ต่อล่วงหน้า ไม่ให้มีช่วงรูป/หน้าโหลดไม่ขึ้น


def cf_headers(url: str) -> dict:
    """User-Agent + Cookie ที่ผ่าน Cloudflare แล้วของเว็บนี้ ({} = ไม่เคยโดนตรวจ) — ใกล้หมดอายุสั่งแก้ใหม่เบื้องหลัง"""
    entry = _cf_clearance.get(_host_key(url))
    if not entry:
        return {}
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(entry["at"])).total_seconds()
    except (KeyError, ValueError):
        age = CF_RENEW_SECONDS
    if age >= CF_RENEW_SECONDS:
        request_cf_solve(url)  # ใช้คุกกี้เดิมต่อระหว่างรอ
    return {"User-Agent": entry["ua"], "Cookie": "; ".join(f"{k}={v}" for k, v in entry["cookies"].items())}


def is_cf_challenge(resp: requests.Response | None) -> bool:
    return resp is not None and resp.status_code in (403, 503) and resp.headers.get("cf-mitigated") == "challenge"


def cf_status(url: str) -> dict | None:
    host = _host_key(url)
    if host in _cf_solving:
        return {"state": "solving"}
    if host in _cf_last_error:
        return {"state": "failed", "error": _cf_last_error[host]}
    if host in _cf_clearance:
        return {"state": "ok", "at": _cf_clearance[host].get("at")}
    return None


def _run_cf_solver(url: str):
    host = _host_key(url)
    started = time.monotonic()
    try:
        proc = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("cf_solve.py")), url],
            capture_output=True, text=True, encoding="utf-8", timeout=CF_SOLVE_TIMEOUT,
            stdin=subprocess.DEVNULL,
            # priority ต่ำ (Firefox ลูกได้ตาม): VPS 2 CPU — ทดสอบ camoufox ติดกันแล้วเว็บไม่ตอบ healthz 1 ครั้ง (23 ต.ค. 22:32)
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0),
        )
        if proc.returncode != 0:
            lines = (proc.stderr or "").strip().splitlines()
            message = lines[-1] if lines else f"exit {proc.returncode}"
            if "No module named 'camoufox'" in message:
                message = "ยังไม่ได้ติดตั้ง camoufox"
            raise RuntimeError(message[:200])
        result = json.loads(proc.stdout.strip().splitlines()[-1])
        if "cf_clearance" not in result.get("cookies", {}):
            raise RuntimeError("ไม่ได้คุกกี้ cf_clearance")
        with _cf_lock:
            _cf_clearance[host] = {**result, "at": datetime.now(timezone.utc).isoformat()}
            _cf_last_error.pop(host, None)
            tmp = CF_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(_cf_clearance, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, CF_FILE)
        print(f"[cloudflare] ผ่านหน้าตรวจ {host} ใน {time.monotonic() - started:.0f} วิ", flush=True)
    except Exception as e:
        message = "หมดเวลา" if isinstance(e, subprocess.TimeoutExpired) else (str(e) or e.__class__.__name__)
        with _cf_lock:
            _cf_last_error[host] = message
            _cf_retry_at[host] = time.monotonic() + CF_RETRY_SECONDS
        print(f"[cloudflare] ⚠️ ผ่านหน้าตรวจ {host} ไม่สำเร็จ: {message}", flush=True)
    finally:
        with _cf_lock:
            _cf_solving.discard(host)


def request_cf_solve(url: str):
    """โดนหน้าตรวจ → สั่งแก้เบื้องหลัง (ครั้งละ 1 ต่อเว็บ, พลาดแล้วเว้น 30 นาที) ไม่รอผล"""
    host = _host_key(url)
    with _cf_lock:
        if host in _cf_solving or _cf_retry_at.get(host, 0.0) > time.monotonic():
            return
        _cf_solving.add(host)
    threading.Thread(target=_run_cf_solver, args=(url,), daemon=True, name=f"cf-solve-{host}").start()


def wait_cf_solve(url: str, timeout: float) -> bool:
    """สำหรับงานเบื้องหลัง (รอบรีเฟรช) เท่านั้น — รอให้การแก้ของเว็บนี้จบ คืน True ถ้าได้คุกกี้"""
    host = _host_key(url)
    deadline = time.monotonic() + timeout
    while host in _cf_solving and time.monotonic() < deadline:
        time.sleep(1)
    return host in _cf_clearance and host not in _cf_last_error


def _mark_host(url: str, down: bool):
    if down:
        _host_down_until[_host_key(url)] = time.monotonic() + HOST_DOWN_SECONDS
    else:
        _host_down_until.pop(_host_key(url), None)


def mark_host_down(url: str):
    _mark_host(url, down=True)


# คำขอที่ยังรอคำตอบแรก (header) อยู่ แยกตามเว็บ — ช่วงก่อนที่จะรู้ว่าเว็บล่ม (ยังไม่มีคำขอไหน timeout)
# ทุกคำขอไปเว็บนั้นจะค้างรอพร้อมกันหมด เช่นหน้าแรกมีปก 10 เรื่องจากเว็บที่ล่ม = ยึด thread 10 ตัว
# ถ้ามีคำขอก่อนหน้ารอมานานเกินกำหนดแล้วยังไม่ได้คำตอบ คำขอใหม่ไปเว็บเดียวกันให้ยอมแพ้ทันที
STALL_SECONDS = 4
_awaiting: dict[str, list["awaiting_response"]] = {}
_awaiting_lock = threading.Lock()


def host_is_stalled(url: str, limit: float | None = None) -> bool:
    """มีคำขอไปเว็บนี้ค้างเกินเพดานของตัวเอง (หรือเกิน limit ถ้าระบุ)"""
    now = time.monotonic()
    with _awaiting_lock:
        return any(now - a.started > (a.limit if limit is None else limit) for a in _awaiting.get(_host_key(url), ()))


class awaiting_response:
    """ครอบช่วงที่รอเว็บ (with scraper.awaiting_response(url): resp = session().get(...)) — ค้างเกิน limit วิ
    = เว็บนั้นช้า คำขอใหม่ไปเว็บเดียวกันยอมแพ้ทันที ปกติครอบแค่ช่วงรอ header (4 วิ) ส่วนพร็อกซีรูปครอบทั้งคำขอ
    รวมช่วงอ่านไฟล์ด้วยเพดานที่ยาวกว่า เพราะเว็บที่หยดข้อมูลทีละนิดตอบ header ทันทีแต่ยึด thread ตอนอ่านไฟล์"""

    def __init__(self, url: str, limit: float = STALL_SECONDS):
        self.key, self.limit, self.started = _host_key(url), limit, time.monotonic()

    def __enter__(self):
        with _awaiting_lock:
            _awaiting.setdefault(self.key, []).append(self)

    def __exit__(self, *exc):
        with _awaiting_lock:
            waiting = _awaiting.get(self.key, [])
            if self in waiting:
                waiting.remove(self)
            if not waiting:
                _awaiting.pop(self.key, None)


# จำนวนคำขอพร้อมกันต่อเว็บ — กันเว็บช้าเว็บเดียวยึด thread ของ waitress (16 ตัว) จนหมด
_host_slots: dict[str, threading.BoundedSemaphore] = {}
_host_slots_lock = threading.Lock()


def host_slots(url: str, limit: int) -> threading.BoundedSemaphore:
    with _host_slots_lock:
        return _host_slots.setdefault(_host_key(url), threading.BoundedSemaphore(limit))


def is_slow_read(exc: Exception) -> bool:
    """อ่านเนื้อหาไม่ทันเวลา: เกินเพดานรวมของ read_limited หรือรอข้อมูลก้อนถัดไปเกิน timeout (urllib3 ไม่ห่อเป็น requests)"""
    return isinstance(exc, (requests.Timeout, urllib3.exceptions.ReadTimeoutError))


def is_outage(exc: Exception) -> bool:
    """error ที่แปลว่า "เว็บล่ม" จริง ๆ (ไม่ใช่แค่หน้านี้ไม่มี เช่น 404)"""
    if isinstance(exc, (requests.ConnectionError, requests.Timeout)):
        return True
    resp = getattr(exc, "response", None)
    return resp is not None and resp.status_code >= 500


# เพดานต่อหน้า: timeout ของ requests นับแค่ช่วงรอระหว่างข้อมูลแต่ละก้อน เว็บที่หยดข้อมูลมาทีละนิดจะยึด thread
# ไว้ได้ไม่จำกัด — วัดจริง (ต.ค. 2026) หน้าเรื่อง/หน้าตอนของทุกเว็บที่ใช้ ใหญ่สุด 342 KB ใช้เวลาไม่เกิน 1.2 วิ
MAX_PAGE_BYTES = 10 * 1024 * 1024


class PageTooLarge(requests.RequestException):
    pass


def read_limited(resp: requests.Response, max_seconds: float, max_bytes: int = MAX_PAGE_BYTES) -> bytes:
    """อ่านเนื้อหา (stream=True) พร้อมเพดานเวลารวม/ขนาด — เกินเวลา = Timeout (นับเป็นเว็บล่ม ไปลองแหล่งสำรองต่อ)"""
    deadline = time.monotonic() + max_seconds
    chunks, size = [], 0
    # read1 คืนข้อมูลเท่าที่มาถึงทันที — iter_content รอจนเต็มก้อนก่อน เว็บที่หยดทีละไม่กี่ไบต์จึงไม่เคยถึงจุดเช็คเวลา
    # (urllib3 รุ่นเก่าไม่มี read1 → ใช้ก้อนเล็ก 1 KB แทน ยังเช็คเวลาได้บ่อยพอ)
    if hasattr(resp.raw, "read1"):
        pieces = iter(lambda: resp.raw.read1(64 * 1024, decode_content=True), b"")
    else:
        pieces = resp.iter_content(chunk_size=1024)
    try:
        for chunk in pieces:
            chunks.append(chunk)
            size += len(chunk)
            if size > max_bytes:
                raise PageTooLarge(f"ข้อมูลใหญ่เกิน {max_bytes // (1024 * 1024)} MB: {resp.url}")
            if time.monotonic() > deadline:
                raise requests.Timeout(f"ส่งข้อมูลช้าเกิน {max_seconds:.0f} วิ: {resp.url}")
    finally:
        resp.close()
    return b"".join(chunks)


def _read_body(resp: requests.Response, max_seconds: float) -> str:
    # เว็บกลุ่มนี้ไม่ระบุ charset ใน Content-Type ทำให้ requests เดาเป็น ISO-8859-1
    # (ค่า default ตาม RFC 2616) แล้วข้อความไทยจะเพี้ยน ต้องบังคับเป็น utf-8 เสมอ
    return read_limited(resp, max_seconds).decode("utf-8", errors="replace")


def fetch(url: str, referer: str | None = None, min_interval: float = 0.0, timeout: float = TIMEOUT) -> str:
    headers = {**HEADERS, **cf_headers(url)}
    if referer:
        headers["Referer"] = referer
    check_public(url)
    if min_interval:
        throttle(url, min_interval)
    try:
        # เชื่อมต่อไม่ได้ใน 5 วิ = เว็บล่ม ไม่ต้องรอครบ timeout เต็ม (ค่านั้นเผื่อไว้สำหรับรอข้อมูล)
        resp = session().get(url, headers=headers, timeout=(min(5, timeout), timeout), stream=True)
        resp.raise_for_status()
        text = _read_body(resp, max_seconds=max(15, timeout * 2))
    except requests.RequestException as e:
        if is_cf_challenge(e.response):
            request_cf_solve(url)
        if e.response is not None:
            e.response.close()  # stream=True: ตอบ 4xx/5xx แล้วต้องคืน connection เอง
        if is_outage(e):
            _mark_host(url, down=True)
        raise
    _mark_host(url, down=False)
    return text


def _extract_balanced_json(text: str, marker: str) -> dict | None:
    """หา JSON object ที่ตามหลัง marker (เช่น 'ts_reader.run(') โดยนับวงเล็บปีกกาให้สมดุล"""
    idx = text.find(marker)
    if idx == -1:
        return None
    start = text.find("{", idx)
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
        else:
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    chunk = text[start : i + 1]
                    try:
                        return json.loads(chunk)
                    except json.JSONDecodeError:
                        return None
    return None


_TH_MONTHS = {
    "มกราคม": 1, "กุมภาพันธ์": 2, "มีนาคม": 3, "เมษายน": 4, "พฤษภาคม": 5, "มิถุนายน": 6,
    "กรกฎาคม": 7, "สิงหาคม": 8, "กันยายน": 9, "ตุลาคม": 10, "พฤศจิกายน": 11, "ธันวาคม": 12,
}
_EN_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
}


def parse_release_date(text: str | None) -> str | None:
    """แปลงวันที่แบบที่เว็บแสดง (เช่น "กันยายน 8, 2026" หรือ "September 3, 2026") เป็น
    ISO (YYYY-MM-DD) ไว้เทียบ/เรียงลำดับตามความจริงได้ ไม่ใช่แค่เวลาที่ระบบเรามาเช็คเจอ"""
    if not text:
        return None
    match = re.match(r"([ก-๙A-Za-z.]+)\s+(\d{1,2}),?\s+(\d{4})", text.strip())
    if match:
        month_name, day, year = match.groups()
    else:
        # วันขึ้นก่อน แบบไทยทั่วไป "11 ตุลาคม 2026" (oremanga.net)
        match = re.match(r"(\d{1,2})\s+([ก-๙A-Za-z.]+)\s+(\d{4})", text.strip())
        if not match:
            return None
        day, month_name, year = match.groups()
    # รองรับชื่อเดือนภาษาอังกฤษแบบย่อด้วย (เช่น niceoppai.net ใช้ "Sep 09, 2026")
    en = month_name.lower().rstrip(".")
    month = _TH_MONTHS.get(month_name) or _EN_MONTHS.get(en) or next(
        (n for full, n in _EN_MONTHS.items() if len(en) >= 3 and full.startswith(en)), None
    )
    if not month:
        return None
    return f"{int(year):04d}-{month:02d}-{int(day):02d}"


_NUM_RE = re.compile(r"(\d+(?:\.\d+)?)")


@functools.lru_cache(maxsize=16384)
def chapter_number(text: str) -> float | None:
    match = _NUM_RE.search(text)
    return float(match.group(1)) if match else None


def parse_chapter_list(soup: BeautifulSoup) -> list[dict]:
    """ดึงรายชื่อตอนทั้งหมดจาก #chapterlist แล้วบังคับให้เรียงใหม่ -> เก่าเสมอ (ทั้งแอปนี้คาดหวัง
    ลำดับนี้ เช่น ใช้ chapters[0] เป็นตอนล่าสุด) ส่วนใหญ่เว็บกลุ่มนี้แสดงมาเป็นใหม่ -> เก่าอยู่แล้ว
    แต่บางเว็บ (เช่น flash-manga.net) ดันแสดงเก่า -> ใหม่ เลยต้องเช็คทิศทางจากเลขตอนจริงก่อน"""
    chapters = []
    for li in soup.select("#chapterlist li"):
        anchor = li.select_one(".eph-num a") or li.find("a")
        if not anchor or not anchor.get("href"):
            continue
        num_span = anchor.select_one(".chapternum")
        text = num_span.get_text(strip=True) if num_span else anchor.get_text(strip=True)
        date_span = anchor.select_one(".chapterdate")
        date = date_span.get_text(strip=True) if date_span else None
        chapters.append({"text": text, "url": anchor["href"], "date": date})

    nums = [n for n in (chapter_number(c["text"]) for c in chapters) if n is not None]
    if len(nums) >= 2 and nums[0] < nums[-1]:
        chapters.reverse()

    return chapters


MAX_CHAPTER_LIST_PAGES = 50  # กันวนดึงไม่จบถ้าเว็บทำลิงก์หน้าเพี้ยน (เรื่องยาวสุดที่เจอ ~70 ตอน/หน้า)


def _parse_chrow_rows(soup: BeautifulSoup) -> list[dict]:
    """แถวรายชื่อตอนแบบธีมของ niceoppai.net (<a class="chrow" data-ch="287">) — ใช้เลขตอนจาก
    data-ch เป็นหลัก ข้อความในแถวบางทีเป็นแค่เลขเปล่า ๆ เลยเติม "ตอนที่" ให้ตรงกับเว็บอื่นในแอป"""
    chapters = []
    for a in soup.select("a.chrow[href]"):
        title_el = a.select_one(".chrow__t")
        if title_el:
            # ตอนที่เพิ่งลงมีป้าย <span class="chip">ใหม่</span> ต่อท้าย ถ้าไม่ตัดทิ้งชื่อตอนจะกลายเป็น "289ใหม่"
            for chip in title_el.select(".chip"):
                chip.decompose()
        raw = (title_el.get_text(strip=True) if title_el else "") or (a.get("data-ch") or "")
        text = f"ตอนที่ {raw}" if re.fullmatch(r"\d+(?:\.\d+)?", raw) else raw
        date_el = a.select_one(".chrow__d")
        chapters.append({"text": text, "url": a["href"], "date": date_el.get_text(strip=True) if date_el else None})
    return chapters


def fetch_chrow_chapters(soup: BeautifulSoup, min_interval: float = 0.0) -> list[dict]:
    """niceoppai.net แบ่งรายชื่อตอนเป็นหลายหน้า (.../chapter-list/2/, /3/, ...) หน้าเรื่องมีแค่หน้าแรก
    ต้องไล่ดึงหน้าที่เหลือต่อเองถึงจะได้ครบทุกตอน หน้าไหนดึงพลาดก็ข้ามไป ได้เท่าที่ได้"""
    chapters = _parse_chrow_rows(soup)
    if not chapters:
        return []

    pages = {}
    for a in soup.find_all("a", href=True):
        match = re.search(r"/chapter-list/(\d+)/?$", a["href"])
        if match:
            pages[int(match.group(1))] = a["href"]
    for n in sorted(p for p in pages if 1 < p <= MAX_CHAPTER_LIST_PAGES):
        try:
            page_html = fetch(pages[n], min_interval=min_interval)
        except requests.RequestException:
            continue
        chapters.extend(_parse_chrow_rows(BeautifulSoup(page_html, "html.parser")))

    seen = set()
    unique = [c for c in chapters if not (c["url"] in seen or seen.add(c["url"]))]
    unique.sort(key=lambda c: chapter_number(c["text"]) or -1, reverse=True)
    return unique


def _parse_sh_ep_rows(soup: BeautifulSoup, base_url: str | None) -> list[dict]:
    """รายชื่อตอนแบบ bully-manga.com (<a class="sh-ep" href="/เรื่อง-ep0026"><h3>ตอนที่ 26</h3>)
    ลิงก์เป็น path relative ต้องต่อโดเมนเอง และหน้าเรื่องเรียงเก่า -> ใหม่ เลยเรียงใหม่ตามเลขตอน"""
    chapters = []
    for a in soup.select("a.sh-ep[href]"):
        label = a.select_one(".sh-ep-label")
        raw = (label.get_text(strip=True) if label else "") or (a.get("data-title") or "")
        text = f"ตอนที่ {raw}" if re.fullmatch(r"\d+(?:\.\d+)?", raw) else raw
        date_el = a.select_one(".sh-ep-date")
        href = urljoin(base_url, a["href"]) if base_url else a["href"]
        chapters.append({"text": text, "url": href, "date": date_el.get_text(strip=True) if date_el else None})
    seen = set()
    unique = [c for c in chapters if not (c["url"] in seen or seen.add(c["url"]))]
    unique.sort(key=lambda c: chapter_number(c["text"]) or -1, reverse=True)
    return unique


def fetch_madara_chapters(manga_url: str, min_interval: float = 0.0) -> list[dict]:
    """เว็บกลุ่ม Madara ไม่ได้ฝังรายชื่อตอนมาในหน้าเรื่อง (มีแค่ไอคอนหมุน ๆ รอ AJAX) ต้องยิง
    ขอลิสต์เต็มแยกอีกทีที่ {manga_url}/ajax/chapters/ — และต้องเป็น POST เท่านั้น
    ถ้ายิง GET เว็บจะคืนหน้าเพจปกติมาแทน ไม่ใช่รายชื่อตอน"""
    endpoint = manga_url.rstrip("/") + "/ajax/chapters/"
    if not is_public_url(endpoint):
        return []
    headers = {**HEADERS, **cf_headers(manga_url)}
    headers["X-Requested-With"] = "XMLHttpRequest"
    if min_interval:
        throttle(endpoint, min_interval)
    try:
        resp = session().post(endpoint, headers=headers, timeout=(5, TIMEOUT), stream=True)
        resp.raise_for_status()
        text = _read_body(resp, max_seconds=TIMEOUT * 2)
    except requests.RequestException:
        return []

    chapters = []
    for li in BeautifulSoup(text, "html.parser").select("li.wp-manga-chapter"):
        anchor = li.find("a", href=True)
        if not anchor:
            continue
        date_el = li.select_one(".chapter-release-date")
        date = date_el.get_text(strip=True) if date_el else None
        chapters.append({"text": anchor.get_text(strip=True), "url": anchor["href"], "date": date or None})

    # กันเผื่อเว็บ Madara เจ้าอื่นเรียงกลับด้าน เหมือนที่เจอในเว็บกลุ่ม mangareader-family
    nums = [n for n in (chapter_number(c["text"]) for c in chapters) if n is not None]
    if len(nums) >= 2 and nums[0] < nums[-1]:
        chapters.reverse()

    return chapters


def _parse_madara_latest(soup: BeautifulSoup) -> tuple[str | None, str | None]:
    """เว็บกลุ่ม Madara (ธีม WordPress ยอดนิยมอีกกลุ่ม ต่างจาก mangareader-family) ไม่มี
    span.epcurlast — ใช้ปุ่ม "Read Last" บนหน้าเรื่องแทน (ข้อความอาจสลับกับปุ่ม Read First
    ในบางเว็บที่ตั้งค่าธีมผิด เลยต้องเช็คจากข้อความ ไม่ใช้ id ของปุ่ม)"""
    for a in soup.find_all("a", href=True):
        if "read last" in a.get_text(strip=True).lower():
            href = a["href"]
            # บางเว็บ (เช่น manga-lc.net) ปุ่มนี้เป็นแค่ "#" รอ JS เติมทีหลัง ไม่ใช่ลิงก์ตอนจริง
            if not href.startswith("http"):
                continue
            num_match = re.search(r"(\d+)/?$", href.rstrip("/"))
            text = f"ตอนที่ {num_match.group(1)}" if num_match else a.get_text(strip=True)
            return text, href
    return None, None


def _parse_series_chapterlist(soup: BeautifulSoup) -> list[dict]:
    """รายชื่อตอนแบบ oremanga.net: ul.series-chapterlist li a > span "ตอนที่ 1195" + span.date ซ้อนอยู่ข้างใน"""
    chapters = []
    for a in soup.select("ul.series-chapterlist li a[href]"):
        date_el = a.select_one(".date")
        date = date_el.get_text(strip=True) if date_el else None
        if date_el:
            date_el.extract()
        text = a.get_text(strip=True) or a.get("title") or ""
        chapters.append({"text": text, "url": a["href"], "date": date})
    nums = [n for n in (chapter_number(c["text"]) for c in chapters) if n is not None]
    if len(nums) >= 2 and nums[0] < nums[-1]:
        chapters.reverse()
    return chapters


def parse_manga_title(html: str) -> str:
    """ชื่อเรื่องจากหน้ารายละเอียด (ใช้ดูตัวอย่างก่อนเพิ่ม) — h1 ของธีม ก่อน og:title (มักมีชื่อเว็บต่อท้าย)"""
    soup = BeautifulSoup(html, "html.parser")
    for sel in ("h1.entry-title", ".post-title h1", ".seriestuheader h1", "h1"):
        node = soup.select_one(sel)
        if node and node.get_text(strip=True):
            return node.get_text(" ", strip=True)[:120]
    og = soup.find("meta", attrs={"property": "og:title"})
    title = (og.get("content") if og else "") or (soup.title.get_text() if soup.title else "")
    return re.split(r"\s[–\-|]\s", title.strip())[0][:120]


def _norm_title(text: str) -> str:
    return re.sub(r"[^0-9a-z฀-๿]+", "", (text or "").lower())


SEARCH_TIMEOUT = 8


def search_site(host: str, query: str) -> list[dict]:
    """ค้นชื่อเรื่องในเว็บมังงะหนึ่งเว็บ คืน [{title, url}] — รองรับธีม MangaStream (.bsx), Madara (post-title),
    oremanga (a[title] ใต้ /series/), niceoppai (/manga_list/search/) ตามที่ทดสอบ 24 ต.ค."""
    from urllib.parse import quote
    base = f"https://{host}"
    if "niceoppai" in host:
        pages = [f"{base}/manga_list/search/{quote(query)}/"]
    else:
        pages = [f"{base}/?s={quote(query)}", f"{base}/?s={quote(query)}&post_type=wp-manga"]
    found: list[dict] = []
    for page in pages:
        try:
            html = fetch(page, timeout=SEARCH_TIMEOUT)
        except Exception:
            continue
        soup = BeautifulSoup(html, "html.parser")
        anchors = soup.select(".bsx a, .c-tabs-item__content .post-title a, .row.c-tabs-item .post-title a, .fcard__body a, a[title][href*='/series/']")
        for a in anchors:
            href = urljoin(page, a.get("href") or "")
            title = (a.get("title") or a.get_text(" ", strip=True)).strip()
            path = [p for p in urlparse(href).path.split("/") if p]
            # ลิงก์ตอน (/เรื่อง/12/, ...-chapter-12) ไม่ใช่หน้าเรื่อง
            if not title or not path or len(path) > 2 or re.search(r"(chapter|ตอนที่|/\d+/?$)", href, re.I) or urlparse(href).netloc != urlparse(page).netloc:
                continue
            if href not in {f["url"] for f in found}:
                found.append({"title": title[:120], "url": href})
        if found:
            break
    return found


def title_match_score(name: str, title: str) -> int:
    """0 = ไม่ใช่, 2 = ชื่อตรง (ไม่นับคำไทย/วงเล็บท้าย), 1 = มีชื่อเราอยู่ในชื่อเว็บนั้น"""
    a = _norm_title(re.sub(r"\(.*?\)", "", name))
    b_full = _norm_title(title)
    b_latin = _norm_title(re.sub(r"[฀-๿]+", " ", re.sub(r"\(.*?\)", "", title)))
    if not a:
        return 0
    if a == b_latin or a == b_full:
        # "Overgeared (Remake)" กับเรื่องเรา "Overgeared" = อาจคนละภาค → คะแนนรอง (ผู้ดูแลดูเลขตอนเทียบเอง)
        extra = re.findall(r"\((.*?)\)", title)
        return 1 if extra and not all(_norm_title(x) in _norm_title(name) for x in extra) else 2
    return 1 if a in b_full else 0


def parse_index_page(html: str, url: str | None = None, min_interval: float = 0.0) -> dict:
    """ดึงตอนล่าสุด + ลิงก์ + รูปปก + รายชื่อตอนทั้งหมด จากหน้ารายละเอียดเรื่อง
    (url ใช้เฉพาะตอนเจอเว็บกลุ่ม Madara ที่ต้องยิงขอรายชื่อตอนเพิ่มอีก request)"""
    soup = BeautifulSoup(html, "html.parser")
    result = {
        "latest_chapter": None,
        "latest_chapter_url": None,
        "cover_url": None,
        "chapters": [],
    }

    span = soup.select_one("span.epcurlast")
    if span:
        text = span.get_text(strip=True)
        match = re.search(r"ตอนที่\s*\S+", text)
        result["latest_chapter"] = match.group(0) if match else text
        anchor = span.find_parent("a")
        if anchor and anchor.get("href"):
            href = anchor["href"]
            if not href.startswith("#"):
                result["latest_chapter_url"] = href

    og_image = soup.select_one('meta[property="og:image"]')
    if og_image and og_image.get("content"):
        result["cover_url"] = og_image["content"]
    else:
        for sel in COVER_FALLBACK_SELECTORS:
            img = soup.select_one(sel)
            if img and img.get("src"):
                result["cover_url"] = img["src"]
                break

    result["chapters"] = parse_chapter_list(soup)

    # ไม่เจอ #chapterlist แบบ mangareader-family ลองแบบ niceoppai.net (a.chrow แบ่งหลายหน้า)
    if not result["chapters"]:
        result["chapters"] = fetch_chrow_chapters(soup, min_interval)

    # bully-manga.com (a.sh-ep ลิงก์ relative ฝังครบทุกตอนในหน้าเรื่อง)
    if not result["chapters"]:
        result["chapters"] = _parse_sh_ep_rows(soup, url)

    # oremanga.net (ul.series-chapterlist ครบทุกตอนในหน้าเรื่อง)
    if not result["chapters"]:
        result["chapters"] = _parse_series_chapterlist(soup)

    # ยังไม่เจออีก ลองแบบ Madara แทน (ต้องยิงขอรายชื่อตอนเพิ่มอีก request เพราะหน้าเรื่องไม่ได้ฝังลิสต์มาให้)
    if not result["chapters"] and url:
        result["chapters"] = fetch_madara_chapters(url, min_interval)

    if not result["latest_chapter_url"]:
        text, chapter_url = _parse_madara_latest(soup)
        if chapter_url:
            result["latest_chapter"] = text
            result["latest_chapter_url"] = chapter_url
        elif result["chapters"]:
            result["latest_chapter"] = result["chapters"][0]["text"]
            result["latest_chapter_url"] = result["chapters"][0]["url"]

    # วันที่ตอนล่าสุดจริง ๆ ตามเว็บต้นทาง (เอาไว้เรียง "วันอัพเดตล่าสุด" ในหน้าเรื่องทั้งหมด)
    # ตอนล่าสุดบางเว็บไม่มีวันที่กำกับ (เพิ่งลงวันนี้ยังไม่ทันขึ้น) เลยไล่หาตัวแรกที่มีวันที่จริง
    result["latest_chapter_date"] = next(
        (d for c in result["chapters"] if (d := parse_release_date(c.get("date")))), None
    )

    return result


_LAZY_SRC_ATTRS = ("data-src", "data-lazy-src", "data-original", "src")


def _real_img_src(img) -> str | None:
    """ลิงก์รูปจริงของ <img> — เว็บที่ใช้ lazy-load (เช่น manga-lc.net) ใส่ src เป็นภาพหลอก 1x1 แบบ
    data:image/gif แล้วเก็บรูปจริงไว้ใน data-src รอ JS สลับให้ทีหลัง ถ้าอ่านแค่ src จะได้ภาพว่างทุกหน้า"""
    for attr in _LAZY_SRC_ATTRS:
        value = (img.get(attr) or "").strip()
        if value and not value.startswith("data:"):
            return value
    return None


# ---------- รูปหั่นสลับชิ้น (สดใสเมะ) ----------
# บางหน้าไม่ได้เป็น <img> แต่เป็น <div class="displayImage" ori-width ori-height> + สคริปต์ packer (eval(function(p,a,c,k,e,d)))
# ที่ใส่รูปซึ่งหั่นเป็นชิ้นสลับตำแหน่งไว้ แล้วต่อกลับด้วย background-position ในเบราว์เซอร์ — เดิมเราข้ามไปทั้งหน้า
# (ตอน 160: เห็น 46 จาก 60 หน้า) ตอนนี้ถอดสคริปต์เอาลิงก์รูป + ตำแหน่งชิ้น แล้วให้พร็อกซีรูปต่อชิ้นกลับ
# รูปแบบลิงก์: <url รูปต้นฉบับ>#mee-tiles=<กว้าง>x<สูง>;<ชิ้นกว้าง>x<ชิ้นสูง>;<ซ้าย>,<บน>,<srcX>,<srcY>|...
TILES_MARK = "#mee-tiles="
_PACKER_RE = re.compile(r"\}\('(.*)',(\d+),(\d+),'(.*?)'\.split\('\|'\)", re.S)


def _unpack_packer(script: str) -> str | None:
    """ถอด Dean Edwards packer (eval(function(p,a,c,k,e,d){...}('...',a,c,'w1|w2'.split('|'))) แบบไม่รัน JS"""
    m = _PACKER_RE.search(script)
    if not m:
        return None
    payload, radix, count, words = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4).split("|")
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"

    def encode(n: int) -> str:
        out = ""
        while True:
            r = n % radix
            out = (chr(r + 29) if r > 35 else digits[r]) + out
            n //= radix
            if n == 0:
                return out

    table = {encode(i): (words[i] if i < len(words) and words[i] else encode(i)) for i in range(count)}
    return re.sub(r"\b\w+\b", lambda w: table.get(w.group(0), w.group(0)), payload)


def _scrambled_image(div) -> str | None:
    script = div.find_next("script")
    code = _unpack_packer(script.string or script.get_text()) if script else None
    if not code:
        return None
    src = re.search(r"url\((https?://[^)\s'\"]+)\)", code) or re.search(r"src=\\?'(https?://[^'\\]+)", code)
    size = re.search(r"width:(\d+)px;\s*height:(\d+)px", code)
    tiles = re.findall(r'\["(\d+)(?:\.\d+)?","(\d+)(?:\.\d+)?","(\d+)(?:\.\d+)?","(\d+)(?:\.\d+)?"\]', code)
    try:
        width, height = int(div.get("ori-width")), int(div.get("ori-height"))
    except (TypeError, ValueError):
        return None
    if not (src and size and tiles):
        return None
    # ใน sovleImage: [ซ้าย, บน, srcX, srcY] (สคริปต์ใช้ top = ตัวที่ 2, left = ตัวที่ 1)
    parts = "|".join(",".join(t) for t in tiles)
    return f"{src.group(1)}{TILES_MARK}{width}x{height};{size.group(1)}x{size.group(2)};{parts}"


_IMAGE_MAP_RE = re.compile(r"\bIMAGE_MAP\s*=\s*\[(.*?)\]", re.S)


def parse_chapter_page(html: str, url: str | None = None) -> dict:
    """ดึงรายการรูปหน้ามังงะ + ลิงก์ตอนก่อนหน้า/ถัดไป จากหน้าอ่านตอน
    (url ใช้ต่อโดเมนให้ลิงก์รูปแบบ relative เช่น bully-manga.com)"""
    data = _extract_balanced_json(html, "ts_reader.run(")
    result = {"images": [], "prev_url": None, "next_url": None, "chapter_text": None}
    soup = BeautifulSoup(html, "html.parser")

    if data:
        sources = data.get("sources") or []
        if sources:
            result["images"] = sources[0].get("images") or []
        result["prev_url"] = data.get("prevUrl") or None
        result["next_url"] = data.get("nextUrl") or None
    else:
        # ไม่เจอ ts_reader (ไม่ใช่ mangareader-family) ลองแบบ Madara แทน: รูปอยู่ใน
        # .reading-content เป็น <img src="..."> ตรง ๆ ไม่ก็แบบธีมที่ใช้ #readerarea แทน (เจอใน
        # สดใสเมะ.com บางเรื่อง — เว็บเดียวกันแต่บางเรื่องยังใช้เทมเพลตเก่าที่ไม่มี ts_reader)
        # ทั้งสองแบบไม่มี prev/next link ที่ใช้ได้จริงในหน้านี้ (เป็น # เปล่า ๆ รอ JS เติมทีหลัง)
        # เลยปล่อยเป็น None — ฝั่ง app.py จะ derive จากลำดับในรายชื่อตอนแทนอยู่แล้ว
        # #image-container = niceoppai.net (หน้านี้มีแบนเนอร์โฆษณาเป็น <img> ปนอยู่เยอะ ต้องเจาะจงเฉพาะ
        # กล่องนี้ ซึ่งมีแต่รูปหน้ามังงะล้วน ๆ ห้ามกวาดรูปทั้งหน้า)
        reading = (
            soup.select_one(".reading-content")
            or soup.select_one("#readerarea")
            or soup.select_one("#image-container")
            or soup.select_one(".reader-area-main")  # oremanga.net (แบนเนอร์โฆษณาอยู่นอกกล่องนี้)
        )
        if reading:
            # รูป <img> กับรูปหั่นชิ้น (div.displayImage) ปนกันตามลำดับหน้า — ไล่ตามลำดับในเอกสาร
            for node in reading.select("img.wp-manga-chapter-img, img, div.displayImage"):
                src = _scrambled_image(node) if node.name == "div" else _real_img_src(node)
                if src:
                    result["images"].append(src)

        # bully-manga.com: <img> ในหน้าเป็นไอคอนหลอกทั้งหมด รูปจริงอยู่ใน JS `const IMAGE_MAP = [...]`
        # เป็น path relative (/img/backcat/...) ต้องต่อโดเมนจากลิงก์ตอนเอง
        if not result["images"]:
            match = _IMAGE_MAP_RE.search(html)
            if match:
                for src in re.findall(r"[\"']([^\"']+)[\"']", match.group(1)):
                    result["images"].append(urljoin(url, src) if url else src)

    # บางเว็บ h1 บนหน้าตอนเป็นหัวข้อทั่วไปของทั้งเว็บ (ไม่ใช่ชื่อตอน) เช่น "อ่านมังงะอ่านการ์ตูน
    # ออนไลน์แปลไทย 2026" — ลองทุก tag ที่มักมีเลขตอนกำกับ ใช้ตัวแรกที่แมตช์ได้จริง ๆ ไม่ใช่
    # ตัวแรกที่มี tag อยู่ (ไม่งั้นถ้า h1 ทั่วไปแบบนี้เจอก่อน จะไม่ลอง title เลย)
    texts = [t.get_text() for t in (soup.select_one("h1"), soup.select_one("title")) if t]

    for text in texts:
        match = re.search(r"ตอนที่\s*\S+", text)
        if match:
            result["chapter_text"] = match.group(0)
            break
    else:
        # บางเว็บ (เช่น slow-manga.net) ไม่มีคำว่า "ตอนที่" เลย มีแค่เลขตอนต่อท้ายชื่อเรื่องตรง ๆ
        # (เช่น "What a Bountiful Harvest, Demon Lord! 77") เช็คทีหลังสุด กันไปแมตช์เลขอื่นที่ไม่ใช่
        # เลขตอนจริง (เช่นปี ค.ศ. ใน h1 ทั่วไปของเว็บ) ในเว็บที่จริง ๆ มีคำว่า "ตอนที่" อยู่แล้ว
        for text in texts:
            match = re.search(r"(\d+(?:\.\d+)?)\s*$", text.strip())
            if match:
                result["chapter_text"] = f"ตอนที่ {match.group(1)}"
                break

    return result
