(() => {
  const SETTINGS_VERSION = 4;
  const DEFAULT_SETTINGS = {
    settingsVersion: SETTINGS_VERSION,
    enabled: false,
    apiUrl: 'http://127.0.0.1:8765/v1/speak',
    healthUrl: 'http://127.0.0.1:8765/health',
    voiceProfile: 'irodori-v2',
    voiceVolume: 0.6,
    previewMaxLines: 2,
    previewMaxChars: 80,
    previewMinChars: 25,
    previewStableMs: 800,
    panelPosition: null,
    panelCollapsed: true,
  };

  const MIN_FALLBACK_CHARS = 20;
  const AUTO_SENT_FLAG = 'localVoiceSent';
  const PANEL_POSITION_KEY = 'panelPosition';
  const PANEL_COLLAPSED_KEY = 'panelCollapsed';
  const DEFAULT_PROFILE_OPTIONS = [
    { id: 'irodori-v2', label: 'Irodori v2' },
    { id: 'irodori-v3', label: 'Irodori v3' },
  ];
  const PET_POSITION_KEY = 'petPosition';
  const DEFAULT_PET_SIZE = { width: 72, height: 86 };

  const stateByElement = new WeakMap();
  const initializedElements = new WeakSet();
  const audioQueue = [];
  const audioCache = new Map();
  const readCursorByMessage = new Map();

  let settings = { ...DEFAULT_SETTINGS };
  let enabled = Boolean(DEFAULT_SETTINGS.enabled);
  let availableVoiceProfiles = [...DEFAULT_PROFILE_OPTIONS];
  let observer = null;
  let inspectTimer = null;
  let sequence = 0;
  let isPlaying = false;
  let currentAudio = null;
  let lastAudio = null;
  let lastPreviewEntry = null;
  let dragMovedRecently = false;

  // Pixel Pet variables
  let petContainer = null;
  let petImage = null;
  let petState = 'idle';
  let petAnimTimer = null;
  let petBlinkTimer = null;

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
      titleNode.textContent = `Voice · ${statusText}`;
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

  function cacheAudio(key, audioUrl, text) {
    audioCache.set(key, {
      audioUrl,
      text,
      createdAt: Date.now(),
    });
  }

  function clearCacheForKey(key) {
    audioCache.delete(key);
    if (lastAudio && lastAudio.cacheKey === key) {
      setLastAudio(null);
    }
  }

  async function postToLocalApi(text, requestId, voiceProfile) {
    const apiUrl = String(settings.apiUrl || DEFAULT_SETTINGS.apiUrl);
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, requestId, source: 'chatgpt-web', voiceProfile }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `Local API failed: ${response.status}`);
    }
    return payload;
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

  async function requestSpeech(text, requestId, voiceProfile) {
    if (canUseRuntimeMessaging()) {
      try {
        return await runtimeMessage('speak', { text, requestId, voiceProfile });
      } catch (_error) {
        // Fall back to direct fetch in restricted content-script environments.
      }
    }
    return postToLocalApi(text, requestId, voiceProfile);
  }

  function enqueueAudio(url, text, meta = {}) {
    audioQueue.push({ url, text, meta });
    if (!isPlaying) {
      setPanelState('Ready', audioQueue.length > 0 ? `Queued ${audioQueue.length}` : 'Irodori / preview only');
    }
    void playNext();
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

  async function playWithAudioElement(blob) {
    const objectUrl = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      const audio = new Audio(objectUrl);
      audio.volume = clampVolume(settings.voiceVolume);
      currentAudio = audio;
      audio.onended = () => {
        URL.revokeObjectURL(objectUrl);
        resolve();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('audio element failed to load generated audio'));
      };
      audio.play().catch((error) => {
        URL.revokeObjectURL(objectUrl);
        reject(error);
      });
    });
  }

  async function playWithWebAudio(blob) {
    const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error('Web Audio API is unavailable');
    }
    const buffer = await blob.arrayBuffer();
    const context = new AudioContextCtor();
    if (context.state === 'suspended') {
      await context.resume();
    }
    const decoded = await context.decodeAudioData(buffer.slice(0));
    await new Promise((resolve, reject) => {
      const source = context.createBufferSource();
      const gain = context.createGain();
      gain.gain.value = clampVolume(settings.voiceVolume);
      source.buffer = decoded;
      source.connect(gain);
      gain.connect(context.destination);
      source.onended = resolve;
      try {
        source.start(0);
      } catch (error) {
        reject(error);
      }
    });
    await context.close().catch(() => {});
  }

  async function playAudioBlob(blob) {
    try {
      await playWithAudioElement(blob);
    } catch (_elementError) {
      await playWithWebAudio(blob);
    }
  }

  async function playNext() {
    if (isPlaying || audioQueue.length === 0) return;

    const item = audioQueue.shift();
    isPlaying = true;
    currentAudio = null;

    try {
      setPanelState('Playing', `${item.text.slice(0, 60)}${item.text.length > 60 ? '...' : ''}`);
      setPixelPetState('talking');
      const blob = await fetchAudioBlob(item.url);
      await playAudioBlob(blob);

      isPlaying = false;
      currentAudio = null;
      
      // Briefly show happy state if possible
      setPixelPetState('happy');
      setTimeout(() => {
        if (petState === 'happy') {
          setPixelPetState('idle');
        }
      }, 1200);

      setLastAudio({
        audioUrl: item.url,
        text: item.text,
        createdAt: Date.now(),
        cacheKey: item.meta.cacheKey || null,
        voiceProfile: item.meta.voiceProfile || getCurrentVoiceProfile(),
      });
      setPanelState('Ready', audioQueue.length > 0 ? `Queued ${audioQueue.length}` : 'Irodori / cached');
      void playNext();
    } catch (error) {
      isPlaying = false;
      currentAudio = null;
      setPixelPetState('error');
      let handled = false;
      if (typeof item.meta.onPlaybackError === 'function') {
        try {
          const result = await item.meta.onPlaybackError(error);
          handled = Boolean(result && result.handled);
        } catch (_handlerError) {}
      }
      if (!handled) {
        setPanelState('Error', error.message || String(error));
      }
      void playNext();
    }
  }

  function stopPlayback() {
    audioQueue.length = 0;
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    }
    currentAudio = null;
    isPlaying = false;
    setPixelPetState('idle');
    setPanelState('Ready', 'Playback stopped');
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

  async function generateAndQueue(chunkText, cacheKey, node, chunkMeta) {
    const requestId = `${cacheKey}-${Date.now()}-${sequence++}`.slice(0, 120);
    const voiceProfile = getCurrentVoiceProfile();
    setPixelPetState('thinking');
    setPanelState('Generating', `${chunkText.length} chars / ${voiceProfile}`);

    node.dataset[AUTO_SENT_FLAG] = '1';
    const nodeState = stateByElement.get(node);
    if (nodeState) nodeState.sent = true;

    const payload = await requestSpeech(chunkText, requestId, voiceProfile);
    const audioUrl = payload && payload.audioUrl;
    if (!audioUrl) {
      throw new Error('audioUrl is missing in API response');
    }

    cacheAudio(cacheKey, audioUrl, chunkText);
    console.debug('[local-voice] speak', {
      voiceProfile,
      messageKey: chunkMeta.messageKey,
      chunkIndex: chunkMeta.chunkIndex,
      cacheKey,
      cacheHit: false,
      text: chunkText,
    });
    setPanelState('Cached', `Generated ${voiceProfile}`);
    enqueueAudio(audioUrl, chunkText, {
      cacheKey,
      voiceProfile,
      onPlaybackError: async () => {
        clearCacheForKey(cacheKey);
      },
    });
  }

  async function readChunk(entry, chunkIndex, options = {}) {
    const { forceGenerate = false, fallbackGenerateOnCacheFail = true } = options;
    const chunkText = entry.chunks[chunkIndex];
    if (!chunkText) return;

    const voiceProfile = getCurrentVoiceProfile();
    const cacheKey = getCacheKey({
      voiceProfile,
      messageKey: entry.messageKey,
      chunkIndex,
      text: chunkText,
    });
    const chunkMeta = { messageKey: entry.messageKey, chunkIndex };
    recordLastPreviewEntry(entry, chunkIndex, cacheKey);

    if (!forceGenerate) {
      const cached = audioCache.get(cacheKey);
      if (cached && cached.audioUrl) {
        console.debug('[local-voice] speak', {
          voiceProfile,
          messageKey: entry.messageKey,
          chunkIndex,
          cacheKey,
          cacheHit: true,
          text: chunkText,
        });
        setPanelState('Cached', `Using cached audio / ${voiceProfile}`);
        enqueueAudio(cached.audioUrl, chunkText, {
          cacheKey,
          voiceProfile,
          onPlaybackError: async () => {
            clearCacheForKey(cacheKey);
            if (fallbackGenerateOnCacheFail) {
              await readChunk(entry, chunkIndex, {
                forceGenerate: true,
                fallbackGenerateOnCacheFail: false,
              });
              return { handled: true };
            }
            return { handled: false };
          },
        });
        readCursorByMessage.set(entry.messageKey, chunkIndex);
        return;
      }
    }

    try {
      await generateAndQueue(chunkText, cacheKey, entry.node, chunkMeta);
      readCursorByMessage.set(entry.messageKey, chunkIndex);
      setPanelState('Ready', forceGenerate ? `Force regenerated / ${voiceProfile}` : `Ready / ${voiceProfile}`);
    } catch (error) {
      setPanelState('Offline', error.message || String(error));
      setPixelPetState('error');
    }
  }

  function processNode(node) {
    if (!enabled || !settings.enabled) return;

    const text = extractAssistantText(node);
    if (!text) return;

    const item = ensureElementState(node, text);
    if (item.sent) return;

    if (!initializedElements.has(node)) {
      initializedElements.add(node);
      item.lastText = text;
      item.lastChangedAt = Date.now();
      return;
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
      item.sent = true;
      node.dataset[AUTO_SENT_FLAG] = '1';
      void readChunk(entry, 0, { forceGenerate: false });
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
        item.sent = true;
        node.dataset[AUTO_SENT_FLAG] = '1';
        const pendingEntry = {
          node,
          text: latest,
          messageKey: item.key,
          chunks: pendingChunks,
          capturedAt: Date.now(),
        };
        void readChunk(pendingEntry, 0, { forceGenerate: false });
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

  function createButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = [
      'font:600 11px/1.1 "Segoe UI",sans-serif',
      'padding:5px 8px',
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
      titleNode.textContent = collapsed ? `Voice · ${statusNode ? statusNode.textContent : 'Ready'}` : 'Local Voice';
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

  function createPixelPet() {
    if (petContainer) return;

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
    ].join(';');

    petImage = document.createElement('img');
    petImage.style.cssText = [
      'width:100%',
      'height:100%',
      'object-fit:contain',
      'image-rendering:pixelated',
      'pointer-events:none',
    ].join(';');

    // Fallback logic for missing images
    petImage.onerror = () => {
      const currentSrc = petImage.src;
      const idleSrc = getPetImageUrl('idle_0.png');
      if (currentSrc !== idleSrc) {
        console.warn('[local-voice] Pet image load failed, falling back to idle_0.png', currentSrc);
        petImage.src = idleSrc;
      }
    };
    
    petContainer.appendChild(petImage);
    document.documentElement.appendChild(petContainer);

    makePetDraggable(petContainer);
    
    petContainer.addEventListener('dblclick', () => {
      resetPetPosition();
    });

    loadPetPosition();
    setPixelPetState('idle');
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
    if (!petImage) return;
    petState = state;
    
    if (petAnimTimer) clearInterval(petAnimTimer);
    if (petBlinkTimer) clearTimeout(petBlinkTimer);

    switch (state) {
      case 'idle':
        startPetIdle();
        break;
      case 'thinking':
        petImage.src = getPetImageUrl('thinking_0.png');
        break;
      case 'talking':
        startPetTalking();
        break;
      case 'happy':
        petImage.src = getPetImageUrl('happy_0.png');
        break;
      case 'error':
        petImage.src = getPetImageUrl('error_0.png');
        setTimeout(() => {
          if (petState === 'error') setPixelPetState('idle');
        }, 3000);
        break;
    }
    
    if (petContainer) {
      // If disabled, make it slightly darker/transparent
      const isActuallyEnabled = enabled && settings.enabled;
      petContainer.style.opacity = isActuallyEnabled ? '1' : '0.4';
      petContainer.style.filter = isActuallyEnabled ? 'none' : 'grayscale(0.5) brightness(0.7)';
    }
  }

  function startPetIdle() {
    petImage.src = getPetImageUrl('idle_0.png');
    
    const blink = () => {
      if (petState !== 'idle') return;
      // idle_1.png or fallback to idle_0.png
      petImage.src = getPetImageUrl('idle_1.png');
      setTimeout(() => {
        if (petState !== 'idle') return;
        petImage.src = getPetImageUrl('idle_0.png');
        // Random blink interval: 2s to 7s
        petBlinkTimer = setTimeout(blink, 2000 + Math.random() * 5000);
      }, 150);
    };
    petBlinkTimer = setTimeout(blink, 3000);
  }

  function startPetTalking() {
    // talk_0 -> talk_1 -> talk_2 -> talk_3 -> talk_2 -> talk_1
    const frames = ['talk_0.png', 'talk_1.png', 'talk_2.png', 'talk_3.png', 'talk_2.png', 'talk_1.png'];
    let frameIdx = 0;
    
    const nextFrame = () => {
      if (petState !== 'talking') return;
      petImage.src = getPetImageUrl(frames[frameIdx]);
      frameIdx = (frameIdx + 1) % frames.length;
    };

    nextFrame();
    petAnimTimer = setInterval(nextFrame, 130);
  }

  function createPanel() {
    if (panel) return;

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

    const volumeRow = document.createElement('div');
    volumeRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const volumeLabel = document.createElement('div');
    volumeLabel.textContent = 'Volume';
    volumeLabel.style.cssText = 'font-size:11px;color:#c8d2e8;min-width:42px;';
    volumeSlider = document.createElement('input');
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
    controls.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';

    autoButton = createButton('Auto', async () => {
      enabled = !enabled;
      settings.enabled = enabled;
      if (!enabled) stopPlayback();
      autoButton.style.borderColor = enabled ? 'rgba(90,200,140,.5)' : 'rgba(255,255,255,.18)';
      autoButton.style.background = enabled ? 'rgba(73,168,113,.25)' : 'rgba(255,255,255,.08)';
      setPanelState('Ready', enabled ? 'Auto read enabled' : 'Auto read disabled');
      setPixelPetState(petState);
      if (globalThis.chrome && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ enabled });
      }
    });

    const readButton = createButton('Read', () => {
      const entry = buildLatestChunkContext();
      if (!entry) {
        setPanelState('Error', 'No assistant response');
        return;
      }
      const state = ensureElementState(entry.node, entry.text);
      state.sent = true;
      entry.node.dataset[AUTO_SENT_FLAG] = '1';
      readCursorByMessage.set(entry.messageKey, 0);
      void readChunk(entry, 0, { forceGenerate: false, fallbackGenerateOnCacheFail: true });
    });

    const nextButton = createButton('Next', () => {
      const entry = buildLatestChunkContext();
      if (!entry) {
        setPanelState('Error', 'No assistant response');
        return;
      }
      const state = ensureElementState(entry.node, entry.text);
      state.sent = true;
      entry.node.dataset[AUTO_SENT_FLAG] = '1';

      const lastIndex = readCursorByMessage.get(entry.messageKey);
      const targetIndex = Number.isInteger(lastIndex) ? Number(lastIndex) + 1 : 0;
      if (targetIndex >= entry.chunks.length) {
        setPanelState('Ready', 'No more text');
        return;
      }
      void readChunk(entry, targetIndex, { forceGenerate: false, fallbackGenerateOnCacheFail: true });
    });

    const regenButton = createButton('Regen', () => {
      const entry = buildLatestChunkContext();
      if (!entry) {
        setPanelState('Error', 'No assistant response');
        return;
      }
      const state = ensureElementState(entry.node, entry.text);
      state.sent = true;
      entry.node.dataset[AUTO_SENT_FLAG] = '1';
      const lastIndex = readCursorByMessage.get(entry.messageKey);
      const targetIndex = Number.isInteger(lastIndex) && Number(lastIndex) < entry.chunks.length ? Number(lastIndex) : 0;
      void readChunk(entry, targetIndex, { forceGenerate: true, fallbackGenerateOnCacheFail: false });
    });

    replayButton = createButton('Replay', () => {
      if (!lastAudio || !lastAudio.audioUrl) {
        setPanelState('Ready', 'No replay source');
        return;
      }
      enqueueAudio(lastAudio.audioUrl, lastAudio.text || '', {
        cacheKey: lastAudio.cacheKey || null,
        voiceProfile: lastAudio.voiceProfile || getCurrentVoiceProfile(),
        onPlaybackError: async () => {
          if (lastAudio.cacheKey) clearCacheForKey(lastAudio.cacheKey);
          setLastAudio(null);
        },
      });
      setPanelState('Cached', `Replaying / ${lastAudio.voiceProfile || getCurrentVoiceProfile()}`);
    });

    const stopButton = createButton('Stop', stopPlayback);
    controls.append(autoButton, readButton, nextButton, regenButton, replayButton, stopButton);
    panelBody.append(detailNode, voiceRow, volumeRow, controls);
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
    audioCache.clear();
    readCursorByMessage.clear();
    setLastAudio(null);
    setPanelState('Ready', 'Preview cache cleared');
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
    const lastIndex = readCursorByMessage.get(entry.messageKey);
    const targetIndex = Number.isInteger(lastIndex) && Number(lastIndex) < entry.chunks.length ? Number(lastIndex) : 0;
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
    next.voiceProfile = String(stored.voiceProfile || DEFAULT_SETTINGS.voiceProfile);
    next.voiceVolume = clampVolume(stored.voiceVolume);
    next.settingsVersion = SETTINGS_VERSION;
    if (typeof next.panelCollapsed !== 'boolean') next.panelCollapsed = DEFAULT_SETTINGS.panelCollapsed;
    return next;
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
    await loadSettings();
    registerDebugApi();
    createPanel();
    createPixelPet();
    markExistingMessagesAsSeen();
    await probeApiStatus();

    observer = new MutationObserver(scheduleInspect);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
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
      void start();
    }, { once: true });
  } else {
    void start();
  }
})();

