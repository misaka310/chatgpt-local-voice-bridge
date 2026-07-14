const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { test, expect, chromium } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '../..');
const API_BASE = process.env.LOCAL_VOICE_API_BASE || 'http://127.0.0.1:8717';
const PUBLIC_BASE = process.env.LOCAL_VOICE_PUBLIC_BASE_URL || API_BASE;
const API_PORT = new URL(API_BASE).port || '80';
const EXTENSION_DIR = path.join(ROOT, 'extension');
const EXTENSION_ARG = EXTENSION_DIR.split(String.fromCharCode(92)).join('/');
const PROFILE_DIR = path.join(ROOT, `.e2e-profile-ref-pet-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.afterEach(() => {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
});

async function healthy() {
  try {
    const res = await fetch(`${API_BASE}/health`);
    const body = await res.json();
    return res.ok && body.ok === true;
  } catch (_) {
    return false;
  }
}

async function startApi() {
  if (await healthy()) return null;
  const python = path.join(ROOT, 'local-api', '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(python)) throw new Error(`missing venv python: ${python}`);
  const proc = spawn(python, ['server.py'], {
    cwd: path.join(ROOT, 'local-api'),
    env: { ...process.env, LOCAL_VOICE_PORT: API_PORT, LOCAL_VOICE_PUBLIC_BASE_URL: PUBLIC_BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (data) => process.stdout.write(`[local-api] ${data}`));
  proc.stderr.on('data', (data) => process.stderr.write(`[local-api] ${data}`));
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    if (await healthy()) return proc;
    await wait(1000);
  }
  throw new Error('local api did not become healthy');
}

async function configureExtension(worker, overrides = {}) {
  await worker.evaluate(async ({ apiBase, overrides: nextOverrides }) => {
    await chrome.storage.local.set({
      apiUrl: `${apiBase}/v1/speak`,
      healthUrl: `${apiBase}/health`,
      model: 'irodori-v3',
      voiceProfile: 'irodori-v3',
      voiceId: '',
      referenceVoice: '',
      voiceVolume: 0,
      enabled: false,
      ...nextOverrides,
    });
  }, { apiBase: API_BASE, overrides });
}

function html() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT Ref Pet Fixture</title></head><body><main><h1>ChatGPT fixture</h1></main><script>window.addAssistant=()=>{const turn=document.createElement('div');turn.setAttribute('data-testid','conversation-turn-2');const msg=document.createElement('div');msg.setAttribute('data-message-author-role','assistant');msg.setAttribute('data-message-id','ref-pet-msg');msg.textContent='準備中';turn.appendChild(msg);document.querySelector('main').appendChild(turn);setTimeout(()=>{msg.textContent='これはPlaywrightによる拡張機能E2Eテストです。ローカル音声APIで音声を生成し、ブラウザ上で再生完了まで確認します。';},700);};window.addLongAssistant=()=>{const turn=document.createElement('div');turn.setAttribute('data-testid','conversation-turn-3');const msg=document.createElement('div');msg.setAttribute('data-message-author-role','assistant');msg.setAttribute('data-message-id','ref-pet-long-msg');msg.textContent='準備中';turn.appendChild(msg);document.querySelector('main').appendChild(turn);setTimeout(()=>{msg.textContent='最初のプレビューです。' + 'あ'.repeat(200) + '次のプレビューです。';},700);};</script></body></html>`;
}

test('Ref list, pet rendering, storage sync, and speak payload all use the selected reference voice', async () => {
  test.setTimeout(240000);
  const api = await startApi();
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  const loadArg = '--' + 'load-extension=' + EXTENSION_ARG;
  const onlyArg = '--' + 'disable-extensions-except=' + EXTENSION_ARG;
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [onlyArg, loadArg, '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--mute-audio'],
  });

  const speakResponses = [];
  ctx.on('response', async (res) => {
    if (!res.url().startsWith(`${API_BASE}/v1/speak`)) return;
    const body = await res.json().catch(() => null);
    speakResponses.push({ status: res.status(), body });
  });

  try {
    const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    await configureExtension(worker);
    const page = await ctx.newPage();
    await page.route('https://chatgpt.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html() }));
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });

    const panel = page.locator('#local-voice-bridge-panel');
    await expect(panel).toBeVisible({ timeout: 30000 });
    await panel.click({ position: { x: 40, y: 12 } });
    await expect(panel.getByRole('button', { name: 'Regen' })).toBeVisible({ timeout: 10000 });

    const refSelect = panel.locator('select').nth(0);
    const petSelect = panel.locator('select').nth(1);
    await expect(refSelect).toBeVisible();
    await expect
      .poll(async () => await refSelect.evaluate((el) => Array.from(el.options).map((opt) => opt.value).filter(Boolean).length))
      .toBeGreaterThan(0);
    await refSelect.selectOption({ index: 1 });

    await expect
      .poll(async () => await worker.evaluate(async () => chrome.storage.local.get(['voiceId', 'referenceVoice'])))
      .toEqual(expect.objectContaining({ voiceId: expect.any(String), referenceVoice: expect.any(String) }));

    await expect
      .poll(async () => await petSelect.evaluate((el) => Array.from(el.options).some((opt) => (opt.textContent || '').startsWith('Auto by Ref ('))))
      .toBe(true);

    const pet = page.locator('#local-voice-pixel-pet');
    await expect(pet).toBeVisible({ timeout: 30000 });
    await expect
      .poll(async () => await pet.evaluate((el) => getComputedStyle(el.firstElementChild).backgroundImage))
      .not.toBe('none');

    await page.evaluate(() => window.addAssistant());
    await expect(page.locator('[data-message-id="ref-pet-msg"]')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2500);
    await panel.getByRole('button', { name: 'Regen' }).click();
    await expect(panel).toContainText('Played chunk 1/1', { timeout: 180000 });
    await expect
      .poll(() => speakResponses.length)
      .toBeGreaterThan(0);
    expect(speakResponses.at(-1)).toMatchObject({
      status: 200,
      body: {
        ok: true,
        voiceId: expect.any(String),
        referenceVoice: expect.any(String),
      },
    });

    await page.evaluate(() => window.addLongAssistant());
    await expect(page.locator('[data-message-id="ref-pet-long-msg"]')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2500);
    await panel.getByRole('button', { name: 'Next' }).click();
    await expect(panel).toContainText('Played chunk 1/', { timeout: 180000 });
    expect(speakResponses.at(-1)).toMatchObject({
      status: 200,
      body: {
        ok: true,
        voiceId: expect.any(String),
        referenceVoice: expect.any(String),
      },
    });
  } finally {
    await ctx.close().catch(() => {});
    if (api) api.kill();
  }
});
