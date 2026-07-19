const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { test, expect, chromium } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '../..');
const API_PORT = Number(process.env.LOCAL_VOICE_E2E_PORT || 18717);
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const SOURCE_EXTENSION = path.join(ROOT, 'extension');
const EXTENSION_DIR = path.join(os.tmpdir(), `local-voice-extension-real-${process.pid}-${Date.now()}`);
const EXTENSION_ARG = EXTENSION_DIR.replaceAll('\\', '/');
const CONTROL_STATE = path.join(os.tmpdir(), `local-voice-control-state-${process.pid}-${Date.now()}.json`);
const PET_STATE = path.join(os.tmpdir(), `local-voice-pet-state-${process.pid}-${Date.now()}.json`);
const AUDIO_DIR = path.join(ROOT, 'local-api', 'runtime', 'audio');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let apiProcess = null;
let initialAudioFiles = new Set();
let profileCounter = 0;

function prepareTestExtension() {
  fs.rmSync(EXTENSION_DIR, { recursive: true, force: true });
  fs.cpSync(SOURCE_EXTENSION, EXTENSION_DIR, { recursive: true });
  const manifestPath = path.join(EXTENSION_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [`${API_BASE}/*`];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
}

async function healthy() {
  try {
    const response = await fetch(`${API_BASE}/health`);
    const body = await response.json();
    return response.ok && body.ok === true && body.runtime === 'irodori_direct';
  } catch (_) {
    return false;
  }
}

async function startApi() {
  if (await healthy()) throw new Error(`test port ${API_PORT} is already in use`);
  const python = path.join(ROOT, 'local-api', '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(python)) throw new Error(`missing venv python: ${python}`);
  const proc = spawn(python, ['server.py'], {
    cwd: path.join(ROOT, 'local-api'),
    env: {
      ...process.env,
      LOCAL_VOICE_PORT: String(API_PORT),
      LOCAL_VOICE_PUBLIC_BASE_URL: API_BASE,
      LOCAL_VOICE_CONTROL_STATE: CONTROL_STATE,
      LOCAL_VOICE_DESKTOP_PET_SETTINGS: PET_STATE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (data) => process.stdout.write(`[local-api] ${data}`));
  proc.stderr.on('data', (data) => process.stderr.write(`[local-api] ${data}`));
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    if (await healthy()) return proc;
    if (proc.exitCode !== null) break;
    await wait(500);
  }
  if (proc.exitCode === null) proc.kill();
  throw new Error('local API did not become healthy');
}

function listAudioFiles() {
  if (!fs.existsSync(AUDIO_DIR)) return new Set();
  return new Set(fs.readdirSync(AUDIO_DIR).filter((name) => /\.(wav|mp3|flac|ogg|m4a|aac)$/i.test(name)));
}

async function controlSnapshot() {
  const response = await fetch(`${API_BASE}/v1/control-panel`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  return body;
}

async function updateControlSettings(payload) {
  const response = await fetch(`${API_BASE}/v1/control-panel/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  return body;
}

async function sendControlCommand(command) {
  const response = await fetch(`${API_BASE}/v1/control-panel/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  return body;
}

async function waitForControlReady(tabsCount) {
  await expect.poll(async () => {
    const state = await controlSnapshot();
    return {
      connected: state.extension.connected,
      tabsCount: state.extension.tabsCount,
    };
  }, { timeout: 30000 }).toEqual({ connected: true, tabsCount });
}

async function waitForPlayed(textFragment, chunkLabel = null) {
  await expect.poll(async () => {
    const state = await controlSnapshot();
    return {
      status: state.extension.statusText,
      text: state.extension.currentText,
      queue: state.extension.queueSize,
    };
  }, { timeout: 180000, intervals: [500, 1000, 2000] }).toEqual({
    status: chunkLabel ? `Played chunk ${chunkLabel}` : 'Played chunk 1/1',
    text: expect.stringContaining(textFragment),
    queue: 0,
  });
}

async function launchContext() {
  const profile = path.join(ROOT, `.e2e-profile-external-${process.pid}-${profileCounter++}-${Date.now()}`);
  fs.rmSync(profile, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profile, {
    headless: process.env.PLAYWRIGHT_HEADED !== '1',
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${EXTENSION_ARG}`,
      `--load-extension=${EXTENSION_ARG}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--mute-audio',
    ],
  });
  return { context, profile };
}

async function configureExtension(worker) {
  await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get('settingsVersion')).settingsVersion)).toBe(9);
  await worker.evaluate(async ({ apiBase }) => {
    await chrome.storage.local.set({
      apiUrl: `${apiBase}/v1/speak`,
      healthUrl: `${apiBase}/health`,
      model: 'irodori-v3',
      voiceProfile: 'irodori-v3',
      voiceId: '',
      referenceVoice: '',
      voiceVolume: 0,
      enabled: false,
    });
  }, { apiBase: API_BASE });
}

function singleReplyHtml(message, id = 'reply') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT fixture</title></head><body><main id="chat"><button id="add">add</button></main><script>document.querySelector('#add').addEventListener('click',()=>{const turn=document.createElement('article');turn.dataset.testid='conversation-turn-assistant';const node=document.createElement('div');node.dataset.messageAuthorRole='assistant';node.dataset.messageId=${JSON.stringify(id)};node.textContent=${JSON.stringify(message)};turn.append(node);document.querySelector('#chat').append(turn);});</script></body></html>`;
}

function multiChunkHtml() {
  const text = [
    '1行目は自動再生されます。',
    '2行目も最初のチャンクです。',
    '3行目はNextで再生されます。',
    '4行目も次のチャンクです。',
  ].join('\n');
  return singleReplyHtml(text, 'multi-reply');
}

test.beforeAll(async () => {
  prepareTestExtension();
  initialAudioFiles = listAudioFiles();
  apiProcess = await startApi();
});

test.afterAll(async () => {
  if (apiProcess && apiProcess.exitCode === null) apiProcess.kill();
  fs.rmSync(EXTENSION_DIR, { recursive: true, force: true });
  fs.rmSync(CONTROL_STATE, { force: true });
  fs.rmSync(PET_STATE, { force: true });
  for (const name of listAudioFiles()) {
    if (!initialAudioFiles.has(name)) fs.rmSync(path.join(AUDIO_DIR, name), { force: true });
  }
});

test('external Auto generates, fetches, and finishes one real Irodori reply', async () => {
  test.setTimeout(240000);
  const { context, profile } = await launchContext();
  const message = '外部Local Voiceパネルから有効にした自動読み上げの実Irodori確認です。';
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await configureExtension(worker);
    await updateControlSettings({ enabled: false, voiceVolume: 0, referenceVoice: '' });
    const page = await context.newPage();
    await page.route('https://chatgpt.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: singleReplyHtml(message) }));
    await page.goto('https://chatgpt.com/c/auto', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#chat')).toBeVisible();
    await expect(page.locator('#local-voice-bridge-panel')).toHaveCount(0);
    await waitForControlReady(1);
    await updateControlSettings({ enabled: true, voiceVolume: 0, referenceVoice: '' });
    await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get('enabled')).enabled)).toBe(true);
    const before = listAudioFiles().size;
    await page.locator('#add').click();
    await waitForPlayed(message.slice(0, 20));
    await expect.poll(() => listAudioFiles().size, { timeout: 180000 }).toBeGreaterThan(before);
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('external Next advances to the next two-line real Irodori chunk', async () => {
  test.setTimeout(300000);
  const { context, profile } = await launchContext();
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await configureExtension(worker);
    await updateControlSettings({ enabled: false, voiceVolume: 0, referenceVoice: '' });
    const page = await context.newPage();
    await page.route('https://chatgpt.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: multiChunkHtml() }));
    await page.goto('https://chatgpt.com/c/multi', { waitUntil: 'domcontentloaded' });
    await waitForControlReady(1);
    await updateControlSettings({ enabled: true, voiceVolume: 0, referenceVoice: '' });
    await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get('enabled')).enabled)).toBe(true);
    await page.locator('#add').click();
    await waitForPlayed('1行目は自動再生されます。', '1/2');
    await sendControlCommand('next');
    await waitForPlayed('3行目はNextで再生されます。', '2/2');
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('external Ref selection synchronizes Chrome storage, desktop pet, and real speech', async () => {
  test.setTimeout(300000);
  const voicesResponse = await fetch(`${API_BASE}/v1/reference-voices`);
  const voicesBody = await voicesResponse.json();
  const voice = (voicesBody.voices || []).find((item) => item && item.id);
  test.skip(!voice, 'No local reference voice is configured');

  const { context, profile } = await launchContext();
  const message = '外部パネルで選択した参照音声とペットの連動を確認します。';
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await configureExtension(worker);
    const page = await context.newPage();
    await page.route('https://chatgpt.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: singleReplyHtml(message, 'ref-reply') }));
    await page.goto('https://chatgpt.com/c/ref', { waitUntil: 'domcontentloaded' });
    await waitForControlReady(1);
    await updateControlSettings({ enabled: true, voiceVolume: 0, referenceVoice: voice.id });
    await expect.poll(async () => worker.evaluate(async () => chrome.storage.local.get(['voiceId', 'referenceVoice']))).toEqual({ voiceId: voice.id, referenceVoice: voice.id });
    await expect.poll(async () => {
      const response = await fetch(`${API_BASE}/v1/desktop-pet`);
      return (await response.json()).selectedPetId;
    }).toBe(String(voice.id).toLowerCase());
    await page.locator('#add').click();
    await waitForPlayed(message.slice(0, 20));
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('two ChatGPT tabs both feed the same real Irodori Auto queue', async () => {
  test.setTimeout(360000);
  const { context, profile } = await launchContext();
  const firstText = '左側のChatGPTタブから届いた実音声確認です。';
  const secondText = '右側のChatGPTタブから届いた実音声確認です。';
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await configureExtension(worker);
    await updateControlSettings({ enabled: false, voiceVolume: 0, referenceVoice: '' });
    const pages = [await context.newPage(), await context.newPage()];
    const texts = [firstText, secondText];
    for (let index = 0; index < pages.length; index += 1) {
      await pages[index].route('https://chatgpt.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: singleReplyHtml(texts[index], `reply-${index}`) }));
      await pages[index].goto(`https://chatgpt.com/c/tab-${index}`, { waitUntil: 'domcontentloaded' });
      await expect(pages[index].locator('#local-voice-bridge-panel')).toHaveCount(0);
    }
    await waitForControlReady(2);
    await updateControlSettings({ enabled: true, voiceVolume: 0, referenceVoice: '' });
    await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get('enabled')).enabled)).toBe(true);
    const before = listAudioFiles().size;
    await pages[0].locator('#add').click();
    await pages[1].locator('#add').click();
    await waitForPlayed(secondText.slice(0, 18));
    await expect.poll(() => listAudioFiles().size, { timeout: 300000 }).toBeGreaterThanOrEqual(before + 2);
    expect((await controlSnapshot()).extension.tabsCount).toBe(2);
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
