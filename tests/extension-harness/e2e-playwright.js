/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs, stepMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(stepMs);
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

async function sendRuntimeMessage(runtimePage, message) {
  return runtimePage.evaluate((msg) => new Promise((resolve, reject) => {
    if (!window.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
      reject(new Error('chrome.runtime.sendMessage is unavailable'));
      return;
    }
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.ok) {
        reject(new Error((response && response.error) || 'unknown runtime error'));
        return;
      }
      resolve(response.payload);
    });
  }), message);
}

async function getDebugState(runtimePage) {
  return sendRuntimeMessage(runtimePage, { type: 'debug-get-state' });
}

async function addAssistantMessage(page, key, text) {
  await page.evaluate(({ messageKey, messageText }) => {
    let node = document.querySelector(`[data-message-id="${messageKey}"]`);
    if (!node) {
      node = document.createElement('div');
      node.setAttribute('data-message-author-role', 'assistant');
      node.setAttribute('data-message-id', messageKey);
      document.body.appendChild(node);
    }
    node.textContent = messageText;
  }, { messageKey: key, messageText: text });
}

async function clickPanelButton(page, label) {
  await page.locator('#local-voice-bridge-panel button', { hasText: label }).click();
}

async function setSelectedTab(page, tabId) {
  await waitFor(async () => {
    const values = await page.$$eval('#local-voice-tab-select option', (nodes) => nodes.map((n) => n.value));
    return values.includes(String(tabId));
  }, 30000, 200, `tab option ${tabId}`);
  await page.selectOption('#local-voice-tab-select', String(tabId));
}

async function setAuto(page, enabled) {
  const button = page.locator('#local-voice-bridge-panel button', { hasText: 'Auto' });
  const style = await button.evaluate((el) => el.style.background || '');
  const isOn = String(style).includes('73, 168, 113') || String(style).includes('73,168,113');
  if ((enabled && !isOn) || (!enabled && isOn)) {
    await button.click();
    await sleep(300);
  }
}

async function maybeForcePlaybackDone(runtimePage, debugState) {
  if (
    debugState
    && debugState.state
    && debugState.state.isPlaying
    && debugState.state.currentPlayingItem
    && debugState.state.currentPlayingItem.audioUrl
  ) {
    await sendRuntimeMessage(runtimePage, { type: 'debug-force-playback-done' }).catch(() => {});
    await sleep(250);
  }
}

async function waitForLastPlayed(runtimePage, matcher, label, timeoutMs = 180000) {
  return waitFor(async () => {
    const now = await getDebugState(runtimePage);
    await maybeForcePlaybackDone(runtimePage, now);
    const refreshed = await getDebugState(runtimePage);
    return matcher(refreshed) ? refreshed : null;
  }, timeoutMs, 500, label);
}

async function main() {
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
  };

  try {
    await context.addInitScript(() => {
      window.__audioMetrics = {
        playCount: 0,
        elementVolumes: [],
        gainVolumes: [],
        forceAudioError: false,
        playDurationMs: 400,
      };

      class FakeAudio {
        constructor(url) {
          this.url = url;
          this.currentTime = 0;
          this.volume = 1;
          this.onended = null;
          this.onerror = null;
          this._timer = null;
          this._paused = false;
        }
        play() {
          window.__audioMetrics.playCount += 1;
          window.__audioMetrics.elementVolumes.push(this.volume);
          if (window.__audioMetrics.forceAudioError) {
            window.__audioMetrics.forceAudioError = false;
            return Promise.reject(new Error('forced audio element failure'));
          }
          this._paused = false;
          this._timer = setTimeout(() => {
            if (!this._paused && typeof this.onended === 'function') {
              this.onended();
            }
          }, Number(window.__audioMetrics.playDurationMs || 300));
          return Promise.resolve();
        }
        pause() {
          this._paused = true;
          if (this._timer) clearTimeout(this._timer);
          this._timer = null;
        }
      }
      window.Audio = FakeAudio;

      class FakeAudioContext {
        constructor() {
          this.state = 'running';
          this.destination = {};
        }
        resume() {
          this.state = 'running';
          return Promise.resolve();
        }
        close() {
          this.state = 'closed';
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
            buffer: null,
            onended: null,
            _gainNode: null,
            connect(node) {
              this._gainNode = node;
            },
            start() {
              const gainValue = this._gainNode && this._gainNode.gain ? Number(this._gainNode.gain.value) : 1;
              window.__audioMetrics.gainVolumes.push(gainValue);
              setTimeout(() => {
                if (typeof this.onended === 'function') this.onended();
              }, Number(window.__audioMetrics.playDurationMs || 300));
            },
            stop() {},
          };
        }
      }
      window.AudioContext = FakeAudioContext;
      window.webkitAudioContext = FakeAudioContext;
    });

    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(sw.url()).host;
    const runtimePage = await context.newPage();
    await runtimePage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await runtimePage.evaluate(() => chrome.storage.local.set({
      enabled: false,
      voiceProfile: 'irodori-v2',
      voiceVolume: 0.6,
      panelCollapsed: false,
    }));

    const page1 = await context.newPage();
    await page1.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    const page2 = await context.newPage();
    await page2.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    await page1.evaluate(() => { document.title = 'Harness Tab 1'; });
    await page2.evaluate(() => { document.title = 'Harness Tab 2'; });
    await sleep(6500);

    await waitFor(async () => {
      const state = await getDebugState(runtimePage);
      return state && state.tabs && state.tabs.length === 2 ? state : null;
    }, 120000, 300, '2 tabs registered');

    await waitFor(async () => {
      const panelCount = await page1.locator('#local-voice-bridge-panel').count();
      return panelCount > 0;
    }, 60000, 300, 'panel injected');

    await runtimePage.evaluate(() => chrome.storage.local.set({
      enabled: false,
      voiceProfile: 'irodori-v2',
      voiceVolume: 0.6,
    }));
    await sleep(500);

    let state = await getDebugState(runtimePage);
    const ownerIndex = await waitFor(async () => {
      const panel1Visible = await page1.locator('#local-voice-bridge-panel').isVisible().catch(() => false);
      const panel2Visible = await page2.locator('#local-voice-bridge-panel').isVisible().catch(() => false);
      if (panel1Visible) return 1;
      if (panel2Visible) return 2;
      return null;
    }, 60000, 300, 'owner panel visible');
    const ownerPage = ownerIndex === 1 ? page1 : page2;
    const otherPage = ownerPage === page1 ? page2 : page1;
    const tabValues = await ownerPage.$$eval('#local-voice-tab-select option', (nodes) => nodes.map((node) => Number(node.value)));
    if (tabValues.length < 2) {
      throw new Error(`Expected at least 2 tab options, got ${tabValues.length}`);
    }
    const ownerTabId = Number(await ownerPage.$eval('#local-voice-tab-select', (el) => Number(el.value)));
    const otherTabId = tabValues.find((id) => id !== ownerTabId);

    await setSelectedTab(ownerPage, ownerTabId);
    await setAuto(ownerPage, true);

    const autoText = [
      'Auto test line one with enough text.',
      'Auto test line two with enough text.',
      'Auto test line three with enough text.',
    ].join('\n');
    await addAssistantMessage(otherPage, 'auto-other-1', autoText);

    let speakTarget = state.debugStats.speakCalls + 1;
    await waitFor(async () => {
      const now = await getDebugState(runtimePage);
      return now.debugStats.speakCalls >= speakTarget ? now : null;
    }, 180000, 500, 'auto speak call');
    await waitFor(async () => {
      const now = await getDebugState(runtimePage);
      await maybeForcePlaybackDone(runtimePage, now);
      const refreshed = await getDebugState(runtimePage);
      return !refreshed.state.isPlaying ? refreshed : null;
    }, 120000, 500, 'auto playback drain');

    state = await getDebugState(runtimePage);
    const afterAutoSpeak = state.debugStats.speakCalls;
    await addAssistantMessage(otherPage, 'auto-other-1', `${autoText} mutation`);
    await sleep(2200);
    state = await getDebugState(runtimePage);
    if (state.debugStats.speakCalls !== afterAutoSpeak) {
      throw new Error('Auto duplicate should not enqueue the same message key chunk0 twice');
    }

    await setAuto(ownerPage, false);
    await setSelectedTab(ownerPage, ownerTabId);

    const manualText = [
      'Chunk alpha line one with descriptive content and punctuation.',
      'Chunk alpha line two continues to keep this long enough.',
      'Chunk beta line one with additional details and wording.',
      'Chunk beta line two extends this response beyond one chunk.',
      'Chunk gamma line one introduces the final chunk of text.',
      'Chunk gamma line two finishes the assistant response cleanly.',
    ].join('\n');
    await addAssistantMessage(ownerPage, 'manual-owner-1', manualText);

    await waitFor(async () => {
      const now = await getDebugState(runtimePage);
      const tab = now.tabs.find((item) => item.id === ownerTabId);
      return tab && tab.messageKey === 'manual-owner-1' && tab.chunkCount >= 3 ? now : null;
    }, 120000, 300, 'manual chunk reporting');

    state = await getDebugState(runtimePage);
    let speakBaseline = state.debugStats.speakCalls;

    await clickPanelButton(ownerPage, 'Read');
    await waitForLastPlayed(runtimePage, (now) => (
      now.state.lastPlayedItem
      && now.state.lastPlayedItem.messageKey === 'manual-owner-1'
      && Number(now.state.lastPlayedItem.chunkIndex) === 0
    ), 'Read chunk0 played').catch(async (error) => {
      const debugNow = await getDebugState(runtimePage);
      console.log('READ_DEBUG_STATE', JSON.stringify(debugNow, null, 2));
      throw error;
    });
    state = await getDebugState(runtimePage);
    speakBaseline = state.debugStats.speakCalls;

    await clickPanelButton(ownerPage, 'Next');
    await waitForLastPlayed(runtimePage, (now) => (
      now.state.lastPlayedItem
      && now.state.lastPlayedItem.messageKey === 'manual-owner-1'
      && Number(now.state.lastPlayedItem.chunkIndex) === 1
    ), 'Next chunk1 played');
    state = await getDebugState(runtimePage);
    speakBaseline = state.debugStats.speakCalls;

    await clickPanelButton(ownerPage, 'Next');
    await waitForLastPlayed(runtimePage, (now) => (
      now.state.lastPlayedItem
      && now.state.lastPlayedItem.messageKey === 'manual-owner-1'
      && Number(now.state.lastPlayedItem.chunkIndex) === 2
    ), 'Next chunk2 played');
    state = await getDebugState(runtimePage);
    speakBaseline = state.debugStats.speakCalls;

    await clickPanelButton(ownerPage, 'Next');
    await sleep(1200);
    state = await getDebugState(runtimePage);
    if (state.debugStats.speakCalls !== speakBaseline) {
      throw new Error('Next at end should not call speak');
    }

    await clickPanelButton(ownerPage, 'Regen');
    await waitFor(async () => {
      const now = await getDebugState(runtimePage);
      await maybeForcePlaybackDone(runtimePage, now);
      return now.debugStats.speakCalls > speakBaseline ? now : null;
    }, 180000, 500, 'Regen speak');
    state = await getDebugState(runtimePage);
    speakBaseline = state.debugStats.speakCalls;

    const replayBefore = state.debugStats.replayCalls;
    await clickPanelButton(ownerPage, 'Replay');
    await waitFor(async () => {
      const now = await getDebugState(runtimePage);
      await maybeForcePlaybackDone(runtimePage, now);
      const refreshed = await getDebugState(runtimePage);
      return !refreshed.state.isPlaying ? refreshed : null;
    }, 120000, 500, 'Replay completion');
    state = await getDebugState(runtimePage);
    if (state.debugStats.speakCalls !== speakBaseline) {
      throw new Error('Replay should not call speak');
    }
    if (state.debugStats.replayCalls <= replayBefore) {
      throw new Error('Replay command did not increment replay counter');
    }

    await ownerPage.fill('#local-voice-volume-slider', '35');
    await ownerPage.dispatchEvent('#local-voice-volume-slider', 'change');
    await sleep(500);
    await clickPanelButton(ownerPage, 'Read');
    await waitFor(async () => {
      const now = await getDebugState(runtimePage);
      await maybeForcePlaybackDone(runtimePage, now);
      const refreshed = await getDebugState(runtimePage);
      return !refreshed.state.isPlaying ? refreshed : null;
    }, 120000, 500, 'Volume read completion');

    await ownerPage.evaluate(() => {
      window.__audioMetrics.forceAudioError = true;
    });
    await clickPanelButton(ownerPage, 'Replay');
    await waitFor(async () => {
      const now = await getDebugState(runtimePage);
      await maybeForcePlaybackDone(runtimePage, now);
      const refreshed = await getDebugState(runtimePage);
      return !refreshed.state.isPlaying ? refreshed : null;
    }, 120000, 500, 'Replay fallback completion');

    await ownerPage.evaluate(() => {
      window.__audioMetrics.playDurationMs = 2500;
    });
    await clickPanelButton(ownerPage, 'Read');
    await clickPanelButton(ownerPage, 'Next');
    await waitFor(async () => {
      const now = await getDebugState(runtimePage);
      return now.state.isPlaying && now.state.queueSize >= 1 ? now : null;
    }, 120000, 300, 'queue ready for Skip');
    await clickPanelButton(ownerPage, 'Skip');
    await waitFor(async () => {
      const now = await getDebugState(runtimePage);
      return !now.state.isPlaying && now.state.queueSize === 0 ? now : null;
    }, 120000, 300, 'Skip completion');

    await ownerPage.evaluate(() => {
      window.__audioMetrics.playDurationMs = 2500;
    });
    await clickPanelButton(ownerPage, 'Read');
    await clickPanelButton(ownerPage, 'Next');
    await waitFor(async () => {
      const now = await getDebugState(runtimePage);
      return now.state.isPlaying || now.state.queueSize > 0 ? now : null;
    }, 120000, 300, 'queue ready for Stop');
    await clickPanelButton(ownerPage, 'Stop');
    await waitFor(async () => {
      const now = await getDebugState(runtimePage);
      return !now.state.isPlaying && now.state.queueSize === 0 ? now : null;
    }, 120000, 300, 'Stop completion');
    await sleep(1400);
    state = await getDebugState(runtimePage);
    if (state.state.isPlaying || state.state.queueSize !== 0) {
      throw new Error('Stop should leave queue empty and playback idle');
    }

    await ownerPage.selectOption('#local-voice-voice-select', 'irodori-v3');
    await sleep(500);
    await clickPanelButton(ownerPage, 'Regen');
    speakTarget = state.debugStats.speakCalls + 1;
    await waitFor(async () => {
      const now = await getDebugState(runtimePage);
      await maybeForcePlaybackDone(runtimePage, now);
      return now.debugStats.speakCalls >= speakTarget ? now : null;
    }, 180000, 500, 'Voice v3 Regen speak');
    state = await getDebugState(runtimePage);
    const lastSpeakEvent = state.debugStats.speakEvents[state.debugStats.speakEvents.length - 1];
    if (!lastSpeakEvent || lastSpeakEvent.voiceProfile !== 'irodori-v3') {
      throw new Error('voiceProfile did not switch to irodori-v3 for generation');
    }
    speakBaseline = state.debugStats.speakCalls;

    await ownerPage.selectOption('#local-voice-voice-select', 'irodori-v2');
    await sleep(500);
    await clickPanelButton(ownerPage, 'Replay');
    await waitFor(async () => {
      const now = await getDebugState(runtimePage);
      await maybeForcePlaybackDone(runtimePage, now);
      const refreshed = await getDebugState(runtimePage);
      return !refreshed.state.isPlaying ? refreshed : null;
    }, 120000, 500, 'Replay after voice switch completion');
    state = await getDebugState(runtimePage);
    if (state.debugStats.speakCalls !== speakBaseline) {
      throw new Error('Replay after voice switch should still avoid speak');
    }

    await setSelectedTab(ownerPage, otherTabId);
    const tab2ManualText = [
      'Other tab manual chunk one.',
      'Other tab manual chunk two.',
      'Other tab manual chunk three.',
    ].join('\n');
    await addAssistantMessage(otherPage, 'manual-other-2', tab2ManualText);
    await waitFor(async () => {
      const now = await getDebugState(runtimePage);
      const tab = now.tabs.find((item) => item.id === otherTabId);
      return tab && tab.messageKey === 'manual-other-2' ? now : null;
    }, 120000, 300, 'selected tab2 reports');
    await clickPanelButton(ownerPage, 'Read');
    await waitForLastPlayed(runtimePage, (now) => (
      now.state.lastPlayedItem && now.state.lastPlayedItem.tabId === otherTabId
    ), 'Read targets selected tab', 120000);

    await setAuto(ownerPage, true);
    const ownerAutoText = [
      'Auto check while selected tab is not owner.',
      'Should still enqueue from reporting tab.',
    ].join('\n');
    await addAssistantMessage(ownerPage, 'auto-owner-2', ownerAutoText);
    await waitForLastPlayed(runtimePage, (now) => (
      now.state.lastPlayedItem && now.state.lastPlayedItem.messageKey === 'auto-owner-2'
    ), 'Auto independent from selected tab', 180000);

    const finalState = await getDebugState(runtimePage);
    const metrics = await ownerPage.evaluate(() => window.__audioMetrics);
    console.log(JSON.stringify({
      ok: true,
      ownerTabId,
      otherTabId,
      speakCalls: finalState.debugStats.speakCalls,
      replayCalls: finalState.debugStats.replayCalls,
      speakCallsByReason: finalState.debugStats.speakCallsByReason,
      lastPlayedItem: finalState.state.lastPlayedItem,
      lastStatus: {
        text: finalState.state.statusText,
        level: finalState.state.statusLevel,
      },
      volumeMetrics: metrics,
    }, null, 2));
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
