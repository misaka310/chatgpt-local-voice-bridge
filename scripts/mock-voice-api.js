#!/usr/bin/env node
'use strict';

// Deterministic local substitute for CI and the browser demo. It never loads
// Python, CUDA, a model, or a reference voice.
const http = require('http');

const host = '127.0.0.1';
const port = Number(process.env.MOCK_VOICE_PORT || 8717);
const events = [];
const referenceVoices = [{ id: '', label: 'none' }, { id: 'sample', label: 'sample' }];
let control;

function resetControl() {
  control = {
    initialized: false,
    settingsRevision: 0,
    settings: {
      enabled: false,
      voiceVolume: 0.6,
      referenceVoice: '',
      micConversationEnabled: false,
      sttModel: 'small',
      cancelGraceMs: 700,
    },
    commands: [],
    nextCommandId: 1,
    conversationEvents: [],
    nextConversationEventId: 1,
    conversation: {
      phase: 'off',
      statusText: 'マイク会話オフ',
      sttDevice: '',
      sttModel: 'small',
      error: '',
    },
    extension: {
      connected: false,
      statusText: 'Waiting for ChatGPT',
      statusLevel: 'info',
      currentText: '',
      queueSize: 0,
      isPlaying: false,
      playbackPhase: 'idle',
      replayAvailable: false,
      tabsCount: 0,
    },
  };
}
resetControl();

// A short valid PCM WAV. A zero-byte/invalid blob would let a mock pass while
// the extension's real Audio element never reaches its completion state.
const wav = Buffer.alloc(44 + 8000);
wav.write('RIFF', 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(8000, 28);
wav.writeUInt16LE(1, 32);
wav.writeUInt16LE(8, 34);
wav.write('data', 36);
wav.writeUInt32LE(8000, 40);
wav.fill(128, 44);

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req, res, callback) {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (_) { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
    callback(body);
  });
}

function controlSnapshot(extra = {}) {
  return {
    ok: true,
    initialized: control.initialized,
    settingsRevision: control.settingsRevision,
    settings: { ...control.settings },
    extension: { ...control.extension },
    conversation: { ...control.conversation },
    lastCommandId: control.nextCommandId - 1,
    lastConversationEventId: control.nextConversationEventId - 1,
    referenceVoices,
    ...extra,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, engine: 'mock', runtime: 'mock', referenceVoices });
  if (req.method === 'GET' && url.pathname === '/v1/reference-voices') return json(res, 200, { ok: true, voices: referenceVoices });
  if (req.method === 'GET' && url.pathname === '/v1/control-panel') return json(res, 200, controlSnapshot());
  if (req.method === 'GET' && url.pathname === '/v1/control-panel/poll') {
    const after = Number(url.searchParams.get('after') || 0);
    const commands = control.commands.filter((item) => item.id > after);
    const claimedIds = new Set(commands.map((item) => item.id));
    if (claimedIds.size) control.commands = control.commands.filter((item) => !claimedIds.has(item.id));
    const conversationEvents = control.conversationEvents.splice(0);
    return json(res, 200, controlSnapshot({ commands, conversationEvents }));
  }
  if (req.method === 'GET' && url.pathname === '/audio/mock.wav') {
    events.push({ method: 'GET', path: url.pathname, responseStatus: 200, at: Date.now() });
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store' });
    return res.end(wav);
  }
  if (req.method === 'GET' && url.pathname === '/__test/events') return json(res, 200, { ok: true, events });
  if (req.method === 'POST' && url.pathname === '/__test/reset') {
    events.length = 0;
    resetControl();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/v1/control-panel/settings') {
    return readJson(req, res, (body) => {
      if (Object.prototype.hasOwnProperty.call(body, 'enabled')) control.settings.enabled = Boolean(body.enabled);
      if (Object.prototype.hasOwnProperty.call(body, 'voiceVolume')) control.settings.voiceVolume = Math.min(1, Math.max(0, Number(body.voiceVolume) || 0));
      if (Object.prototype.hasOwnProperty.call(body, 'referenceVoice') || Object.prototype.hasOwnProperty.call(body, 'voiceId')) {
        control.settings.referenceVoice = String(body.referenceVoice ?? body.voiceId ?? '').trim();
      }
      if (Object.prototype.hasOwnProperty.call(body, 'micConversationEnabled')) {
        control.settings.micConversationEnabled = Boolean(body.micConversationEnabled);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'sttModel')) {
        const model = String(body.sttModel || 'small').trim();
        control.settings.sttModel = ['small', 'medium', 'large-v3-turbo'].includes(model) ? model : 'small';
      }
      if (Object.prototype.hasOwnProperty.call(body, 'cancelGraceMs')) {
        control.settings.cancelGraceMs = Math.max(0, Math.min(5000, Math.round(Number(body.cancelGraceMs) || 0)));
      }
      control.initialized = true;
      control.settingsRevision += 1;
      events.push({ method: 'POST', path: url.pathname, body, responseStatus: 200, at: Date.now() });
      return json(res, 200, controlSnapshot());
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/control-panel/command') {
    return readJson(req, res, (body) => {
      const command = String(body.command || '').trim().toLowerCase();
      if (!['next', 'regen', 'replay', 'stop'].includes(command)) return json(res, 400, { ok: false, error: 'unsupported command' });
      const item = { id: control.nextCommandId++, command, createdAt: Date.now() / 1000 };
      control.commands.push(item);
      events.push({ method: 'POST', path: url.pathname, body, responseStatus: 200, at: Date.now() });
      return json(res, 200, { ok: true, command: item });
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/control-panel/state') {
    return readJson(req, res, (body) => {
      control.extension = { ...control.extension, ...body, connected: true };
      events.push({ method: 'POST', path: url.pathname, body, responseStatus: 200, at: Date.now() });
      return json(res, 200, { ok: true, extension: control.extension });
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/conversation/state') {
    return readJson(req, res, (body) => {
      control.conversation = {
        ...control.conversation,
        phase: String(body.phase || 'error'),
        statusText: String(body.statusText || ''),
        sttDevice: String(body.sttDevice || ''),
        sttModel: String(body.sttModel || control.settings.sttModel || 'small'),
        error: String(body.error || ''),
      };
      events.push({ method: 'POST', path: url.pathname, body: control.conversation, responseStatus: 200, at: Date.now() });
      return json(res, 200, { ok: true, conversation: control.conversation });
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/conversation/event') {
    return readJson(req, res, (body) => {
      const type = String(body.type || '').trim();
      const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
      if (!['cancel_pending', 'transcript'].includes(type)) return json(res, 400, { ok: false, error: 'unsupported conversation event' });
      if (type === 'transcript' && !String(payload.text || '').trim()) return json(res, 400, { ok: false, error: 'transcript text is required' });
      const item = { id: control.nextConversationEventId++, type, payload, createdAt: Date.now() / 1000 };
      control.conversationEvents.push(item);
      events.push({ method: 'POST', path: url.pathname, body, responseStatus: 200, at: Date.now() });
      return json(res, 200, { ok: true, event: item });
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/desktop-pet') {
    return readJson(req, res, (body) => {
      const selectedPetId = String(body.petId || 'placeholder').trim() || 'placeholder';
      events.push({ method: 'POST', path: url.pathname, body, responseStatus: 200, at: Date.now() });
      return json(res, 200, { ok: true, selectedPetId, visible: true });
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/speak') {
    return readJson(req, res, (body) => {
      const referenceVoice = String(body.voiceId || body.referenceVoice || '').trim();
      events.push({ method: 'POST', path: url.pathname, body, responseStatus: 200, at: Date.now() });
      return json(res, 200, { ok: true, engine: 'mock', runtime: 'mock', model: 'irodori-v3', voiceId: referenceVoice, voiceProfile: 'irodori-v3', referenceVoice, usedReferenceAudio: Boolean(referenceVoice), audioUrl: `http://${host}:${port}/audio/mock.wav` });
    });
  }
  return json(res, 404, { ok: false, error: 'not found' });
});

server.listen(port, host, () => console.log(`Mock Voice API listening on http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
