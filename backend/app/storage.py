"""SQLite authority for session safety state, decisions and user history.

Two layers exist on purpose:

* ``sessions`` keeps the full report a user explicitly agreed to persist.  It is
  user history and is only written when ``persist=true``.
* ``active_sessions`` keeps the minimum runtime state that must survive a
  process restart (input version/hash, safety latch, proposal identity, TTL).
  When ``persist=false`` it stores *no* report payload, profile, rep details or
  trace, so the privacy choice of the user is not bypassed.
* ``session_events`` is an append-only audit log with a per-session idempotency
  key ``(session_id, event_id)``.  Decisions and safety events are recorded
  here so that earlier decisions are never overwritten by a newer analysis.

All mutations go through ``BEGIN IMMEDIATE`` write transactions on short-lived
connections; the database is the authority and a process-local cache is only a
cache.  ``busy_timeout`` + WAL let independent processes share one database.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA_VERSION = 1

_MIGRATION_1 = (
    # Legacy history table (pre-existing baseline); IF NOT EXISTS keeps old DBs.
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    """
    CREATE TABLE IF NOT EXISTS active_sessions (
        session_id TEXT PRIMARY KEY,
        input_version INTEGER NOT NULL DEFAULT 0,
        input_hash TEXT NOT NULL DEFAULT '',
        safety_latched INTEGER NOT NULL DEFAULT 0,
        safety_version INTEGER NOT NULL DEFAULT 0,
        proposal_id TEXT,
        proposal_status TEXT,
        decided_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        persist_history INTEGER NOT NULL DEFAULT 0,
        report_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        input_version INTEGER,
        proposal_id TEXT,
        safety_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, event_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events (session_id, id)",
    "CREATE INDEX IF NOT EXISTS idx_active_sessions_expiry ON active_sessions (status, expires_at)",
)

# (version, statements).  Applied in order, recorded in schema_migrations; each
# step is idempotent (IF NOT EXISTS) so pre-existing databases migrate safely.
MIGRATIONS: tuple[tuple[int, tuple[str, ...]], ...] = ((1, _MIGRATION_1),)

SESSION_FIELDS = (
    "session_id",
    "input_version",
    "input_hash",
    "safety_latched",
    "safety_version",
    "proposal_id",
    "proposal_status",
    "decided_at",
    "status",
    "persist_history",
    "report_json",
    "created_at",
    "updated_at",
    "expires_at",
)

EVENT_FIELDS = (
    "id",
    "session_id",
    "event_id",
    "event_type",
    "event_hash",
    "input_version",
    "proposal_id",
    "safety_version",
    "created_at",
)


def utc_now() -> str:
    """Timezone-aware UTC timestamp used for every stored timestamp."""
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: sqlite3.Row | None, fields: tuple[str, ...]) -> dict[str, Any] | None:
    if row is None:
        return None
    return {field: row[field] for field in fields}


class Storage:
    def __init__(
        self,
        path: Path | str,
        *,
        ttl_seconds: int = 24 * 60 * 60,
        busy_timeout_seconds: float = 5.0,
    ):
        self.path = Path(path)
        self.ttl_seconds = int(ttl_seconds)
        self.busy_timeout_seconds = float(busy_timeout_seconds)
        self._migrated = False

    # -- connections -------------------------------------------------------
    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(
            self.path,
            timeout=self.busy_timeout_seconds,
            isolation_level=None,
            check_same_thread=False,
        )
        connection.row_factory = sqlite3.Row
        connection.execute(f"PRAGMA busy_timeout = {int(self.busy_timeout_seconds * 1000)}")
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def migrate(self) -> None:
        """Apply pending schema migrations under a single serialized write lock."""
        if self._migrated:
            return
        connection = self._connect()
        try:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS schema_migrations ("
                    "version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
                )
                applied = {
                    row["version"]
                    for row in connection.execute("SELECT version FROM schema_migrations")
                }
                for version, statements in MIGRATIONS:
                    if version in applied:
                        continue
                    for statement in statements:
                        connection.execute(statement)
                    connection.execute(
                        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                        (version, utc_now()),
                    )
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
        finally:
            connection.close()
        self._migrated = True

    def connect(self) -> sqlite3.Connection:
        """Legacy helper: migrated connection usable as a context manager."""
        self.migrate()
        return self._connect()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Serialized write transaction; the only mutation boundary used by the API."""
        self.migrate()
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.execute("COMMIT")
        except BaseException:
            try:
                connection.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            connection.close()

    def read_session(
        self, session_id: str, *, conn: sqlite3.Connection | None = None
    ) -> dict[str, Any] | None:
        self.migrate()
        owned = conn is None
        connection = conn or self._connect()
        try:
            row = connection.execute(
                "SELECT * FROM active_sessions WHERE session_id = ?", (session_id,)
            ).fetchone()
            return _row_to_dict(row, SESSION_FIELDS)
        finally:
            if owned:
                connection.close()

    def write_session(self, conn: sqlite3.Connection, state: dict[str, Any]) -> None:
        placeholders = ", ".join("?" for _ in SESSION_FIELDS)
        updates = ", ".join(f"{field} = excluded.{field}" for field in SESSION_FIELDS[1:])
        conn.execute(
            f"INSERT INTO active_sessions ({', '.join(SESSION_FIELDS)}) VALUES ({placeholders}) "
            f"ON CONFLICT(session_id) DO UPDATE SET {updates}",
            tuple(state[field] for field in SESSION_FIELDS),
        )

    # -- append-only events -------------------------------------------------
    def find_event(
        self, conn: sqlite3.Connection, session_id: str, event_id: str
    ) -> dict[str, Any] | None:
        row = conn.execute(
            "SELECT * FROM session_events WHERE session_id = ? AND event_id = ?",
            (session_id, event_id),
        ).fetchone()
        return _row_to_dict(row, EVENT_FIELDS)

    def record_event(
        self,
        conn: sqlite3.Connection,
        *,
        session_id: str,
        event_id: str,
        event_type: str,
        event_hash: str,
        safety_version: int,
        created_at: str,
        input_version: int | None = None,
        proposal_id: str | None = None,
    ) -> bool:
        """Insert one event; returns False when the idempotency key already exists."""
        cursor = conn.execute(
            "INSERT OR IGNORE INTO session_events "
            "(session_id, event_id, event_type, event_hash, input_version, proposal_id, "
            "safety_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                session_id,
                event_id,
                event_type,
                event_hash,
                input_version,
                proposal_id,
                safety_version,
                created_at,
            ),
        )
        return cursor.rowcount == 1

    def list_events(self, session_id: str) -> list[dict[str, Any]]:
        self.migrate()
        connection = self._connect()
        try:
            rows = connection.execute(
                "SELECT * FROM session_events WHERE session_id = ? ORDER BY id",
                (session_id,),
            ).fetchall()
            return [dict(row) for row in rows]
        finally:
            connection.close()

    # -- user history (persist=true only) ------------------------------------
    def history_exists(self, conn: sqlite3.Connection, session_id: str) -> bool:
        """True when an earlier history row already owns this session id.

        A legacy database (or a row left by a previous release) can keep history
        for a session id whose active state is gone. Creating a fresh active
        session for that id would silently overwrite the old user report, so the
        API checks this inside the write transaction before creating state.
        """
        row = conn.execute(
            "SELECT 1 FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        return row is not None

    def save(self, report: dict[str, Any], conn: sqlite3.Connection | None = None) -> None:
        payload = json.dumps(report, ensure_ascii=False)
        if conn is not None:
            conn.execute(
                "INSERT OR REPLACE INTO sessions VALUES (?, ?)",
                (report["session_id"], payload),
            )
            return
        with self.transaction() as own:
            own.execute(
                "INSERT OR REPLACE INTO sessions VALUES (?, ?)",
                (report["session_id"], payload),
            )

    def list(self) -> list[dict[str, Any]]:
        self.migrate()
        connection = self._connect()
        try:
            return [
                json.loads(row["payload"])
                for row in connection.execute(
                    "SELECT payload FROM sessions ORDER BY rowid DESC LIMIT 50"
                )
            ]
        finally:
            connection.close()

    def clear(self) -> int:
        """Delete user history only.

        Active-session safety state (latch, versions, proposal metadata) is kept;
        only the full report payload is removed so a user delete really deletes
        the report while the safety latch cannot be bypassed by deleting history.
        """
        now = utc_now()
        with self.transaction() as conn:
            deleted = conn.execute("DELETE FROM sessions").rowcount
            conn.execute(
                "UPDATE active_sessions SET report_json = NULL, updated_at = ? "
                "WHERE report_json IS NOT NULL",
                (now,),
            )
        return deleted

    # -- test / diagnostics helpers -----------------------------------------
    def list_active(self) -> list[dict[str, Any]]:
        self.migrate()
        connection = self._connect()
        try:
            rows = connection.execute(
                "SELECT * FROM active_sessions ORDER BY created_at"
            ).fetchall()
            return [dict(row) for row in rows]
        finally:
            connection.close()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Storage({self.path!r}, ttl_seconds={self.ttl_seconds})"
