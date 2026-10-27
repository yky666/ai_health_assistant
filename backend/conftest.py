import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    """Every test gets its own SQLite file and an empty process cache.

    This keeps the suite independent of any ``data/sessions.sqlite3`` left by a
    previous run and makes safety-state assertions deterministic.
    """
    from app import main
    from app.storage import Storage

    store = Storage(tmp_path / "sessions.sqlite3")
    monkeypatch.setattr(main, "storage", store)
    with main.lock:
        main.reports.clear()
    monkeypatch.setattr(main, "ANALYZE_DELAY_SECONDS", 0.0)
    monkeypatch.setattr(main, "EXPLANATION_DELAY_SECONDS", 0.0)
    monkeypatch.setattr(main, "EXPLANATION_MARKER_PATH", "")
    monkeypatch.setattr(main, "_analyze_barrier", None)
    monkeypatch.setattr(main, "_analyze_replay_barrier", None)
    monkeypatch.setattr(main, "_explanation_barrier", None)
    yield store
