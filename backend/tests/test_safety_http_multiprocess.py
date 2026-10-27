"""Real-HTTP acceptance for BE-01.

Every test here talks to a separately launched Uvicorn process over TCP and then
queries the shared SQLite file directly.  Sequential ``TestClient`` assertions
live in ``test_safety_state.py`` and are not a substitute for these tests.
"""
from __future__ import annotations

import os
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class UvicornServer:
    """One isolated ``app.main:app`` process with its own environment and DB."""

    def __init__(self, db_path: Path, *, ttl_seconds: int = 86400, analyze_delay: float = 0.0,
                 explanation_delay: float = 0.0, explanation_marker: Path | None = None):
        self.db_path = Path(db_path)
        self.port = free_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        env = os.environ.copy()
        env.update({
            "PYTHONPATH": str(BACKEND_DIR),
            "LOCALFIT_DB_PATH": str(self.db_path),
            "LOCALFIT_SESSION_TTL_SECONDS": str(ttl_seconds),
            "LOCALFIT_ANALYZE_DELAY_SECONDS": str(analyze_delay),
            "LOCALFIT_EXPLANATION_DELAY_SECONDS": str(explanation_delay),
            "LOCALFIT_EXPLANATION_MARKER": str(explanation_marker) if explanation_marker else "",
        })
        self.process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app",
             "--host", "127.0.0.1", "--port", str(self.port), "--log-level", "warning"],
            cwd=str(BACKEND_DIR),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def wait_ready(self, timeout: float = 25.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f"uvicorn exited with {self.process.returncode}")
            try:
                if httpx.get(f"{self.base_url}/api/health", timeout=0.5).status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.1)
        raise RuntimeError("uvicorn did not become ready in time")

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:  # pragma: no cover - defensive
                self.process.kill()
                self.process.wait()

    def client(self) -> httpx.Client:
        return httpx.Client(base_url=self.base_url, timeout=10.0)


@pytest.fixture
def server(tmp_path):
    instance = UvicornServer(tmp_path / "sessions.sqlite3")
    try:
        instance.wait_ready()
        yield instance
    finally:
        instance.stop()


@pytest.fixture
def two_servers(tmp_path):
    db_path = tmp_path / "shared.sqlite3"
    first = UvicornServer(db_path)
    second = UvicornServer(db_path)
    try:
        first.wait_ready()
        second.wait_ready()
        yield first, second
    finally:
        first.stop()
        second.stop()


def payload(**updates):
    value = dict(session_id="s1", input_version=1, exercise="squat", source="simulation", reps=8,
                 active_seconds=60, observable_seconds=55, work_seconds=30, rest_seconds=20,
                 form_events=0, fatigue=8, discomfort=False, target_reps=12,
                 profile={"weight_kg": 65})
    value.update(updates)
    return value


def rows(db_path: Path, sql: str, params: tuple = ()) -> list[dict]:
    connection = sqlite3.connect(db_path, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in connection.execute(sql, params).fetchall()]
    finally:
        connection.close()


def active_row(db_path: Path, session_id: str = "s1") -> dict:
    found = rows(db_path, "SELECT * FROM active_sessions WHERE session_id = ?", (session_id,))
    assert found, f"missing active_sessions row for {session_id}"
    return found[0]


def race(actions):
    """Run callables as simultaneously as the OS allows."""
    barrier = threading.Barrier(len(actions))

    def run(action):
        barrier.wait(timeout=15)
        return action()

    with ThreadPoolExecutor(max_workers=len(actions)) as pool:
        futures = [pool.submit(run, action) for action in actions]
        return [future.result(timeout=30) for future in futures]


# ---------------------------------------------------------------------------
# Concurrent decisions
# ---------------------------------------------------------------------------
def test_concurrent_accept_and_reject_cannot_both_win(server):
    with server.client() as api:
        assert api.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200

    def accept():
        with server.client() as api:
            return api.post("/api/sessions/s1/accept", json={"input_version": 1})

    def reject():
        with server.client() as api:
            return api.post("/api/sessions/s1/reject", json={"input_version": 1})

    accept_response, reject_response = race([accept, reject])
    codes = sorted([accept_response.status_code, reject_response.status_code])
    assert codes == [200, 409], (accept_response.text, reject_response.text)

    state = active_row(server.db_path)
    decisions = rows(server.db_path,
                     "SELECT * FROM session_events WHERE session_id='s1' "
                     "AND event_type LIKE 'decision.%'")
    assert len(decisions) == 1
    assert state["proposal_status"] in ("accepted", "rejected")
    assert state["decided_at"]
    assert state["proposal_status"] == decisions[0]["event_type"].split(".")[1]
    print(f"\n[concurrent decisions] final proposal_status={state['proposal_status']} "
          f"events={len(decisions)}")


def test_two_processes_export_the_same_latched_state(tmp_path):
    db_path = tmp_path / "shared.sqlite3"
    first = UvicornServer(db_path)
    second = UvicornServer(db_path)
    try:
        first.wait_ready()
        second.wait_ready()
        with first.client() as api:
            assert api.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
            latch = api.post("/api/sessions/s1/safety-events",
                             json={"event_id": "proc-a", "type": "discomfort"})
            assert latch.status_code == 200
            assert latch.json()["safety_version"] == 1

        with second.client() as api:
            view = api.get("/api/sessions/s1/state").json()
            assert view["safety_latched"] is True
            assert view["safety_version"] == 1
            blocked = api.post("/api/sessions/analyze",
                               json=payload(input_version=2, discomfort=False, persist=True))
            assert blocked.status_code == 200
            assert blocked.json()["proposal"]["blocked"] is True
            assert blocked.json()["safety_latched"] is True
            assert api.post("/api/sessions/s1/accept",
                            json={"input_version": 2}).status_code == 409

        # The first process (which never saw the request above) agrees as well.
        with first.client() as api:
            assert api.post("/api/sessions/s1/accept",
                            json={"input_version": 2}).status_code == 409
            assert api.get("/api/sessions/s1/state").json()["safety_latched"] is True

        state = active_row(db_path)
        assert state["safety_latched"] == 1
        assert state["safety_version"] == 1
        print(f"\n[two processes] safety_latched={state['safety_latched']} "
              f"safety_version={state['safety_version']} input_version={state['input_version']}")
    finally:
        first.stop()
        second.stop()


def test_two_processes_concurrent_decisions_are_serialized(tmp_path):
    db_path = tmp_path / "shared.sqlite3"
    first = UvicornServer(db_path)
    second = UvicornServer(db_path)
    try:
        first.wait_ready()
        second.wait_ready()
        with first.client() as api:
            assert api.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200

        def accept():
            with first.client() as api:
                return api.post("/api/sessions/s1/accept", json={"input_version": 1})

        def reject():
            with second.client() as api:
                return api.post("/api/sessions/s1/reject", json={"input_version": 1})

        accept_response, reject_response = race([accept, reject])
        assert sorted([accept_response.status_code, reject_response.status_code]) == [200, 409]

        state = active_row(db_path)
        decisions = rows(db_path,
                         "SELECT event_type FROM session_events WHERE session_id='s1' "
                         "AND event_type LIKE 'decision.%'")
        assert len(decisions) == 1
        assert state["proposal_status"] == decisions[0]["event_type"].split(".")[1]
        print(f"\n[two-process decisions] winner={state['proposal_status']}")
    finally:
        first.stop()
        second.stop()


def test_accept_racing_a_safety_event_keeps_a_consistent_order(server):
    with server.client() as api:
        assert api.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200

    def accept():
        with server.client() as api:
            return api.post("/api/sessions/s1/accept", json={"input_version": 1})

    def safety():
        with server.client() as api:
            return api.post("/api/sessions/s1/safety-events",
                            json={"event_id": "race-latch", "type": "discomfort"})

    accept_response, safety_response = race([accept, safety])
    assert safety_response.status_code == 200
    state = active_row(server.db_path)
    decisions = rows(server.db_path,
                     "SELECT * FROM session_events WHERE session_id='s1' "
                     "AND event_type LIKE 'decision.%'")
    assert state["safety_latched"] == 1
    if accept_response.status_code == 200:
        # The decision committed first: it is preserved as a historical fact.
        assert state["proposal_status"] == "accepted"
        assert len(decisions) == 1
        # The response was produced before the latch committed; the authoritative
        # state must now expose both the preserved decision and the latch.
        with server.client() as api:
            view = api.get("/api/sessions/s1/state").json()
            assert view["safety_latched"] is True
            assert view["proposal_status"] == "accepted"
            replay = api.post("/api/sessions/s1/accept", json={"input_version": 1})
            assert replay.status_code == 200
            assert replay.json()["proposal"]["status"] == "accepted"
            assert replay.json()["safety_latched"] is True
            assert api.post("/api/sessions/s1/reject",
                            json={"input_version": 1}).status_code == 409
    else:
        assert accept_response.status_code == 409
        assert state["proposal_status"] in ("pending", "blocked")
        assert decisions == []
    print(f"\n[accept vs latch] accept={accept_response.status_code} "
          f"latched={state['safety_latched']} proposal_status={state['proposal_status']}")


def test_analysis_uploaded_during_a_safety_event_is_committed_blocked(tmp_path):
    db_path = tmp_path / "slow.sqlite3"
    slow = UvicornServer(db_path, analyze_delay=0.6)
    try:
        slow.wait_ready()
        with slow.client() as api:
            assert api.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200

        result: dict = {}

        def analyze_second_version():
            with slow.client() as api:
                result["response"] = api.post(
                    "/api/sessions/analyze",
                    json=payload(input_version=2, discomfort=False, persist=True))

        worker = threading.Thread(target=analyze_second_version)
        worker.start()
        time.sleep(0.2)  # the analyze handler is inside the injected delay
        with slow.client() as api:
            latch = api.post("/api/sessions/s1/safety-events",
                             json={"event_id": "mid-analysis", "type": "discomfort"})
            assert latch.status_code == 200
        worker.join(timeout=30)

        response = result["response"]
        assert response.status_code == 200
        body = response.json()
        assert body["proposal"]["blocked"] is True
        assert body["safety_latched"] is True
        with slow.client() as api:
            assert api.post("/api/sessions/s1/accept",
                            json={"input_version": 2}).status_code == 409
        state = active_row(db_path)
        assert state["safety_latched"] == 1
        assert state["input_version"] == 2
        assert state["proposal_status"] == "blocked"
        print(f"\n[analyze/latch race] report blocked={body['proposal']['blocked']} "
              f"final proposal_status={state['proposal_status']}")
    finally:
        slow.stop()


# ---------------------------------------------------------------------------
# Storage failure injection over HTTP + final database state
# ---------------------------------------------------------------------------
def test_sqlite_write_failure_over_http_is_atomic(server):
    # The schema is created lazily; materialize it before injecting a trigger.
    from app.storage import Storage
    Storage(server.db_path).migrate()
    connection = sqlite3.connect(server.db_path, timeout=10)
    try:
        connection.execute(
            "CREATE TRIGGER block_active BEFORE INSERT ON active_sessions "
            "WHEN NEW.session_id = 'boom' BEGIN SELECT RAISE(ABORT, 'injected'); END"
        )
        connection.commit()
    finally:
        connection.close()

    with server.client() as api:
        failure = api.post("/api/sessions/analyze", json=payload(session_id="boom", persist=False))
        assert failure.status_code == 503
        assert api.get("/api/sessions/boom/state").status_code == 404
    assert rows(server.db_path, "SELECT * FROM active_sessions WHERE session_id='boom'") == []
    assert rows(server.db_path, "SELECT * FROM session_events WHERE session_id='boom'") == []
    assert rows(server.db_path, "SELECT * FROM sessions WHERE id='boom'") == []

    connection = sqlite3.connect(server.db_path, timeout=10)
    try:
        connection.execute("DROP TRIGGER block_active")
        connection.commit()
    finally:
        connection.close()

    with server.client() as api:
        assert api.post("/api/sessions/analyze",
                        json=payload(session_id="boom", persist=False)).status_code == 200
    assert len(rows(server.db_path, "SELECT * FROM active_sessions WHERE session_id='boom'")) == 1


def test_real_process_restart_recovers_the_latch_and_the_decision(tmp_path):
    db_path = tmp_path / "restart.sqlite3"
    first = UvicornServer(db_path)
    try:
        first.wait_ready()
        with first.client() as api:
            assert api.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
            assert api.post("/api/sessions/s1/accept",
                            json={"input_version": 1}).status_code == 200
            assert api.post("/api/sessions/s1/safety-events",
                            json={"event_id": "restart-latch",
                                  "type": "discomfort"}).status_code == 200
    finally:
        first.stop()

    second = UvicornServer(db_path)
    try:
        second.wait_ready()
        with second.client() as api:
            view = api.get("/api/sessions/s1/state").json()
            assert view["safety_latched"] is True
            assert view["safety_version"] == 1
            assert view["proposal_status"] == "accepted"
            replay = api.post("/api/sessions/s1/accept",
                              json={"input_version": 1, "proposal_id": "s1:1"})
            assert replay.status_code == 200
            assert replay.json()["proposal"]["status"] == "accepted"
            assert replay.json()["safety_latched"] is True
            assert api.post("/api/sessions/s1/reject",
                            json={"input_version": 1}).status_code == 409
            blocked = api.post("/api/sessions/analyze",
                               json=payload(input_version=2, persist=True))
            assert blocked.json()["proposal"]["blocked"] is True
        state = active_row(db_path)
        assert state["safety_latched"] == 1
        assert state["safety_version"] == 1
        print(f"\n[restart] latched={state['safety_latched']} "
              f"proposal_status={state['proposal_status']}")
    finally:
        second.stop()


def test_safety_event_idempotency_is_shared_between_processes(tmp_path):
    db_path = tmp_path / "events.sqlite3"
    first = UvicornServer(db_path)
    second = UvicornServer(db_path)
    try:
        first.wait_ready()
        second.wait_ready()
        with first.client() as api:
            created = api.post("/api/sessions/s1/safety-events",
                               json={"event_id": "shared", "type": "discomfort"})
            assert created.status_code == 200
            assert created.json()["duplicate"] is False
        with second.client() as api:
            same = api.post("/api/sessions/s1/safety-events",
                            json={"event_id": "shared", "type": "discomfort"})
            assert same.status_code == 200
            assert same.json()["duplicate"] is True
            assert same.json()["safety_version"] == 1
            conflict = api.post("/api/sessions/s1/safety-events",
                                json={"event_id": "shared", "type": "discomfort",
                                      "note": "different content"})
            assert conflict.status_code == 409
        events = rows(db_path, "SELECT * FROM session_events WHERE session_id='s1'")
        assert len(events) == 1
        print(f"\n[cross-process idempotency] events={len(events)} "
              f"safety_version={events[0]['safety_version']}")
    finally:
        first.stop()
        second.stop()


def test_history_clear_over_http_keeps_the_latch(server):
    with server.client() as api:
        assert api.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
        assert api.post("/api/sessions/s1/safety-events",
                        json={"event_id": "hist", "type": "discomfort"}).status_code == 200
        assert len(api.get("/api/history").json()) == 1
        assert api.delete("/api/history").status_code == 200
        assert api.get("/api/history").json() == []
        view = api.get("/api/sessions/s1/state").json()
        assert view["safety_latched"] is True
        assert view["report_recoverable"] is False
        blocked = api.post("/api/sessions/analyze",
                           json=payload(input_version=2, persist=True))
        assert blocked.status_code == 200
        assert blocked.json()["proposal"]["blocked"] is True
    assert active_row(server.db_path)["safety_latched"] == 1


def test_persist_false_rows_contain_no_report_over_http(server):
    detail = dict(number=1, start_seconds=1, bottom_seconds=2, end_seconds=3,
                  descent_seconds=1, ascent_seconds=1, min_angle_degrees=120, rom="below_rule")
    with server.client() as api:
        assert api.post("/api/sessions/analyze",
                        json=payload(session_id="private", persist=False,
                                     rep_details=[detail])).status_code == 200
    active = active_row(server.db_path, "private")
    assert active["report_json"] is None
    assert active["persist_history"] == 0
    assert rows(server.db_path, "SELECT * FROM sessions WHERE id='private'") == []
    blobs = b"".join(
        path.read_bytes()
        for path in (server.db_path, Path(f"{server.db_path}-wal"))
        if path.exists()
    )
    for forbidden in (b"weight_kg", b"rep_details", b"min_angle_degrees", b"trace"):
        assert forbidden not in blobs
    with server.client() as api:
        assert api.get("/api/sessions/private/state").json()["report_recoverable"] is False


def test_final_sqlite_state_after_the_whole_lifecycle(server):
    with server.client() as api:
        assert api.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
        assert api.post("/api/sessions/s1/accept", json={"input_version": 1}).status_code == 200
        assert api.post("/api/sessions/s1/safety-events",
                        json={"event_id": "life", "type": "discomfort"}).status_code == 200
        blocked = api.post("/api/sessions/analyze",
                           json=payload(input_version=2, discomfort=False, persist=True))
        assert blocked.status_code == 200
        assert blocked.json()["proposal"]["blocked"] is True
        assert api.post("/api/sessions/s1/accept",
                        json={"input_version": 2}).status_code == 409

    state = active_row(server.db_path)
    events = rows(server.db_path, "SELECT * FROM session_events WHERE session_id='s1' ORDER BY id")
    history = rows(server.db_path, "SELECT * FROM sessions WHERE id='s1'")

    assert state["safety_latched"] == 1
    assert state["safety_version"] == 1
    assert state["input_version"] == 2
    assert state["proposal_status"] == "blocked"
    assert [event["event_type"] for event in events] == [
        "analysis.committed", "decision.accepted", "safety.discomfort", "analysis.committed",
    ]
    assert events[1]["proposal_id"] == "s1:1"
    assert events[1]["input_version"] == 1
    assert history and history[0]["payload"]
    print(f"\n[final db] active_sessions="
          f"{ {k: v for k, v in state.items() if k != 'report_json'} }")
    print(f"[final db] report_json_present={bool(state['report_json'])}")
    print(f"[final db] events={[(e['event_type'], e['proposal_id']) for e in events]}")
    print(f"[final db] history_rows={len(history)}")


def test_expired_session_over_real_http_cannot_be_reactivated(tmp_path):
    server = UvicornServer(tmp_path / "expiring.sqlite3", ttl_seconds=0)
    try:
        server.wait_ready()
        with server.client() as api:
            assert api.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
            view = api.get("/api/sessions/s1/state").json()
            assert view["status"] == "expired"
            assert view["report_recoverable"] is False
            assert api.post("/api/sessions/s1/safety-events",
                            json={"event_id": "late", "type": "discomfort"}).status_code == 410
            assert api.post("/api/sessions/analyze",
                            json=payload(input_version=2, persist=False)).status_code == 410
        state = active_row(server.db_path)
        assert state["status"] == "expired"
        assert state["report_json"] is None  # sensitive temporary payload was cleared
        # User history is a separate retention policy and is not auto-deleted here.
        assert rows(server.db_path, "SELECT * FROM sessions WHERE id='s1'")
        print(f"\n[expiry] status={state['status']} expires_at={state['expires_at']} "
              f"report_json={state['report_json']}")
    finally:
        server.stop()


# ---------------------------------------------------------------------------
# BE-01-R1: multi-process history deletion must invalidate other caches
# ---------------------------------------------------------------------------
def test_history_delete_in_one_process_invalidates_the_other_process_cache(two_servers):
    first, second = two_servers
    db_path = first.db_path
    assert second.db_path == db_path

    with first.client() as api:
        assert api.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
        assert api.post("/api/sessions/s1/safety-events",
                        json={"event_id": "cache-latch", "type": "discomfort"}).status_code == 200

    # Both processes read the same persisted report; the second one caches it.
    with second.client() as api:
        replay = api.post("/api/sessions/analyze", json=payload(persist=True))
        assert replay.status_code == 200
        assert replay.json()["proposal"]["blocked"] is True
        assert replay.json()["safety_latched"] is True
        assert api.post("/api/sessions/s1/explanation").status_code == 200

    # Process A deletes the user history.
    with first.client() as api:
        assert api.delete("/api/history").status_code == 200
        assert api.get("/api/history").json() == []

    # Process B must neither serve nor write back the deleted report from cache.
    with second.client() as api:
        assert api.get("/api/history").json() == []
        explanation = api.post("/api/sessions/s1/explanation")
        # BE-01-R2: latched + deleted report -> minimal safety block, not a
        # generic "report unavailable" error and never the cached old advice.
        assert explanation.status_code == 200
        assert explanation.json()["runtime"] == "safety_gate"
        assert explanation.json()["blocked"] is True
        assert "禁止继续训练" in explanation.json()["text"]
        assert api.post("/api/sessions/s1/accept", json={"input_version": 1}).status_code == 409
        assert api.post("/api/sessions/s1/reject", json={"input_version": 1}).status_code == 409
        replay_after = api.post("/api/sessions/analyze", json=payload(persist=True))
        assert replay_after.status_code == 409
        assert "deleted" in replay_after.json()["detail"]
        view = api.get("/api/sessions/s1/state").json()
        assert view["safety_latched"] is True
        assert view["report_recoverable"] is False
        assert api.get("/api/history").json() == []

    state = active_row(db_path)
    assert state["safety_latched"] == 1
    assert state["safety_version"] == 1
    assert state["report_json"] is None
    assert rows(db_path, "SELECT * FROM sessions") == []
    assert rows(db_path, "SELECT * FROM session_events WHERE session_id='s1' "
                         "AND event_type='safety.discomfort'")
    print(f"\n[multi-process history delete] safety_latched={state['safety_latched']} "
          f"safety_version={state['safety_version']} report_json={state['report_json']} "
          f"history_rows={len(rows(db_path, 'SELECT * FROM sessions'))}")


def test_latched_replay_is_blocked_across_processes(two_servers):
    first, second = two_servers
    with first.client() as api:
        assert api.post("/api/sessions/analyze", json=payload(persist=True)).status_code == 200
        assert api.post("/api/sessions/s1/safety-events",
                        json={"event_id": "x-proc", "type": "discomfort"}).status_code == 200
    with second.client() as api:
        replay = api.post("/api/sessions/analyze", json=payload(persist=True))
        assert replay.status_code == 200
        body = replay.json()
        assert body["proposal"]["blocked"] is True
        assert body["proposal"]["status"] == "blocked"
        assert body["proposal"]["reason"] == "服务端已记录不适事件：会话已锁存，禁止继续训练。"
        assert body["trace"][-1]["role"] == "safety_gate"
        assert body["trace"][-1]["evidence"]["safety_latched"] is True
        assert all(entry.get("pre_latch") is True for entry in body["trace"][:-1])
        assert body["safety_latched"] is True
        explanation = api.post("/api/sessions/s1/explanation")
        assert explanation.status_code == 200
        assert explanation.json()["runtime"] == "safety_gate"
        assert explanation.json()["blocked"] is True
        assert api.post("/api/sessions/s1/accept", json={"input_version": 1}).status_code == 409
    print("\n[cross-process latched replay] proposal_blocked=True runtime=safety_gate")


def test_explanation_generation_race_over_real_http(tmp_path):
    """A latch committed while the async explanation generates must win.

    The test waits for an explicit "generation started" marker file (test-only
    handshake) instead of inferring progress from a sleep.
    """
    marker = tmp_path / "explanation.started"
    server = UvicornServer(tmp_path / "explanation-race.sqlite3",
                           explanation_delay=1.5, explanation_marker=marker)
    try:
        server.wait_ready()
        with server.client() as api:
            analysis = api.post("/api/sessions/analyze", json=payload(persist=True))
            assert analysis.status_code == 200
            old_reason = analysis.json()["proposal"]["reason"]
        result: dict = {}

        def call_explanation():
            with server.client() as api:
                result["response"] = api.post("/api/sessions/s1/explanation")

        worker = threading.Thread(target=call_explanation)
        worker.start()
        deadline = time.time() + 15
        while time.time() < deadline and not marker.exists():
            time.sleep(0.02)
        assert marker.exists(), "explanation handler did not signal generation start"

        # Only now, with generation explicitly started, commit the safety event.
        with server.client() as api:
            latch = api.post("/api/sessions/s1/safety-events",
                             json={"event_id": "exp-race", "type": "discomfort"})
            assert latch.status_code == 200
        worker.join(timeout=30)
        assert not worker.is_alive()

        response = result["response"]
        assert response.status_code == 200
        body = response.json()
        assert body["runtime"] == "safety_gate"
        assert body["blocked"] is True
        assert body["safety_latched"] is True
        assert "禁止继续训练" in body["text"]
        assert body["text"] != old_reason
        state = active_row(server.db_path)
        assert state["safety_latched"] == 1
        print(f"\n[explanation race/handshake] runtime={body['runtime']} "
              f"blocked={body['blocked']} safety_latched={body['safety_latched']} "
              f"marker_seen=True")
    finally:
        server.stop()
