"""
Scraper สำหรับกลุ่มเว็บที่ใช้ธีมเดียวกับ slow-manga / go-manga / up-manga / tanuki-manga
ใช้ requests ธรรมดา (ไม่ต้องใช้ playwright) เพราะข้อมูลที่ต้องการ render มาใน HTML/JS อยู่แล้ว
"""
import functools
import json
import re
import threading
import time
from urllib.parse import urlparse

import requests
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
    ".summary_image img",
    ".tab-summary img",
    ".thumb img",
    "img.wp-post-image",
]

TIMEOUT = 20


_local = threading.local()


def session() -> requests.Session:
    """Session ต่อ thread (requests.Session ไม่ thread-safe เต็มที่) ใช้ keep-alive ซ้ำกับเว็บ/CDN
    เดิม ไม่ต้องจับมือ TCP+TLS ใหม่ทุกรูป/ทุกหน้า"""
    s = getattr(_local, "session", None)
    if s is None:
        s = requests.Session()
        adapter = HTTPAdapter(pool_connections=16, pool_maxsize=16)
        s.mount("http://", adapter)
        s.mount("https://", adapter)
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


def fetch(url: str, referer: str | None = None, min_interval: float = 0.0) -> str:
    headers = dict(HEADERS)
    if referer:
        headers["Referer"] = referer
    if min_interval:
        throttle(url, min_interval)
    resp = session().get(url, headers=headers, timeout=TIMEOUT)
    resp.raise_for_status()
    # เว็บกลุ่มนี้ไม่ระบุ charset ใน Content-Type ทำให้ requests เดาเป็น ISO-8859-1
    # (ค่า default ตาม RFC 2616) แล้วข้อความไทยจะเพี้ยน ต้องบังคับเป็น utf-8 เสมอ
    resp.encoding = "utf-8"
    return resp.text


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
    if not match:
        return None
    month_name, day, year = match.groups()
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


def fetch_madara_chapters(manga_url: str, min_interval: float = 0.0) -> list[dict]:
    """เว็บกลุ่ม Madara ไม่ได้ฝังรายชื่อตอนมาในหน้าเรื่อง (มีแค่ไอคอนหมุน ๆ รอ AJAX) ต้องยิง
    ขอลิสต์เต็มแยกอีกทีที่ {manga_url}/ajax/chapters/ — และต้องเป็น POST เท่านั้น
    ถ้ายิง GET เว็บจะคืนหน้าเพจปกติมาแทน ไม่ใช่รายชื่อตอน"""
    endpoint = manga_url.rstrip("/") + "/ajax/chapters/"
    headers = dict(HEADERS)
    headers["X-Requested-With"] = "XMLHttpRequest"
    if min_interval:
        throttle(endpoint, min_interval)
    try:
        resp = session().post(endpoint, headers=headers, timeout=TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException:
        return []
    resp.encoding = "utf-8"

    chapters = []
    for li in BeautifulSoup(resp.text, "html.parser").select("li.wp-manga-chapter"):
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
            num_match = re.search(r"(\d+)/?$", href.rstrip("/"))
            text = f"ตอนที่ {num_match.group(1)}" if num_match else a.get_text(strip=True)
            return text, href
    return None, None


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


def parse_chapter_page(html: str) -> dict:
    """ดึงรายการรูปหน้ามังงะ + ลิงก์ตอนก่อนหน้า/ถัดไป จากหน้าอ่านตอน"""
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
        )
        if reading:
            for img in reading.select("img.wp-manga-chapter-img, img"):
                src = (img.get("src") or img.get("data-src") or "").strip()
                if src:
                    result["images"].append(src)

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
