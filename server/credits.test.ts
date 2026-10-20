import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

test('credits and complete notices are public static files even when business APIs require Entra', async () => {
  const staticDir = fileURLToPath(new URL('../public', import.meta.url));
  const app = createApp(loadConfig({ STATIC_DIR: staticDir, GORELO_API_KEY: 'synthetic-test-key',
    REQUIRE_ENTRA_AUTH: 'true', ENTRA_TENANT_ID: '11111111-1111-4111-8111-111111111111',
    ENTRA_CLIENT_ID: '22222222-2222-4222-8222-222222222222' })).listen(0, '127.0.0.1');
  try {
    if (!app.listening) await new Promise<void>(resolve => app.once('listening', resolve));
    const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    for (const path of ['/credits.html', '/licenses/source-sans-3-OFL.md', '/licenses/npm-dependencies.md', '/licenses/project-MIT.md']) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), await readFile(staticDir + path, 'utf8'));
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.equal((await fetch(origin + '/api/options')).status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  }
});

test('font attribution pins the three unmodified official Adobe Source Sans 3 files', async () => {
  const hashes = {
    regular: '4644c81b86ec9caaa76b634889968ed3c4f4f52f054855933acc7c2b21e53b0f',
    semibold: 'a3f4f8dcf343a8f24dc61951de93f3ba1558b15cd250ba24af8a40e957081b7d',
    bold: '9214b9d95e4231c609802815c2646c98174e2102d0d37f88978a7f8e71006e6a',
  };
  const notice = await readFile(new URL('../public/licenses/source-sans-3-OFL.md', import.meta.url), 'utf8');
  assert.ok(notice.includes('ed1808970eb3c7301c9a523bee26473ba0bb62fa'));
  for (const [weight, expected] of Object.entries(hashes)) {
    const font = await readFile(new URL(`../public/source-sans3-${weight}.ttf`, import.meta.url));
    assert.equal(createHash('sha256').update(font).digest('hex'), expected, 'Changed font requires attribution/provenance review');
    assert.ok(notice.includes(expected));
    await assert.rejects(readFile(new URL(`../public/source-sans-${weight}.ttf`, import.meta.url)), { code: 'ENOENT' });
  }
  for (const file of ['../src/gorelo-theme.css', '../public/credits.html']) {
    const content = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.ok(content.includes("font-family: 'Source Sans 3'"));
    assert.ok(!content.includes('Source Sans Pro'));
    assert.ok(!content.includes('/source-sans-regular.ttf'));
  }
});

test('complete font license matches the reviewed Adobe release text after declared whitespace normalization', async () => {
  const notice = await readFile(new URL('../public/licenses/source-sans-3-OFL.md', import.meta.url), 'utf8');
  const complete = notice.split('## Complete upstream notice and license\n\n')[1];
  assert.ok(complete);
  const normalized = complete.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
  // Official Adobe LICENSE.md at ed1808970eb3c7301c9a523bee26473ba0bb62fa.
  assert.equal(createHash('sha256').update(normalized).digest('hex'), 'c5ea98e6f4de45140b00c37608f396b847ddc550104aa87b8ca2974ea76e0b93');
});
