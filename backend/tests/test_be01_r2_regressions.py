"""BE-01-R2 regressions.

Task 1: a latched session must return fully blocked report *content*, not only a
        ``blocked`` flag: safety reason, pre-latch trace marked historical, an
        authoritative post-latch gate entry, and the stored history untouched.
Task 2: the async explanation generation must be rechecked against the
        authoritative state after it completes (latch / expiry / deletion).
Task 3: the same-version idempotent analyze replay must re-read the authority
        right before responding instead of using its initial snapshot.
"""
from __future__ import annotations

import asyncio
import json
import threading

import httpx
from fastapi.testclient import TestClient

from app import main
from app.main import app
from app.schemas import SafetyEvent
from app.storage import Storage

client = TestClient(app)

SAFETY_TEXT = "服务端已记录不适事件：会话已锁存，禁止继续训练。"


def payload(**updates):
    value = dict(session_id="s1", input_version=1, exercise="squat", source="simulation", reps=8,
                 active_seconds=60, observable_seconds=55, work_seconds=30, rest_seconds=20,
                 form_events=0, fatigue=8, discomfort=False, target_reps=12,
                 profile={"weight_kg": 65, "height_cm": 170})
    value.update(updates)
    return value


def latch(session_id="s1", event_id="evt-1"):
    return client.post(f"/api/sessions/{session_id}/safety-events",
                       json={"event_id": event_id, "type": "discomfort"})


def state(session_id="s1"):
    response = client.get(f"/api/sessions/{session_id}/state")
    return response.status_code, response.json() if response.status_code == 200 else None


def assert_blocked_content(body):
    """A live latched view must carry the full safety block (task 1)."""
    assert body["proposal"]["blocked"] is True
    assert body["proposal"]["reason"] == SAFETY_TEXT
    trace = body["trace"]
    assert isinstance(trace, list) and len(trace) >= 2
    # every pre-latch entry is retained only as marked historical evidence
    for entry in trace[:-1]:
        assert entry.get("pre_latch") is True, entry
        assert entry.get("historical") is True, entry
    # the last entry is the authoritative post-latch decision
    gate = trace[-1]
    assert gate["role"] == "safety_gate"
    assert gate.get("pre_latch") is False
    assert gate["evidence"]["safety_latched"] is True
    assert gate["evidence"]["safety_version"] == body["safety_version"]
    assert "阻止继续训练" in gate["decision"]
    # the old "candidate plan passed" conclusion is kept but flagged as history
    candidates = [entry for entry in trace[:-1]
                  if "候选计划通过预设规则" in str(entry.get("decision"))]
    assert candidates, "pre-latch candidate-pass evidence should be retained"
    return trace


# ---------------------------------------------------------------------------
# Task 1: complete blocking of report content after a latch
# ---------------------------------------------------------------------------
def test_latched_persisted_replay_replaces_reason_and_marks_trace():
    first = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert first.status_code == 200
    old_reason = first.json()["proposal"]["reason"]
    stored_history = main.storage.list()[0]
    assert latch().status_code == 200

    replay = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert replay.status_code == 200
    body = replay.json()
    assert body["proposal"]["status"] == "blocked"
    assert body["proposal"]["reason"] != old_reason
    assert_blocked_content(body)

    # the persisted history archive is not rewritten by the live view
    history = main.storage.list()
    assert history[0] == stored_history
    assert history[0]["proposal"]["blocked"] is False
    assert history[0]["proposal"]["reason"] == old_reason
    assert "pre_latch" not in json.dumps(history[0]["trace"])


def test_latched_non_persisted_replay_replaces_reason_and_marks_trace():
    first = client.post("/api/sessions/analyze", json=payload(persist=False))
    assert first.status_code == 200
    old_reason = first.json()["proposal"]["reason"]
    assert latch().status_code == 200

    replay = client.post("/api/sessions/analyze", json=payload(persist=False))
    assert replay.status_code == 200
    body = replay.json()
    assert body["proposal"]["status"] == "blocked"
    assert_blocked_content(body)

    # the raw process cache stays pre-latch; the blocking is a live view only
    with main.lock:
        cached = main.reports["s1"]
    assert cached["proposal"]["blocked"] is False
    assert cached["proposal"]["reason"] == old_reason
    assert "pre_latch" not in json.dumps(cached["trace"])


def test_latched_view_after_accepted_keeps_decision_but_blocks_content():
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    decided = client.post("/api/sessions/s1/accept", json={"input_version": 1})
    assert decided.status_code == 200
    decided_at = decided.json()["proposal"]["decided_at"]
    stored_history = main.storage.list()[0]
    assert latch().status_code == 200

    replay = client.post("/api/sessions/s1/accept", json={"input_version": 1})
    assert replay.status_code == 200
    body = replay.json()
    assert body["proposal"]["status"] == "accepted"      # historical fact kept
    assert body["proposal"]["decided_at"] == decided_at  # not forged
    assert_blocked_content(body)
    # the decision payload in history is still the factual record
    assert main.storage.list()[0] == stored_history


def test_latched_view_after_rejected_keeps_decision_but_blocks_content():
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    decided = client.post("/api/sessions/s1/reject", json={"input_version": 1})
    assert decided.status_code == 200
    decided_at = decided.json()["proposal"]["decided_at"]
    assert latch().status_code == 200

    replay = client.post("/api/sessions/s1/reject", json={"input_version": 1})
    assert replay.status_code == 200
    body = replay.json()
    assert body["proposal"]["status"] == "rejected"
    assert body["proposal"]["decided_at"] == decided_at
    assert_blocked_content(body)


def test_restart_replay_view_is_fully_blocked():
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    old_reason = main.storage.list()[0]["proposal"]["reason"]
    assert latch().status_code == 200
    restarted = Storage(main.storage.path)
    main.storage = restarted
    with main.lock:
        main.reports.clear()

    replay = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert replay.status_code == 200
    body = replay.json()
    assert body["proposal"]["status"] == "blocked"
    assert body["proposal"]["reason"] != old_reason
    assert_blocked_content(body)
    assert restarted.list()[0]["proposal"]["blocked"] is False


# ---------------------------------------------------------------------------
# Task 2: async explanation rechecks the authority after generation
# ---------------------------------------------------------------------------
def test_explanation_async_race_returns_safety_gate(monkeypatch):
    analysis = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert analysis.status_code == 200
    old_reason = analysis.json()["proposal"]["reason"]
    paused = asyncio.Event()
    resume = asyncio.Event()

    async def barrier():
        paused.set()
        await resume.wait()

    monkeypatch.setattr(main, "_explanation_barrier", barrier)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as api:
            task = asyncio.create_task(api.post("/api/sessions/s1/explanation"))
            await asyncio.wait_for(paused.wait(), timeout=10)
            # the safety event commits while the explanation is paused mid-way
            latch_response = await api.post("/api/sessions/s1/safety-events",
                                            json={"event_id": "async-race", "type": "discomfort"})
            assert latch_response.status_code == 200
            resume.set()
            return await asyncio.wait_for(task, timeout=15)

    response = asyncio.run(scenario())
    assert response.status_code == 200
    body = response.json()
    assert body["runtime"] == "safety_gate"
    assert body["blocked"] is True
    assert body["safety_latched"] is True
    assert body["safety_version"] == 1
    assert body["text"] == SAFETY_TEXT
    assert body["text"] != old_reason


def test_explanation_async_race_expiry_returns_410(monkeypatch):
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    paused = asyncio.Event()
    resume = asyncio.Event()

    async def barrier():
        paused.set()
        await resume.wait()

    monkeypatch.setattr(main, "_explanation_barrier", barrier)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as api:
            task = asyncio.create_task(api.post("/api/sessions/s1/explanation"))
            await asyncio.wait_for(paused.wait(), timeout=10)
            # the session expires while the explanation is being generated
            with main.storage.transaction() as conn:
                session = main.storage.read_session("s1", conn=conn)
                session["expires_at"] = "2000-01-01T00:00:00+00:00"
                main.storage.write_session(conn, session)
            resume.set()
            return await asyncio.wait_for(task, timeout=15)

    response = asyncio.run(scenario())
    assert response.status_code == 410
    assert "expired" in response.json()["detail"].lower()


def test_explanation_latched_deleted_report_returns_minimal_safety_gate():
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    assert latch().status_code == 200
    assert main.storage.clear() == 1      # report deleted, latch kept
    with main.lock:
        assert "s1" in main.reports       # stale cache present

    response = client.post("/api/sessions/s1/explanation")
    assert response.status_code == 200   # minimal safety response, not 409
    body = response.json()
    assert body["runtime"] == "safety_gate"
    assert body["blocked"] is True
    assert body["text"] == SAFETY_TEXT
    assert body["safety_latched"] is True

    # same with no local cache at all (another process)
    with main.lock:
        main.reports.clear()
    other = client.post("/api/sessions/s1/explanation")
    assert other.status_code == 200
    assert other.json()["runtime"] == "safety_gate"


def test_explanation_without_latch_still_uses_generated_text():
    analysis = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert analysis.status_code == 200
    response = client.post("/api/sessions/s1/explanation")
    assert response.status_code == 200
    body = response.json()
    assert body["safety_latched"] is False
    assert body["text"] == analysis.json()["proposal"]["reason"]


# ---------------------------------------------------------------------------
# Task 3: same-version analyze replay rechecks the authority before responding
# ---------------------------------------------------------------------------
def test_analyze_replay_rechecks_latch_before_responding(monkeypatch):
    analysis = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert analysis.status_code == 200
    old_reason = analysis.json()["proposal"]["reason"]
    paused = threading.Event()
    resume = threading.Event()

    def barrier():
        paused.set()
        assert resume.wait(timeout=15)

    monkeypatch.setattr(main, "_analyze_replay_barrier", barrier)
    result: dict = {}

    def replay_request():
        result["response"] = client.post("/api/sessions/analyze", json=payload(persist=True))

    worker = threading.Thread(target=replay_request)
    worker.start()
    try:
        assert paused.wait(timeout=15), "replay did not reach the pre-response pause"
        # the safety event commits between the initial state read and the response
        latched = main.safety_events("s1", SafetyEvent(event_id="replay-race", type="discomfort"))
        assert latched["safety_latched"] is True
        resume.set()
    finally:
        worker.join(timeout=20)
    assert not worker.is_alive()

    body = result["response"].json()
    assert body["proposal"]["status"] == "blocked"
    assert body["proposal"]["reason"] != old_reason
    assert_blocked_content(body)
    # ordering evidence: the latch was committed before this response was built
    session = main.storage.read_session("s1")
    assert session["safety_latched"] == 1
    assert session["safety_version"] == 1
    events = main.storage.list_events("s1")
    assert [event["event_type"] for event in events].count("safety.discomfort") == 1


def test_analyze_replay_without_race_keeps_the_normal_view(monkeypatch):
    first = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert first.status_code == 200
    replay = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert replay.status_code == 200
    body = replay.json()
    assert body["proposal"]["status"] == "pending"
    assert body["proposal"]["blocked"] is False
    assert body["safety_latched"] is False
    assert "pre_latch" not in json.dumps(body["trace"])
