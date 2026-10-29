"""คลิปไม่มีชื่อใน playlist (ส่วนตัว/ต้อง login) ต้องไม่กลายเป็นตอน — เคยได้เลขตอนจากลำดับ (ตอน 57, 29 ต.ค. 2026)"""
import unittest

from sandbox import load


class UntitledYoutubeItem(unittest.TestCase):
    def test_untitled_item_skipped_then_added_when_titled(self):
        m = load()
        app, storage = m.app, m.storage
        items = [{"id": f"vid{i:08d}", "title": f"เรื่องทดสอบ ตอนที่ {i}", "duration": 1400, "index": i} for i in (1, 2)]
        info = {"title": "เรื่องทดสอบ", "channel": "", "items": items}
        first = app._store_youtube_items("PLtestuntitled1", info, playlist_id=None, name="เรื่องทดสอบ", lang="dub",
                                         category_id=None, follow=True, username="auto")
        pid = first["playlist_id"]
        hidden = {"id": "vidPRIVATE1", "title": "", "duration": None, "index": 3}
        watch = app._store_youtube_items("PLtestuntitled1", {**info, "items": items + [hidden]}, playlist_id=pid,
                                         name="เรื่องทดสอบ", lang="dub", category_id=None, follow=True, username="auto")
        self.assertEqual(watch["added"], [])
        self.assertEqual(sorted(v["episode"] for v in storage.load_videos() if v.get("playlist_id") == pid), [1.0, 2.0])
        # ช่องเปิดสาธารณะแล้ว: รอบถัดไปได้ชื่อ + เลขตอนจากชื่อ
        public = {**hidden, "title": "เรื่องทดสอบ ตอนที่ 3"}
        later = app._store_youtube_items("PLtestuntitled1", {**info, "items": items + [public]}, playlist_id=pid,
                                         name="เรื่องทดสอบ", lang="dub", category_id=None, follow=True, username="auto")
        self.assertEqual([(v["episode"], v["title"]) for v in later["added"]], [(3.0, "เรื่องทดสอบ ตอนที่ 3")])


if __name__ == "__main__":
    unittest.main()
