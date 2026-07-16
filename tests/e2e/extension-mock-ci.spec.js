const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { test, expect, chromium } = require('@playwright/test');
const { DEMO_REPLY, fixtureHtml } = require('../../scripts/demo-fixture');

const ROOT = path.resolve(__dirname, '../..');
const API = 'http://127.0.0.1:8717';
const EXTENSION = path.join(ROOT, 'extension').replaceAll('\\', '/');
const PROFILE = path.join(ROOT, `.e2e-profile-mock-${process.pid}-${Date.now()}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      if (body.runtime !== 'mock') throw new Error('port 8717 is already used by a non-mock API');
      await fetch(`${API}/__test/reset`, { method: 'POST' });
      return null;
    }
  } catch (error) {
    if (String(error.message || error).includes('non-mock')) throw error;
  }

  const proc = spawn(process.execPath, ['scripts/mock-voice-api.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (await mockHealth()) return proc;
    if (proc.exitCode !== null) break;
    await wait(150);
  }
  proc.kill();
  throw new Error('mock API did not start; stop the process using port 8717');
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
    headless: false,
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
        voiceId: 'qwen3',
        referenceVoice: 'qwen3',
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
    if (!(await panel.getByText('Voice', { exact: true }).isVisible().catch(() => false))) {
      await panel.click({ position: { x: 40, y: 12 } });
    }

    const stored = await worker.evaluate(() => chrome.storage.local.get(['voiceId', 'referenceVoice']));
    expect(stored.voiceId).toBe('');
    expect(stored.referenceVoice).toBe('');
    await expect(panel.locator('select').nth(0)).toHaveValue('');

    await panel.getByRole('button', { name: 'Auto' }).click();
    await page.waitForTimeout(1800);
    expect((await apiEvents()).filter((event) => event.path === '/v1/speak')).toHaveLength(0);

    await page.locator('#add-reply').click();
    await expect(page.locator('[data-message-id="new-reply"]')).toHaveText(DEMO_REPLY);
    await expect(panel).toContainText('Played chunk 1/', { timeout: 30000 });
    await waitForCounts(1, 1);

    let events = await apiEvents();
    const firstPost = events.find((event) => event.method === 'POST' && event.path === '/v1/speak');
    expect(firstPost.responseStatus).toBe(200);
    expect(firstPost.body.referenceVoice).toBe('');
    expect(firstPost.body.voiceId).toBe('');
    expect(firstPost.body.text.length).toBeLessThanOrEqual(80);
    expect(DEMO_REPLY.startsWith(firstPost.body.text)).toBe(true);
    expect(firstPost.body.text).not.toBe(DEMO_REPLY);
    expect(events.find((event) => event.method === 'GET' && event.path === '/audio/mock.wav').responseStatus).toBe(200);

    await panel.getByRole('button', { name: 'Next' }).click();
    await expect(panel).toContainText('Played chunk 2/', { timeout: 30000 });
    await waitForCounts(2, 2);
    events = await apiEvents();
    const postsAfterNext = events.filter((event) => event.method === 'POST' && event.path === '/v1/speak');
    expect(postsAfterNext[1].body.text).not.toBe(postsAfterNext[0].body.text);

    await panel.getByRole('button', { name: 'Regen' }).click();
    await expect(panel).toContainText('Played chunk 2/', { timeout: 30000 });
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
    headless: false,
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

    await expect.poll(async () => {
      const states = await Promise.all(pages.map((page) => page.locator('#local-voice-bridge-panel').isVisible().catch(() => false)));
      return states.filter(Boolean).length;
    }, { timeout: 15000 }).toBe(1);

    const ownerPage = (await pages[0].locator('#local-voice-bridge-panel').isVisible()) ? pages[0] : pages[1];
    const ownerPanel = ownerPage.locator('#local-voice-bridge-panel');
    if (!(await ownerPanel.getByText('Voice', { exact: true }).isVisible().catch(() => false))) {
      await ownerPanel.click({ position: { x: 40, y: 12 } });
    }
    await expect(ownerPanel.locator('select').nth(0)).toHaveValue('sample');
    await expect.poll(async () => ownerPanel.locator('select').last().locator('option').count()).toBe(2);

    await ownerPanel.getByRole('button', { name: 'Auto' }).click();
    await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get('enabled')).enabled)).toBe(true);
    await Promise.all(pages.map((page) => page.locator('#add-reply').click()));

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
