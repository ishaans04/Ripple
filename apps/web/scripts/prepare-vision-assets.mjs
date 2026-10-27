import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = dirname(fileURLToPath(import.meta.resolve('@mediapipe/tasks-vision')));
const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
if (metadata.version !== '1.1.1')
  throw new Error('Vision assets require the pinned MediaPipe 1.1.1 package');
const model = await readFile(join(root, 'public/vision/hand_landmarker_v1.task'));
const hash = createHash('sha256').update(model).digest('hex');
if (hash !== 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1') {
  throw new Error('Pinned hand-landmarker model checksum mismatch');
}
const destination = join(root, 'public/vision/mediapipe-1.1.1');
await mkdir(destination, { recursive: true });
for (const file of ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm']) {
  await copyFile(join(packageRoot, 'wasm', file), join(destination, file));
}
process.stdout.write('Prepared pinned MediaPipe module/WASM assets; model checksum verified.\n');
