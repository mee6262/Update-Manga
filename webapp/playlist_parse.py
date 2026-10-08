"""แยกชื่อเรื่อง + เลขตอน จากชื่อคลิป reel (ฟังก์ชันล้วน ไม่แตะไฟล์/เน็ต)

ชื่อคลิปของเพจแบบ "#จีนย้อนยุค เทพยุทธเสื้อทอง  Ep9", "กระบี่เทพสังหาร19 #จีนย้อนยุค",
"ขี่พายุดวลดาบสะท้านฟ้า19 ดวล", "THE4 โดนซองขาว" (ไม่มีเลขตอน เรียงตามวันโพสต์)
"""
import re

_STATS_PREFIX = re.compile(r"^[^|]*(ความรู้สึก|ครั้ง|ความคิดเห็น)[^|]*\|\s*")
# ชื่อเรื่อง + (Ep/ตอน) + เลขท้ายสุด [จบ]
_STRICT = re.compile(r"^(.*?)\s*[,.]?\s*(?:ep\.?|ตอนที่|ตอน|part)?\s*(\d+(?:\.\d+)?)\s*\.?\s*(?:จบ|end)?$", re.I)
# ชื่อเรื่อง+เลข ตามด้วยชื่อตอน
_TRAIL = re.compile(r"^(.*?\D)(\d+)\s+(?!ep|ตอน)(\D.*)$", re.I)
_LEADING_EP = re.compile(r"^\s*[,.]?\s*(?:ep\.?|ตอนที่|ตอน|part)\s*(\d+(?:\.\d+)?)", re.I)
# เต็มเรื่อง / โพสต์ขอบคุณของเพจ — ไม่ใช่ตอนของซีรีส์
_NOT_EPISODE = ("เต็มเรื่อง", "ความรู้สึก", "ขอบคุ", "on Reels")


def clean_title(title: str, page_name: str = "") -> str:
    """ตัดยอดดู/ความรู้สึก, ชื่อเพจท้าย og:title, แฮชแท็ก, เครดิตเพลง"""
    t = _STATS_PREFIX.sub("", title or "")
    if page_name:
        t = re.sub(rf"\s*\|\s*{re.escape(page_name)}\s*$", "", t)
    t = re.sub(r"#\S+", " ", t)
    t = re.sub(r"cr\..*$", "", t, flags=re.I)
    return " ".join(t.split())


def _norm(name: str) -> str:
    return " ".join(name.split()).casefold()


def parse_episode(title: str) -> tuple[str, float] | None:
    """(ชื่อเรื่อง, เลขตอน) หรือ None ถ้าชื่อคลิปไม่มีเลขตอน"""
    for pattern in (_STRICT, _TRAIL):
        match = pattern.match(title)
        name = match and match.group(1).strip(" -:|,")
        if name:
            return name, float(match.group(2))
    return None


def assign(title: str, playlist_names: list[str]) -> tuple[str, float | None] | None:
    """เลือก playlist ให้คลิป: (ชื่อเรื่อง, เลขตอน หรือ None = ต่อท้ายตอนล่าสุด) / None = ไม่ใช่ตอนของซีรีส์
    - มีเลขตอน → ชื่อเรื่องตามที่แยกได้ (ตรงกับเรื่องเดิม = ใช้ชื่อเดิม ไม่ตรง = เรื่องใหม่)
    - ไม่มีเลขตอน แต่ขึ้นต้นด้วยชื่อเรื่องที่มีอยู่ ("THE4 โดนซองขาว") → เรื่องนั้น ต่อท้ายตอนล่าสุด
    - "เต็มเรื่อง"/โพสต์ทั่วไป → None"""
    if any(word in title for word in _NOT_EPISODE):
        return None
    by_norm = {_norm(n): n for n in playlist_names}
    parsed = parse_episode(title)
    if parsed and _norm(parsed[0]) in by_norm:
        return by_norm[_norm(parsed[0])], parsed[1]
    # ขึ้นต้นด้วยชื่อเรื่องที่มีอยู่ + เว้นวรรค ("THE4 โดนซองขาว" — ไม่งั้นจะแยกได้เป็นเรื่อง "THE" ตอน 4)
    lowered = _norm(title)
    prefixes = [n for n in playlist_names if lowered.startswith(_norm(n) + " ")]
    if prefixes:
        name = max(prefixes, key=len)
        number = _LEADING_EP.match(lowered[len(_norm(name)):])
        return name, float(number.group(1)) if number else None
    return parsed
