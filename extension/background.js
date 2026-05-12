const NATIVE_HOST_NAME = 'com.chatgpt.local_voice_bridge';
const SETTINGS_VERSION = 2;
const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  enabled: false,
  apiUrl: 'http://127.0.0.1:8765/v1/speak',
  healthUrl: 'http://127.0.0.1:8765/health',
  previewMaxLines: 2,
  previewMaxChars: 80,
  previewMinChars: 25,
  previewStableMs: 800,
  panelCollapsed: true,
};

async function migrateSettings() {
  const current = await chrome.storage.local.get(null);
  const version = Number(current.settingsVersion || 0);
  if (version >= SETTINGS_VERSION) {
    await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...current });
    return;
  }
  const migrated = {
    ...DEFAULT_SETTINGS,
    ...current,
    settingsVersion: SETTINGS_VERSION,
    previewMaxLines: DEFAULT_SETTINGS.previewMaxLines,
    previewMaxChars: DEFAULT_SETTINGS.previewMaxChars,
    previewMinChars: DEFAULT_SETTINGS.previewMinChars,
    previewStableMs: DEFAULT_SETTINGS.previewStableMs,
  };
  if (typeof current.panelCollapsed !== 'boolean') {
    migrated.panelCollapsed = DEFAULT_SETTINGS.panelCollapsed;
  }
  await chrome.storage.local.set(migrated);
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let body;
  try {
    body = await response.json();
  } catch (_error) {
    throw new Error(`Local API returned non-JSON response: ${response.status}`);
  }

  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Local API failed: ${response.status}`);
  }
  return body;
}

async function speak(text, requestId) {
  const settings = await getSettings();
  return postJson(settings.apiUrl, { text, requestId, source: 'chatgpt-web' });
}

async function health() {
  const settings = await getSettings();
  const response = await fetch(settings.healthUrl, { method: 'GET', cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function callNativeHost(command) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      reject(new Error(error && error.message ? error.message : 'Native host is not available'));
      return;
    }

    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch (_error) {}
      handler(value);
    };

    port.onMessage.addListener((message) => {
      if (!message || !message.ok) {
        finish(reject, new Error((message && message.error) || 'Native host command failed'));
        return;
      }
      finish(resolve, message);
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      const detail = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Native host disconnected';
      finish(reject, new Error(detail));
    });

    try {
      port.postMessage({ command });
    } catch (error) {
      finish(reject, new Error(error && error.message ? error.message : 'Failed to send native host message'));
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await migrateSettings();
});

chrome.runtime.onStartup.addListener(async () => {
  await migrateSettings();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'speak') {
    speak(String(message.text || ''), String(message.requestId || ''))
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'health') {
    health()
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'native-status') {
    callNativeHost('status')
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'native-start') {
    callNativeHost('start')
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'native-stop') {
    callNativeHost('stop')
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  return false;
});
