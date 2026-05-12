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

const $ = (id) => document.getElementById(id);

function setStatus(message, isError = false) {
  const node = $('status');
  node.textContent = message;
  node.style.color = isError ? '#b00020' : '#0a6b21';
}

async function migrateIfNeeded() {
  const all = await chrome.storage.local.get(null);
  const version = Number(all.settingsVersion || 0);
  if (version >= SETTINGS_VERSION) return;
  const migrated = {
    ...DEFAULT_SETTINGS,
    ...all,
    settingsVersion: SETTINGS_VERSION,
    previewMaxLines: DEFAULT_SETTINGS.previewMaxLines,
    previewMaxChars: DEFAULT_SETTINGS.previewMaxChars,
    previewMinChars: DEFAULT_SETTINGS.previewMinChars,
    previewStableMs: DEFAULT_SETTINGS.previewStableMs,
  };
  await chrome.storage.local.set(migrated);
}

async function load() {
  await migrateIfNeeded();
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  $('enabled').checked = Boolean(settings.enabled);
  $('apiUrl').value = settings.apiUrl;
  $('healthUrl').value = settings.healthUrl;
  $('previewMaxLines').value = settings.previewMaxLines;
  $('previewMaxChars').value = settings.previewMaxChars;
  $('previewMinChars').value = settings.previewMinChars;
  $('previewStableMs').value = settings.previewStableMs;
  $('panelCollapsed').checked = Boolean(settings.panelCollapsed);
}

async function save() {
  const settings = {
    settingsVersion: SETTINGS_VERSION,
    enabled: $('enabled').checked,
    apiUrl: $('apiUrl').value.trim() || DEFAULT_SETTINGS.apiUrl,
    healthUrl: $('healthUrl').value.trim() || DEFAULT_SETTINGS.healthUrl,
    previewMaxLines: Number($('previewMaxLines').value || DEFAULT_SETTINGS.previewMaxLines),
    previewMaxChars: Number($('previewMaxChars').value || DEFAULT_SETTINGS.previewMaxChars),
    previewMinChars: Number($('previewMinChars').value || DEFAULT_SETTINGS.previewMinChars),
    previewStableMs: Number($('previewStableMs').value || DEFAULT_SETTINGS.previewStableMs),
    panelCollapsed: $('panelCollapsed').checked,
  };
  await chrome.storage.local.set(settings);
  setStatus('Saved. Reload the ChatGPT tab to apply immediately.');
}

async function testApi() {
  await save();
  try {
    const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
    const response = await fetch(settings.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Local Voice API options test.', requestId: 'options-test' }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    setStatus(`API OK: ${payload.engine} / ${payload.voiceProfile || 'voice'} / ${payload.audioUrl}`);
  } catch (error) {
    setStatus(`API NG: ${error.message || error}`, true);
  }
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', testApi);
load();
