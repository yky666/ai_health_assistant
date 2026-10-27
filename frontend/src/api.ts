import {
  analyzeLocal,
  clearHistory,
  decideLocal,
  estimateFood,
  reportFor,
  loadHistory,
  type LocalSummary,
} from './localCoach';
import { runtimeMode } from './runtime';
import type { Report, SafetyEventReceipt, SessionState } from './types';
import contract from '../../shared/contract.json';

/** Typed HTTP error so the UI can react to 409/410/503 semantics safely. */
export class ApiError extends Error {
  readonly status: number;
  readonly bodyText: string;

  constructor(status: number, bodyText: string) {
    super(`本地后端请求失败 (${status})，未切换计算模式：${bodyText}`);
    this.name = 'ApiError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (runtimeMode === 'browser') return localRequest<T>(path, options);
  // Own the timeout so both cancellation sources work without AbortSignal.any/timeout.
  const controller = new AbortController();
  const userSignal = options.signal;
  const cancel = () => controller.abort(userSignal?.reason);
  if (userSignal?.aborted) {
    throw userSignal.reason ?? new DOMException('请求已取消。', 'AbortError');
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException('请求超过 25 秒。', 'TimeoutError')),
    25000,
  );
  userSignal?.addEventListener('abort', cancel, { once: true });
  try {
    const response = await fetch('/api' + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
      signal: controller.signal,
    });
    if (!response.ok) throw new ApiError(response.status, await response.text());
    return await response.json();
  } finally {
    clearTimeout(timer);
    userSignal?.removeEventListener('abort', cancel);
  }
}

export const decideReport = (report: Report, decision: 'accept' | 'reject', signal?: AbortSignal) =>
  request<Report>(`/sessions/${encodeURIComponent(report.session_id)}/${decision}`, {
    method: 'POST',
    signal,
    body: JSON.stringify({
      input_version: report.input_version,
      proposal_id: report.proposal.proposal_id,
      // Only backend reports carry a server safety version; send it when known.
      ...(report.safety_version != null
        ? { expected_safety_version: report.safety_version }
        : {}),
    }),
  });
export const acceptReport = (report: Report, signal?: AbortSignal) =>
  decideReport(report, 'accept', signal);

/** Report a discomfort event. `eventId` must be reused for retries of the same event. */
export const reportSafetyEvent = (
  sessionId: string,
  eventId: string,
  note?: string,
  signal?: AbortSignal,
) =>
  request<SafetyEventReceipt>(`/sessions/${encodeURIComponent(sessionId)}/safety-events`, {
    method: 'POST',
    signal,
    body: JSON.stringify({
      event_id: eventId,
      type: 'discomfort',
      ...(note ? { note } : {}),
    }),
  });

/** Authoritative session safety state (metadata only, never the full report). */
export const getSessionState = (sessionId: string, signal?: AbortSignal) =>
  request<SessionState>(`/sessions/${encodeURIComponent(sessionId)}/state`, { signal });

function localRequest<T>(path: string, options: RequestInit = {}): T {
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(String(options.body)) : null;
  if (path === '/health' && method === 'GET')
    return {
      status: 'browser',
      version: '0.2.0',
      schema_version: contract.schema_version,
      policy_version: contract.policy_version,
    } as T;
  // Backend-only safety endpoints must never be silently faked in the browser mode.
  if (path.endsWith('/safety-events') || path.endsWith('/state'))
    throw new Error('浏览器模式不调用后端安全接口。');
  if (path === '/sessions/analyze' && method === 'POST')
    return analyzeLocal(body as LocalSummary, options.signal ?? undefined) as T;
  const route = path.match(/^\/sessions\/([^/]+)\/(accept|reject|explanation)$/);
  if (route && method === 'POST') {
    const report = reportFor(route[1]);
    if (route[2] === 'explanation')
      return {
        text: report.proposal.reason,
        runtime: 'browser',
        input_version: report.input_version,
      } as T;
    return decideLocal(
      {
        ...report,
        input_version: body?.input_version,
        proposal: {
          ...report.proposal,
          proposal_id: body?.proposal_id ?? report.proposal.proposal_id,
        },
      },
      route[2] === 'accept' ? 'accepted' : 'rejected',
      options.signal ?? undefined,
    ) as T;
  }
  if (path === '/history' && method === 'GET') return loadHistory() as T;
  if (path === '/history' && method === 'DELETE') {
    clearHistory();
    return { deleted: true } as T;
  }
  if (path === '/nutrition/estimate' && method === 'POST') {
    const first = Array.isArray(body) ? body[0] : body;
    const entry = first ?? { query: '米饭', grams: 150 };
    return estimateFood(entry.query || entry.food_id || '', entry.grams, entry) as T;
  }
  throw new Error('浏览器模式不支持此接口。');
}
