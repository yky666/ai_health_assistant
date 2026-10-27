import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

export default defineConfig({
  base: env?.VITE_BASE || '/',
  plugins: [react()],
  worker: { format: 'iife' },
  server: { strictPort: true, proxy: { '/api': 'http://127.0.0.1:8000' } },
  // Browser E2E lives in e2e/ and is run by Playwright, not Vitest.
  test: { exclude: [...configDefaults.exclude, 'e2e/**'] },
});
