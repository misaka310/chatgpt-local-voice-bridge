(() => {
  const DEFAULT_SETTINGS = {
    enabled: true,
    apiUrl: 'http://127.0.0.1:8765/v1/speak',
    previewMaxLines: 3,
    previewMaxChars: 120,
    previewMinChars: 40,
    previewStableMs: 800,
  };

  const MIN_FALLBACK_CHARS = 20;
  const AUTO_SENT_FLAG = 'localVoiceSent';
  const stateByElement = new WeakMap();
  const initializedElements = new WeakSet();
  const audioQueue = [];

  let settings = { ...DEFAULT_SETTINGS };
  let currentAudio = null;
  let isPlaying = false;
  let enabled = true;
  let observer = null;
  let inspectTimer = null;
  let sequence = 0;

  let panel = null;
  let stateNode = null;
  let infoNode = null;
  let helperNode = null;
  let healthButton = null;
  let startButton = null;
  let stopApiButton = null;

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

    const cut = naturalCut(merged, minChars, maxChars);
    return normalizeText(cut);
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

  function setPanelState(stateText, detailText = '') {
    if (!stateNode || !infoNode) return;
    stateNode.textContent = `Local Voice: ${stateText}`;
    infoNode.textContent = detailText || `API: ${String(settings.apiUrl || DEFAULT_SETTINGS.apiUrl)}`;
  }

  function setHelper(message, isError = false) {
    if (!helperNode) return;
    helperNode.textContent = message;
    helperNode.style.color = isError ? '#ffd6d6' : '#c9ffd7';
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
        // Some environments block runtime messaging in content script; direct fetch is fallback.
      }
    }
    return postToLocalApi(text, requestId);
  }

  function enqueueAudio(url, text) {
    audioQueue.push({ url, text });
    setPanelState('起動中', `キュー: ${audioQueue.length}`);
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
        reject(new Error('audio element failed to load the generated file'));
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
      throw new Error('Web Audio API is not available');
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
      setPanelState('再生中', `再生: ${item.text.length}字`);
      const blob = await fetchAudioBlob(item.url);
      await playAudioBlob(blob);
      isPlaying = false;
      currentAudio = null;
      setPanelState('起動中', audioQueue.length ? `キュー: ${audioQueue.length}` : '待機中');
      void playNext();
    } catch (error) {
      isPlaying = false;
      currentAudio = null;
      setPanelState('エラー', `再生エラー: ${error.message || error}`);
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
    setPanelState('起動中', '停止しました');
  }

  function sendPreview(preview, key, node) {
    const requestId = `${key}-${Date.now()}-${sequence++}`.slice(0, 80);
    setPanelState('生成中', `冒頭のみ送信: ${preview.length}字`);
    node.dataset[AUTO_SENT_FLAG] = '1';
    const item = stateByElement.get(node);
    if (item) item.sent = true;

    requestSpeech(preview, requestId)
      .then((payload) => {
        const audioUrl = payload && payload.audioUrl;
        if (!audioUrl) {
          setPanelState('エラー', '音声URLがありません');
          return;
        }
        enqueueAudio(audioUrl, preview);
      })
      .catch((error) => {
        setPanelState('エラー', error.message || String(error));
      });
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
      sendPreview(preview, item.key, node);
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
        sendPreview(pendingPreview, item.key, node);
      }
    }, Number(settings.previewStableMs || DEFAULT_SETTINGS.previewStableMs) + 50);
  }

  function inspectLatestAssistant() {
    const nodes = getAssistantNodes();
    if (nodes.length === 0) return;
    const latest = nodes[nodes.length - 1];
    processNode(latest);
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
    button.style.cssText = 'font:inherit;padding:2px 8px;border-radius:6px;border:0;cursor:pointer;background:#f7f7f7;color:#111';
    button.addEventListener('click', onClick);
    return button;
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
      'font:12px/1.4 system-ui,sans-serif',
      'background:rgba(20,20,20,.9)',
      'color:#fff',
      'border-radius:10px',
      'padding:10px',
      'box-shadow:0 4px 16px rgba(0,0,0,.25)',
      'display:flex',
      'flex-direction:column',
      'gap:6px',
      'width:300px',
    ].join(';');

    stateNode = document.createElement('div');
    infoNode = document.createElement('div');
    helperNode = document.createElement('div');
    helperNode.style.fontSize = '11px';
    helperNode.style.color = '#c9ffd7';

    const controls1 = document.createElement('div');
    controls1.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';

    const controls2 = document.createElement('div');
    controls2.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';

    const toggle = createButton('Auto ON', () => {
      enabled = !enabled;
      toggle.textContent = enabled ? 'Auto ON' : 'Auto OFF';
      setPanelState(enabled ? '起動中' : '未起動', enabled ? '監視中' : '自動読み上げOFF');
      if (!enabled) stopPlayback();
    });

    const stopAudioButton = createButton('Stop Audio', stopPlayback);

    const readLatest = createButton('最新を読む', () => {
      const nodes = getAssistantNodes();
      if (!nodes.length) {
        setPanelState('エラー', 'assistant応答なし');
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
        setPanelState('エラー', '読める冒頭テキストなし');
        return;
      }
      sendPreview(preview, `manual-${Date.now()}`, latest);
    });

    healthButton = createButton('Health', async () => {
      try {
        const result = await runtimeMessage('health');
        setPanelState('起動中', `health OK (${result.engine || 'unknown'})`);
      } catch (error) {
        setPanelState('未起動', error.message || String(error));
      }
    });

    startButton = createButton('Start API', async () => {
      try {
        await runtimeMessage('native-start');
        setPanelState('起動中', 'Native host経由で起動要求を送信');
      } catch (error) {
        setPanelState('エラー', error.message || String(error));
        setHelper('Native host未設定。手動でQwen3 API起動: .\\scripts\\start-local-api.ps1', true);
      }
    });

    stopApiButton = createButton('Stop API', async () => {
      try {
        await runtimeMessage('native-stop');
        setPanelState('未起動', '停止要求を送信');
      } catch (error) {
        setPanelState('エラー', error.message || String(error));
        setHelper('手動停止: .\\scripts\\stop-local-api.ps1', true);
      }
    });

    controls1.append(toggle, stopAudioButton, readLatest);
    controls2.append(healthButton, startButton, stopApiButton);

    panel.append(stateNode, infoNode, controls1, controls2, helperNode);
    document.documentElement.appendChild(panel);

    setPanelState('起動中', `API: ${String(settings.apiUrl || DEFAULT_SETTINGS.apiUrl)}`);
    setHelper('読み上げ対象: 冒頭previewのみ（最大3行/120字, Qwen3/ComfyUI）');
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

  async function probeNativeStatus() {
    try {
      const result = await runtimeMessage('native-status');
      if (result && result.running) {
        setPanelState('起動中', 'Native host OK / API起動中');
      } else {
        setPanelState('未起動', 'Native host OK / API未起動');
      }
      return;
    } catch (_error) {
      setHelper('Native host未設定。手動起動または docs/startup.md を参照。', true);
    }

    try {
      await runtimeMessage('health');
      setPanelState('起動中', '手動起動APIに接続済み');
    } catch (_error) {
      setPanelState('未起動', 'API未起動');
    }
  }

  async function start() {
    await loadSettings();
    createPanel();
    markExistingMessagesAsSeen();
    await probeNativeStatus();
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
      if (panel) {
        setPanelState(enabled ? '起動中' : '未起動', `API: ${String(settings.apiUrl || DEFAULT_SETTINGS.apiUrl)}`);
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
