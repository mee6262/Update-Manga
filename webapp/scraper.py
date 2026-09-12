"""
Scraper สำหรับกลุ่มเว็บที่ใช้ธีมเดียวกับ slow-manga / go-manga / up-manga / tanuki-manga
ใช้ requests ธรรมดา (ไม่ต้องใช้ playwright) เพราะข้อมูลที่ต้องการ render มาใน HTML/JS อยู่แล้ว
"""
import json
import re
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

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


def domain_of(url: str) -> str:
    return urlparse(url).netloc


def fetch(url: str, referer: str | None = None) -> str:
    headers = dict(HEADERS)
    if referer:
        headers["Referer"] = referer
    resp = requests.get(url, headers=headers, timeout=TIMEOUT)
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


def parse_chapter_list(soup: BeautifulSoup) -> list[dict]:
    """ดึงรายชื่อตอนทั้งหมด (ใหม่ -> เก่า ตามลำดับที่เว็บแสดง) จาก #chapterlist"""
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


def parse_index_page(html: str) -> dict:
    """ดึงตอนล่าสุด + ลิงก์ + รูปปก + รายชื่อตอนทั้งหมด จากหน้ารายละเอียดเรื่อง"""
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

    # ไม่เจอตอนล่าสุดแบบ mangareader-family เลย ลองแบบ Madara แทน (เว็บกลุ่มนี้รายชื่อตอน
    # ทั้งหมดมักโหลดผ่าน AJAX แยกต่างหาก ซึ่งแต่ละเว็บ endpoint ไม่เหมือนกัน เลยดึงได้แค่
    # ตอนล่าสุดตอนเดียว ไม่ได้ลิสต์เต็ม — ตอนอื่นย้อนหลังต้องรอ implement เพิ่มทีหลัง)
    if not result["latest_chapter_url"]:
        text, url = _parse_madara_latest(soup)
        if url:
            result["latest_chapter"] = text
            result["latest_chapter_url"] = url

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
        # .reading-content เป็น <img src="..."> ตรง ๆ (ไม่มี prev/next link ให้ดึงบนหน้านี้
        # เลยปล่อยเป็น None — ปุ่มตอนก่อนหน้า/ถัดไปจะกดไม่ได้สำหรับเว็บกลุ่มนี้)
        reading = soup.select_one(".reading-content")
        if reading:
            for img in reading.select("img.wp-manga-chapter-img, img"):
                src = (img.get("src") or img.get("data-src") or "").strip()
                if src:
                    result["images"].append(src)

    title_tag = soup.select_one("h1") or soup.select_one("title")
    if title_tag:
        match = re.search(r"ตอนที่\s*\S+", title_tag.get_text())
        if match:
            result["chapter_text"] = match.group(0)

    return result
