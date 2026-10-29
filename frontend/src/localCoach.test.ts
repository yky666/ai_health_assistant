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

  it('rejects incomplete Report shapes instead of returning them', () => {
    const current = analyzeLocal({ ...base, persist: true });
    const raw = sessionStorage.getItem(historyKey);
    if (!raw) throw new Error('expected a persisted report');
    const record = JSON.parse(raw)[0] as Record<string, unknown>;
    const invalidVariants: Array<[string, (value: Record<string, unknown>) => void]> = [
      ['session_id empty', (value) => (value.session_id = '')],
      ['input_version wrong type', (value) => (value.input_version = '1')],
      ['source invalid', (value) => (value.source = 'webcam')],
      ['coverage wrong type', (value) => (value.coverage = '0.5')],
      ['completion wrong type', (value) => (value.completion = '0.5')],
      ['saved wrong type', (value) => (value.saved = 'true')],
      ['rep detail incomplete', (value) => (value.rep_details = [{}])],
      ['energy incomplete', (value) => (value.energy = {})],
      ['proposal empty', (value) => (value.proposal = {})],
      ['proposal target wrong type', (value) => {
        value.proposal = { ...(value.proposal as Record<string, unknown>), target_reps: '12' };
      }],
      ['trace entry incomplete', (value) => (value.trace = [{}])],
      ['trace empty', (value) => (value.trace = [])],
      ['proposal status invalid', (value) => {
        (value.proposal as Record<string, unknown>).status = 'unknown';
      }],
      ['pending proposal marked blocked', (value) => {
        (value.proposal as Record<string, unknown>).blocked = true;
      }],
      ['proposal blocked wrong type', (value) => {
        (value.proposal as Record<string, unknown>).blocked = 'false';
      }],
      ['blocked proposal marked unblocked', (value) => {
        (value.proposal as Record<string, unknown>).status = 'blocked';
        (value.proposal as Record<string, unknown>).blocked = false;
      }],
      ['pending proposal has decision timestamp', (value) => {
        (value.proposal as Record<string, unknown>).decided_at = '2026-01-01T00:00:00Z';
      }],
      ['accepted proposal has null decision timestamp', (value) => {
        const proposal = value.proposal as Record<string, unknown>;
        proposal.status = 'accepted';
        proposal.blocked = false;
        proposal.decided_at = null;
      }],
      ['accepted proposal has malformed decision timestamp', (value) => {
        const proposal = value.proposal as Record<string, unknown>;
        proposal.status = 'accepted';
        proposal.blocked = false;
        proposal.decided_at = 'not-a-date';
      }],
      ['accepted proposal has invalid calendar date', (value) => {
        const proposal = value.proposal as Record<string, unknown>;
        proposal.status = 'accepted';
        proposal.blocked = false;
        proposal.decided_at = '2026-02-30T00:00:00Z';
      }],
      ['accepted blocked proposal lacks latch metadata', (value) => {
        const proposal = value.proposal as Record<string, unknown>;
        proposal.status = 'accepted';
        proposal.blocked = true;
        proposal.decided_at = '2026-01-01T00:00:00Z';
        delete value.safety_latched;
        delete value.safety_version;
      }],
      ['latched accepted proposal is unblocked', (value) => {
        const proposal = value.proposal as Record<string, unknown>;
        proposal.status = 'accepted';
        proposal.blocked = false;
        proposal.decided_at = '2026-01-01T00:00:00Z';
        value.safety_latched = true;
        value.safety_version = 1;
      }],
      ['negative safety version', (value) => {
        value.safety_latched = false;
        value.safety_version = -1;
      }],
      ['fractional safety version', (value) => {
        const proposal = value.proposal as Record<string, unknown>;
        proposal.status = 'blocked';
        proposal.blocked = true;
        proposal.decided_at = null;
        value.safety_latched = true;
        value.safety_version = 0.5;
      }],
      ['safety version disagrees with latch', (value) => {
        value.safety_latched = false;
        value.safety_version = 1;
      }],
      ['schema_version wrong type', (value) => (value.schema_version = 1)],
      ['policy_version wrong type', (value) => (value.policy_version = false)],
    ];
    for (const [name, mutate] of invalidVariants) {
      const invalid = structuredClone(record);
      mutate(invalid);
      const invalidRaw = JSON.stringify([invalid]);
      sessionStorage.setItem(historyKey, invalidRaw);
      const write = vi.spyOn(sessionStorage, 'setItem');
      expect(() => loadHistory(), name).toThrow('本地历史记录格式无效');
      expect(() => analyzeLocal({ ...base, input_version: 2, persist: true }), name).toThrow(
        '本地历史记录格式无效',
      );
      expect(() => decideLocal(current, 'rejected'), name).toThrow('本地历史记录格式无效');
      expect(write, name).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(historyKey), name).toBe(invalidRaw);
      write.mockRestore();
    }
    expect(reportFor(current.session_id)).toEqual(current);
  });

  it('still accepts the current Report format', () => {
    const current = analyzeLocal({ ...base, persist: true });
    expect(loadHistory()).toEqual([current]);
  });

  it('rejects unsafe squat sequences and energy relationships', () => {
    const firstRep = {
      number: 1,
      start_seconds: 1,
      bottom_seconds: 2,
      end_seconds: 3,
      descent_seconds: 1,
      ascent_seconds: 1,
      min_angle_degrees: 90,
      rom: 'within_rule' as const,
    };
    const secondRep = {
      ...firstRep,
      number: 2,
      start_seconds: 3,
      bottom_seconds: 4,
      end_seconds: 5,
    };
    const current = analyzeLocal({
      ...base,
      reps: 2,
      rep_details: [firstRep, secondRep],
      persist: true,
    });
    const raw = sessionStorage.getItem(historyKey);
    if (!raw) throw new Error('expected a persisted report');
    const record = JSON.parse(raw)[0] as Record<string, unknown>;
    const invalidVariants: Array<[string, (value: Record<string, unknown>) => void]> = [
      [
        'squat timestamp reverse',
        (value) => {
          (value.rep_details as Array<Record<string, unknown>>)[0].start_seconds = 2.5;
        },
      ],
      [
        'squat descent mismatch',
        (value) => {
          (value.rep_details as Array<Record<string, unknown>>)[0].descent_seconds = 0.5;
        },
      ],
      [
        'squat ascent mismatch',
        (value) => {
          (value.rep_details as Array<Record<string, unknown>>)[0].ascent_seconds = 0.5;
        },
      ],
      [
        'squat number reverse',
        (value) => {
          (value.rep_details as Array<Record<string, unknown>>)[1].number = 1;
        },
      ],
      [
        'squat time overlap',
        (value) => {
          const reps = value.rep_details as Array<Record<string, unknown>>;
          reps[1].start_seconds = 2.5;
          reps[1].bottom_seconds = 3.5;
          reps[1].end_seconds = 4.5;
        },
      ],
      [
        'more than 100 squat records',
        (value) => {
          value.rep_details = Array.from({ length: 101 }, (_, index) => ({
            ...firstRep,
            number: index + 1,
            start_seconds: index * 2,
            bottom_seconds: index * 2 + 1,
            end_seconds: index * 2 + 2,
          }));
        },
      ],
      [
        'negative low energy',
        (value) => {
          (value.energy as Record<string, unknown>).low_kcal = -1;
        },
      ],
      [
        'negative work seconds',
        (value) => {
          (value.energy as Record<string, unknown>).work_seconds = -1;
        },
      ],
      [
        'negative daily energy',
        (value) => {
          const energy = value.energy as Record<string, unknown>;
          (energy.daily as Record<string, unknown>).bmr_kcal = -1;
        },
      ],
      [
        'energy bounds reversed',
        (value) => {
          const energy = value.energy as Record<string, unknown>;
          energy.low_kcal = 10;
          energy.high_kcal = 5;
        },
      ],
      [
        'net energy bounds reversed',
        (value) => {
          const energy = value.energy as Record<string, unknown>;
          energy.net_low_kcal = 10;
          energy.net_high_kcal = 5;
        },
      ],
      [
        'rep number exceeds traced total',
        (value) => {
          (value.rep_details as Array<Record<string, unknown>>)[1].number = 3;
        },
      ],
      [
        'rep end exceeds active seconds',
        (value) => {
          value.active_seconds = 4;
        },
      ],
      [
        'rep end exceeds energy duration',
        (value) => {
          const energy = value.energy as Record<string, unknown>;
          energy.work_seconds = 1;
          energy.rest_seconds = 0;
          energy.unknown_seconds = 0;
        },
      ],
      [
        'active and energy durations disagree',
        (value) => {
          value.active_seconds = 60;
          const energy = value.energy as Record<string, unknown>;
          energy.work_seconds = 1;
          energy.rest_seconds = 0;
          energy.unknown_seconds = 0;
        },
      ],
      [
        'reps field invalid',
        (value) => {
          value.reps = '2';
        },
      ],
      [
        'top reps disagree with final trace reps',
        (value) => {
          value.reps = 3;
        },
      ],
      [
        'trace reps invalid',
        (value) => {
          const trace = value.trace as Array<Record<string, unknown>>;
          const training = trace.find((entry) => entry.role === 'training_analyst');
          if (!training) throw new Error('expected training trace entry');
          (training.evidence as Record<string, unknown>).reps = '2';
        },
      ],
    ];
    for (const [name, mutate] of invalidVariants) {
      const invalid = structuredClone(record);
      mutate(invalid);
      const invalidRaw = JSON.stringify([invalid]);
      sessionStorage.setItem(historyKey, invalidRaw);
      const write = vi.spyOn(sessionStorage, 'setItem');
      expect(() => loadHistory(), name).toThrow('本地历史记录格式无效');
      expect(() => analyzeLocal({ ...base, input_version: 2, persist: true }), name).toThrow(
        '本地历史记录格式无效',
      );
      expect(() => decideLocal(current, 'rejected'), name).toThrow('本地历史记录格式无效');
      expect(write, name).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(historyKey), name).toBe(invalidRaw);
      write.mockRestore();
    }
    expect(reportFor(current.session_id)).toEqual(current);
  });

  it('accepts matching top-level and final trace totals', () => {
    const current = analyzeLocal({ ...base, persist: true });
    const raw = sessionStorage.getItem(historyKey);
    if (!raw) throw new Error('expected a persisted report');
    const record = JSON.parse(raw)[0] as Record<string, unknown>;
    record.reps = base.reps;
    sessionStorage.setItem(historyKey, JSON.stringify([record]));
    expect(loadHistory()).toHaveLength(1);
    expect(reportFor(current.session_id)).toEqual(current);
  });

  it('accepts valid proposal statuses and latched accepted/rejected views', () => {
    const current = analyzeLocal({ ...base, persist: true });
    const raw = sessionStorage.getItem(historyKey);
    if (!raw) throw new Error('expected a persisted report');
    const baseRecord = JSON.parse(raw)[0] as Record<string, unknown>;
    const statuses = [
      { status: 'pending', blocked: false },
      { status: 'blocked', blocked: true },
      { status: 'accepted', blocked: false },
      { status: 'rejected', blocked: false },
      { status: 'accepted', blocked: true },
      { status: 'rejected', blocked: true },
    ] as const;
    for (const { status, blocked } of statuses) {
      const record = structuredClone(baseRecord);
      const proposal = record.proposal as Record<string, unknown>;
      proposal.status = status;
      proposal.blocked = blocked;
      proposal.decided_at =
        status === 'accepted' || status === 'rejected' ? '2026-01-01T00:00:00+00:00' : null;
      const latchedView = blocked && (status === 'accepted' || status === 'rejected');
      if (latchedView) {
        record.safety_latched = true;
        record.safety_version = 1;
      } else {
        delete record.safety_latched;
        delete record.safety_version;
      }
      sessionStorage.setItem(historyKey, JSON.stringify([record]));
      expect(loadHistory(), `${status}/${blocked}`).toHaveLength(1);
    }
    expect(reportFor(current.session_id)).toEqual(current);
  });

  it('accepts legacy records without optional schema/policy metadata', () => {
    const legacy = {
      session_id: 'legacy-history',
      input_version: 1,
      source: 'simulation',
      coverage: 0.5,
      completion: 0.5,
      saved: true,
      rep_details: [],
      energy: { low_kcal: 1, high_kcal: 2, note: 'legacy' },
      proposal: {
        target_reps: 12,
        rest_seconds: 60,
        reason: 'legacy reason',
        blocked: false,
        status: 'pending',
      },
      trace: [
        {
          role: 'reporter',
          runtime: 'browser',
          decision: 'summary',
          evidence: {},
          timestamp: '2026-01-01T00:00:00+00:00',
        },
      ],
    };
    sessionStorage.setItem(historyKey, JSON.stringify([legacy]));
    expect(loadHistory()).toHaveLength(1);
    expect(loadHistory()[0].session_id).toBe('legacy-history');

    // The previous loader allowed empty trace arrays. Keep that compatibility
    // only for unversioned legacy records with no untraceable rep details.
    const legacyEmptyTrace = { ...legacy, session_id: 'legacy-empty-trace', trace: [] };
    sessionStorage.setItem(historyKey, JSON.stringify([legacyEmptyTrace]));
    expect(loadHistory()[0].session_id).toBe('legacy-empty-trace');

    const untraceableReps = {
      ...legacyEmptyTrace,
      session_id: 'legacy-untraceable-reps',
      rep_details: [
        {
          number: 1,
          start_seconds: 1,
          bottom_seconds: 2,
          end_seconds: 3,
          descent_seconds: 1,
          ascent_seconds: 1,
          min_angle_degrees: 90,
          rom: 'within_rule',
        },
      ],
    };
    sessionStorage.setItem(historyKey, JSON.stringify([untraceableReps]));
    expect(() => loadHistory()).toThrow('本地历史记录格式无效');
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
