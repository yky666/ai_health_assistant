"""BE-01-R1 regressions.

Covers the four issues confirmed by the BE-01 review:
1. latched sessions must never return a stale unblocked report or continuation
   advice (analyze replay, explanation, decisions, restart);
2. client safety-event ids must not collide with internal audit ids;
3. an old history row must not be overwritten by a reused session id;
4. a deleted persisted report must not be resurrected from another process'
   cache (in-process simulation here, real dual-process in
   test_safety_http_multiprocess.py).
"""
from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app import main
from app.main import app
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


def history_payload(store, session_id):
    with store.connect() as db:
        row = db.execute("SELECT payload FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return row["payload"] if row else None


def insert_legacy_history(store, session_id):
    record = {"session_id": session_id, "input_version": 1, "saved": True,
              "proposal": {"status": "accepted", "blocked": False, "proposal_id": f"{session_id}:1"},
              "trace": []}
    raw = json.dumps(record)
    with store.connect() as db:
        db.execute("INSERT INTO sessions (id, payload) VALUES (?, ?)", (session_id, raw))
    return record, raw


# ---------------------------------------------------------------------------
# 1. Report / safety-state consistency
# ---------------------------------------------------------------------------
def test_latched_replay_of_persisted_pending_report_is_blocked():
    first = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert first.status_code == 200
    assert first.json()["proposal"]["blocked"] is False
    assert latch().status_code == 200
    replay = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert replay.status_code == 200
    body = replay.json()
    assert body["proposal"]["proposal_id"] == first.json()["proposal"]["proposal_id"]
    assert body["proposal"]["blocked"] is True
    assert body["proposal"]["status"] == "blocked"
    assert body["safety_latched"] is True
    assert body["safety_version"] == 1
    code, view = state()
    assert view["proposal_status"] == "blocked"
    assert view["safety_latched"] is True
    assert client.post("/api/sessions/s1/accept", json={"input_version": 1}).status_code == 409


def test_latched_replay_of_non_persisted_pending_report_is_blocked():
    first = client.post("/api/sessions/analyze", json=payload(persist=False))
    assert first.status_code == 200
    assert first.json()["proposal"]["blocked"] is False
    assert latch().status_code == 200
    replay = client.post("/api/sessions/analyze", json=payload(persist=False))
    assert replay.status_code == 200
    body = replay.json()
    assert body["proposal"]["blocked"] is True
    assert body["proposal"]["status"] == "blocked"
    assert body["safety_latched"] is True
    assert client.post("/api/sessions/s1/accept", json={"input_version": 1}).status_code == 409


def test_explanation_after_latch_never_returns_continuation_advice():
    first = client.post("/api/sessions/analyze", json=payload(persist=True))
    pending_reason = first.json()["proposal"]["reason"]
    assert latch().status_code == 200
    response = client.post("/api/sessions/s1/explanation")
    assert response.status_code == 200
    body = response.json()
    assert body["runtime"] == "safety_gate"
    assert body["safety_latched"] is True
    assert body["safety_version"] == 1
    assert body["blocked"] is True
    assert "禁止继续训练" in body["text"]
    assert body["text"] != pending_reason


def test_explanation_after_latch_ignores_non_persisted_cache():
    first = client.post("/api/sessions/analyze", json=payload(persist=False))
    pending_reason = first.json()["proposal"]["reason"]
    assert latch().status_code == 200
    response = client.post("/api/sessions/s1/explanation")
    assert response.status_code == 200
    assert response.json()["runtime"] == "safety_gate"
    assert response.json()["text"] != pending_reason


def test_accepted_decision_survives_latch_but_response_is_blocked():
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    decided = client.post("/api/sessions/s1/accept", json={"input_version": 1})
    assert decided.status_code == 200
    decided_at = decided.json()["proposal"]["decided_at"]
    assert decided_at
    assert latch().status_code == 200

    code, view = state()
    assert view["proposal_status"] == "accepted"
    assert view["decided_at"] == decided_at
    assert view["safety_latched"] is True

    replay = client.post("/api/sessions/s1/accept",
                         json={"input_version": 1, "proposal_id": "s1:1"})
    assert replay.status_code == 200
    body = replay.json()
    assert body["proposal"]["status"] == "accepted"  # history fact preserved
    assert body["proposal"]["decided_at"] == decided_at
    assert body["proposal"]["blocked"] is True       # never a continuation licence
    assert body["safety_latched"] is True
    assert client.post("/api/sessions/s1/reject",
                       json={"input_version": 1}).status_code == 409


def test_restart_replay_of_persisted_report_is_blocked():
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    assert latch().status_code == 200
    restarted = Storage(main.storage.path)
    main.storage = restarted
    with main.lock:
        main.reports.clear()
    code, view = state()
    assert view["safety_latched"] is True
    replay = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert replay.status_code == 200
    assert replay.json()["proposal"]["blocked"] is True
    assert replay.json()["proposal"]["status"] == "blocked"
    assert replay.json()["safety_latched"] is True


# ---------------------------------------------------------------------------
# 2. Client event id namespace isolation
# ---------------------------------------------------------------------------
def test_client_event_id_colliding_with_analysis_event_still_latches():
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    response = latch("s1", "analysis:1")
    assert response.status_code == 200
    assert response.json()["event_id"] == "analysis:1"
    assert response.json()["safety_latched"] is True
    assert response.json()["safety_version"] == 1

    duplicate = latch("s1", "analysis:1")
    assert duplicate.status_code == 200
    assert duplicate.json()["duplicate"] is True
    assert latch("s1", "analysis:1", note="changed content").status_code == 409

    events = main.storage.list_events("s1")
    analysis_events = [event for event in events if event["event_type"] == "analysis.committed"]
    safety_events = [event for event in events if event["event_type"] == "safety.discomfort"]
    assert len(analysis_events) == 1                       # internal audit row kept
    assert analysis_events[0]["event_id"] == "internal:analysis:1"
    assert len(safety_events) == 1                         # one idempotent client event
    assert safety_events[0]["event_id"] == "client:safety:analysis:1"
    assert client.post("/api/sessions/s1/accept",
                       json={"input_version": 1}).status_code == 409


def test_client_event_id_colliding_with_decision_event_still_latches():
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    assert client.post("/api/sessions/s1/accept", json={"input_version": 1}).status_code == 200
    response = latch("s1", "decision:s1:1:accepted")
    assert response.status_code == 200
    assert response.json()["safety_latched"] is True

    events = main.storage.list_events("s1")
    types = [event["event_type"] for event in events]
    assert "analysis.committed" in types
    assert "decision.accepted" in types
    assert sum(1 for event in events if event["event_type"] == "safety.discomfort") == 1

    replay = client.post("/api/sessions/s1/accept", json={"input_version": 1})
    assert replay.status_code == 200
    assert replay.json()["proposal"]["status"] == "accepted"
    assert replay.json()["proposal"]["blocked"] is True


def test_audit_records_survive_ids_that_look_like_every_internal_family():
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    assert client.post("/api/sessions/s1/accept", json={"input_version": 1}).status_code == 200
    for client_id in ("analysis:1", "decision:s1:1:accepted",
                      "legacy-analyze:1", "internal:analysis:1"):
        assert latch("s1", client_id).status_code == 200

    events = main.storage.list_events("s1")
    assert sorted({event["event_type"] for event in events}) == [
        "analysis.committed", "decision.accepted", "safety.discomfort"]
    safety = [event for event in events if event["event_type"] == "safety.discomfort"]
    assert len(safety) == 4
    assert {event["event_id"] for event in safety} == {
        "client:safety:analysis:1",
        "client:safety:decision:s1:1:accepted",
        "client:safety:legacy-analyze:1",
        "client:safety:internal:analysis:1",
    }
    # The internal rows are still unique and present.
    assert [event["event_id"] for event in events
            if event["event_type"] == "analysis.committed"] == ["internal:analysis:1"]
    assert [event["event_id"] for event in events
            if event["event_type"] == "decision.accepted"] == [
                "internal:decision:s1:1:accepted"]


# ---------------------------------------------------------------------------
# 3. Legacy history ids must not be overwritten
# ---------------------------------------------------------------------------
def test_legacy_history_id_cannot_be_reused_by_analysis():
    store = main.storage
    _, raw = insert_legacy_history(store, "legacy-id")
    response = client.post("/api/sessions/analyze",
                           json=payload(session_id="legacy-id", persist=True))
    assert response.status_code == 409
    assert "earlier history record" in response.json()["detail"]
    assert history_payload(store, "legacy-id") == raw   # payload untouched
    assert store.read_session("legacy-id") is None       # no half-created session
    assert store.list_events("legacy-id") == []

    fresh = client.post("/api/sessions/analyze",
                        json=payload(session_id="fresh-id", persist=True))
    assert fresh.status_code == 200
    assert history_payload(store, "fresh-id") is not None


def test_legacy_history_id_cannot_create_active_session_via_safety_event():
    store = main.storage
    _, raw = insert_legacy_history(store, "legacy-id")
    response = latch("legacy-id", "evt")
    assert response.status_code == 409
    assert history_payload(store, "legacy-id") == raw
    assert store.read_session("legacy-id") is None
    assert store.list_events("legacy-id") == []

    ok = latch("fresh-id", "evt")
    assert ok.status_code == 200
    assert store.read_session("fresh-id")["safety_latched"] == 1


def test_normal_active_session_still_updates_its_history():
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    first = history_payload(main.storage, "s1")
    assert client.post("/api/sessions/analyze",
                       json=payload(input_version=2, persist=True)).status_code == 200
    second = history_payload(main.storage, "s1")
    assert first != second
    assert json.loads(second)["input_version"] == 2
    assert len(main.storage.list()) == 1


# ---------------------------------------------------------------------------
# 4. Deleted persisted report vs non-persisted cache
# ---------------------------------------------------------------------------
def test_deleted_persisted_report_is_not_revived_from_stale_cache():
    first = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert first.status_code == 200
    pending_reason = first.json()["proposal"]["reason"]
    assert latch().status_code == 200
    with main.lock:
        assert "s1" in main.reports          # this process keeps a pre-delete cache
    assert main.storage.clear() == 1          # another process deletes user history
    with main.lock:
        assert "s1" in main.reports          # the stale cache is still here

    # BE-01-R2: a latched session gets the minimal safety block response even
    # though the full report was deleted; it must never be the old advice.
    explanation = client.post("/api/sessions/s1/explanation")
    assert explanation.status_code == 200
    body = explanation.json()
    assert body["runtime"] == "safety_gate"
    assert body["blocked"] is True
    assert body["safety_latched"] is True
    assert "禁止继续训练" in body["text"]
    assert body["text"] != pending_reason

    assert client.post("/api/sessions/s1/accept", json={"input_version": 1}).status_code == 409
    replay = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert replay.status_code == 409
    assert "deleted" in replay.json()["detail"]

    assert main.storage.list() == []          # nothing was resurrected
    code, view = state()
    assert view["safety_latched"] is True     # clearing history never unlatches
    assert view["report_recoverable"] is False


def test_deleted_persisted_report_is_not_written_back_by_a_decision():
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    assert main.storage.clear() == 1
    with main.lock:
        main.reports.clear()                  # even without any cache
    assert client.post("/api/sessions/s1/accept", json={"input_version": 1}).status_code == 409
    assert "deleted" in client.post(
        "/api/sessions/s1/accept", json={"input_version": 1}).json()["detail"]
    assert main.storage.list() == []


def test_non_persisted_report_survives_history_clear_from_cache():
    assert client.post("/api/sessions/analyze", json=payload(persist=False)).status_code == 200
    assert main.storage.clear() == 0
    explanation = client.post("/api/sessions/s1/explanation")
    assert explanation.status_code == 200
    assert explanation.json()["safety_latched"] is False
    assert client.post("/api/sessions/s1/accept", json={"input_version": 1}).status_code == 200
    assert main.storage.list() == []


def test_expired_session_explanation_ignores_cache(tmp_path):
    main.storage = Storage(tmp_path / "expiring.sqlite3", ttl_seconds=0)
    with main.lock:
        main.reports.clear()
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    with main.lock:
        assert "s1" in main.reports            # cache exists but must not bypass expiry
    code, view = state()
    assert code == 200
    assert view["status"] == "expired"
    assert client.post("/api/sessions/s1/explanation").status_code == 410
