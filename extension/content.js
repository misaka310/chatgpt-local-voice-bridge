(() => {
  const SETTINGS_VERSION = 7;
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
  const PET_POSITION_KEY = 'petPosition';
  const PET_MODE_STORAGE = 'petMode';
  const SELECTED_PET_ID_STORAGE = 'selectedPetId';
  const DEFAULT_PET_ID = 'placeholder';
  const MANUAL_PET_IDS = new Set(['placeholder']);
  const DEFAULT_REFERENCE_VOICES = [{ id: '', label: 'none' }];
  const DEFAULT_PET_SIZE = { width: 88, height: 104 };
  const DEFAULT_CODEX_PET_SHEET = {
    width: 1536,
    height: 1872,
    columns: 8,
    rows: 9,
    frameWidth: 192,
    frameHeight: 208,
  };
  const PET_DEFAULT_RIGHT = 24;
  const PET_DEFAULT_BOTTOM = 140;
  const PET_EDGE_MARGIN = 8;
  const MIN_FALLBACK_CHARS = 20;

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
  let voiceProfileInput = null;
  let referenceVoiceSelect = null;
  let petSelect = null;
  let tabSelect = null;
  let autoButton = null;
  let actionButtons = [];
  let volumeSlider = null;
  let volumeValueNode = null;
  let currentAudio = null;
  let currentObjectUrl = null;
  let currentPlaybackToken = null;
  let isUiOwner = null;
  let globalTabs = [];
  let selectedTabId = null;
  let queueSize = 0;
  let dragMovedRecently = false;
  let petContainer = null;
  let petState = 'idle';
  let petAnimTimer = null;
  let petConfig = null;
  let petConfigVoiceKey = '';
  let petConfigLoadToken = 0;
  let petSpriteEl = null;
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

  function resolveEffectivePetVoiceId(value) {
    const normalized = normalizeVoiceId(value).toLowerCase();
    if (!normalized || normalized === 'none') return DEFAULT_PET_ID;
    return normalized;
  }

  function normalizePetId(value) {
    const petId = normalizeVoiceId(value).toLowerCase();
    if (!petId || petId === 'none' || petId === '.' || petId === '..' || /[\\/]/.test(petId)) return DEFAULT_PET_ID;
    return petId;
  }

  function normalizeManualPetId(value) {
    return normalizePetId(value);
  }

  async function getCurrentPetSelection() {
    if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) {
      return { key: 'auto:' + DEFAULT_PET_ID, petId: DEFAULT_PET_ID };
    }
    try {
      const saved = await chrome.storage.local.get({
        voiceId: '',
        referenceVoice: '',
        [PET_MODE_STORAGE]: 'auto',
        [SELECTED_PET_ID_STORAGE]: DEFAULT_PET_ID,
      });
      const petMode = saved[PET_MODE_STORAGE] === 'auto' ? 'auto' : 'manual';
      if (petMode !== 'auto') {
        const petId = normalizeManualPetId(saved[SELECTED_PET_ID_STORAGE]);
        return { key: 'manual:' + petId, petId };
      }
      const voiceId = normalizeVoiceId(saved.voiceId) || normalizeVoiceId(saved.referenceVoice);
      const petId = resolveEffectivePetVoiceId(voiceId);
      return { key: 'auto:' + petId, petId };
    } catch (_error) {
      return { key: 'auto:' + DEFAULT_PET_ID, petId: DEFAULT_PET_ID };
    }
  }

  function buildPetConfigCandidates(voiceId) {
    const normalized = resolveEffectivePetVoiceId(voiceId);
    const candidates = [];
    if (normalized && !/[\\/]/.test(normalized) && normalized !== '.' && normalized !== '..') {
      candidates.push(`assets/pet/local/voices/${normalized}/pet.json`);
    }
    if (normalized !== DEFAULT_PET_ID) {
      candidates.push(`assets/pet/local/voices/${DEFAULT_PET_ID}/pet.json`);
    }
    candidates.push('assets/pet/local/pet.json', 'assets/pet/pet.json');
    return candidates;
  }

  function normalizeReferenceVoice(value) {
    const normalized = String(value || '').trim();
    if (!normalized || ['none', 'qwen3', 'qwen'].includes(normalized.toLowerCase())) return '';
    return normalized;
  }

  async function sanitizeStoredSettings(raw) {
    const next = {
      ...DEFAULT_SETTINGS,
      ...raw,
      settingsVersion: SETTINGS_VERSION,
      model: DEFAULT_SETTINGS.voiceProfile,
      voiceId: normalizeReferenceVoice(raw.voiceId || raw.referenceVoice),
      voiceProfile: DEFAULT_SETTINGS.voiceProfile,
      referenceVoice: normalizeReferenceVoice(raw.voiceId || raw.referenceVoice),
      voicePrompt: '',
        };
    if (globalThis.chrome && chrome.storage && chrome.storage.local) await chrome.storage.local.set(next);
    return next;
  }

  function getCurrentVoiceProfile() {
    return DEFAULT_SETTINGS.voiceProfile;
  }

  function getCurrentReferenceVoice() {
    return normalizeReferenceVoice(settings.voiceId || settings.referenceVoice);
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
    const punctRegex = /[縲ゑｼ・ｼ・!?]/g;
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

  function buildPreviewSourceText(fullText, options = {}) {
    const maxLines = Number(options.maxLines || DEFAULT_SETTINGS.previewMaxLines);
    let text = normalizeText(fullText);
    if (!text) return '';
    text = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/\n{2,}/g, '\n');
    const lines = text.split('\n').map((line) => normalizeMarkdownLine(line)).filter(Boolean);
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
    const merged = buildPreviewSourceText(fullText, options);
    if (!merged) return [];
    const chunks = [];
    let pending = merged;
    while (pending) {
      const split = splitChunkByMaxChars(pending, maxChars, minChars);
      if (!split.head) break;
      chunks.push(split.head);
      if (!split.tail || split.tail === pending) break;
      pending = split.tail;
    }
    return chunks;
  }

  function shouldSendNow(preview, now, item) {
    const maxChars = Number(settings.previewMaxChars || DEFAULT_SETTINGS.previewMaxChars);
    const minChars = Number(settings.previewMinChars || DEFAULT_SETTINGS.previewMinChars);
    const stableMs = Number(settings.previewStableMs || DEFAULT_SETTINGS.previewStableMs);
    const len = preview.length;
    if (!len) return false;
    if (len >= minChars && now - item.lastChangedAt >= stableMs) return true;
    if (len >= MIN_FALLBACK_CHARS && now - item.lastChangedAt >= stableMs + 400) return true;
    return false;
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
    return normalizeText(clone.innerText || clone.textContent || '');
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
    }, Number(settings.previewStableMs || DEFAULT_SETTINGS.previewStableMs) + 50);
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
    if (statusNode) statusNode.textContent = statusText;
    if (detailNode) {
      const refText = getCurrentReferenceVoice() || 'none';
      detailNode.textContent = detailText || `${getCurrentVoiceProfile()} Ref=${refText} / ${queueSize ? `Queued ${queueSize}` : 'ready'}`;
    }
    if (titleNode) titleNode.textContent = settings.panelCollapsed ? 'Voice' : 'Local Voice';
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

  async function persistVoiceProfile(value) {
    settings.voiceProfile = DEFAULT_SETTINGS.voiceProfile;
    await chrome.storage.local.set({ voiceProfile: DEFAULT_SETTINGS.voiceProfile, model: DEFAULT_SETTINGS.voiceProfile });
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

  function syncPetSelect() {
    if (!petSelect) return;
    const options = [{ id: 'auto', label: `Auto by Ref (${getCurrentReferenceVoice() || 'none'})` }, { id: `manual:${DEFAULT_PET_ID}`, label: DEFAULT_PET_ID }];
    const seen = new Set(options.map((item) => item.id));
    for (const voice of availableReferenceVoices) {
      const petId = normalizePetId(voice.id);
      const optionId = `manual:${petId}`;
      if (!voice.id || seen.has(optionId)) continue;
      seen.add(optionId);
      options.push({ id: optionId, label: `${voice.label || petId} pet` });
    }
    const mode = settings[PET_MODE_STORAGE] === 'manual' ? 'manual' : 'auto';
    const selected = mode === 'manual' ? `manual:${normalizeManualPetId(settings[SELECTED_PET_ID_STORAGE])}` : 'auto';
    if (!seen.has(selected)) options.push({ id: selected, label: selected.replace(/^manual:/, '') });
    setSelectOptions(petSelect, options, selected);
  }

  async function refreshReferenceVoiceChoices() {
    await loadReferenceVoiceChoices();
    syncReferenceVoiceSelect();
    syncPetSelect();
  }

  async function persistReferenceVoice(value) {
    const referenceVoice = normalizeReferenceVoice(value);
    settings.voiceId = referenceVoice;
    settings.referenceVoice = referenceVoice;
    await chrome.storage.local.set({ voiceId: referenceVoice, referenceVoice, voicePrompt: '' });
    syncReferenceVoiceSelect();
    syncPetSelect();
    await refreshPetConfig(true);
    setPanelState('Ready', `Ref=${referenceVoice || 'none'}`);
  }

  async function persistPetSelection(value) {
    const raw = String(value || 'auto');
    if (raw.startsWith('manual:')) {
      const petId = normalizeManualPetId(raw.slice('manual:'.length));
      settings[PET_MODE_STORAGE] = 'manual';
      settings[SELECTED_PET_ID_STORAGE] = petId;
      await chrome.storage.local.set({ [PET_MODE_STORAGE]: 'manual', [SELECTED_PET_ID_STORAGE]: petId });
    } else {
      settings[PET_MODE_STORAGE] = 'auto';
      await chrome.storage.local.set({ [PET_MODE_STORAGE]: 'auto' });
    }
    syncPetSelect();
    await refreshPetConfig(true);
    setPanelState('Ready');
  }

  function syncTabs() {
    if (!tabSelect) return;
    tabSelect.innerHTML = '';
    for (const t of globalTabs) {
      const opt = document.createElement('option');
      opt.value = String(t.id);
      opt.textContent = String(t.title || 'ChatGPT').slice(0, 30);
      opt.style.backgroundColor = '#ffffff';
      opt.style.color = '#111827';
      tabSelect.appendChild(opt);
    }
    tabSelect.value = String(selectedTabId || '');
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
    detailNode.style.cssText = 'font-size:11px;color:#c8d2e8;min-height:1.2em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    const voiceRow = document.createElement('div');
    voiceRow.style.cssText = 'display:flex;align-items:center;gap:6px';
    const voiceLabel = document.createElement('div');
    voiceLabel.textContent = 'Voice';
    voiceLabel.style.cssText = 'font-size:11px;color:#c8d2e8;min-width:34px';
    voiceProfileInput = document.createElement('input');
    voiceProfileInput.value = getCurrentVoiceProfile();
    voiceProfileInput.readOnly = true;
    voiceProfileInput.title = 'Fixed to Irodori direct runtime';
    voiceProfileInput.style.cssText = 'flex:1;min-width:0;font:600 11px system-ui,sans-serif;padding:4px 6px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#f7f9ff';
    voiceProfileInput.addEventListener('change', async () => { await persistVoiceProfile(voiceProfileInput.value); setPanelState('Ready', `Voice switched to ${getCurrentVoiceProfile()}`); });
    voiceRow.append(voiceLabel, voiceProfileInput);

    const refRow = document.createElement('div');
    refRow.style.cssText = 'display:flex;align-items:center;gap:6px';
    const refLabel = document.createElement('div');
    refLabel.textContent = 'Ref';
    refLabel.style.cssText = 'font-size:11px;color:#c8d2e8;min-width:34px';
    referenceVoiceSelect = document.createElement('select');
    referenceVoiceSelect.style.cssText = 'flex:1;min-width:0;font:600 11px system-ui,sans-serif;padding:4px 6px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#f7f9ff';
    referenceVoiceSelect.addEventListener('change', async () => { await persistReferenceVoice(referenceVoiceSelect.value); });
    refRow.append(refLabel, referenceVoiceSelect);

    const petRow = document.createElement('div');
    petRow.style.cssText = 'display:flex;align-items:center;gap:6px';
    const petLabel = document.createElement('div');
    petLabel.textContent = 'Pet';
    petLabel.style.cssText = 'font-size:11px;color:#c8d2e8;min-width:34px';
    petSelect = document.createElement('select');
    petSelect.style.cssText = 'flex:1;min-width:0;font:600 11px system-ui,sans-serif;padding:4px 6px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#f7f9ff';
    petSelect.addEventListener('change', async () => { await persistPetSelection(petSelect.value); });
    petRow.append(petLabel, petSelect);

    const tabRow = document.createElement('div');
    tabRow.style.cssText = 'display:flex;align-items:center;gap:6px';
    const tabLabel = document.createElement('div');
    tabLabel.textContent = 'Tab';
    tabLabel.style.cssText = 'font-size:11px;color:#c8d2e8;min-width:34px';
    tabSelect = document.createElement('select');
    tabSelect.style.cssText = 'flex:1;min-width:0;font:600 11px system-ui,sans-serif;padding:4px 6px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#f7f9ff';
    tabSelect.addEventListener('change', () => { void sendUiCommand('select-tab', { tabId: Number(tabSelect.value) }); });
    tabRow.append(tabLabel, tabSelect);

    const volumeRow = document.createElement('div');
    volumeRow.style.cssText = 'display:flex;align-items:center;gap:8px';
    const volumeLabel = document.createElement('div');
    volumeLabel.textContent = 'Vol';
    volumeLabel.style.cssText = 'font-size:11px;color:#c8d2e8;min-width:34px';
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
      setPixelPetState('thinking');
      void sendUiCommand('next', getSpeakParams());
    });
    const regenButton = createButton('Regen', () => {
      setPanelState('Queued', 'Regenerating current chunk...');
      setPixelPetState('thinking');
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
    panelBody.append(detailNode, voiceRow, refRow, petRow, tabRow, volumeRow, controls);
    panel.append(header, panelBody);
    document.documentElement.appendChild(panel);
    syncTabs();
    syncReferenceVoiceSelect();
    syncPetSelect();
    void refreshReferenceVoiceChoices();
    syncVolumeSlider();
    autoButton.style.background = enabled ? 'rgba(73,168,113,.25)' : 'rgba(255,255,255,.08)';
    applyPanelPosition(settings[PANEL_POSITION_KEY]);
    void setCollapsed(Boolean(settings[PANEL_COLLAPSED_KEY]), false);
    makePanelDraggable(header);
    header.addEventListener('click', () => { if (!dragMovedRecently) void setCollapsed(!Boolean(settings[PANEL_COLLAPSED_KEY]), true); });
    setPanelState('Ready');
  }

  function petBaseStyle() {
    return [
      'position:fixed',
      `right:${PET_DEFAULT_RIGHT}px`,
      `bottom:${PET_DEFAULT_BOTTOM}px`,
      'z-index:2147483647',
      `width:${DEFAULT_PET_SIZE.width}px`,
      `height:${DEFAULT_PET_SIZE.height}px`,
      'display:block',
      'cursor:move',
      'pointer-events:auto',
      'user-select:none',
      'touch-action:none',
      'overflow:hidden',
      'background:transparent',
      'border:none',
      'box-shadow:none',
      'padding:0',
    ].join(';');
  }

  function getPetFrameSize(definition) {
    const frameWidth = Math.max(1, Math.round(Number(definition?.frameWidth) || 0));
    const frameHeight = Math.max(1, Math.round(Number(definition?.frameHeight) || 0));
    return {
      frameWidth: frameWidth || 192,
      frameHeight: frameHeight || 208,
    };
  }

  function toPositiveInt(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(1, Math.round(n));
  }

  function clampFrameId(frameId, totalFrames) {
    const n = Number(frameId);
    if (!Number.isFinite(n)) return 0;
    const i = Math.max(0, Math.floor(n));
    if (!Number.isFinite(totalFrames) || totalFrames <= 0) return i;
    return Math.min(totalFrames - 1, i);
  }

  function normalizeAnimDef(raw, fallbackFrames, fallbackSpeed, totalFrames) {
    const defaultFrames = Array.isArray(fallbackFrames) && fallbackFrames.length ? fallbackFrames : [0];
    const sourceFrames = Array.isArray(raw)
      ? raw
      : raw && Array.isArray(raw.frames)
        ? raw.frames
        : defaultFrames;
    const frames = sourceFrames
      .map((id) => clampFrameId(id, totalFrames))
      .filter((id) => Number.isFinite(id));
    const speedCandidate = raw && typeof raw === 'object' ? raw.speed : undefined;
    return {
      frames: frames.length ? frames : defaultFrames.map((id) => clampFrameId(id, totalFrames)),
      speed: toPositiveInt(speedCandidate, fallbackSpeed),
    };
  }

  function resolvePetResourceUrl(resourcePath, jsonUrl) {
    const rawPath = String(resourcePath || '').trim();
    if (!rawPath) return '';
    if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.getURL) return '';
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(rawPath)) return rawPath;
    if (rawPath.startsWith('assets/')) return chrome.runtime.getURL(rawPath);
    if (rawPath.startsWith('/')) return chrome.runtime.getURL(rawPath.slice(1));
    try {
      return new URL(rawPath, jsonUrl).toString();
    } catch (_error) {
      return chrome.runtime.getURL(rawPath.replace(/^\.?\//, ''));
    }
  }

  function clampPetPosition(left, top) {
    if (!petContainer) return { left, top };
    const width = petContainer.offsetWidth || 0;
    const height = petContainer.offsetHeight || 0;
    const maxLeft = Math.max(PET_EDGE_MARGIN, window.innerWidth - width - PET_EDGE_MARGIN);
    const maxTop = Math.max(PET_EDGE_MARGIN, window.innerHeight - height - PET_EDGE_MARGIN);
    return {
      left: Math.round(Math.min(Math.max(left, PET_EDGE_MARGIN), maxLeft)),
      top: Math.round(Math.min(Math.max(top, PET_EDGE_MARGIN), maxTop)),
    };
  }

  function setPetDefaultPosition() {
    if (!petContainer) return;
    petContainer.style.left = '';
    petContainer.style.top = '';
    petContainer.style.right = `${PET_DEFAULT_RIGHT}px`;
    petContainer.style.bottom = `${PET_DEFAULT_BOTTOM}px`;
  }

  function applyPetPosition(position) {
    if (!petContainer) return;
    if (position && isFiniteNumber(position.left) && isFiniteNumber(position.top)) {
      const clamped = clampPetPosition(Number(position.left), Number(position.top));
      petContainer.style.left = `${clamped.left}px`;
      petContainer.style.top = `${clamped.top}px`;
      petContainer.style.right = 'auto';
      petContainer.style.bottom = 'auto';
      return;
    }
    setPetDefaultPosition();
  }

  async function loadPetPosition() {
    if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return null;
    try {
      const data = await chrome.storage.local.get([PET_POSITION_KEY]);
      const pos = data[PET_POSITION_KEY];
      if (pos && isFiniteNumber(pos.left) && isFiniteNumber(pos.top)) return pos;
    } catch (_error) {}
    return null;
  }

  async function savePetPosition(left, top) {
    if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return;
    try {
      const clamped = clampPetPosition(left, top);
      await chrome.storage.local.set({ [PET_POSITION_KEY]: clamped });
    } catch (_error) {}
  }

  async function applyStoredPetPosition() {
    if (!petContainer) return;
    const pos = await loadPetPosition();
    if (pos) {
      applyPetPosition(pos);
      return;
    }
    setPetDefaultPosition();
  }

  async function resetPetPosition() {
    if (!petContainer) return;
    if (globalThis.chrome && chrome.storage && chrome.storage.local) {
      try {
        await chrome.storage.local.remove([PET_POSITION_KEY]);
      } catch (_error) {}
    }
    setPetDefaultPosition();
  }

  function ensurePetSpriteEl() {
    if (!petContainer) return null;
    if (petSpriteEl && petSpriteEl.isConnected) return petSpriteEl;
    petSpriteEl = document.createElement('div');
    petSpriteEl.style.cssText = [
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'background-repeat:no-repeat',
      'background-position:0 0',
      'background-origin:border-box',
      'background-clip:border-box',
      'image-rendering:pixelated',
      'pointer-events:none',
    ].join(';');
    petContainer.appendChild(petSpriteEl);
    return petSpriteEl;
  }

  function getPetFrameViewportSize() {
    if (!petContainer) {
      return { frameWidth: DEFAULT_PET_SIZE.width, frameHeight: DEFAULT_PET_SIZE.height };
    }
    return {
      frameWidth: Math.max(1, Math.round(petContainer.clientWidth || petContainer.offsetWidth || DEFAULT_PET_SIZE.width)),
      frameHeight: Math.max(1, Math.round(petContainer.clientHeight || petContainer.offsetHeight || DEFAULT_PET_SIZE.height)),
    };
  }

  function applyPetSpriteFrame(frameId) {
    if (!petConfig || !petSpriteEl) return;
    const cols = toPositiveInt(petConfig.columns, 1);
    const rows = toPositiveInt(petConfig.rows, 1);
    const totalFrames = cols * rows;
    const safeFrameId = clampFrameId(frameId, totalFrames);
    const col = safeFrameId % cols;
    const row = Math.floor(safeFrameId / cols);
    const { frameWidth, frameHeight } = getPetFrameViewportSize();
    const sheetWidth = frameWidth * cols;
    const sheetHeight = frameHeight * rows;

    petSpriteEl.style.backgroundSize = `${sheetWidth}px ${sheetHeight}px`;
    petSpriteEl.style.backgroundPosition = `${-col * frameWidth}px ${-row * frameHeight}px`;
  }

  function applyLoadedPetConfig(config) {
    if (!config) return;
    if (petSpriteEl) {
      petSpriteEl.style.backgroundImage = `url("${config.spritesheetUrl}")`;
      petSpriteEl.style.backgroundRepeat = 'no-repeat';
    }
    if (petContainer && config.frameWidth && config.frameHeight) {
      const ratio = config.frameHeight / config.frameWidth;
      petContainer.style.width = `${DEFAULT_PET_SIZE.width}px`;
      petContainer.style.height = `${Math.round(DEFAULT_PET_SIZE.width * ratio)}px`;
    }
  }

  async function loadPetConfig(voiceId = '') {
    if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.getURL) return null;
    for (const resourcePath of buildPetConfigCandidates(voiceId)) {
      try {
        const jsonUrl = chrome.runtime.getURL(resourcePath);
        const response = await fetch(jsonUrl, { cache: 'no-store' });
        if (!response.ok) continue;
        const data = await response.json();
        if (!data || !data.spritesheetPath) continue;

        const spritesheetUrl = resolvePetResourceUrl(data.spritesheetPath, jsonUrl);
        if (!spritesheetUrl) continue;

        const img = new Image();
        img.decoding = 'async';
        img.src = spritesheetUrl;
        await new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = resolve;
        });
        if (!img.naturalWidth || !img.naturalHeight) continue;

        const columns = toPositiveInt(data.columns, DEFAULT_CODEX_PET_SHEET.columns);
        const rows = toPositiveInt(data.rows, DEFAULT_CODEX_PET_SHEET.rows);
        const sheetWidth = toPositiveInt(img.naturalWidth, DEFAULT_CODEX_PET_SHEET.width);
        const sheetHeight = toPositiveInt(img.naturalHeight, DEFAULT_CODEX_PET_SHEET.height);
        const frameWidth = toPositiveInt(
          data.frameWidth,
          toPositiveInt(Math.floor(sheetWidth / columns), DEFAULT_CODEX_PET_SHEET.frameWidth),
        );
        const frameHeight = toPositiveInt(
          data.frameHeight,
          toPositiveInt(Math.floor(sheetHeight / rows), DEFAULT_CODEX_PET_SHEET.frameHeight),
        );
        const totalFrames = columns * rows;
        const rawAnimations = data.animations || {};

        petConfig = {
          id: data.id || 'custom-pet',
          spritesheetUrl,
          columns,
          rows,
          frameWidth,
          frameHeight,
          sheetWidth,
          sheetHeight,
          animations: {
            idle: normalizeAnimDef(rawAnimations.idle || rawAnimations.waiting, [0, 1], 400, totalFrames),
            talking: normalizeAnimDef(rawAnimations.talking || rawAnimations.speaking || rawAnimations.talk, [16, 17, 18, 17], 150, totalFrames),
            thinking: normalizeAnimDef(rawAnimations.thinking || rawAnimations.working, [24, 25], 300, totalFrames),
            happy: normalizeAnimDef(rawAnimations.happy || rawAnimations.success || rawAnimations.celebrate, [32, 33], 220, totalFrames),
            error: normalizeAnimDef(rawAnimations.error || rawAnimations.sad || rawAnimations.angry || rawAnimations.confused, [40, 41], 260, totalFrames),
          },
        };
        return petConfig;
      } catch (_error) {
        continue;
      }
    }
    petConfig = null;
    return null;
  }

  async function refreshPetConfig(force = false) {
    const selection = await getCurrentPetSelection();
    if (!force && petConfig && petConfigVoiceKey === selection.key) {
      applyLoadedPetConfig(petConfig);
      return petConfig;
    }

    const loadSeq = ++petConfigLoadToken;
    const nextConfig = await loadPetConfig(selection.petId);
    if (loadSeq !== petConfigLoadToken) return null;

    petConfigVoiceKey = selection.key;
    petConfig = nextConfig;
    applyLoadedPetConfig(petConfig);
    if (petConfig) setPixelPetState(petState);
    return petConfig;
  }

  function startPetSpriteAnim(animName) {
    if (!petConfig || !petSpriteEl) return;
    const anim = petConfig.animations[animName] || petConfig.animations.idle;
    if (!anim || !anim.frames || anim.frames.length === 0) return;

    let frameIdx = 0;
    const updateFrame = () => {
      if (petState !== animName && !(animName === 'idle' && petState === 'idle')) return;
      const frameId = anim.frames[frameIdx];
      applyPetSpriteFrame(frameId);
      frameIdx = (frameIdx + 1) % anim.frames.length;
      if (petAnimTimer) clearTimeout(petAnimTimer);
      petAnimTimer = setTimeout(updateFrame, anim.speed || 400);
    };

    updateFrame();
  }

  function setPixelPetState(state) {
    petState = state;

    if (petAnimTimer) {
      clearTimeout(petAnimTimer);
      clearInterval(petAnimTimer);
      petAnimTimer = null;
    }

    if (petConfig) {
      switch (state) {
        case 'idle':
          startPetSpriteAnim('idle');
          break;
        case 'thinking':
          startPetSpriteAnim('thinking');
          break;
        case 'talking':
          startPetSpriteAnim('talking');
          break;
        case 'happy':
          startPetSpriteAnim('happy');
          setTimeout(() => {
            if (petState === 'happy') setPixelPetState('idle');
          }, 1000);
          break;
        case 'error':
          startPetSpriteAnim('error');
          setTimeout(() => {
            if (petState === 'error') setPixelPetState('idle');
          }, 3000);
          break;
        default:
          startPetSpriteAnim('idle');
          break;
      }
    } else if (state === 'happy') {
      setTimeout(() => {
        if (petState === 'happy') setPixelPetState('idle');
      }, 1000);
    } else if (state === 'error') {
      setTimeout(() => {
        if (petState === 'error') setPixelPetState('idle');
      }, 3000);
    }

    if (petContainer) {
      const isActuallyEnabled = enabled && settings.enabled;
      petContainer.style.opacity = isActuallyEnabled ? '1' : '0.4';
      petContainer.style.filter = isActuallyEnabled ? 'none' : 'grayscale(0.5) brightness(0.7)';
    }
  }

  function createPixelPet() {
    if (petContainer) return;
    petContainer = document.createElement('div');
    petContainer.id = 'local-voice-pixel-pet';
    petContainer.title = 'Double-click to reset position';
    petContainer.style.cssText = [
      petBaseStyle(),
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'transition:opacity 0.3s ease',
    ].join(';');

    petSpriteEl = document.createElement('div');
    petSpriteEl.style.cssText = [
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'background-repeat:no-repeat',
      'background-position:0 0',
      'background-origin:border-box',
      'background-clip:border-box',
      'image-rendering:pixelated',
      'pointer-events:none',
      'display:block',
    ].join(';');
    petContainer.appendChild(petSpriteEl);
    document.documentElement.appendChild(petContainer);
    makePetDraggable(petContainer);
    petContainer.addEventListener('dblclick', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await resetPetPosition();
    });
    void loadPetPosition();

    window.addEventListener('resize', () => {
      if (!petContainer || !petContainer.style.left || !petContainer.style.top) return;
      const clamped = clampPetPosition(
        Number.parseFloat(petContainer.style.left || '0'),
        Number.parseFloat(petContainer.style.top || '0'),
      );
      petContainer.style.left = `${clamped.left}px`;
      petContainer.style.top = `${clamped.top}px`;
    });

    void refreshPetConfig(true).catch(() => {});
  }

  function makePetDraggable(el) {
    let dragState = null;
    const body = document.body;

    const onMove = (event) => {
      if (!dragState || !petContainer) return;
      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      const clamped = clampPetPosition(dragState.startLeft + dx, dragState.startTop + dy);
      petContainer.style.left = `${clamped.left}px`;
      petContainer.style.top = `${clamped.top}px`;
      petContainer.style.right = 'auto';
      petContainer.style.bottom = 'auto';
      event.preventDefault();
    };

    const onUp = async () => {
      if (!dragState || !petContainer) return;
      const left = Number.parseFloat(petContainer.style.left || '0');
      const top = Number.parseFloat(petContainer.style.top || '0');
      dragState = null;
      if (body) body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      await savePetPosition(left, top);
    };

    el.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const rect = petContainer.getBoundingClientRect();
      dragState = {
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
      };
      petContainer.style.left = `${Math.round(rect.left)}px`;
      petContainer.style.top = `${Math.round(rect.top)}px`;
      petContainer.style.right = 'auto';
      petContainer.style.bottom = 'auto';
      if (body) body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      event.preventDefault();
    });
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
    setPixelPetState('talking');
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
      setPixelPetState('happy');
      setPanelState('Ready', 'Playback done');
      chrome.runtime.sendMessage({ type: 'playback-done', playbackToken, ok: true, stopped: false }).catch(() => {});
    } catch (error) {
      releaseObjectUrl();
      currentAudio = null;
      currentPlaybackToken = null;
      setPixelPetState('error');
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
    if (reason !== 'replace') setPixelPetState('idle');
    if (reason === 'stop') setPanelState('Ready', 'Playback stopped');
    return token;
  }

  function applyOwnerState(nextIsOwner, payload = null) {
    isUiOwner = nextIsOwner;
    if (payload) {
      globalTabs = payload.tabs || [];
      selectedTabId = payload.selectedTabId;
      queueSize = payload.queueSize || 0;
    }
    if (isUiOwner === false) {
      if (panel) panel.style.display = 'none';
      if (petContainer) petContainer.style.display = 'none';
      return;
    }
    if (!panel) createPanel();
    if (!petContainer) createPixelPet();
    if (panel) panel.style.display = 'flex';
    if (petContainer) petContainer.style.display = 'block';
    syncTabs();
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
          setPixelPetState('thinking');
        } else {
          setPanelState('Playing', preview);
          setPixelPetState('talking');
        }
      } else {
        const queueText = queueSize > 0 ? `Queued ${queueSize}` : 'Queue empty';
        setPanelState('Ready', payload.statusText ? `${payload.statusText} / ${queueText}` : queueText);
        setPixelPetState('idle');
      }
    } else if (petContainer) {
      setPixelPetState('idle');
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
    await loadSettings();
    markExistingMessagesAsSeen();
    try {
      const response = await runtimeMessage('register-tab', { title: document.title });
      applyOwnerState(response && typeof response.isUiOwner !== 'undefined' ? response.isUiOwner : null, response || null);
    } catch (_error) {
      applyOwnerState(null);
    }
    observer = new MutationObserver(scheduleInspect);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
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
      if (voiceProfileInput) voiceProfileInput.value = getCurrentVoiceProfile();
      syncReferenceVoiceSelect();
      syncPetSelect();
      syncVolumeSlider();
      if (autoButton) autoButton.style.background = enabled ? 'rgba(73,168,113,.25)' : 'rgba(255,255,255,.08)';
      setPixelPetState(petState);
      if (Object.prototype.hasOwnProperty.call(changes, 'voiceId')
        || Object.prototype.hasOwnProperty.call(changes, 'referenceVoice')
        || Object.prototype.hasOwnProperty.call(changes, PET_MODE_STORAGE)
        || Object.prototype.hasOwnProperty.call(changes, SELECTED_PET_ID_STORAGE)) {
        void refreshPetConfig(false);
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

