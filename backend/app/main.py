"""LocalFit Agent HTTP API.

Safety state is authoritative in SQLite (``app.storage``).  Every mutation runs
inside one ``BEGIN IMMEDIATE`` write transaction that re-reads the committed
state, re-validates it and only then updates it; the process-local ``reports``
dict is a response cache and never the source of truth.  This keeps the safety
latch intact across retries, restarts and independent processes sharing the
same database.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .agents import analyze as build_report
from .catalog import match_food, parse_query
from .local_llm import explain
from .contract import CONTRACT
from .schemas import AcceptProposal, FoodEntry, SafetyEvent, SessionSummary
from .storage import Storage

ROOT = Path(__file__).resolve().parents[2]


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


DEFAULT_TTL_SECONDS = 24 * 60 * 60
TTL_SECONDS = _env_int("LOCALFIT_SESSION_TTL_SECONDS", DEFAULT_TTL_SECONDS)
DB_PATH = Path(os.environ.get("LOCALFIT_DB_PATH") or (ROOT / "data" / "sessions.sqlite3"))

app = FastAPI(title="LocalFit Agent", version="0.2.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                   allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type"])

# SQLite is the authority; this cache only avoids re-reading a report payload.
storage = Storage(DB_PATH, ttl_seconds=TTL_SECONDS)
reports: dict[str, dict[str, Any]] = {}
lock = RLock()

# Test-only hooks: widen the window between the pre-commit read and the commit
# so a concurrent safety event can be injected deterministically.
ANALYZE_DELAY_SECONDS = _env_float("LOCALFIT_ANALYZE_DELAY_SECONDS", 0.0)
EXPLANATION_DELAY_SECONDS = _env_float("LOCALFIT_EXPLANATION_DELAY_SECONDS", 0.0)
# Test-only handshake: when set, explanation generation writes this marker file
# as soon as it enters the generation phase, so a test can wait for an explicit
# "generation started" signal instead of sleeping. Default off; no public API.
EXPLANATION_MARKER_PATH = os.environ.get("LOCALFIT_EXPLANATION_MARKER", "")
_analyze_barrier: Callable[[], None] | None = None
_analyze_replay_barrier: Callable[[], None] | None = None
_explanation_barrier: Callable[[], Awaitable[None]] | None = None

CACHE_LIMIT = 100


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "0.1.0", "agent_runtime": "deterministic",
            "schema_version": CONTRACT["schema_version"], "policy_version": CONTRACT["policy_version"],
            "video_upload": False, "cloud_required": False}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _session_expiry(now: datetime) -> str:
    return (now + timedelta(seconds=storage.ttl_seconds)).isoformat()


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _is_expired(state: dict[str, Any], now: datetime) -> bool:
    return state["status"] == "expired" or _parse_time(state["expires_at"]) <= now


def _blank_state(session_id: str, now: datetime) -> dict[str, Any]:
    return {
        "session_id": session_id,
        "input_version": 0,
        "input_hash": "",
        "safety_latched": 0,
        "safety_version": 0,
        "proposal_id": None,
        "proposal_status": None,
        "decided_at": None,
        "status": "active",
        "persist_history": 0,
        "report_json": None,
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
        "expires_at": _session_expiry(now),
    }


def _expire_in_place(state: dict[str, Any], now: datetime) -> None:
    state["status"] = "expired"
    state["report_json"] = None
    state["updated_at"] = now.isoformat()


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _input_hash(summary: SessionSummary) -> str:
    return hashlib.sha256(_canonical_json(summary.model_dump(mode="json")).encode("utf-8")).hexdigest()


def _safety_event_hash(event: SafetyEvent) -> str:
    return hashlib.sha256(_canonical_json(event.model_dump(mode="json")).encode("utf-8")).hexdigest()


def _legacy_discomfort_hash(summary: SessionSummary) -> str:
    return hashlib.sha256(
        f"legacy-discomfort:{summary.input_version}:{_input_hash(summary)}".encode("utf-8")
    ).hexdigest()


def _decision_hash(decision: str, input_version: int, proposal_id: str | None) -> str:
    return hashlib.sha256(
        _canonical_json({"decision": decision, "input_version": input_version,
                         "proposal_id": proposal_id}).encode("utf-8")
    ).hexdigest()


# Event ids are namespaced so a client-provided id can never collide with the
# server's own analysis/decision audit rows (and vice versa):
#   analysis  -> "internal:analysis:<version>"
#   decision  -> "internal:decision:<proposal_id>:<decision>"
#   legacy    -> "internal:legacy-analysis:<version>"
#   client    -> "client:safety:<client_event_id>"
INTERNAL_EVENT_NAMESPACE = "internal:"
CLIENT_SAFETY_NAMESPACE = "client:safety:"


def _internal_event_id(*parts: str | int) -> str:
    return INTERNAL_EVENT_NAMESPACE + ":".join(str(part) for part in parts)


def _client_safety_event_key(event_id: str) -> str:
    return CLIENT_SAFETY_NAMESPACE + event_id


def _storage_error(action: str) -> HTTPException:
    return HTTPException(503, f"State store unavailable: {action} was not committed")


def _remember(report: dict[str, Any]) -> None:
    with lock:
        reports[report["session_id"]] = report
        while len(reports) > CACHE_LIMIT:
            reports.pop(next(iter(reports)))


def _cached_report(session_id: str) -> dict[str, Any] | None:
    with lock:
        cached = reports.get(session_id)
    return json.loads(json.dumps(cached, ensure_ascii=False)) if cached is not None else None


def _authoritative_payload(state: dict[str, Any]) -> dict[str, Any] | None:
    """Report payload the authoritative session state allows to be used.

    SQLite decides the source, never the cache alone:
    * ``report_json`` set -> the persisted report;
    * ``persist_history == 0`` -> the in-process cache is the only source;
    * ``report_json`` NULL while ``persist_history == 1`` -> the user deleted the
      history: the report is gone and must not be resurrected from a stale cache
      held by another process.
    """
    if state.get("report_json"):
        return json.loads(state["report_json"])
    if int(state.get("persist_history") or 0) == 0:
        cached = _cached_report(state["session_id"])
        if cached is not None and cached.get("input_version") == state["input_version"]:
            return cached
    return None


def _payload_unavailable_detail(state: dict[str, Any]) -> str:
    if int(state.get("persist_history") or 0):
        return ("The persisted report was deleted together with the user history; it cannot be "
                "replayed or decided. Re-analyze with input_version + 1 to create a new report.")
    return ("The committed result for this input_version is not persisted and cannot be recovered "
            "after a restart; resend with input_version + 1 "
            "(and persist=true for restart recovery)")


SAFETY_BLOCK_REASON = "服务端已记录不适事件：会话已锁存，禁止继续训练。"
SAFETY_BLOCK_TRACE_DECISION = "服务端安全锁存：阻止继续训练（当前有效结论）。"


def _report_generated_under_latch(report: dict[str, Any]) -> bool:
    """True when the stored trace already carries the authoritative safety gate.

    Reports generated after the latch record ``safety_latched`` in the
    ``safety_gate`` evidence; earlier reports (or legacy ones without the field)
    are pre-latch history and must be marked as such in a live view.
    """
    for entry in report.get("trace") or []:
        if isinstance(entry, dict) and entry.get("role") == "safety_gate":
            evidence = entry.get("evidence") or {}
            if evidence.get("safety_latched") is True:
                return True
    return False


def _safety_view(payload: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    """Live response view of a report for a possibly latched session.

    A latched session always reports ``proposal.blocked = true``; a ``pending``
    proposal becomes ``blocked``.  An accepted/rejected decision keeps its status
    and ``decided_at`` as the historical fact it is, but the proposal reason is
    replaced by the current safety block so it cannot be read as continuation
    advice.  Pre-latch trace entries are retained as marked historical evidence
    and an authoritative post-latch safety gate entry is appended.

    The view is always a deep copy: the persisted history and the process cache
    keep the original report untouched.
    """
    latched = bool(state["safety_latched"])
    if not latched:
        return _with_safety(payload, False, int(state["safety_version"]))
    view = copy.deepcopy(payload)
    proposal = view["proposal"]
    if proposal.get("status") == "pending":
        proposal["status"] = "blocked"
    proposal["blocked"] = True
    proposal["reason"] = SAFETY_BLOCK_REASON
    if not _report_generated_under_latch(view):
        trace = view.get("trace")
        if isinstance(trace, list):
            for entry in trace:
                if isinstance(entry, dict):
                    entry["pre_latch"] = True
                    entry["historical"] = True
            trace.append({
                "role": "safety_gate",
                "runtime": "authoritative",
                "status": "completed",
                "session_id": view.get("session_id"),
                "input_version": view.get("input_version"),
                "timestamp": state.get("updated_at"),
                "pre_latch": False,
                "historical": False,
                "decision": SAFETY_BLOCK_TRACE_DECISION,
                "evidence": {
                    "safety_latched": True,
                    "safety_version": int(state["safety_version"]),
                    "pre_latch": False,
                },
            })
    return _with_safety(view, True, int(state["safety_version"]))


def _safety_gate_response(state: dict[str, Any],
                          input_version: int | None = None) -> dict[str, Any]:
    """Minimal safety-block response; never depends on a report payload."""
    return {
        "text": SAFETY_BLOCK_REASON,
        "runtime": "safety_gate",
        "input_version": (input_version if input_version is not None
                          else (state["input_version"] or None)),
        "safety_latched": True,
        "safety_version": int(state["safety_version"]),
        "blocked": True,
    }


def _recheck_storage_error(action: str) -> HTTPException:
    """503 for a failed authoritative re-check.

    The surrounding operation may already have been committed, so the message
    must not claim the opposite; callers retry under the existing idempotency
    rules (same input_version + same normalized input, or the same decision).
    """
    return HTTPException(
        503,
        f"Authoritative safety re-check unavailable ({action}). The operation may "
        "already have been committed; retry the same request to obtain the "
        "idempotent result.",
    )


def _authoritative_recheck(session_id: str, action: str) -> dict[str, Any]:
    """Strictly re-read the authoritative state; never fall back to a snapshot."""
    try:
        latest = storage.read_session(session_id)
    except sqlite3.Error as error:
        raise _recheck_storage_error(action) from error
    if latest is None:
        raise HTTPException(
            409,
            f"Session state disappeared during {action}; the operation may already "
            "have been committed. Retry the same request to obtain the idempotent result.",
        )
    return latest


def _with_safety(report: dict[str, Any], latched: bool, safety_version: int) -> dict[str, Any]:
    return {**report, "safety_latched": bool(latched), "safety_version": int(safety_version)}


def _mark_expired(session_id: str) -> None:
    now = _utcnow()
    try:
        with storage.transaction() as conn:
            state = storage.read_session(session_id, conn=conn)
            if state is not None and state["status"] != "expired":
                _expire_in_place(state, now)
                storage.write_session(conn, state)
    except sqlite3.Error:
        # Best effort: the expiry is re-computed from expires_at on every request.
        pass


# ---------------------------------------------------------------------------
# Safety events (single write transaction: event + latch + version)
# ---------------------------------------------------------------------------
def _latch_safety(*, session_id: str, event_key: str, public_event_id: str, event_type: str,
                  event_hash: str, input_version: int | None, now: datetime) -> dict[str, Any]:
    """Commit one safety event and (on the first one) the latch in one transaction.

    ``event_key`` is the namespaced idempotency key stored in SQLite, while
    ``public_event_id`` is the client-facing id echoed back in the response.
    """
    conflict: HTTPException | None = None
    expired = False
    payload: dict[str, Any] | None = None
    try:
        with storage.transaction() as conn:
            state = storage.read_session(session_id, conn=conn)
            if state is not None and _is_expired(state, now):
                _expire_in_place(state, now)
                storage.write_session(conn, state)
                expired = True
            else:
                existing = storage.find_event(conn, session_id, event_key)
                if existing is not None:
                    if existing["event_hash"] != event_hash:
                        conflict = HTTPException(
                            409,
                            f"Safety event {public_event_id!r} was already recorded with "
                            "different content",
                        )
                    else:
                        current = state or _blank_state(session_id, now)
                        payload = {
                            "session_id": session_id,
                            "event_id": public_event_id,
                            "event_type": existing["event_type"],
                            "safety_latched": True,
                            "safety_version": int(current["safety_version"]),
                            "status": current["status"],
                            "duplicate": True,
                        }
                elif state is None and storage.history_exists(conn, session_id):
                    # A legacy history row already owns this id: creating an
                    # active session for it could later overwrite that report.
                    conflict = HTTPException(
                        409,
                        "Session id already belongs to an earlier history record; refusing to "
                        "create a new active session for it. Start a new session id.",
                    )
                else:
                    current = state or _blank_state(session_id, now)
                    latched = bool(current["safety_latched"])
                    version = int(current["safety_version"]) + (0 if latched else 1)
                    storage.record_event(
                        conn,
                        session_id=session_id,
                        event_id=event_key,
                        event_type=event_type,
                        event_hash=event_hash,
                        input_version=(input_version if input_version is not None
                                       else (current["input_version"] or None)),
                        proposal_id=current["proposal_id"],
                        safety_version=version,
                        created_at=now.isoformat(),
                    )
                    current["safety_latched"] = 1
                    current["safety_version"] = version
                    if current["proposal_status"] == "pending":
                        current["proposal_status"] = "blocked"
                    current["updated_at"] = now.isoformat()
                    current["expires_at"] = _session_expiry(now)
                    storage.write_session(conn, current)
                    payload = {
                        "session_id": session_id,
                        "event_id": public_event_id,
                        "event_type": event_type,
                        "safety_latched": True,
                        "safety_version": version,
                        "status": current["status"],
                        "duplicate": False,
                    }
    except sqlite3.Error as error:
        raise _storage_error("safety event") from error
    if expired:
        raise HTTPException(410, "Session state expired; start a new session")
    if conflict is not None:
        raise conflict
    assert payload is not None
    return payload


@app.post("/api/sessions/{session_id}/safety-events")
def safety_events(session_id: str, event: SafetyEvent):
    return _latch_safety(
        session_id=session_id,
        event_key=_client_safety_event_key(event.event_id),
        public_event_id=event.event_id,
        event_type=f"safety.{event.type}",
        event_hash=_safety_event_hash(event),
        input_version=None,
        now=_utcnow(),
    )


# ---------------------------------------------------------------------------
# Analysis: legacy safety first, then version rules, then re-check at commit
# ---------------------------------------------------------------------------
@app.post("/api/sessions/analyze")
def analyze_session(summary: SessionSummary):
    if summary.observable_seconds > summary.active_seconds:
        raise HTTPException(422, "observable_seconds cannot exceed active_seconds")
    now = _utcnow()
    session_id = summary.session_id
    input_hash = _input_hash(summary)

    # 1) Legacy discomfort is committed before any version decision, so a 409
    #    caused by versions can never lose the safety event.
    if summary.discomfort:
        _latch_safety(
            session_id=session_id,
            event_key=_internal_event_id("legacy-analysis", summary.input_version),
            public_event_id=f"legacy-analyze:{summary.input_version}",
            event_type="safety.discomfort",
            event_hash=_legacy_discomfort_hash(summary),
            input_version=summary.input_version,
            now=now,
        )

    # 2) Authoritative read: version rules and idempotent replay.
    try:
        state = storage.read_session(session_id)
    except sqlite3.Error as error:
        raise _storage_error("analysis") from error
    if state is not None and _is_expired(state, now):
        _mark_expired(session_id)
        raise HTTPException(410, "Session state expired; start a new session")
    if state is not None and state["input_version"]:
        if summary.input_version < state["input_version"]:
            raise HTTPException(409, "Stale input_version: a newer analysis was already committed")
        if summary.input_version == state["input_version"]:
            if state["input_hash"] != input_hash:
                raise HTTPException(409, "Conflicting content for the same input_version")
            payload = _authoritative_payload(state)
            if payload is None:
                raise HTTPException(409, _payload_unavailable_detail(state))
            _remember(payload)
            # R2: never build the live response from the snapshot read above - a
            # safety event may have committed while this replay was being prepared.
            if _analyze_replay_barrier is not None:
                _analyze_replay_barrier()
            latest = _authoritative_recheck(session_id, "idempotent analysis replay")
            if _is_expired(latest, _utcnow()):
                _mark_expired(session_id)
                raise HTTPException(410, "Session state expired; start a new session")
            if (int(latest["input_version"]) != int(state["input_version"])
                    or latest["input_hash"] != input_hash):
                raise HTTPException(
                    409, "Session changed while replaying the committed analysis; "
                         "refresh the session state")
            fresh_payload = _authoritative_payload(latest)
            if fresh_payload is None:
                raise HTTPException(409, _payload_unavailable_detail(latest))
            _remember(fresh_payload)
            return _safety_view(fresh_payload, latest)

    # 3) Generate, then re-read the authoritative state inside the commit
    #    transaction so a discomfort that landed meanwhile blocks the report.
    latched = bool(state["safety_latched"]) if state is not None else False
    report = build_report(summary, safety_latched=latched)
    if ANALYZE_DELAY_SECONDS > 0:
        time.sleep(ANALYZE_DELAY_SECONDS)
    if _analyze_barrier is not None:
        _analyze_barrier()

    conflict: HTTPException | None = None
    expired = False
    final_report: dict[str, Any] | None = None
    final_state: dict[str, Any] | None = None
    commit_now = _utcnow()
    try:
        with storage.transaction() as conn:
            current = storage.read_session(session_id, conn=conn)
            if current is not None and _is_expired(current, commit_now):
                _expire_in_place(current, commit_now)
                storage.write_session(conn, current)
                expired = True
            else:
                if current is None and storage.history_exists(conn, session_id):
                    # Checked inside the write transaction: an earlier history row
                    # must never be overwritten by a "new" session with that id.
                    conflict = HTTPException(
                        409,
                        "Session id already belongs to an earlier history record; refusing to "
                        "overwrite it. Start a new session id.",
                    )
                elif current is not None and current["input_version"]:
                    if summary.input_version < current["input_version"]:
                        conflict = HTTPException(
                            409, "Stale input_version: a newer analysis was committed meanwhile")
                    elif summary.input_version == current["input_version"]:
                        if current["input_hash"] != input_hash:
                            conflict = HTTPException(
                                409, "Conflicting content for the same input_version")
                        else:
                            payload = _authoritative_payload(current)
                            if payload is None:
                                conflict = HTTPException(
                                    409, _payload_unavailable_detail(current))
                            else:
                                final_report = payload
                                final_state = current
                if conflict is None and final_report is None:
                    latched_final = bool(current["safety_latched"]) if current is not None else False
                    if latched_final != latched:
                        report = build_report(summary, safety_latched=latched_final)
                    final_report = report
                    final_state = _commit_analysis(conn, current, summary, input_hash, report,
                                                   commit_now)
    except sqlite3.Error as error:
        raise _storage_error("analysis") from error
    if expired:
        raise HTTPException(410, "Session state expired; start a new session")
    if conflict is not None:
        raise conflict
    assert final_report is not None and final_state is not None
    _remember(final_report)
    # R2/R3: reconcile with the authority once more right before the live
    # response. The re-check is strict: a storage error becomes 503 and a
    # missing row becomes 409, never a stale unconfirmed view.
    response_state = final_state
    latest = _authoritative_recheck(session_id, "post-commit analysis reconciliation")
    if bool(latest["safety_latched"]) and not bool(final_state["safety_latched"]):
        response_state = latest
    return _safety_view(final_report, response_state)


def _commit_analysis(conn: sqlite3.Connection, current: dict[str, Any] | None,
                     summary: SessionSummary, input_hash: str, report: dict[str, Any],
                     now: datetime) -> dict[str, Any]:
    proposal = report["proposal"]
    persist = bool(summary.persist)
    state = dict(current) if current is not None else _blank_state(summary.session_id, now)
    # safety_latched / safety_version are preserved: an analysis never clears them.
    state.update({
        "input_version": summary.input_version,
        "input_hash": input_hash,
        "proposal_id": proposal["proposal_id"],
        "proposal_status": proposal["status"],
        "decided_at": None,
        "status": "active",
        "persist_history": 1 if persist else 0,
        "report_json": json.dumps(report, ensure_ascii=False) if persist else None,
        "updated_at": now.isoformat(),
        "expires_at": _session_expiry(now),
    })
    if persist:
        storage.save(report, conn=conn)
    storage.write_session(conn, state)
    storage.record_event(
        conn,
        session_id=summary.session_id,
        event_id=_internal_event_id("analysis", summary.input_version),
        event_type="analysis.committed",
        event_hash=input_hash,
        safety_version=int(state["safety_version"]),
        created_at=now.isoformat(),
        input_version=summary.input_version,
        proposal_id=proposal["proposal_id"],
    )
    return state


# ---------------------------------------------------------------------------
# Decisions: one transaction re-reads latch/version/proposal, then commits
# ---------------------------------------------------------------------------
@app.post("/api/sessions/{session_id}/accept")
def accept(session_id: str, request: AcceptProposal):
    return decide(session_id, request, "accepted")


@app.post("/api/sessions/{session_id}/reject")
def reject(session_id: str, request: AcceptProposal):
    return decide(session_id, request, "rejected")


def decide(session_id: str, request: AcceptProposal, decision: str):
    now = _utcnow()
    conflict: HTTPException | None = None
    expired = False
    result: dict[str, Any] | None = None
    result_state: dict[str, Any] | None = None
    try:
        with storage.transaction() as conn:
            state = storage.read_session(session_id, conn=conn)
            if state is None:
                conflict = HTTPException(404, "Session not found")
            elif _is_expired(state, now):
                _expire_in_place(state, now)
                storage.write_session(conn, state)
                expired = True
            elif (request.expected_safety_version is not None
                  and request.expected_safety_version != int(state["safety_version"])):
                conflict = HTTPException(
                    409, "Safety version mismatch: refresh the session state before deciding")
            elif request.input_version != int(state["input_version"]):
                conflict = HTTPException(
                    409, "Stale proposal: input version does not match the committed analysis")
            elif request.proposal_id is not None and request.proposal_id != state["proposal_id"]:
                conflict = HTTPException(409, "Proposal identity mismatch")
            elif state["safety_latched"]:
                if state["proposal_status"] == decision and state["decided_at"]:
                    # History fact committed before the latch: replay it, but the
                    # response is still explicitly marked as safety-blocked.
                    payload = _authoritative_payload(state)
                    if payload is None:
                        conflict = HTTPException(
                            409,
                            "This decision was committed before the safety latch but the full "
                            "report is no longer recoverable. "
                            + _payload_unavailable_detail(state),
                        )
                    else:
                        payload["proposal"]["status"] = decision
                        payload["proposal"]["decided_at"] = state["decided_at"]
                        result = payload
                        result_state = state
                else:
                    conflict = HTTPException(
                        409, "Continuation blocked by the committed safety latch")
            elif state["proposal_status"] == decision:
                payload = _authoritative_payload(state)
                if payload is None:
                    conflict = HTTPException(409, _payload_unavailable_detail(state))
                else:
                    result = payload
                    result_state = state
            elif state["proposal_status"] != "pending":
                conflict = HTTPException(409, "Decision already finalized")
            else:
                payload = _authoritative_payload(state)
                if payload is None:
                    conflict = HTTPException(409, _payload_unavailable_detail(state))
                else:
                    decided_at = now.isoformat()
                    payload["proposal"]["status"] = decision
                    payload["proposal"]["decided_at"] = decided_at
                    payload["saved"] = bool(state["persist_history"])
                    storage.record_event(
                        conn,
                        session_id=session_id,
                        event_id=_internal_event_id("decision", state["proposal_id"], decision),
                        event_type=f"decision.{decision}",
                        event_hash=_decision_hash(decision, int(state["input_version"]),
                                                  state["proposal_id"]),
                        safety_version=int(state["safety_version"]),
                        created_at=decided_at,
                        input_version=int(state["input_version"]),
                        proposal_id=state["proposal_id"],
                    )
                    if state["persist_history"]:
                        storage.save(payload, conn=conn)
                        state["report_json"] = json.dumps(payload, ensure_ascii=False)
                    state["proposal_status"] = decision
                    state["decided_at"] = decided_at
                    state["updated_at"] = decided_at
                    state["expires_at"] = _session_expiry(now)
                    storage.write_session(conn, state)
                    result = payload
                    result_state = state
    except sqlite3.Error as error:
        raise _storage_error("decision") from error
    if expired:
        raise HTTPException(410, "Session state expired; start a new session")
    if conflict is not None:
        raise conflict
    assert result is not None and result_state is not None
    _remember(result)
    # R2/R3: a latch committed after our decision transaction must still block the
    # view, and the re-check is strict (503 on storage error, 409 on missing row).
    latest = _authoritative_recheck(session_id, "post-commit decision reconciliation")
    if bool(latest["safety_latched"]) and not bool(result_state["safety_latched"]):
        result_state = latest
    return _safety_view(result, result_state)


# ---------------------------------------------------------------------------
# State inspection (metadata only) and history
# ---------------------------------------------------------------------------
@app.get("/api/sessions/{session_id}/state")
def session_state(session_id: str):
    now = _utcnow()
    try:
        state = storage.read_session(session_id)
    except sqlite3.Error as error:
        raise _storage_error("state read") from error
    if state is None:
        raise HTTPException(404, "Session not found")
    if _is_expired(state, now):
        _mark_expired(session_id)
        try:
            refreshed = storage.read_session(session_id)
            state = refreshed if refreshed is not None else state
        except sqlite3.Error:
            pass
        if _is_expired(state, now):
            # Even if the best-effort cleanup write failed, never report "active".
            state = {**state, "status": "expired", "report_json": None}
    return {
        "session_id": session_id,
        "status": state["status"],
        "safety_latched": bool(state["safety_latched"]),
        "safety_version": int(state["safety_version"]),
        "input_version": state["input_version"] or None,
        "proposal_id": state["proposal_id"],
        "proposal_status": state["proposal_status"],
        "decided_at": state["decided_at"],
        "persist_history": bool(state["persist_history"]),
        "report_recoverable": bool(state["report_json"]),
        "expires_at": state["expires_at"],
    }


@app.post("/api/sessions/{session_id}/explanation")
async def explanation(session_id: str):
    # The authoritative state is read first: the cache must never bypass expiry,
    # a committed safety latch or a history deletion.
    now = _utcnow()
    try:
        state = storage.read_session(session_id)
    except sqlite3.Error as error:
        raise _storage_error("explanation") from error
    if state is None:
        raise HTTPException(404, "Session not found")
    if _is_expired(state, now):
        _mark_expired(session_id)
        raise HTTPException(410, "Session state expired; start a new session")
    if bool(state["safety_latched"]):
        # A latched session gets the minimal safety response even when the full
        # report was already deleted with the user history.
        return _safety_gate_response(state)
    payload = _authoritative_payload(state)
    if payload is None:
        raise HTTPException(409, _payload_unavailable_detail(state))
    _remember(payload)
    snapshot = {**payload, "proposal": dict(payload["proposal"])}
    # Generation is async. These test-only hooks let tests pause the handler and
    # know exactly when generation has started (defaults are off).
    if EXPLANATION_MARKER_PATH:
        try:
            Path(EXPLANATION_MARKER_PATH).write_text("explanation-started", encoding="utf-8")
        except OSError:
            pass
    if _explanation_barrier is not None:
        await _explanation_barrier()
    if EXPLANATION_DELAY_SECONDS > 0:
        await asyncio.sleep(EXPLANATION_DELAY_SECONDS)

    fallback_reason: str | None = None
    try:
        message = await explain(snapshot)
        text = message or snapshot["proposal"]["reason"]
        runtime = "local_llm" if message else "deterministic"
    except Exception as error:
        # Preserve working baseline when an optional local model is unavailable.
        text = snapshot["proposal"]["reason"]
        runtime = "fallback"
        fallback_reason = type(error).__name__

    # R2: re-read the authority *after* the async generation. A latch or expiry
    # committed meanwhile must win over the already generated text.
    try:
        latest = storage.read_session(session_id)
    except sqlite3.Error as error:
        raise _storage_error("explanation") from error
    if latest is None:
        raise HTTPException(409, "Session disappeared while generating the explanation")
    if _is_expired(latest, _utcnow()):
        _mark_expired(session_id)
        raise HTTPException(410, "Session state expired; start a new session")
    if bool(latest["safety_latched"]):
        return _safety_gate_response(latest, snapshot.get("input_version"))
    if int(latest["input_version"]) != int(state["input_version"]):
        raise HTTPException(
            409, "A newer analysis was committed while generating the explanation; request it again")
    if _authoritative_payload(latest) is None:
        raise HTTPException(409, _payload_unavailable_detail(latest))
    response = {"text": text, "runtime": runtime,
                "input_version": snapshot["input_version"],
                "safety_latched": False,
                "safety_version": int(latest["safety_version"])}
    if fallback_reason is not None:
        response["reason"] = fallback_reason
    return response


@app.get("/api/history")
def history():
    try:
        return storage.list()
    except sqlite3.Error as error:
        raise _storage_error("history read") from error


@app.delete("/api/history")
def clear_history():
    try:
        storage.clear()
    except sqlite3.Error as error:
        raise _storage_error("history delete") from error
    with lock:
        reports.clear()
    return {"deleted": True}


@app.post("/api/nutrition/estimate")
def nutrition(entries: list[FoodEntry]):
    if len(entries) > 100:
        raise HTTPException(422, "Too many entries")
    items = []
    for entry in entries:
        food = match_food(entry.query, entry.food_id)
        if food is None and entry.kcal_per_100g is None:
            items.append({"name": entry.query or "未识别食物", "grams": entry.grams or 100,
                          "kcal": 0, "matched": False})
            continue
        kcal_per = entry.kcal_per_100g if entry.kcal_per_100g is not None else food["kcal"]
        _, parsed = parse_query(entry.query)
        grams = entry.grams or parsed or (food["unit_g"] if food else 100)
        items.append({
            "name": food["name"] if food else entry.query or "自定义食物",
            "food_id": food["id"] if food else None,
            "grams": grams,
            "kcal_per_100g": kcal_per,
            "kcal": round(kcal_per * grams / 100, 1),
            "matched": food is not None,
        })
    return {"items": items, "total_kcal": round(sum(x["kcal"] for x in items), 1),
            "data_status": "illustrative_unverified",
            "note": "示例食物库按名称匹配，尚未完成烹饪方式核验，仅供功能演示。"}


# Mount last so explicit API and OpenAPI routes retain priority.
frontend_build = ROOT / "frontend" / "dist"
if frontend_build.is_dir():
    app.mount("/", StaticFiles(directory=frontend_build, html=True), name="frontend")
