import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
interface Entry {
  name?: string;
  version?: string;
  license?: string;
  dev?: boolean;
  link?: boolean;
  resolved?: string;
}
const lock = JSON.parse(await readFile('package-lock.json', 'utf8')) as {
  packages: Record<string, Entry>;
};
const dependencies = [];
for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) =>
  a.localeCompare(b, 'en'),
)) {
  if (!path.includes('node_modules/') || entry.dev || entry.link) continue;
  const name = entry.name ?? path.split('node_modules/').at(-1);
  const directory = resolve(path);
  const files = (await readdir(directory))
    .filter((file) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file))
    .sort();
  const notices = [];
  for (const file of files)
    notices.push({
      file,
      text: (await readFile(resolve(directory, file), 'utf8')).replace(/\r\n/g, '\n').trim(),
    });
  if (notices.length === 0 && (name === 'pg-types' || name === 'pgpass')) {
    const readme = await readFile(resolve(directory, 'README.md'), 'utf8');
    const section = /(?:^|\n)##\s+license\b[\s\S]*/i.exec(readme)?.[0]?.trim();
    if (!section) throw new Error(`Missing embedded license for ${name}`);
    notices.push({ file: 'README.md#license', text: section.replace(/\r\n/g, '\n') });
  }
  const fallback: Record<string, string> = {
    '@mediapipe/tasks-vision': 'apps/web/public/vision/MEDIAPIPE-LICENSE.txt',
    'drizzle-orm': 'docs/licenses/drizzle-orm-0.45.4.txt',
    'abstract-logging': 'docs/licenses/abstract-logging-2.0.1.txt',
  };
  const notice = fallback[name ?? ''];
  if (notices.length === 0 && notice)
    notices.push({
      file: notice,
      text: (await readFile(notice, 'utf8')).replace(/\r\n/g, '\n').trim(),
    });
  if (notices.length === 0)
    throw new Error(`Review and supply the missing license notice for ${name}`);
  dependencies.push({
    name,
    version: entry.version,
    license: entry.license ?? 'See package notice',
    source: entry.resolved ?? null,
    notices,
  });
}
const report = {
  scope:
    'Production JavaScript dependencies in package-lock.json; excludes Node/Debian image components and separately inventoried model/test assets.',
  dependencies,
};
const output = 'docs/licenses/npm-runtime.json',
  text = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if ((await readFile(output, 'utf8')) !== text)
    throw new Error(
      'Dependency notices differ. Run node tests/dependency-notices.ts and review licenses.',
    );
} else {
  await mkdir('docs/licenses', { recursive: true });
  await writeFile(output, text);
}
process.stdout.write(
  `${JSON.stringify({ packages: dependencies.length, missingNoticeFiles: dependencies.filter((entry) => entry.notices.length === 0).map((entry) => ({ name: entry.name, license: entry.license })) })}\n`,
);
