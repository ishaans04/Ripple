import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
const output = new URL('../public/licenses/', import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(
  new URL('README.md', output),
  (await readFile(new URL('../../../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')).replace(
    '(docs/licenses/npm-runtime.json)',
    '(npm-runtime.json)',
  ),
);
await copyFile(
  new URL('../../../docs/licenses/npm-runtime.json', import.meta.url),
  new URL('npm-runtime.json', output),
);
