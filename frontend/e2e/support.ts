import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';

export const API = 'http://127.0.0.1:8000/api';

export type ApiCall = {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
};
export type ApiResponse = { method: string; url: string; status: number };

export type Tracker = {
  calls: ApiCall[];
  responses: ApiResponse[];
  pageErrors: string[];
  consoleErrors: string[];
  failedResources: { url: string; status?: number; failure?: string }[];
  analyze: Record<string, unknown>[];
  safety: Record<string, unknown>[];
  decisions: ApiCall[];
};

function recordBody(postData: string | null): Record<string, unknown> | null {
  if (!postData) return null;
  try {
    return JSON.parse(postData) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Observe all /api traffic and browser errors for evidence + assertions. */
export function trackApi(page: Page): Tracker {
  const tracker: Tracker = {
    calls: [],
    responses: [],
    pageErrors: [],
    consoleErrors: [],
    failedResources: [],
    analyze: [],
    safety: [],
    decisions: [],
  };
  page.on('request', (request) => {
    const url = request.url();
    if (!url.includes('/api/')) return;
    const body = recordBody(request.postData());
    const call = { method: request.method(), url, body };
    tracker.calls.push(call);
    if (url.endsWith('/sessions/analyze')) tracker.analyze.push(body ?? {});
    if (url.includes('/safety-events')) tracker.safety.push(body ?? {});
    if (url.endsWith('/accept') || url.endsWith('/reject')) tracker.decisions.push(call);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (!url.includes('/api/')) return;
    tracker.responses.push({ method: response.request().method(), url, status: response.status() });
  });
  page.on('pageerror', (error) => tracker.pageErrors.push(String(error)));
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/')) return;
    tracker.failedResources.push({
      url: request.url(),
      failure: request.failure()?.errorText ?? 'requestfailed',
    });
  });
  page.on('response', (response) => {
    if (!response.url().includes('/api/') && response.status() >= 400) {
      tracker.failedResources.push({ url: response.url(), status: response.status() });
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') tracker.consoleErrors.push(message.text());
  });
  return tracker;
}

export function dbFilePath(): string {
  const value = process.env.LOCALFIT_E2E_DB;
  if (!value) throw new Error('LOCALFIT_E2E_DB is not set for the test process');
  return value;
}

/** Query the isolated E2E SQLite database directly (final-state assertions). */
export function queryDb(sql: string): Record<string, unknown>[] {
  const script =
    'import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row; ' +
    'print(json.dumps([dict(r) for r in c.execute(sys.argv[2])]))';
  const out = execFileSync('python', ['-c', script, dbFilePath(), sql], { encoding: 'utf8' });
  return JSON.parse(out) as Record<string, unknown>[];
}

export function sessionIdFromRequest(url: string): string {
  const match = url.match(/\/sessions\/([^/]+)\//);
  return match ? decodeURIComponent(match[1]) : '';
}

export function summarize(tracker: Tracker) {
  return {
    apiCalls: tracker.calls.length,
    analyzeSessions: tracker.analyze.map((body) => body.session_id),
    safetyEvents: tracker.safety.map((body) => body.event_id),
    decisions: tracker.decisions.map((call) => ({ url: call.url, body: call.body })),
    responses: tracker.responses,
    pageErrors: tracker.pageErrors,
    consoleErrors: tracker.consoleErrors,
    failedResources: tracker.failedResources,
  };
}
