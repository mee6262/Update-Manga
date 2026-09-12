"""รันครั้งเดียวเพื่อย้ายข้อมูลจาก manga_list.txt / manga_db.json (เดิม) มาเป็น data/manga.json
ส่วนตอนที่เคยอ่านแล้วจะเขียนไว้ที่ data/read_state.json (ตำแหน่งเดิมก่อนมีระบบผู้ใช้หลายคน) —
พอรันแอปครั้งแรกพร้อม WEB_USERNAME/WEB_PASSWORD ใน .env ตัว _bootstrap_first_admin() ใน app.py
จะย้ายไฟล์นี้ไปเป็นของ admin คนแรกให้เองอัตโนมัติ"""
import json
from pathlib import Path
from urllib.parse import urlparse

import storage

ROOT = Path(__file__).parent.parent
LIST_FILE = ROOT / "manga_list.txt"
DB_FILE = ROOT / "manga_db.json"


def load_old_list() -> list[dict]:
    mangas = []
    if not LIST_FILE.exists():
        return mangas
    with open(LIST_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "|" not in line:
                continue
            name, url = line.split("|", maxsplit=1)
            name, url = name.strip(), url.strip()
            if name and url:
                mangas.append({"name": name, "url": url})
    return mangas


def load_old_db() -> dict:
    if not DB_FILE.exists():
        return {}
    with open(DB_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    if storage.MANGA_FILE.exists():
        print(f"⚠️ {storage.MANGA_FILE} มีอยู่แล้ว ข้ามการ migrate (ลบไฟล์ก่อนถ้าต้องการรันใหม่)")
        return

    old_list = load_old_list()
    old_db = load_old_db()

    manga_items = []
    read_state = {}

    for entry in old_list:
        mid = storage.make_id(entry["url"])
        known_chapter = old_db.get(entry["name"])
        manga_items.append(
            {
                "id": mid,
                "name": entry["name"],
                "url": entry["url"],
                "source": urlparse(entry["url"]).netloc,
                "latest_chapter": known_chapter,
                "latest_chapter_url": None,
                "cover_url": None,
                "chapters": [],
                "last_checked_at": None,
                "last_updated_at": None,
            }
        )
        if known_chapter:
            read_state[mid] = {"last_read_chapter": known_chapter, "last_read_at": None}

    storage.save_manga(manga_items)
    if read_state:
        with open(storage.DATA_DIR / "read_state.json", "w", encoding="utf-8") as f:
            json.dump(read_state, f, ensure_ascii=False, indent=2)
    print(f"✅ Migrate เรียบร้อย: {len(manga_items)} เรื่อง -> {storage.MANGA_FILE}")


if __name__ == "__main__":
    main()
