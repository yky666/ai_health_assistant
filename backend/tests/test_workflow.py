from fastapi.testclient import TestClient
from app.main import app, reports
from app.schemas import SessionSummary
from app.agents import analyze

client = TestClient(app)


def payload(**updates):
    value = dict(session_id="test-session", exercise="squat", source="simulation", reps=8,
                 active_seconds=60, observable_seconds=55, form_events=0, fatigue=8)
    value.update(updates)
    return value


def test_fatigue_reduces_target_with_evidence():
    report = analyze(SessionSummary(**payload()))
    assert report["proposal"]["target_reps"] < 12
    assert report["proposal"]["rest_seconds"] == 90
    assert len(report["trace"]) == 4


def test_missing_evidence_does_not_adapt():
    report = analyze(SessionSummary(**payload(observable_seconds=10)))
    assert report["proposal"]["target_reps"] == 12


def test_discomfort_cannot_be_accepted():
    reports.clear()
    report = client.post("/api/sessions/analyze", json=payload(discomfort=True)).json()
    assert report["proposal"]["blocked"]
    assert client.post("/api/sessions/test-session/accept", json={"input_version": 1}).status_code == 409


def test_stale_write_and_accept_rejected():
    reports.clear()
    first = client.post("/api/sessions/analyze", json=payload())
    assert first.status_code == 200
    # Same input_version + same normalized input is an idempotent replay.
    replay = client.post("/api/sessions/analyze", json=payload())
    assert replay.status_code == 200
    assert replay.json()["proposal"]["proposal_id"] == first.json()["proposal"]["proposal_id"]
    # Same input_version with different content is a hard conflict.
    assert client.post("/api/sessions/analyze", json=payload(reps=5)).status_code == 409
    assert client.post("/api/sessions/test-session/accept", json={"input_version": 2}).status_code == 409


def test_invalid_observation_duration_rejected():
    assert client.post("/api/sessions/analyze", json=payload(observable_seconds=100)).status_code == 422


def test_no_persistence_without_consent(tmp_path, monkeypatch):
    from app import main
    from app.storage import Storage
    store = Storage(tmp_path / "test.sqlite")
    monkeypatch.setattr(main, "storage", store)
    reports.clear()
    client.post("/api/sessions/analyze", json=payload())
    # No user history is written without consent.
    assert store.list() == []
    # The minimum safety metadata exists so a restart cannot bypass a latch...
    state = store.read_session("test-session")
    assert state is not None
    # ...but it never contains the full report payload.
    assert state["report_json"] is None
    assert state["persist_history"] == 0


def test_video_source_and_body_profile_accepted():
    report = analyze(SessionSummary(**payload(
        source="video",
        profile={"weight_kg": 70, "height_cm": 180, "muscle_upper": 0.6, "body_model": "smplx"},
    )))
    assert report["source"] == "video"


def test_energy_scales_with_weight_and_duration():
    a = analyze(SessionSummary(**payload(profile={"weight_kg": 50},work_seconds=30,rest_seconds=20)))
    b = analyze(SessionSummary(**payload(profile={"weight_kg": 100},work_seconds=30,rest_seconds=20)))
    assert abs(b["energy"]["low_kcal"] - 2 * a["energy"]["low_kcal"]) <= 0.1
    assert a["energy"]["daily"]["need_kcal"] > 0
    assert b["energy"]["daily"]["need_kcal"] > a["energy"]["daily"]["need_kcal"]
    assert a["energy"]["net_low_kcal"] <= a["energy"]["low_kcal"]


def test_local_model_cannot_use_remote_endpoint(monkeypatch):
    import pytest
    from app.local_llm import local_endpoint
    monkeypatch.setenv("LOCAL_LLM_URL", "https://example.com")
    with pytest.raises(ValueError):
        local_endpoint()


def test_rep_detail_reaches_analysis_and_report():
    detail = dict(number=1, start_seconds=1, bottom_seconds=2, end_seconds=3,
                  descent_seconds=1, ascent_seconds=1, min_angle_degrees=120, rom="below_rule")
    report = analyze(SessionSummary(**payload(rep_details=[detail])))
    assert report["rep_details"] == [detail]
    assert report["trace"][0]["evidence"]["experimental_rom"]["below_rule"] == 1


def test_rep_details_reject_inconsistent_timing():
    detail = dict(number=1, start_seconds=1, bottom_seconds=2, end_seconds=3,
                  descent_seconds=8, ascent_seconds=1, min_angle_degrees=120, rom="below_rule")
    assert client.post("/api/sessions/analyze",json=payload(rep_details=[detail])).status_code == 422


def test_food_query_matches_alias():
    report = client.post("/api/nutrition/estimate", json=[{"query": "米饭150克"}]).json()
    assert report["items"][0]["matched"]
    assert report["total_kcal"] > 100


def test_unknown_exercise_rejected():
    assert client.post("/api/sessions/analyze", json=payload(exercise="not_an_exercise")).status_code == 422


def test_rep_details_reject_wrong_exercise_or_out_of_session():
    detail = dict(number=1, start_seconds=1, bottom_seconds=2, end_seconds=3,
                  descent_seconds=1, ascent_seconds=1, min_angle_degrees=120, rom="unobservable")
    assert client.post("/api/sessions/analyze",json=payload(exercise="jumping_jack",rep_details=[detail])).status_code == 422
    assert client.post("/api/sessions/analyze",json=payload(active_seconds=2,observable_seconds=2,rep_details=[detail])).status_code == 422


def test_final_decisions_are_idempotent_and_immutable():
    reports.clear()
    report = client.post("/api/sessions/analyze",json=payload()).json()
    decision = {"input_version":1,"proposal_id":report["proposal"]["proposal_id"]}
    first=client.post("/api/sessions/test-session/reject",json=decision)
    assert first.status_code == 200
    assert first.json()["proposal"]["status"] == "rejected"
    assert first.json()["proposal"]["decided_at"]
    assert client.post("/api/sessions/test-session/reject",json=decision).json() == first.json()
    assert client.post("/api/sessions/test-session/accept",json=decision).status_code == 409


def test_wrong_proposal_identity_and_classification_rejected():
    reports.clear()
    client.post("/api/sessions/analyze",json=payload())
    assert client.post("/api/sessions/test-session/accept",json={"input_version":1,"proposal_id":"other"}).status_code == 409
    assert client.post("/api/sessions/analyze",json=payload(work_seconds=60,rest_seconds=0)).status_code == 422
    assert client.post("/api/sessions/analyze",json=payload(work_seconds=5)).status_code == 422
