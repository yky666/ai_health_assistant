// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { clearHistory } from './localCoach';

const poseMock = vi.hoisted(() => ({
  fail: true,
  calls: 0,
  detectThrows: false,
  detectCalls: 0,
}));
vi.mock('./pose', () => ({
  createPoseLandmarker: vi.fn(async () => {
    poseMock.calls += 1;
    if (poseMock.fail) throw new Error('simulated model load failure');
    return {
      close: vi.fn(),
      detectForVideo: vi.fn(() => {
        poseMock.detectCalls += 1;
        if (poseMock.detectThrows) throw new Error('simulated runtime inference failure');
        return { landmarks: [[]], worldLandmarks: [[]] };
      }),
    };
  }),
}));

const workerInstances: FailingWorker[] = [];
class FailingWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn(() => {
    // Fail the worker init, then let the app use its main-thread fallback.
    queueMicrotask(() => this.onerror?.(new Event('error') as ErrorEvent));
  });
  constructor() {
    workerInstances.push(this);
  }
}

const readyWorkers: ReadyThenErrorWorker[] = [];
class ReadyThenErrorWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn(() => {
    queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } } as MessageEvent));
  });
  constructor() {
    readyWorkers.push(this);
  }
}

let container: HTMLDivElement;
let root: Root | null = null;

const flush = async () => {
  await Promise.resolve();
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

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(text),
  );
  if (!found) throw new Error(`Button not found: ${text}`);
  return found as HTMLButtonElement;
}

async function click(element: HTMLButtonElement) {
  await act(async () => {
    element.click();
    await flush();
    await flush();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  poseMock.fail = true;
  poseMock.calls = 0;
  poseMock.detectThrows = false;
  poseMock.detectCalls = 0;
  workerInstances.length = 0;
  readyWorkers.length = 0;
  vi.stubGlobal('Worker', FailingWorker);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('crypto', { randomUUID: () => 'model-retry-session' });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
  });
  clearHistory();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pose model recovery', () => {
  it('shows retry after worker and main-thread fallback both fail', async () => {
    await renderApp();
    await act(async () => {
      await flush();
      await flush();
    });
    expect(workerInstances).toHaveLength(1);
    expect(poseMock.calls).toBe(1);
    expect(container.textContent).toContain('姿态模型加载失败');
    expect(button('重试模型加载')).toBeTruthy();
  });

  it('retries once, cleans the failed worker, and reaches main-thread success', async () => {
    await renderApp();
    await act(async () => {
      await flush();
      await flush();
    });
    expect(workerInstances).toHaveLength(1);
    const firstWorker = workerInstances[0];
    poseMock.fail = false;

    await click(button('重试模型加载'));
    await act(async () => {
      await flush();
      await flush();
    });

    expect(workerInstances).toHaveLength(2);
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(poseMock.calls).toBe(2);
    expect(container.textContent).not.toContain('姿态模型加载失败');
    expect([...container.querySelectorAll('button')].some((item) =>
      item.textContent?.includes('重试模型加载'),
    )).toBe(false);
  });

  it('does not start an infinite retry loop and allows another retry after a second failure', async () => {
    await renderApp();
    await act(async () => {
      await flush();
      await flush();
    });
    expect(workerInstances).toHaveLength(1);

    await click(button('重试模型加载'));
    await act(async () => {
      await flush();
      await flush();
    });
    expect(workerInstances).toHaveLength(2);
    expect(container.textContent).toContain('姿态模型加载失败');
    expect(button('重试模型加载')).toBeTruthy();
  });

  it('stops running when the main-thread detectForVideo path throws', async () => {
    poseMock.fail = false;
    poseMock.detectThrows = true;
    let rafCallback: ((now: number) => void) | null = null;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: (now: number) => void) => {
        rafCallback = callback;
        return 1;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Object.defineProperty(HTMLVideoElement.prototype, 'readyState', {
      configurable: true,
      get: () => 2,
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
      configurable: true,
      get: () => 1280,
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
      configurable: true,
      get: () => 720,
    });
    await renderApp();
    await act(async () => {
      await flush();
      await flush();
    });
    await click(button('真实摄像头'));
    await click(button('开始 / 继续'));
    expect(button('暂停')).toBeTruthy();
    expect(rafCallback).not.toBeNull();

    await act(async () => {
      rafCallback?.(performance.now());
      await flush();
    });

    expect(poseMock.detectCalls).toBeGreaterThan(0);
    expect(container.textContent).toContain('主线程姿态识别异常');
    expect(
      [...container.querySelectorAll('button')].some((item) =>
        item.textContent?.includes('暂停'),
      ),
    ).toBe(false);
  });
  it('stops running and invalidates the worker after a post-ready runtime error', async () => {
    vi.stubGlobal('Worker', ReadyThenErrorWorker);
    poseMock.fail = false;
    await renderApp();
    await act(async () => {
      await flush();
      await flush();
    });
    expect(readyWorkers).toHaveLength(1);
    await click(button('开始 / 继续'));
    expect(button('暂停')).toBeTruthy();

    await act(async () => {
      readyWorkers[0].onmessage?.({
        data: { type: 'error', message: 'runtime worker failure' },
      } as MessageEvent);
      await flush();
    });

    expect(container.textContent).toContain('姿态模型运行失败');
    expect(
      [...container.querySelectorAll('button')].some((item) =>
        item.textContent?.includes('暂停'),
      ),
    ).toBe(false);
    expect(readyWorkers[0].terminate).toHaveBeenCalledOnce();
    expect(button('重试模型加载')).toBeTruthy();

    // A queued old frame after the failure must not restart the timer.
    await act(async () => {
      readyWorkers[0].onmessage?.({
        data: { type: 'pose', points: [], worldPoints: [], generation: 0, activeElapsedMs: 1 },
      } as MessageEvent);
      await flush();
    });
    expect(
      [...container.querySelectorAll('button')].some((item) =>
        item.textContent?.includes('暂停'),
      ),
    ).toBe(false);
  });
});
