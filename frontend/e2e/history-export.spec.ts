import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function startGroup(page: Page) {
  await page.getByRole('button', { name: /开始 \/ 继续/ }).click();
  await expect
    .poll(async () => {
      const text = await page.locator('.rep-number').first().innerText();
      const match = text.match(/\d+/);
      return match ? Number(match[0]) : 0;
    }, { timeout: 20_000 })
    .toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '暂停' })).toBeVisible();
}

async function finishGroup(page: Page) {
  await page.getByRole('button', { name: '结束本组并复盘' }).click();
  await expect(page.getByText('NEXT SET')).toBeVisible();
}

test.describe('history export (real browser download)', () => {
  test('downloads the persisted history records, not the current report cache', async ({
    page,
  }, testInfo) => {
    await page.goto('/?runtime=browser');
    await page.locator('label:has-text("同意在本机保存本次摘要") input').check();

    await startGroup(page);
    await finishGroup(page);
    await page.getByRole('button', { name: '训练空间' }).click();
    await startGroup(page);
    await finishGroup(page);

    await page.getByRole('button', { name: '训练复盘' }).click();
    await page.getByRole('button', { name: '读取已保存记录' }).click();
    await expect(page.locator('.history-row')).toHaveCount(2);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出历史 JSON' }).click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(path).not.toBeNull();
    const records = JSON.parse(await readFile(path!, 'utf8')) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      source: 'simulation',
      saved: true,
    });
    expect(records[0].proposal).toMatchObject({
      target_reps: expect.any(Number),
      rest_seconds: expect.any(Number),
      reason: expect.any(String),
    });
    expect(Array.isArray(records[0].trace)).toBe(true);
    expect((records[0].trace as unknown[]).length).toBeGreaterThan(0);

    await testInfo.attach('downloaded-history.json', {
      body: JSON.stringify(records, null, 2),
      contentType: 'application/json',
    });
  });
});
