"""โหลดเว็บแอปจากสำเนาในโฟลเดอร์ชั่วคราว — `import app` รัน migration ที่เขียน data/ จริง ห้าม import จาก webapp/ ตรง ๆ

รัน: python -m unittest discover -s webapp/tests   (จาก root ของ repo, ไม่ต้องใช้เน็ต)
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

WEBAPP = Path(__file__).resolve().parents[1]
_mods = None


def load() -> SimpleNamespace:
    global _mods
    if _mods:
        return _mods
    root = Path(tempfile.mkdtemp(prefix="mee-tests-")) / "webapp"
    shutil.copytree(WEBAPP, root, ignore=shutil.ignore_patterns("data", "tests", "__pycache__"))
    (root / "data").mkdir()
    sys.path[:] = [p for p in sys.path if Path(p or ".").resolve() != WEBAPP]
    sys.path.insert(0, str(root))
    os.environ["SECRET_KEY"] = "test-secret"
    os.environ.pop("PUBLIC_ORIGIN", None)
    import storage  # noqa: E402

    if Path(storage.__file__).resolve().parent != root.resolve():
        raise RuntimeError(f"import storage ผิดที่: {storage.__file__} — จะเขียน data จริง")
    from werkzeug.security import generate_password_hash

    storage.save_users({
        "boss": {"password_hash": generate_password_hash("pw-admin-1"), "is_admin": True},
        "member": {"password_hash": generate_password_hash("pw-member-1"), "is_admin": False},
    })
    import a037, anifume, app, streams  # noqa: E402,E401

    assert Path(app.__file__).resolve().parent == root.resolve()
    _mods = SimpleNamespace(root=root, storage=storage, streams=streams, anifume=anifume, a037=a037, app=app)
    return _mods


def client(mods, user: str | None = "boss", password: str = "pw-admin-1"):
    c = mods.app.app.test_client()
    if user:
        r = c.post("/login", data={"username": user, "password": password})
        assert r.status_code == 302, r.status_code
    return c
