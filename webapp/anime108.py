"""Anime108 (anime108.com) — เพิ่มตอนอนิเมะเข้าคลังวิดีโอ เล่นโดยฝังตัวเล่นของเว็บ (iframe)

ตรวจหน้าเว็บจริง (ต.ค. 2026, ธีม WordPress HaLim):
- หน้าเรื่อง (ภาค) /<slug>/ และหน้าตอน /<slug>-ep-<n>/ มีรายชื่อตอนทั้งภาคเหมือนกัน 2 ชุด ตามภาษา
  select#sequel_select_th = "Thai" (พากย์ไทย), select#sequel_select_en = "Sound Track" (เสียงญี่ปุ่นซับไทย)
  จำนวนตอนสองภาษาไม่เท่ากันได้ (Mushoku Tensei 3: พากย์ 11 / ซับ 14) ภาษาที่ไม่มีเลย = select ว่าง
- select[name=Sequel_select2] = ภาคอื่นของเรื่อง (ตัวเลือกแรก = ภาคของหน้านี้) — ปนมูฟวี่/OVA ไม่ดึงเอง
- og:title / og:image (wp-content/uploads) — ชื่อมีป้าย "พากย์ไทย ซับไทย", หน้าตอนมี "EP n"
- ตัวเล่น: POST /api/get.php (action=halim_ajax_player, nonce ว่างได้, episode, server=1, postid, lang) ตอบ
  <iframe src="https://main.108player.com/index_th.php?id=..."> — postid ของหน้าตอนใน data-post-id, เลขตอนใน halim_cfg.episode
  ตัวเล่นเช็ค Referer: ส่งชื่อเว็บอื่น = หน้าว่าง 17 ไบต์, ไม่ส่ง = ได้ตัวเล่น → แอปฝังแบบ referrerpolicy=no-referrer
  ไฟล์จริงเป็น HLS ที่ท่อนวิดีโอปลอมเป็น .webp (มีหัวไฟล์รูปนำหน้า) — <video>/iPhone เล่นตรงไม่ได้ จึงฝังตัวเล่นเขา
ตอนเดียวกันสองภาษาใช้หน้าเดียวกัน → แยกด้วย fragment ของลิงก์ (#dub / #sub) เป็นคนละตอนในคลัง
"""
import re
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

import scraper
import streams

LABEL = "Anime108"
HOST = "www.anime108.com"
HOSTS = {"anime108.com", "www.anime108.com"}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
TIMEOUT = (5, 15)
MAX_PAGE_BYTES = 3 * 1024 * 1024
PLAYER_HOSTS = {"main.108player.com"}
_SLUG = r"[a-z0-9][a-z0-9-]{0,150}"
LANGS = {"dub": ("sequel_select_th", "Thai"), "sub": ("sequel_select_en", "Sound Track")}
LANG_TAG = {"dub": "[พากย์ไทย]", "sub": "[ซับไทย]"}
_RESERVED = {"wp-json", "wp-content", "wp-admin", "wp-includes", "feed", "page", "category", "tag", "author",
             "search", "api", "comments", "sitemap", "sitemap_index"}


def parse_url(url: str) -> tuple[str, str, str | None] | None:
    """("episode", "<slug>-ep-<n>", ภาษา) / ("series", slug, ภาษา) / None — ภาษาจาก #dub / #sub (ไม่มี = None)
    รับเฉพาะ http(s)://(www.)anime108.com ไม่มี user:pass ไม่ระบุพอร์ต — query ทิ้ง"""
    try:
        parts = urlsplit((url or "").strip())
        port = parts.port
    except ValueError:
        return None
    if (parts.scheme not in ("http", "https") or (parts.hostname or "").lower() not in HOSTS
            or port is not None or parts.username is not None or parts.password is not None):
        return None
    lang = parts.fragment if parts.fragment in LANGS else None
    match = re.fullmatch(rf"/({_SLUG}-ep-\d+(?:-\d+)?)/?", parts.path)
    if match:
        return "episode", match.group(1), lang
    match = re.fullmatch(rf"/({_SLUG})/?", parts.path)
    return ("series", match.group(1), lang) if match and match.group(1) not in _RESERVED else None


def _with_lang(url: str, lang: str | None) -> str:
    return f"{url}#{lang}" if lang else url


def episode_url(slug: str, lang: str | None = None) -> str:
    return _with_lang(f"https://{HOST}/{slug}/", lang)


def series_url(slug: str, lang: str | None = None) -> str:
    return _with_lang(f"https://{HOST}/{slug}/", lang)


def canonical_episode_url(url: str) -> str | None:
    parsed = parse_url(url)
    return episode_url(parsed[1], parsed[2]) if parsed and parsed[0] == "episode" else None


def canonical_series_url(url: str) -> str | None:
    parsed = parse_url(url)
    return series_url(parsed[1], parsed[2]) if parsed and parsed[0] == "series" else None


def is_image_url(url: str) -> bool:
    """ปกที่ยอมให้เซิร์ฟเวอร์ดาวน์โหลด: https://www.anime108.com/wp-content/uploads/... เท่านั้น"""
    try:
        parts = urlsplit(url or "")
        return (parts.scheme == "https" and (parts.hostname or "").lower() in HOSTS and parts.port is None
                and parts.username is None and parts.path.startswith("/wp-content/uploads/"))
    except ValueError:
        return False


def _request(method: str, url: str, **kw) -> requests.Response:
    """ยิงเฉพาะ URL ที่สร้างจาก parse_url (โฮสต์ anime108) ไม่ตาม redirect"""
    if scraper.host_is_down(url) or scraper.host_is_stalled(url):
        raise ValueError("Anime108 ไม่ตอบช่วงนี้ ลองใหม่อีกครั้ง")
    try:
        with scraper.awaiting_response(url):
            resp = scraper.session().request(method, url, headers={"User-Agent": UA, "Accept-Language": "th-TH,th;q=0.9"},
                                             timeout=TIMEOUT, allow_redirects=False, **kw)
    except requests.RequestException as e:
        if scraper.is_outage(e):
            scraper.mark_host_down(url)
        raise ValueError(f"เชื่อมต่อ Anime108 ไม่ได้: {e.__class__.__name__}") from None
    if resp.status_code == 404:
        raise ValueError("ไม่พบหน้านี้บน Anime108 (ลิงก์ผิดหรือถูกลบ)")
    if resp.status_code != 200:
        raise ValueError(f"Anime108 ตอบ HTTP {resp.status_code}")
    if len(resp.content) > MAX_PAGE_BYTES:
        raise ValueError("หน้า Anime108 ใหญ่ผิดปกติ")
    return resp


def _page(url: str) -> tuple[str, BeautifulSoup]:
    html = _request("GET", url.split("#")[0]).text
    return html, BeautifulSoup(html, "html.parser")


def _meta(soup: BeautifulSoup, prop: str) -> str:
    tag = soup.find("meta", property=prop)
    return (tag.get("content") or "").strip() if tag else ""


def series_name(title: str) -> str:
    """"Mushoku Tensei 3 เกิดชาตินี้พี่ต้องเทพ พากย์ไทย ซับไทย EP 9 พากย์ไทย ซับไทย" → "Mushoku Tensei 3 เกิดชาตินี้พี่ต้องเทพ" """
    name = re.split(r"\s+(?:EP\.?|ตอนที่|ตอน)\s*\d", title or "", maxsplit=1, flags=re.I)[0]
    while True:
        cut = re.sub(r"\s*(?:\|.*|%|ซับไทย|พากย์ไทย|พากษ์ไทย|เสียงไทย|anime108)\s*$", "", name, flags=re.I).strip()
        if cut == name:
            break
        name = cut
    return " ".join(name.split()) or title


def _episode_lists(soup: BeautifulSoup, base: str) -> dict[str, list[tuple[float, str]]]:
    """{"dub": [(เลขตอน, ลิงก์ตอนไม่มีภาษา)], "sub": [...]} จาก select ทั้งสองชุด"""
    out = {}
    for lang, (select_id, _) in LANGS.items():
        items, seen = [], set()
        for opt in soup.select(f"select#{select_id} option[value]"):
            url = canonical_episode_url(urljoin(base, opt["value"]).split("#")[0])
            num = re.search(r"(\d+(?:\.\d+)?)", opt.get_text(" ", strip=True))
            if url and num and url not in seen:
                seen.add(url)
                items.append((float(num.group(1)), url))
        out[lang] = items
    return out


def fetch_series(url: str) -> dict:
    """หน้าเรื่องหรือหน้าตอน (#dub/#sub เลือกภาษา; ไม่ระบุ = พากย์ถ้ามี ไม่งั้นซับ)
    → {"url" (หน้าเรื่อง+ภาษา), "title", "name", "image", "lang", "langs": {ภาษา: จำนวนตอน},
       "lang_urls": {ภาษา: url}, "parts": [{"url", "title"}], "items": [{"url", "title"}]}"""
    parsed = parse_url(url)
    if not parsed:
        raise ValueError("ไม่ใช่ลิงก์ของ Anime108 (anime108.com/<ชื่อเรื่อง>/ หรือ /<ชื่อเรื่อง>-ep-<n>/)")
    page = url.split("#")[0]
    _, soup = _page(page)
    lists = _episode_lists(soup, page)
    if not any(lists.values()):
        raise ValueError("ไม่พบรายชื่อตอนในหน้านี้ (ไม่ใช่หน้าเรื่อง/ตอนของ Anime108)")
    parts = []
    for opt in soup.select("select[name=Sequel_select2] option[value]"):
        part = canonical_series_url(urljoin(page, opt["value"]))
        if part and not any(p["url"] == part for p in parts):
            parts.append({"url": part, "title": " ".join(opt.get_text(" ", strip=True).split())})
    # หน้าเรื่องของภาคนี้ = ตัวเลือกแรกของ "เลือกภาคต่อ" (หน้าตอนไม่มีลิงก์อื่นที่แน่นอนกว่า)
    home = canonical_series_url(page) if parsed[0] == "series" else (parts[0]["url"] if parts else None)
    if not home:
        slug = re.sub(r"-ep-\d+(?:-\d+)?$", "", parsed[1])
        home = series_url(slug)
    lang = parsed[2] or ("dub" if lists["dub"] else "sub")
    title = _meta(soup, "og:title") or (soup.title.get_text(strip=True) if soup.title else "")
    name = series_name(title)
    image = urljoin(page, _meta(soup, "og:image"))
    items = [{"url": _with_lang(ep_url, lang), "title": f"{name} ตอนที่ {num:g} {LANG_TAG[lang]}"} for num, ep_url in lists[lang]]
    return {"url": _with_lang(home, lang), "title": f"{name} {LANG_TAG[lang]}", "name": name,
            "image": image if is_image_url(image) else "", "lang": lang,
            "langs": {k: len(v) for k, v in lists.items()}, "lang_urls": {k: _with_lang(home, k) for k in LANGS},
            "parts": parts, "items": items}


def fetch_episode(url: str) -> dict:
    """{"url" (มีภาษา), "title", "series_url", "image", "embeddable"}"""
    canonical = canonical_episode_url(url)
    if not canonical:
        raise ValueError("ไม่ใช่ลิงก์ตอนของ Anime108")
    info = fetch_series(canonical)
    num = re.search(r"-ep-(\d+)", canonical)
    return {"url": _with_lang(canonical.split("#")[0], info["lang"]),
            "title": f"{info['name']} ตอนที่ {num.group(1) if num else ''} {LANG_TAG[info['lang']]}".strip(),
            "series_url": info["url"], "image": info["image"], "embeddable": True}


def player_url(url: str) -> str:
    """ลิงก์ตัวเล่นของตอน (ภาษาตาม #dub/#sub) — อ่าน postid + เลขตอนจากหน้าตอน แล้วถาม /api/get.php"""
    parsed = parse_url(url)
    if not parsed or parsed[0] != "episode":
        raise ValueError("ลิงก์ตอนของ Anime108 ไม่ถูกต้อง")
    html, soup = _page(episode_url(parsed[1]))
    post = soup.select_one("[data-post-id]")
    ep = re.search(r"halim_cfg\.episode\s*=\s*(\d+)", html)
    if not post or not ep:
        raise ValueError("ไม่พบข้อมูลตัวเล่นในหน้าตอน (เว็บอาจเปลี่ยนหน้าตา)")
    lang = LANGS[parsed[2] or "dub"][1]
    resp = _request("POST", f"https://{HOST}/api/get.php", data={
        "action": "halim_ajax_player", "nonce": "", "episode": ep.group(1), "server": "1",
        "postid": post["data-post-id"], "lang": lang, "title": ""})
    frame = BeautifulSoup(resp.text.replace("\\", ""), "html.parser").select_one("iframe[src]")
    src = frame["src"] if frame else ""
    host = (urlsplit(src).hostname or "").lower() if src.startswith("https://") else ""
    if host not in PLAYER_HOSTS:
        raise ValueError("Anime108 ยังไม่มีตอนนี้ในภาษานี้ หรือเปลี่ยนตัวเล่น")
    return src


class Provider:
    """adapter ของ streams — ข้อมูลเรื่อง/ตอนจากฟังก์ชันข้างบน, เล่นด้วยการฝังตัวเล่นของเว็บ (ไม่ส่ง Referer)"""
    name = "anime108"

    @staticmethod
    def validate_series_url(url: str) -> str | None:
        return canonical_series_url(url)

    @staticmethod
    def get_series_metadata(url: str) -> dict:
        try:
            info = fetch_series(url)
        except ValueError as e:
            raise streams.StreamError(streams.SERIES_PARSE_FAILED, str(e)) from None
        return {k: info[k] for k in ("url", "name", "title", "image")}

    @staticmethod
    def get_episode_list(url: str) -> list[dict]:
        try:
            items = fetch_series(url)["items"]
        except ValueError as e:
            raise streams.StreamError(streams.EPISODE_LIST_FAILED, str(e)) from None
        if not items:
            raise streams.StreamError(streams.EPISODE_LIST_FAILED, "ภาษานี้ยังไม่มีตอน")
        return items

    @staticmethod
    def get_episode_metadata(url: str) -> dict:
        try:
            return fetch_episode(url)
        except ValueError as e:
            raise streams.StreamError(streams.PLAYER_INFO_MISSING, str(e)) from None

    @staticmethod
    def resolve_playback(video: dict, ctx: dict) -> dict:
        url = canonical_episode_url(video.get("source_url") or "")
        if not url:
            raise streams.StreamError(streams.PLAYER_INFO_MISSING, "ลิงก์ตอนของ Anime108 ไม่ถูกต้อง")
        try:
            src = player_url(url)
        except ValueError as e:
            raise streams.StreamError(streams.STREAM_RESOLUTION_FAILED, str(e), retryable=True) from None
        return {"kind": "embed", "url": src, "expires_at": None, "frame": None, "referrer": "none"}


streams.register(Provider())
