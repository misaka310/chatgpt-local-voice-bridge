const DEFAULT_SETTINGS = {
  enabled: true,
  apiUrl: 'http://127.0.0.1:8765/v1/speak',
  healthUrl: 'http://127.0.0.1:8765/health',
  previewMaxLines: 3,
  previewMaxChars: 120,
  previewMinChars: 40,
  previewStableMs: 800,
};

const $ = (id) => document.getElementById(id);

function setStatus(message, isError = false) {
  const node = $('status');
  node.textContent = message;
  node.style.color = isError ? '#b00020' : '#0a6b21';
}

async function load() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  $('enabled').checked = Boolean(settings.enabled);
  $('apiUrl').value = settings.apiUrl;
  $('healthUrl').value = settings.healthUrl;
  $('previewMaxLines').value = settings.previewMaxLines;
  $('previewMaxChars').value = settings.previewMaxChars;
  $('previewMinChars').value = settings.previewMinChars;
  $('previewStableMs').value = settings.previewStableMs;
}

async function save() {
  const settings = {
    enabled: $('enabled').checked,
    apiUrl: $('apiUrl').value.trim() || DEFAULT_SETTINGS.apiUrl,
    healthUrl: $('healthUrl').value.trim() || DEFAULT_SETTINGS.healthUrl,
    previewMaxLines: Number($('previewMaxLines').value || DEFAULT_SETTINGS.previewMaxLines),
    previewMaxChars: Number($('previewMaxChars').value || DEFAULT_SETTINGS.previewMaxChars),
    previewMinChars: Number($('previewMinChars').value || DEFAULT_SETTINGS.previewMinChars),
    previewStableMs: Number($('previewStableMs').value || DEFAULT_SETTINGS.previewStableMs),
  };
  await chrome.storage.local.set(settings);
  setStatus('保存しました。ChatGPTタブを再読み込みすると反映されます。');
}

async function testApi() {
  await save();
  try {
    const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
    const response = await fetch(settings.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'ローカル音声APIの疎通テストです。', requestId: 'options-test' }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    setStatus(`API OK: ${payload.engine} / ${payload.audioUrl}`);
  } catch (error) {
    setStatus(`API NG: ${error.message || error}`, true);
  }
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', testApi);
load();
