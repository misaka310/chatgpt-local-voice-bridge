(() => {
  const DEFAULT_SETTINGS = {
    enabled: true,
    apiUrl: 'http://127.0.0.1:8765/v1/speak',
    healthUrl: 'http://127.0.0.1:8765/health',
    previewMaxLines: 3,
    previewMaxChars: 120,
    previewMinChars: 40,
    previewStableMs: 800,
    panelPosition: null,
  };

  const MIN_FALLBACK_CHARS = 20;
  const AUTO_SENT_FLAG = 'localVoiceSent';
  const PANEL_POSITION_KEY = 'panelPosition';

  const stateByElement = new WeakMap();
  const initializedElements = new WeakSet();
  const audioQueue = [];
  const audioCache = new Map();

  let settings = { ...DEFAULT_SETTINGS };
  let currentAudio = null;
  let isPlaying = false;
  let enabled = true;
  let observer = null;
  let inspectTimer = null;
  let sequence = 0;
  let lastAudio = null;

  let panel = null;
  let statusNode = null;
  let detailNode = null;
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

  function naturalCut(text, minChars, maxChars) {
    if (text.length <= maxChars) return text;
    const head = text.slice(0, maxChars);
    const punct = Math.max(
      head.lastIndexOf('。'),
      head.lastIndexOf('．'),
      head.lastIndexOf('！'),
      head.lastIndexOf('？'),
      head.lastIndexOf('.'),
      head.lastIndexOf('!'),
      head.lastIndexOf('?'),
    );
    if (punct >= Math.floor(minChars * 0.6)) {
      return head.slice(0, punct + 1);
    }
    const soft = head.lastIndexOf(' ');
    if (soft >= Math.floor(minChars * 0.6)) {
      return head.slice(0, soft).trim();
    }
    return head;
  }

  function extractSpeakPreview(fullText, options = {}) {
    const maxLines = Number(options.maxLines || DEFAULT_SETTINGS.previewMaxLines);
    const maxChars = Number(options.maxChars || DEFAULT_SETTINGS.previewMaxChars);
    const minChars = Number(options.minChars || DEFAULT_SETTINGS.previewMinChars);

    let text = normalizeText(fullText);
    if (!text) return '';

    text = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/\n{2,}/g, '\n');

    const lines = text
      .split('\n')
      .map((line) => normalizeMarkdownLine(line))
      .filter(Boolean);

    if (!lines.length) return '';

    const picked = lines.slice(0, Math.max(1, maxLines));
    const merged = normalizeText(picked.join(' '));
    if (!merged) return '';

    return normalizeText(naturalCut(merged, minChars, maxChars));
  }

  function shouldSendNow(preview, now, item) {
    const maxChars = Number(settings.previewMaxChars || DEFAULT_SETTINGS.previewMaxChars);
    const minChars = Number(settings.previewMinChars || DEFAULT_SETTINGS.previewMinChars);
    const stableMs = Number(settings.previewStableMs || DEFAULT_SETTINGS.previewStableMs);
    const len = preview.length;
    if (!len) return false;
    if (len >= maxChars) return true;
    if (len >= minChars && /[。．！？.!?]$/.test(preview)) return true;
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
    if (detailNode) detailNode.textContent = detailText || 'Preview only / cache ready';
  }

  function setLastAudio(entry) {
    lastAudio = entry;
    if (!replayButton) return;
    replayButton.disabled = !lastAudio;
    replayButton.style.opacity = lastAudio ? '1' : '0.5';
    replayButton.style.cursor = lastAudio ? 'pointer' : 'not-allowed';
  }

  function getCacheKey(preview) {
    return normalizeText(preview);
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

  async function postToLocalApi(text, requestId) {
    const apiUrl = String(settings.apiUrl || DEFAULT_SETTINGS.apiUrl);
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, requestId, source: 'chatgpt-web' }),
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

  async function requestSpeech(text, requestId) {
    if (canUseRuntimeMessaging()) {
      try {
        return await runtimeMessage('speak', { text, requestId });
      } catch (_error) {
        // Fall back to direct fetch in restricted content-script environments.
      }
    }
    return postToLocalApi(text, requestId);
  }

  function enqueueAudio(url, text, meta = {}) {
    audioQueue.push({ url, text, meta });
    if (!isPlaying) {
      setPanelState('Idle', audioQueue.length > 0 ? `Queued ${audioQueue.length}` : 'Preview only / cache ready');
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
      source.buffer = decoded;
      source.connect(context.destination);
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
      setPanelState('Playing', `${item.text.slice(0, 70)}${item.text.length > 70 ? '...' : ''}`);
      const blob = await fetchAudioBlob(item.url);
      await playAudioBlob(blob);

      isPlaying = false;
      currentAudio = null;
      setLastAudio({
        audioUrl: item.url,
        text: item.text,
        createdAt: Date.now(),
        cacheKey: item.meta.cacheKey || null,
      });
      setPanelState('Idle', audioQueue.length > 0 ? `Queued ${audioQueue.length}` : 'Preview only / cache ready');
      void playNext();
    } catch (error) {
      isPlaying = false;
      currentAudio = null;
      let handled = false;
      if (typeof item.meta.onPlaybackError === 'function') {
        try {
          const result = await item.meta.onPlaybackError(error);
          handled = Boolean(result && result.handled);
        } catch (_handlerError) {
          // Best effort; the main playback error is reported below.
        }
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
    setPanelState('Idle', 'Playback stopped');
  }

  async function generateAndQueue(preview, key, node) {
    const requestId = `${key}-${Date.now()}-${sequence++}`.slice(0, 120);
    setPanelState('Generating', `${preview.length} chars`);

    node.dataset[AUTO_SENT_FLAG] = '1';
    const nodeState = stateByElement.get(node);
    if (nodeState) nodeState.sent = true;

    const payload = await requestSpeech(preview, requestId);
    const audioUrl = payload && payload.audioUrl;
    if (!audioUrl) {
      throw new Error('audioUrl is missing in API response');
    }

    cacheAudio(key, audioUrl, preview);
    setPanelState('Cached', 'Generated and cached');

    enqueueAudio(audioUrl, preview, {
      cacheKey: key,
      onPlaybackError: async () => {
        clearCacheForKey(key);
      },
    });
  }

  async function readPreview(preview, key, node, options = {}) {
    const { forceGenerate = false, fallbackGenerateOnCacheFail = true } = options;
    if (!preview) return;

    if (!forceGenerate) {
      const cached = audioCache.get(key);
      if (cached && cached.audioUrl) {
        setPanelState('Cached', 'Using cached audio');
        enqueueAudio(cached.audioUrl, preview, {
          cacheKey: key,
          onPlaybackError: async () => {
            clearCacheForKey(key);
            if (fallbackGenerateOnCacheFail) {
              await readPreview(preview, key, node, {
                forceGenerate: true,
                fallbackGenerateOnCacheFail: false,
              });
              return { handled: true };
            }
            return { handled: false };
          },
        });
        return;
      }
    }

    try {
      await generateAndQueue(preview, key, node);
      setPanelState('Qwen Ready', 'Preview only / cache ready');
    } catch (error) {
      setPanelState('Qwen Offline', error.message || String(error));
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

    const preview = extractSpeakPreview(text, {
      maxLines: Number(settings.previewMaxLines || DEFAULT_SETTINGS.previewMaxLines),
      maxChars: Number(settings.previewMaxChars || DEFAULT_SETTINGS.previewMaxChars),
      minChars: Number(settings.previewMinChars || DEFAULT_SETTINGS.previewMinChars),
    });
    if (!preview) return;

    const now = Date.now();
    if (shouldSendNow(preview, now, item)) {
      item.sent = true;
      node.dataset[AUTO_SENT_FLAG] = '1';
      const key = getCacheKey(preview);
      void readPreview(preview, key, node, { forceGenerate: false });
      return;
    }

    if (item.idleTimer) clearTimeout(item.idleTimer);
    item.idleTimer = setTimeout(() => {
      if (item.sent) return;
      const latest = extractAssistantText(node);
      if (latest !== item.lastText) return;

      const pendingPreview = extractSpeakPreview(latest, {
        maxLines: Number(settings.previewMaxLines || DEFAULT_SETTINGS.previewMaxLines),
        maxChars: Number(settings.previewMaxChars || DEFAULT_SETTINGS.previewMaxChars),
        minChars: Number(settings.previewMinChars || DEFAULT_SETTINGS.previewMinChars),
      });
      if (!pendingPreview) return;

      if (shouldSendNow(pendingPreview, Date.now(), item)) {
        item.sent = true;
        node.dataset[AUTO_SENT_FLAG] = '1';
        const key = getCacheKey(pendingPreview);
        void readPreview(pendingPreview, key, node, { forceGenerate: false });
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
      'font:500 12px/1.2 "Segoe UI",sans-serif',
      'padding:6px 10px',
      'border-radius:10px',
      'border:1px solid rgba(255,255,255,0.15)',
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

  function clampPanelPosition(left, top) {
    if (!panel) return { left, top };
    const margin = 8;
    const panelWidth = panel.offsetWidth || 320;
    const panelHeight = panel.offsetHeight || 150;

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

  function makePanelDraggable(dragHandle) {
    if (!panel || !dragHandle) return;

    let dragState = null;
    const body = document.body;

    const onMove = (event) => {
      if (!dragState) return;
      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
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
    };

    dragHandle.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
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
      if (canUseRuntimeMessaging()) {
        await runtimeMessage('health');
      } else {
        const healthUrl = String(settings.healthUrl || DEFAULT_SETTINGS.healthUrl);
        const response = await fetch(healthUrl, { method: 'GET', cache: 'no-store' });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || `health failed: ${response.status}`);
        }
      }
      setPanelState('Qwen Ready', 'Preview only / cache ready');
    } catch (_error) {
      setPanelState('Qwen Offline', 'Start with run-qwen-stack.cmd');
    }
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
      'font:12px/1.4 "Segoe UI",sans-serif',
      'background:linear-gradient(135deg,rgba(10,12,18,.86),rgba(14,20,30,.82))',
      'color:#f5f7ff',
      'border:1px solid rgba(120,180,255,.25)',
      'border-radius:14px',
      'padding:10px',
      'box-shadow:0 10px 28px rgba(0,0,0,.45), 0 0 18px rgba(92,155,255,.18)',
      'backdrop-filter:blur(10px)',
      'display:flex',
      'flex-direction:column',
      'gap:8px',
      'width:min(92vw,360px)',
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

    const title = document.createElement('div');
    title.textContent = 'Local Voice';
    title.style.cssText = 'font-weight:700;letter-spacing:.3px;color:#fbfdff';

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

    detailNode = document.createElement('div');
    detailNode.style.cssText = 'font-size:11px;color:#c8d2e8;min-height:1.2em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';

    autoButton = createButton('Auto ON', async () => {
      enabled = !enabled;
      settings.enabled = enabled;
      if (!enabled) stopPlayback();
      autoButton.textContent = enabled ? 'Auto ON' : 'Auto OFF';
      autoButton.style.borderColor = enabled ? 'rgba(90,200,140,.5)' : 'rgba(255,255,255,.15)';
      autoButton.style.background = enabled ? 'rgba(73,168,113,.25)' : 'rgba(255,255,255,.08)';
      setPanelState('Idle', enabled ? 'Auto read enabled' : 'Auto read disabled');

      if (globalThis.chrome && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ enabled });
      }
    });

    const readLatestButton = createButton('Read Latest', () => {
      const nodes = getAssistantNodes();
      if (!nodes.length) {
        setPanelState('Error', 'No assistant response');
        return;
      }

      const latest = nodes[nodes.length - 1];
      const text = extractAssistantText(latest);
      const preview = extractSpeakPreview(text, {
        maxLines: Number(settings.previewMaxLines || DEFAULT_SETTINGS.previewMaxLines),
        maxChars: Number(settings.previewMaxChars || DEFAULT_SETTINGS.previewMaxChars),
        minChars: Number(settings.previewMinChars || DEFAULT_SETTINGS.previewMinChars),
      });

      if (!preview) {
        setPanelState('Error', 'Preview is empty');
        return;
      }

      const key = getCacheKey(preview);
      const state = ensureElementState(latest, text);
      state.sent = true;
      latest.dataset[AUTO_SENT_FLAG] = '1';
      void readPreview(preview, key, latest, { forceGenerate: false, fallbackGenerateOnCacheFail: true });
    });

    replayButton = createButton('Replay', () => {
      if (!lastAudio || !lastAudio.audioUrl) {
        setPanelState('Idle', 'No cached audio');
        return;
      }

      enqueueAudio(lastAudio.audioUrl, lastAudio.text || '', {
        cacheKey: lastAudio.cacheKey || null,
        onPlaybackError: async () => {
          if (lastAudio.cacheKey) clearCacheForKey(lastAudio.cacheKey);
          setLastAudio(null);
        },
      });
      setPanelState('Cached', 'Replaying last audio');
    });

    const stopButton = createButton('Stop', stopPlayback);

    controls.append(autoButton, readLatestButton, replayButton, stopButton);
    header.append(title, statusNode);

    panel.append(header, detailNode, controls);
    document.documentElement.appendChild(panel);

    autoButton.textContent = enabled ? 'Auto ON' : 'Auto OFF';
    autoButton.style.borderColor = enabled ? 'rgba(90,200,140,.5)' : 'rgba(255,255,255,.15)';
    autoButton.style.background = enabled ? 'rgba(73,168,113,.25)' : 'rgba(255,255,255,.08)';

    setLastAudio(null);
    setPanelState('Idle', 'Preview only / cache ready');
    applyPanelPosition(settings[PANEL_POSITION_KEY]);
    makePanelDraggable(header);

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

  async function loadSettings() {
    if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) {
      settings = { ...DEFAULT_SETTINGS };
      enabled = Boolean(settings.enabled);
      return;
    }
    const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
    settings = { ...DEFAULT_SETTINGS, ...stored };
    enabled = Boolean(settings.enabled);
  }

  async function start() {
    await loadSettings();
    createPanel();
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
        autoButton.textContent = enabled ? 'Auto ON' : 'Auto OFF';
        autoButton.style.borderColor = enabled ? 'rgba(90,200,140,.5)' : 'rgba(255,255,255,.15)';
        autoButton.style.background = enabled ? 'rgba(73,168,113,.25)' : 'rgba(255,255,255,.08)';
      }

      if (Object.prototype.hasOwnProperty.call(changes, PANEL_POSITION_KEY)) {
        applyPanelPosition(changes[PANEL_POSITION_KEY].newValue);
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
