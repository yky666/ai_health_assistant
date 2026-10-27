from typing import Literal
from pydantic import BaseModel, Field, model_validator

from .catalog import EXERCISE_IDS
from .contract import CONTRACT


class Profile(BaseModel):
    weight_kg: float = Field(default=65, ge=30, le=250)
    height_cm: float = Field(default=170, ge=120, le=220)
    age_years: float = Field(default=22, ge=14, le=80)
    sex: Literal["female", "male", "unspecified"] = "unspecified"
    activity: Literal["sedentary", "light", "moderate", "active"] = "light"
    muscle_upper: float = Field(default=0.45, ge=0, le=1)
    muscle_core: float = Field(default=0.4, ge=0, le=1)
    muscle_lower: float = Field(default=0.45, ge=0, le=1)
    body_model: Literal["smpl", "smplx"] = "smpl"
    experience: Literal["beginner", "regular"] = "beginner"
    goal: Literal["habit", "fitness"] = "habit"


class SquatRep(BaseModel):
    number: int = Field(ge=1, le=10000)
    start_seconds: float = Field(ge=0, le=86400)
    bottom_seconds: float = Field(ge=0, le=86400)
    end_seconds: float = Field(ge=0, le=86400)
    descent_seconds: float = Field(ge=0, le=86400)
    ascent_seconds: float = Field(ge=0, le=86400)
    min_angle_degrees: float = Field(ge=0, le=180)
    rom: Literal["within_rule", "below_rule", "unobservable"]

    @model_validator(mode="after")
    def coherent_timing(self):
        if not self.start_seconds <= self.bottom_seconds <= self.end_seconds:
            raise ValueError("Rep timestamps must be ordered")
        if abs(self.descent_seconds - (self.bottom_seconds - self.start_seconds)) > 0.001 or abs(self.ascent_seconds - (self.end_seconds - self.bottom_seconds)) > 0.001:
            raise ValueError("Rep phase durations must match timestamps")
        return self


class SessionSummary(BaseModel):
    schema_version: Literal["localfit.session.v1"] = CONTRACT["schema_version"]
    session_id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    input_version: int = Field(default=1, ge=1)
    exercise: str = Field(min_length=2, max_length=40)
    source: Literal["simulation", "camera", "video"]
    reps: int = Field(ge=0, le=10000)
    active_seconds: float = Field(ge=0, le=86400)
    observable_seconds: float = Field(ge=0, le=86400)
    work_seconds: float | None = Field(default=None, ge=0, le=86400)
    rest_seconds: float | None = Field(default=None, ge=0, le=86400)
    form_events: int = Field(ge=0, le=10000)
    fatigue: int = Field(default=4, ge=0, le=10)
    discomfort: bool = Field(default=False, strict=True)
    target_reps: int = Field(default=12, ge=1, le=100)
    persist: bool = Field(default=False, strict=True)
    profile: Profile = Field(default_factory=Profile)
    rep_details: list[SquatRep] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def coherent_reps(self):
        if self.observable_seconds > self.active_seconds:
            raise ValueError("Observation cannot exceed active clock")
        if (self.work_seconds is None) != (self.rest_seconds is None):
            raise ValueError("Provide both work and rest durations")
        if self.work_seconds is not None and self.work_seconds + self.rest_seconds > self.observable_seconds + 0.001:
            raise ValueError("Classified durations cannot exceed observed duration")
        if self.exercise not in EXERCISE_IDS:
            raise ValueError("Unknown exercise")
        if self.rep_details and self.exercise != "squat":
            raise ValueError("Rep details currently support squat only")
        previous_end = -1.0
        previous_number = 0
        for rep in self.rep_details:
            if rep.number > self.reps or rep.number <= previous_number or rep.start_seconds < previous_end or rep.end_seconds > self.active_seconds + 0.001:
                raise ValueError("Rep details must be ordered, non-overlapping and within session")
            previous_end, previous_number = rep.end_seconds, rep.number
        return self


class AcceptProposal(BaseModel):
    input_version: int = Field(ge=1)
    proposal_id: str | None = Field(default=None, max_length=150)
    # Optional so old clients keep working; the server always re-checks the
    # authoritative latch/safety version in SQLite, it never trusts the client.
    expected_safety_version: int | None = Field(default=None, ge=0)


class SafetyEvent(BaseModel):
    """Client-reported safety event (currently only discomfort)."""

    event_id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_.:-]+$")
    type: Literal["discomfort"] = "discomfort"
    note: str | None = Field(default=None, max_length=200)


class SessionState(BaseModel):
    """Metadata-only view of an active session; never contains report payloads."""

    session_id: str
    status: Literal["active", "expired"]
    safety_latched: bool
    safety_version: int
    input_version: int | None = None
    proposal_id: str | None = None
    proposal_status: str | None = None
    decided_at: str | None = None
    persist_history: bool = False
    report_recoverable: bool = False
    expires_at: str


class FoodEntry(BaseModel):
    query: str = Field(default="", max_length=80)
    food_id: str = Field(default="", max_length=40)
    grams: float | None = Field(default=None, ge=1, le=3000)
    kcal_per_100g: float | None = Field(default=None, ge=0, le=900)

    @model_validator(mode="after")
    def has_identity(self):
        if not self.query and not self.food_id and self.kcal_per_100g is None:
            raise ValueError("Need query, food_id or custom kcal")
        return self
