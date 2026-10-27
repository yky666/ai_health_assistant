import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
const flags = vi.hoisted(() => ({ mode: 'browser' }));
vi.mock('./runtime', () => ({
  get runtimeMode() {
    return flags.mode;
  },
}));
import {
  request,
  acceptReport,
  decideReport,
  reportSafetyEvent,
  getSessionState,
  isApiError,
} from './api';
import { clearHistory } from './localCoach';
import type { Report } from './types';
beforeEach(() => {
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  clearHistory();
  flags.mode = 'browser';
});
const summary = (id: string) => ({
  session_id: id,
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
});
describe('runtime authority', () => {
  it('browser flow never sends a network request and explanation is session-specific', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const first = await request<Report>('/sessions/analyze', {
      method: 'POST',
      body: JSON.stringify(summary('one')),
    });
    await request('/sessions/analyze', {
      method: 'POST',
      body: JSON.stringify({ ...summary('two'), discomfort: true }),
    });
    const explanation = await request<{ text: string }>('/sessions/one/explanation', {
      method: 'POST',
    });
    expect(explanation.text).toBe(first.proposal.reason);
    expect((await acceptReport(first)).proposal.status).toBe('accepted');
    await expect(decideReport(first, 'reject')).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
  it.each([404, 500])('backend HTTP %s cannot silently create a browser report', async (status) => {
    flags.mode = 'backend';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('failure', { status })));
    await expect(
      request('/sessions/analyze', { method: 'POST', body: JSON.stringify(summary('failure')) }),
    ).rejects.toThrow('未切换');
    flags.mode = 'browser';
    await expect(request('/sessions/failure/explanation', { method: 'POST' })).rejects.toThrow();
  });
  it('backend network failure remains a failure', async () => {
    flags.mode = 'backend';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(request('/health')).rejects.toThrow('offline');
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const signalSupport = [
  { name: 'native statics available', missing: [] },
  { name: 'without AbortSignal.any', missing: ['any'] },
  { name: 'without AbortSignal.timeout', missing: ['timeout'] },
  { name: 'without either static API', missing: ['any', 'timeout'] },
];

function omitSignalStatics(missing: string[]) {
  const native = AbortSignal;
  vi.stubGlobal(
    'AbortSignal',
    new Proxy(native, {
      get(target, key, receiver) {
        return missing.includes(String(key)) ? undefined : Reflect.get(target, key, receiver);
      },
    }),
  );
  for (const key of missing) expect(Reflect.get(AbortSignal, key)).toBeUndefined();
}

function pendingFetch() {
  let signal: AbortSignal;
  const network = vi.fn((_url: string, options: RequestInit) => {
    signal = options.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  vi.stubGlobal('fetch', network);
  return { network, receivedSignal: () => signal! };
}

describe.each(signalSupport)('backend timeout compatibility: $name', ({ missing }) => {
  beforeEach(() => {
    flags.mode = 'backend';
    vi.useFakeTimers();
    omitSignalStatics(missing);
  });

  it.each([false, true])(
    'aborts at exactly 25 seconds, including with a caller signal: %s',
    async (withCaller) => {
      const caller = new AbortController();
      const add = vi.spyOn(caller.signal, 'addEventListener');
      const remove = vi.spyOn(caller.signal, 'removeEventListener');
      const pending = pendingFetch();
      const result = request('/health', withCaller ? { signal: caller.signal } : {}).catch(
        (e) => e,
      );
      expect(vi.getTimerCount()).toBe(1);
      expect(pending.receivedSignal().aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(24999);
      expect(pending.receivedSignal().aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await result;
      expect(pending.receivedSignal().aborted).toBe(true);
      expect(error).toBe(pending.receivedSignal().reason);
      expect(error).toBeInstanceOf(DOMException);
      expect(error).toMatchObject({ name: 'TimeoutError', message: '请求超过 25 秒。' });
      expect(caller.signal.aborted).toBe(false);
      expect(pending.network).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      if (withCaller) {
        expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
        expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
      }
    },
  );

  it('honors earlier user cancellation and removes its timer and listener', async () => {
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, 'addEventListener');
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const pending = pendingFetch();
    const result = request('/health', { signal: caller.signal }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pending.receivedSignal().aborted).toBe(false);
    const reason = new DOMException('user cancelled', 'AbortError');
    caller.abort(reason);
    expect(await result).toBe(reason);
    expect(pending.receivedSignal().aborted).toBe(true);
    expect(pending.receivedSignal().reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    await vi.advanceTimersByTimeAsync(25000);
    expect(pending.receivedSignal().reason).toBe(reason);
  });
});

describe('backend request resource cleanup', () => {
  beforeEach(() => {
    flags.mode = 'backend';
    vi.useFakeTimers();
  });

  it.each(['success', 'network failure', 'HTTP failure', 'JSON failure'] as const)(
    'cleans timer and cancellation listener after %s',
    async (kind) => {
      const caller = new AbortController();
      const add = vi.spyOn(caller.signal, 'addEventListener');
      const remove = vi.spyOn(caller.signal, 'removeEventListener');
      let received: AbortSignal;
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, options: RequestInit) => {
          received = options.signal as AbortSignal;
          if (kind === 'network failure') return Promise.reject(new Error('offline'));
          return Promise.resolve(
            kind === 'success'
              ? new Response('{"ok":true}')
              : kind === 'HTTP failure'
                ? new Response('failure', { status: 500 })
                : new Response('invalid-json'),
          );
        }),
      );
      const result = request('/health', { signal: caller.signal });
      if (kind === 'success') await expect(result).resolves.toEqual({ ok: true });
      else if (kind === 'network failure') await expect(result).rejects.toThrow('offline');
      else if (kind === 'HTTP failure') await expect(result).rejects.toThrow('(500)');
      else await expect(result).rejects.toBeInstanceOf(SyntaxError);
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(25000);
      expect(received!.aborted).toBe(false);
      caller.abort();
      expect(received!.aborted).toBe(false);
    },
  );

  it('rejects an already-aborted caller before starting fetch or creating resources', async () => {
    const caller = new AbortController();
    const reason = new DOMException('already cancelled', 'AbortError');
    caller.abort(reason);
    const add = vi.spyOn(caller.signal, 'addEventListener');
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    await expect(request('/health', { signal: caller.signal })).rejects.toBe(reason);
    expect(network).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps timeout active until response JSON finishes, not just until headers arrive', async () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    let received: AbortSignal;
    const json = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          received.addEventListener('abort', () => reject(received.reason), { once: true });
        }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: RequestInit) => {
        received = options.signal as AbortSignal;
        return Promise.resolve({ ok: true, json });
      }),
    );
    const result = request('/health', { signal: caller.signal }).catch((e) => e);
    await Promise.resolve();
    expect(json).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    expect(remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25000);
    expect(await result).toMatchObject({ name: 'TimeoutError' });
    expect(remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('BE-01 safety API integration', () => {
  const receipt = {
    session_id: 'session-a',
    event_id: 'event-1',
    event_type: 'safety.discomfort',
    safety_latched: true,
    safety_version: 1,
    status: 'active',
    duplicate: false,
  };
  const report = (overrides: Partial<Report> = {}): Report => ({
    session_id: 'session-a',
    input_version: 1,
    source: 'simulation',
    coverage: 1,
    completion: 1,
    saved: false,
    rep_details: [],
    energy: { low_kcal: 1, high_kcal: 2, note: '' },
    proposal: {
      target_reps: 12,
      rest_seconds: 60,
      reason: 'keep',
      blocked: false,
      status: 'pending',
      proposal_id: 'session-a:1',
      decided_at: null,
    },
    trace: [],
    ...overrides,
  });

  it('reports a discomfort event to the documented path with the documented body', async () => {
    flags.mode = 'backend';
    const network = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt), { status: 200 }));
    vi.stubGlobal('fetch', network);
    const result = await reportSafetyEvent('session/a', 'event-1', 'dizzy');
    expect(result).toEqual(receipt);
    expect(network).toHaveBeenCalledOnce();
    const [url, init] = network.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/sessions/session%2Fa/safety-events');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      event_id: 'event-1',
      type: 'discomfort',
      note: 'dizzy',
    });
  });

  it('omits the optional note and reuses the caller event id on a retry', async () => {
    flags.mode = 'backend';
    const network = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));
    vi.stubGlobal('fetch', network);
    await expect(reportSafetyEvent('session-a', 'stable-event')).rejects.toThrow('offline');
    await expect(reportSafetyEvent('session-a', 'stable-event')).resolves.toMatchObject({
      safety_version: 1,
    });
    const bodies = network.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies).toEqual([
      { event_id: 'stable-event', type: 'discomfort' },
      { event_id: 'stable-event', type: 'discomfort' },
    ]);
  });

  it('reads the authoritative state from the metadata-only endpoint', async () => {
    flags.mode = 'backend';
    const state = {
      session_id: 'session-a',
      status: 'active',
      safety_latched: true,
      safety_version: 3,
      input_version: 1,
      proposal_id: 'session-a:1',
      proposal_status: 'blocked',
      decided_at: null,
      persist_history: false,
      report_recoverable: false,
      expires_at: '2030-01-01T00:00:00+00:00',
    };
    const network = vi.fn().mockResolvedValue(new Response(JSON.stringify(state), { status: 200 }));
    vi.stubGlobal('fetch', network);
    await expect(getSessionState('session-a')).resolves.toEqual(state);
    const [url, init] = network.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/sessions/session-a/state');
    expect((init.method ?? 'GET').toUpperCase()).toBe('GET');
  });

  it('sends expected_safety_version only for reports that carry a server version', async () => {
    flags.mode = 'backend';
    const network = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify(report()), { status: 200 }));
    vi.stubGlobal('fetch', network);
    await acceptReport(report());
    await acceptReport(report({ safety_version: 4 }));
    await decideReport(report({ safety_version: 4 }), 'reject');
    const bodies = network.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies[0]).toEqual({ input_version: 1, proposal_id: 'session-a:1' });
    expect(bodies[1]).toEqual({
      input_version: 1,
      proposal_id: 'session-a:1',
      expected_safety_version: 4,
    });
    expect(bodies[2]).toEqual({
      input_version: 1,
      proposal_id: 'session-a:1',
      expected_safety_version: 4,
    });
  });

  it.each([409, 410, 503])('surfaces HTTP %s as a typed ApiError', async (status) => {
    flags.mode = 'backend';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(`failure-${status}`, { status })),
    );
    const error = await reportSafetyEvent('session-a', 'event-1').catch((e) => e);
    expect(isApiError(error)).toBe(true);
    expect(error).toMatchObject({ status });
    expect(String(error)).toContain('未切换');
  });

  it('browser mode never calls the backend safety endpoints', async () => {
    flags.mode = 'browser';
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    await expect(reportSafetyEvent('session-a', 'event-1')).rejects.toThrow(
      '浏览器模式不调用后端安全接口',
    );
    await expect(getSessionState('session-a')).rejects.toThrow('浏览器模式不调用后端安全接口');
    expect(network).not.toHaveBeenCalled();
  });

  it('times out a stalled safety-event request as TimeoutError', async () => {
    flags.mode = 'backend';
    vi.useFakeTimers();
    let received: AbortSignal;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        received = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          received.addEventListener('abort', () => reject(received.reason), { once: true });
        });
      }),
    );
    const pending = reportSafetyEvent('session-a', 'event-1').catch((e) => e);
    await vi.advanceTimersByTimeAsync(25000);
    expect(await pending).toMatchObject({ name: 'TimeoutError' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
