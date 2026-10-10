"""streams.resolve: แคช/หมดอายุ/จำกัดการขอใหม่/ตรวจรูปแบบ/ไม่ให้ URL รั่วในข้อความ error"""
import unittest

from sandbox import load

T0 = 1_000_000.0


class Fake:
    name = "test-fake"

    def __init__(self):
        self.calls, self.out, self.exc = 0, None, None

    def resolve_playback(self, video, ctx):
        self.calls += 1
        if self.exc:
            raise self.exc
        return dict(self.out)


class StreamResolverTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load()
        cls.s = cls.m.streams
        cls.fake = cls.s.register(Fake())

    def setUp(self):
        self.s.clear()
        self.fake.calls, self.fake.exc = 0, None
        self.fake.out = {"kind": "file", "url": "https://cdn.example/a.mp4?sig=SECRET", "expires_at": T0 + 3600}
        self.video = {"id": "v1", "provider": "test-fake"}

    def code(self, **kw):
        with self.assertRaises(self.s.StreamError) as cm:
            self.s.resolve(self.video, **kw)
        return cm.exception.code

    def test_cached_until_near_expiry(self):
        self.s.resolve(self.video, now=T0)
        self.s.resolve(self.video, now=T0 + 100)
        self.assertEqual(self.fake.calls, 1)
        self.fake.out["expires_at"] = T0 + 7200
        self.s.resolve(self.video, now=T0 + 3600 - 30)  # เหลือไม่ถึง EXPIRY_MARGIN → ขอใหม่
        self.assertEqual(self.fake.calls, 2)

    def test_expired_url_from_provider(self):
        self.fake.out["expires_at"] = T0 - 1
        self.assertEqual(self.code(now=T0), self.s.STREAM_EXPIRED)

    def test_refresh_limit_per_user(self):
        for _ in range(self.s.MAX_REFRESHES):
            self.s.resolve(self.video, refresh=True, ctx={"user": "a"}, now=T0)
        self.assertEqual(self.code(refresh=True, ctx={"user": "a"}, now=T0 + 1), self.s.STREAM_EXPIRED)
        self.assertEqual(self.fake.calls, self.s.MAX_REFRESHES)  # ไม่เรียกแหล่งเกินโควตา
        self.s.resolve(self.video, refresh=True, ctx={"user": "b"}, now=T0 + 1)  # อีกคนไม่โดนนับรวม
        self.s.resolve(self.video, refresh=True, ctx={"user": "a"}, now=T0 + self.s.REFRESH_WINDOW + 5)

    def test_cache_separated_by_origin(self):
        self.s.resolve(self.video, ctx={"origin": "https://a.example"}, now=T0)
        self.s.resolve(self.video, ctx={"origin": "https://b.example"}, now=T0)
        self.assertEqual(self.fake.calls, 2)

    def test_rejects_bad_playback(self):
        for out, code in [({"kind": "rtmp", "url": "https://x/y"}, self.s.PLAYBACK_UNSUPPORTED),
                          ({"kind": "file", "url": "http://x/y.mp4"}, self.s.PLAYER_INFO_MISSING),
                          ({"kind": "embed", "url": "javascript:alert(1)"}, self.s.PLAYER_INFO_MISSING),
                          ({"kind": "hls", "url": ""}, self.s.PLAYER_INFO_MISSING)]:
            self.s.clear()
            self.fake.out = out
            self.assertEqual(self.code(now=T0), code, out)

    def test_provider_crash_hides_url(self):
        self.fake.exc = RuntimeError("boom https://cdn.example/a.mp4?sig=SECRET")
        with self.assertRaises(self.s.StreamError) as cm:
            self.s.resolve(self.video, now=T0)
        self.assertEqual(cm.exception.code, self.s.STREAM_RESOLUTION_FAILED)
        self.assertNotIn("SECRET", cm.exception.message)
        self.assertNotIn("http", cm.exception.message)

    def test_redact(self):
        self.assertEqual(self.s.redact("https://cdn.example/f/1/a.mp4?m=SIG&e=1"), "https://cdn.example/f…")
        self.assertEqual(self.s.redact("not a url"), "-")

    def test_unregistered_provider(self):
        self.video = {"id": "x", "provider": "facebook"}
        self.assertEqual(self.code(), self.s.PLAYBACK_UNSUPPORTED)


if __name__ == "__main__":
    unittest.main()
