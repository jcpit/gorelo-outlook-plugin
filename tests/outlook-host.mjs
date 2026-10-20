import assert from 'node:assert/strict';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: process.env.BROWSER_EXECUTABLE_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:4173';
const fontPaths = ['regular', 'semibold', 'bold'].map(weight => `/source-sans3-${weight}.ttf`);
const disclaimer = 'This is not an official Gorelo tool and is not affiliated with or endorsed by Gorelo. Use at your own risk.';
const screenshotDir = process.env.FONT_SCREENSHOT_DIR;

async function checkFonts(page, requests, weights = [400, 600, 700]) {
  await page.evaluate(async weights => {
    for (const weight of weights) {
      const faces = await document.fonts.load(`${weight} 16px "Source Sans 3"`);
      if (!faces.length || faces.some(face => face.status !== 'loaded')) throw new Error(`Font weight ${weight} did not load`);
    }
    await document.fonts.ready;
  }, weights);
  assert.ok((await page.locator('body').evaluate(node => getComputedStyle(node).fontFamily)).startsWith('"Source Sans 3"'));
  for (const path of fontPaths.slice(0, weights.length)) assert.ok(requests.some(url => url.pathname === path), `Missing font request: ${path}`);
  assert.ok(requests.every(url => url.origin === new URL(origin).origin), 'Fonts must be requested only from the test origin');
}

async function checkLayout(page, link) {
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal document overflow');
  for (const locator of [link, page.locator('.unofficial-disclaimer')]) {
    if (!await locator.count()) continue;
    await locator.scrollIntoViewIfNeeded();
    assert.ok(await locator.isVisible());
    assert.ok(await locator.evaluate(node => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth
        && parseFloat(style.fontSize) >= 12 && style.visibility === 'visible';
    }), 'Legal text must remain readable and fit the viewport');
  }
  // Enter keyboard modality, then tab onto the link to exercise :focus-visible.
  await link.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  assert.ok(await link.evaluate(node => node === document.activeElement && node.matches(':focus-visible')
    && getComputedStyle(node).outlineStyle !== 'none'), 'Credits link needs a visible keyboard focus indicator');
}

async function screenshot(page, name) {
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true });
}

try {
  if (screenshotDir) {
    assert.ok((await stat(screenshotDir)).isDirectory(), 'FONT_SCREENSHOT_DIR must be an existing directory');
    const pathFromRepo = relative(await realpath(fileURLToPath(new URL('../', import.meta.url))), await realpath(screenshotDir));
    assert.ok(pathFromRepo === '..' || pathFromRepo.startsWith('../') || isAbsolute(pathFromRepo), 'Screenshots must be outside the repository');
  }
  for (const mode of ['real-browser', 'browser', 'missing-office', 'word', 'outlook']) {
    const page = await browser.newPage();
    const apiRequests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://appsforoffice.microsoft.com/**', route => {
      if (mode === 'real-browser') return route.continue();
      if (mode === 'missing-office') return route.abort();
      const host = mode === 'outlook' ? 'Outlook' : mode === 'word' ? 'Word' : null;
      return route.fulfill({
        contentType: 'text/javascript',
        body: `window.Office = {
          HostType: { Outlook: 'Outlook' },
          onReady: async () => ({ host: ${JSON.stringify(host)} }),
          context: { mailbox: ${host ? '{ addHandlerAsync() {} }' : 'undefined'} },
          EventType: { ItemChanged: 'itemChanged' },
          MailboxEnums: { ItemType: { Message: 'message' } }
        };`,
      });
    });
    await page.route('**/api/**', route => {
      if (route.request().method() !== 'GET') return route.abort();
      const path = new URL(route.request().url()).pathname;
      apiRequests.push(path);
      const data = path === '/api/auth-config' ? { provider: 'local' }
        : path === '/api/auth-mode' ? { serverManaged: true }
        : { groups: [], statuses: [], types: [], clients: [] };
      return route.fulfill({ json: data });
    });
    await page.goto(origin);
    if (mode === 'outlook') {
      await page.getByRole('navigation', { name: 'Gorelo sections' }).waitFor();
      await page.getByText('Open an email message to create a ticket.', { exact: true }).waitFor();
      assert.ok(apiRequests.includes('/api/auth-mode'));
      assert.ok(apiRequests.includes('/api/options'));
      assert.equal(await page.getByRole('heading', { name: 'Open this add-in in Outlook' }).count(), 0);
    } else {
      await page.getByRole('heading', { name: 'Open this add-in in Outlook' }).waitFor();
      assert.deepEqual(apiRequests, [], `${mode} must not load authentication or business data`);
      assert.equal(await page.locator('nav, form, select').count(), 0);
    }
    assert.equal(await page.getByText('Printer offline in reception', { exact: true }).count(), 0);
    await page.getByText(disclaimer, { exact: true }).waitFor();
    const credits = page.getByRole('link', { name: 'Credits and licenses (opens in a new tab)', exact: true });
    assert.equal(await credits.getAttribute('href'), '/credits.html');
    assert.equal(await credits.getAttribute('target'), '_blank');
    assert.equal(await credits.getAttribute('rel'), 'noopener noreferrer');
    assert.deepEqual(errors, []);
    console.log(`PASS ${mode}`);
    await page.close();
  }
  const credits = await browser.newPage();
  const requests = [];
  const creditFonts = [];
  credits.on('request', request => requests.push(new URL(request.url()).pathname));
  credits.on('request', request => { if (request.resourceType() === 'font') creditFonts.push(new URL(request.url())); });
  await credits.goto(`${origin}/credits.html`);
  await credits.getByRole('heading', { name: 'Credits and licenses', exact: true }).waitFor();
  await credits.getByRole('heading', { name: 'Font Awesome Free icons', exact: true }).waitFor();
  await credits.getByRole('heading', { name: 'Source Sans 3', exact: true }).waitFor();
  await checkFonts(credits, creditFonts, [400, 600]);
  for (const width of [320, 728]) {
    await credits.setViewportSize({ width, height: 900 });
    await checkLayout(credits, credits.getByRole('link', { name: 'Fonts', exact: true }));
    assert.ok(await credits.locator('main').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
    await screenshot(credits, `credits-${width}`);
  }
  assert.ok(!requests.some(path => path.startsWith('/api/') || path.includes('office.js')));
  for (const path of ['/licenses/npm-dependencies.md', '/licenses/source-sans-3-OFL.md', '/licenses/project-MIT.md']) {
    const response = await credits.request.get(`${origin}${path}`);
    assert.equal(response.status(), 200);
    assert.ok(!(await response.text()).includes('<!doctype html>'), 'License requests must not return the SPA fallback');
  }
  await credits.close();
  console.log('PASS public credits and licenses');
  for (const failFonts of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    const errors = [];
    const fonts = [];
    const blockedWrites = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.resourceType() === 'font') fonts.push(new URL(request.url())); });
    if (failFonts) await page.route('**/source-sans3-*.ttf', route => route.abort());
    await page.route('https://appsforoffice.microsoft.com/**', route => route.fulfill({
      contentType: 'text/javascript',
      body: `window.Office = {
        HostType: { Outlook: 'Outlook' }, onReady: async () => ({ host: 'Outlook' }),
        AsyncResultStatus: { Succeeded: 'succeeded' }, CoercionType: { Html: 'html', Text: 'text' },
        EventType: { ItemChanged: 'itemChanged' }, MailboxEnums: { ItemType: { Message: 'message' } },
        context: { mailbox: { addHandlerAsync() {}, userProfile: { emailAddress: 'support@example.com' }, item: {
          itemType: 'message', subject: 'Synthetic long subject for font wrapping and routing review: ' + 'LongUnbrokenSubject'.repeat(8),
          from: { displayName: 'Synthetic sender with a long display name', emailAddress: 'long.synthetic.sender@example.com' },
          to: [{ emailAddress: 'support@example.com' }], cc: [], attachments: [], itemId: 'synthetic-item',
          conversationId: 'synthetic-conversation', dateTimeCreated: new Date('2026-01-01T00:00:00Z'),
          body: { getAsync(type, callback) { callback({ status: 'succeeded', value: 'Synthetic message body with a long reference ' + 'LongUnbrokenReference'.repeat(10) }); } },
          getAllInternetHeadersAsync(callback) { callback({ status: 'succeeded', value: 'Message-ID: <synthetic-font-layout@example.com>' }); }
        } } }
      };`,
    }));
    await page.route('**/api/**', route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') { blockedWrites.push(path); return route.abort(); }
      const data = path === '/api/auth-config' ? { provider: 'local' }
        : path === '/api/auth-mode' ? { serverManaged: true }
        : path === '/api/options' ? {
          groups: [{ id: 1, name: 'Synthetic service desk with a long routing label' }],
          statuses: [{ id: 1, name: 'Synthetic open status' }], types: [{ id: 1, name: 'Synthetic request type' }],
          clients: [{ id: 1, name: 'Synthetic example client with a long display name' }],
        } : { users: [], contacts: [], items: [] };
      return route.fulfill({ json: data });
    });
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Selected email', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Ticket details', exact: true }).waitFor();
    await page.locator('form select').first().waitFor();
    await page.getByText(disclaimer, { exact: true }).waitFor();
    await page.getByText('Preview message body', { exact: true }).click();
    if (!failFonts) await checkFonts(page, fonts);
    else {
      await page.evaluate(() => document.fonts.ready);
      assert.ok(fonts.length > 0, 'Fallback test must attempt the aborted fonts');
      assert.equal(await page.evaluate(() => document.fonts.check('400 16px "Source Sans 3"')), false);
    }
    for (const width of failFonts ? [320] : [320, 728]) {
      await page.setViewportSize({ width, height: 900 });
      await checkLayout(page, page.getByRole('link', { name: 'Credits and licenses (opens in a new tab)', exact: true }));
      assert.ok(await page.locator('.subject').isVisible());
      assert.ok(await page.locator('.preview-text').first().isVisible());
      await screenshot(page, `outlook-${failFonts ? 'fallback-' : ''}${width}`);
    }
    assert.ok(blockedWrites.every(path => path === '/api/classify'), 'Only the automatic synthetic classification attempt may be blocked; no ticket writes');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS synthetic Outlook font ${failFonts ? 'fallback' : 'weights and layouts'}`);
  }
} finally {
  await browser.close();
}
