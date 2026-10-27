"""BE-01 safety-state invariants exercised through the ASGI app.

These are sequential TestClient tests: they prove state-machine rules, failure
injection, restart recovery, expiry and privacy, but they are *not* the real
HTTP concurrency acceptance (see test_safety_http_multiprocess.py).
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import app
from app.schemas import SafetyEvent
from app.storage import Storage

client = TestClient(app)


def payload(**updates):
    value = dict(session_id="s1", input_version=1, exercise="squat", source="simulation", reps=8,
                 active_seconds=60, observable_seconds=55, work_seconds=30, rest_seconds=20,
                 form_events=0, fatigue=8, discomfort=False, target_reps=12,
                 profile={"weight_kg": 65, "height_cm": 170})
    value.update(updates)
    return value


def state(session_id="s1"):
    response = client.get(f"/api/sessions/{session_id}/state")
    return response.status_code, response.json() if response.status_code == 200 else None


def latch(session_id="s1", event_id="evt-1", note=None):
    body = {"event_id": event_id, "type": "discomfort"}
    if note is not None:
        body["note"] = note
    return client.post(f"/api/sessions/{session_id}/safety-events", json=body)


# ---------------------------------------------------------------------------
# A. versions, latch and idempotency
# ---------------------------------------------------------------------------
def test_higher_version_and_discomfort_false_cannot_clear_the_latch():
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    first = latch()
    assert first.status_code == 200
    assert first.json()["safety_latched"] is True
    assert first.json()["safety_version"] == 1

    blocked = client.post("/api/sessions/analyze",
                          json=payload(input_version=2, discomfort=False, persist=True))
    assert blocked.status_code == 200
    body = blocked.json()
    assert body["safety_latched"] is True
    assert body["safety_version"] == 1
    assert body["proposal"]["blocked"] is True
    assert body["proposal"]["status"] == "blocked"
    gate = [entry for entry in body["trace"] if entry["role"] == "safety_gate"][0]
    assert gate["evidence"]["blocked"] is True
    assert gate["evidence"]["safety_latched"] is True
    assert client.post("/api/sessions/s1/accept",
                       json={"input_version": 2}).status_code == 409
    code, view = state()
    assert code == 200
    assert view["safety_latched"] is True
    assert view["safety_version"] == 1
    assert view["input_version"] == 2


def test_legacy_discomfort_latches_even_when_the_analysis_conflicts():
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    # Same input_version, different content, discomfort=true: the safety event
    # must be committed first and survive the 409.
    conflict = client.post("/api/sessions/analyze",
                           json=payload(reps=3, discomfort=True, persist=True))
    assert conflict.status_code == 409
    code, view = state()
    assert code == 200
    assert view["safety_latched"] is True
    assert view["safety_version"] == 1
    # And the latch keeps a later, higher version non-executable.
    later = client.post("/api/sessions/analyze",
                        json=payload(input_version=2, discomfort=False, persist=True))
    assert later.status_code == 200
    assert later.json()["proposal"]["blocked"] is True
    assert client.post("/api/sessions/s1/accept",
                       json={"input_version": 2}).status_code == 409


def test_version_rules_and_idempotent_replay():
    first = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert first.status_code == 200
    proposal_id = first.json()["proposal"]["proposal_id"]

    replay = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert replay.status_code == 200
    assert replay.json()["proposal"]["proposal_id"] == proposal_id
    assert replay.json()["proposal"]["status"] == "pending"

    conflict = client.post("/api/sessions/analyze", json=payload(reps=5, persist=True))
    assert conflict.status_code == 409

    assert client.post("/api/sessions/analyze",
                       json=payload(input_version=2, persist=True)).status_code == 200
    stale = client.post("/api/sessions/analyze", json=payload(input_version=1, persist=True))
    assert stale.status_code == 409
    code, view = state()
    assert view["input_version"] == 2


def test_repeated_safety_event_is_idempotent_and_conflicts_on_new_content():
    assert latch("s1", "event-a").status_code == 200
    assert latch("s1", "event-b").status_code == 200
    code, view = state()
    assert view["safety_version"] == 1  # only the first latch increments it

    repeat = latch("s1", "event-a")
    assert repeat.status_code == 200
    assert repeat.json()["duplicate"] is True
    assert repeat.json()["safety_version"] == 1
    events = main.storage.list_events("s1")
    # Client ids live in their own namespace, never mixed with internal audit ids.
    assert [event["event_id"] for event in events] == [
        "client:safety:event-a", "client:safety:event-b"]

    conflict = latch("s1", "event-a", note="different content")
    assert conflict.status_code == 409
    assert len(main.storage.list_events("s1")) == 2


def test_safety_event_before_any_analysis_is_kept_and_blocks_the_first_report():
    first = latch("fresh", "early-event")
    assert first.status_code == 200
    assert first.json()["safety_version"] == 1

    report = client.post("/api/sessions/analyze",
                         json=payload(session_id="fresh", input_version=1, persist=True))
    assert report.status_code == 200
    assert report.json()["proposal"]["blocked"] is True
    assert report.json()["safety_latched"] is True
    code, view = state("fresh")
    assert view["input_version"] == 1
    assert view["safety_latched"] is True
    assert client.post("/api/sessions/fresh/accept",
                       json={"input_version": 1}).status_code == 409


# ---------------------------------------------------------------------------
# B. decisions vs the latch
# ---------------------------------------------------------------------------
def test_decision_after_the_latch_is_rejected_for_both_actions():
    client.post("/api/sessions/analyze", json=payload(persist=True))
    assert latch().status_code == 200
    for action in ("accept", "reject"):
        response = client.post(f"/api/sessions/s1/{action}", json={"input_version": 1})
        assert response.status_code == 409
    code, view = state()
    assert view["proposal_status"] == "blocked"
    assert view["safety_latched"] is True


def test_decision_committed_before_the_latch_is_preserved():
    client.post("/api/sessions/analyze", json=payload(persist=True))
    decided = client.post("/api/sessions/s1/accept",
                          json={"input_version": 1, "proposal_id": "s1:1"})
    assert decided.status_code == 200
    assert decided.json()["proposal"]["status"] == "accepted"
    decided_at = decided.json()["proposal"]["decided_at"]
    assert decided_at

    assert latch().status_code == 200
    code, view = state()
    assert view["safety_latched"] is True
    assert view["proposal_status"] == "accepted"
    assert view["decided_at"] == decided_at

    replay = client.post("/api/sessions/s1/accept",
                         json={"input_version": 1, "proposal_id": "s1:1"})
    assert replay.status_code == 200
    assert replay.json()["proposal"]["status"] == "accepted"
    assert replay.json()["proposal"]["decided_at"] == decided_at
    assert replay.json()["safety_latched"] is True  # never a continuation licence
    # BE-01-R1: the safety block is explicit even when replaying a kept decision.
    assert replay.json()["proposal"]["blocked"] is True

    assert client.post("/api/sessions/s1/reject",
                       json={"input_version": 1}).status_code == 409


def test_rejection_before_the_latch_is_preserved():
    client.post("/api/sessions/analyze", json=payload(persist=True))
    assert client.post("/api/sessions/s1/reject",
                       json={"input_version": 1}).status_code == 200
    assert latch().status_code == 200
    code, view = state()
    assert view["safety_latched"] is True
    assert view["proposal_status"] == "rejected"
    assert client.post("/api/sessions/s1/accept",
                       json={"input_version": 1}).status_code == 409
    replay = client.post("/api/sessions/s1/reject", json={"input_version": 1})
    assert replay.status_code == 200
    assert replay.json()["safety_latched"] is True
    assert replay.json()["proposal"]["blocked"] is True
    assert replay.json()["proposal"]["status"] == "rejected"


def test_duplicate_decision_is_idempotent_before_the_latch():
    client.post("/api/sessions/analyze", json=payload(persist=True))
    first = client.post("/api/sessions/s1/reject", json={"input_version": 1})
    assert first.status_code == 200
    again = client.post("/api/sessions/s1/reject", json={"input_version": 1})
    assert again.status_code == 200
    assert again.json()["proposal"]["decided_at"] == first.json()["proposal"]["decided_at"]
    assert client.post("/api/sessions/s1/accept",
                       json={"input_version": 1}).status_code == 409


def test_expected_safety_version_is_checked_server_side():
    client.post("/api/sessions/analyze", json=payload(persist=True))
    mismatch = client.post("/api/sessions/s1/accept",
                           json={"input_version": 1, "expected_safety_version": 1})
    assert mismatch.status_code == 409
    assert client.post("/api/sessions/s1/accept",
                       json={"input_version": 1, "expected_safety_version": 0}).status_code == 200


def test_analysis_committing_during_a_safety_event_is_marked_blocked():
    client.post("/api/sessions/analyze", json=payload(persist=True))

    def safety_arrives():
        result = main.safety_events("s1", SafetyEvent(event_id="race-1", type="discomfort"))
        assert result["safety_latched"] is True

    main._analyze_barrier = safety_arrives
    late = client.post("/api/sessions/analyze",
                       json=payload(input_version=2, discomfort=False, persist=True))
    assert late.status_code == 200  # committed, but not executable
    assert late.json()["proposal"]["blocked"] is True
    assert late.json()["safety_latched"] is True
    code, view = state()
    assert view["safety_latched"] is True
    assert view["input_version"] == 2
    assert client.post("/api/sessions/s1/accept",
                       json={"input_version": 2}).status_code == 409


def test_new_analysis_never_erases_committed_decision_events():
    client.post("/api/sessions/analyze", json=payload(persist=True))
    assert client.post("/api/sessions/s1/accept",
                       json={"input_version": 1}).status_code == 200
    assert client.post("/api/sessions/analyze",
                       json=payload(input_version=2, persist=True)).status_code == 200
    events = main.storage.list_events("s1")
    decisions = [event for event in events if event["event_type"] == "decision.accepted"]
    assert len(decisions) == 1
    assert decisions[0]["input_version"] == 1
    assert decisions[0]["proposal_id"] == "s1:1"
    code, view = state()
    assert view["input_version"] == 2
    assert view["proposal_status"] == "pending"


# ---------------------------------------------------------------------------
# C. persistence, restart, failure injection, expiry, privacy
# ---------------------------------------------------------------------------
def test_sqlite_write_failure_leaves_no_partial_state():
    store = main.storage
    with store.connect() as db:
        db.execute(
            "CREATE TRIGGER block_active BEFORE INSERT ON active_sessions "
            "WHEN NEW.session_id = 'boom' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END"
        )
    failure = client.post("/api/sessions/analyze",
                          json=payload(session_id="boom", persist=False))
    assert failure.status_code == 503
    assert state("boom")[0] == 404
    assert main.storage.list_events("boom") == []
    assert "boom" not in main.reports

    with store.connect() as db:
        db.execute("DROP TRIGGER block_active")
    assert client.post("/api/sessions/analyze",
                       json=payload(session_id="boom", persist=False)).status_code == 200
    assert state("boom")[0] == 200


def test_restart_recovers_the_latch_and_the_committed_decision(tmp_path):
    client.post("/api/sessions/analyze", json=payload(persist=True))
    assert client.post("/api/sessions/s1/accept",
                       json={"input_version": 1}).status_code == 200
    assert latch().status_code == 200

    # Simulate a process restart: same database file, empty process cache.
    restarted = Storage(main.storage.path)
    main.storage = restarted
    with main.lock:
        main.reports.clear()

    code, view = state()
    assert code == 200
    assert view["safety_latched"] is True
    assert view["proposal_status"] == "accepted"
    assert view["report_recoverable"] is True

    replay = client.post("/api/sessions/s1/accept",
                         json={"input_version": 1, "proposal_id": "s1:1"})
    assert replay.status_code == 200
    assert replay.json()["proposal"]["status"] == "accepted"
    assert replay.json()["safety_latched"] is True
    assert client.post("/api/sessions/s1/reject",
                       json={"input_version": 1}).status_code == 409
    # A higher version after the restart is still non-executable.
    blocked = client.post("/api/sessions/analyze",
                          json=payload(input_version=2, persist=True))
    assert blocked.status_code == 200
    assert blocked.json()["proposal"]["blocked"] is True
    assert client.post("/api/sessions/s1/accept",
                       json={"input_version": 2}).status_code == 409


def test_non_persisted_report_returns_a_recovery_conflict_after_restart(tmp_path):
    assert client.post("/api/sessions/analyze", json=payload(persist=False)).status_code == 200
    stored = Storage(main.storage.path)
    main.storage = stored
    with main.lock:
        main.reports.clear()

    replay = client.post("/api/sessions/analyze", json=payload(persist=False))
    assert replay.status_code == 409
    assert "input_version + 1" in replay.json()["detail"]
    decide = client.post("/api/sessions/s1/accept", json={"input_version": 1})
    assert decide.status_code == 409


def test_clearing_history_keeps_the_safety_latch():
    client.post("/api/sessions/analyze", json=payload(persist=True))
    assert latch().status_code == 200
    assert len(client.get("/api/history").json()) == 1

    assert client.delete("/api/history").status_code == 200
    assert client.get("/api/history").json() == []
    code, view = state()
    assert code == 200
    assert view["safety_latched"] is True
    assert view["report_recoverable"] is False

    blocked = client.post("/api/sessions/analyze",
                          json=payload(input_version=2, persist=True))
    assert blocked.status_code == 200
    assert blocked.json()["proposal"]["blocked"] is True
    assert client.post("/api/sessions/s1/accept",
                       json={"input_version": 2}).status_code == 409


def test_expired_session_cannot_be_reactivated(tmp_path):
    main.storage = Storage(tmp_path / "expiring.sqlite3", ttl_seconds=0)
    with main.lock:
        main.reports.clear()
    assert client.post("/api/sessions/analyze", json=payload(persist=False)).status_code == 200

    code, view = state()
    assert code == 200
    assert view["status"] == "expired"

    assert client.post("/api/sessions/s1/safety-events",
                       json={"event_id": "late", "type": "discomfort"}).status_code == 410
    assert client.post("/api/sessions/analyze",
                       json=payload(input_version=2, persist=False)).status_code == 410
    assert client.post("/api/sessions/s1/accept",
                       json={"input_version": 1}).status_code == 410


def test_persist_false_stores_no_report_profile_or_rep_details(tmp_path):
    detail = dict(number=1, start_seconds=1, bottom_seconds=2, end_seconds=3,
                  descent_seconds=1, ascent_seconds=1, min_angle_degrees=120, rom="below_rule")
    report = client.post("/api/sessions/analyze",
                         json=payload(session_id="private", persist=False, rep_details=[detail]))
    assert report.status_code == 200
    assert report.json()["rep_details"] == [detail]

    store = main.storage
    active = store.read_session("private")
    assert active is not None
    assert active["report_json"] is None
    assert active["persist_history"] == 0
    with store.connect() as db:
        db.execute("PRAGMA wal_checkpoint(FULL)")
    blobs = b"".join(
        path.read_bytes()
        for path in (tmp_path / "sessions.sqlite3", tmp_path / "sessions.sqlite3-wal")
        if path.exists()
    )
    for forbidden in (b"weight_kg", b"rep_details", b"trace", b"energy", b"min_angle_degrees"):
        assert forbidden not in blobs
    code, view = state("private")
    assert view["report_recoverable"] is False


def test_persist_true_keeps_the_full_report_in_user_history(tmp_path):
    report = client.post("/api/sessions/analyze",
                         json=payload(session_id="saved", persist=True))
    assert report.status_code == 200
    history = client.get("/api/history").json()
    assert len(history) == 1
    assert history[0]["session_id"] == "saved"
    assert history[0]["saved"] is True
    assert len(history[0]["trace"]) == 4
    assert history[0]["energy"]["daily"]["need_kcal"] > 0
    assert history[0]["proposal"]["status"] == "pending"
    code, view = state("saved")
    assert view["persist_history"] is True
    assert view["report_recoverable"] is True


def test_legacy_accept_shape_without_expected_safety_version_still_works():
    client.post("/api/sessions/analyze", json=payload(persist=True))
    response = client.post("/api/sessions/s1/accept", json={"input_version": 1})
    assert response.status_code == 200
    assert response.json()["proposal"]["status"] == "accepted"


def test_idempotent_replay_of_a_pre_latch_report_stays_non_executable():
    first = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert first.status_code == 200
    assert latch().status_code == 200
    replay = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert replay.status_code == 200  # committed result is replayed...
    assert replay.json()["proposal"]["proposal_id"] == first.json()["proposal"]["proposal_id"]
    assert replay.json()["safety_latched"] is True  # ...and the latch is still reported
    assert replay.json()["safety_version"] == 1
    # BE-01-R1: the replayed report itself must expose the safety block instead of
    # the stale pre-latch "pending" proposal.
    assert replay.json()["proposal"]["blocked"] is True
    assert replay.json()["proposal"]["status"] == "blocked"
    # ...but it is never a continuation licence.
    assert client.post("/api/sessions/s1/accept",
                       json={"input_version": 1}).status_code == 409


def test_idempotency_is_insensitive_to_json_key_order():
    ordered = payload(persist=True)
    reordered = {key: ordered[key] for key in reversed(list(ordered))}
    first = client.post("/api/sessions/analyze", json=ordered)
    second = client.post("/api/sessions/analyze", json=reordered)
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["proposal"]["proposal_id"] == first.json()["proposal"]["proposal_id"]


def test_migration_is_repeatable_and_preserves_legacy_history(tmp_path, monkeypatch):
    db_path = tmp_path / "legacy.sqlite3"
    legacy = {"session_id": "old", "input_version": 1, "saved": True,
              "proposal": {"status": "accepted"}, "trace": []}
    connection = sqlite3.connect(db_path)
    try:
        connection.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        connection.execute("INSERT INTO sessions VALUES (?, ?)",
                           ("old", json.dumps(legacy)))
        connection.commit()
    finally:
        connection.close()

    store = Storage(db_path)
    store.migrate()
    store.migrate()  # repeatable: a second call is a no-op
    assert [row["session_id"] for row in store.list()] == ["old"]

    connection = sqlite3.connect(db_path)
    try:
        tables = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        versions = [row[0] for row in connection.execute(
            "SELECT version FROM schema_migrations ORDER BY version")]
    finally:
        connection.close()
    assert {"sessions", "active_sessions", "session_events", "schema_migrations"} <= tables
    assert versions == [1]
    # A migrated legacy history row does not fabricate an active safety session.
    assert store.read_session("old") is None
    # The legacy row is still served by the user-history API.
    monkeypatch.setattr(main, "storage", store)
    with main.lock:
        main.reports.clear()
    assert client.get("/api/history").json()[0]["session_id"] == "old"
