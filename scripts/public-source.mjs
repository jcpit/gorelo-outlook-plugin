import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deliberately enumerate files, never recursively copy a workspace or Git history.
export const SOURCE_FILES = Object.freeze([
  '.dockerignore', '.env.example', '.github/workflows/ci.yml', '.gitignore',
  '.gitleaksignore', '.railwayignore', 'Dockerfile', 'LICENSE', 'README.md', 'SECURITY.md',
  'PUBLIC_RELEASE.md', 'THIRD_PARTY_NOTICES.md', 'deploy.md', 'deploy-railway.md',
  'docs/images/workflow/README.md', 'docs/images/workflow/launch.png',
  'docs/images/workflow/review.png', 'docs/images/workflow/created.png',
  'docs/images/workflow/tickets.png', 'docs/images/workflow/assets.png',
  'docker-compose.remote.yml', 'index.html', 'manifest.xml', 'manifest.remote.xml',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
  'public/gorelo-mark.png', 'public/gorelo-mark.svg', 'public/icon.svg',
  'public/icon-16.png', 'public/icon-32.png', 'public/icon-64.png',
  'public/icon-80.png', 'public/icon-128.png', 'public/source-sans3-bold.ttf',
  'public/source-sans3-regular.ttf', 'public/source-sans3-semibold.ttf',
  'public/credits.html', 'public/licenses/npm-dependencies.md',
  'public/licenses/project-MIT.md',
  'public/licenses/source-sans-3-OFL.md',
  'server/access.ts', 'server/access.test.ts', 'server/app.ts', 'server/app.test.ts',
  'server/asset-presence.test.ts', 'server/asset-sort.test.ts',
  'server/attachment-retry.ts', 'server/attachment-retry.test.ts',
  'server/audit.ts', 'server/audit.test.ts', 'server/classifier.ts',
  'server/config.ts', 'server/config.test.ts', 'server/container-entry.mjs',
  'server/credits.test.ts',
  'server/goreloConnector.ts', 'server/goreloConnector.test.ts', 'server/index.ts',
  'server/outlook-host.test.ts', 'server/recipients.test.ts', 'server/schemas.ts',
  'server/ticket-creation.test.ts', 'server/ticket-status.test.ts',
  'src/asset-presence.ts', 'src/asset-sort.ts', 'src/auth.ts', 'src/browse.css',
  'src/browse.ts', 'src/gorelo-theme.css', 'src/icons.ts', 'src/linked.css',
  'src/mail.ts', 'src/main.ts', 'src/outlook-host.ts', 'src/recipients.ts',
  'src/recovery.css', 'src/scope.css', 'src/style.css', 'src/ticket-creation.ts',
  'src/ticket-status.ts', 'tests/outlook-host.mjs',
  'scripts/public-source.mjs', 'scripts/public-source.test.mjs',
  'scripts/licenses.mjs', 'scripts/licenses.test.mjs',
]);

export function checkContent(data, name) {
  // This is a tripwire, not a substitute for a dedicated redacted secret scan.
  const text = data.toString('utf8');
  const patterns = [
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/,
    /\bAKIA[A-Z0-9]{16}\b/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    /(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*[=:]\s*["']?[A-Za-z0-9_+\/-]{32,}/i,
  ];
  if (patterns.some(pattern => pattern.test(text))) {
    throw new Error(`Secret-shaped material rejected in ${name}; values withheld`);
  }
}

async function readSource(root, name) {
  if (!SOURCE_FILES.includes(name) || !/^[\w./-]+$/.test(name) ||
      name.split('/').includes('..') ||
      !/(?:\.(?:ts|mjs|css|html|xml|json|md|yml|svg|png|ttf)|(?:^|\/)(?:Dockerfile|LICENSE|\.dockerignore|\.gitignore|\.gitleaksignore|\.railwayignore|\.env\.example))$/.test(name)) {
    throw new Error('Unapproved source path or extension');
  }
  let path = root;
  for (const part of name.split('/')) {
    path = resolve(path, part);
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Symlink rejected: ${name}`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Non-file rejected: ${name}`);
    const data = await handle.readFile();
    if (name.endsWith('.png') && !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`Invalid PNG: ${name}`);
    }
    if (name.endsWith('.ttf') && data.readUInt32BE(0) !== 0x00010000) {
      throw new Error(`Invalid TrueType font: ${name}`);
    }
    checkContent(data, name);
    return data;
  } finally { await handle.close(); }
}

export async function exportSource(source, destination) {
  const root = await realpath(source);
  const output = resolve(destination);
  // Require an existing real parent and forbid exports inside the source tree.
  const parent = await realpath(dirname(output));
  if (parent !== dirname(output)) throw new Error('Output parent must not contain symlinks');
  const fromRoot = relative(root, output);
  if (!fromRoot || (!fromRoot.startsWith('..' + '/') && !isAbsolute(fromRoot))) {
    throw new Error('Output must be outside the source tree');
  }
  // Validate the entire snapshot before creating any output; source bytes are cached.
  const snapshot = await Promise.all(SOURCE_FILES.map(async name => [name, await readSource(root, name)]));
  await mkdir(output, { mode: 0o700 }); // exclusive: fail if anything already exists
  for (const [name, data] of snapshot) {
    const target = resolve(output, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const handle = await open(target, 'wx', 0o600);
    try { await handle.writeFile(data); } finally { await handle.close(); }
  }
  return SOURCE_FILES.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/public-source.mjs NEW_OUTPUT_DIRECTORY');
    const source = fileURLToPath(new URL('../', import.meta.url));
    const count = await exportSource(source, process.argv[2]);
    console.log(`Exported ${count} allowlisted files. PRIVATE REVIEW CANDIDATE ONLY; publication not authorized.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Export failed');
    process.exitCode = 1;
  }
}
