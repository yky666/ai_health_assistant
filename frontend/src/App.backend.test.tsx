// @vitest-environment jsdom
/**
 * FE-BE-01 backend-mode integration tests.
 *
 * These render the real App with the real API module in `runtime=backend` mode and
 * stub only the network boundary (fetch). They verify the frontend safety state
 * machine: local-first latch, stable session/event ids, sync retry, reload state
 * recovery, decision safety versions and history semantics.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runtime', () => ({ runtimeMode: 'backend', strictOffline: true }));

import App from './App';
import { ACTIVE_SESSION_KEY, LOCAL_SAFETY_KEY } from './App';

type Call = { method: string; url: string; body: Record<string, unknown> | null };
type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};
type Handler = (body: Record<string, unknown> | null) => FakeResponse | Promise<FakeResponse>;

const net = vi.hoisted(() => ({
  calls: [] as Call[],
  handlers: {} as Record<string, Handler>,
}));

function fakeResponse(status: number, payload: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function route(method: string, url: string, handler: Handler) {
  net.handlers[`${method} ${url}`] = handler;
}

function callsFor(fragment: string) {
  return net.calls.filter((call) => call.url.includes(fragment));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;
let uuidCounter = 0;

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const settle = async () => {
  await flush();
  await act(async () => {
    await flush();
  });
};

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage() {}
  terminate() {}
}

async function renderApp() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
    await flush();
  });
  await settle();
}

function findButton(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button as HTMLButtonElement;
}

function allButtons() {
  return [...container.querySelectorAll('button')] as HTMLButtonElement[];
}

function discomfortInput(): HTMLInputElement {
  const label = [...container.querySelectorAll('label')].find((item) =>
    item.textContent?.includes('不适'),
  );
  const input = label?.querySelector('input');
  if (!input) throw new Error('Discomfort checkbox not found');
  return input as HTMLInputElement;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await flush();
  });
  await settle();
}

async function toggle(input: HTMLInputElement) {
  await act(async () => {
    input.click();
    await flush();
  });
  await settle();
}

async function forceClick(button: HTMLButtonElement) {
  const propsKey = Object.keys(button).find((key) => key.startsWith('__reactProps$'));
  const props = propsKey
    ? (button as unknown as Record<string, { onClick?: (event: unknown) => unknown }>)[propsKey]
    : null;
  if (!props?.onClick) throw new Error('React onClick handler not found');
  await act(async () => {
    await props.onClick!({
      target: button,
      currentTarget: button,
      preventDefault() {},
      stopPropagation() {},
    });
    await flush();
  });
  await settle();
}

async function forceChange(
  element: HTMLInputElement | HTMLSelectElement,
  target: Record<string, unknown>,
) {
  const propsKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
  const props = propsKey
    ? (element as unknown as Record<string, { onChange?: (event: unknown) => unknown }>)[propsKey]
    : null;
  if (!props?.onChange) throw new Error('React onChange handler not found');
  await act(async () => {
    await props.onChange!({ target, currentTarget: element });
    await flush();
  });
  await settle();
}

function inputFor(labelText: string): HTMLInputElement | HTMLSelectElement {
  const label = [...container.querySelectorAll('label')].find((item) =>
    item.textContent?.includes(labelText),
  );
  const input = label?.querySelector('input, select');
  if (!input) throw new Error(`Input not found: ${labelText}`);
  return input as HTMLInputElement | HTMLSelectElement;
}

async function changeInput(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const proto =
      input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
  });
  await settle();
}

function statePayload(
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: sessionId,
    status: 'active',
    safety_latched: false,
    safety_version: 1,
    input_version: null,
    proposal_id: null,
    proposal_status: null,
    decided_at: null,
    persist_history: false,
    report_recoverable: false,
    expires_at: '2030-01-01T00:00:00+00:00',
    ...overrides,
  };
}

function blockedReport(sessionId: string, overrides: Record<string, unknown> = {}) {
  return analysisReport(sessionId, {
    safety_latched: true,
    safety_version: 1,
    proposal: {
      target_reps: 12,
      rest_seconds: 60,
      reason: '服务端已记录不适事件：会话已锁存，禁止继续训练。',
      blocked: true,
      status: 'blocked',
      proposal_id: `${sessionId}:1`,
      decided_at: null,
    },
    trace: [
      {
        role: 'safety_gate',
        runtime: 'safety',
        decision: '服务端安全锁存：阻止继续训练（当前有效结论）。',
        evidence: { safety_latched: true },
        timestamp: '2026-01-01T00:00:00+00:00',
        historical: false,
      },
    ],
    ...overrides,
  });
}

function findButtonByAria(label: string): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Button not found by aria-label: ${label}`);
  return button as HTMLButtonElement;
}

function analysisReport(
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: sessionId,
    input_version: 1,
    source: 'simulation',
    coverage: 0.9,
    completion: 0.7,
    saved: false,
    rep_details: [],
    energy: { low_kcal: 1, high_kcal: 2, note: '' },
    proposal: {
      target_reps: 12,
      rest_seconds: 60,
      reason: '本次记录暂不支持增加训练量，保持计划并继续观察。',
      blocked: false,
      status: 'pending',
      proposal_id: `${sessionId}:1`,
      decided_at: null,
    },
    trace: [],
    safety_latched: false,
    safety_version: 1,
    ...overrides,
  };
}

const storedSafety = () => {
  const raw = sessionStorage.getItem(LOCAL_SAFETY_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
};
const storedSession = () => {
  const raw = sessionStorage.getItem(ACTIVE_SESSION_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  net.calls.length = 0;
  net.handlers = {};
  uuidCounter = 0;
  sessionStorage.clear();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('crypto', { randomUUID: () => `test-session-${++uuidCounter}` });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
  });
  route('GET', '/api/health', () => fakeResponse(200, { status: 'ok' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo, init: RequestInit = {}) => {
      const url = String(input);
      const method = String(init.method ?? 'GET').toUpperCase();
      const body = init.body ? JSON.parse(String(init.body)) : null;
      net.calls.push({ method, url, body });
      const handler = net.handlers[`${method} ${url}`];
      if (!handler) return fakeResponse(404, { detail: 'not found' });
      return handler(body);
    }),
  );
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('session id lifecycle', () => {
  it('creates one stable id per group shared by safety event, analysis and decision, then a new id', async () => {
    const state = { safe: true };
    let currentSession = '';
    route('POST', '/api/sessions/analyze', (body) => {
      currentSession = String(body?.session_id);
      return fakeResponse(200, analysisReport(currentSession));
    });
    route('POST', '/api/sessions/test-session-1/accept', () =>
      fakeResponse(200, {
        ...analysisReport('test-session-1'),
        proposal: {
          target_reps: 12,
          rest_seconds: 60,
          reason: 'ok',
          blocked: false,
          status: 'accepted',
          proposal_id: 'test-session-1:1',
          decided_at: '2026-01-01T00:00:00+00:00',
        },
        safety_version: 1,
      }),
    );
    route('POST', '/api/sessions/test-session-2/accept', () =>
      fakeResponse(200, {
        ...analysisReport('test-session-2'),
        proposal: {
          target_reps: 12,
          rest_seconds: 60,
          reason: 'ok',
          blocked: false,
          status: 'accepted',
          proposal_id: 'test-session-2:1',
          decided_at: '2026-01-01T00:00:00+00:00',
        },
        safety_version: 1,
      }),
    );

    await renderApp();
    // First group: start -> finish -> accept.
    await click(findButton('开始 / 继续'));
    expect(storedSession()?.session_id).toBe('test-session-1');
    await click(findButton('结束本组并复盘'));
    expect(currentSession).toBe('test-session-1');
    expect(callsFor('/sessions/analyze').map((call) => call.body?.session_id)).toEqual([
      'test-session-1',
    ]);
    await click(findButton('确认下一组计划'));
    expect(callsFor('/sessions/test-session-1/accept')).toHaveLength(1);
    expect(callsFor('/sessions/test-session-1/accept')[0].body).toMatchObject({
      input_version: 1,
      proposal_id: 'test-session-1:1',
      expected_safety_version: 1,
    });

    // A new group must use a new session id.
    await click(findButton('开始 / 继续'));
    expect(storedSession()?.session_id).toBe('test-session-2');
    await click(findButton('结束本组并复盘'));
    expect(currentSession).toBe('test-session-2');
    expect(callsFor('/sessions/analyze').map((call) => call.body?.session_id)).toEqual([
      'test-session-1',
      'test-session-2',
    ]);
    expect(state.safe).toBe(true);
  });
});

describe('safety event lifecycle', () => {
  it('locks locally before the safety request resolves, then records the confirmed server version', async () => {
    const gate = deferred<FakeResponse>();
    route('POST', '/api/sessions/test-session-1/safety-events', () => gate.promise);
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(200, analysisReport(String(body?.session_id))),
    );

    await renderApp();
    await click(findButton('开始 / 继续'));
    await act(async () => {
      discomfortInput().click();
      await flush();
    });

    // Local block happened while the network request is still pending.
    expect(container.textContent).toContain('本次训练已因不适停止');
    expect(findButton('本次训练已停止').disabled).toBe(true);
    const calls = callsFor('/safety-events');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('/api/sessions/test-session-1/safety-events');
    expect(calls[0].body).toMatchObject({ type: 'discomfort' });
    const eventId = String(calls[0].body?.event_id);
    expect(eventId.length).toBeGreaterThan(0);
    expect(storedSafety()).toMatchObject({
      session_id: 'test-session-1',
      event_id: eventId,
      server_confirmed: false,
    });

    await act(async () => {
      gate.resolve(
        fakeResponse(200, {
          session_id: 'test-session-1',
          event_id: eventId,
          event_type: 'safety.discomfort',
          safety_latched: true,
          safety_version: 1,
          status: 'active',
          duplicate: false,
        }),
      );
      await flush();
    });
    await settle();
    expect(container.textContent).toContain('服务端已确认记录本次不适事件');
    expect(container.textContent).toContain('safety_version 1');
    expect(storedSafety()).toMatchObject({ server_confirmed: true, safety_version: 1 });

    // Unchecking never clears the local latch.
    await toggle(discomfortInput());
    expect(container.textContent).toContain('本次训练已因不适停止');
    expect(findButton('本次训练已停止').disabled).toBe(true);
  });

  it('keeps the local latch on sync failure and retries with the same event id', async () => {
    let attempts = 0;
    const responses = [
      fakeResponse(503, { detail: 'store unavailable' }),
      fakeResponse(200, {
        session_id: 'test-session-1',
        event_id: 'stable-event',
        event_type: 'safety.discomfort',
        safety_latched: true,
        safety_version: 2,
        status: 'active',
        duplicate: false,
      }),
    ];
    route('POST', '/api/sessions/test-session-1/safety-events', () => {
      const response = responses[Math.min(attempts, responses.length - 1)];
      attempts += 1;
      return response;
    });

    await renderApp();
    await click(findButton('开始 / 继续'));
    await toggle(discomfortInput());
    await settle();

    expect(container.textContent).toContain('服务端同步状态待确认');
    expect(findButton('本次训练已停止').disabled).toBe(true);
    const first = callsFor('/safety-events');
    expect(first).toHaveLength(1);
    expect(storedSafety()?.server_confirmed).toBe(false);
    const eventId = String(first[0].body?.event_id);

    await click(findButton('重试服务端同步'));
    const retried = callsFor('/safety-events');
    expect(retried).toHaveLength(2);
    expect(retried[1].body?.event_id).toBe(eventId); // same id, no fresh event
    expect(container.textContent).toContain('服务端已确认记录本次不适事件');
    expect(storedSafety()).toMatchObject({ server_confirmed: true, safety_version: 2 });
  });
});

describe('authoritative state recovery', () => {
  it('enters the blocked state when the backend reports safety_latched', async () => {
    sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({ session_id: 'restored' }));
    route('GET', '/api/sessions/restored/state', () =>
      fakeResponse(200, {
        session_id: 'restored',
        status: 'active',
        safety_latched: true,
        safety_version: 2,
        input_version: 1,
        proposal_id: 'restored:1',
        proposal_status: 'blocked',
        decided_at: null,
        persist_history: false,
        report_recoverable: false,
        expires_at: '2030-01-01T00:00:00+00:00',
      }),
    );

    await renderApp();
    expect(callsFor('/sessions/restored/state')).toHaveLength(1);
    expect(container.textContent).toContain('本次训练已因不适停止');
    expect(findButton('本次训练已停止').disabled).toBe(true);
    expect(container.textContent).toContain('服务端已确认记录本次不适事件');
  });

  it('treats an expired session as unusable and requires a new session id', async () => {
    sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({ session_id: 'expired-one' }));
    route('GET', '/api/sessions/expired-one/state', () =>
      fakeResponse(200, {
        session_id: 'expired-one',
        status: 'expired',
        safety_latched: false,
        safety_version: 1,
        input_version: 1,
        proposal_id: null,
        proposal_status: null,
        decided_at: null,
        persist_history: false,
        report_recoverable: false,
        expires_at: '2020-01-01T00:00:00+00:00',
      }),
    );

    await renderApp();
    expect(container.textContent).toContain('服务端会话已过期');
    await click(findButton('开始新的训练组'));
    expect(container.textContent).not.toContain('服务端会话已过期');
    expect(findButton('开始 / 继续').disabled).toBe(false);
    expect(storedSession()?.session_id).toBe('test-session-1');
  });

  it('blocks continuation and says the state is unconfirmed when the state request fails', async () => {
    sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({ session_id: 'unknown-state' }));
    route('GET', '/api/sessions/unknown-state/state', () =>
      fakeResponse(503, { detail: 'store unavailable' }),
    );
    await renderApp();
    expect(container.textContent).toContain('无法确认服务端安全状态');
    expect(findButton('状态未确认').disabled).toBe(true);
  });
});

describe('report and decision safety', () => {
  it('preserves the report and session when source/settings changes are attempted with unknown backend state', async () => {
    let stateReads = 0;
    route('GET', '/api/sessions/test-session-1/state', () => {
      stateReads += 1;
      return stateReads === 1
        ? fakeResponse(404, { detail: 'not found' })
        : fakeResponse(503, { detail: 'store unavailable' });
    });
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(200, analysisReport(String(body?.session_id))),
    );
    route('POST', '/api/sessions/test-session-1/accept', () =>
      fakeResponse(503, { detail: 'store unavailable' }),
    );

    await renderApp();
    await toggle(inputFor('显示其他实验动作') as HTMLInputElement);
    await changeInput(container.querySelector('#exercise') as HTMLSelectElement, 'jumping_jack');
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));

    expect(container.textContent).toContain('本次记录暂不支持增加训练量');
    expect(storedSession()?.session_id).toBe('test-session-1');

    await click(findButton('确认下一组计划'));
    expect(container.textContent).toContain('无法确认服务端安全状态');
    expect(stateReads).toBe(2);
    expect(storedSession()?.session_id).toBe('test-session-1');

    await click(findButton('训练空间'));
    const exercise = container.querySelector('#exercise') as HTMLSelectElement;
    const threshold = container.querySelector(
      'input[type="range"][min="85"][max="125"]',
    ) as HTMLInputElement;
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    expect(findButton('真实摄像头').disabled).toBe(true);
    expect(findButton('上传视频').disabled).toBe(true);
    expect(findButtonByAria('重置本组').disabled).toBe(true);
    expect(exercise.disabled).toBe(true);
    expect(threshold.disabled).toBe(true);
    expect(fileInput.disabled).toBe(true);

    await forceClick(findButton('真实摄像头'));
    await forceChange(exercise, { value: 'squat' });
    await forceChange(threshold, { value: '110' });

    const OriginalURL = globalThis.URL;
    const createObjectUrl = vi.fn(() => 'blob:blocked-video');
    vi.stubGlobal(
      'URL',
      Object.assign(class TestURL extends OriginalURL {}, {
        createObjectURL: createObjectUrl,
        revokeObjectURL: vi.fn(),
      }) as unknown as typeof URL,
    );
    const file = new File(['video'], 'blocked.mp4', { type: 'video/mp4' });
    await forceChange(fileInput, { files: [file] });
    await forceClick(findButtonByAria('重置本组'));

    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(findButton('模拟演示').className).toContain('selected');
    expect(exercise.value).toBe('jumping_jack');
    expect(threshold.value).toBe('105');
    expect(storedSession()?.session_id).toBe('test-session-1');

    await click(findButton('训练复盘'));
    expect(container.textContent).toContain('本次记录暂不支持增加训练量');
  });

  it('adopts a latched analyze response as blocked state', async () => {
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(
        200,
        analysisReport(String(body?.session_id), {
          safety_latched: true,
          safety_version: 3,
          proposal: {
            target_reps: 12,
            rest_seconds: 60,
            reason: '服务端已记录不适事件：会话已锁存，禁止继续训练。',
            blocked: true,
            status: 'blocked',
            proposal_id: 'x:1',
            decided_at: null,
          },
        }),
      ),
    );
    await renderApp();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));

    expect(container.textContent).toContain('本次训练已因不适结束');
    expect(findButton('本次训练已停止').disabled).toBe(true);
    expect(findButton('确认下一组计划').disabled).toBe(true);
  });

  it('sends expected_safety_version and refreshes state on 409 instead of auto-retrying', async () => {
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(200, analysisReport(String(body?.session_id), { safety_version: 4 })),
    );
    route('POST', '/api/sessions/test-session-1/accept', () =>
      fakeResponse(409, { detail: 'safety version mismatch' }),
    );
    route('GET', '/api/sessions/test-session-1/state', () =>
      fakeResponse(200, {
        session_id: 'test-session-1',
        status: 'active',
        safety_latched: false,
        safety_version: 5,
        input_version: 1,
        proposal_id: 'test-session-1:1',
        proposal_status: 'pending',
        decided_at: null,
        persist_history: false,
        report_recoverable: false,
        expires_at: '2030-01-01T00:00:00+00:00',
      }),
    );

    await renderApp();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    await click(findButton('确认下一组计划'));

    const acceptCall = callsFor('/sessions/test-session-1/accept')[0];
    expect(acceptCall.body).toMatchObject({ expected_safety_version: 4 });
    expect(container.textContent).toContain('409');
    expect(callsFor('/sessions/test-session-1/state').length).toBeGreaterThanOrEqual(1);
    // No automatic retry or different decision was submitted.
    expect(callsFor('/sessions/test-session-1/accept')).toHaveLength(1);
    expect(callsFor('/sessions/test-session-1/reject')).toHaveLength(0);
  });

  it('does not claim an unconfirmed decision definitely failed on 503', async () => {
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(200, analysisReport(String(body?.session_id))),
    );
    route('POST', '/api/sessions/test-session-1/accept', () =>
      fakeResponse(503, { detail: 'store unavailable' }),
    );
    route('GET', '/api/sessions/test-session-1/state', () =>
      fakeResponse(200, {
        session_id: 'test-session-1',
        status: 'active',
        safety_latched: false,
        safety_version: 1,
        input_version: 1,
        proposal_id: 'test-session-1:1',
        proposal_status: 'pending',
        decided_at: null,
        persist_history: false,
        report_recoverable: false,
        expires_at: '2030-01-01T00:00:00+00:00',
      }),
    );
    await renderApp();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    await click(findButton('确认下一组计划'));

    expect(container.textContent).toContain('可能已经提交');
    expect(callsFor('/sessions/test-session-1/state').length).toBeGreaterThanOrEqual(1);
  });

  it('keeps a decision committed before discomfort but blocks the next group', async () => {
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(200, analysisReport(String(body?.session_id))),
    );
    route('POST', '/api/sessions/test-session-1/accept', () =>
      fakeResponse(200, {
        ...analysisReport('test-session-1'),
        proposal: {
          target_reps: 12,
          rest_seconds: 60,
          reason: 'ok',
          blocked: false,
          status: 'accepted',
          proposal_id: 'test-session-1:1',
          decided_at: '2026-01-01T00:00:00+00:00',
        },
      }),
    );
    route('POST', '/api/sessions/test-session-1/safety-events', (body) =>
      fakeResponse(200, {
        session_id: 'test-session-1',
        event_id: String(body?.event_id),
        event_type: 'safety.discomfort',
        safety_latched: true,
        safety_version: 1,
        status: 'active',
        duplicate: false,
      }),
    );

    await renderApp();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    await click(findButton('确认下一组计划'));
    await click(findButton('训练空间'));
    await toggle(discomfortInput());

    expect(container.textContent).toContain('此前已提交的计划决定仍保留');
    expect(findButton('本次训练已停止').disabled).toBe(true);
    // The safety event belongs to the same group as the committed decision.
    expect(callsFor('/safety-events')[0].url).toBe('/api/sessions/test-session-1/safety-events');
  });

  it('never lets a late analyze response override the local latch', async () => {
    const gate = deferred<FakeResponse>();
    route('POST', '/api/sessions/analyze', () => gate.promise);
    await renderApp();
    await click(findButton('开始 / 继续'));
    await act(async () => {
      findButton('结束本组并复盘').click();
      await flush();
    });
    await act(async () => {
      discomfortInput().click();
      await flush();
    });
    expect(container.textContent).toContain('本次训练已因不适停止');

    await act(async () => {
      gate.resolve(fakeResponse(200, analysisReport('test-session-1')));
      await flush();
    });
    await settle();
    expect(container.textContent).toContain('本次训练已因不适停止');
    expect(container.textContent).not.toContain('下一组建议');
    expect(findButton('本次训练已停止').disabled).toBe(true);
  });
});

describe('history semantics', () => {
  it('clearing history keeps the local latch and does not resurrect a report', async () => {
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(200, analysisReport(String(body?.session_id))),
    );
    route('POST', '/api/sessions/test-session-1/safety-events', (body) =>
      fakeResponse(200, {
        session_id: 'test-session-1',
        event_id: String(body?.event_id),
        event_type: 'safety.discomfort',
        safety_latched: true,
        safety_version: 1,
        status: 'active',
        duplicate: false,
      }),
    );
    route('DELETE', '/api/history', () => fakeResponse(200, { deleted: true }));
    route('GET', '/api/sessions/test-session-1/state', () =>
      fakeResponse(200, {
        session_id: 'test-session-1',
        status: 'active',
        safety_latched: true,
        safety_version: 1,
        input_version: 0,
        proposal_id: null,
        proposal_status: null,
        decided_at: null,
        persist_history: false,
        report_recoverable: false,
        expires_at: '2030-01-01T00:00:00+00:00',
      }),
    );

    await renderApp();
    await click(findButton('开始 / 继续'));
    await toggle(discomfortInput());
    await settle();
    expect(storedSafety()?.server_confirmed).toBe(true);

    await click(findButton('训练复盘'));
    await click(findButton('删除全部本机摘要'));
    expect(callsFor('/api/history')).toHaveLength(1);
    expect(container.textContent).toContain('本次训练已因不适');
    expect(storedSafety()).not.toBeNull();
    expect(container.textContent).not.toContain('下一组建议');
  });
});

describe('P1.1 recovery checking is fail-closed', () => {
  it('blocks start while the authoritative state request is still pending, then allows a clear state', async () => {
    sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({ session_id: 'restored' }));
    const gate = deferred<FakeResponse>();
    route('GET', '/api/sessions/restored/state', () => gate.promise);
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(200, analysisReport(String(body?.session_id))),
    );

    await renderApp();
    expect(container.textContent).toContain('正在核对服务端会话状态');
    expect(callsFor('/sessions/restored/state')).toHaveLength(1);
    const start = findButton('正在核对状态…');
    expect(start.disabled).toBe(true);
    await forceClick(start);
    expect(container.textContent).toContain('核对完成前不能开始训练');
    expect(callsFor('/sessions/analyze')).toHaveLength(0);

    await act(async () => {
      gate.resolve(fakeResponse(200, statePayload('restored')));
      await flush();
    });
    await settle();
    expect(findButton('开始 / 继续').disabled).toBe(false);
    await click(findButton('开始 / 继续'));
    expect(storedSession()?.session_id).toBe('restored');
  });

  it('keeps the group blocked when the recovery state says latched, with checking cleared', async () => {
    sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({ session_id: 'latched-restore' }));
    route('GET', '/api/sessions/latched-restore/state', () =>
      fakeResponse(
        200,
        statePayload('latched-restore', { safety_latched: true, safety_version: 4 }),
      ),
    );
    await renderApp();
    expect(findButton('本次训练已停止').disabled).toBe(true);
    expect(container.textContent).toContain('服务端已确认记录本次不适事件');
    expect(container.textContent).not.toContain('正在核对服务端会话状态');
    await forceClick(findButton('本次训练已停止'));
    expect(container.textContent).toContain('不能开始、继续或恢复本组');
    expect(callsFor('/sessions/analyze')).toHaveLength(0);
  });

  it('stays unknown and blocked when the recovery state request fails', async () => {
    sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({ session_id: 'unknown-state' }));
    route('GET', '/api/sessions/unknown-state/state', () =>
      fakeResponse(503, { detail: 'store unavailable' }),
    );
    await renderApp();
    expect(container.textContent).toContain('无法确认服务端安全状态');
    expect(findButton('状态未确认').disabled).toBe(true);
    await forceClick(findButton('状态未确认'));
    expect(container.textContent).toContain('无法确认服务端安全状态');
    expect(callsFor('/sessions/analyze')).toHaveLength(0);
  });

  it('turns a recovery 404 into an explicit unrecoverable session that needs discard', async () => {
    sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({ session_id: 'missing-session' }));
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(200, analysisReport(String(body?.session_id))),
    );
    await renderApp();
    expect(container.textContent).toContain('会话无法恢复');
    expect(findButton('会话待处理').disabled).toBe(true);
    await forceClick(findButton('会话待处理'));
    expect(container.textContent).toContain('会话无法恢复');
    expect(callsFor('/sessions/analyze')).toHaveLength(0);

    await click(findButton('丢弃本组并创建新会话'));
    expect(storedSession()?.session_id).toBe('test-session-1');
    expect(container.textContent).not.toContain('会话无法恢复');
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    expect(callsFor('/sessions/analyze').map((call) => call.body?.session_id)).toEqual([
      'test-session-1',
    ]);
    expect(callsFor('/sessions/missing-session/analyze')).toHaveLength(0);
  });
});

describe('P1.2 sessionStorage failures are fail-closed', () => {
  it('does not start at all when sessionStorage cannot be written', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'QuotaExceededError');
    });
    await renderApp();
    expect(container.textContent).toContain('浏览器存储不可用');
    const start = findButton('存储不可用');
    expect(start.disabled).toBe(true);
    await forceClick(start);
    expect(container.textContent).toContain('浏览器无法持久化安全状态');
    expect(callsFor('/sessions/analyze')).toHaveLength(0);
    expect(storedSession()).toBeNull();
  });

  it('recovers the latch from the authoritative state when only the latch write failed', async () => {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === LOCAL_SAFETY_KEY) throw new DOMException('denied', 'QuotaExceededError');
      return original.call(this, key, value);
    });
    route('POST', '/api/sessions/test-session-1/safety-events', (body) =>
      fakeResponse(200, {
        session_id: 'test-session-1',
        event_id: String(body?.event_id),
        event_type: 'safety.discomfort',
        safety_latched: true,
        safety_version: 1,
        status: 'active',
        duplicate: false,
      }),
    );
    route('GET', '/api/sessions/test-session-1/state', () =>
      fakeResponse(
        200,
        statePayload('test-session-1', { safety_latched: true, safety_version: 1 }),
      ),
    );

    await renderApp();
    await click(findButton('开始 / 继续'));
    await toggle(discomfortInput());
    await settle();
    expect(container.textContent).toContain('浏览器无法持久化安全状态');
    expect(storedSafety()).toBeNull();

    // Simulated refresh: the latch key is missing, but the authoritative state is
    // re-read from the stored active session id and still blocks the page.
    await act(async () => {
      root.unmount();
    });
    container.remove();
    await renderApp();
    expect(container.textContent).toContain('本次训练已因不适停止');
    // The latch key write still fails, so the storage gate itself also blocks the
    // page; either way the group cannot be restarted after the simulated reload.
    expect(findButton('存储不可用').disabled).toBe(true);
    expect(storedSafety()).toBeNull();
  });

  it('cannot be bypassed after reload when both storage writes and the safety network fail', async () => {
    await renderApp();
    await click(findButton('开始 / 继续'));
    expect(storedSession()?.session_id).toBe('test-session-1');

    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === ACTIVE_SESSION_KEY || key === LOCAL_SAFETY_KEY)
        throw new DOMException('denied', 'QuotaExceededError');
      return original.call(this, key, value);
    });
    route('POST', '/api/sessions/test-session-1/safety-events', () =>
      fakeResponse(503, { detail: 'store unavailable' }),
    );
    await toggle(discomfortInput());
    await settle();
    expect(container.textContent).toContain('浏览器无法持久化安全状态');
    expect(container.textContent).toContain('本次训练已因不适停止');

    await act(async () => {
      root.unmount();
    });
    container.remove();
    // The storage fault itself (probe) keeps the page fail-closed after reload.
    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'QuotaExceededError');
    });
    await renderApp();
    expect(container.textContent).toContain('浏览器存储不可用');
    const start = findButton('存储不可用');
    expect(start.disabled).toBe(true);
    await forceClick(start);
    expect(container.textContent).toContain('浏览器无法持久化安全状态');
    expect(callsFor('/sessions/analyze')).toHaveLength(0);
  });

  it('honours a stored latch key even when the active-session key is missing', async () => {
    sessionStorage.setItem(
      LOCAL_SAFETY_KEY,
      JSON.stringify({
        session_id: 'latch-only',
        event_id: 'event-latch-only',
        server_confirmed: true,
        safety_version: 2,
      }),
    );
    route('GET', '/api/sessions/latch-only/state', () =>
      fakeResponse(200, statePayload('latch-only', { safety_latched: true, safety_version: 2 })),
    );
    await renderApp();
    expect(container.textContent).toContain('本次训练已因不适停止');
    expect(findButton('本次训练已停止').disabled).toBe(true);
    // The missing active-session identity is re-persisted best-effort, but the
    // authoritative latch remains the source of truth either way.
    expect(sessionStorage.getItem(ACTIVE_SESSION_KEY)).toContain('latch-only');
  });
});

describe('P1.3 late explanation responses are ignored', () => {
  it('never shows an explanation response that arrives after discomfort', async () => {
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(200, analysisReport(String(body?.session_id))),
    );
    const explanationGate = deferred<FakeResponse>();
    route('POST', '/api/sessions/test-session-1/explanation', () => explanationGate.promise);
    route('POST', '/api/sessions/test-session-1/safety-events', (body) =>
      fakeResponse(200, {
        session_id: 'test-session-1',
        event_id: String(body?.event_id),
        event_type: 'safety.discomfort',
        safety_latched: true,
        safety_version: 1,
        status: 'active',
        duplicate: false,
      }),
    );
    route('GET', '/api/sessions/test-session-1/state', () =>
      fakeResponse(200, statePayload('test-session-1', { input_version: 1 })),
    );

    await renderApp();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    await click(findButton('查看解释'));
    expect(callsFor('/explanation')).toHaveLength(1);

    await toggle(discomfortInput());
    await settle();
    await act(async () => {
      explanationGate.resolve(
        fakeResponse(200, {
          text: 'ADVICE-THAT-MUST-NOT-APPEAR',
          runtime: 'deterministic',
          input_version: 1,
          safety_latched: false,
          safety_version: 1,
        }),
      );
      await flush();
    });
    await settle();
    expect(container.textContent).not.toContain('ADVICE-THAT-MUST-NOT-APPEAR');
    expect(container.textContent).toContain('本次训练已因不适停止');
    expect(container.textContent).toContain('本组报告生成于安全锁存之前');
  });
});

describe('P1.4 analysis/discomfort races and recovery', () => {
  it('keeps a generated report as pre-latch evidence and blocks decisions', async () => {
    let latched = false;
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(200, analysisReport(String(body?.session_id))),
    );
    route('POST', '/api/sessions/test-session-1/safety-events', (body) =>
      fakeResponse(200, {
        session_id: 'test-session-1',
        event_id: String(body?.event_id),
        event_type: 'safety.discomfort',
        safety_latched: true,
        safety_version: 1,
        status: 'active',
        duplicate: false,
      }),
    );
    route('GET', '/api/sessions/test-session-1/state', () =>
      latched
        ? fakeResponse(
            200,
            statePayload('test-session-1', {
              safety_latched: true,
              safety_version: 1,
              input_version: 1,
              proposal_status: 'pending',
            }),
          )
        : fakeResponse(404, { detail: 'not found' }),
    );

    await renderApp();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    expect(container.textContent).toContain('下一组建议');
    latched = true;
    await toggle(discomfortInput());
    await settle();
    expect(container.textContent).toContain('本次训练已因不适停止');
    expect(container.textContent).toContain('本组报告生成于安全锁存之前');
    expect(container.textContent).toContain('下一组建议');
    expect(findButton('确认下一组计划').disabled).toBe(true);
    expect(findButton('拒绝调整，保持原计划').disabled).toBe(true);
    expect(findButton('核对并恢复本组报告').disabled).toBe(false);
  });
  it('recovers a committed-but-lost analysis by replaying the same version and payload', async () => {
    let analyzeAttempt = 0;
    let committed = false;
    route('POST', '/api/sessions/analyze', (body) => {
      analyzeAttempt += 1;
      if (analyzeAttempt === 1) {
        committed = true;
        return Promise.reject(new TypeError('response lost after commit'));
      }
      return fakeResponse(200, blockedReport(String(body?.session_id)));
    });
    let latched = false;
    route('GET', '/api/sessions/test-session-1/state', () =>
      committed
        ? fakeResponse(
            200,
            statePayload('test-session-1', {
              safety_latched: latched,
              safety_version: latched ? 1 : 0,
              input_version: 1,
              proposal_status: latched ? 'blocked' : 'pending',
              report_recoverable: false,
            }),
          )
        : fakeResponse(404, { detail: 'not found' }),
    );
    route('POST', '/api/sessions/test-session-1/safety-events', (body) =>
      fakeResponse(200, {
        session_id: 'test-session-1',
        event_id: String(body?.event_id),
        event_type: 'safety.discomfort',
        safety_latched: true,
        safety_version: 1,
        status: 'active',
        duplicate: false,
      }),
    );

    await renderApp();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    await settle();
    // The server committed input_version=1 but the client only knows the version
    // from state; it must not resend a different payload as version 1.
    expect(container.textContent).toContain('分析提交状态待核对');
    latched = true;
    await toggle(discomfortInput());
    await settle();
    expect(container.textContent).toContain('本次训练已因不适停止');

    await click(findButton('核对并恢复本组报告'));
    expect(callsFor('/sessions/analyze')).toHaveLength(2);
    const bodies = callsFor('/sessions/analyze').map((call) => call.body);
    expect(bodies[0]?.input_version).toBe(1);
    expect(bodies[1]?.input_version).toBe(1);
    expect(bodies[1]?.discomfort).toBe(bodies[0]?.discomfort);
    expect(container.textContent).toContain('训练已暂停');
  });

  it('falls back to input_version+1 when the old payload is unavailable', async () => {
    let analyzeAttempt = 0;
    let committed = false;
    route('POST', '/api/sessions/analyze', (body) => {
      analyzeAttempt += 1;
      const version = Number(body?.input_version);
      if (analyzeAttempt === 1) {
        committed = true;
        return Promise.reject(new TypeError('response lost after commit'));
      }
      if (version === 1) return fakeResponse(409, { detail: 'payload unavailable' });
      return fakeResponse(200, blockedReport(String(body?.session_id), { input_version: version }));
    });
    route('GET', '/api/sessions/test-session-1/state', () =>
      committed
        ? fakeResponse(
            200,
            statePayload('test-session-1', {
              safety_latched: true,
              safety_version: 1,
              input_version: 1,
              proposal_status: 'blocked',
              report_recoverable: false,
            }),
          )
        : fakeResponse(404, { detail: 'not found' }),
    );
    route('POST', '/api/sessions/test-session-1/safety-events', (body) =>
      fakeResponse(200, {
        session_id: 'test-session-1',
        event_id: String(body?.event_id),
        event_type: 'safety.discomfort',
        safety_latched: true,
        safety_version: 1,
        status: 'active',
        duplicate: false,
      }),
    );

    await renderApp();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    await settle();
    await toggle(discomfortInput());
    await settle();
    await click(findButton('核对并恢复本组报告'));
    const versions = callsFor('/sessions/analyze').map((call) => call.body?.input_version);
    expect(versions[0]).toBe(1);
    expect(versions[versions.length - 1]).toBe(2);
    expect(container.textContent).toContain('训练已暂停');
  });
  it('retries version 1 when the aborted first analysis never committed', async () => {
    const firstGate = deferred<FakeResponse>();
    let analyzeCalls = 0;
    route('POST', '/api/sessions/analyze', (body) => {
      analyzeCalls += 1;
      if (analyzeCalls === 1) return firstGate.promise;
      return fakeResponse(200, blockedReport(String(body?.session_id)));
    });
    let committed = false;
    route('GET', '/api/sessions/test-session-1/state', () =>
      committed
        ? fakeResponse(
            200,
            statePayload('test-session-1', {
              safety_latched: true,
              safety_version: 1,
              input_version: null,
              proposal_status: null,
            }),
          )
        : fakeResponse(404, { detail: 'not found' }),
    );
    route('POST', '/api/sessions/test-session-1/safety-events', (body) => {
      committed = true;
      return fakeResponse(200, {
        session_id: 'test-session-1',
        event_id: String(body?.event_id),
        event_type: 'safety.discomfort',
        safety_latched: true,
        safety_version: 1,
        status: 'active',
        duplicate: false,
      });
    });

    await renderApp();
    await click(findButton('开始 / 继续'));
    await act(async () => {
      findButton('结束本组并复盘').click();
      await flush();
    });
    await settle();
    expect(callsFor('/sessions/analyze')).toHaveLength(1);
    await toggle(discomfortInput());
    await settle();
    // Resolve the aborted attempt with a normal report: it must not be adopted.
    await act(async () => {
      firstGate.resolve(fakeResponse(200, analysisReport('test-session-1')));
      await flush();
    });
    await settle();
    expect(container.textContent).toContain('本次训练已因不适停止');
    expect(container.textContent).not.toContain('下一组建议');

    await click(findButton('结束本组并复盘'));
    const bodies = callsFor('/sessions/analyze').map((call) => call.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.input_version).toBe(1);
    expect(bodies[0]?.discomfort).toBe(false);
    expect(bodies[1]?.input_version).toBe(1);
    expect(bodies[1]?.discomfort).toBe(true);
    expect(container.textContent).toContain('训练已暂停');
  });
});

describe('P2.1 session lifecycle on report-discarding actions', () => {
  it('retires a reported session on reset so the next group uses a new id', async () => {
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(
        200,
        analysisReport(String(body?.session_id), {
          input_version: Number(body?.input_version ?? 1),
        }),
      ),
    );
    await renderApp();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    expect(storedSession()?.session_id).toBe('test-session-1');

    await click(findButtonByAria('重置本组'));
    expect(storedSession()).toBeNull();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    expect(callsFor('/sessions/analyze').map((call) => call.body?.session_id)).toEqual([
      'test-session-1',
      'test-session-2',
    ]);
    expect(callsFor('/sessions/analyze').map((call) => call.body?.input_version)).toEqual([1, 1]);
  });

  it('retires a reported session on exercise, source and threshold changes', async () => {
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(
        200,
        analysisReport(String(body?.session_id), {
          input_version: Number(body?.input_version ?? 1),
        }),
      ),
    );
    await renderApp();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));

    const exerciseSelect = container.querySelector('#exercise') as HTMLSelectElement;
    await changeInput(exerciseSelect, 'jumping_jack');
    expect(storedSession()).toBeNull();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));

    await click(findButton('真实摄像头'));
    expect(storedSession()).toBeNull();
    await click(findButton('模拟演示'));
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));

    const threshold = inputFor('深蹲下降角度阈值') as HTMLInputElement;
    await changeInput(threshold, '115');
    expect(storedSession()).toBeNull();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));

    const sessions = callsFor('/sessions/analyze').map((call) => call.body?.session_id);
    expect(new Set(sessions).size).toBe(sessions.length);
    expect(sessions.length).toBe(4);
  });

  it('retires the session when history is deleted, avoiding a same-version conflict', async () => {
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(
        200,
        analysisReport(String(body?.session_id), {
          input_version: Number(body?.input_version ?? 1),
        }),
      ),
    );
    route('DELETE', '/api/history', () => fakeResponse(200, { deleted: true }));
    await renderApp();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    await click(findButton('训练复盘'));
    await click(findButton('删除全部本机摘要'));
    expect(storedSession()).toBeNull();

    await click(findButton('训练空间'));
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    const sessions = callsFor('/sessions/analyze').map((call) => call.body?.session_id);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).not.toBe(sessions[1]);
    expect(callsFor('/sessions/analyze').map((call) => call.body?.input_version)).toEqual([1, 1]);
  });
});

describe('P2.2 decision state recovery after 409/503', () => {
  it('adopts a committed decision from state after 409 and forbids the contrary decision', async () => {
    let decisionAttempted = false;
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(200, analysisReport(String(body?.session_id))),
    );
    route('POST', '/api/sessions/test-session-1/accept', () => {
      decisionAttempted = true;
      return fakeResponse(409, { detail: 'decision already finalized' });
    });
    route('GET', '/api/sessions/test-session-1/state', () =>
      decisionAttempted
        ? fakeResponse(
            200,
            statePayload('test-session-1', {
              input_version: 1,
              proposal_id: 'test-session-1:1',
              proposal_status: 'accepted',
              decided_at: '2026-01-01T00:00:00+00:00',
            }),
          )
        : fakeResponse(404, { detail: 'not found' }),
    );

    await renderApp();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    await click(findButton('确认下一组计划'));
    expect(container.textContent).toContain('服务端已提交本组决定');
    expect(container.textContent).toContain('不能用相反决定覆盖');
    expect(findButton('已确认并更新目标').disabled).toBe(true);
    expect(findButton('拒绝调整，保持原计划').disabled).toBe(true);
    expect(storedSession()).toBeNull();
  });

  it('keeps pending when 503 is followed by a pending authoritative state', async () => {
    let decisionAttempted = false;
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(200, analysisReport(String(body?.session_id))),
    );
    route('POST', '/api/sessions/test-session-1/accept', () => {
      decisionAttempted = true;
      return fakeResponse(503, { detail: 'store unavailable' });
    });
    route('GET', '/api/sessions/test-session-1/state', () =>
      decisionAttempted
        ? fakeResponse(
            200,
            statePayload('test-session-1', {
              input_version: 1,
              proposal_id: 'test-session-1:1',
              proposal_status: 'pending',
            }),
          )
        : fakeResponse(404, { detail: 'not found' }),
    );
    await renderApp();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    await click(findButton('确认下一组计划'));
    expect(container.textContent).toContain('可能已经提交');
    expect(container.textContent).toContain('确认下一组计划');
    expect(container.textContent).not.toContain('服务端已提交本组决定');
    expect(storedSession()?.session_id).toBe('test-session-1');
  });

  it('stays fail-closed when the post-503 state check also fails', async () => {
    let decisionAttempted = false;
    route('POST', '/api/sessions/analyze', (body) =>
      fakeResponse(200, analysisReport(String(body?.session_id))),
    );
    route('POST', '/api/sessions/test-session-1/accept', () => {
      decisionAttempted = true;
      return fakeResponse(503, { detail: 'store unavailable' });
    });
    route('GET', '/api/sessions/test-session-1/state', () =>
      decisionAttempted
        ? fakeResponse(503, { detail: 'store unavailable' })
        : fakeResponse(404, { detail: 'not found' }),
    );
    await renderApp();
    await click(findButton('开始 / 继续'));
    await click(findButton('结束本组并复盘'));
    await click(findButton('确认下一组计划'));
    expect(container.textContent).toContain('无法确认服务端安全状态');
    expect(findButton('确认下一组计划').disabled).toBe(true);
    expect(findButton('拒绝调整，保持原计划').disabled).toBe(true);
  });
});
