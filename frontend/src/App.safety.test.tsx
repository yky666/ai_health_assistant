// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App, { ACTIVE_SESSION_KEY, LOCAL_SAFETY_KEY } from './App';
import { clearHistory, latestReport, loadHistory } from './localCoach';

const apiMock = vi.hoisted(() => ({
  failAnalyze: false,
  deferAnalyze: false,
  analyzeGate: null as { promise: Promise<void>; resolve: () => void } | null,
  analyzeBody: '',
  deferDecision: false,
  decisionGate: null as { promise: Promise<void>; resolve: () => void } | null,
}));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    request: async (path: string, options: RequestInit = {}) => {
      if (apiMock.failAnalyze && path === '/sessions/analyze') throw new Error('模拟报告生成失败');
      if (apiMock.deferAnalyze && path === '/sessions/analyze') {
        apiMock.analyzeBody = String(options.body ?? '');
        await apiMock.analyzeGate!.promise;
      }
      return actual.request(path, options);
    },
    acceptReport: async (
      report: Parameters<typeof actual.acceptReport>[0],
      signal?: AbortSignal,
    ) => {
      if (apiMock.deferDecision) await apiMock.decisionGate!.promise;
      return actual.acceptReport(report, signal);
    },
    decideReport: async (
      report: Parameters<typeof actual.decideReport>[0],
      decision: 'accept' | 'reject',
      signal?: AbortSignal,
    ) => {
      if (apiMock.deferDecision) await apiMock.decisionGate!.promise;
      return actual.decideReport(report, decision, signal);
    },
  };
});

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage() {}
  terminate() {}
}

let container: HTMLDivElement;
let root: Root | null = null;
let sessionCounter = 0;
const mediaMock = { getUserMedia: vi.fn() };
let mediaTracks: { stop: ReturnType<typeof vi.fn> }[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeStream(tracks: { stop: ReturnType<typeof vi.fn> }[]) {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

async function renderApp() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<App />);
    await flush();
  });
}

function findButton(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button as HTMLButtonElement;
}

function discomfortInput(): HTMLInputElement {
  const label = [...container.querySelectorAll('label')].find((item) =>
    item.textContent?.includes('不适'),
  );
  const input = label?.querySelector('input');
  if (!input) throw new Error('Discomfort checkbox not found');
  return input as HTMLInputElement;
}

function inputFor(labelText: string): HTMLInputElement {
  const label = [...container.querySelectorAll('label')].find((item) =>
    item.textContent?.includes(labelText),
  );
  const input = label?.querySelector('input');
  if (!input) throw new Error(`Input not found: ${labelText}`);
  return input as HTMLInputElement;
}

function findButtonByAria(label: string): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Button not found by aria-label: ${label}`);
  return button as HTMLButtonElement;
}

function findFileInput(): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error('File input not found');
  return input as HTMLInputElement;
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
}

async function clickButton(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await flush();
  });
}

async function toggleCheckbox(input: HTMLInputElement) {
  await act(async () => {
    input.click();
    await flush();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.failAnalyze = false;
  apiMock.deferAnalyze = false;
  apiMock.analyzeGate = null;
  apiMock.analyzeBody = '';
  apiMock.deferDecision = false;
  apiMock.decisionGate = null;
  sessionCounter = 0;
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('crypto', {
    randomUUID: () => `test-session-${++sessionCounter}`,
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  mediaTracks = [];
  mediaMock.getUserMedia.mockReset();
  mediaMock.getUserMedia.mockResolvedValue(makeStream(mediaTracks));
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: mediaMock.getUserMedia },
  });
  clearHistory();
  sessionStorage.removeItem(ACTIVE_SESSION_KEY);
  sessionStorage.removeItem(LOCAL_SAFETY_KEY);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('discomfort safety latch', () => {
  it('stops immediately and ignores unchecking', async () => {
    await renderApp();
    await clickButton(findButton('开始 / 继续'));
    expect(findButton('暂停')).toBeTruthy();
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent?.includes('暂停')),
    ).toBe(true);

    await toggleCheckbox(discomfortInput());
    expect(container.textContent).toContain('本次训练已因不适停止');
    expect(findButton('本次训练已停止').disabled).toBe(true);
    expect(findButton('真实摄像头').disabled).toBe(true);
    expect(inputFor('本组目标次数').disabled).toBe(true);
    expect((container.querySelector('#exercise') as HTMLSelectElement).disabled).toBe(true);
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent?.includes('暂停')),
    ).toBe(false);

    await toggleCheckbox(discomfortInput());
    expect(discomfortInput().checked).toBe(false);
    expect(container.textContent).toContain('本次训练已因不适停止');
    expect(findButton('本次训练已停止').disabled).toBe(true);
    await clickButton(findButton('本次训练已停止'));
    expect(latestReport()).toBeNull();

    await clickButton(findButton('结束本组并复盘'));
    expect(latestReport()?.proposal.blocked).toBe(true);
  });

  it('keeps a paused session blocked after reporting discomfort', async () => {
    await renderApp();
    await clickButton(findButton('开始 / 继续'));
    await clickButton(findButton('暂停'));
    await toggleCheckbox(discomfortInput());

    expect(findButton('本次训练已停止').disabled).toBe(true);
    await clickButton(findButton('本次训练已停止'));
    expect(findButton('本次训练已停止').disabled).toBe(true);
    expect(latestReport()).toBeNull();
  });

  it('does not restore the session by switching source', async () => {
    await renderApp();
    await clickButton(findButton('开始 / 继续'));
    await toggleCheckbox(discomfortInput());

    const camera = findButton('真实摄像头');
    expect(camera.disabled).toBe(true);
    await clickButton(camera);
    expect(findButton('本次训练已停止').disabled).toBe(true);
    expect(container.textContent).toContain('本次训练已因不适停止');
  });

  it('finishes with blocked report and cannot accept, reject or finish twice', async () => {
    await renderApp();
    await clickButton(findButton('开始 / 继续'));
    await toggleCheckbox(discomfortInput());
    await clickButton(findButton('结束本组并复盘'));

    const first = latestReport();
    expect(first?.proposal.blocked).toBe(true);
    expect(container.textContent).toContain('训练已暂停');
    const accept = findButton('确认下一组计划');
    expect(accept.disabled).toBe(true);
    await clickButton(accept);
    expect(latestReport()?.proposal.status).toBe('blocked');
    expect(latestReport()?.proposal.decided_at).toBeNull();
    expect(findButton('拒绝调整，保持原计划').disabled).toBe(true);

    const finish = findButton('本次训练已结束');
    expect(finish.disabled).toBe(true);
    await clickButton(finish);
    expect(latestReport()?.session_id).toBe(first?.session_id);
    expect(latestReport()?.proposal.blocked).toBe(true);
  });

  it('keeps the block when report generation fails, then allows a blocked retry', async () => {
    await renderApp();
    await clickButton(findButton('开始 / 继续'));
    await toggleCheckbox(discomfortInput());
    apiMock.failAnalyze = true;
    await clickButton(findButton('结束本组并复盘'));
    expect(latestReport()).toBeNull();
    expect(container.textContent).toContain('本次训练已因不适停止');
    expect(findButton('本次训练已停止').disabled).toBe(true);

    apiMock.failAnalyze = false;
    await clickButton(findButton('结束本组并复盘'));
    expect(latestReport()?.proposal.blocked).toBe(true);
  });

  it('leaves the normal pause/continue/finish flow unchanged', async () => {
    await renderApp();
    await clickButton(findButton('开始 / 继续'));
    await clickButton(findButton('暂停'));
    await clickButton(findButton('开始 / 继续'));
    await clickButton(findButton('结束本组并复盘'));

    expect(latestReport()?.proposal.blocked).toBe(false);
    expect(container.textContent).toContain('下一组建议');
    expect(findButton('确认下一组计划').disabled).toBe(false);
  });

  it('stops every acquired camera track on discomfort and does not re-request it', async () => {
    const first = { stop: vi.fn() };
    const second = { stop: vi.fn() };
    mediaTracks = [first, second];
    mediaMock.getUserMedia.mockResolvedValue(makeStream(mediaTracks));
    await renderApp();

    await clickButton(findButton('真实摄像头'));
    expect(mediaMock.getUserMedia).toHaveBeenCalledTimes(1);

    await toggleCheckbox(discomfortInput());
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);
    expect(mediaMock.getUserMedia).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('本次训练已因不适停止');

    // Unchecking and reporting again must be safe; the stream is already released.
    await toggleCheckbox(discomfortInput());
    await toggleCheckbox(discomfortInput());
    expect(mediaMock.getUserMedia).toHaveBeenCalledTimes(1);
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);
  });

  it('releases a camera stream that resolves after the user reports discomfort', async () => {
    const track = { stop: vi.fn() };
    let resolveMedia!: (stream: MediaStream) => void;
    mediaMock.getUserMedia.mockReturnValue(
      new Promise<MediaStream>((resolve) => {
        resolveMedia = resolve;
      }),
    );
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    expect(mediaMock.getUserMedia).toHaveBeenCalledTimes(1);

    await toggleCheckbox(discomfortInput());
    await act(async () => {
      resolveMedia(makeStream([track]));
      await flush();
    });

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(mediaMock.getUserMedia).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('本次训练已因不适停止');
  });

  it('does not release the camera on ordinary pause, but does on discomfort', async () => {
    const track = { stop: vi.fn() };
    mediaTracks = [track];
    mediaMock.getUserMedia.mockResolvedValue(makeStream(mediaTracks));
    await renderApp();

    await clickButton(findButton('真实摄像头'));
    expect(mediaMock.getUserMedia).toHaveBeenCalledTimes(1);
    await clickButton(findButton('开始 / 继续'));
    await clickButton(findButton('暂停'));
    expect(track.stop).not.toHaveBeenCalled();
    await clickButton(findButton('开始 / 继续'));
    expect(track.stop).not.toHaveBeenCalled();

    await toggleCheckbox(discomfortInput());
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('executes the toggleRunning, reset and chooseSource guards by invoking their React handlers', async () => {
    await renderApp();
    await clickButton(findButton('开始 / 继续'));
    await toggleCheckbox(discomfortInput());

    await forceClick(findButton('本次训练已停止'));
    expect(container.textContent).toContain('不能开始、继续或恢复本组');
    expect(latestReport()).toBeNull();

    await forceClick(findButtonByAria('重置本组'));
    expect(container.textContent).toContain('不能通过重置恢复本组');

    await forceClick(findButton('真实摄像头'));
    expect(container.textContent).toContain('不能通过切换输入源恢复本组');
    expect(findButton('模拟演示').className).toContain('selected');
  });

  it('executes the onVideoFile guard after forcing the hidden file input', async () => {
    await renderApp();
    await toggleCheckbox(discomfortInput());
    const input = findFileInput();
    const file = new File(['not-a-real-video'], 'blocked.mp4', { type: 'video/mp4' });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
    });
    expect(container.textContent).toContain('不能通过上传视频恢复本组');
  });

  it('executes the accept, reject and finish guards for a blocked report', async () => {
    await renderApp();
    await clickButton(findButton('开始 / 继续'));
    await toggleCheckbox(discomfortInput());
    await clickButton(findButton('结束本组并复盘'));
    const first = latestReport();

    await forceClick(findButton('确认下一组计划'));
    expect(container.textContent).toContain('不能确认或应用下一组建议');
    expect(latestReport()?.proposal.status).toBe('blocked');
    expect(latestReport()?.proposal.decided_at).toBeNull();

    await forceClick(findButton('拒绝调整，保持原计划'));
    expect(container.textContent).toContain('不能确认或拒绝下一组建议');
    expect(latestReport()?.proposal.status).toBe('blocked');

    await forceClick(findButton('本次训练已结束'));
    expect(latestReport()?.session_id).toBe(first?.session_id);
    expect(latestReport()?.proposal.blocked).toBe(true);
  });

  it('does not commit an analyze result when discomfort arrives before the response', async () => {
    await renderApp();
    await toggleCheckbox(inputFor('同意在本机保存本次摘要'));
    await clickButton(findButton('开始 / 继续'));

    const gate = deferred();
    apiMock.deferAnalyze = true;
    apiMock.analyzeGate = gate;
    await clickButton(findButton('结束本组并复盘'));
    expect(apiMock.analyzeBody).toContain('"discomfort":false');

    await toggleCheckbox(discomfortInput());
    expect(latestReport()).toBeNull();

    await act(async () => {
      gate.resolve();
      await flush();
      await flush();
    });

    // The aborted local request must not write lastReport/history.
    expect(latestReport()).toBeNull();
    expect(loadHistory()).toEqual([]);
    expect(container.textContent).toContain('本次训练已因不适停止');
    expect(container.textContent).not.toContain('训练已暂停');

    // Retrying after the block must commit only a blocked report.
    apiMock.deferAnalyze = false;
    await clickButton(findButton('结束本组并复盘'));
    expect(latestReport()?.proposal.blocked).toBe(true);
    expect(loadHistory()).toHaveLength(1);
    expect(loadHistory()[0].proposal.blocked).toBe(true);
  });

  it.each([
    ['确认下一组计划', 'accepted'],
    ['拒绝调整，保持原计划', 'rejected'],
  ])(
    'does not commit %s when discomfort arrives before the decision response',
    async (buttonText, _expectedStatus) => {
      await renderApp();
      await toggleCheckbox(inputFor('同意在本机保存本次摘要'));
      await clickButton(findButton('开始 / 继续'));
      await clickButton(findButton('结束本组并复盘'));

      const gate = deferred();
      apiMock.deferDecision = true;
      apiMock.decisionGate = gate;
      await clickButton(findButton(buttonText));

      await clickButton(findButton('训练空间'));
      await toggleCheckbox(discomfortInput());
      await act(async () => {
        gate.resolve();
        await flush();
        await flush();
      });

      // The local decision was aborted before commit; the report stays pending.
      expect(latestReport()?.proposal.status).toBe('pending');
      expect(loadHistory()[0].proposal.status).toBe('pending');
      expect(container.textContent).toContain('本次训练已因不适停止');
      expect(container.textContent).not.toContain('NEXT SET');
      expect(container.querySelector('.rep-number')?.textContent).toContain('/ 12 次');
    },
  );

  it('keeps a decision committed before discomfort and labels it as retained', async () => {
    await renderApp();
    await toggleCheckbox(inputFor('同意在本机保存本次摘要'));
    await clickButton(findButton('开始 / 继续'));
    await clickButton(findButton('结束本组并复盘'));
    await clickButton(findButton('确认下一组计划'));
    expect(latestReport()?.proposal.status).toBe('accepted');

    await clickButton(findButton('训练空间'));
    await toggleCheckbox(discomfortInput());

    expect(latestReport()?.proposal.status).toBe('accepted');
    expect(loadHistory()[0].proposal.status).toBe('accepted');
    expect(container.textContent).toContain('此前已提交的计划决定仍保留');
    expect(findButton('本次训练已结束').disabled).toBe(true);
  });

  it('restores the browser-mode discomfort latch after a page reload', async () => {
    await renderApp();
    await clickButton(findButton('开始 / 继续'));
    await toggleCheckbox(discomfortInput());

    const storedSafety = JSON.parse(sessionStorage.getItem(LOCAL_SAFETY_KEY) ?? 'null');
    const storedSession = JSON.parse(sessionStorage.getItem(ACTIVE_SESSION_KEY) ?? 'null');
    expect(storedSafety).toMatchObject({
      session_id: expect.any(String),
      event_id: expect.any(String),
      server_confirmed: false,
      safety_version: null,
    });
    expect(storedSession).toMatchObject({
      session_id: storedSafety.session_id,
      safety_latched: true,
      event_id: storedSafety.event_id,
    });

    await act(async () => {
      root!.unmount();
    });
    root = null;
    container.remove();
    await renderApp();

    expect(discomfortInput().checked).toBe(true);
    expect(container.textContent).toContain('本次训练已因不适停止');
    expect(findButton('本次训练已停止').disabled).toBe(true);

    await toggleCheckbox(discomfortInput());
    expect(discomfortInput().checked).toBe(false);
    expect(findButton('本次训练已停止').disabled).toBe(true);
    expect(container.textContent).toContain('本次训练已因不适停止');
  });

  it('fails closed when browser safety storage is corrupt', async () => {
    sessionStorage.setItem(LOCAL_SAFETY_KEY, '{invalid-json');
    await renderApp();

    expect(container.textContent).toContain(
      '浏览器存储中的会话/安全状态无法可靠读取或已损坏',
    );
    await forceClick(findButton('开始 / 继续'));
    expect(
      [...container.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('暂停'),
      ),
    ).toBe(false);
    expect(container.textContent).toContain('本组保持阻断');
  });

  it('browser mode never calls the backend safety endpoints and keeps the local latch', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    await renderApp();
    await clickButton(findButton('开始 / 继续'));
    await toggleCheckbox(discomfortInput());
    await clickButton(findButton('结束本组并复盘'));

    // Pure browser mode: local report + local latch, no network request at all.
    expect(network).not.toHaveBeenCalled();
    expect(latestReport()?.proposal.blocked).toBe(true);
    expect(container.textContent).toContain('本次训练已因不适结束');
    expect(findButton('本次训练已停止').disabled).toBe(true);

    // Unchecking does not clear the latch.
    await toggleCheckbox(discomfortInput());
    expect(findButton('本次训练已停止').disabled).toBe(true);
  });
});

describe('history export', () => {
  function historyRecord(id: string, target = 12) {
    return {
      session_id: id,
      input_version: 1,
      source: 'simulation',
      coverage: 0.5,
      completion: 0.5,
      saved: true,
      rep_details: [],
      energy: { low_kcal: 1, high_kcal: 2, note: 'scenario' },
      proposal: {
        target_reps: target,
        rest_seconds: 60,
        reason: `reason-${id}`,
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
  }

  it('exports the records actually loaded from history, with complete report fields', async () => {
    sessionStorage.setItem(
      'localfit-browser-history',
      JSON.stringify([historyRecord('history-a', 10), historyRecord('history-b', 14)]),
    );
    let exportedBlob: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      exportedBlob = blob;
      return 'blob:history-test';
    });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.useFakeTimers();
    await renderApp();
    await clickButton(findButton('训练复盘'));
    await clickButton(findButton('读取已保存记录'));
    await clickButton(findButton('导出历史 JSON'));

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await flush();
    });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:history-test');
    vi.useRealTimers();
    expect(exportedBlob).not.toBeNull();
    const parsed = JSON.parse(await exportedBlob!.text()) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0].session_id).toBe('history-a');
    expect(parsed[0].source).toBe('simulation');
    expect(parsed[0].proposal).toMatchObject({ target_reps: 10, reason: 'reason-history-a' });
    expect(parsed[0].trace).toHaveLength(1);
  });

  it('does not fabricate a file when history is empty', async () => {
    const createObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await renderApp();
    await clickButton(findButton('训练复盘'));
    expect(findButton('导出历史 JSON').disabled).toBe(true);
    expect(container.textContent).toContain('历史尚未加载或为空');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('shows a clear error when history export cannot create a file', async () => {
    sessionStorage.setItem(
      'localfit-browser-history',
      JSON.stringify([historyRecord('history-failure')]),
    );
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => {
        throw new Error('blob unavailable');
      }),
    });
    await renderApp();
    await clickButton(findButton('训练复盘'));
    await clickButton(findButton('读取已保存记录'));
    await clickButton(findButton('导出历史 JSON'));
    expect(container.textContent).toContain('导出历史失败');
  });

  it('keeps the explicit current target when deleting a report/history', async () => {
    await renderApp();
    const target = inputFor('本组目标次数');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(target, '17');
      target.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });
    await toggleCheckbox(inputFor('同意在本机保存本次摘要'));
    await clickButton(findButton('开始 / 继续'));
    await clickButton(findButton('结束本组并复盘'));
    expect(latestReport()).not.toBeNull();
    expect(loadHistory()).toHaveLength(1);

    await clickButton(findButton('训练复盘'));
    await clickButton(findButton('删除全部本机摘要'));
    expect(loadHistory()).toEqual([]);
    expect(latestReport()).toBeNull();
    expect(container.textContent).toContain('当前训练目标保持不变');
    expect(inputFor('本组目标次数').value).toBe('17');
  });

  it('does not reset the target when clearing history without a report', async () => {
    await renderApp();
    const target = inputFor('本组目标次数');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(target, '21');
      target.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });
    await clickButton(findButton('训练复盘'));
    await clickButton(findButton('删除全部本机摘要'));
    expect(inputFor('本组目标次数').value).toBe('21');
    expect(container.textContent).toContain('当前训练目标和会话保持不变');
  });
});

describe('camera track interruption', () => {
  type Track = {
    stop: ReturnType<typeof vi.fn>;
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
    emit: (type: string) => void;
    listenerCount: () => number;
  };

  function makeTrack(): Track {
    const listeners = new Set<() => void>();
    return {
      stop: vi.fn(),
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      emit: (type) => {
        if (type === 'ended') [...listeners].forEach((listener) => listener());
      },
      listenerCount: () => listeners.size,
    };
  }

  function makeVideoStream(tracks: Track[]) {
    return {
      getTracks: () => tracks,
      getVideoTracks: () => tracks,
    } as unknown as MediaStream;
  }

  it('stops training and offers reconnect when an active camera track ends', async () => {
    const track = makeTrack();
    mediaMock.getUserMedia.mockResolvedValue(makeVideoStream([track]));
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    await clickButton(findButton('开始 / 继续'));
    expect(findButton('暂停')).toBeTruthy();

    await act(async () => {
      track.emit('ended');
      await flush();
    });

    expect(container.textContent).toContain('摄像头连接已中断');
    expect([...container.querySelectorAll('button')].some((item) =>
      item.textContent?.includes('暂停'),
    )).toBe(false);
    expect(findButton('重新连接摄像头并重置本组')).toBeTruthy();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(track.listenerCount()).toBe(0);

    // A duplicate ended event after cleanup must not duplicate the interruption.
    await act(async () => {
      track.emit('ended');
      await flush();
    });
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('does not turn a normal source stop into a camera interruption', async () => {
    const track = makeTrack();
    mediaMock.getUserMedia.mockResolvedValue(makeVideoStream([track]));
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    await clickButton(findButton('开始 / 继续'));
    await clickButton(findButton('暂停'));
    await clickButton(findButton('模拟演示'));
    expect(track.listenerCount()).toBe(0);
    await act(async () => {
      track.emit('ended');
      await flush();
    });
    expect(container.textContent).not.toContain('摄像头连接已中断');
    expect(container.textContent).not.toContain('本次训练已停止');
  });

  it('reconnects explicitly and resets the interrupted group count', async () => {
    const first = makeTrack();
    const second = makeTrack();
    mediaMock.getUserMedia
      .mockResolvedValueOnce(makeVideoStream([first]))
      .mockResolvedValueOnce(makeVideoStream([second]));
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    await clickButton(findButton('开始 / 继续'));
    await act(async () => {
      first.emit('ended');
      await flush();
    });
    expect(container.textContent).toContain('摄像头连接已中断');

    await clickButton(findButton('重新连接摄像头并重置本组'));
    expect(container.textContent).toContain('摄像头已重新连接；本组计数已重置');
    expect(findButton('开始 / 继续')).toBeTruthy();
    expect(second.listenerCount()).toBe(1);
    expect(container.textContent).not.toContain('摄像头连接已中断');
  });

  it('shares one in-flight camera request between source effect and start', async () => {
    let resolveMedia!: (stream: MediaStream) => void;
    const track = makeTrack();
    mediaMock.getUserMedia.mockReturnValue(
      new Promise<MediaStream>((resolve) => {
        resolveMedia = resolve;
      }),
    );
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    expect(mediaMock.getUserMedia).toHaveBeenCalledTimes(1);
    await clickButton(findButton('开始 / 继续'));
    expect(mediaMock.getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveMedia(makeVideoStream([track]));
      await flush();
    });
    expect(mediaMock.getUserMedia).toHaveBeenCalledTimes(1);
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('cleans up an initial camera stream when video.play() fails', async () => {
    const track = makeTrack();
    mediaMock.getUserMedia.mockResolvedValue(makeVideoStream([track]));
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValueOnce(
      new Error('play rejected'),
    );
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    await act(async () => {
      await flush();
    });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(track.listenerCount()).toBe(0);
    expect(container.textContent).toContain('无法播放摄像头画面');
    expect(findButton('重新连接摄像头并重置本组')).toBeTruthy();
  });

  it('cleans up a reconnect stream when video.play() fails', async () => {
    const first = makeTrack();
    const second = makeTrack();
    mediaMock.getUserMedia
      .mockResolvedValueOnce(makeVideoStream([first]))
      .mockResolvedValueOnce(makeVideoStream([second]));
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    await act(async () => {
      first.emit('ended');
      await flush();
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValueOnce(
      new Error('reconnect play rejected'),
    );
    await clickButton(findButton('重新连接摄像头并重置本组'));
    expect(second.stop).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('无法播放摄像头画面');
    expect(container.textContent).not.toContain('摄像头已重新连接');
  });

  it('does not show reconnect success when a safety gate rejects reset', async () => {
    const first = makeTrack();
    const second = makeTrack();
    mediaMock.getUserMedia
      .mockResolvedValueOnce(makeVideoStream([first]))
      .mockResolvedValueOnce(makeVideoStream([second]));
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    await act(async () => {
      first.emit('ended');
      await flush();
    });
    // Safe block is a state gate that reset() must not bypass.
    await toggleCheckbox(discomfortInput());
    await clickButton(findButton('重新连接摄像头并重置本组'));
    expect(container.textContent).not.toContain('摄像头已重新连接');
    expect(container.textContent).toContain('本次训练已因不适停止');
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it('removes camera listeners on component unmount', async () => {
    const track = makeTrack();
    mediaMock.getUserMedia.mockResolvedValue(makeVideoStream([track]));
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    expect(track.listenerCount()).toBe(1);
    await act(async () => {
      root!.unmount();
      root = null;
      await flush();
    });
    expect(track.listenerCount()).toBe(0);
  });

  it('stops a reconnect stream that resolves after component unmount', async () => {
    const first = makeTrack();
    const late = makeTrack();
    let resolveLate!: (stream: MediaStream) => void;
    mediaMock.getUserMedia
      .mockResolvedValueOnce(makeVideoStream([first]))
      .mockReturnValueOnce(
        new Promise<MediaStream>((resolve) => {
          resolveLate = resolve;
        }),
      );
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    await act(async () => {
      first.emit('ended');
      await flush();
    });
    await clickButton(findButton('重新连接摄像头并重置本组'));
    expect(mediaMock.getUserMedia).toHaveBeenCalledTimes(2);

    await act(async () => {
      root!.unmount();
      root = null;
      await flush();
    });
    await act(async () => {
      resolveLate(makeVideoStream([late]));
      await flush();
    });

    expect(late.stop).toHaveBeenCalledOnce();
    expect(late.listenerCount()).toBe(0);
    expect(container.textContent).not.toContain('摄像头已重新连接');
  });

  it('does not install a reconnect stream that resolves after switching to simulation', async () => {
    const first = makeTrack();
    const late = makeTrack();
    let resolveLate!: (stream: MediaStream) => void;
    mediaMock.getUserMedia
      .mockResolvedValueOnce(makeVideoStream([first]))
      .mockReturnValueOnce(
        new Promise<MediaStream>((resolve) => {
          resolveLate = resolve;
        }),
      );
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    await act(async () => {
      first.emit('ended');
      await flush();
    });
    await clickButton(findButton('重新连接摄像头并重置本组'));
    await clickButton(findButton('模拟演示'));
    expect(findButton('模拟演示').className).toContain('selected');

    await act(async () => {
      resolveLate(makeVideoStream([late]));
      await flush();
    });

    expect(late.stop).toHaveBeenCalledOnce();
    expect(late.listenerCount()).toBe(0);
    expect(container.textContent).not.toContain('摄像头已重新连接');
    expect(findButton('模拟演示').className).toContain('selected');
  });

  it('keeps an in-flight camera request alive when the selected camera is clicked again', async () => {
    const track = makeTrack();
    const stream = makeVideoStream([track]);
    let resolveMedia!: (media: MediaStream) => void;
    mediaMock.getUserMedia.mockReturnValue(
      new Promise<MediaStream>((resolve) => {
        resolveMedia = resolve;
      }),
    );
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    expect(mediaMock.getUserMedia).toHaveBeenCalledTimes(1);
    await clickButton(findButton('真实摄像头'));
    expect(mediaMock.getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveMedia(stream);
      await flush();
    });

    const video = container.querySelector('video') as HTMLVideoElement;
    expect(track.stop).not.toHaveBeenCalled();
    expect(track.listenerCount()).toBe(1);
    expect(video.srcObject).toBe(stream);
    expect(findButton('真实摄像头').className).toContain('selected');
  });

  it('does not release or re-request a connected camera when its selected entry is clicked again', async () => {
    const track = makeTrack();
    const stream = makeVideoStream([track]);
    mediaMock.getUserMedia.mockResolvedValue(stream);
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    await act(async () => {
      await flush();
    });
    expect(track.listenerCount()).toBe(1);
    expect(track.stop).not.toHaveBeenCalled();

    await clickButton(findButton('真实摄像头'));
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(mediaMock.getUserMedia).toHaveBeenCalledTimes(1);
    expect(track.stop).not.toHaveBeenCalled();
    expect(track.listenerCount()).toBe(1);
    expect(video.srcObject).toBe(stream);
    expect(findButton('真实摄像头').className).toContain('selected');
  });

  it('releases the old camera stream and listeners when switching to simulation', async () => {
    const track = makeTrack();
    const stream = makeVideoStream([track]);
    mediaMock.getUserMedia.mockResolvedValue(stream);
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    await act(async () => {
      await flush();
    });
    expect(track.listenerCount()).toBe(1);
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.srcObject).toBe(stream);

    await clickButton(findButton('模拟演示'));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(track.listenerCount()).toBe(0);
    expect(video.srcObject).toBeNull();
    expect(findButton('模拟演示').className).toContain('selected');
  });

  it('offers an explicit reconnect path after initial camera acquisition fails', async () => {
    const track = makeTrack();
    const stream = makeVideoStream([track]);
    mediaMock.getUserMedia
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce(stream);
    await renderApp();
    await clickButton(findButton('真实摄像头'));
    expect(container.textContent).toContain('无法打开摄像头');
    expect(findButton('重新连接摄像头并重置本组')).toBeTruthy();

    await clickButton(findButton('重新连接摄像头并重置本组'));
    expect(container.textContent).toContain('摄像头已重新连接');
    expect(track.listenerCount()).toBe(1);
    expect(track.stop).not.toHaveBeenCalled();
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.srcObject).toBe(stream);
  });
});
