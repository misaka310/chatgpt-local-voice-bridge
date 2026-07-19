(() => {
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
  const AUTO_SENT_FLAG = 'localVoiceSent';
  const PANEL_POSITION_KEY = 'panelPosition';
  const PANEL_COLLAPSED_KEY = 'panelCollapsed';
  const DEFAULT_PET_ID = 'placeholder';
  const LEGACY_PET_STORAGE_KEYS = ['petMode', 'selectedPetId', 'petPosition'];
  const DEFAULT_REFERENCE_VOICES = [{ id: '', label: 'none' }];

  const stateByElement = new WeakMap();
  const initializedElements = new WeakSet();
  let settings = { ...DEFAULT_SETTINGS };
  let enabled = false;
  let observer = null;
  let inspectTimer = null;
  let panel = null;
  let panelBody = null;
  let statusNode = null;
  let detailNode = null;
  let titleNode = null;
  let referenceVoiceSelect = null;
  let autoButton = null;
  let actionButtons = [];
  let volumeSlider = null;
  let volumeValueNode = null;
  let currentAudio = null;
  let currentObjectUrl = null;
  let currentPlaybackToken = null;
  let isUiOwner = null;
  let queueSize = 0;
  let dragMovedRecently = false;
  let availableReferenceVoices = DEFAULT_REFERENCE_VOICES.slice();

  function normalizeText(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function isTransientAssistantStatus(text) {
    const normalized = normalizeText(text).replace(/\s+/g, '');
    return /^(?:思考中|考え中|Thinking)(?:[.…。・]+)?$/i.test(normalized);
  }

  function normalizeMarkdownLine(line) {
    return String(line || '')
      .replace(/^>\s*/g, '')
      .replace(/^#{1,6}\s*/g, '')
      .replace(/^\s*[-*+]\s+/g, '')
      .replace(/^\s*\d+\.\s+/g, '')
      .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
      .replace(/[*_~`]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function clampVolume(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS.voiceVolume;
    return Math.min(1, Math.max(0, n));
  }

  function normalizeVoiceId(value) {
    return String(value || '').trim();
  }

  function resolveDesktopPetId(value) {
    const petId = normalizeVoiceId(value).toLowerCase();
    if (!petId || petId === 'none' || petId === '.' || petId === '..' || /[\\/]/.test(petId)) return DEFAULT_PET_ID;
    return petId;
  }

  function normalizeReferenceVoice(value) {
    const normalized = String(value || '').trim();
    if (!normalized || ['none', 'qwen3', 'qwen'].includes(normalized.toLowerCase())) return '';
    return normalized;
  }
  function storedReferenceVoice(raw) {
    if (raw && Object.prototype.hasOwnProperty.call(raw, 'voiceId')) return normalizeReferenceVoice(raw.voiceId);
    return normalizeReferenceVoice(raw && raw.referenceVoice);
  }

  async function sanitizeStoredSettings(raw) {
    const next = {
      ...DEFAULT_SETTINGS,
      ...raw,
      settingsVersion: SETTINGS_VERSION,
      model: DEFAULT_SETTINGS.voiceProfile,
      voiceId: storedReferenceVoice(raw),
      voiceProfile: DEFAULT_SETTINGS.voiceProfile,
      referenceVoice: storedReferenceVoice(raw),
      voicePrompt: '',
    };
    for (const key of LEGACY_PET_STORAGE_KEYS) delete next[key];
    if (globalThis.chrome && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set(next);
      await chrome.storage.local.remove(LEGACY_PET_STORAGE_KEYS);
    }
    return next;
  }

  function getCurrentVoiceProfile() {
    return DEFAULT_SETTINGS.voiceProfile;
  }

  function getCurrentReferenceVoice() {
    return normalizeReferenceVoice(settings.voiceId);
  }

  function getSpeakParams() {
    const referenceVoice = getCurrentReferenceVoice();
    return {
      voiceProfile: getCurrentVoiceProfile(),
      voiceId: referenceVoice,
      referenceVoice,
      voicePrompt: '',
    };
  }

  function splitChunkByMaxChars(text, maxChars, minChars) {
    const trimmed = normalizeText(text);
    if (!trimmed) return { head: '', tail: '' };
    if (trimmed.length <= maxChars) return { head: trimmed, tail: '' };
    const head = trimmed.slice(0, maxChars);
    const punctRegex = /[、。！？!?]/g;
    let punctMatch = null;
    for (const match of head.matchAll(punctRegex)) punctMatch = match;
    if (punctMatch && Number(punctMatch.index) >= Math.floor(minChars * 0.6)) {
      const cut = Number(punctMatch.index) + 1;
      return { head: normalizeText(trimmed.slice(0, cut)), tail: normalizeText(trimmed.slice(cut)) };
    }
    const soft = head.lastIndexOf(' ');
    if (soft >= Math.floor(minChars * 0.6)) {
      return { head: normalizeText(head.slice(0, soft)), tail: normalizeText(trimmed.slice(soft)) };
    }
    return { head: normalizeText(head), tail: normalizeText(trimmed.slice(maxChars)) };
  }

  function normalizeSpeakableLines(fullText) {
    let text = normalizeText(fullText);
    if (!text) return [];
    text = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/\n{2,}/g, '\n');
    return text.split('\n').map((line) => normalizeMarkdownLine(line)).filter(Boolean);
  }

  function buildPreviewSourceText(fullText, options = {}) {
    const maxLines = Number(options.maxLines || DEFAULT_SETTINGS.previewMaxLines);
    const lines = normalizeSpeakableLines(fullText);
    const picked = lines.slice(0, Math.max(1, maxLines));
    const merged = normalizeText(picked.join(' '));
    return merged;
  }

  function extractAutoPreview(fullText, options = {}) {
    const maxChars = Number(options.maxChars || DEFAULT_SETTINGS.previewMaxChars);
    const minChars = Number(options.minChars || DEFAULT_SETTINGS.previewMinChars);
    const merged = buildPreviewSourceText(fullText, options);
    if (!merged) return '';
    return splitChunkByMaxChars(merged, maxChars, minChars).head;
  }

  function splitSpeakChunks(fullText, options = {}) {
    const maxChars = Number(options.maxChars || DEFAULT_SETTINGS.previewMaxChars);
    const minChars = Number(options.minChars || DEFAULT_SETTINGS.previewMinChars);
    const maxLines = Math.max(1, Number(options.maxLines || DEFAULT_SETTINGS.previewMaxLines));
    const lines = normalizeSpeakableLines(fullText);
    const chunks = [];
    for (let index = 0; index < lines.length; index += maxLines) {
      let pending = normalizeText(lines.slice(index, index + maxLines).join(' '));
      while (pending) {
        const split = splitChunkByMaxChars(pending, maxChars, minChars);
        if (!split.head) break;
        chunks.push(split.head);
        if (!split.tail || split.tail === pending) break;
        pending = split.tail;
      }
    }
    return chunks;
  }

  function stableDelayForPreview(preview) {
    const minChars = Number(settings.previewMinChars || DEFAULT_SETTINGS.previewMinChars);
    const stableMs = Number(settings.previewStableMs || DEFAULT_SETTINGS.previewStableMs);
    return preview.length >= minChars ? stableMs : stableMs + 400;
  }

  function shouldSendNow(preview, now, item) {
    if (!preview.length) return false;
    return now - item.lastChangedAt >= stableDelayForPreview(preview);
  }

  function getAssistantNodes() {
    const primary = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    if (primary.length > 0) return primary;
    return Array.from(document.querySelectorAll('article')).filter((node) => {
      const label = `${node.getAttribute('aria-label') || ''} ${node.textContent || ''}`.toLowerCase();
      return label.includes('assistant') || label.includes('chatgpt');
    });
  }

  function getStableKey(node) {
    const turn = node.closest('[data-testid^="conversation-turn-"]');
    const testId = turn && turn.getAttribute('data-testid');
    const messageId = node.getAttribute('data-message-id') || node.dataset.messageId;
    if (messageId) return messageId;
    if (testId) return testId;
    if (!node.__localVoiceBridgeId) node.__localVoiceBridgeId = `node-${Math.random().toString(36).slice(2)}`;
    return node.__localVoiceBridgeId;
  }

  function extractAssistantText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('pre, code, button, svg, menu, nav, script, style, textarea, input, select').forEach((item) => item.remove());
    const text = normalizeText(clone.innerText || clone.textContent || '');
    return isTransientAssistantStatus(text) ? '' : text;
  }

  function ensureElementState(node, text) {
    let item = stateByElement.get(node);
    if (!item) {
      item = { key: getStableKey(node), sent: node.dataset[AUTO_SENT_FLAG] === '1', lastText: text, lastChangedAt: Date.now(), idleTimer: null };
      stateByElement.set(node, item);
    }
    return item;
  }

  function markExistingMessagesAsSeen() {
    for (const node of getAssistantNodes()) {
      const text = extractAssistantText(node);
      initializedElements.add(node);
      const item = stateByElement.get(node);
      if (item && item.idleTimer) clearTimeout(item.idleTimer);
      stateByElement.set(node, { key: getStableKey(node), sent: true, lastText: text, lastChangedAt: Date.now(), idleTimer: null });
      node.dataset[AUTO_SENT_FLAG] = '1';
    }
  }

  function rebaselineAutoMessages() {
    markExistingMessagesAsSeen();
  }

  function runtimeMessage(type, extra = {}) {
    return new Promise((resolve, reject) => {
      if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
        reject(new Error('chrome.runtime is unavailable'));
        return;
      }
      chrome.runtime.sendMessage({ type, ...extra }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.ok) {
          reject(new Error((response && response.error) || 'unknown error'));
          return;
        }
        resolve(response.payload);
      });
    });
  }

  async function reportChunks(entry, isAuto = false) {
    await chrome.runtime.sendMessage({
      type: 'report-chunks',
      messageKey: entry.messageKey,
      chunks: entry.chunks,
      autoPreview: entry.autoPreview,
      isAuto,
      voiceProfile: getCurrentVoiceProfile(),
      ...getSpeakParams(),
      title: document.title,
    }).catch(() => {});
  }

  function processNode(node) {
    const text = extractAssistantText(node);
    if (!text) return;
    const item = ensureElementState(node, text);
    if (item.sent) return;
    if (!initializedElements.has(node)) {
      initializedElements.add(node);
      item.lastText = text;
      item.lastChangedAt = Date.now();
      if (!enabled || !settings.enabled) return;
    }
    if (text !== item.lastText) {
      item.lastText = text;
      item.lastChangedAt = Date.now();
    }
    const chunks = splitSpeakChunks(text, {
      maxLines: Number(settings.previewMaxLines || DEFAULT_SETTINGS.previewMaxLines),
      maxChars: Number(settings.previewMaxChars || DEFAULT_SETTINGS.previewMaxChars),
      minChars: Number(settings.previewMinChars || DEFAULT_SETTINGS.previewMinChars),
    });
    const preview = extractAutoPreview(text, {
      maxLines: Number(settings.previewMaxLines || DEFAULT_SETTINGS.previewMaxLines),
      maxChars: Number(settings.previewMaxChars || DEFAULT_SETTINGS.previewMaxChars),
      minChars: Number(settings.previewMinChars || DEFAULT_SETTINGS.previewMinChars),
    });
    if (!preview) return;
    const entry = { node, text, messageKey: item.key, chunks, autoPreview: preview, capturedAt: Date.now() };
    if (shouldSendNow(preview, Date.now(), item)) {
      item.sent = true;
      node.dataset[AUTO_SENT_FLAG] = '1';
      void reportChunks(entry, Boolean(enabled && settings.enabled));
      return;
    }
    if (item.idleTimer) clearTimeout(item.idleTimer);
    item.idleTimer = setTimeout(() => {
      if (item.sent) return;
      const latest = extractAssistantText(node);
      if (latest !== item.lastText) return;
      const pendingChunks = splitSpeakChunks(latest, {
        maxLines: Number(settings.previewMaxLines || DEFAULT_SETTINGS.previewMaxLines),
        maxChars: Number(settings.previewMaxChars || DEFAULT_SETTINGS.previewMaxChars),
        minChars: Number(settings.previewMinChars || DEFAULT_SETTINGS.previewMinChars),
      });
      const pendingPreview = extractAutoPreview(latest, {
        maxLines: Number(settings.previewMaxLines || DEFAULT_SETTINGS.previewMaxLines),
        maxChars: Number(settings.previewMaxChars || DEFAULT_SETTINGS.previewMaxChars),
        minChars: Number(settings.previewMinChars || DEFAULT_SETTINGS.previewMinChars),
      });
      if (!pendingPreview) return;
      if (shouldSendNow(pendingPreview, Date.now(), item)) {
        item.sent = true;
        node.dataset[AUTO_SENT_FLAG] = '1';
        void reportChunks({ node, text: latest, messageKey: item.key, chunks: pendingChunks, autoPreview: pendingPreview, capturedAt: Date.now() }, Boolean(enabled && settings.enabled));
      }
    }, stableDelayForPreview(preview) + 50);
  }

  function inspectLatestAssistant() {
    const nodes = getAssistantNodes();
    if (nodes.length === 0) return;
    processNode(nodes[nodes.length - 1]);
  }

  function scheduleInspect() {
    if (inspectTimer) return;
    inspectTimer = setTimeout(() => {
      inspectTimer = null;
      inspectLatestAssistant();
    }, 200);
  }

  function setPanelState(statusText, detailText = '') {
    if (statusNode) {
      statusNode.textContent = statusText;
      statusNode.title = detailText || `${getCurrentVoiceProfile()} / Ref=${getCurrentReferenceVoice() || 'none'} / ${queueSize ? `Queued ${queueSize}` : 'Ready'}`;
    }
    if (detailNode) {
      const refText = getCurrentReferenceVoice() || 'none';
      const detail = detailText || `${getCurrentVoiceProfile()} Ref=${refText} / ${queueSize ? `Queued ${queueSize}` : 'ready'}`;
      detailNode.textContent = detail;
      detailNode.title = detail;
    }
    if (titleNode) titleNode.textContent = 'Local Voice';
  }

  function createButton(label, onClick, testId = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (testId) button.dataset.testid = testId;
    button.style.cssText = 'font:600 11px/1.1 system-ui,sans-serif;padding:5px 7px;border-radius:9px;border:1px solid rgba(255,255,255,.18);cursor:pointer;background:rgba(255,255,255,.08);color:#f7f9ff';
    button.addEventListener('click', onClick);
    return button;
  }

  function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
  }

  function clampPanelPosition(left, top) {
    if (!panel) return { left, top };
    const margin = 8;
    const panelWidth = panel.offsetWidth || 300;
    const panelHeight = panel.offsetHeight || 110;
    return {
      left: Math.round(Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - panelWidth - margin))),
      top: Math.round(Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - panelHeight - margin))),
    };
  }

  function applyPanelPosition(position) {
    if (!panel) return;
    if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) {
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '16px';
      panel.style.bottom = 'auto';
      panel.style.top = '72px';
      return;
    }
    const clamped = clampPanelPosition(Number(position.left), Number(position.top));
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = `${clamped.left}px`;
    panel.style.top = `${clamped.top}px`;
  }

  async function persistPanelPosition(left, top) {
    const clamped = clampPanelPosition(left, top);
    settings[PANEL_POSITION_KEY] = clamped;
    await chrome.storage.local.set({ [PANEL_POSITION_KEY]: clamped });
  }

  function makePanelDraggable(dragHandle) {
    let dragState = null;
    const onMove = (event) => {
      if (!dragState) return;
      const clamped = clampPanelPosition(dragState.startLeft + event.clientX - dragState.startX, dragState.startTop + event.clientY - dragState.startY);
      dragMovedRecently = true;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = `${clamped.left}px`;
      panel.style.top = `${clamped.top}px`;
    };
    const onUp = async () => {
      if (!dragState) return;
      const left = Number.parseFloat(panel.style.left || '0');
      const top = Number.parseFloat(panel.style.top || '0');
      dragState = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      await persistPanelPosition(left, top);
      setTimeout(() => { dragMovedRecently = false; }, 0);
    };
    dragHandle.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      dragMovedRecently = false;
      dragState = { startX: event.clientX, startY: event.clientY, startLeft: rect.left, startTop: rect.top };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      event.preventDefault();
    });
  }

  async function setCollapsed(collapsed, persist = true) {
    settings[PANEL_COLLAPSED_KEY] = Boolean(collapsed);
    if (panelBody) panelBody.style.display = collapsed ? 'none' : 'flex';
    if (panel) panel.style.width = collapsed ? 'fit-content' : 'min(92vw,320px)';
    if (panel) panel.style.padding = collapsed ? '8px 10px' : '10px';
    if (persist) await chrome.storage.local.set({ [PANEL_COLLAPSED_KEY]: Boolean(collapsed) });
    setPanelState(statusNode ? statusNode.textContent : 'Ready');
  }

  function syncVolumeSlider() {
    if (!volumeSlider) return;
    const percent = Math.round(clampVolume(settings.voiceVolume) * 100);
    volumeSlider.value = String(percent);
    if (volumeValueNode) volumeValueNode.textContent = `${percent}%`;
  }

  async function persistVoiceVolume(percent) {
    const nextVolume = clampVolume((Number(percent) || 0) / 100);
    settings.voiceVolume = nextVolume;
    syncVolumeSlider();
    if (currentAudio) currentAudio.volume = nextVolume;
    await chrome.storage.local.set({ voiceVolume: nextVolume });
  }

  function createSelectOption(value, label) {
    const opt = document.createElement('option');
    opt.value = String(value);
    opt.textContent = String(label || value || 'none');
    opt.style.backgroundColor = '#ffffff';
    opt.style.color = '#111827';
    return opt;
  }

  function setSelectOptions(select, options, selectedValue) {
    if (!select) return;
    select.innerHTML = '';
    for (const option of options) select.appendChild(createSelectOption(option.id, option.label));
    select.value = String(selectedValue || '');
  }

  function normalizeReferenceVoiceList(rawVoices) {
    const result = DEFAULT_REFERENCE_VOICES.slice();
    const seen = new Set(['']);
    for (const item of Array.isArray(rawVoices) ? rawVoices : []) {
      const id = normalizeReferenceVoice(typeof item === 'string' ? item : item && item.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push({ id, label: String((item && item.label) || id) });
    }
    const current = getCurrentReferenceVoice();
    if (current && !seen.has(current)) result.push({ id: current, label: current });
    return result;
  }

  function referenceVoicesUrl() {
    try {
      const url = new URL(settings.healthUrl || DEFAULT_SETTINGS.healthUrl);
      url.pathname = '/v1/reference-voices';
      url.search = '';
      return url.toString();
    } catch (_error) {
      return 'http://127.0.0.1:8717/v1/reference-voices';
    }
  }

  async function loadReferenceVoiceChoices() {
    try {
      const payload = await runtimeMessage('reference-voices');
      const voices = payload && (payload.voices || payload.referenceVoices || payload.availableReferenceVoices);
      if (voices) {
        availableReferenceVoices = normalizeReferenceVoiceList(voices);
        return;
      }
    } catch (_error) {}

    const urls = [referenceVoicesUrl(), settings.healthUrl || DEFAULT_SETTINGS.healthUrl];
    for (const url of urls) {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload) continue;
        const voices = payload.voices || payload.referenceVoices || payload.availableReferenceVoices;
        availableReferenceVoices = normalizeReferenceVoiceList(voices);
        return;
      } catch (_error) {}
    }
    availableReferenceVoices = normalizeReferenceVoiceList([]);
  }

  function syncReferenceVoiceSelect() {
    setSelectOptions(referenceVoiceSelect, availableReferenceVoices, getCurrentReferenceVoice());
  }

  async function refreshReferenceVoiceChoices() {
    await loadReferenceVoiceChoices();
    syncReferenceVoiceSelect();
  }

  async function syncDesktopPetSelection(referenceVoice = getCurrentReferenceVoice()) {
    const petId = resolveDesktopPetId(referenceVoice);
    try {
      await runtimeMessage('desktop-pet-selection', { petId });
    } catch (error) {
      if (panel) setPanelState('Error', `Desktop pet: ${error.message || String(error)}`);
    }
  }

  async function persistReferenceVoice(value) {
    const referenceVoice = normalizeReferenceVoice(value);
    settings.voiceId = referenceVoice;
    settings.referenceVoice = referenceVoice;
    await chrome.storage.local.set({ voiceId: referenceVoice, referenceVoice, voicePrompt: '' });
    syncReferenceVoiceSelect();
    await syncDesktopPetSelection(referenceVoice);
    setPanelState('Ready', `Ref=${referenceVoice || 'none'}`);
  }

  async function sendUiCommand(cmd, params = {}) {
    try {
      const payload = await runtimeMessage('ui-command', { cmd, params });
      if (payload && payload.statusText) setPanelState(payload.statusLevel === 'error' ? 'Error' : 'Ready', String(payload.statusText));
      return payload || null;
    } catch (error) {
      setPanelState('Error', error.message || String(error));
      return null;
    }
  }

  function createPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'local-voice-bridge-panel';
    panel.style.cssText = 'position:fixed;right:16px;top:72px;bottom:auto;z-index:2147483647;font:12px/1.35 system-ui,sans-serif;background:rgba(10,12,18,.88);color:#f5f7ff;border:1px solid rgba(120,180,255,.25);border-radius:14px;padding:10px;box-shadow:0 10px 28px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:8px;width:min(92vw,320px)';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:move;user-select:none';
    titleNode = document.createElement('div');
    titleNode.textContent = 'Local Voice';
    titleNode.style.cssText = 'font-weight:700';
    statusNode = document.createElement('div');
    statusNode.style.cssText = 'font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;background:rgba(93,171,255,.2)';
    panelBody = document.createElement('div');
    panelBody.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    detailNode = document.createElement('div');
    detailNode.dataset.testid = 'local-voice-current-text';
    detailNode.style.cssText = 'font-size:11px;color:#c8d2e8;min-height:1.2em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    const refRow = document.createElement('div');
    refRow.dataset.localVoiceField = 'ref';
    refRow.style.cssText = 'display:flex;align-items:center;gap:6px';
    const refLabel = document.createElement('div');
    refLabel.textContent = 'Ref';
    refLabel.style.cssText = 'font-size:11px;color:#c8d2e8;min-width:52px';
    referenceVoiceSelect = document.createElement('select');
    referenceVoiceSelect.dataset.testid = 'local-voice-ref';
    referenceVoiceSelect.style.cssText = 'flex:1;min-width:0;font:600 11px system-ui,sans-serif;padding:4px 6px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#f7f9ff';
    referenceVoiceSelect.addEventListener('change', async () => { await persistReferenceVoice(referenceVoiceSelect.value); });
    refRow.append(refLabel, referenceVoiceSelect);

    const volumeRow = document.createElement('div');
    volumeRow.dataset.localVoiceField = 'volume';
    volumeRow.style.cssText = 'display:flex;align-items:center;gap:8px';
    const volumeLabel = document.createElement('div');
    volumeLabel.textContent = 'Volume';
    volumeLabel.style.cssText = 'font-size:11px;color:#c8d2e8;min-width:52px';
    volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.min = '0';
    volumeSlider.max = '100';
    volumeSlider.step = '1';
    volumeSlider.style.cssText = 'flex:1;min-width:0';
    volumeSlider.addEventListener('input', () => { settings.voiceVolume = clampVolume((Number(volumeSlider.value) || 0) / 100); syncVolumeSlider(); if (currentAudio) currentAudio.volume = settings.voiceVolume; });
    volumeSlider.addEventListener('change', async () => { await persistVoiceVolume(volumeSlider.value); });
    volumeValueNode = document.createElement('div');
    volumeValueNode.style.cssText = 'font-size:11px;color:#c8d2e8;min-width:36px;text-align:right';
    volumeRow.append(volumeLabel, volumeSlider, volumeValueNode);

    const controls = document.createElement('div');
    controls.style.cssText = 'display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px';
    autoButton = createButton('Auto', async () => {
      const nextEnabled = !enabled;
      if (nextEnabled) rebaselineAutoMessages();
      enabled = nextEnabled;
      settings.enabled = enabled;
      await chrome.storage.local.set({ enabled });
      setPanelState('Ready', enabled ? 'Auto read enabled' : 'Auto read disabled');
      autoButton.style.background = enabled ? 'rgba(73,168,113,.25)' : 'rgba(255,255,255,.08)';
    });
    const nextButton = createButton('Next', () => {
      setPanelState('Queued', 'Generating audio...');
      void sendUiCommand('next', getSpeakParams());
    });
    const regenButton = createButton('Regen', () => {
      setPanelState('Queued', 'Regenerating current chunk...');
      void sendUiCommand('regen', getSpeakParams());
    });
    const replayButton = createButton('Replay', () => { void sendUiCommand('replay'); });
    for (const button of [autoButton, nextButton, regenButton, replayButton]) {
      button.style.padding = '5px 3px';
      button.style.fontSize = '10px';
      button.style.minWidth = '0';
      button.style.whiteSpace = 'nowrap';
    }
    actionButtons = [nextButton, regenButton];
    controls.append(autoButton, nextButton, regenButton, replayButton);

    header.append(titleNode, statusNode);
    panelBody.append(detailNode, refRow, volumeRow, controls);
    panel.append(header, panelBody);
    document.documentElement.appendChild(panel);
    syncReferenceVoiceSelect();
    void refreshReferenceVoiceChoices();
    syncVolumeSlider();
    autoButton.style.background = enabled ? 'rgba(73,168,113,.25)' : 'rgba(255,255,255,.08)';
    applyPanelPosition(settings[PANEL_POSITION_KEY]);
    void setCollapsed(Boolean(settings[PANEL_COLLAPSED_KEY]), false);
    makePanelDraggable(header);
    header.addEventListener('click', () => { if (!dragMovedRecently) void setCollapsed(!Boolean(settings[PANEL_COLLAPSED_KEY]), true); });
    setPanelState('Ready');
  }

  function releaseObjectUrl() {
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }

  function base64ToBlob(base64, contentType) {
    const binary = atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: contentType || 'audio/wav' });
  }

  async function fetchAudioObjectUrl(url) {
    const payload = await runtimeMessage('fetch-audio', { url });
    if (!payload || !payload.base64) throw new Error('audio data is empty');
    const blob = base64ToBlob(payload.base64, payload.contentType || 'audio/wav');
    if (!blob || blob.size === 0) throw new Error('audio blob is empty');
    releaseObjectUrl();
    currentObjectUrl = URL.createObjectURL(blob);
    return currentObjectUrl;
  }


  async function playItem(url, text, item, playbackToken) {
    stopCurrentPlayback('replace');
    currentPlaybackToken = String(playbackToken || '');
    setPanelState('Playing', `${String(text || '').slice(0, 60)}${String(text || '').length > 60 ? '...' : ''}`);
    try {
      const audioSrc = await fetchAudioObjectUrl(url);
      if (currentPlaybackToken !== playbackToken) return;
      await new Promise((resolve, reject) => {
        const audio = new Audio(audioSrc);
        audio.volume = clampVolume(settings.voiceVolume);
        currentAudio = audio;
        audio.onended = resolve;
        audio.onerror = () => reject(new Error('audio element failed'));
        audio.play().catch(reject);
      });
      releaseObjectUrl();
      currentAudio = null;
      currentPlaybackToken = null;
      setPanelState('Ready', 'Playback done');
      chrome.runtime.sendMessage({ type: 'playback-done', playbackToken, ok: true, stopped: false }).catch(() => {});
    } catch (error) {
      releaseObjectUrl();
      currentAudio = null;
      currentPlaybackToken = null;
      setPanelState('Error', error.message || String(error));
      chrome.runtime.sendMessage({ type: 'playback-done', playbackToken, ok: false, stopped: false, error: error.message || String(error) }).catch(() => {});
    }
  }

  function stopCurrentPlayback(reason = 'stop') {
    const token = currentPlaybackToken;
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio.currentTime = 0; } catch (_error) {}
    }
    currentAudio = null;
    currentPlaybackToken = null;
    releaseObjectUrl();
    if (reason === 'stop') setPanelState('Ready', 'Playback stopped');
    return token;
  }

  function applyOwnerState(nextIsOwner, payload = null) {
    isUiOwner = nextIsOwner;
    if (payload) {
      queueSize = payload.queueSize || 0;
    }
    if (isUiOwner === false) {
      if (panel) panel.style.display = 'none';
      return;
    }
    if (!panel) createPanel();
    if (panel) panel.style.display = 'flex';
    if (payload) {
      const busy = Boolean(payload.isPlaying);
      for (const button of actionButtons) {
        button.disabled = busy;
        button.style.opacity = busy ? '0.45' : '1';
        button.style.cursor = busy ? 'not-allowed' : 'pointer';
      }
      if (payload.isPlaying) {
        const txt = payload.currentPlayingItem?.text || '';
        const preview = `${txt.slice(0, 50)}${txt.length > 50 ? '...' : ''}`;
        if (payload.playbackPhase === 'generating') {
          setPanelState('Generating', preview || 'Generating audio...');
        } else {
          setPanelState('Playing', preview);
        }
      } else {
        const queueText = queueSize > 0 ? `Queued ${queueSize}` : 'Queue empty';
        setPanelState('Ready', payload.statusText ? `${payload.statusText} / ${queueText}` : queueText);
      }
    }
  }

  async function loadSettings() {
    if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) {
      settings = { ...DEFAULT_SETTINGS };
      enabled = false;
      return;
    }
    const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
    settings = await sanitizeStoredSettings(stored);
    settings.voiceVolume = clampVolume(settings.voiceVolume);
    enabled = Boolean(settings.enabled);
  }

  function registerMessageListener() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return false;
      if (message.type === 'state-update') {
        applyOwnerState(message.payload.isUiOwner, message.payload);
        return false;
      }
      if (message.type === 'play-audio') {
        void playItem(message.payload.url, message.payload.text, message.payload.item, String(message.payload.playbackToken || ''));
        return false;
      }
      if (message.type === 'stop-audio') {
        const incomingToken = String((message.payload && message.payload.playbackToken) || '');
        if (!incomingToken || incomingToken === currentPlaybackToken) stopCurrentPlayback('stop');
        sendResponse({ ok: true });
        return false;
      }
      return false;
    });
  }

  async function start() {
    registerMessageListener();
    document.getElementById('local-voice-pixel-pet')?.remove();
    await loadSettings();
    await syncDesktopPetSelection();
    markExistingMessagesAsSeen();
    try {
      const response = await runtimeMessage('register-tab', { title: document.title });
      applyOwnerState(response && typeof response.isUiOwner !== 'undefined' ? response.isUiOwner : null, response || null);
    } catch (_error) {
      applyOwnerState(null);
    }
    observer = new MutationObserver(scheduleInspect);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const claimUiOwnership = () => {
      chrome.runtime.sendMessage({ type: 'register-tab', title: document.title, claimOwner: true }).catch(() => {});
    };
    window.addEventListener('focus', claimUiOwnership);
    document.addEventListener('pointerdown', claimUiOwnership, { capture: true });
    setInterval(() => {
      chrome.runtime.sendMessage({ type: 'register-tab', title: document.title }).catch(() => {});
    }, 5000);
  }

  if (globalThis.chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const wasEnabled = enabled;
      for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue;
      enabled = Boolean(settings.enabled);
      if (!wasEnabled && enabled) rebaselineAutoMessages();
      settings.voiceVolume = clampVolume(settings.voiceVolume);
      syncReferenceVoiceSelect();
      syncVolumeSlider();
      if (autoButton) autoButton.style.background = enabled ? 'rgba(73,168,113,.25)' : 'rgba(255,255,255,.08)';
      if (Object.prototype.hasOwnProperty.call(changes, 'voiceId')
        || Object.prototype.hasOwnProperty.call(changes, 'referenceVoice')) {
        void syncDesktopPetSelection();
      }
      if (Object.prototype.hasOwnProperty.call(changes, PANEL_POSITION_KEY)) applyPanelPosition(changes[PANEL_POSITION_KEY].newValue);
      if (Object.prototype.hasOwnProperty.call(changes, PANEL_COLLAPSED_KEY)) void setCollapsed(Boolean(changes[PANEL_COLLAPSED_KEY].newValue), false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void start(); }, { once: true });
  } else {
    void start();
  }
})();

