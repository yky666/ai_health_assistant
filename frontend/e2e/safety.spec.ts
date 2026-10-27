import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { API, queryDb, sessionIdFromRequest, summarize, trackApi, type Tracker } from './support';

/**
 * Real-browser acceptance: real Vite frontend + real FastAPI backend + isolated
 * temporary SQLite database (see playwright.config.ts).
 */
async function openBackend(page: Page) {
  await page.goto('/?runtime=backend');
  await expect(page.getByText('本地后端已连接')).toBeVisible();
}

async function reps(page: Page): Promise<number> {
  const text = await page.locator('.rep-number').first().innerText();
  const match = text.match(/\d+/);
  return match ? Number(match[0]) : 0;
}

async function startGroup(page: Page) {
  await page.getByRole('button', { name: /开始 \/ 继续/ }).click();
  await expect.poll(() => reps(page), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '暂停' })).toBeVisible();
}

async function finishGroup(page: Page) {
  await page.getByRole('button', { name: '结束本组并复盘' }).click();
}

async function latchByCheckbox(page: Page) {
  await page.locator('label:has-text("不适") input[type="checkbox"]').first().check();
}

async function sessionState(page: Page, sessionId: string) {
  const response = await page.request.get(`${API}/sessions/${encodeURIComponent(sessionId)}/state`);
  return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
}

async function evidence(testInfo: TestInfo, tracker: Tracker, extra: Record<string, unknown> = {}) {
  const payload = { ...summarize(tracker), ...extra };
  await testInfo.attach('api-and-db-evidence', {
    body: JSON.stringify(payload, null, 2),
    contentType: 'application/json',
  });
  console.log('[evidence]', JSON.stringify(payload));
}

test.describe('FE-BE-01 real browser integration', () => {
  test('A. normal training, report, decision, then a new session for the next group', async ({
    page,
  }, testInfo) => {
    const tracker = trackApi(page);
    await openBackend(page);
    await startGroup(page);
    await finishGroup(page);
    await expect(page.getByText('NEXT SET')).toBeVisible();

    const firstSession = String(tracker.analyze[0]?.session_id);
    expect(firstSession.length).toBeGreaterThan(0);

    await page.getByRole('button', { name: '确认下一组计划' }).click();
    await expect(page.getByRole('button', { name: /已确认并更新目标/ })).toBeVisible();
    expect(tracker.decisions).toHaveLength(1);
    expect(tracker.decisions[0].body).toMatchObject({
      input_version: 1,
      proposal_id: `${firstSession}:1`,
      expected_safety_version: 0, // a fresh backend session has no latch yet
    });

    // The next group must use a fresh session id.
    await page.getByRole('button', { name: '训练空间' }).click();
    await startGroup(page);
    await finishGroup(page);
    await expect(page.getByText('NEXT SET')).toBeVisible();

    expect(tracker.analyze).toHaveLength(2);
    const secondSession = String(tracker.analyze[1]?.session_id);
    expect(secondSession).not.toBe(firstSession);
    const state = await sessionState(page, secondSession);
    expect(state.status).toBe(200);
    expect(state.body.input_version).toBe(1);

    const rows = queryDb(
      `SELECT session_id, safety_latched, proposal_status FROM active_sessions
       WHERE session_id IN ('${firstSession}', '${secondSession}') ORDER BY rowid`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.safety_latched === 0)).toBe(true);

    await page.screenshot({ path: testInfo.outputPath('scenario-A-report.png') });
    await evidence(testInfo, tracker, { firstSession, secondSession, dbRows: rows });
    expect(tracker.pageErrors).toEqual([]);
  });

  test('B. discomfort during training stops immediately, latches the backend and blocks acceptance', async ({
    page,
  }, testInfo) => {
    const tracker = trackApi(page);
    await openBackend(page);
    await startGroup(page);
    await latchByCheckbox(page);

    // Local-first: the UI is blocked before/while the network request is in flight.
    await expect(page.getByText('本次训练已因不适停止')).toBeVisible();
    await expect(page.getByRole('button', { name: /本次训练已停止/ })).toBeDisabled();
    await expect(page.getByText(/服务端已确认记录本次不适事件/)).toBeVisible();

    expect(tracker.safety).toHaveLength(1);
    const sessionId = sessionIdFromRequest(
      tracker.calls.find((call) => call.url.includes('/safety-events'))!.url,
    );
    expect(sessionId.length).toBeGreaterThan(0);

    await expect
      .poll(async () => (await sessionState(page, sessionId)).body.safety_latched)
      .toBe(true);

    // The start/continue control is truly disabled in the browser (a real user
    // cannot click it), and the reset/source controls stay blocked as well.
    await expect(page.getByRole('button', { name: /本次训练已停止/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: '重置本组' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '真实摄像头' })).toBeDisabled();

    // Finishing produces the blocked report; accepting the plan is disabled.
    await finishGroup(page);
    await expect(page.getByText('训练已暂停')).toBeVisible();
    await expect(page.getByRole('button', { name: '确认下一组计划' })).toBeDisabled();

    const rows = queryDb(
      `SELECT safety_latched, safety_version, proposal_status FROM active_sessions
       WHERE session_id='${sessionId}'`,
    );
    expect(rows[0].safety_latched).toBe(1);
    expect(rows[0].safety_version).toBe(1);
    expect(rows[0].proposal_status).not.toBe('accepted');

    await page.screenshot({ path: testInfo.outputPath('scenario-B-blocked.png') });
    await evidence(testInfo, tracker, { sessionId, dbRows: rows });
    expect(tracker.pageErrors).toEqual([]);
  });

  test('C. failed safety-event sync keeps the local block and retries the same event id', async ({
    page,
  }, testInfo) => {
    const tracker = trackApi(page);
    let attempts = 0;
    await page.route('**/api/sessions/*/safety-events', async (route) => {
      attempts += 1;
      if (attempts === 1) await route.abort('failed');
      else await route.continue();
    });
    await openBackend(page);
    await startGroup(page);
    await latchByCheckbox(page);

    await expect(
      page.locator('p[role="status"]', { hasText: '服务端同步状态待确认' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /本次训练已停止/ })).toBeDisabled();
    expect(tracker.safety).toHaveLength(1);
    const eventId = String(tracker.safety[0].event_id);
    expect(eventId.length).toBeGreaterThan(0);

    await page.getByRole('button', { name: /重试服务端同步/ }).click();
    await expect(page.getByText(/服务端已确认记录本次不适事件/)).toBeVisible();
    expect(tracker.safety).toHaveLength(2);
    expect(tracker.safety[1].event_id).toBe(eventId); // same id, no duplicate event

    const sessionId = sessionIdFromRequest(
      tracker.calls.find((call) => call.url.includes('/safety-events'))!.url,
    );
    await expect
      .poll(async () => (await sessionState(page, sessionId)).body.safety_latched)
      .toBe(true);
    const rows = queryDb(
      `SELECT safety_latched, safety_version FROM active_sessions WHERE session_id='${sessionId}'`,
    );
    expect(rows[0].safety_latched).toBe(1);

    await page.screenshot({ path: testInfo.outputPath('scenario-C-retry.png') });
    await evidence(testInfo, tracker, { eventId, attempts, dbRows: rows });
    expect(tracker.pageErrors).toEqual([]);
  });

  test('D1. latch committed before the accept request: accept is rejected and stays blocked', async ({
    page,
  }, testInfo) => {
    const tracker = trackApi(page);
    await openBackend(page);
    await startGroup(page);
    await finishGroup(page);
    await expect(page.getByText('NEXT SET')).toBeVisible();
    const sessionId = String(tracker.analyze[0]?.session_id);

    // Deterministic "latch first": commit the real safety event through the
    // backend HTTP API and await its response *before* sending the accept
    // request. No sleep is used to guess the order.
    const latch = await page.request.post(
      `${API}/sessions/${encodeURIComponent(sessionId)}/safety-events`,
      { data: { event_id: 'e2e-race-latch', type: 'discomfort' } },
    );
    expect(latch.status()).toBe(200);
    expect(((await latch.json()) as { safety_latched: boolean }).safety_latched).toBe(true);

    const acceptResponse = page.waitForResponse(
      (response) => response.url().includes('/accept') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '确认下一组计划' }).click();
    expect((await acceptResponse).status()).toBe(409);

    await expect(page.getByText(/409/)).toBeVisible();
    // The report tab stays blocked: accept / reject / explanation are disabled.
    await expect(page.getByRole('button', { name: '确认下一组计划' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '拒绝调整，保持原计划' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '查看解释' })).toBeDisabled();
    // And the training tab cannot be restarted.
    await page.getByRole('button', { name: '训练空间' }).click();
    await expect(page.getByRole('button', { name: /本次训练已停止/ })).toBeDisabled();
    const rows = queryDb(
      `SELECT safety_latched, proposal_status FROM active_sessions WHERE session_id='${sessionId}'`,
    );
    expect(rows[0].safety_latched).toBe(1);
    expect(rows[0].proposal_status).not.toBe('accepted');

    await page.screenshot({ path: testInfo.outputPath('scenario-D1-latch-first.png') });
    await evidence(testInfo, tracker, { sessionId, dbRows: rows });
    expect(tracker.pageErrors).toEqual([]);
  });

  test('D2. decision committed before discomfort: decision kept, next group impossible', async ({
    page,
  }, testInfo) => {
    const tracker = trackApi(page);
    await openBackend(page);
    await startGroup(page);
    await finishGroup(page);
    await expect(page.getByText('NEXT SET')).toBeVisible();
    const sessionId = String(tracker.analyze[0]?.session_id);

    await page.getByRole('button', { name: '确认下一组计划' }).click();
    await expect(page.getByRole('button', { name: /已确认并更新目标/ })).toBeVisible();

    await page.getByRole('button', { name: '训练空间' }).click();
    await latchByCheckbox(page);
    await expect(page.getByText('此前已提交的计划决定仍保留')).toBeVisible();
    await expect(page.getByRole('button', { name: /本次训练已停止/ })).toBeDisabled();

    const rows = queryDb(
      `SELECT safety_latched, proposal_status, decided_at FROM active_sessions
       WHERE session_id='${sessionId}'`,
    );
    expect(rows[0].safety_latched).toBe(1);
    expect(rows[0].proposal_status).toBe('accepted');
    expect(rows[0].decided_at).toBeTruthy();
    const safetyRows = queryDb(
      `SELECT event_id FROM session_events WHERE session_id='${sessionId}'
       AND event_type='safety.discomfort'`,
    );
    expect(safetyRows.length).toBe(1);

    await page.screenshot({ path: testInfo.outputPath('scenario-D2-decision-first.png') });
    await evidence(testInfo, tracker, { sessionId, dbRows: rows, safetyRows });
    expect(tracker.pageErrors).toEqual([]);
  });

  test('E. reload restores the authoritative latch; clearing history keeps it and cannot revive the report', async ({
    page,
  }, testInfo) => {
    const tracker = trackApi(page);
    await openBackend(page);
    await page.locator('label:has-text("同意在本机保存本次摘要") input[type="checkbox"]').check();
    await startGroup(page);
    await latchByCheckbox(page);
    await expect(page.getByText(/服务端已确认记录本次不适事件/)).toBeVisible();
    await finishGroup(page);
    await expect(page.getByText('训练已暂停')).toBeVisible();
    const sessionId = sessionIdFromRequest(
      tracker.calls.find((call) => call.url.includes('/safety-events'))!.url,
    );

    // Reload: session id + local latch are restored, authoritative state re-read.
    await page.reload();
    await expect(page.getByText('本地后端已连接')).toBeVisible();
    await expect(page.getByText('本次训练已因不适停止')).toBeVisible();
    await expect(page.getByRole('button', { name: /本次训练已停止/ })).toBeDisabled();
    expect((await sessionState(page, sessionId)).body.safety_latched).toBe(true);

    // History is an archive snapshot; the row is marked as historical.
    await page.getByRole('button', { name: '训练复盘' }).click();
    await page.getByRole('button', { name: '读取已保存记录' }).click();
    await expect(page.locator('.history-row')).toHaveCount(1);
    await expect(page.locator('.history-row')).toContainText('已锁存（历史）');

    // Delete history: latch stays, report does not come back.
    await page.getByRole('button', { name: '删除全部本机摘要' }).click();
    await expect(page.locator('.history-row')).toHaveCount(0);
    await expect(page.getByText('本次训练已因不适停止')).toBeVisible();
    const history = await (await page.request.get(`${API}/history`)).json();
    expect(history).toEqual([]);
    expect((await sessionState(page, sessionId)).body.safety_latched).toBe(true);
    expect(queryDb(`SELECT * FROM sessions WHERE id='${sessionId}'`)).toHaveLength(0);

    // Reload again: no report is restored from a cache; the latch still holds.
    await page.reload();
    await expect(page.getByText('本次训练已因不适停止')).toBeVisible();
    await page.getByRole('button', { name: '训练复盘' }).click();
    await expect(page.getByText('完成第一组训练后，复盘会出现在这里。')).toBeVisible();
    await expect(page.locator('.history-row')).toHaveCount(0);

    const rows = queryDb(
      `SELECT safety_latched, proposal_status, report_json FROM active_sessions
       WHERE session_id='${sessionId}'`,
    );
    expect(rows[0].safety_latched).toBe(1);
    expect(rows[0].report_json).toBeNull();

    await page.screenshot({ path: testInfo.outputPath('scenario-E-history-cleared.png') });
    await evidence(testInfo, tracker, { sessionId, dbRows: rows });
    expect(tracker.pageErrors).toEqual([]);
  });

  test('F. pure browser mode trains and blocks locally without any backend traffic', async ({
    page,
  }, testInfo) => {
    const tracker = trackApi(page);
    await page.goto('/?runtime=browser');
    await expect(page.getByText('浏览器规则模式')).toBeVisible();
    await startGroup(page);
    await latchByCheckbox(page);
    await expect(page.getByText('本次训练已因不适停止')).toBeVisible();
    await expect(page.getByRole('button', { name: /本次训练已停止/ })).toBeDisabled();

    await finishGroup(page);
    await expect(page.getByText('训练已暂停')).toBeVisible();
    await expect(page.getByRole('button', { name: '确认下一组计划' })).toBeDisabled();

    // No API traffic at all: no safety-event upload, no training data upload.
    expect(tracker.calls).toHaveLength(0);

    await page.screenshot({ path: testInfo.outputPath('scenario-F-browser-only.png') });
    await evidence(testInfo, tracker, { browserOnly: true });
    expect(tracker.pageErrors).toEqual([]);
  });

  test('G. accept and safety event overlap at the client request layer (explicit barrier)', async ({
    page,
  }, testInfo) => {
    const tracker = trackApi(page);
    await openBackend(page);
    await startGroup(page);
    await finishGroup(page);
    await expect(page.getByText('NEXT SET')).toBeVisible();
    const sessionId = String(tracker.analyze[0]?.session_id);

    // Pause the browser accept request at the client boundary. While it is held,
    // commit the safety event over real HTTP, then release the accept request.
    // Ordering is controlled by explicit barriers, never by fixed sleeps.
    let releaseAccept!: () => void;
    const acceptBarrier = new Promise<void>((resolve) => {
      releaseAccept = resolve;
    });
    let acceptPaused = false;
    await page.route('**/api/sessions/*/accept', async (route) => {
      acceptPaused = true;
      await acceptBarrier;
      await route.continue();
    });
    await page.getByRole('button', { name: '确认下一组计划' }).click();
    await expect.poll(() => acceptPaused).toBeTruthy();

    const latch = await page.request.post(
      `${API}/sessions/${encodeURIComponent(sessionId)}/safety-events`,
      { data: { event_id: 'e2e-overlap-latch', type: 'discomfort' } },
    );
    expect(latch.status()).toBe(200);
    expect(((await latch.json()) as { safety_latched: boolean }).safety_latched).toBe(true);

    const acceptResponse = page.waitForResponse(
      (response) => response.url().includes('/accept') && response.request().method() === 'POST',
    );
    releaseAccept();
    expect((await acceptResponse).status()).toBe(409);

    // Both requests were in flight together; the latch won and the accept was
    // rejected. No accepted decision may exist.
    await expect(page.getByText(/409/)).toBeVisible();
    await page.getByRole('button', { name: '训练空间' }).click();
    await expect(page.getByRole('button', { name: /本次训练已停止/ })).toBeDisabled();
    const rows = queryDb(
      `SELECT safety_latched, proposal_status, decided_at FROM active_sessions
       WHERE session_id='${sessionId}'`,
    );
    expect(rows[0].safety_latched).toBe(1);
    expect(rows[0].proposal_status).not.toBe('accepted');
    expect(rows[0].decided_at).toBeNull();
    const safetyRows = queryDb(
      `SELECT event_id FROM session_events WHERE session_id='${sessionId}'
       AND event_type='safety.discomfort' AND event_id='client:safety:e2e-overlap-latch'`,
    );
    expect(safetyRows).toHaveLength(1);

    await page.screenshot({ path: testInfo.outputPath('scenario-G-overlap.png') });
    await evidence(testInfo, tracker, { sessionId, overlap: true, dbRows: rows, safetyRows });
    expect(tracker.pageErrors).toEqual([]);
  });

  test('H. analysis committed but response lost: recovery replays the same input_version without a duplicate commit', async ({
    page,
  }, testInfo) => {
    const tracker = trackApi(page);
    const sentBodies: Record<string, unknown>[] = [];
    let dropped = false;
    await page.route('**/api/sessions/analyze', async (route) => {
      sentBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      if (!dropped) {
        dropped = true;
        // Real HTTP: the backend commits the analysis, then the client response is
        // destroyed. This is not the same as a request that never reached the server.
        await route.fetch();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    await openBackend(page);
    await startGroup(page);
    await finishGroup(page);

    // The client only knows the response was lost; authoritative state reveals the
    // committed input_version and that the report is not persisted/recoverable.
    await expect(page.getByText('分析提交状态待核对')).toBeVisible();
    const sessionId = String(tracker.analyze[0]?.session_id);
    expect(sessionId.length).toBeGreaterThan(0);
    const committed = (await (
      await page.request.get(`${API}/sessions/${encodeURIComponent(sessionId)}/state`)
    ).json()) as Record<string, unknown>;
    expect(committed.input_version).toBe(1);
    expect(committed.report_recoverable).toBe(false);
    expect(committed.safety_latched).toBe(false);

    await page.locator('label:has-text("不适") input[type="checkbox"]').first().check();
    await expect(page.getByText(/服务端已确认记录本次不适事件/)).toBeVisible();
    await expect(page.getByRole('button', { name: /核对并恢复本组报告/ })).toBeVisible();

    await page.getByRole('button', { name: /核对并恢复本组报告/ }).click();
    await expect(page.getByText('训练已暂停')).toBeVisible();
    await expect(page.getByRole('button', { name: '确认下一组计划' })).toBeDisabled();

    // The recovery must replay version 1 with identical content; it must not send a
    // different summary under the same version, nor silently create a new one.
    expect(sentBodies.length).toBe(2);
    expect(sentBodies[0].input_version).toBe(1);
    expect(sentBodies[1].input_version).toBe(1);
    expect(sentBodies[1]).toEqual(sentBodies[0]);
    const rows = queryDb(
      `SELECT input_version, safety_latched, proposal_status FROM active_sessions
       WHERE session_id='${sessionId}'`,
    );
    expect(rows[0].input_version).toBe(1);
    expect(rows[0].safety_latched).toBe(1);
    expect(rows[0].proposal_status).toBe('blocked');
    const analysisEvents = queryDb(
      `SELECT event_id FROM session_events WHERE session_id='${sessionId}'
       AND event_type='analysis.committed'`,
    );
    expect(analysisEvents).toHaveLength(1);

    await page.screenshot({ path: testInfo.outputPath('scenario-H-lost-response-recovery.png') });
    await evidence(testInfo, tracker, { sessionId, sentBodies, dbRows: rows, analysisEvents });
    expect(tracker.pageErrors).toEqual([]);
  });
});
