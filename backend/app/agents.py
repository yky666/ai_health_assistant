"""Typed, deterministic agent workflow baseline. No external model is required."""
from datetime import datetime, timezone
from .energy import daily_requirement, session_energy
from .schemas import SessionSummary
from .contract import CONTRACT, POLICY


def analyze(summary: SessionSummary, *, safety_latched: bool = False) -> dict:
    """Build the deterministic report.

    ``safety_latched`` is the authoritative latched state read from SQLite by the
    API layer.  It is combined with the legacy ``discomfort`` field so a report
    generated after a latch is never executable and the ``safety_gate`` trace
    reflects the real safety decision instead of only the request field.
    """
    trace = []

    def record(role: str, evidence: dict, decision: str):
        trace.append({"role": role, "runtime": "deterministic", "status": "completed",
                      "session_id": summary.session_id, "input_version": summary.input_version,
                      "timestamp": datetime.now(timezone.utc).isoformat(),
                      "evidence": evidence, "decision": decision})

    coverage = min(1, summary.observable_seconds / max(summary.active_seconds, 1))
    completion = min(1, summary.reps / summary.target_reps)
    rom_counts = {status: sum(rep.rom == status for rep in summary.rep_details)
                  for status in ("within_rule", "below_rule", "unobservable")}
    record("training_analyst", {"reps": summary.reps, "completion": round(completion, 3),
                               "coverage": round(coverage, 3), "form_events": summary.form_events,
                               "experimental_rom": rom_counts, "recorded_reps": len(summary.rep_details)},
           "汇总动作证据；识别覆盖率不足时不判断动作质量。")

    blocked = summary.discomfort or safety_latched
    low_evidence = coverage < POLICY["minimum_coverage"] or summary.active_seconds < POLICY["minimum_seconds"]
    target = summary.target_reps
    rest = POLICY["baseline_rest_seconds"]
    if blocked:
        reason = ("用户报告不适：暂停训练，取消继续训练建议。" if summary.discomfort
                  else "服务端已记录不适事件：会话已锁存，禁止继续训练。")
    elif low_evidence:
        reason = "有效观察不足：保持计划，先调整机位或补充训练记录。"
    elif summary.fatigue >= POLICY["high_fatigue"] or completion < POLICY["minimum_completion"]:
        target = max(1, int(target * POLICY["reduction_factor"] + 0.5))
        rest = POLICY["reduced_rest_seconds"]
        reason = "主观疲劳较高或完成度不足，建议减少下一组目标并延长休息。"
    elif summary.form_events > POLICY["deviation_limit"] or rom_counts["below_rule"] > POLICY["deviation_limit"]:
        rest = POLICY["deviation_rest_seconds"]
        reason = "出现多次可观察偏差或未达到实验幅度，保持次数，增加休息并复核动作。"
    else:
        reason = "本次记录暂不支持增加训练量，保持计划并继续观察。"
    record("plan_adapter", {"fatigue": summary.fatigue, "discomfort": blocked,
                            "safety_latched": safety_latched,
                            "low_evidence": low_evidence}, reason)
    record("safety_gate", {"blocked": blocked, "target_reps": target, "rest_seconds": rest,
                           "safety_latched": safety_latched},
           "阻止继续训练。" if blocked else "候选计划通过预设规则，等待用户确认。")

    energy = {
        **session_energy(summary.exercise, summary.profile.weight_kg, summary.active_seconds,
                         summary.observable_seconds, summary.rep_details, summary.reps,
                         summary.work_seconds, summary.rest_seconds),
        "daily": daily_requirement(summary.profile),
    }
    record("reporter", {"source": summary.source, "energy": energy}, "生成可追踪摘要，不推断医疗状态。")
    return {"schema_version": CONTRACT["schema_version"], "policy_version": CONTRACT["policy_version"],
            "session_id": summary.session_id, "input_version": summary.input_version,
            "source": summary.source, "coverage": round(coverage, 3), "completion": round(completion, 3),
            "rep_details": [rep.model_dump() for rep in summary.rep_details],
            "energy": energy, "proposal": {"target_reps": target, "rest_seconds": rest,
            "reason": reason, "blocked": blocked, "status": "blocked" if blocked else "pending",
            "proposal_id": f"{summary.session_id}:{summary.input_version}", "decided_at": None},
            "trace": trace, "saved": summary.persist}
