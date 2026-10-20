import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkContent, exportSource, SOURCE_FILES } from './public-source.mjs';

test('MIT license is included in source exports and package metadata', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const license = await readFile(join(root, 'LICENSE'), 'utf8');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  assert.ok(SOURCE_FILES.includes('LICENSE'));
  assert.match(license, /^MIT License\n/);
  assert.match(license, /Copyright \(c\) 2026 Gorelo for Outlook contributors/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.equal(metadata.license, 'MIT');
  assert.equal(lock.packages[''].license, 'MIT');
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES\.md \.\//);
});

test('allowlist covers every current source module and test', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  async function walk(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else if (/\.(?:ts|mjs|css)$/.test(name)) {
        assert.ok(SOURCE_FILES.includes(name), `Review and explicitly allowlist required source: ${name}`);
      }
    }
  }
  for (const directory of ['server', 'src', 'tests', 'scripts']) await walk(directory);
});

test('source exports include browser credits and complete third-party notices', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const name of ['public/credits.html', 'public/licenses/source-sans-3-OFL.md', 'public/licenses/npm-dependencies.md', 'public/licenses/project-MIT.md', 'scripts/licenses.mjs', 'scripts/licenses.test.mjs', 'server/credits.test.ts']) {
    assert.ok(SOURCE_FILES.includes(name), `Missing attribution artifact: ${name}`);
    assert.ok((await readFile(join(root, name))).length > 0);
  }
  const page = await readFile(join(root, 'public/credits.html'), 'utf8');
  assert.equal(await readFile(join(root, 'public/licenses/project-MIT.md'), 'utf8'), await readFile(join(root, 'LICENSE'), 'utf8'));
  for (const text of ['Fonticons, Inc.', 'creativecommons.org/licenses/by/4.0/', 'Paul D. Hunt', 'Microsoft Corporation', 'not affiliated with or endorsed by Gorelo']) assert.ok(page.includes(text));
  assert.ok(!page.includes('<script'));
  const license = await readFile(join(root, 'public/licenses/source-sans-3-OFL.md'), 'utf8');
  for (const text of ['© 2023 Adobe', 'Copyright 2010-2022 Adobe', 'SIL OPEN FONT LICENSE Version 1.1', 'PERMISSION & CONDITIONS', 'TERMINATION', 'DISCLAIMER']) assert.ok(license.includes(text));
  for (const weight of ['regular', 'semibold', 'bold']) {
    assert.ok(SOURCE_FILES.includes(`public/source-sans3-${weight}.ttf`));
    assert.ok(!SOURCE_FILES.includes(`public/source-sans-${weight}.ttf`));
  }
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'public-source-test-'));
  const source = join(base, 'source');
  await mkdir(source);
  for (const name of SOURCE_FILES) {
    const path = join(source, name);
    await mkdir(dirname(path), { recursive: true });
    const bytes = name.endsWith('.png') ? Buffer.from([137,80,78,71,13,10,26,10]) :
      name.endsWith('.ttf') ? Buffer.from([0,1,0,0]) : Buffer.from('reviewed fixture');
    await writeFile(path, bytes);
  }
  return { base, source, output: join(base, 'candidate') };
}

test('inline workflow mockups are portable, allowlisted and free of text metadata', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  assert.match(readme, /illustrative workflow mockups, not live production screenshots/);
  assert.match(readme, /All people, companies, emails, tickets and devices shown are fictional/);
  assert.ok(SOURCE_FILES.includes('docs/images/workflow/README.md'));
  for (const scene of ['launch', 'review', 'created', 'tickets', 'assets']) {
    const name = `docs/images/workflow/${scene}.png`;
    assert.ok(SOURCE_FILES.includes(name), `Missing reviewed image in export: ${name}`);
    assert.ok(readme.includes(`](${name})`), `Image must be inline in README: ${name}`);
    const png = await readFile(join(root, name));
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
    let offset = 8;
    let ended = false;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const chunk = png.toString('ascii', offset + 4, offset + 8);
      assert.ok(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(chunk), `Unreviewed metadata chunk in ${name}: ${chunk}`);
      offset += length + 12;
      assert.ok(offset <= png.length, `Truncated PNG: ${name}`);
      if (chunk === 'IEND') { ended = true; break; }
    }
    assert.ok(ended, `Missing PNG end: ${name}`);
    assert.equal(offset, png.length, `Unexpected trailing image data: ${name}`);
  }
});

test('exports only exact allowlist, excluding private runtime data and history', async () => {
  const { source, output } = await fixture();
  await writeFile(join(source, '.env'), 'private fixture');
  await mkdir(join(source, '.git'));
  await writeFile(join(source, '.git', 'config'), 'private history fixture');
  await writeFile(join(source, 'src', 'customer-report.json'), '{}');
  assert.equal(await exportSource(source, output), SOURCE_FILES.length);
  assert.equal(await readFile(join(output, 'README.md'), 'utf8'), 'reviewed fixture');
  assert.equal(await readFile(join(output, 'LICENSE'), 'utf8'), 'reviewed fixture');
  assert.ok(!(await readdir(output)).includes('.env'));
  assert.ok(!(await readdir(output)).includes('.git'));
  assert.ok(!(await readdir(join(output, 'src'))).includes('customer-report.json'));
  await assert.rejects(exportSource(source, output), { code: 'EEXIST' });
  await assert.rejects(exportSource(source, join(source, 'candidate')), /outside/);
});

test('rejects selected file and directory symlinks', async () => {
  const { base, source, output } = await fixture();
  const external = join(base, 'external');
  await writeFile(external, 'reviewed');
  // Use an independently prepared fixture path, never remove existing source.
  const alternate = join(base, 'alternate');
  await mkdir(alternate);
  for (const name of SOURCE_FILES) {
    await mkdir(dirname(join(alternate, name)), { recursive: true });
    if (name === 'README.md') await symlink(external, join(alternate, name));
    else await writeFile(join(alternate, name), await readFile(join(source, name)));
  }
  await assert.rejects(exportSource(alternate, output), /Symlink rejected/);
  await rename(join(source, 'server'), join(base, 'external-server'));
  await symlink(join(base, 'external-server'), join(source, 'server'));
  await assert.rejects(exportSource(source, output), /Symlink rejected/);
  const linkedParent = join(base, 'linked-parent');
  await symlink(base, linkedParent);
  await assert.rejects(exportSource(source, join(linkedParent, 'candidate')), /symlinks/);
});

test('rejects secret-shaped content without disclosing values', () => {
  const candidates = [
    ['gh', 'p_', 'x'.repeat(24)].join(''),
    ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
    ['AK', 'IA', 'A'.repeat(16)].join(''),
    ['api_key=', 'a'.repeat(40)].join(''),
  ];
  for (const value of candidates) {
    assert.throws(() => checkContent(Buffer.from(value), 'fixture.ts'), error =>
      error.message.includes('values withheld') && !error.message.includes(value));
  }
});

test('rejects a bad binary or secret before creating output', async () => {
  const { source, output } = await fixture();
  await writeFile(join(source, 'public/icon-16.png'), 'not a PNG');
  await assert.rejects(exportSource(source, output), /Invalid PNG/);
  await assert.rejects(readdir(output), { code: 'ENOENT' });
  await writeFile(join(source, 'public/icon-16.png'), Buffer.from([137,80,78,71,13,10,26,10]));
  await writeFile(join(source, 'README.md'), ['api_key=', 'a'.repeat(40)].join(''));
  await assert.rejects(exportSource(source, output), /values withheld/);
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});
