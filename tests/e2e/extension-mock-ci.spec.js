const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { test, expect, chromium } = require('@playwright/test');
const { DEMO_REPLY, fixtureHtml } = require('../../scripts/demo-fixture');

const ROOT = path.resolve(__dirname, '../..');
const MOCK_PORT = Number(process.env.MOCK_VOICE_PORT || (18000 + (process.pid % 1000)));
const API = `http://127.0.0.1:${MOCK_PORT}`;
const SOURCE_EXTENSION = path.join(ROOT, 'extension');
const EXTENSION_DIR = path.join(os.tmpdir(), `local-voice-extension-mock-${process.pid}-${Date.now()}`);
const EXTENSION = EXTENSION_DIR.replaceAll('\\', '/');
const PROFILE = path.join(ROOT, `.e2e-profile-mock-${process.pid}-${Date.now()}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function prepareTestExtension() {
  fs.rmSync(EXTENSION_DIR, { recursive: true, force: true });
  fs.cpSync(SOURCE_EXTENSION, EXTENSION_DIR, { recursive: true });
  const manifestPath = path.join(EXTENSION_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [
    `http://127.0.0.1:${MOCK_PORT}/*`,
    `http://localhost:${MOCK_PORT}/*`,
  ];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
}

test.beforeAll(() => prepareTestExtension());
test.afterAll(() => fs.rmSync(EXTENSION_DIR, { recursive: true, force: true }));

async function mockHealth() {
  try {
    const response = await fetch(`${API}/health`);
    const body = await response.json();
    return response.ok && body.runtime === 'mock';
  } catch (_) {
    return false;
  }
}

async function startMock() {
  try {
    const response = await fetch(`${API}/health`);
    if (response.ok) {
      const body = await response.json();
      if (body.runtime !== 'mock') throw new Error(`mock port ${MOCK_PORT} is already used by a non-mock API`);
      await fetch(`${API}/__test/reset`, { method: 'POST' });
      return null;
    }
  } catch (error) {
    if (String(error.message || error).includes('non-mock')) throw error;
  }

  const proc = spawn(process.execPath, ['scripts/mock-voice-api.js'], {
    cwd: ROOT,
    env: { ...process.env, MOCK_VOICE_PORT: String(MOCK_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (await mockHealth()) return proc;
    if (proc.exitCode !== null) break;
    await wait(150);
  }
  proc.kill();
  throw new Error(`mock API did not start on port ${MOCK_PORT}`);
}

async function apiEvents() {
  const response = await fetch(`${API}/__test/events`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  return body.events;
}

async function waitForCounts(postCount, getCount) {
  await expect.poll(async () => {
    const events = await apiEvents();
    return {
      posts: events.filter((event) => event.method === 'POST' && event.path === '/v1/speak').length,
      gets: events.filter((event) => event.method === 'GET' && event.path === '/audio/mock.wav').length,
    };
  }, { timeout: 30000 }).toEqual({ posts: postCount, gets: getCount });
}

test('mock CI protects Auto baseline and proves Next, Regen, Replay, audio fetch, and stale Ref normalization', async () => {
  test.setTimeout(90000);
  const api = await startMock();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: process.env.PLAYWRIGHT_HEADED !== '1',
    channel: 'chromium',
    viewport: { width: 1280, height: 720 },
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--mute-audio',
    ],
  });

  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(async (apiUrl) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        apiUrl: `${apiUrl}/v1/speak`,
        healthUrl: `${apiUrl}/health`,
        voiceVolume: 0,
        enabled: false,
        panelCollapsed: false,
        voiceId: '',
        referenceVoice: 'sample',
        petMode: 'manual',
        selectedPetId: 'standalone',
        petPosition: { left: 10, top: 20 },
      });
    }, API);

    const page = await context.newPage();
    await page.route('https://chatgpt.com/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: fixtureHtml(),
    }));
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });

    const panel = page.locator('#local-voice-bridge-panel');
    await expect(panel).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#local-voice-pixel-pet')).toHaveCount(0);
    await expect(panel.locator('select')).toHaveCount(1);
    await expect(panel.locator('[data-local-voice-field="ref"]')).toBeVisible();
    await expect(panel.locator('[data-local-voice-field="volume"]')).toBeVisible();
    await expect(panel.getByText('Voice', { exact: true })).toHaveCount(0);
    await expect(panel.getByText('Tab', { exact: true })).toHaveCount(0);
    await expect(panel.getByText('Pet', { exact: true })).toHaveCount(0);
    for (const name of ['Auto', 'Next', 'Regen', 'Replay']) await expect(panel.getByRole('button', { name })).toBeVisible();
    const currentText = panel.locator('[data-testid="local-voice-current-text"]');
    await expect(currentText).toBeVisible();

    const stored = await worker.evaluate(() => chrome.storage.local.get(['voiceId', 'referenceVoice', 'petMode', 'selectedPetId', 'petPosition']));
    expect(stored.voiceId).toBe('');
    expect(stored.referenceVoice).toBe('');
    expect(stored.petMode).toBeUndefined();
    expect(stored.selectedPetId).toBeUndefined();
    expect(stored.petPosition).toBeUndefined();
    const refSelect = panel.locator('[data-testid="local-voice-ref"]');
    await expect(refSelect).toHaveValue('');
    await expect.poll(async () => {
      const petEvents = (await apiEvents()).filter((event) => event.method === 'POST' && event.path === '/v1/desktop-pet');
      return petEvents.at(-1)?.body?.petId || '';
    }).toBe('placeholder');

    await refSelect.selectOption('sample');
    await expect.poll(async () => {
      const petEvents = (await apiEvents()).filter((event) => event.method === 'POST' && event.path === '/v1/desktop-pet');
      return petEvents.at(-1)?.body?.petId || '';
    }).toBe('sample');
    await refSelect.selectOption('');
    await expect.poll(async () => {
      const petEvents = (await apiEvents()).filter((event) => event.method === 'POST' && event.path === '/v1/desktop-pet');
      return petEvents.at(-1)?.body?.petId || '';
    }).toBe('placeholder');

    const header = panel.locator(':scope > div').first();
    await header.click();
    await expect(panel.locator('[data-local-voice-field="ref"]')).toBeHidden();
    await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get('panelCollapsed')).panelCollapsed)).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(panel).toBeVisible({ timeout: 15000 });
    await expect(panel.locator('[data-local-voice-field="ref"]')).toBeHidden();
    await panel.locator(':scope > div').first().click();
    await expect(panel.locator('[data-local-voice-field="ref"]')).toBeVisible();
    await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get('panelCollapsed')).panelCollapsed)).toBe(false);
    await panel.getByRole('button', { name: 'Auto' }).click();
    await page.waitForTimeout(1800);
    expect((await apiEvents()).filter((event) => event.path === '/v1/speak')).toHaveLength(0);

    await page.locator('#add-reply').click();
    await expect(page.locator('[data-message-id="new-reply"]')).toHaveText(DEMO_REPLY);
    await expect(currentText).toContainText('これはオートをオンにした後に届いた新しい返答です。', { timeout: 15000 });
    await waitForCounts(1, 1);

    let events = await apiEvents();
    const firstPost = events.find((event) => event.method === 'POST' && event.path === '/v1/speak');
    expect(firstPost.responseStatus).toBe(200);
    expect(firstPost.body.referenceVoice).toBe('');
    expect(firstPost.body.voiceId).toBe('');
    expect(firstPost.body.text.length).toBeLessThanOrEqual(80);
    const demoLines = DEMO_REPLY.split('\n');
    expect(firstPost.body.text).toContain(demoLines[0]);
    expect(firstPost.body.text).not.toContain(demoLines[2]);
    expect(firstPost.body.text).not.toBe(DEMO_REPLY);
    expect(events.find((event) => event.method === 'GET' && event.path === '/audio/mock.wav').responseStatus).toBe(200);

    await panel.getByRole('button', { name: 'Next' }).click();
    await waitForCounts(2, 2);
    events = await apiEvents();
    const postsAfterNext = events.filter((event) => event.method === 'POST' && event.path === '/v1/speak');
    expect(postsAfterNext[1].body.text).not.toBe(postsAfterNext[0].body.text);

    await panel.getByRole('button', { name: 'Regen' }).click();
    await waitForCounts(3, 3);
    events = await apiEvents();
    const postsAfterRegen = events.filter((event) => event.method === 'POST' && event.path === '/v1/speak');
    expect(postsAfterRegen[2].body.text).toBe(postsAfterRegen[1].body.text);

    await panel.getByRole('button', { name: 'Replay' }).click();
    await waitForCounts(3, 4);
  } finally {
    await context.close().catch(() => {});
    if (api) api.kill();
    fs.rmSync(PROFILE, { recursive: true, force: true });
  }
});

test('two ChatGPT tabs keep the selected reference voice across a continuous Auto queue', async () => {
  test.setTimeout(90000);
  const api = await startMock();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: process.env.PLAYWRIGHT_HEADED !== '1',
    channel: 'chromium',
    viewport: { width: 1280, height: 720 },
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--mute-audio',
    ],
  });

  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(async (apiUrl) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        apiUrl: `${apiUrl}/v1/speak`,
        healthUrl: `${apiUrl}/health`,
        voiceVolume: 0,
        enabled: false,
        panelCollapsed: false,
        voiceId: 'sample',
        referenceVoice: 'sample',
      });
    }, API);

    const pages = [await context.newPage(), await context.newPage()];
    for (const page of pages) {
      await page.route('https://chatgpt.com/**', (route) => route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: fixtureHtml(),
      }));
    }
    await Promise.all(pages.map((page, index) => page.goto(`https://chatgpt.com/c/mock-${index}`, { waitUntil: 'domcontentloaded' })));

    await pages[0].bringToFront();
    await expect(pages[0].locator('#local-voice-bridge-panel')).toBeVisible({ timeout: 15000 });
    await expect(pages[1].locator('#local-voice-bridge-panel')).toBeHidden();
    const firstPanel = pages[0].locator('#local-voice-bridge-panel');
    await expect(firstPanel.locator('select')).toHaveCount(1);
    await expect(firstPanel.locator('[data-testid="local-voice-ref"]')).toHaveValue('sample');
    await firstPanel.getByRole('button', { name: 'Auto' }).click();
    await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get('enabled')).enabled)).toBe(true);
    await pages[0].locator('#add-reply').click();
    await waitForCounts(1, 1);

    await pages[1].bringToFront();
    await expect(pages[1].locator('#local-voice-bridge-panel')).toBeVisible({ timeout: 15000 });
    await expect(pages[0].locator('#local-voice-bridge-panel')).toBeHidden();
    await pages[1].locator('#add-reply').click();
    await waitForCounts(2, 2);
    const events = await apiEvents();
    const posts = events.filter((event) => event.method === 'POST' && event.path === '/v1/speak');
    expect(posts.map((event) => event.body.referenceVoice)).toEqual(['sample', 'sample']);
    expect(posts.map((event) => event.body.voiceId)).toEqual(['sample', 'sample']);
  } finally {
    await context.close().catch(() => {});
    if (api) api.kill();
    fs.rmSync(PROFILE, { recursive: true, force: true });
  }
});
