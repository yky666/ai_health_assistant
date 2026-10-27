import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(frontendDir, '..', 'backend');
const dbPath = process.env.LOCALFIT_E2E_DB || path.join(os.tmpdir(), 'localfit-e2e.sqlite3');
const outDir = process.env.LOCALFIT_E2E_OUT || path.join(os.tmpdir(), 'localfit-e2e-artifacts');

// NOTE: the config file is evaluated by the runner *and* each worker, so it must
// not delete/mutate the database here - that would race a running backend. The
// caller prepares a fresh DB path (see the evidence runner for FE-BE-01).

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: outDir,
  use: {
    baseURL: process.env.LOCALFIT_E2E_BASE || 'http://127.0.0.1:5173',
    channel: 'msedge',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: [
    {
      command: 'python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --log-level info',
      cwd: backendDir,
      url: 'http://127.0.0.1:8000/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...(process.env as Record<string, string>),
        LOCALFIT_DB_PATH: dbPath,
        LOCALFIT_SESSION_TTL_SECONDS: '86400',
      },
    },
    {
      command: 'npm run dev',
      cwd: frontendDir,
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 120_000,
      env: process.env as Record<string, string>,
    },
  ],
});
