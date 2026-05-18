/* eslint-disable no-console */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const MOCK_HOST = '127.0.0.1';
const MOCK_PORT = 8717;
const MOCK_BASE = `http://${MOCK_HOST}:${MOCK_PORT}`;

const TINY_WAV_BASE64 =
  'UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
const TINY_WAV = Buffer.from(TINY_WAV_BASE64, 'base64');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeFakeChatGptHtml(pathname) {
  const tabName = pathname.includes('tab2') ? 'Fake ChatGPT Tab 2' : 'Fake ChatGPT Tab 1';
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${tabName}</title>
    <style>
      body { font-family: sans-serif; margin: 16px; }
      .turn { margin: 8px 0; border: 1px solid #ddd; padding: 8px; border-radius: 6px; }
      .assistant { white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h1>${tabName}</h1>
    <div id="app"></div>
  </body>
</html>`;
}

function createMockLocalApiServer() {
  const state = {
    healthCalls: 0,
    speakTotal: 0,
    speakByVoiceProfile: {},
    speakRequests: [],
    audioHits: 0,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', MOCK_BASE);

    if (req.method === 'GET' && url.pathname === '/health') {
      state.healthCalls += 1;
      const payload = {
        ok: true,
        engine: 'comfyui_workflow',
        defaultVoiceProfile: 'irodori-v2',
        availableVoiceProfiles: [
          { id: 'irodori-v2', label: 'Irodori v2' },
          { id: 'irodori-v3', label: 'Irodori v3' },
        ],
      };
      const body = Buffer.from(JSON.stringify(payload), 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(body.length),
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/speak') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let parsed = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        } catch (_error) {
          parsed = {};
        }
        state.speakTotal += 1;
        const voiceProfile = String(parsed.voiceProfile || 'irodori-v2');
        state.speakByVoiceProfile[voiceProfile] = (state.speakByVoiceProfile[voiceProfile] || 0) + 1;
        const requestId = String(parsed.requestId || `mock-${state.speakTotal}`);
        const audioUrl = `${MOCK_BASE}/audio/mock-${state.speakTotal}.wav`;
        state.speakRequests.push({
          at: new Date().toISOString(),
          requestId,
          source: String(parsed.source || ''),
          text: String(parsed.text || ''),
          voiceProfile,
          audioUrl,
        });
        const payload = {
          ok: true,
          engine: 'comfyui_workflow',
          requestId,
          voiceProfile,
          audioUrl,
          textLength: String(parsed.text || '').length,
        };
        const body = Buffer.from(JSON.stringify(payload), 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(body.length),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(body);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
      state.audioHits += 1;
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': String(TINY_WAV.length),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(TINY_WAV);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });

  return {
    state,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(MOCK_PORT, MOCK_HOST, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitFor(fn, timeoutMs, stepMs, label) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(stepMs);
  }
  throw new Error(`Timeout waiting for ${label}`);
}

async function sendRuntimeMessage(runtimePage, message) {
  return runtimePage.evaluate((msg) => new Promise((resolve, reject) => {
    if (!window.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
      reject(new Error('chrome.runtime.sendMessage unavailable'));
      return;
    }
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.ok) {
        reject(new Error((response && response.error) || 'runtime message failed'));
        return;
      }
      resolve(response.payload);
    });
  }), message);
}

async function getDebugState(runtimePage) {
  return sendRuntimeMessage(runtimePage, { type: 'debug-get-state' });
}

async function clickByTestId(page, testId) {
  await page.locator(`[data-testid="${testId}"]`).click();
}

async function setSelectByTestId(page, testId, value) {
  await page.selectOption(`[data-testid="${testId}"]`, value);
}

async function setAuto(page, enabled) {
  const current = await page.evaluate(() => new Promise((resolve) => {
    if (!window.chrome || !chrome.storage || !chrome.storage.local) {
      resolve(false);
      return;
    }
    chrome.storage.local.get(['enabled'], (value) => resolve(Boolean(value.enabled)));
  }));
  if (Boolean(current) !== Boolean(enabled)) {
    await clickByTestId(page, 'local-voice-auto');
    await sleep(150);
  }
}

async function addAssistantMessage(page, messageKey, text) {
  await page.evaluate(({ key, bodyText }) => {
    const app = document.getElementById('app') || document.body;
    let node = document.querySelector(`[data-message-id="${key}"]`);
    if (!node) {
      const turnCount = document.querySelectorAll('[data-testid^="conversation-turn-"]').length;
      const turn = document.createElement('div');
      turn.className = 'turn';
      turn.setAttribute('data-testid', `conversation-turn-${turnCount + 1}`);
      node = document.createElement('div');
      node.className = 'assistant';
      node.setAttribute('data-message-author-role', 'assistant');
      node.setAttribute('data-message-id', key);
      turn.appendChild(node);
      app.appendChild(turn);
    }
    node.textContent = bodyText;
  }, { key: messageKey, bodyText: text });
}

async function getOwnerPage(page1, page2) {
  return waitFor(async () => {
    const v1 = await page1.locator('#local-voice-bridge-panel').isVisible().catch(() => false);
    const v2 = await page2.locator('#local-voice-bridge-panel').isVisible().catch(() => false);
    if (v1 && !v2) return page1;
    if (v2 && !v1) return page2;
    return null;
  }, 60000, 200, 'single owner panel visible');
}

async function forceDoneOnce(runtimePage) {
  await sendRuntimeMessage(runtimePage, { type: 'debug-force-playback-done' }).catch(() => {});
}

async function waitForPlaybackStart(runtimePage) {
  return waitFor(async () => {
    const state = await getDebugState(runtimePage);
    if (state.state.isPlaying && state.state.currentPlayingItem) return state;
    return null;
  }, 120000, 100, 'playback start');
}

async function drainPlayback(runtimePage) {
  await waitFor(async () => {
    const state = await getDebugState(runtimePage);
    if (!state.state.isPlaying && state.state.queueSize === 0) return state;
    if (state.state.isPlaying && state.state.currentPlayingItem && state.state.currentPlayingItem.audioUrl) {
      await forceDoneOnce(runtimePage);
    }
    return null;
  }, 120000, 100, 'queue drain');
}

async function waitForLastPlayedChunk(runtimePage, messageKey, chunkIndex, label) {
  return waitFor(async () => {
    const st = await getDebugState(runtimePage);
    const item = st.state.lastPlayedItem;
    if (item && String(item.messageKey) === String(messageKey) && Number(item.chunkIndex) === Number(chunkIndex)) {
      return st;
    }
    return null;
  }, 120000, 100, label);
}

async function waitForOwnerContentState(runtimePage, predicate, label) {
  return waitFor(async () => {
    const state = await sendRuntimeMessage(runtimePage, { type: 'debug-get-owner-content-state' }).catch(() => null);
    if (!state) return null;
    return predicate(state) ? state : null;
  }, 120000, 100, label);
}

async function run() {
  const mockServer = createMockLocalApiServer();
  await mockServer.start();

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvb-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  });

  const cleanup = async () => {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    await mockServer.stop();
  };

  try {
    await context.addInitScript(() => {
      window.__audioMetrics = {
        playCount: 0,
        elementVolumes: [],
        gainVolumes: [],
        forceAudioError: false,
      };

      class FakeAudio {
        constructor(_url) {
          this.volume = 1;
          this.currentTime = 0;
          this.onended = null;
          this.onerror = null;
        }
        play() {
          window.__audioMetrics.playCount += 1;
          window.__audioMetrics.elementVolumes.push(Number(this.volume));
          if (window.__audioMetrics.forceAudioError) {
            window.__audioMetrics.forceAudioError = false;
            return Promise.reject(new Error('forced audio element failure'));
          }
          setTimeout(() => {
            if (typeof this.onended === 'function') this.onended();
          }, 30);
          return Promise.resolve();
        }
        pause() {}
      }
      window.Audio = FakeAudio;

      class FakeAudioContext {
        constructor() {
          this.state = 'running';
          this.destination = {};
        }
        resume() {
          return Promise.resolve();
        }
        close() {
          return Promise.resolve();
        }
        decodeAudioData() {
          return Promise.resolve({});
        }
        createGain() {
          return {
            gain: { value: 1 },
            connect() {},
          };
        }
        createBufferSource() {
          return {
            _gain: null,
            onended: null,
            connect(node) {
              this._gain = node;
            },
            start() {
              const gain = this._gain && this._gain.gain ? Number(this._gain.gain.value) : 1;
              window.__audioMetrics.gainVolumes.push(gain);
              setTimeout(() => {
                if (typeof this.onended === 'function') this.onended();
              }, 30);
            },
            stop() {},
          };
        }
      }
      window.AudioContext = FakeAudioContext;
      window.webkitAudioContext = FakeAudioContext;
    });

    await context.route('https://chatgpt.com/**', async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: makeFakeChatGptHtml(url.pathname),
      });
    });

    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(sw.url()).host;
    const runtimePage = await context.newPage();
    await runtimePage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await runtimePage.evaluate((base) => new Promise((resolve) => {
      chrome.storage.local.set({
        enabled: false,
        apiUrl: `${base}/v1/speak`,
        healthUrl: `${base}/health`,
        voiceProfile: 'irodori-v2',
        voiceVolume: 0.6,
        panelCollapsed: false,
      }, resolve);
    }), MOCK_BASE);

    const page1 = await context.newPage();
    await page1.goto('https://chatgpt.com/tab1', { waitUntil: 'domcontentloaded' });
    const page2 = await context.newPage();
    await page2.goto('https://chatgpt.com/tab2', { waitUntil: 'domcontentloaded' });

    const registered = await waitFor(async () => {
      const st = await getDebugState(runtimePage);
      return st.tabs.length === 2 ? st : null;
    }, 120000, 200, 'two tabs registered');

    const ownerPage = await getOwnerPage(page1, page2);
    const otherPage = ownerPage === page1 ? page2 : page1;
    const simulatedPlaybackResult = await sendRuntimeMessage(runtimePage, {
      type: 'debug-set-owner-playback-simulated',
      enabled: true,
    });
    assert(simulatedPlaybackResult && simulatedPlaybackResult.enabled === true, 'failed to enable simulated playback mode');
    const autoInitiallyEnabled = await runtimePage.evaluate(() => new Promise((resolve) => {
      chrome.storage.local.get(['enabled'], (value) => resolve(Boolean(value.enabled)));
    }));
    const tabValues = await ownerPage.$$eval('[data-testid="local-voice-tab"] option', (nodes) => nodes.map((n) => String(n.value)));
    assert(tabValues.length === 2, `expected 2 tab options, got ${tabValues.length}`);
    const profileValues = await ownerPage.$$eval('[data-testid="local-voice-profile"] option', (nodes) => nodes.map((n) => String(n.value)));
    assert(profileValues.includes('irodori-v2') && profileValues.includes('irodori-v3'), 'voice profile options should include irodori-v2 and irodori-v3');
    const ownerTabId = String(await ownerPage.$eval('[data-testid="local-voice-tab"]', (el) => el.value));
    const otherTabId = tabValues.find((id) => id !== ownerTabId);
    assert(Boolean(otherTabId), 'other tab id missing');

    // A. health/profile initial check
    assert(mockServer.state.healthCalls >= 1, 'health should be called at least once');
    assert(!autoInitiallyEnabled, 'Auto should be initially OFF in this test');

    // B. Auto
    await setAuto(ownerPage, true);
    await addAssistantMessage(otherPage, 'auto-key-1', [
      'auto chunk sentence one for fake page',
      'auto chunk sentence two for fake page',
      'auto chunk sentence three for fake page',
    ].join('\n'));
    const autoStarted = await waitForPlaybackStart(runtimePage);
    assert(String(autoStarted.state.currentPlayingItem.mode) === 'auto', 'auto mode should start playback');
    assert(String(autoStarted.state.currentPlayingItem.tabId) === otherTabId, 'auto should target reporting tab, not selected tab');
    await drainPlayback(runtimePage);
    const afterAuto = await getDebugState(runtimePage);
    assert(afterAuto.debugStats.speakCallsByReason.auto === 1, 'auto speak should be exactly 1');
    assert(Number(afterAuto.state.lastPlayedItem.chunkIndex) === 0, 'auto should play chunk0');
    await addAssistantMessage(otherPage, 'auto-key-1', 'same key mutated should not enqueue duplicate');
    await sleep(1200);
    const afterAutoDup = await getDebugState(runtimePage);
    assert(afterAutoDup.debugStats.speakCallsByReason.auto === 1, 'auto duplicate with same messageKey should not call speak again');

    // C. Read
    await setAuto(ownerPage, false);
    await setSelectByTestId(ownerPage, 'local-voice-tab', ownerTabId);
    await addAssistantMessage(ownerPage, 'manual-key-1', [
      'read/next target line one alpha',
      'read/next target line two beta',
      'read/next target line three gamma',
      'read/next target line four delta',
      'read/next target line five epsilon',
      'read/next target line six zeta',
    ].join('\n'));
    await waitFor(async () => {
      const st = await getDebugState(runtimePage);
      const tab = st.tabs.find((t) => String(t.id) === ownerTabId);
      return tab && tab.messageKey === 'manual-key-1' && tab.chunkCount >= 3 ? st : null;
    }, 120000, 200, 'manual chunks reported');
    const speakBeforeRead = (await getDebugState(runtimePage)).debugStats.speakCalls;
    await clickByTestId(ownerPage, 'local-voice-read');
    await waitForPlaybackStart(runtimePage);
    await drainPlayback(runtimePage);
    const afterRead = await waitForLastPlayedChunk(runtimePage, 'manual-key-1', 0, 'read chunk0');
    assert(afterRead.state.lastPlayedItem && Number(afterRead.state.lastPlayedItem.chunkIndex) === 0, 'Read should play chunk0');
    assert(afterRead.debugStats.speakCalls >= speakBeforeRead, 'Read should affect playback path');

    // D. Next
    await clickByTestId(ownerPage, 'local-voice-next');
    await waitForPlaybackStart(runtimePage);
    await drainPlayback(runtimePage);
    const afterNext1 = await waitForLastPlayedChunk(runtimePage, 'manual-key-1', 1, 'next chunk1').catch(async (error) => {
      const dbg = await getDebugState(runtimePage);
      console.log('NEXT1_DEBUG', JSON.stringify(dbg, null, 2));
      throw error;
    });
    assert(Number(afterNext1.state.lastPlayedItem.chunkIndex) === 1, 'Next should move to chunk1');
    await clickByTestId(ownerPage, 'local-voice-next');
    await waitForPlaybackStart(runtimePage);
    await drainPlayback(runtimePage);
    const afterNext2 = await waitForLastPlayedChunk(runtimePage, 'manual-key-1', 2, 'next chunk2');
    assert(Number(afterNext2.state.lastPlayedItem.chunkIndex) === 2, 'Next should move to chunk2');
    const speakBeforeNoMore = afterNext2.debugStats.speakCalls;
    for (let i = 0; i < 6; i += 1) {
      await clickByTestId(ownerPage, 'local-voice-next');
      await sleep(100);
    }
    await sleep(300);
    const afterNoMore = await getDebugState(runtimePage);
    assert(afterNoMore.debugStats.speakCalls >= speakBeforeNoMore, 'Next end should not break state');

    // E. Regen
    const beforeRegen = await getDebugState(runtimePage);
    await clickByTestId(ownerPage, 'local-voice-regen');
    await waitForPlaybackStart(runtimePage);
    await drainPlayback(runtimePage);
    const afterRegen = await getDebugState(runtimePage);
    assert((afterRegen.debugStats.speakCallsByReason.regen || 0) > (beforeRegen.debugStats.speakCallsByReason.regen || 0), 'Regen should call speak');
    const regenEvents = afterRegen.debugStats.speakEvents.filter((e) => e.reason === 'regen' && e.type === 'speak');
    assert(regenEvents.length >= 1, 'Regen speak event missing');

    // F. Replay
    const replaySpeakBefore = afterRegen.debugStats.speakCalls;
    const replayCountBefore = afterRegen.debugStats.replayCalls;
    await clickByTestId(ownerPage, 'local-voice-replay');
    await waitForPlaybackStart(runtimePage);
    await drainPlayback(runtimePage);
    const afterReplay = await getDebugState(runtimePage);
    assert(afterReplay.debugStats.speakCalls === replaySpeakBefore, 'Replay should not call /v1/speak');
    assert(afterReplay.debugStats.replayCalls === replayCountBefore + 1, 'Replay count should increment');

    // G. Skip
    await clickByTestId(ownerPage, 'local-voice-read');
    await clickByTestId(ownerPage, 'local-voice-next');
    const beforeSkip = await waitFor(async () => {
      const st = await getDebugState(runtimePage);
      return st.state.isPlaying && st.state.queueSize >= 1 ? st : null;
    }, 120000, 100, 'skip precondition');
    const playingBeforeSkip = beforeSkip.state.currentPlayingItem;
    await clickByTestId(ownerPage, 'local-voice-skip');
    const afterSkipStart = await waitFor(async () => {
      const st = await getDebugState(runtimePage);
      return st.state.isPlaying ? st : null;
    }, 120000, 100, 'skip next start');
    assert(afterSkipStart.state.currentPlayingItem.id !== playingBeforeSkip.id, 'Skip should move to next queue item');
    await drainPlayback(runtimePage);

    // H. Stop + stale playback done
    await clickByTestId(ownerPage, 'local-voice-read');
    await clickByTestId(ownerPage, 'local-voice-next');
    const stopPre = await waitFor(async () => {
      const st = await getDebugState(runtimePage);
      return st.state.isPlaying ? st : null;
    }, 120000, 100, 'stop precondition');
    const staleToken = String(stopPre.currentPlaybackToken || '');
    await clickByTestId(ownerPage, 'local-voice-stop');
    const afterStop = await waitFor(async () => {
      const st = await getDebugState(runtimePage);
      return !st.state.isPlaying && st.state.queueSize === 0 ? st : null;
    }, 120000, 100, 'stop result');
    assert(afterStop.state.queueSize === 0 && !afterStop.state.isPlaying, 'Stop should clear queue and stop playback');
    if (staleToken) {
      await sendRuntimeMessage(runtimePage, {
        type: 'playback-done',
        playbackToken: staleToken,
        ok: true,
        stopped: false,
      });
      await sleep(200);
      const staleAfter = await getDebugState(runtimePage);
      assert(!staleAfter.state.isPlaying && staleAfter.state.queueSize === 0, 'stale playback-done after Stop must not resume playback');
    }
    await addAssistantMessage(ownerPage, 'auto-after-stop', 'auto after stop should still work');
    await setAuto(ownerPage, true);
    await waitForPlaybackStart(runtimePage);
    await drainPlayback(runtimePage);
    await setAuto(ownerPage, false);

    // I. Voice switch
    await setSelectByTestId(ownerPage, 'local-voice-profile', 'irodori-v3');
    const beforeV3 = await getDebugState(runtimePage);
    await clickByTestId(ownerPage, 'local-voice-regen');
    await waitForPlaybackStart(runtimePage);
    await drainPlayback(runtimePage);
    const afterV3 = await getDebugState(runtimePage);
    assert(afterV3.debugStats.speakCalls > beforeV3.debugStats.speakCalls, 'voice v3 regen should call speak');
    const lastSpeakEvent = [...afterV3.debugStats.speakEvents].reverse().find((e) => e.type === 'speak');
    assert(lastSpeakEvent && lastSpeakEvent.voiceProfile === 'irodori-v3', 'voiceProfile should be irodori-v3');
    await setSelectByTestId(ownerPage, 'local-voice-profile', 'irodori-v2');
    const replaySpeakBeforeV2 = afterV3.debugStats.speakCalls;
    await clickByTestId(ownerPage, 'local-voice-replay');
    await waitForPlaybackStart(runtimePage);
    await drainPlayback(runtimePage);
    const afterReplayV2 = await getDebugState(runtimePage);
    assert(afterReplayV2.debugStats.speakCalls === replaySpeakBeforeV2, 'Replay after voice switch must not call speak');

    // J. Volume
    await ownerPage.fill('[data-testid="local-voice-volume"]', '35');
    await ownerPage.dispatchEvent('[data-testid="local-voice-volume"]', 'change');
    await clickByTestId(ownerPage, 'local-voice-read');
    await waitForPlaybackStart(runtimePage);
    const elementVolumeState = await waitForOwnerContentState(runtimePage, (state) => (
      state.lastElementVolumeApplied !== null
      && Math.abs(Number(state.lastElementVolumeApplied) - 0.35) < 0.02
    ), 'owner element volume applied').catch(async (error) => {
      const ownerState = await sendRuntimeMessage(runtimePage, { type: 'debug-get-owner-content-state' }).catch(() => null);
      const bgState = await getDebugState(runtimePage).catch(() => null);
      console.log('VOLUME_ELEMENT_DEBUG', JSON.stringify({ ownerState, bgState }, null, 2));
      throw error;
    });
    await forceDoneOnce(runtimePage);
    await drainPlayback(runtimePage);
    assert(
      Math.abs(Number(elementVolumeState.lastElementVolumeApplied) - 0.35) < 0.02,
      `audio element volume should be ~0.35, got ${elementVolumeState.lastElementVolumeApplied}`
    );
    await sendRuntimeMessage(runtimePage, { type: 'debug-force-owner-web-audio-next' });
    await clickByTestId(ownerPage, 'local-voice-read');
    await waitForPlaybackStart(runtimePage);
    const gainVolumeState = await waitForOwnerContentState(runtimePage, (state) => (
      state.lastGainVolumeApplied !== null
      && Math.abs(Number(state.lastGainVolumeApplied) - 0.35) < 0.02
    ), 'owner gain volume applied');
    await forceDoneOnce(runtimePage);
    await drainPlayback(runtimePage);
    assert(
      Math.abs(Number(gainVolumeState.lastGainVolumeApplied) - 0.35) < 0.02,
      `web audio gain volume should be ~0.35, got ${gainVolumeState.lastGainVolumeApplied}`
    );

    // K. multi-tab behavior and cleanup
    await setSelectByTestId(ownerPage, 'local-voice-tab', otherTabId);
    await addAssistantMessage(otherPage, 'tab2-manual', [
      'tab2 manual line one',
      'tab2 manual line two',
      'tab2 manual line three',
    ].join('\n'));
    await waitFor(async () => {
      const st = await getDebugState(runtimePage);
      const tab = st.tabs.find((t) => String(t.id) === otherTabId);
      return tab && tab.messageKey === 'tab2-manual' ? st : null;
    }, 120000, 200, 'tab2 report');
    await clickByTestId(ownerPage, 'local-voice-read');
    await waitForPlaybackStart(runtimePage);
    await drainPlayback(runtimePage);
    const tab2Read = await getDebugState(runtimePage);
    assert(String(tab2Read.state.lastPlayedItem.tabId) === otherTabId, 'selectedTab should redirect manual Read target');
    await setSelectByTestId(ownerPage, 'local-voice-tab', ownerTabId);
    await setAuto(ownerPage, true);
    await addAssistantMessage(otherPage, 'auto-tab2-independent', 'auto should follow reporter tab');
    await waitForPlaybackStart(runtimePage);
    await drainPlayback(runtimePage);
    const autoIndependent = await getDebugState(runtimePage);
    assert(String(autoIndependent.state.lastPlayedItem.tabId) === otherTabId, 'Auto must be independent from selectedTab');
    await setAuto(ownerPage, false);

    // close tab2 and verify cleanup
    await otherPage.close();
    const afterClose = await waitFor(async () => {
      const st = await getDebugState(runtimePage);
      return st.tabs.length === 1 ? st : null;
    }, 120000, 200, 'tab cleanup after close');
    assert(afterClose.tabs.length === 1, 'tabRegistry should cleanup closed tab');
    assert(afterClose.queue.every((item) => String(item.tabId) !== otherTabId), 'queue should not retain closed tab items');

    const replaySpeakAfter = afterReplay.debugStats.speakCalls;
    const replaySpeakDiff = replaySpeakAfter - replaySpeakBefore;
    assert(replaySpeakDiff === 0, `Replay speak diff should be 0, got ${replaySpeakDiff}`);
    const firstAudioUrl = mockServer.state.speakRequests[0] && mockServer.state.speakRequests[0].audioUrl;
    assert(Boolean(firstAudioUrl), 'mock /v1/speak did not return audioUrl');
    const audioResponse = await fetch(firstAudioUrl);
    assert(audioResponse.ok, `mock audioUrl is not retrievable: ${audioResponse.status}`);
    const audioBytes = Buffer.from(await audioResponse.arrayBuffer());
    assert(audioBytes.length > 0, 'mock audio response is empty');

    const summary = {
      ok: true,
      autoInitiallyEnabled,
      mockApi: {
        healthCalls: mockServer.state.healthCalls,
        speakTotal: mockServer.state.speakTotal,
        speakByVoiceProfile: mockServer.state.speakByVoiceProfile,
        audioHits: mockServer.state.audioHits,
      },
      speakCalls: afterClose.debugStats.speakCalls,
      speakCallsByReason: afterClose.debugStats.speakCallsByReason,
      replayCalls: afterClose.debugStats.replayCalls,
      replaySpeakBefore,
      replaySpeakAfter,
      replaySpeakDiff,
      queueSizeFinal: afterClose.state.queueSize,
      isPlayingFinal: afterClose.state.isPlaying,
      tabsCountFinal: afterClose.tabs.length,
      lastPlayedItem: afterClose.state.lastPlayedItem,
      selectedTabId: afterClose.state.selectedTabId,
      uiOwnerTabId: afterClose.state.uiOwnerTabId,
      mockSpeakRequestsTail: mockServer.state.speakRequests.slice(-10),
    };

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await cleanup();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
