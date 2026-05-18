(() => {
  console.debug('[local-voice] content.js loaded');
  const SETTINGS_VERSION = 5;
  const LEGACY_DEFAULT_API_URL = 'http://127.0.0.1:8765/v1/speak';
  const LEGACY_DEFAULT_HEALTH_URL = 'http://127.0.0.1:8765/health';
  const DEFAULT_SETTINGS = {
    settingsVersion: SETTINGS_VERSION,
    enabled: false,
    apiUrl: 'http://127.0.0.1:8717/v1/speak',
    healthUrl: 'http://127.0.0.1:8717/health',
    voiceProfile: 'irodori-v2',
    voiceVolume: 0.6,
    previewMaxLines: 2,
    previewMaxChars: 80,
    previewMinChars: 25,
    previewStableMs: 800,
    panelPosition: null,
    panelCollapsed: true,
  };

  function preferCurrentUnlessLegacyOrEmpty(currentValue, legacyValue, defaultValue) {
    const value = String(currentValue || '').trim();
    if (!value || value === legacyValue) return defaultValue;
    return value;
  }

  const MIN_FALLBACK_CHARS = 20;
  const AUTO_SENT_FLAG = 'localVoiceSent';
  const PANEL_POSITION_KEY = 'panelPosition';
  const PANEL_COLLAPSED_KEY = 'panelCollapsed';
  const DEFAULT_PROFILE_OPTIONS = [
    { id: 'irodori-v2', label: 'Irodori v2' },
    { id: 'irodori-v3', label: 'Irodori v3' },
  ];
  const PET_POSITION_KEY = 'petPosition';
  const DEFAULT_PET_SIZE = { width: 88, height: 104 };
  const DEFAULT_CODEX_PET_SHEET = {
    width: 1536,
    height: 1872,
    columns: 8,
    rows: 9,
    frameWidth: 192,
    frameHeight: 208,
  };

  const stateByElement = new WeakMap();
  const initializedElements = new WeakSet();
  let settings = { ...DEFAULT_SETTINGS };
  let enabled = Boolean(DEFAULT_SETTINGS.enabled);
  let availableVoiceProfiles = [...DEFAULT_PROFILE_OPTIONS];
  let observer = null;
  let inspectTimer = null;
  let isPlaying = false;
  let currentAudio = null;
  let currentAudioContext = null;
  let currentAudioSource = null;
  let currentObjectUrl = null;
  let currentPlaybackToken = null;
  let lastAudio = null;
  let lastPreviewEntry = null;
  let lastElementVolumeApplied = null;
  let lastGainVolumeApplied = null;
  let forceWebAudioNextPlayback = false;
  let debugSimulatedPlayback = false;
  let dragMovedRecently = false;

  // Pixel Pet variables
  let petContainer = null;
  let petState = 'idle';
  let petAnimTimer = null;
  let petConfig = null;
  let petSpriteEl = null;

  // Global UI State
  let isUiOwner = null; // null: unknown, true: owner, false: non-owner
  console.debug('[local-voice] Initial isUiOwner:', isUiOwner);
  let uiOwnerStateFallbackTimer = null;
  let globalTabs = [];
  let selectedTabId = null;
  let queueSize = 0;

  let panel = null;
  let panelBody = null;
  let titleNode = null;
  let statusNode = null;
  let detailNode = null;
  let voiceProfileSelect = null;
  let volumeSlider = null;
  let volumeValueNode = null;
  let autoButton = null;
  let replayButton = null;
  let tabSelect = null;

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

  function getCurrentVoiceProfile() {
    const picked = String(settings.voiceProfile || DEFAULT_SETTINGS.voiceProfile).trim();
    return picked || DEFAULT_SETTINGS.voiceProfile;
  }

  function clampVolume(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0.6;
    return Math.min(1, Math.max(0, n));
  }

  function splitChunkByMaxChars(text, maxChars, minChars) {
    const trimmed = normalizeText(text);
    if (!trimmed) return { head: '', tail: '' };
    if (trimmed.length <= maxChars) return { head: trimmed, tail: '' };

    const head = trimmed.slice(0, maxChars);
    const punctRegex = /[。！？.!?]/g;
    let punctMatch = null;
    for (const match of head.matchAll(punctRegex)) punctMatch = match;
    if (punctMatch && Number(punctMatch.index) >= Math.floor(minChars * 0.6)) {
      const cut = Number(punctMatch.index) + 1;
      return {
        head: normalizeText(trimmed.slice(0, cut)),
        tail: normalizeText(trimmed.slice(cut)),
      };
    }

    const soft = head.lastIndexOf(' ');
    if (soft >= Math.floor(minChars * 0.6)) {
      return {
        head: normalizeText(head.slice(0, soft)),
        tail: normalizeText(trimmed.slice(soft)),
      };
    }

    return {
      head: normalizeText(head),
      tail: normalizeText(trimmed.slice(maxChars)),
    };
  }

  function splitSpeakChunks(fullText, options = {}) {
    const maxLines = Number(options.maxLines || DEFAULT_SETTINGS.previewMaxLines);
    const maxChars = Number(options.maxChars || DEFAULT_SETTINGS.previewMaxChars);
    const minChars = Number(options.minChars || DEFAULT_SETTINGS.previewMinChars);

    let text = normalizeText(fullText);
    if (!text) return [];

    text = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/\n{2,}/g, '\n');

    const lines = text
      .split('\n')
      .map((line) => normalizeMarkdownLine(line))
      .filter(Boolean);

    if (!lines.length) return [];

    const chunks = [];
    let lineCursor = 0;

    while (lineCursor < lines.length) {
      const chunkLines = [];
      let charCount = 0;

      while (lineCursor < lines.length && chunkLines.length < Math.max(1, maxLines)) {
        const line = lines[lineCursor];
        const projectedChars = charCount === 0 ? line.length : charCount + line.length + 1;
        if (chunkLines.length > 0 && projectedChars > maxChars) break;
        chunkLines.push(line);
        charCount = projectedChars;
        lineCursor += 1;
        if (charCount >= maxChars) break;
      }

      if (chunkLines.length === 0) {
        chunkLines.push(lines[lineCursor]);
        lineCursor += 1;
      }

      let pending = normalizeText(chunkLines.join(' '));
      while (pending) {
        const split = splitChunkByMaxChars(pending, maxChars, minChars);
        if (!split.head) break;
        chunks.push(split.head);
        if (!split.tail || split.tail === pending) break;
        pending = split.tail;
      }
    }

    return chunks.filter(Boolean);
  }

  function shouldSendNow(preview, now, item) {
    const maxChars = Number(settings.previewMaxChars || DEFAULT_SETTINGS.previewMaxChars);
    const minChars = Number(settings.previewMinChars || DEFAULT_SETTINGS.previewMinChars);
    const stableMs = Number(settings.previewStableMs || DEFAULT_SETTINGS.previewStableMs);
    const len = preview.length;
    if (!len) return false;
    if (len >= maxChars) return true;
    if (len >= minChars && /[。！？.!?]$/.test(preview)) return true;
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
    if (!node.__localVoiceBridgeId) {
      node.__localVoiceBridgeId = `node-${Math.random().toString(36).slice(2)}`;
    }
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
      item = {
        key: getStableKey(node),
        sent: node.dataset[AUTO_SENT_FLAG] === '1',
        lastText: text,
        lastChangedAt: Date.now(),
        idleTimer: null,
      };
      stateByElement.set(node, item);
    }
    return item;
  }

  function markExistingMessagesAsSeen() {
    for (const node of getAssistantNodes()) {
      const text = extractAssistantText(node);
      initializedElements.add(node);
      stateByElement.set(node, {
        key: getStableKey(node),
        sent: true,
        lastText: text,
        lastChangedAt: Date.now(),
        idleTimer: null,
      });
      node.dataset[AUTO_SENT_FLAG] = '1';
    }
  }

  function setPanelState(statusText, detailText = '') {
    if (statusNode) statusNode.textContent = statusText;
    if (detailNode) detailNode.textContent = detailText || `${getCurrentVoiceProfile()} / chunked preview`;
    if (titleNode && settings.panelCollapsed) {
      titleNode.textContent = `Voice - ${statusText}`;
    } else if (titleNode) {
      titleNode.textContent = 'Local Voice';
    }
  }

  function setLastAudio(entry) {
    lastAudio = entry;
    if (!replayButton) return;
    replayButton.disabled = !lastAudio;
    replayButton.style.opacity = lastAudio ? '1' : '0.45';
    replayButton.style.cursor = lastAudio ? 'pointer' : 'not-allowed';
  }

  function getCacheKey({ voiceProfile, messageKey, chunkIndex, text }) {
    return `${voiceProfile}::${messageKey}::${chunkIndex}::${normalizeText(text)}`;
  }

  function buildLatestChunkContext() {
    const nodes = getAssistantNodes();
    if (!nodes.length) return null;

    const latest = nodes[nodes.length - 1];
    const text = extractAssistantText(latest);
    const chunks = splitSpeakChunks(text, {
      maxLines: Number(settings.previewMaxLines || DEFAULT_SETTINGS.previewMaxLines),
      maxChars: Number(settings.previewMaxChars || DEFAULT_SETTINGS.previewMaxChars),
      minChars: Number(settings.previewMinChars || DEFAULT_SETTINGS.previewMinChars),
    });
    if (!chunks.length) return null;
    const messageKey = getStableKey(latest);

    return {
      node: latest,
      text,
      messageKey,
      chunks,
      capturedAt: Date.now(),
    };
  }

  function canUseRuntimeMessaging() {
    return Boolean(globalThis.chrome && chrome.runtime && typeof chrome.runtime.sendMessage === 'function');
  }

  function runtimeMessage(type, extra = {}) {
    return new Promise((resolve, reject) => {
      if (!canUseRuntimeMessaging()) {
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

  async function fetchAudioBlob(url) {
    const cacheBustedUrl = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    const response = await fetch(cacheBustedUrl, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`audio fetch failed: ${response.status}`);
    }
    const blob = await response.blob();
    if (!blob || blob.size === 0) {
      throw new Error('audio blob is empty');
    }
    return blob;
  }

  function isCurrentPlaybackToken(token) {
    return Boolean(token) && token === currentPlaybackToken;
  }

  function releaseCurrentObjectUrl() {
    if (!currentObjectUrl) return;
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }

  async function playWithAudioElement(blob, playbackToken) {
    if (forceWebAudioNextPlayback) {
      forceWebAudioNextPlayback = false;
      throw new Error('forced webaudio fallback');
    }
    const objectUrl = URL.createObjectURL(blob);
    currentObjectUrl = objectUrl;
    return new Promise((resolve, reject) => {
      const audio = new Audio(objectUrl);
      audio.volume = clampVolume(settings.voiceVolume);
      lastElementVolumeApplied = audio.volume;
      currentAudio = audio;
      audio.onended = () => {
        releaseCurrentObjectUrl();
        resolve();
      };
      audio.onerror = () => {
        releaseCurrentObjectUrl();
        reject(new Error('audio element failed to load generated audio'));
      };
      audio.play().catch((error) => {
        releaseCurrentObjectUrl();
        reject(error);
      });
      if (!isCurrentPlaybackToken(playbackToken)) {
        audio.pause();
        audio.currentTime = 0;
        releaseCurrentObjectUrl();
        resolve();
      }
    });
  }

  async function playWithWebAudio(blob, playbackToken) {
    const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error('Web Audio API is unavailable');
    }
    const buffer = await blob.arrayBuffer();
    const context = new AudioContextCtor();
    currentAudioContext = context;
    if (context.state === 'suspended') {
      await context.resume();
    }
    const decoded = await context.decodeAudioData(buffer.slice(0));
    await new Promise((resolve, reject) => {
      const source = context.createBufferSource();
      const gain = context.createGain();
      gain.gain.value = clampVolume(settings.voiceVolume);
      lastGainVolumeApplied = gain.gain.value;
      source.buffer = decoded;
      source.connect(gain);
      gain.connect(context.destination);
      currentAudioSource = source;
      source.onended = resolve;
      try {
        source.start(0);
      } catch (error) {
        reject(error);
      }
      if (!isCurrentPlaybackToken(playbackToken)) {
        try {
          source.stop(0);
        } catch (_error) {}
        resolve();
      }
    });
    currentAudioSource = null;
    await context.close().catch(() => {});
    if (currentAudioContext === context) {
      currentAudioContext = null;
    }
  }

  async function playAudioBlob(blob, playbackToken) {
    try {
      await playWithAudioElement(blob, playbackToken);
    } catch (_elementError) {
      await playWithWebAudio(blob, playbackToken);
    }
  }

  async function playAudioWithTimeout(blob, playbackToken, timeoutMs = 20000) {
    let timer = null;
    try {
      await Promise.race([
        playAudioBlob(blob, playbackToken),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('playback timeout')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function stopCurrentPlayback(reason = 'stop') {
    const previousToken = currentPlaybackToken;
    currentPlaybackToken = null;
    isPlaying = false;
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.currentTime = 0;
      } catch (_error) {}
    }
    currentAudio = null;
    if (currentAudioSource) {
      try {
        currentAudioSource.stop(0);
      } catch (_error) {}
      currentAudioSource = null;
    }
    if (currentAudioContext) {
      currentAudioContext.close().catch(() => {});
      currentAudioContext = null;
    }
    releaseCurrentObjectUrl();
    isPlaying = false;
    setPixelPetState('idle');
    if (reason === 'stop') {
      setPanelState('Ready', 'Playback stopped');
    }
    return previousToken;
  }

  async function playItem(url, text, itemMeta = {}, playbackToken = '') {
    stopCurrentPlayback('replace');
    currentPlaybackToken = String(playbackToken || '');
    isPlaying = true;
    setPixelPetState('talking');
    setPanelState('Playing', `${String(text || '').slice(0, 60)}${String(text || '').length > 60 ? '...' : ''}`);
    if (debugSimulatedPlayback) {
      const volume = clampVolume(settings.voiceVolume);
      if (forceWebAudioNextPlayback) {
        forceWebAudioNextPlayback = false;
        lastGainVolumeApplied = volume;
      } else {
        lastElementVolumeApplied = volume;
      }
      setPanelState('Playing', `${String(text || '').slice(0, 60)}${String(text || '').length > 60 ? '...' : ''} (simulated)`);
      return;
    }
    try {
      const blob = await fetchAudioBlob(url);
      if (!isCurrentPlaybackToken(currentPlaybackToken)) return;
      await playAudioWithTimeout(blob, currentPlaybackToken, 20000);
      if (!isCurrentPlaybackToken(currentPlaybackToken)) return;
      isPlaying = false;
      currentAudio = null;
      currentPlaybackToken = null;
      setPixelPetState('happy');
      setTimeout(() => {
        if (petState === 'happy') {
          setPixelPetState('idle');
        }
      }, 1200);
      setLastAudio({
        audioUrl: url,
        text: String(text || ''),
        createdAt: Date.now(),
        cacheKey: null,
        voiceProfile: itemMeta && itemMeta.voiceProfile ? itemMeta.voiceProfile : getCurrentVoiceProfile(),
      });
      setPanelState('Ready', 'Playback done');
      chrome.runtime.sendMessage({
        type: 'playback-done',
        playbackToken,
        ok: true,
        stopped: false,
      }).catch(() => {});
    } catch (error) {
      if (!isCurrentPlaybackToken(currentPlaybackToken)) return;
      isPlaying = false;
      currentAudio = null;
      currentPlaybackToken = null;
      setPixelPetState('error');
      setPanelState('Error', error.message || String(error));
      chrome.runtime.sendMessage({
        type: 'playback-done',
        playbackToken,
        ok: false,
        stopped: false,
        error: error.message || String(error),
      }).catch(() => {});
    }
  }

  function recordLastPreviewEntry(entry, chunkIndex, cacheKey) {
    lastPreviewEntry = {
      key: cacheKey,
      preview: entry.chunks[chunkIndex],
      textLength: entry.text.length,
      capturedAt: entry.capturedAt,
      nodeKey: entry.messageKey,
      chunkIndex,
      voiceProfile: getCurrentVoiceProfile(),
    };
  }

  async function reportChunks(entry, isAuto = false) {
    console.debug('[local-voice] content report-chunks', {
      messageKey: entry.messageKey,
      chunkCount: entry.chunks.length,
      chunk0Chars: entry.chunks[0] ? entry.chunks[0].length : 0,
      isAuto,
    });
    chrome.runtime.sendMessage({
      type: 'report-chunks',
      messageKey: entry.messageKey,
      text: entry.text,
      chunks: entry.chunks,
      isAuto,
      voiceProfile: getCurrentVoiceProfile(),
      title: document.title
    }).catch(() => {});
  }

  async function readChunk(entry, chunkIndex, options = {}) {
    await reportChunks(entry, false);
  }

  function processNode(node) {
    const text = extractAssistantText(node);
    if (!text) return;

    const item = ensureElementState(node, text);
    console.debug('[local-voice] assistant node detected', {
      messageKey: item.key,
      isInitialized: initializedElements.has(node),
      sent: item.sent,
      textChars: text.length,
    });
    if (item.sent) return;

    if (!initializedElements.has(node)) {
      initializedElements.add(node);
      if (!item.lastText) item.lastText = text;
      if (!item.lastChangedAt) item.lastChangedAt = Date.now();
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
    const preview = chunks[0];
    console.debug('[local-voice] chunk[0] prepared', {
      messageKey: item.key,
      hasChunk0: Boolean(preview),
      chunkCount: chunks.length,
      chunk0Chars: preview ? preview.length : 0,
    });
    if (!preview) return;
    const entry = {
      node,
      text,
      messageKey: item.key,
      chunks,
      capturedAt: Date.now(),
    };
    recordLastPreviewEntry(entry, 0, getCacheKey({
      voiceProfile: getCurrentVoiceProfile(),
      messageKey: item.key,
      chunkIndex: 0,
      text: preview,
    }));

    const now = Date.now();
    if (shouldSendNow(preview, now, item)) {
      console.debug('[local-voice] shouldSendNow=true', {
        messageKey: item.key,
        chunk0Chars: preview.length,
      });
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
      const pendingPreview = pendingChunks[0];
      if (!pendingPreview) return;

      if (shouldSendNow(pendingPreview, Date.now(), item)) {
        console.debug('[local-voice] shouldSendNow=true (idle)', {
          messageKey: item.key,
          chunk0Chars: pendingPreview.length,
        });
        item.sent = true;
        node.dataset[AUTO_SENT_FLAG] = '1';
        const pendingEntry = {
          node,
          text: latest,
          messageKey: item.key,
          chunks: pendingChunks,
          capturedAt: Date.now(),
        };
        void reportChunks(pendingEntry, Boolean(enabled && settings.enabled));
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

  function createButton(label, onClick, testId = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (testId) {
      button.dataset.testid = testId;
      button.id = testId;
    }
    button.style.cssText = [
      'font:600 11px/1.1 "Segoe UI",sans-serif',
      'padding:5px 6px',
      'border-radius:10px',
      'border:1px solid rgba(255,255,255,0.18)',
      'cursor:pointer',
      'background:rgba(255,255,255,0.08)',
      'color:#f7f9ff',
      'transition:background .15s ease,border-color .15s ease,transform .05s ease',
      'backdrop-filter:blur(6px)',
    ].join(';');
    button.addEventListener('mouseenter', () => {
      if (!button.disabled) button.style.background = 'rgba(255,255,255,0.18)';
    });
    button.addEventListener('mouseleave', () => {
      if (!button.disabled) button.style.background = 'rgba(255,255,255,0.08)';
    });
    button.addEventListener('mousedown', () => {
      if (!button.disabled) button.style.transform = 'translateY(1px)';
    });
    button.addEventListener('mouseup', () => {
      button.style.transform = 'translateY(0)';
    });
    button.addEventListener('click', onClick);
    return button;
  }

  async function sendUiCommand(cmd, params = {}) {
    try {
      const payload = await runtimeMessage('ui-command', { cmd, params });
      if (payload && payload.statusText) {
        const level = String(payload.statusLevel || 'info');
        const title = level === 'error' ? 'Error' : 'Ready';
        setPanelState(title, String(payload.statusText));
      }
      return payload || null;
    } catch (error) {
      setPanelState('Error', error.message || String(error));
      return null;
    }
  }

  function syncVoiceProfileSelect() {
    if (!voiceProfileSelect) return;
    const current = getCurrentVoiceProfile();
    voiceProfileSelect.innerHTML = '';
    for (const profile of availableVoiceProfiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.label;
      voiceProfileSelect.appendChild(option);
    }
    if (!availableVoiceProfiles.some((item) => item.id === current)) {
      settings.voiceProfile = (availableVoiceProfiles[0] && availableVoiceProfiles[0].id) || DEFAULT_SETTINGS.voiceProfile;
    }
    voiceProfileSelect.value = settings.voiceProfile;
  }

  async function persistVoiceProfile(voiceProfile) {
    settings.voiceProfile = voiceProfile;
    if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return;
    await chrome.storage.local.set({ voiceProfile });
  }

  function setVolumeDisplay(percent) {
    if (!volumeValueNode) return;
    volumeValueNode.textContent = `${percent}%`;
  }

  async function persistVoiceVolume(percent) {
    const boundedPercent = Math.min(100, Math.max(0, Number(percent) || 0));
    const nextVolume = clampVolume(boundedPercent / 100);
    const nextPercent = Math.round(nextVolume * 100);
    settings.voiceVolume = nextVolume;
    if (volumeSlider && String(volumeSlider.value) !== String(nextPercent)) {
      volumeSlider.value = String(nextPercent);
    }
    setVolumeDisplay(nextPercent);
    if (currentAudio && Number.isFinite(currentAudio.volume)) {
      currentAudio.volume = nextVolume;
    }
    if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return;
    await chrome.storage.local.set({ voiceVolume: nextVolume });
  }

  function syncVoiceVolumeSlider() {
    if (!volumeSlider) return;
    const percent = Math.round(clampVolume(settings.voiceVolume) * 100);
    volumeSlider.value = String(percent);
    setVolumeDisplay(percent);
  }

  function clampPanelPosition(left, top) {
    if (!panel) return { left, top };
    const margin = 8;
    const panelWidth = panel.offsetWidth || 300;
    const panelHeight = panel.offsetHeight || 110;
    const maxLeft = Math.max(margin, window.innerWidth - panelWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - panelHeight - margin);
    const nextLeft = Math.min(Math.max(left, margin), maxLeft);
    const nextTop = Math.min(Math.max(top, margin), maxTop);
    return { left: Math.round(nextLeft), top: Math.round(nextTop) };
  }

  function applyPanelPosition(position) {
    if (!panel) return;
    if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) {
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '16px';
      panel.style.bottom = '16px';
      return;
    }
    const clamped = clampPanelPosition(Number(position.left), Number(position.top));
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = `${clamped.left}px`;
    panel.style.top = `${clamped.top}px`;
  }

  async function persistPanelPosition(left, top) {
    if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return;
    const clamped = clampPanelPosition(left, top);
    settings[PANEL_POSITION_KEY] = clamped;
    await chrome.storage.local.set({ [PANEL_POSITION_KEY]: clamped });
  }

  async function setCollapsed(collapsed, persist = true) {
    settings[PANEL_COLLAPSED_KEY] = Boolean(collapsed);
    if (panelBody) {
      panelBody.style.display = collapsed ? 'none' : 'flex';
    }
    if (panel) {
      panel.style.width = collapsed ? 'auto' : 'min(92vw,320px)';
      panel.style.padding = collapsed ? '8px 10px' : '10px';
    }
    if (titleNode) {
      titleNode.textContent = collapsed ? `Voice - ${statusNode ? statusNode.textContent : 'Ready'}` : 'Local Voice';
    }
    if (persist && globalThis.chrome && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ [PANEL_COLLAPSED_KEY]: Boolean(collapsed) });
    }
  }

  function makePanelDraggable(dragHandle) {
    if (!panel || !dragHandle) return;
    let dragState = null;
    const body = document.body;

    const onMove = (event) => {
      if (!dragState) return;
      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        dragMovedRecently = true;
      }
      const rawLeft = dragState.startLeft + dx;
      const rawTop = dragState.startTop + dy;
      const clamped = clampPanelPosition(rawLeft, rawTop);
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
      if (body) body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      await persistPanelPosition(left, top);
      setTimeout(() => {
        dragMovedRecently = false;
      }, 0);
    };

    dragHandle.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      dragMovedRecently = false;
      dragState = {
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
      };
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = `${Math.round(rect.left)}px`;
      panel.style.top = `${Math.round(rect.top)}px`;
      if (body) body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      event.preventDefault();
    });
  }

  async function probeApiStatus() {
    try {
      let payload = null;
      if (canUseRuntimeMessaging()) {
        payload = await runtimeMessage('health');
      } else {
        const healthUrl = String(settings.healthUrl || DEFAULT_SETTINGS.healthUrl);
        const response = await fetch(healthUrl, { method: 'GET', cache: 'no-store' });
        payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || `health failed: ${response.status}`);
        }
      }
      if (payload && Array.isArray(payload.availableVoiceProfiles) && payload.availableVoiceProfiles.length > 0) {
        availableVoiceProfiles = payload.availableVoiceProfiles
          .map((item) => ({
            id: String(item.id || '').trim(),
            label: String(item.label || item.id || '').trim(),
          }))
          .filter((item) => item.id && item.label);
      }
      if (!Array.isArray(availableVoiceProfiles) || availableVoiceProfiles.length === 0) {
        availableVoiceProfiles = [...DEFAULT_PROFILE_OPTIONS];
      }
      if (!availableVoiceProfiles.some((item) => item.id === getCurrentVoiceProfile())) {
        settings.voiceProfile = payload && payload.defaultVoiceProfile ? String(payload.defaultVoiceProfile) : DEFAULT_SETTINGS.voiceProfile;
      }
      if (voiceProfileSelect) syncVoiceProfileSelect();
      setPanelState('Ready', `Voice ${getCurrentVoiceProfile()} / cache ready`);
    } catch (_error) {
      setPanelState('Offline', 'Start with run-voice-stack.cmd');
    }
  }

  function getPetImageUrl(filename) {
    if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.getURL) return '';
    return chrome.runtime.getURL(`assets/pet/${filename}`);
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

  async function loadPetConfig() {
    try {
      const jsonUrl = getPetImageUrl('pet.json');
      const response = await fetch(jsonUrl);
      if (!response.ok) return null;
      const data = await response.json();

      if (!data.spritesheetPath) return null;
      const spritesheetUrl = getPetImageUrl(data.spritesheetPath);

      const columns = toPositiveInt(data.columns, DEFAULT_CODEX_PET_SHEET.columns);
      const rows = toPositiveInt(data.rows, DEFAULT_CODEX_PET_SHEET.rows);
      const img = new Image();
      img.src = spritesheetUrl;
      await new Promise((resolve) => {
        img.onload = resolve;
        img.onerror = resolve;
      });

      const sheetWidth = toPositiveInt(img.naturalWidth, DEFAULT_CODEX_PET_SHEET.width);
      const sheetHeight = toPositiveInt(img.naturalHeight, DEFAULT_CODEX_PET_SHEET.height);
      if (!img.naturalWidth || !img.naturalHeight) return null;

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
      const defaultAnimations = {
        idle: normalizeAnimDef(rawAnimations.idle || rawAnimations.waiting, [0, 1], 400, totalFrames),
        talking: normalizeAnimDef(rawAnimations.talking || rawAnimations.speaking || rawAnimations.talk, [16, 17, 18, 17], 150, totalFrames),
        thinking: normalizeAnimDef(rawAnimations.thinking || rawAnimations.working, [24, 25], 300, totalFrames),
        happy: normalizeAnimDef(rawAnimations.happy || rawAnimations.success || rawAnimations.celebrate, [32, 33], 220, totalFrames),
        error: normalizeAnimDef(rawAnimations.error || rawAnimations.sad || rawAnimations.angry || rawAnimations.confused, [40, 41], 260, totalFrames),
      };

      const config = {
        id: data.id || 'custom-pet',
        spritesheetUrl,
        columns,
        rows,
        frameWidth,
        frameHeight,
        sheetWidth,
        sheetHeight,
        animations: defaultAnimations,
      };
      return config;
    } catch (e) {
      console.warn('[local-voice] Failed to load Codex pet assets (pet.json / spritesheet.webp)', e);
      return null;
    }
  }

  function createPixelPet() {
    if (petContainer) return;
    // Always create, but initial visibility depends on isUiOwner
    // If isUiOwner is null (unknown), we show it as fallback.

    petContainer = document.createElement('div');
    petContainer.id = 'local-voice-pixel-pet';
    petContainer.title = 'Double-click to reset position';
    petContainer.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      `width:${DEFAULT_PET_SIZE.width}px`,
      `height:${DEFAULT_PET_SIZE.height}px`,
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'transition:opacity 0.3s ease',
      'cursor:move',
      'pointer-events:auto',
      'user-select:none',
      'overflow:hidden',
    ].join(';');

    petSpriteEl = document.createElement('div');
    petSpriteEl.style.cssText = [
      'width:100%',
      'height:100%',
      'background-repeat:no-repeat',
      'image-rendering:pixelated',
      'display:none',
      'pointer-events:none',
      'background-position:0 0',
      'overflow:hidden',
      'background-origin:border-box',
      'background-clip:border-box',
    ].join(';');
    petContainer.appendChild(petSpriteEl);
    document.documentElement.appendChild(petContainer);

    makePetDraggable(petContainer);
    
    petContainer.addEventListener('dblclick', () => {
      resetPetPosition();
    });

    loadPetPosition();
    
    // Load Codex pet format (pet.json + spritesheet.webp)
    loadPetConfig().then(config => {
      petConfig = config;
      if (petConfig) {
        console.log('[local-voice] Codex pet loaded:', petConfig.id, `${petConfig.columns}x${petConfig.rows}`);
        petSpriteEl.style.display = 'block';
        petSpriteEl.style.backgroundImage = `url("${petConfig.spritesheetUrl}")`;
        petSpriteEl.style.backgroundRepeat = 'no-repeat';
        
        // Ensure the container matches the aspect ratio of a single frame
        if (petConfig.frameWidth && petConfig.frameHeight) {
          const ratio = petConfig.frameHeight / petConfig.frameWidth;
          const currentWidth = DEFAULT_PET_SIZE.width;
          petContainer.style.height = `${Math.round(currentWidth * ratio)}px`;
        }
        applyPetSpriteFrame(0);
      } else {
        console.warn('[local-voice] Codex pet assets are unavailable. Pet animation is disabled.');
      }
      setPixelPetState('idle');
    });
  }

  function makePetDraggable(el) {
    let dragState = null;
    const onMove = (e) => {
      if (!dragState) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      const nextLeft = dragState.startLeft + dx;
      const nextTop = dragState.startTop + dy;
      
      const margin = 10;
      const clampedLeft = Math.min(Math.max(margin, nextLeft), window.innerWidth - el.offsetWidth - margin);
      const clampedTop = Math.min(Math.max(margin, nextTop), window.innerHeight - el.offsetHeight - margin);
      
      el.style.left = `${clampedLeft}px`;
      el.style.top = `${clampedTop}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };
    const onUp = async () => {
      if (!dragState) return;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      dragState = null;
      await savePetPosition();
    };
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      dragState = {
        startX: e.clientX,
        startY: e.clientY,
        startLeft: rect.left,
        startTop: rect.top,
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  async function loadPetPosition() {
    if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return;
    const data = await chrome.storage.local.get([PET_POSITION_KEY]);
    const pos = data[PET_POSITION_KEY];
    if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
      petContainer.style.left = `${pos.left}px`;
      petContainer.style.top = `${pos.top}px`;
      petContainer.style.right = 'auto';
      petContainer.style.bottom = 'auto';
    } else {
      // Default position: Above or near the panel
      petContainer.style.right = '24px';
      petContainer.style.bottom = '140px';
    }
  }

  async function savePetPosition() {
    if (!petContainer || !globalThis.chrome || !chrome.storage || !chrome.storage.local) return;
    const rect = petContainer.getBoundingClientRect();
    await chrome.storage.local.set({
      [PET_POSITION_KEY]: { left: Math.round(rect.left), top: Math.round(rect.top) }
    });
  }

  function resetPetPosition() {
    if (!petContainer) return;
    petContainer.style.left = '';
    petContainer.style.top = '';
    petContainer.style.right = '24px';
    petContainer.style.bottom = '140px';
    void savePetPosition();
  }

  function setPixelPetState(state) {
    if (!petSpriteEl) return;
    petState = state;
    
    if (petAnimTimer) {
      clearInterval(petAnimTimer);
      clearTimeout(petAnimTimer);
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
          break;
        case 'error':
          startPetSpriteAnim('error');
          setTimeout(() => {
            if (petState === 'error') setPixelPetState('idle');
          }, 3000);
          break;
      }
    } else if (state === 'error') {
      setTimeout(() => {
        if (petState === 'error') setPixelPetState('idle');
      }, 3000);
    }
    
    if (petContainer) {
      // If disabled, make it slightly darker/transparent
      const isActuallyEnabled = enabled && settings.enabled;
      petContainer.style.opacity = isActuallyEnabled ? '1' : '0.4';
      petContainer.style.filter = isActuallyEnabled ? 'none' : 'grayscale(0.5) brightness(0.7)';
    }
  }

  function createPanel() {
    if (panel) return;
    // Always create, but initial visibility depends on isUiOwner
    // If isUiOwner is null (unknown), we show it as fallback.

    panel = document.createElement('div');
    panel.id = 'local-voice-bridge-panel';
    panel.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'font:12px/1.35 "Segoe UI",sans-serif',
      'background:linear-gradient(135deg,rgba(10,12,18,.86),rgba(14,20,30,.82))',
      'color:#f5f7ff',
      'border:1px solid rgba(120,180,255,.25)',
      'border-radius:14px',
      'padding:10px',
      'box-shadow:0 10px 28px rgba(0,0,0,.45),0 0 18px rgba(92,155,255,.18)',
      'backdrop-filter:blur(10px)',
      'display:flex',
      'flex-direction:column',
      'gap:8px',
      'width:min(92vw,320px)',
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:space-between',
      'gap:8px',
      'cursor:move',
      'padding:2px 2px 4px 2px',
      'border-bottom:1px solid rgba(255,255,255,.08)',
      'user-select:none',
    ].join(';');

    titleNode = document.createElement('div');
    titleNode.textContent = 'Local Voice';
    titleNode.style.cssText = 'font-weight:700;letter-spacing:.2px;color:#fbfdff;';

    statusNode = document.createElement('div');
    statusNode.style.cssText = [
      'font-size:11px',
      'font-weight:700',
      'padding:3px 8px',
      'border-radius:999px',
      'background:rgba(93,171,255,.2)',
      'border:1px solid rgba(120,180,255,.45)',
      'color:#e8f3ff',
      'white-space:nowrap',
    ].join(';');

    panelBody = document.createElement('div');
    panelBody.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    detailNode = document.createElement('div');
    detailNode.style.cssText = 'font-size:11px;color:#c8d2e8;min-height:1.2em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    const voiceRow = document.createElement('div');
    voiceRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const voiceLabel = document.createElement('div');
    voiceLabel.textContent = 'Voice';
    voiceLabel.style.cssText = 'font-size:11px;color:#c8d2e8;min-width:34px;';
    voiceProfileSelect = document.createElement('select');
    voiceProfileSelect.id = 'local-voice-voice-select';
    voiceProfileSelect.dataset.testid = 'local-voice-profile';
    voiceProfileSelect.style.cssText = [
      'flex:1',
      'min-width:0',
      'font:600 11px/1.1 "Segoe UI",sans-serif',
      'padding:4px 6px',
      'border-radius:8px',
      'border:1px solid rgba(255,255,255,0.2)',
      'background:rgba(255,255,255,0.08)',
      'color:#f7f9ff',
    ].join(';');
    voiceProfileSelect.addEventListener('click', (event) => event.stopPropagation());
    voiceProfileSelect.addEventListener('change', async () => {
      const picked = String(voiceProfileSelect.value || DEFAULT_SETTINGS.voiceProfile);
      await persistVoiceProfile(picked);
      setPanelState('Ready', `Voice switched to ${picked}`);
    });
    voiceRow.append(voiceLabel, voiceProfileSelect);

    const tabRow = document.createElement('div');
    tabRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const tabLabel = document.createElement('div');
    tabLabel.textContent = 'Tab';
    tabLabel.style.cssText = 'font-size:11px;color:#c8d2e8;min-width:34px;';
    tabSelect = document.createElement('select');
    tabSelect.id = 'local-voice-tab-select';
    tabSelect.dataset.testid = 'local-voice-tab';
    tabSelect.style.cssText = [
      'flex:1',
      'min-width:0',
      'font:600 11px/1.1 "Segoe UI",sans-serif',
      'padding:4px 6px',
      'border-radius:8px',
      'border:1px solid rgba(255,255,255,0.2)',
      'background:rgba(255,255,255,0.08)',
      'color:#f7f9ff',
    ].join(';');
    tabSelect.addEventListener('click', (event) => event.stopPropagation());
    tabSelect.addEventListener('change', () => {
      void sendUiCommand('select-tab', { tabId: Number(tabSelect.value) });
    });
    tabRow.append(tabLabel, tabSelect);

    const volumeRow = document.createElement('div');
    volumeRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const volumeLabel = document.createElement('div');
    volumeLabel.textContent = 'Volume';
    volumeLabel.style.cssText = 'font-size:11px;color:#c8d2e8;min-width:42px;';
    volumeSlider = document.createElement('input');
    volumeSlider.id = 'local-voice-volume-slider';
    volumeSlider.dataset.testid = 'local-voice-volume';
    volumeSlider.type = 'range';
    volumeSlider.min = '0';
    volumeSlider.max = '100';
    volumeSlider.step = '1';
    volumeSlider.style.cssText = 'flex:1;min-width:0;';
    volumeSlider.addEventListener('click', (event) => event.stopPropagation());
    volumeSlider.addEventListener('input', () => {
      const percent = Math.min(100, Math.max(0, Number(volumeSlider.value) || 0));
      settings.voiceVolume = clampVolume(percent / 100);
      setVolumeDisplay(Math.round(clampVolume(settings.voiceVolume) * 100));
      if (currentAudio && Number.isFinite(currentAudio.volume)) {
        currentAudio.volume = settings.voiceVolume;
      }
    });
    volumeSlider.addEventListener('change', async () => {
      await persistVoiceVolume(volumeSlider.value);
      setPanelState('Ready', `Volume ${Math.round(clampVolume(settings.voiceVolume) * 100)}%`);
    });
    volumeValueNode = document.createElement('div');
    volumeValueNode.style.cssText = 'font-size:11px;color:#c8d2e8;min-width:36px;text-align:right;';
    volumeRow.append(volumeLabel, volumeSlider, volumeValueNode);

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap';

    autoButton = createButton('Auto', async () => {
      enabled = !enabled;
      settings.enabled = enabled;
      autoButton.style.borderColor = enabled ? 'rgba(90,200,140,.5)' : 'rgba(255,255,255,.18)';
      autoButton.style.background = enabled ? 'rgba(73,168,113,.25)' : 'rgba(255,255,255,.08)';
      setPanelState('Ready', enabled ? 'Auto read enabled' : 'Auto read disabled');
      setPixelPetState(petState);
      if (globalThis.chrome && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ enabled });
      }
    }, 'local-voice-auto');

    const readButton = createButton('Read', () => {
      void sendUiCommand('read', { voiceProfile: getCurrentVoiceProfile() });
    }, 'local-voice-read');

    const nextButton = createButton('Next', () => {
      void sendUiCommand('next', { voiceProfile: getCurrentVoiceProfile() });
    }, 'local-voice-next');

    const regenButton = createButton('Regen', () => {
      void sendUiCommand('regen', { voiceProfile: getCurrentVoiceProfile() });
    }, 'local-voice-regen');

    replayButton = createButton('Replay', () => {
      void sendUiCommand('replay');
    }, 'local-voice-replay');

    const skipButton = createButton('Skip', () => {
      void sendUiCommand('skip');
    }, 'local-voice-skip');

    const stopButton = createButton('Stop', () => {
      void sendUiCommand('stop');
    }, 'local-voice-stop');

    controls.append(autoButton, readButton, nextButton, regenButton, replayButton, skipButton, stopButton);
    panelBody.append(detailNode, voiceRow, tabRow, volumeRow, controls);
    header.append(titleNode, statusNode);
    panel.append(header, panelBody);
    document.documentElement.appendChild(panel);

    autoButton.style.borderColor = enabled ? 'rgba(90,200,140,.5)' : 'rgba(255,255,255,.18)';
    autoButton.style.background = enabled ? 'rgba(73,168,113,.25)' : 'rgba(255,255,255,.08)';

    syncVoiceProfileSelect();
    syncVoiceVolumeSlider();
    setLastAudio(null);
    setPanelState('Ready', `${getCurrentVoiceProfile()} / chunk 0 ready`);
    applyPanelPosition(settings[PANEL_POSITION_KEY]);
    void setCollapsed(Boolean(settings[PANEL_COLLAPSED_KEY]), false);
    makePanelDraggable(header);

    // Initial visibility
    if (isUiOwner === false) {
      hidePanelForNonOwner();
    } else {
      ensurePanelVisible();
    }

    header.addEventListener('click', () => {
      if (dragMovedRecently) return;
      void setCollapsed(!Boolean(settings[PANEL_COLLAPSED_KEY]), true);
    });

    window.addEventListener('resize', () => {
      if (!panel) return;
      if (!panel.style.left || !panel.style.top) return;
      const left = Number.parseFloat(panel.style.left || '0');
      const top = Number.parseFloat(panel.style.top || '0');
      const clamped = clampPanelPosition(left, top);
      panel.style.left = `${clamped.left}px`;
      panel.style.top = `${clamped.top}px`;
    });
  }

  function clearAllPreviewCache() {
    setLastAudio(null);
    setPanelState('Ready', 'Local cache cleared');
  }

  async function forceGenerateLatestPreview() {
    const entry = buildLatestChunkContext();
    if (!entry) {
      setPanelState('Error', 'No assistant response');
      return { ok: false, error: 'No assistant response' };
    }
    const state = ensureElementState(entry.node, entry.text);
    state.sent = true;
    entry.node.dataset[AUTO_SENT_FLAG] = '1';
    const targetIndex = 0;
    try {
      await readChunk(entry, targetIndex, { forceGenerate: true, fallbackGenerateOnCacheFail: false });
      setPanelState('Ready', 'Force regenerated');
      return { ok: true, preview: entry.chunks[targetIndex], chunkIndex: targetIndex };
    } catch (error) {
      setPanelState('Offline', error.message || String(error));
      return { ok: false, error: error.message || String(error) };
    }
  }

  function registerDebugApi() {
    globalThis.localVoiceBridgeDebug = {
      forceGenerateLatest: () => forceGenerateLatestPreview(),
      clearCache: () => {
        clearAllPreviewCache();
        return { ok: true };
      },
      getLastPreview: () => (lastPreviewEntry ? { ...lastPreviewEntry } : null),
      getUiSnapshot: () => ({
        isUiOwner,
        enabled,
        selectedTabId,
        queueSize,
        voiceProfile: getCurrentVoiceProfile(),
        voiceVolume: clampVolume(settings.voiceVolume),
        currentAudioVolume: currentAudio ? Number(currentAudio.volume) : null,
        isPlaying,
        lastElementVolumeApplied,
        lastGainVolumeApplied,
      }),
    };
  }

  function getDebugContentState() {
    return {
      isUiOwner,
      enabled,
      selectedTabId,
      queueSize,
      voiceProfile: getCurrentVoiceProfile(),
      voiceVolume: clampVolume(settings.voiceVolume),
      currentAudioVolume: currentAudio ? Number(currentAudio.volume) : null,
      isPlaying,
      lastElementVolumeApplied,
      lastGainVolumeApplied,
    };
  }

  async function migrateSettingsIfNeeded(stored) {
    const next = { ...stored };
    const version = Number(stored.settingsVersion || 0);
    if (version >= SETTINGS_VERSION) return null;
    next.previewMaxLines = DEFAULT_SETTINGS.previewMaxLines;
    next.previewMaxChars = DEFAULT_SETTINGS.previewMaxChars;
    next.previewMinChars = DEFAULT_SETTINGS.previewMinChars;
    next.previewStableMs = DEFAULT_SETTINGS.previewStableMs;
    next.apiUrl = preferCurrentUnlessLegacyOrEmpty(stored.apiUrl, LEGACY_DEFAULT_API_URL, DEFAULT_SETTINGS.apiUrl);
    next.healthUrl = preferCurrentUnlessLegacyOrEmpty(stored.healthUrl, LEGACY_DEFAULT_HEALTH_URL, DEFAULT_SETTINGS.healthUrl);
    next.voiceProfile = String(stored.voiceProfile || DEFAULT_SETTINGS.voiceProfile);
    next.voiceVolume = clampVolume(stored.voiceVolume);
    next.settingsVersion = SETTINGS_VERSION;
    if (typeof next.panelCollapsed !== 'boolean') next.panelCollapsed = DEFAULT_SETTINGS.panelCollapsed;
    return next;
  }

  function ensurePanelVisible() {
    console.debug('[local-voice] ensurePanelVisible() called, panel exists:', !!panel, 'pet exists:', !!petContainer);
    if (!panel) createPanel();
    if (!petContainer) createPixelPet();
    if (panel) {
      panel.style.display = 'flex';
      console.debug('[local-voice] panel.style.display set to flex');
    }
    if (petContainer) {
      petContainer.style.display = 'flex';
      console.debug('[local-voice] petContainer.style.display set to flex');
    }
  }

  function hidePanelForNonOwner() {
    console.debug('[local-voice] hidePanelForNonOwner() called');
    if (panel) panel.style.display = 'none';
    if (petContainer) petContainer.style.display = 'none';
  }

  function applyOwnerState(nextIsOwner, payload = null) {
    if (uiOwnerStateFallbackTimer) {
      clearTimeout(uiOwnerStateFallbackTimer);
      uiOwnerStateFallbackTimer = null;
    }

    isUiOwner = nextIsOwner;
    console.debug('[local-voice] applyOwnerState:', { nextIsOwner, isUiOwner });
    
    if (payload) {
      globalTabs = payload.tabs || [];
      selectedTabId = payload.selectedTabId;
      queueSize = payload.queueSize || 0;
      setLastAudio(payload.lastPlayedItem || null);
    }

    if (isUiOwner !== false) { // true or null (fallback)
      ensurePanelVisible();
      
      if (payload) {
        if (tabSelect) {
          const currentVal = tabSelect.value;
          tabSelect.innerHTML = '';
          for (const t of globalTabs) {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.title.slice(0, 30) + (t.title.length > 30 ? '...' : '');
            tabSelect.appendChild(opt);
          }
          tabSelect.value = String(selectedTabId || '');
        }

        if (payload.isPlaying) {
          const txt = payload.currentPlayingItem?.text || '';
          const tabName = payload.currentPlayingItem?.tabTitle || 'ChatGPT';
          setPanelState('Playing', `[${tabName}] ${txt.slice(0, 40)}${txt.length > 40 ? '...' : ''}`);
          setPixelPetState('talking');
        } else {
          const statusText = String(payload.statusText || '');
          const queueText = queueSize > 0 ? `Queued ${queueSize}` : 'Queue empty';
          setPanelState('Ready', statusText ? `${statusText} / ${queueText}` : queueText);
          setPixelPetState('idle');
        }
      }
    } else {
      hidePanelForNonOwner();
    }
  }

  async function loadSettings() {
    if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) {
      settings = { ...DEFAULT_SETTINGS };
      enabled = Boolean(settings.enabled);
      return;
    }
    const stored = await chrome.storage.local.get(null);
    const migrated = await migrateSettingsIfNeeded(stored);
    if (migrated) {
      await chrome.storage.local.set(migrated);
    }
    const effective = migrated || stored;
    settings = { ...DEFAULT_SETTINGS, ...effective };
    settings.voiceVolume = clampVolume(settings.voiceVolume);
    enabled = Boolean(settings.enabled);
  }

  async function start() {
    // 1. Setup message listener FIRST
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'state-update') {
        console.debug('[local-voice] Received state-update:', message.payload);
        applyOwnerState(message.payload.isUiOwner, message.payload);
      }

      if (message.type === 'play-audio') {
        void playItem(
          message.payload.url,
          message.payload.text,
          message.payload.item,
          String(message.payload.playbackToken || '')
        );
      }

      if (message.type === 'stop-audio') {
        const incomingToken = String((message.payload && message.payload.playbackToken) || '');
        if (!incomingToken || incomingToken === currentPlaybackToken) {
          stopCurrentPlayback('stop');
        }
      }

      if (message.type === 'debug-content-state') {
        sendResponse({ ok: true, payload: getDebugContentState() });
        return false;
      }

      if (message.type === 'debug-force-web-audio-next') {
        forceWebAudioNextPlayback = true;
        sendResponse({ ok: true, payload: { forced: true } });
        return false;
      }

      if (message.type === 'debug-set-playback-simulated') {
        debugSimulatedPlayback = Boolean(message.enabled);
        sendResponse({ ok: true, payload: { enabled: debugSimulatedPlayback } });
        return false;
      }
    });

    // 2. Load settings and probe API
    await loadSettings();
    registerDebugApi();
    markExistingMessagesAsSeen();
    await probeApiStatus();

    // 3. Register tab and handle immediate response
    console.debug('[local-voice] Registering tab...');
    try {
      const response = await runtimeMessage('register-tab', { title: document.title });
      console.debug('[local-voice] register-tab response:', response);
      if (response && typeof response.isUiOwner !== 'undefined') {
        applyOwnerState(response.isUiOwner, response);
      } else {
        console.debug('[local-voice] No immediate owner state in response, waiting for fallback/update');
        // No payload, wait for state-update or fallback
        uiOwnerStateFallbackTimer = setTimeout(() => {
          if (isUiOwner === null) {
            console.debug('[local-voice] Fallback timer triggered: isUiOwner is still null, showing UI');
            applyOwnerState(null);
          }
        }, 2000);
      }
    } catch (err) {
      console.error('[local-voice] Failed to register tab:', err);
      // Fallback: show UI after some time if no background response
      uiOwnerStateFallbackTimer = setTimeout(() => {
        if (isUiOwner === null) {
          console.debug('[local-voice] Fallback timer triggered (after error): isUiOwner is still null, showing UI');
          applyOwnerState(null);
        }
      }, 2000);
    }

    // 4. Setup observer
    observer = new MutationObserver(scheduleInspect);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // 5. Periodic re-registration (heartbeat)
    setInterval(() => {
      chrome.runtime.sendMessage({
        type: 'register-tab',
        title: document.title
      }).catch(() => {});
    }, 5000);
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

  if (globalThis.chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const [key, change] of Object.entries(changes)) {
        settings[key] = change.newValue;
      }

      enabled = Boolean(settings.enabled);
      if (autoButton) {
        autoButton.style.borderColor = enabled ? 'rgba(90,200,140,.5)' : 'rgba(255,255,255,.18)';
        autoButton.style.background = enabled ? 'rgba(73,168,113,.25)' : 'rgba(255,255,255,.08)';
      }
      setPixelPetState(petState);

      if (Object.prototype.hasOwnProperty.call(changes, PANEL_POSITION_KEY)) {
        applyPanelPosition(changes[PANEL_POSITION_KEY].newValue);
      }
      if (Object.prototype.hasOwnProperty.call(changes, PANEL_COLLAPSED_KEY)) {
        void setCollapsed(Boolean(changes[PANEL_COLLAPSED_KEY].newValue), false);
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'voiceProfile')) {
        if (voiceProfileSelect) syncVoiceProfileSelect();
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'voiceVolume')) {
        settings.voiceVolume = clampVolume(changes.voiceVolume.newValue);
        syncVoiceVolumeSlider();
        if (currentAudio && Number.isFinite(currentAudio.volume)) {
          currentAudio.volume = settings.voiceVolume;
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      console.debug('[local-voice] DOMContentLoaded, starting...');
      void start();
    }, { once: true });
  } else {
    console.debug('[local-voice] Document already loaded, starting...');
    void start();
  }
})();


