"""BE-01-R3 regressions: fail-safe when the authoritative re-check fails.

The pre-R3 ``_latest_state_or`` silently fell back to the earlier snapshot when
the final authoritative read raised ``sqlite3.Error`` or returned ``None``. These
tests pin the fail-safe contract:

* storage error during the final re-check -> HTTP 503 (the operation may have
  committed; retries follow the existing idempotency rules);
* missing authoritative row -> HTTP 409;
* never a success response built from the stale snapshot.
"""
from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

from app import main
from app.main import app

client = TestClient(app)


def payload(**updates):
    value = dict(session_id="s1", input_version=1, exercise="squat", source="simulation", reps=8,
                 active_seconds=60, observable_seconds=55, work_seconds=30, rest_seconds=20,
                 form_events=0, fatigue=8, discomfort=False, target_reps=12,
                 profile={"weight_kg": 65, "height_cm": 170})
    value.update(updates)
    return value


def install_flaky_read(monkeypatch, *, fail_plain_on=None, none_plain_on=None):
    """Make the Nth non-transactional ``read_session`` fail or return None.

    Transaction reads (``conn=...``) are untouched, so write transactions still
    commit normally; only the final authoritative re-check is broken.
    """
    real = main.storage.read_session
    calls = {"plain": 0, "real": real}

    def wrapper(session_id, *, conn=None):
        if conn is None:
            calls["plain"] += 1
            if fail_plain_on is not None and calls["plain"] == fail_plain_on:
                raise sqlite3.OperationalError("injected authoritative re-check failure")
            if none_plain_on is not None and calls["plain"] == none_plain_on:
                return None
        return real(session_id, conn=conn)

    monkeypatch.setattr(main.storage, "read_session", wrapper)
    return calls


def restore_real_read(monkeypatch, calls):
    monkeypatch.setattr(main.storage, "read_session", calls["real"])


def snapshot(session_id="s1"):
    return (main.storage.read_session(session_id),
            main.storage.list_events(session_id),
            main.storage.list())


def event_types(session_id="s1"):
    return [event["event_type"] for event in main.storage.list_events(session_id)]


# ---------------------------------------------------------------------------
# A. Same-version replay: the final authoritative read fails
# ---------------------------------------------------------------------------
def test_same_version_replay_recheck_failure_returns_503(monkeypatch):
    first = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert first.status_code == 200
    baseline = snapshot()

    calls = install_flaky_read(monkeypatch, fail_plain_on=2)
    response = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert response.status_code == 503, response.text
    detail = response.json()["detail"]
    assert "re-check" in detail
    assert "may already have been committed" in detail  # no false "not committed" claim
    assert calls["plain"] == 2

    restore_real_read(monkeypatch, calls)
    # the failed re-check must not have changed any state
    assert snapshot() == baseline


# ---------------------------------------------------------------------------
# B. Post-commit re-check fails for analysis and for decisions
# ---------------------------------------------------------------------------
def test_analysis_post_commit_recheck_failure_returns_503_then_idempotent(monkeypatch):
    calls = install_flaky_read(monkeypatch, fail_plain_on=2)
    response = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert response.status_code == 503, response.text
    assert "may already have been committed" in response.json()["detail"]
    assert calls["plain"] == 2  # initial read + post-commit read only

    restore_real_read(monkeypatch, calls)
    row = main.storage.read_session("s1")
    assert row is not None
    assert row["input_version"] == 1
    assert row["proposal_status"] == "pending"
    assert row["report_json"] is not None
    assert event_types() == ["analysis.committed"]
    history = main.storage.list()
    assert len(history) == 1 and history[0]["input_version"] == 1

    retry = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert retry.status_code == 200
    body = retry.json()
    assert body["proposal"]["proposal_id"] == "s1:1"
    assert body["proposal"]["status"] == "pending"
    assert body["proposal"]["blocked"] is False
    assert event_types() == ["analysis.committed"]        # no duplicate event
    assert len(main.storage.list()) == 1                  # history unchanged


def test_decision_post_commit_recheck_failure_returns_503_then_idempotent(monkeypatch):
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    baseline_events = event_types()

    calls = install_flaky_read(monkeypatch, fail_plain_on=1)
    response = client.post("/api/sessions/s1/accept", json={"input_version": 1})
    assert response.status_code == 503, response.text
    assert "may already have been committed" in response.json()["detail"]
    assert calls["plain"] == 1  # decide only performs the post-commit plain read

    restore_real_read(monkeypatch, calls)
    row = main.storage.read_session("s1")
    assert row["proposal_status"] == "accepted"
    assert row["decided_at"]
    assert event_types().count("decision.accepted") == 1
    assert event_types()[: len(baseline_events)] == baseline_events
    history = main.storage.list()
    assert history[0]["proposal"]["status"] == "accepted"

    retry = client.post("/api/sessions/s1/accept", json={"input_version": 1})
    assert retry.status_code == 200
    assert retry.json()["proposal"]["status"] == "accepted"
    assert retry.json()["proposal"]["decided_at"] == row["decided_at"]
    assert event_types().count("decision.accepted") == 1  # idempotent, no duplicate


# ---------------------------------------------------------------------------
# C. Authoritative row disappears during the final re-check
# ---------------------------------------------------------------------------
def test_replay_recheck_missing_state_returns_409_without_side_effects(monkeypatch):
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    baseline = snapshot()

    calls = install_flaky_read(monkeypatch, none_plain_on=2)
    response = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert response.status_code == 409, response.text
    assert "disappeared" in response.json()["detail"]
    assert calls["plain"] == 2

    restore_real_read(monkeypatch, calls)
    assert snapshot() == baseline  # no events, no history change, state untouched


def test_analysis_post_commit_missing_state_returns_409_but_commit_stays(monkeypatch):
    calls = install_flaky_read(monkeypatch, none_plain_on=2)
    response = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert response.status_code == 409, response.text
    assert "disappeared" in response.json()["detail"]
    assert calls["plain"] == 2

    restore_real_read(monkeypatch, calls)
    row = main.storage.read_session("s1")
    assert row["input_version"] == 1 and row["proposal_status"] == "pending"
    assert event_types() == ["analysis.committed"]
    assert len(main.storage.list()) == 1

    retry = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert retry.status_code == 200
    assert retry.json()["proposal"]["proposal_id"] == "s1:1"
    assert event_types() == ["analysis.committed"]
    assert len(main.storage.list()) == 1


def test_decision_post_commit_missing_state_returns_409_but_commit_stays(monkeypatch):
    assert client.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
    baseline_events = event_types()

    calls = install_flaky_read(monkeypatch, none_plain_on=1)
    response = client.post("/api/sessions/s1/reject", json={"input_version": 1})
    assert response.status_code == 409, response.text
    assert "disappeared" in response.json()["detail"]

    restore_real_read(monkeypatch, calls)
    row = main.storage.read_session("s1")
    assert row["proposal_status"] == "rejected"
    assert row["decided_at"]
    assert event_types().count("decision.rejected") == 1
    assert event_types()[: len(baseline_events)] == baseline_events
    assert main.storage.list()[0]["proposal"]["status"] == "rejected"

    retry = client.post("/api/sessions/s1/reject", json={"input_version": 1})
    assert retry.status_code == 200
    assert retry.json()["proposal"]["status"] == "rejected"
    assert event_types().count("decision.rejected") == 1


# ---------------------------------------------------------------------------
# Guard: a healthy re-check still produces the normal success responses
# ---------------------------------------------------------------------------
def test_healthy_recheck_keeps_normal_responses():
    first = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert first.status_code == 200
    replay = client.post("/api/sessions/analyze", json=payload(persist=True))
    assert replay.status_code == 200
    assert replay.json()["proposal"]["status"] == "pending"
    assert replay.json()["safety_latched"] is False
    decided = client.post("/api/sessions/s1/accept", json={"input_version": 1})
    assert decided.status_code == 200
    assert decided.json()["proposal"]["status"] == "accepted"
