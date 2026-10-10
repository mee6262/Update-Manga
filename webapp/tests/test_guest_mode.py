"""โหมดผู้เยี่ยมชม: เข้าเว็บได้โดยไม่ล็อกอิน, ฟังก์ชันส่วนตัวต้องล็อกอิน (LOGIN_REQUIRED), ไม่เขียนถัง "local",
ย้ายตอนค้างในเครื่องเข้าบัญชี (/api/guest/import), สมัครเปิดเป็นค่าเริ่มต้น"""
import json
import time
import unittest
from datetime import datetime, timedelta, timezone

from sandbox import client, load

NOW_MS = int(time.time() * 1000)
CHAPTERS = [{"text": f"ตอนที่ {n}", "url": f"https://src.example/g1/{n}"} for n in (5, 4, 3, 2, 1)]  # ใหม่→เก่า
BASE = {"external": False, "added_by": "boss", "created_at": "2026-01-01T00:00:00+00:00"}


class GuestModeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load()
        st = cls.m.storage
        st.save_manga([{"id": "g1", "name": "Guest Manga", "url": "https://src.example/g1/", "source": "src.example",
                        "chapters": CHAPTERS, "latest_chapter": "ตอนที่ 5", "latest_chapter_url": CHAPTERS[0]["url"]}])
        st.save_videos(st.load_videos() + [
            {**BASE, "id": "gv1", "canonical_key": "gv1", "title": "gv1", "facebook_url": "https://www.facebook.com/reel/9"},
            {**BASE, "id": "gv2", "canonical_key": "gv2", "title": "gv2", "facebook_url": "https://www.facebook.com/reel/8"},
        ])
        cls.m.app._facebook_video_sources = lambda url: {}
        cls.anon = client(cls.m, None)

    def test_home_open_without_login(self):
        r = self.anon.get("/")
        self.assertEqual(r.status_code, 200)
        boot = r.get_data(as_text=True)
        self.assertIn('"guest": true', boot)
        self.assertIn('"registration_open": true', boot)

    def test_public_endpoints(self):
        for url in ["/api/manga", "/api/catalog", "/api/categories", "/api/manga/g1/chapters", "/api/history", "/api/videos",
                    "/api/videos/gv1/sources", "/api/videos/gv1/progress", "/api/version", "/api/comments?kind=video&id=gv1"]:
            self.assertEqual(self.anon.get(url).status_code, 200, url)
        self.assertEqual(self.anon.get("/api/history").get_json(), {"items": []})
        self.assertEqual(self.anon.get("/api/videos/gv1/progress").get_json(), {"position_seconds": 0})

    def test_personal_endpoints_need_login(self):
        for method, url, body in [("POST", "/api/catalog/g1/subscribe", None), ("POST", "/api/prefs", {"theme": "light"}),
                                  ("POST", "/api/videos/gv1/progress", {"position_seconds": 30}),
                                  ("DELETE", "/api/videos/gv1/progress", None), ("POST", "/api/videos/gv1/save", {"saved": True}),
                                  ("POST", "/api/comments", {"kind": "video", "id": "gv1", "text": "hi"}),
                                  ("GET", "/api/notifications", None), ("POST", "/api/manga/g1/scroll_position", {"url": "x", "fraction": 0.5}),
                                  ("POST", "/api/guest/import", {"manga": []}), ("GET", "/api/users", None)]:
            r = self.anon.open(url, method=method, json=body)
            self.assertEqual((r.status_code, r.get_json().get("code")), (401, "LOGIN_REQUIRED"), url)

    def test_guest_never_writes_local_bucket(self):
        st = self.m.storage
        self.anon.get("/api/videos/gv1/sources")
        self.anon.get("/api/manga/g1/chapters")
        self.assertEqual(st.load_video_progress("local", fresh=True), {})
        self.assertEqual(st.load_video_saved("local", fresh=True), {})
        users = {u for day in st.load_activity(fresh=True).values() for u in day.get("users", [])}
        self.assertNotIn("local", users)

    def test_guest_never_sees_local_bucket(self):
        st = self.m.storage
        st.save_video_progress("local", {"gv1": {"position_seconds": 99, "updated_at": "2026-01-01T00:00:00+00:00"}})
        st.save_video_saved("local", {"gv1": "2026-01-01T00:00:00+00:00"})
        try:
            items = {v["id"]: v for v in self.anon.get("/api/videos").get_json()["items"]}
            self.assertEqual((items["gv1"]["position_seconds"], items["gv1"]["watched_at"], items["gv1"]["saved_at"]), (0, None, None))
            self.assertEqual(self.anon.get("/api/videos/gv1/progress").get_json(), {"position_seconds": 0})
        finally:
            st.save_video_progress("local", {})
            st.save_video_saved("local", {})

    def test_logout_goes_home_and_register_open(self):
        c = client(self.m, "member", "pw-member-1")
        r = c.get("/logout")
        self.assertEqual((r.status_code, r.headers["Location"].rstrip("/").split("/")[-1] if r.headers["Location"] != "/" else ""), (302, ""))
        self.assertEqual(self.anon.get("/register").status_code, 200)

    def test_guest_rate_limit(self):
        app = self.m.app
        old = app.GUEST_RATE_LIMITS["get_video_sources"]
        app.GUEST_RATE_LIMITS["get_video_sources"] = (3, 600)
        app._guest_hits.clear()
        try:
            codes = [self.anon.get("/api/videos/gv1/sources").status_code for _ in range(4)]
            self.assertEqual(codes, [200, 200, 200, 429])
            self.assertEqual(client(self.m).get("/api/videos/gv1/sources").status_code, 200)  # สมาชิกไม่จำกัด
        finally:
            app.GUEST_RATE_LIMITS["get_video_sources"] = old
            app._guest_hits.clear()


class GuestImportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load()
        GuestModeTest.setUpClass.__func__(cls)  # ข้อมูลเรื่อง/คลิปชุดเดียวกัน

    def setUp(self):
        st = self.m.storage
        st.save_read_state("member", {})
        st.save_video_progress("member", {})
        self.c = client(self.m, "member", "pw-member-1")

    def imp(self, body):
        r = self.c.post("/api/guest/import", json=body)
        return r.status_code, r.get_json()

    def test_guest_newer_wins(self):
        st = self.m.storage
        old = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        st.save_read_state("member", {"g1": {"read_keys": [5.0], "last_read_at": old, "last_scroll": {"key": 5.0, "fraction": 0.2}}})
        status, d = self.imp({"manga": [{"id": "g1", "reads": [{"url": CHAPTERS[4]["url"], "at": NOW_MS - 2000},
                                                              {"url": CHAPTERS[3]["url"], "at": NOW_MS - 1000}],
                                         "scroll": {"url": CHAPTERS[3]["url"], "fraction": 0.4, "at": NOW_MS - 1000}}]})
        self.assertEqual((status, d["manga"]), (200, 1))
        e = st.load_read_state("member", fresh=True)["g1"]
        self.assertEqual(e["read_keys"], [5.0, 1.0, 2.0])  # ตอนล่าสุด = ตอน 2 (ของเครื่อง)
        self.assertEqual(e["last_scroll"], {"key": 2.0, "fraction": 0.4})

    def test_account_newer_keeps_latest(self):
        st = self.m.storage
        st.save_read_state("member", {"g1": {"read_keys": [5.0], "last_read_at": datetime.now(timezone.utc).isoformat(),
                                             "last_scroll": {"key": 5.0, "fraction": 0.7}}})
        self.imp({"manga": [{"id": "g1", "reads": [{"url": CHAPTERS[4]["url"], "at": NOW_MS - 3600_000}],
                             "scroll": {"url": CHAPTERS[4]["url"], "fraction": 0.3, "at": NOW_MS - 3600_000}}]})
        e = st.load_read_state("member", fresh=True)["g1"]
        self.assertEqual(e["read_keys"], [1.0, 5.0])  # เติมตอนที่ขาดไว้หน้า ตอนล่าสุดยังเป็นของบัญชี
        self.assertEqual(e["last_scroll"], {"key": 5.0, "fraction": 0.7})

    def test_videos_newer_wins(self):
        st = self.m.storage
        now_iso = datetime.now(timezone.utc).isoformat()
        st.save_video_progress("member", {"gv1": {"position_seconds": 50, "updated_at": now_iso}})
        status, d = self.imp({"videos": [
            {"id": "gv1", "position_seconds": 10, "at": NOW_MS - 3600_000},              # เก่ากว่าบัญชี → ไม่ทับ
            {"id": "gv2", "position_seconds": 0, "watched": True, "duration_seconds": 300, "at": NOW_MS - 1000},
            {"id": "nope", "position_seconds": 5, "at": NOW_MS}]})                        # ไม่มีคลิปนี้ → ข้าม
        p = st.load_video_progress("member", fresh=True)
        self.assertEqual((status, d["videos"]), (200, 1))
        self.assertEqual(p["gv1"]["position_seconds"], 50)
        self.assertEqual((p["gv2"]["position_seconds"], p["gv2"]["duration_seconds"]), (0, 300.0))

    def test_bad_input_ignored(self):
        st = self.m.storage
        future = NOW_MS + 10 * 365 * 86400_000
        status, d = self.imp({"manga": [{"id": "g1", "reads": ["x", {"url": "https://evil.example/1", "at": NOW_MS},
                                                                  {"url": CHAPTERS[0]["url"], "at": "soon"}]},
                                        {"id": "nope", "reads": [{"url": CHAPTERS[0]["url"], "at": NOW_MS}]}, "junk"],
                              "videos": [{"id": "gv1", "position_seconds": -5, "at": NOW_MS}, {"id": "gv2", "position_seconds": True, "at": NOW_MS}]})
        self.assertEqual((status, d["manga"], d["videos"]), (200, 0, 0))
        self.assertEqual(st.load_read_state("member", fresh=True), {})
        # เวลาจากเครื่องที่อยู่ในอนาคต ถูกตัดเป็นเวลาปัจจุบัน
        self.imp({"manga": [{"id": "g1", "reads": [{"url": CHAPTERS[0]["url"], "at": future}]}]})
        at = datetime.fromisoformat(st.load_read_state("member", fresh=True)["g1"]["last_read_at"])
        self.assertLessEqual(at, datetime.now(timezone.utc))
        self.assertEqual(self.imp({"manga": [{}] * 201})[0], 400)


if __name__ == "__main__":
    unittest.main()
