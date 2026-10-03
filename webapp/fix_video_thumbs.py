"""ดึงรูปปกจาก Facebook มาเก็บบนเซิร์ฟเวอร์ ให้คลิปเก่าที่รูปปกยังเป็นลิงก์ภายนอก (ใส่ลิงก์เอง/ลิงก์ fbcdn
ที่หมดอายุได้) — รันครั้งเดียว: .venv\\Scripts\\python webapp\\fix_video_thumbs.py
ดึงไม่ได้ (คลิปไม่สาธารณะ/เน็ต) จะคงลิงก์เดิมไว้ ไม่ลบอะไรทิ้ง"""
import app
import storage


def main():
    todo = [v for v in storage.load_videos(fresh=True)
            if v.get("thumbnail_url") != f"/api/videos/{v['id']}/thumb"]
    print(f"คลิปที่รูปปกยังเป็นลิงก์: {len(todo)}")
    fixed = {}
    # ยิงเน็ตก่อน ค่อยเปิดไฟล์แก้ทีเดียวตอนท้าย (ไม่ค้างไฟล์ไว้ระหว่างรอ Facebook)
    for video in todo:
        meta = app._facebook_page_meta(video["facebook_url"])
        ok = bool(meta.get("image")) and app._fetch_video_thumb(video["id"], meta["image"])
        print(f"{'✓' if ok else '✗'} {video['title'][:50]}")
        if ok:
            fixed[video["id"]] = f"/api/videos/{video['id']}/thumb"
    if fixed:
        with storage.state_lock:
            videos = storage.load_videos(fresh=True)
            for video in videos:
                if video.get("id") in fixed:
                    video["thumbnail_url"] = fixed[video["id"]]
            storage.save_videos(videos)
    print(f"เสร็จ: เปลี่ยน {len(fixed)}/{len(todo)} คลิป")


if __name__ == "__main__":
    main()
