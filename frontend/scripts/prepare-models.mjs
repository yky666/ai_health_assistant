import { mkdir, writeFile, copyFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const url = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
// Pin the reviewed model artifact. The SHA-256 is a download digest, not an
// upstream signature; changing it requires a separate review decision.
const EXPECTED_SHA256 = '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a';
await mkdir(path.join(root, 'public/models'), { recursive: true });
await mkdir(path.join(root, 'public/wasm'), { recursive: true });
const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length < 100000) throw new Error('Model asset unexpectedly small');
const actualSha256 = createHash('sha256').update(bytes).digest('hex');
if (actualSha256 !== EXPECTED_SHA256) {
  throw new Error(
    `Model digest mismatch: expected ${EXPECTED_SHA256}, received ${actualSha256}. ` +
      'Review the source/version before changing the pinned digest; do not trust a downloaded digest automatically.',
  );
}
await writeFile(path.join(root, 'public/models/pose_landmarker_lite.task'), bytes);
const assets = [];
for (const file of await readdir(path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm'))) {
  if (/\.(js|wasm)$/.test(file)) {
    await copyFile(path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm', file), path.join(root, 'public/wasm', file));
    assets.push(file);
  }
}
await writeFile(path.join(root, 'public/models/manifest.json'), JSON.stringify({ source: url,
  model_card: 'https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf',
  license: 'Apache-2.0',
  sha256: EXPECTED_SHA256, bytes: bytes.length,
  prepared_at: new Date().toISOString(), wasm_assets: assets,
  note: 'Pinned download digest, not an independently trusted upstream signature. Review the official model card/license before redistribution.' }, null, 2));
console.log(`Prepared local model (${bytes.length} bytes, SHA-256 ${EXPECTED_SHA256}) and ${assets.length} WASM assets.`);
