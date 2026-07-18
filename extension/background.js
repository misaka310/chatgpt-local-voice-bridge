const SETTINGS_VERSION = 8;
const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  enabled: false,
  apiUrl: 'http://127.0.0.1:8717/v1/speak',
  healthUrl: 'http://127.0.0.1:8717/health',
  voiceProfile: 'irodori-v3',
  voiceId: '',
  referenceVoice: '',
  voicePrompt: '',
  voiceVolume: 0.6,
  previewMaxLines: 2,
  previewMaxChars: 80,
  previewMinChars: 40,
  previewStableMs: 1000,
  panelCollapsed: true,
};
const LEGACY_PET_STORAGE_KEYS = ['petMode', 'selectedPetId', 'petPosition'];

const tabs = new Map();
let selectedTabId = null;
let uiOwnerTabId = null;
let queue = [];
let isPlaying = false;
let playbackPhase = 'idle';
let currentItem = null;
let currentToken = null;
let lastPlayedItem = null;
let seq = 1;
let lastStatusText = 'Ready';
let lastStatusLevel = 'info';

function normalizeModel(_value) {
  return DEFAULT_SETTINGS.voiceProfile;
}

function normalizeStoredReference(value) {
  const normalized = normalizeReferenceVoice(value);
  if (!normalized || ['qwen3', 'qwen', 'none'].includes(normalized.toLowerCase())) return '';
  return normalized;
}
function storedReferenceVoice(raw) {
  if (raw && Object.prototype.hasOwnProperty.call(raw, 'voiceId')) return normalizeStoredReference(raw.voiceId);
  return normalizeStoredReference(raw && raw.referenceVoice);
}

function sanitizeSettings(raw = {}) {
  const sanitized = {
    ...DEFAULT_SETTINGS,
    ...raw,
    settingsVersion: SETTINGS_VERSION,
    model: DEFAULT_SETTINGS.voiceProfile,
    voiceId: storedReferenceVoice(raw),
    voiceProfile: normalizeModel(raw.model || raw.voiceProfile),
    referenceVoice: storedReferenceVoice(raw),
    voicePrompt: '',
  };
  for (const key of LEGACY_PET_STORAGE_KEYS) delete sanitized[key];
  return sanitized;
}

async function migrateSettings() {
  const current = await chrome.storage.local.get(null);
  await chrome.storage.local.set(sanitizeSettings(current));
  await chrome.storage.local.remove(LEGACY_PET_STORAGE_KEYS);
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const sanitized = sanitizeSettings(stored);
  if (stored.voiceProfile !== sanitized.voiceProfile || stored.referenceVoice !== sanitized.referenceVoice || stored.settingsVersion !== SETTINGS_VERSION) {
    await chrome.storage.local.set(sanitized);
  }
  return sanitized;
}

function cloneItem(item) {
  return item ? { ...item } : null;
}

function setStatus(text, level = 'info') {
  lastStatusText = String(text || 'Ready');
  lastStatusLevel = String(level || 'info');
}

function ensureOwner() {
  const ids = Array.from(tabs.keys());
  if (!ids.length) {
    uiOwnerTabId = null;
    selectedTabId = null;
    return;
  }
  if (!uiOwnerTabId || !tabs.has(uiOwnerTabId)) uiOwnerTabId = ids[0];
  if (!selectedTabId || !tabs.has(selectedTabId)) selectedTabId = uiOwnerTabId;
}

function statePayload(forTabId = null) {
  ensureOwner();
  return {
    isUiOwner: forTabId ? forTabId === uiOwnerTabId : undefined,
    uiOwnerTabId,
    selectedTabId,
    tabs: Array.from(tabs.entries()).map(([id, info]) => ({ id, title: info.title, url: info.url })),
    queueSize: queue.length,
    isPlaying,
    playbackPhase,
    currentPlayingItem: cloneItem(currentItem),
    lastPlayedItem: cloneItem(lastPlayedItem),
    replayAvailable: Boolean(lastPlayedItem && lastPlayedItem.audioUrl),
    statusText: lastStatusText,
    statusLevel: lastStatusLevel,
  };
}

function broadcastState() {
  for (const tabId of tabs.keys()) {
    chrome.tabs.sendMessage(tabId, { type: 'state-update', payload: statePayload(tabId) }).catch(() => {});
  }
}


function normalizeReferenceVoice(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || ['none', 'qwen3', 'qwen'].includes(normalized.toLowerCase())) return '';
  return normalized;
}

function resolveReferenceVoice(explicitValue, fallbackValue = '') {
  if (explicitValue !== undefined && explicitValue !== null) return normalizeReferenceVoice(explicitValue);
  return normalizeReferenceVoice(fallbackValue);
}

function referenceVoiceFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(payload, 'voiceId')) {
    return normalizeStoredReference(payload.voiceId);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'referenceVoice')) {
    return normalizeStoredReference(payload.referenceVoice);
  }
  return undefined;
}

async function speak(text, requestId, voiceProfile, referenceVoice, voicePrompt) {
  const settings = await getSettings();
  const pickedProfile = DEFAULT_SETTINGS.voiceProfile;
  const pickedReferenceVoice = normalizeStoredReference(referenceVoice !== undefined ? referenceVoice : settings.referenceVoice);
  const pickedVoicePrompt = '';
  const response = await fetch(settings.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, requestId, source: 'chatgpt-web', model: pickedProfile, voiceProfile: pickedProfile, voiceId: pickedReferenceVoice, referenceVoice: pickedReferenceVoice, voicePrompt: pickedVoicePrompt, instruct: pickedVoicePrompt }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function isAllowedAudioUrl(targetUrl, settings) {
  try {
    const target = new URL(String(targetUrl || ''));
    if (!target.pathname.startsWith('/audio/')) return false;
    const allowedHosts = new Set(['127.0.0.1', 'localhost']);
    if (!allowedHosts.has(target.hostname)) return false;
    const candidates = [settings.apiUrl, settings.healthUrl]
      .map((value) => {
        try {
          return new URL(String(value || ''));
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);
    return candidates.some((candidate) => allowedHosts.has(candidate.hostname)
      && candidate.protocol === target.protocol
      && candidate.port === target.port);
  } catch (_error) {
    return false;
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function fetchAudioPayload(url) {
  const targetUrl = String(url || '');
  const settings = await getSettings();
  if (!isAllowedAudioUrl(targetUrl, settings)) {
    throw new Error('unsupported audio URL');
  }
  const cacheBustedUrl = `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
  const response = await fetch(cacheBustedUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`audio fetch failed: ${response.status}`);
  const contentType = response.headers.get('Content-Type') || 'audio/wav';
  const buffer = await response.arrayBuffer();
  if (!buffer || buffer.byteLength === 0) throw new Error('audio blob is empty');
  return { base64: arrayBufferToBase64(buffer), contentType, size: buffer.byteLength };
}

async function fetchReferenceVoices() {
  const settings = await getSettings();
  const candidates = [];
  try {
    const healthUrl = new URL(settings.healthUrl || DEFAULT_SETTINGS.healthUrl);
    const refUrl = new URL(healthUrl.toString());
    refUrl.pathname = '/v1/reference-voices';
    refUrl.search = '';
    candidates.push(refUrl.toString(), healthUrl.toString());
  } catch (_error) {
    candidates.push('http://127.0.0.1:8717/v1/reference-voices', settings.healthUrl || DEFAULT_SETTINGS.healthUrl);
  }

  for (const url of candidates) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body) continue;
      const voices = Array.isArray(body.voices) ? body.voices : Array.isArray(body.referenceVoices) ? body.referenceVoices : Array.isArray(body.availableReferenceVoices) ? body.availableReferenceVoices : [];
      return { ok: true, voices };
    } catch (_error) {}
  }
  return { ok: true, voices: [] };
}

async function syncDesktopPetSelection(petId) {
  const settings = await getSettings();
  const url = new URL(settings.healthUrl || DEFAULT_SETTINGS.healthUrl);
  url.pathname = '/v1/desktop-pet';
  url.search = '';
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ petId: String(petId || 'placeholder') }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function enqueue(base, front = false) {
  const item = {
    id: `q-${Date.now()}-${seq++}`,
    mode: String(base.mode || 'manual'),
    reason: String(base.reason || 'manual'),
    tabId: Number(base.tabId),
    tabTitle: String(base.tabTitle || 'ChatGPT'),
    messageKey: String(base.messageKey || ''),
    chunkIndex: Number(base.chunkIndex || 0),
    chunkCount: Number(base.chunkCount || 0),
    text: String(base.text || ''),
    voiceProfile: DEFAULT_SETTINGS.voiceProfile,
    referenceVoice: base.referenceVoice === undefined ? undefined : normalizeStoredReference(base.referenceVoice),
    voicePrompt: '',
    audioUrl: base.audioUrl ? String(base.audioUrl) : null,
  };
  if (front) queue.unshift(item);
  else queue.push(item);
  return item;
}

function chunkLabel(item) {
  const index = Math.max(0, Number(item?.chunkIndex || 0)) + 1;
  const count = Math.max(0, Number(item?.chunkCount || 0));
  return count > 0 ? `${index}/${count}` : String(index);
}

function selectedTarget(senderTabId) {
  if (senderTabId && tabs.has(senderTabId)) return senderTabId;
  if (selectedTabId && tabs.has(selectedTabId)) return selectedTabId;
  return Array.from(tabs.keys())[0] || null;
}

function queueCommand(cmd, senderTabId, params = {}) {
  const tabId = selectedTarget(senderTabId);
  if (!tabId || !tabs.has(tabId)) {
    setStatus('No ChatGPT tab selected', 'warn');
    return { ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } };
  }
  const info = tabs.get(tabId);
  const message = info.lastAssistantMessage;
  if (!message || !Array.isArray(message.chunks) || !message.chunks.length) {
    setStatus('No assistant response yet', 'warn');
    return { ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } };
  }
  const lastReadIndex = Number.isInteger(info.lastReadIndex) ? info.lastReadIndex : -1;
  let chunkIndex = 0;
  if (cmd === 'next') {
    chunkIndex = lastReadIndex < 0 ? 0 : lastReadIndex + 1;
    if (chunkIndex >= message.chunks.length) {
      setStatus('End of response', 'info');
      return { ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } };
    }
  }
  if (cmd === 'regen') {
    chunkIndex = Math.min(message.chunks.length - 1, Math.max(0, lastReadIndex));
  }
  info.lastReadIndex = chunkIndex;
  const text = String(message.chunks[chunkIndex] || '').trim();
  if (!text) return { ok: true, payload: { statusText: 'Chunk text is empty', statusLevel: 'warn' } };
  enqueue({
    mode: cmd,
    reason: cmd,
    tabId,
    tabTitle: info.title,
    messageKey: message.messageKey,
    chunkIndex,
    chunkCount: message.chunks.length,
    text,
    voiceProfile: DEFAULT_SETTINGS.voiceProfile,
    referenceVoice: referenceVoiceFromPayload(params),
    voicePrompt: '',
  });
  setStatus(`${cmd === 'regen' ? 'Regen' : 'Next'} chunk ${chunkIndex + 1}/${message.chunks.length}`, 'info');
  void playNext();
  return { ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } };
}

async function playNext() {
  if (isPlaying) return;
  ensureOwner();
  if (!uiOwnerTabId || !tabs.has(uiOwnerTabId)) return broadcastState();
  const item = queue.shift();
  if (!item) return broadcastState();
  isPlaying = true;
  playbackPhase = 'generating';
  currentItem = item;
  currentToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  setStatus(`Generating audio chunk ${chunkLabel(item)}`, 'info');
  broadcastState();
  try {
    if (!item.audioUrl) {
      const payload = await speak(item.text, `bg-${item.id}`, item.voiceProfile, item.referenceVoice, item.voicePrompt);
      item.audioUrl = payload.audioUrl;
      item.usedReferenceAudio = String(payload.usedReferenceAudio || "");
      item.voiceProfile = String(payload.voiceProfile || item.voiceProfile || "");
      item.referenceVoice = String(payload.referenceVoice || item.referenceVoice || "");
    }
    playbackPhase = 'playing';
    setStatus(`Playing chunk ${chunkLabel(item)}`, 'info');
    broadcastState();
    await chrome.tabs.sendMessage(uiOwnerTabId, { type: 'play-audio', payload: { url: item.audioUrl, text: item.text, playbackToken: currentToken, item: cloneItem(item) } });
  } catch (error) {
    isPlaying = false;
    playbackPhase = 'idle';
    currentItem = null;
    currentToken = null;
    setStatus(`Playback failed: ${error.message || String(error)}`, 'error');
    broadcastState();
    void playNext();
  }
}

function finishPlayback(message) {
  const token = String((message && message.playbackToken) || '');
  if (!isPlaying || token !== currentToken) return { ok: true, payload: { ignored: true } };
  const done = currentItem;
  isPlaying = false;
  playbackPhase = 'idle';
  currentItem = null;
  currentToken = null;
  if (message.ok && !message.stopped) {
    lastPlayedItem = { ...cloneItem(done), playedAt: new Date().toISOString() };
    setStatus(`Played chunk ${chunkLabel(done)}`, 'info');
  } else {
    setStatus(message.stopped ? 'Playback stopped' : `Playback error: ${String(message.error || 'unknown')}`, message.stopped ? 'info' : 'error');
  }
  broadcastState();
  void playNext();
  return { ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } };
}

chrome.runtime.onInstalled.addListener(migrateSettings);
chrome.runtime.onStartup.addListener(migrateSettings);
chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  queue = queue.filter((item) => item.tabId !== tabId);
  if (uiOwnerTabId === tabId) uiOwnerTabId = null;
  if (selectedTabId === tabId) selectedTabId = null;
  broadcastState();
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!tabs.has(tabId)) return;
  uiOwnerTabId = tabId;
  selectedTabId = tabId;
  broadcastState();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  const senderTabId = sender.tab ? sender.tab.id : null;

  if (message.type === 'register-tab') {
    if (senderTabId) {
      const existing = tabs.get(senderTabId) || { lastAssistantMessage: null, lastReadIndex: -1, lastAutoQueueSignature: '' };
      existing.title = String(message.title || sender.tab.title || 'ChatGPT');
      existing.url = sender.tab.url || existing.url || '';
      tabs.set(senderTabId, existing);
      if (sender.tab.active) {
        uiOwnerTabId = senderTabId;
        selectedTabId = senderTabId;
      }
    }
    sendResponse({ ok: true, payload: statePayload(senderTabId) });
    broadcastState();
    return false;
  }

  if (message.type === 'report-chunks') {
    if (senderTabId && tabs.has(senderTabId)) {
      const info = tabs.get(senderTabId);
      const chunks = Array.isArray(message.chunks) ? message.chunks.map((x) => String(x || '').trim()).filter(Boolean) : [];
      const autoPreview = String(message.autoPreview || '').trim();
      const messageKey = String(message.messageKey || '').trim();
      if (messageKey && chunks.length) {
        if (!info.lastAssistantMessage || info.lastAssistantMessage.messageKey !== messageKey) info.lastReadIndex = -1;
        info.lastAssistantMessage = { messageKey, chunks, capturedAt: Date.now() };
        if (message.isAuto) {
          const autoText = autoPreview || chunks[0] || '';
          const autoQueueSignature = `${messageKey}\u0000${autoText}`;
          if (info.lastAutoQueueSignature !== autoQueueSignature) {
            info.lastAutoQueueSignature = autoQueueSignature;
            info.lastReadIndex = autoText ? 0 : -1;
            if (autoText) {
              enqueue({ mode: 'auto', reason: 'auto', tabId: senderTabId, tabTitle: info.title, messageKey, chunkIndex: 0, chunkCount: chunks.length, text: autoText, voiceProfile: DEFAULT_SETTINGS.voiceProfile, referenceVoice: referenceVoiceFromPayload(message), voicePrompt: '' });
              void playNext();
            }
          }
        }
      }
    }
    sendResponse({ ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } });
    broadcastState();
    return false;
  }

  if (message.type === 'playback-done') {
    sendResponse(finishPlayback(message));
    return false;
  }

  if (message.type === 'fetch-audio') {
    fetchAudioPayload(message.url)
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'reference-voices') {
    fetchReferenceVoices()
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'desktop-pet-selection') {
    syncDesktopPetSelection(message.petId)
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'ui-command') {
    const cmd = String(message.cmd || '');
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    if (cmd === 'stop' || cmd === 'skip') {
      queue = [];
      if (uiOwnerTabId) chrome.tabs.sendMessage(uiOwnerTabId, { type: 'stop-audio', payload: { playbackToken: currentToken } }).catch(() => {});
      isPlaying = false;
      playbackPhase = 'idle';
      currentItem = null;
      currentToken = null;
      setStatus(cmd === 'skip' ? 'Skipped' : 'Stopped', 'info');
      broadcastState();
      if (cmd === 'skip') void playNext();
      sendResponse({ ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } });
      return false;
    }
    if (cmd === 'replay') {
      if (lastPlayedItem && lastPlayedItem.audioUrl) {
        enqueue({ ...lastPlayedItem, mode: 'replay', reason: 'replay' }, true);
        setStatus(`Replay chunk ${chunkLabel(lastPlayedItem)}`, 'info');
      } else {
        setStatus('No replay audio yet', 'warn');
      }
      void playNext();
      sendResponse({ ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } });
      return false;
    }
    if (cmd === 'next' || cmd === 'regen') {
      sendResponse(queueCommand(cmd, senderTabId, params));
      broadcastState();
      return false;
    }
  }
  return false;
});

