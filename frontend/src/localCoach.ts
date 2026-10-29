import type { Exercise } from './catalog';
import { isExercise } from './catalog';
import { dailyRequirement, sessionEnergy, type ActivityLevel, type Sex } from './energy';
import { estimateFoods } from './foods';
import type { Report, SquatRep } from './types';
import contract from '../../shared/contract.json';
const policy = contract.policy;

export type LocalSummary = {
  schema_version?: string;
  session_id: string;
  input_version: number;
  exercise: Exercise;
  source: 'simulation' | 'camera' | 'video';
  reps: number;
  active_seconds: number;
  observable_seconds: number;
  work_seconds?: number;
  rest_seconds?: number;
  form_events: number;
  fatigue: number;
  discomfort: boolean;
  target_reps: number;
  persist?: boolean;
  profile: {
    weight_kg: number;
    height_cm?: number;
    age_years?: number;
    sex?: Sex;
    activity?: ActivityLevel;
    experience?: string;
    goal?: string;
  };
  rep_details?: SquatRep[];
};

const HISTORY_KEY = 'localfit-browser-history';
/** Keep browser history aligned with the backend's existing 50-row limit. */
export const HISTORY_LIMIT = 50;
let lastReport: Report | null = null;
const reports = new Map<string, Report>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isFiniteInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value);
}

function isTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const match = value.match(
    /^(\\d{4})-(\\d{2})-(\\d{2})T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$/,
  );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day
  );
}

function isSquatRep(value: unknown): value is SquatRep {
  if (!isRecord(value)) return false;
  return (
    isFiniteInteger(value.number) &&
    value.number >= 1 &&
    isFiniteNonNegative(value.start_seconds) &&
    isFiniteNonNegative(value.bottom_seconds) &&
    isFiniteNonNegative(value.end_seconds) &&
    isFiniteNonNegative(value.descent_seconds) &&
    isFiniteNonNegative(value.ascent_seconds) &&
    isFiniteNumber(value.min_angle_degrees) &&
    value.min_angle_degrees >= 0 &&
    value.min_angle_degrees <= 180 &&
    value.start_seconds <= value.bottom_seconds &&
    value.bottom_seconds <= value.end_seconds &&
    Math.abs(value.descent_seconds - (value.bottom_seconds - value.start_seconds)) <= 0.001 &&
    Math.abs(value.ascent_seconds - (value.end_seconds - value.bottom_seconds)) <= 0.001 &&
    (value.rom === 'within_rule' || value.rom === 'below_rule' || value.rom === 'unobservable')
  );
}

function isSquatRepSequence(
  value: unknown,
  maxReps?: number,
  maxEndSeconds?: number,
): value is SquatRep[] {
  if (!Array.isArray(value) || value.length > 100 || !value.every(isSquatRep)) return false;
  let previousEnd = -1;
  let previousNumber = 0;
  for (const rep of value) {
    if (
      rep.number <= previousNumber ||
      (maxReps !== undefined && rep.number > maxReps) ||
      (maxEndSeconds !== undefined && rep.end_seconds > maxEndSeconds + 0.001) ||
      rep.start_seconds < previousEnd
    )
      return false;
    previousEnd = rep.end_seconds;
    previousNumber = rep.number;
  }
  return true;
}

function isTraceEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.role) &&
    isNonEmptyString(value.runtime) &&
    isNonEmptyString(value.decision) &&
    isRecord(value.evidence) &&
    isNonEmptyString(value.timestamp) &&
    (value.pre_latch === undefined || typeof value.pre_latch === 'boolean') &&
    (value.historical === undefined || typeof value.historical === 'boolean')
  );
}

function isProposal(value: unknown, safetyLatched: unknown): boolean {
  if (!isRecord(value)) return false;
  const status = value.status;
  if (
    status !== 'pending' &&
    status !== 'blocked' &&
    status !== 'accepted' &&
    status !== 'rejected'
  )
    return false;
  if (typeof value.blocked !== 'boolean') return false;
  if (status === 'blocked' && value.blocked !== true) return false;
  if (status === 'pending' && value.blocked !== false) return false;
  if (safetyLatched === true && value.blocked !== true) return false;

  const decidedAt = value.decided_at;
  if (status === 'pending' || status === 'blocked') {
    if (decidedAt !== undefined && decidedAt !== null) return false;
  } else {
    // A missing timestamp is tolerated for legacy decided records; a present
    // timestamp must be a real ISO timestamp, and null is not a decision time.
    if (decidedAt !== undefined && !isTimestamp(decidedAt)) return false;
    // Only an authoritative latched safety view may block a prior decision.
    if (value.blocked && safetyLatched !== true) return false;
  }

  return (
    isFiniteInteger(value.target_reps) &&
    value.target_reps >= 1 &&
    value.target_reps <= 100 &&
    isFiniteNonNegative(value.rest_seconds) &&
    isNonEmptyString(value.reason) &&
    (value.proposal_id === undefined || isNonEmptyString(value.proposal_id))
  );
}

function isEnergy(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !isFiniteNonNegative(value.low_kcal) ||
    !isFiniteNonNegative(value.high_kcal) ||
    value.low_kcal > value.high_kcal ||
    !isNonEmptyString(value.note)
  )
    return false;
  for (const key of ['work_seconds', 'rest_seconds', 'unknown_seconds'] as const) {
    if (value[key] !== undefined && !isFiniteNonNegative(value[key])) return false;
  }
  const netLow = value.net_low_kcal;
  const netHigh = value.net_high_kcal;
  if (netLow !== undefined && !isFiniteNonNegative(netLow)) return false;
  if (netHigh !== undefined && !isFiniteNonNegative(netHigh)) return false;
  if (netLow !== undefined && netHigh !== undefined && netLow > netHigh) return false;
  if (value.available !== undefined && typeof value.available !== 'boolean') return false;
  if (value.daily !== undefined) {
    if (
      !isRecord(value.daily) ||
      !isFiniteNonNegative(value.daily.bmr_kcal) ||
      !isFiniteNonNegative(value.daily.tdee_kcal) ||
      !isFiniteNonNegative(value.daily.need_kcal) ||
      !isNonEmptyString(value.daily.note)
    )
      return false;
  }
  return true;
}

/**
 * Resolve the report's final total reps. Top-level `reps` is the authoritative
 * final count when present. For legacy records without it, the last
 * `training_analyst` trace entry is the final analysis snapshot; earlier trace
 * entries may be intermediate and are deliberately not compared. When both
 * sources exist they must agree.
 */
function historyFinalReps(
  value: Record<string, unknown>,
  trace: unknown[],
): { present: boolean; value?: number; invalid: boolean } {
  let topLevel: number | undefined;
  if (value.reps !== undefined) {
    if (!isFiniteInteger(value.reps) || value.reps < 0) return { present: true, invalid: true };
    topLevel = value.reps;
  }

  let finalTraceEntry: Record<string, unknown> | undefined;
  for (const entry of trace) {
    if (isRecord(entry) && entry.role === 'training_analyst') finalTraceEntry = entry;
  }
  let traceValue: number | undefined;
  let tracePresent = false;
  if (finalTraceEntry && isRecord(finalTraceEntry.evidence)) {
    const evidence = finalTraceEntry.evidence;
    if (Object.prototype.hasOwnProperty.call(evidence, 'reps')) {
      tracePresent = true;
      if (!isFiniteInteger(evidence.reps) || evidence.reps < 0)
        return { present: true, invalid: true };
      traceValue = evidence.reps;
    }
  }

  if (topLevel !== undefined && tracePresent && topLevel !== traceValue) {
    return { present: true, invalid: true };
  }
  const finalValue = topLevel ?? traceValue;
  return { present: finalValue !== undefined, value: finalValue, invalid: false };
}

/** Use a report's own trace/reps fields when present; older records may omit them. */
function historySquatLimits(
  value: Record<string, unknown>,
  trace: unknown[],
): { maxReps?: number; maxEndSeconds?: number } | null {
  const finalReps = historyFinalReps(value, trace);
  if (finalReps.invalid) return null;
  const maxReps = finalReps.value;

  let activeSeconds: number | undefined;
  if (value.active_seconds !== undefined) {
    if (!isFiniteNonNegative(value.active_seconds)) return null;
    activeSeconds = value.active_seconds;
  }

  let energyDuration: number | undefined;
  if (isRecord(value.energy)) {
    const work = value.energy.work_seconds;
    const rest = value.energy.rest_seconds;
    const unknown = value.energy.unknown_seconds;
    if (work !== undefined && rest !== undefined && unknown !== undefined) {
      if (
        !isFiniteNonNegative(work) ||
        !isFiniteNonNegative(rest) ||
        !isFiniteNonNegative(unknown)
      )
        return null;
      energyDuration = work + rest + unknown;
    }
  }

  // Classified + unknown duration is rounded to tenths in reports. If both
  // clocks exist, they must describe the same session within rounding error.
  if (
    activeSeconds !== undefined &&
    energyDuration !== undefined &&
    Math.abs(activeSeconds - energyDuration) > 0.2
  )
    return null;

  const maxEndSeconds =
    activeSeconds !== undefined
      ? activeSeconds
      : energyDuration !== undefined
        ? energyDuration + 0.2
        : undefined;

  return { maxReps, maxEndSeconds };
}

/**
 * Validate the complete report shape used by browser history. `schema_version`
 * and `policy_version` stay optional for legacy browser reports; when present
 * they must still be strings. This intentionally does not reject older records
 * merely because a newer contract version exists.
 */
function isStoredReport(value: unknown): value is Report {
  if (!isRecord(value)) return false;
  if (
    value.schema_version !== undefined &&
    !isNonEmptyString(value.schema_version)
  )
    return false;
  if (value.policy_version !== undefined && !isNonEmptyString(value.policy_version)) return false;
  if (
    !isNonEmptyString(value.session_id) ||
    !isFiniteInteger(value.input_version) ||
    value.input_version < 1 ||
    (value.source !== 'simulation' && value.source !== 'camera' && value.source !== 'video') ||
    !isFiniteNumber(value.coverage) ||
    value.coverage < 0 ||
    value.coverage > 1 ||
    !isFiniteNumber(value.completion) ||
    value.completion < 0 ||
    value.completion > 1 ||
    typeof value.saved !== 'boolean' ||
    !isEnergy(value.energy) ||
    !isProposal(value.proposal, value.safety_latched)
  )
    return false;

  const trace = value.trace;
  const legacyWithoutVersionMetadata =
    value.schema_version === undefined && value.policy_version === undefined;
  if (
    !Array.isArray(trace) ||
    (trace.length === 0 && !legacyWithoutVersionMetadata) ||
    !trace.every(isTraceEntry)
  )
    return false;

  const limits = historySquatLimits(value, trace);
  if (!limits || !Array.isArray(value.rep_details)) return false;
  // Without a total count source, non-empty rep details cannot be cross-checked.
  if (limits.maxReps === undefined && value.rep_details.length > 0) return false;
  if (!isSquatRepSequence(value.rep_details, limits.maxReps, limits.maxEndSeconds)) return false;

  if (value.safety_latched !== undefined && typeof value.safety_latched !== 'boolean') return false;
  if (
    value.safety_version !== undefined &&
    (!isFiniteInteger(value.safety_version) || value.safety_version < 0)
  )
    return false;
  if (
    value.safety_latched !== undefined &&
    value.safety_version !== undefined &&
    value.safety_latched !== (value.safety_version > 0)
  )
    return false;
  return true;
}

function ensureNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('本地提交已因安全阻断取消。', 'AbortError');
  }
}

export function reportFor(sessionId: string): Report {
  const report = reports.get(sessionId);
  if (!report) throw new Error('当前会话不存在或已清除，请重新训练。');
  return structuredClone(report);
}

export function analyzeLocal(summary: LocalSummary, signal?: AbortSignal): Report {
  ensureNotAborted(signal);
  if (summary.schema_version !== undefined && summary.schema_version !== contract.schema_version)
    throw new Error('不支持的数据合同版本。');
  if (
    typeof summary.discomfort !== 'boolean' ||
    (summary.persist !== undefined && typeof summary.persist !== 'boolean') ||
    (summary.profile.goal !== undefined && !['habit', 'fitness'].includes(summary.profile.goal)) ||
    (summary.profile.experience !== undefined &&
      !['beginner', 'regular'].includes(summary.profile.experience))
  )
    throw new Error('布尔值或用户目标参数无效。');
  if (
    !isExercise(summary.exercise) ||
    !['simulation', 'camera', 'video'].includes(summary.source) ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(summary.session_id)
  )
    throw new Error('动作、来源或会话标识无效。');
  const previous = reports.get(summary.session_id);
  if (previous && summary.input_version <= previous.input_version)
    throw new Error('拒绝过期或重复的摘要版本。');
  for (const [value, min, max] of [
    [summary.profile.height_cm, 120, 220],
    [summary.profile.age_years, 14, 80],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max))
      throw new Error('身高或年龄无效。');
  }
  if (
    summary.profile.sex !== undefined &&
    !['female', 'male', 'unspecified'].includes(summary.profile.sex)
  )
    throw new Error('公式参数无效。');
  if (
    summary.profile.activity !== undefined &&
    !['sedentary', 'light', 'moderate', 'active'].includes(summary.profile.activity)
  )
    throw new Error('活动参数无效。');
  if (
    !Number.isFinite(summary.active_seconds) ||
    summary.active_seconds < 0 ||
    summary.active_seconds > 86400 ||
    !Number.isFinite(summary.observable_seconds) ||
    summary.observable_seconds < 0 ||
    summary.observable_seconds > summary.active_seconds ||
    !Number.isInteger(summary.input_version) ||
    summary.input_version < 1 ||
    !Number.isInteger(summary.target_reps) ||
    summary.target_reps < 1 ||
    summary.target_reps > 100 ||
    !Number.isFinite(summary.profile.weight_kg) ||
    summary.profile.weight_kg < 30 ||
    summary.profile.weight_kg > 250 ||
    !Number.isInteger(summary.reps) ||
    summary.reps < 0 ||
    summary.reps > 10000 ||
    !Number.isInteger(summary.form_events) ||
    summary.form_events < 0 ||
    summary.form_events > 10000 ||
    !Number.isInteger(summary.fatigue) ||
    summary.fatigue < 0 ||
    summary.fatigue > 10
  )
    throw new Error('训练摘要参数无效。');
  const coverage = Math.min(1, summary.observable_seconds / Math.max(summary.active_seconds, 1));
  const completion = Math.min(1, summary.reps / summary.target_reps);
  const details = summary.rep_details ?? [];
  if (details.length > 100 || (details.length > 0 && summary.exercise !== 'squat'))
    throw new Error('单次记录当前只支持深蹲，最多 100 条。');
  if (!isSquatRepSequence(details, summary.reps, summary.active_seconds))
    throw new Error('单次记录时序或幅度无效。');
  const rom_counts = {
    within_rule: details.filter((r) => r.rom === 'within_rule').length,
    below_rule: details.filter((r) => r.rom === 'below_rule').length,
    unobservable: details.filter((r) => r.rom === 'unobservable').length,
  };
  const blocked = summary.discomfort;
  const lowEvidence =
    coverage < policy.minimum_coverage || summary.active_seconds < policy.minimum_seconds;
  let target = summary.target_reps;
  let rest = policy.baseline_rest_seconds;
  let reason = '本次记录暂不支持增加训练量，保持计划并继续观察。';
  if (blocked) reason = '用户报告不适：暂停训练，取消继续训练建议。';
  else if (lowEvidence) reason = '有效观察不足：保持计划，先调整机位或补充训练记录。';
  else if (summary.fatigue >= policy.high_fatigue || completion < policy.minimum_completion) {
    target = Math.max(1, Math.round(target * policy.reduction_factor));
    rest = policy.reduced_rest_seconds;
    reason = '主观疲劳较高或完成度不足，建议减少下一组目标并延长休息。';
  } else if (
    summary.form_events > policy.deviation_limit ||
    rom_counts.below_rule > policy.deviation_limit
  ) {
    rest = policy.deviation_rest_seconds;
    reason = '出现多次可观察偏差或未达到实验幅度，保持次数，增加休息并复核动作。';
  }
  const energy = {
    ...sessionEnergy({
      exercise: summary.exercise,
      weightKg: summary.profile.weight_kg,
      activeSeconds: summary.active_seconds,
      observableSeconds: summary.observable_seconds,
      reps: summary.reps,
      repDetails: details,
      workSeconds: summary.work_seconds,
      restSeconds: summary.rest_seconds,
    }),
    daily: dailyRequirement({
      weightKg: summary.profile.weight_kg,
      heightCm: summary.profile.height_cm ?? 170,
      ageYears: summary.profile.age_years ?? 22,
      sex: summary.profile.sex ?? 'unspecified',
      activity: summary.profile.activity ?? 'light',
      goal: summary.profile.goal,
    }),
  };
  const now = new Date().toISOString();
  const report: Report = {
    schema_version: contract.schema_version,
    policy_version: contract.policy_version,
    session_id: summary.session_id,
    input_version: summary.input_version,
    source: summary.source,
    coverage: Math.round(coverage * 1000) / 1000,
    completion: Math.round(completion * 1000) / 1000,
    saved: Boolean(summary.persist),
    rep_details: details,
    energy,
    proposal: {
      target_reps: target,
      rest_seconds: rest,
      reason,
      blocked,
      status: blocked ? 'blocked' : 'pending',
      proposal_id: `${summary.session_id}:${summary.input_version}`,
      decided_at: null,
    },
    trace: [
      {
        role: 'training_analyst',
        runtime: 'browser',
        decision: '汇总动作证据；识别覆盖率不足时不判断动作质量。',
        evidence: { reps: summary.reps, completion, coverage, experimental_rom: rom_counts },
        timestamp: now,
      },
      {
        role: 'plan_adapter',
        runtime: 'browser',
        decision: reason,
        evidence: { fatigue: summary.fatigue, discomfort: blocked, low_evidence: lowEvidence },
        timestamp: now,
      },
      {
        role: 'safety_gate',
        runtime: 'browser',
        decision: blocked ? '阻止继续训练。' : '候选计划通过预设规则，等待用户确认。',
        evidence: { blocked, target_reps: target, rest_seconds: rest },
        timestamp: now,
      },
      {
        role: 'reporter',
        runtime: 'browser',
        decision: '生成可追踪摘要，不推断医疗状态。',
        evidence: { source: summary.source, energy },
        timestamp: now,
      },
    ],
  };
  // Prepare both owned copies before persistence; a failed write must not commit or evict.
  const committed = structuredClone(report);
  const result = structuredClone(report);
  ensureNotAborted(signal);
  if (summary.persist) saveHistory(committed);
  lastReport = committed;
  reports.set(summary.session_id, committed);
  if (reports.size > 100) reports.delete(reports.keys().next().value!);
  return result;
}

export function latestReport() {
  return lastReport ? structuredClone(lastReport) : null;
}

export function decideLocal(
  report: Report,
  decision: 'accepted' | 'rejected',
  signal?: AbortSignal,
): Report {
  ensureNotAborted(signal);
  const current = reportFor(report.session_id);
  if (
    current.input_version !== report.input_version ||
    current.proposal.proposal_id !== report.proposal.proposal_id
  )
    throw new Error('提案已过期，请查看当前版本。');
  if (current.proposal.blocked) throw new Error('不适报告已阻止继续训练。');
  if (current.proposal.status === decision) return current;
  if (current.proposal.status !== 'pending') throw new Error('已作出的决定不能被覆盖。');
  const next = {
    ...current,
    proposal: { ...current.proposal, status: decision, decided_at: new Date().toISOString() },
  };
  const committed = structuredClone(next);
  const result = structuredClone(next);
  ensureNotAborted(signal);
  if (current.saved) saveHistory(committed);
  reports.set(next.session_id, committed);
  lastReport = committed;
  return result;
}

export const acceptLocal = (report: Report, signal?: AbortSignal) =>
  decideLocal(report, 'accepted', signal);

export function estimateFood(
  query: string,
  grams?: number,
  extra?: { food_id?: string; kcal_per_100g?: number },
) {
  return estimateFoods([
    { query, food_id: extra?.food_id, grams, kcal_per_100g: extra?.kcal_per_100g },
  ]);
}

export function loadHistory(): Report[] {
  let stored: string | null;
  try {
    stored = sessionStorage.getItem(HISTORY_KEY);
  } catch {
    throw new Error('读取本地历史记录失败，未覆盖已有历史。');
  }
  if (stored === null) return [];
  let items: unknown;
  try {
    items = JSON.parse(stored);
  } catch {
    throw new Error('解析本地历史记录失败，未覆盖已有历史。');
  }
  if (!Array.isArray(items) || !items.every(isStoredReport))
    throw new Error('本地历史记录格式无效，未覆盖已有历史。');
  return (items as Report[]).slice(0, HISTORY_LIMIT);
}

export function clearHistory() {
  // Delete persisted history first: a failed storage delete must propagate to the caller
  // with memory untouched, so a failed clear never leaves the two layers out of sync.
  sessionStorage.removeItem(HISTORY_KEY);
  reports.clear();
  lastReport = null;
}

function saveHistory(report: Report) {
  const items = loadHistory().filter((item) => item.session_id !== report.session_id);
  items.unshift(report);
  sessionStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_LIMIT)));
}
