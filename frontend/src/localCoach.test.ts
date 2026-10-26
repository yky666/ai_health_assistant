import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptLocal,
  analyzeLocal,
  clearHistory,
  decideLocal,
  latestReport,
  loadHistory,
  reportFor,
  HISTORY_LIMIT,
  type LocalSummary,
} from './localCoach';
import planCases from '../../shared/plan_cases.json';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  });
  clearHistory();
});
const base: LocalSummary = {
  session_id: 'versioned',
  input_version: 1,
  exercise: 'squat',
  source: 'simulation',
  reps: 8,
  active_seconds: 60,
  observable_seconds: 55,
  work_seconds: 30,
  rest_seconds: 20,
  form_events: 0,
  fatigue: 8,
  discomfort: false,
  target_reps: 12,
  profile: { weight_kg: 65 },
};

describe('browser coach fallback', () => {
  it.each(planCases)('shared decision contract: $name', (entry) => {
    const result = analyzeLocal({
      ...base,
      work_seconds: undefined,
      rest_seconds: undefined,
      ...(entry.input as Partial<LocalSummary>),
    });
    expect(result.proposal).toMatchObject(entry.expected);
  });
  it('rejects stale analysis and stale decisions', () => {
    const old = analyzeLocal(base);
    expect(() => analyzeLocal(base)).toThrow();
    analyzeLocal({ ...base, input_version: 2 });
    expect(() => acceptLocal(old)).toThrow();
  });
  it('decision is idempotent and cannot be reversed', () => {
    const report = analyzeLocal(base);
    const first = acceptLocal(report);
    expect(acceptLocal(report)).toEqual(first);
    expect(() => decideLocal(report, 'rejected')).toThrow();
    expect(first.proposal.decided_at).toBeTruthy();
  });
  it('reject preserves proposal without enabling later acceptance', () => {
    const report = analyzeLocal(base);
    expect(decideLocal(report, 'rejected').proposal.status).toBe('rejected');
    expect(() => acceptLocal(report)).toThrow();
  });
  it('ignores mutated client fields and protects canonical state', () => {
    const report = analyzeLocal(base);
    report.proposal.target_reps = 100;
    expect(acceptLocal(report).proposal.target_reps).toBe(10);
    expect(latestReport()!.proposal.target_reps).toBe(10);
  });
  it('deleting history also removes the current report and pending decisions', () => {
    const report = analyzeLocal({ ...base, persist: true });
    expect(loadHistory()).toHaveLength(1);
    clearHistory();
    expect(loadHistory()).toEqual([]);
    expect(latestReport()).toBeNull();
    expect(() => reportFor(report.session_id)).toThrow();
    expect(() => acceptLocal(report)).toThrow();
  });
  it('keeps browser history aligned with the backend 50-record limit', () => {
    for (let index = 1; index <= HISTORY_LIMIT + 1; index += 1) {
      analyzeLocal({
        ...base,
        session_id: `capacity-${index}`,
        input_version: 1,
        persist: true,
      });
    }
    const history = loadHistory();
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0].session_id).toBe(`capacity-${HISTORY_LIMIT + 1}`);
    expect(history[history.length - 1].session_id).toBe('capacity-2');
  });
  it('distinguishes missing browser history from intentionally empty history', () => {
    expect(loadHistory()).toEqual([]);
    sessionStorage.setItem('localfit-browser-history', '[]');
    expect(loadHistory()).toEqual([]);
    sessionStorage.setItem('localfit-browser-history', 'not-json');
    expect(() => loadHistory()).toThrow('解析本地历史记录失败');
  });
  it('does not persist without consent and rejects impossible classified time', () => {
    analyzeLocal(base);
    expect(loadHistory()).toEqual([]);
    expect(() =>
      analyzeLocal({ ...base, input_version: 2, work_seconds: 60, rest_seconds: 0 }),
    ).toThrow();
  });
  it('does not commit an analyze result after the local safety signal aborts', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => analyzeLocal({ ...base, persist: true }, controller.signal)).toThrow(/取消/);
    expect(loadHistory()).toEqual([]);
    expect(latestReport()).toBeNull();
  });
  it('does not commit a proposal decision after the local safety signal aborts', () => {
    const report = analyzeLocal({ ...base, persist: true });
    const controller = new AbortController();
    controller.abort();
    expect(() => decideLocal(report, 'accepted', controller.signal)).toThrow(/取消/);
    expect(latestReport()?.proposal.status).toBe('pending');
    expect(loadHistory()[0].proposal.status).toBe('pending');
  });
  it('reduces the next target when fatigue is high and evidence is enough', () => {
    const report = analyzeLocal({
      session_id: 'browser-1',
      input_version: 1,
      exercise: 'squat',
      source: 'video',
      reps: 8,
      active_seconds: 60,
      observable_seconds: 55,
      form_events: 0,
      fatigue: 8,
      discomfort: false,
      target_reps: 12,
      profile: { weight_kg: 65, height_cm: 170 },
    });
    expect(report.proposal.target_reps).toBeLessThan(12);
    expect(report.source).toBe('video');
    expect(report.trace).toHaveLength(4);
  });

  it('blocks acceptance after a discomfort report', () => {
    const report = analyzeLocal({
      session_id: 'browser-2',
      input_version: 1,
      exercise: 'jumping_jack',
      source: 'camera',
      reps: 4,
      active_seconds: 20,
      observable_seconds: 18,
      form_events: 0,
      fatigue: 3,
      discomfort: true,
      target_reps: 12,
      profile: { weight_kg: 65 },
    });
    expect(report.proposal.blocked).toBe(true);
    expect(() => acceptLocal(report)).toThrow();
  });
  it('failed requested storage leaves no committed version, and can retry', () => {
    const setItem = vi.spyOn(sessionStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota');
    });
    expect(() => analyzeLocal({ ...base, persist: true })).toThrow('quota');
    expect(() => reportFor(base.session_id)).toThrow();
    expect(analyzeLocal({ ...base, persist: true }).input_version).toBe(1);
    setItem.mockRestore();
  });
  it('failed decision save remains pending and can retry', () => {
    const report = analyzeLocal({ ...base, persist: true });
    vi.spyOn(sessionStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota');
    });
    expect(() => acceptLocal(report)).toThrow('quota');
    expect(reportFor(base.session_id).proposal.status).toBe('pending');
    expect(acceptLocal(report).proposal.status).toBe('accepted');
  });
  it.each([
    { schema_version: 'future-v2' },
    { discomfort: 'false' },
    { persist: 'false' },
    { profile: { weight_kg: 65, goal: 'unsupported' } },
  ])('rejects invalid contract fields: %j', (change) => {
    expect(() => analyzeLocal({ ...base, ...change } as LocalSummary)).toThrow();
  });
});

const historyKey = 'localfit-browser-history';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('local persistence commits', () => {
  it('does not publish an unsafely unblocked report when the first history write fails', () => {
    const write = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(() => analyzeLocal({ ...base, persist: true })).toThrow('quota exceeded');
    expect(write).toHaveBeenCalledOnce();
    expect(latestReport()).toBeNull();
    expect(() => reportFor(base.session_id)).toThrow('不存在');
    expect(sessionStorage.getItem(historyKey)).toBeNull();
    expect(loadHistory()).toEqual([]);
    write.mockRestore();
    expect(analyzeLocal({ ...base, persist: true }).input_version).toBe(1);
    expect(loadHistory()[0]).toEqual(reportFor(base.session_id));
  });

  it('keeps the prior report and history when an analysis update cannot be persisted', () => {
    const old = analyzeLocal({ ...base, persist: true });
    const stored = sessionStorage.getItem(historyKey);
    const write = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('write denied');
    });
    expect(() => analyzeLocal({ ...base, input_version: 2, persist: true })).toThrow(
      'write denied',
    );
    expect(reportFor(base.session_id)).toEqual(old);
    expect(latestReport()).toEqual(old);
    expect(sessionStorage.getItem(historyKey)).toBe(stored);
    expect(loadHistory()).toEqual([old]);
    write.mockRestore();
    expect(analyzeLocal({ ...base, input_version: 2, persist: true }).input_version).toBe(2);
    expect(loadHistory()).toEqual([reportFor(base.session_id)]);
  });

  it('does not evict any of the 100 in-memory sessions before a failed persisted insert', () => {
    const old = Array.from({ length: 100 }, (_, i) =>
      analyzeLocal({ ...base, session_id: `retained-${i}` }),
    );
    const latest = latestReport();
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('write denied');
    });
    expect(() => analyzeLocal({ ...base, session_id: 'failed-insert', persist: true })).toThrow(
      'write denied',
    );
    expect(latestReport()).toEqual(latest);
    for (const report of old) expect(reportFor(report.session_id)).toEqual(report);
    expect(() => reportFor('failed-insert')).toThrow('不存在');
    expect(loadHistory()).toEqual([]);
  });

  it.each(['accepted', 'rejected'] as const)(
    'keeps canonical, latest and saved proposals unchanged when %s cannot be persisted',
    (decision) => {
      const report = analyzeLocal({ ...base, persist: true });
      const latest = analyzeLocal({ ...base, session_id: 'latest-other', persist: true });
      const stored = sessionStorage.getItem(historyKey);
      const write = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
        throw new Error('decision write denied');
      });
      expect(() => decideLocal(report, decision)).toThrow('decision write denied');
      expect(reportFor(report.session_id)).toEqual(report);
      expect(reportFor(report.session_id).proposal).toMatchObject({
        status: 'pending',
        decided_at: null,
      });
      expect(latestReport()).toEqual(latest);
      expect(sessionStorage.getItem(historyKey)).toBe(stored);
      expect(loadHistory()).toEqual([latest, report]);
      write.mockRestore();
      const committed = decideLocal(report, decision);
      expect(committed.proposal.status).toBe(decision);
      expect(committed.proposal.decided_at).toBeTruthy();
      expect(reportFor(report.session_id)).toEqual(committed);
      expect(latestReport()).toEqual(committed);
      expect(loadHistory()).toEqual([committed, latest]);
    },
  );

  it('surfaces history read failure and does not overwrite unknown history or commit memory', () => {
    const old = analyzeLocal({ ...base, persist: true });
    const stored = sessionStorage.getItem(historyKey);
    const read = vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('read denied', 'SecurityError');
    });
    const write = vi.spyOn(sessionStorage, 'setItem');
    expect(() => loadHistory()).toThrow('读取本地历史记录失败');
    expect(() => analyzeLocal({ ...base, session_id: 'read-failed', persist: true })).toThrow(
      '读取本地历史记录失败',
    );
    expect(() => decideLocal(old, 'accepted')).toThrow('读取本地历史记录失败');
    expect(write).not.toHaveBeenCalled();
    expect(latestReport()).toEqual(old);
    expect(reportFor(old.session_id)).toEqual(old);
    expect(() => reportFor('read-failed')).toThrow('不存在');
    read.mockRestore();
    expect(sessionStorage.getItem(historyKey)).toBe(stored);
    expect(loadHistory()).toEqual([old]);
  });

  it.each([
    ['broken JSON', '{broken', '解析本地历史记录失败'],
    ['empty string', '', '解析本地历史记录失败'],
    ['non-array JSON', '{}', '本地历史记录格式无效'],
    ['invalid history entry', '[{}]', '本地历史记录格式无效'],
  ])('preserves %s instead of silently replacing it with empty history', (_name, raw, message) => {
    const old = analyzeLocal({ ...base, persist: true });
    sessionStorage.setItem(historyKey, raw);
    const write = vi.spyOn(sessionStorage, 'setItem');
    expect(() => loadHistory()).toThrow(message);
    expect(() => analyzeLocal({ ...base, input_version: 2, persist: true })).toThrow(message);
    expect(() => decideLocal(old, 'rejected')).toThrow(message);
    expect(write).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(historyKey)).toBe(raw);
    expect(reportFor(old.session_id)).toEqual(old);
    expect(latestReport()).toEqual(old);
  });

  it('distinguishes a missing key and an explicitly empty array from failed reads', () => {
    expect(sessionStorage.getItem(historyKey)).toBeNull();
    expect(loadHistory()).toEqual([]);
    sessionStorage.setItem(historyKey, '[]');
    expect(loadHistory()).toEqual([]);
    const report = analyzeLocal({ ...base, persist: true });
    expect(loadHistory()).toEqual([report]);
  });
});

describe('clearHistory atomicity', () => {
  it('keeps memory and persisted history intact when the storage delete fails', () => {
    const report = analyzeLocal({ ...base, persist: true });
    const latest = analyzeLocal({ ...base, session_id: 'latest-other', persist: true });
    const stored = sessionStorage.getItem(historyKey);
    const write = vi.spyOn(sessionStorage, 'setItem');
    const remove = vi.spyOn(sessionStorage, 'removeItem').mockImplementation(() => {
      throw new DOMException('delete denied', 'SecurityError');
    });
    expect(() => clearHistory()).toThrow('delete denied');
    expect(remove).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(latestReport()).toEqual(latest);
    expect(reportFor(report.session_id)).toEqual(report);
    expect(reportFor('latest-other')).toEqual(latest);
    expect(sessionStorage.getItem(historyKey)).toBe(stored);
    expect(loadHistory()).toEqual([latest, report]);
    remove.mockRestore();
    // The retained memory is usable: stale-version guard and decisions still work.
    expect(() => analyzeLocal({ ...base, persist: true })).toThrow('拒绝过期或重复');
    const decided = decideLocal(report, 'accepted');
    expect(decided.proposal.status).toBe('accepted');
    expect(reportFor(report.session_id)).toEqual(decided);
    expect(latestReport()).toEqual(decided);
    expect(loadHistory()).toEqual([decided, latest]);
  });

  it('clears both storage and memory only when the storage delete succeeds', () => {
    const report = analyzeLocal({ ...base, persist: true });
    const latest = analyzeLocal({ ...base, session_id: 'latest-other', persist: true });
    expect(loadHistory()).toEqual([latest, report]);
    clearHistory();
    expect(sessionStorage.getItem(historyKey)).toBeNull();
    expect(loadHistory()).toEqual([]);
    expect(latestReport()).toBeNull();
    expect(() => reportFor(report.session_id)).toThrow('不存在');
    expect(() => reportFor('latest-other')).toThrow('不存在');
    expect(() => decideLocal(report, 'accepted')).toThrow('不存在');
    const fresh = analyzeLocal({ ...base, session_id: 'fresh', persist: true });
    expect(latestReport()).toEqual(fresh);
    expect(reportFor('fresh')).toEqual(fresh);
    expect(loadHistory()).toEqual([fresh]);
  });
});
