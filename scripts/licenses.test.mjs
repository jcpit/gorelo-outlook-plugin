import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LICENSE_MANIFEST, LICENSE_OUTPUT, packageLicenses, renderLicenses } from './licenses.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dependency-licenses-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['package.json', 'package-lock.json', ...LICENSE_MANIFEST.flatMap((entry) => [
    `node_modules/${entry.name}/package.json`, `node_modules/${entry.name}/${entry.file}`,
  ])]) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await copyFile(join(projectRoot, file), join(root, file));
  }
  return root;
}

async function editJson(root, file, edit) {
  const path = join(root, file);
  const value = JSON.parse(await readFile(path, 'utf8'));
  edit(value);
  await writeFile(path, JSON.stringify(value));
}

test('manifest covers every direct dependency and exactly the two specified support packages', async () => {
  const metadata = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(LICENSE_MANIFEST.length, 8);
  assert.equal(new Set(LICENSE_MANIFEST.map((entry) => entry.name)).size, 8);
  assert.deepEqual(LICENSE_MANIFEST.filter((entry) => entry.direct).map((entry) => entry.name).sort(), Object.keys(metadata.dependencies).sort());
  assert.deepEqual(LICENSE_MANIFEST.filter((entry) => !entry.direct).map((entry) => entry.name).sort(), [
    '@azure/msal-common', '@fortawesome/fontawesome-common-types',
  ]);
});

test('deterministically copies exact full installed licenses, versions, SPDX and source metadata', async (t) => {
  const root = await fixture(t);
  // Exercise preservation of CRLF, whitespace, no final newline, and Markdown fences.
  const entry = LICENSE_MANIFEST[0];
  await writeFile(join(root, 'node_modules', entry.name, entry.file), ' notice\r\n```\r\n\tunchanged  ');
  const output = await renderLicenses(root);
  assert.equal(await renderLicenses(root), output);
  for (const item of LICENSE_MANIFEST) {
    const license = await readFile(join(root, 'node_modules', item.name, item.file), 'utf8');
    const section = output.split(`\n## ${item.name} — ${item.version}\n`)[1].split('\n## ')[0];
    const fence = section.match(/\n(`{3,})text\n/)[1];
    const copied = section.slice(section.indexOf(`${fence}text\n`) + fence.length + 5, section.lastIndexOf(`\n${fence}\n`));
    assert.equal(copied, license);
    assert.ok(section.includes(`SPDX: \`${item.spdx}\``));
    assert.ok(section.includes(`node_modules/${item.name}/${item.file}`));
    assert.ok(section.includes(item.upstream));
  }
});

test('default check rejects missing output without creating files or directories', async (t) => {
  const root = await fixture(t);
  const before = await readdir(root);
  await assert.rejects(packageLicenses(root), /missing or stale/);
  assert.deepEqual(await readdir(root), before);
  await assert.rejects(readFile(join(root, LICENSE_OUTPUT)), { code: 'ENOENT' });
});

test('write creates output; check accepts it and rejects stale content without modifying it', async (t) => {
  const root = await fixture(t);
  await packageLicenses(root, { write: true });
  assert.equal(await readFile(join(root, LICENSE_OUTPUT), 'utf8'), await renderLicenses(root));
  await packageLicenses(root);
  await writeFile(join(root, LICENSE_OUTPUT), 'stale notice');
  await assert.rejects(packageLicenses(root), /missing or stale/);
  assert.equal(await readFile(join(root, LICENSE_OUTPUT), 'utf8'), 'stale notice');
});

test('check rejects an upstream license text change', async (t) => {
  const root = await fixture(t);
  await packageLicenses(root, { write: true });
  await writeFile(join(root, 'node_modules/express/LICENSE'), 'changed upstream notice');
  await assert.rejects(packageLicenses(root), /missing or stale/);
});

for (const mutation of ['added dependency', 'removed dependency', 'installed version', 'locked version', 'dependency specification', 'SPDX']) {
  test(`rejects ${mutation} mismatch before writing`, async (t) => {
    const root = await fixture(t);
    if (mutation === 'added dependency') await editJson(root, 'package.json', (value) => { value.dependencies.unreviewed = '^1.0.0'; });
    if (mutation === 'removed dependency') await editJson(root, 'package.json', (value) => { delete value.dependencies.express; });
    if (mutation === 'installed version') await editJson(root, 'node_modules/express/package.json', (value) => { value.version = '999.0.0'; });
    if (mutation === 'locked version') await editJson(root, 'package-lock.json', (value) => { value.packages['node_modules/express'].version = '999.0.0'; });
    if (mutation === 'dependency specification') await editJson(root, 'package.json', (value) => { value.dependencies.express = '^999.0.0'; });
    if (mutation === 'SPDX') await editJson(root, 'node_modules/express/package.json', (value) => { value.license = 'UNLICENSED'; });
    await assert.rejects(packageLicenses(root, { write: true }), /manifest|dependency mismatch/);
    await assert.rejects(readFile(join(root, LICENSE_OUTPUT)), { code: 'ENOENT' });
  });
}

test('rejects missing or empty source license rather than omitting it', async (t) => {
  const root = await fixture(t);
  const source = join(root, 'node_modules/express/LICENSE');
  await rm(source);
  await assert.rejects(packageLicenses(root, { write: true }), { code: 'ENOENT' });
  await writeFile(source, '');
  await assert.rejects(packageLicenses(root, { write: true }), /Empty source license/);
  await assert.rejects(readFile(join(root, LICENSE_OUTPUT)), { code: 'ENOENT' });
});
