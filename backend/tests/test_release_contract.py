import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from app import main
from app.schemas import SessionSummary
from app.storage import Storage

BASE = dict(session_id="transaction", exercise="squat", source="simulation", reps=12,
            active_seconds=60, observable_seconds=55, form_events=0, fatigue=8)


def test_checked_in_schema_matches_runtime():
    schema = json.loads((Path(__file__).resolve().parents[2] / "shared/session.schema.json").read_text(encoding="utf-8"))
    assert schema == SessionSummary.model_json_schema()


@pytest.mark.parametrize("change", [{"schema_version": "future-v2"}, {"discomfort": "false"}, {"persist": "false"}])
def test_invalid_contract_is_rejected(change):
    with TestClient(main.app) as client:
        assert client.post("/api/sessions/analyze", json={**BASE, **change}).status_code == 422


def test_failed_persistence_does_not_commit_analysis_or_decision(tmp_path, monkeypatch):
    storage = Storage(tmp_path / "history.sqlite")
    monkeypatch.setattr(main, "storage", storage)
    main.reports.clear()
    save = storage.save
    def fail(_):
        raise OSError("simulated disk unavailable")
    with TestClient(main.app, raise_server_exceptions=False) as client:
        monkeypatch.setattr(storage, "save", fail)
        assert client.post("/api/sessions/analyze", json={**BASE, "persist": True}).status_code == 500
        assert BASE["session_id"] not in main.reports
        monkeypatch.setattr(storage, "save", save)
        report = client.post("/api/sessions/analyze", json={**BASE, "persist": True}).json()
        decision = dict(input_version=1, proposal_id=report["proposal"]["proposal_id"])
        monkeypatch.setattr(storage, "save", fail)
        assert client.post("/api/sessions/transaction/accept", json=decision).status_code == 500
        assert main.reports["transaction"]["proposal"]["status"] == "pending"
        monkeypatch.setattr(storage, "save", save)
        assert client.post("/api/sessions/transaction/accept", json=decision).status_code == 200
        assert storage.list()[0]["proposal"]["status"] == "accepted"


def test_delete_removes_persistent_history_and_pending_authority(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "storage", Storage(tmp_path / "history.sqlite"))
    main.reports.clear()
    with TestClient(main.app) as client:
        report = client.post("/api/sessions/analyze", json={**BASE, "persist": True}).json()
        assert len(client.get("/api/history").json()) == 1
        assert client.delete("/api/history").status_code == 200
        assert client.get("/api/history").json() == []
        # Deleting the user history does not destroy the safety/version authority:
        # the report payload is gone, so later decisions/explanations are refused
        # as not recoverable instead of silently pretending the session never existed.
        deleted_decision = client.post(
            "/api/sessions/transaction/accept", json={"input_version": report["input_version"]}
        )
        assert deleted_decision.status_code == 409
        assert "deleted" in deleted_decision.text
        deleted_explanation = client.post("/api/sessions/transaction/explanation")
        assert deleted_explanation.status_code == 409
        assert "deleted" in deleted_explanation.text
