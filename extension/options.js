const SETTINGS_VERSION = 7;
const LEGACY_DEFAULT_API_URL = 'http://127.0.0.1:8765/v1/speak';
const LEGACY_DEFAULT_HEALTH_URL = 'http://127.0.0.1:8765/health';
const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  enabled: false,
  apiUrl: 'http://127.0.0.1:8717/v1/speak',
  healthUrl: 'http://127.0.0.1:8717/health',
  model: 'irodori-v3',
  voiceId: '',
  voiceProfile: 'irodori-v3',
  referenceVoice: '',
  voiceVolume: 0.6,
  previewMaxLines: 2,
  previewMaxChars: 80,
  previewMinChars: 40,
  previewStableMs: 800,
  panelCollapsed: true,
};

const $ = (id) => document.getElementById(id);

function setStatus(message, isError = false) {
  const node = $('status');
  node.textContent = message;
  node.style.color = isError ? '#b00020' : '#0a6b21';
}

function clampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.voiceVolume;
  return Math.min(1, Math.max(0, n));
}

function renderVoiceVolumePercent(value) {
  const percent = Math.round(clampVolume(value) * 100);
  $('voiceVolumeValue').textContent = `${percent}%`;
}

function preferCurrentUnlessLegacyOrEmpty(currentValue, legacyValue, defaultValue) {
  const value = String(currentValue || '').trim();
  if (!value || value === legacyValue) return defaultValue;
  return value;
}

function normalizeReferenceVoice(value) {
  const normalized = String(value || '').trim();
  if (!normalized || ['none', 'suguha', 'misaka', 'qwen3', 'qwen'].includes(normalized.toLowerCase())) return '';
  return normalized;
}

async function migrateIfNeeded() {
  const all = await chrome.storage.local.get(null);
  const version = Number(all.settingsVersion || 0);
  if (version >= SETTINGS_VERSION) return;
  const model = DEFAULT_SETTINGS.model;
  const voiceId = normalizeReferenceVoice(all.voiceId || all.referenceVoice || DEFAULT_SETTINGS.voiceId);
  const migrated = {
    ...DEFAULT_SETTINGS,
    ...all,
    settingsVersion: SETTINGS_VERSION,
    apiUrl: preferCurrentUnlessLegacyOrEmpty(all.apiUrl, LEGACY_DEFAULT_API_URL, DEFAULT_SETTINGS.apiUrl),
    healthUrl: preferCurrentUnlessLegacyOrEmpty(all.healthUrl, LEGACY_DEFAULT_HEALTH_URL, DEFAULT_SETTINGS.healthUrl),
    model,
    voiceId,
    voiceProfile: model,
    referenceVoice: voiceId,
    voiceVolume: clampVolume(all.voiceVolume),
    voicePrompt: '',
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
  $('voiceProfile').value = DEFAULT_SETTINGS.model;
  $('referenceVoice').value = normalizeReferenceVoice(settings.voiceId || settings.referenceVoice || '');
  $('voiceVolume').value = String(Math.round(clampVolume(settings.voiceVolume) * 100));
  renderVoiceVolumePercent(settings.voiceVolume);
  $('previewMaxLines').value = settings.previewMaxLines;
  $('previewMaxChars').value = settings.previewMaxChars;
  $('previewMinChars').value = settings.previewMinChars;
  $('previewStableMs').value = settings.previewStableMs;
  $('panelCollapsed').checked = Boolean(settings.panelCollapsed);
}

async function save() {
  const voiceVolume = clampVolume((Number($('voiceVolume').value) || 0) / 100);
  const model = DEFAULT_SETTINGS.model;
  const voiceId = normalizeReferenceVoice($('referenceVoice').value);
  const settings = {
    settingsVersion: SETTINGS_VERSION,
    enabled: $('enabled').checked,
    apiUrl: $('apiUrl').value.trim() || DEFAULT_SETTINGS.apiUrl,
    healthUrl: $('healthUrl').value.trim() || DEFAULT_SETTINGS.healthUrl,
    model,
    voiceId,
    voiceProfile: model,
    referenceVoice: voiceId,
    voiceVolume,
    previewMaxLines: Number($('previewMaxLines').value || DEFAULT_SETTINGS.previewMaxLines),
    previewMaxChars: Number($('previewMaxChars').value || DEFAULT_SETTINGS.previewMaxChars),
    previewMinChars: Number($('previewMinChars').value || DEFAULT_SETTINGS.previewMinChars),
    previewStableMs: Number($('previewStableMs').value || DEFAULT_SETTINGS.previewStableMs),
    panelCollapsed: $('panelCollapsed').checked,
  };
  await chrome.storage.local.set(settings);
  renderVoiceVolumePercent(voiceVolume);
  setStatus('Saved. Reload the ChatGPT tab to apply immediately.');
}

async function testApi() {
  await save();
  try {
    const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
    const model = settings.model || settings.voiceProfile || DEFAULT_SETTINGS.model;
    const voiceId = settings.voiceId || settings.referenceVoice || '';
    const response = await fetch(settings.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Local Voice API options test.', requestId: 'options-test', model: DEFAULT_SETTINGS.model, voiceId, voiceProfile: DEFAULT_SETTINGS.model, referenceVoice: voiceId }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    setStatus(`API OK: ${payload.engine} / ${payload.model || payload.voiceProfile || model} / ${payload.voiceId || 'none'} / ${payload.audioUrl}`);
  } catch (error) {
    setStatus(`API NG: ${error.message || error}`, true);
  }
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', testApi);
$('voiceVolume').addEventListener('input', () => {
  renderVoiceVolumePercent((Number($('voiceVolume').value) || 0) / 100);
});
load();

