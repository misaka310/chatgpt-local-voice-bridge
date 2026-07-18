#!/usr/bin/env node
'use strict';

// Deterministic local substitute for CI and the browser demo. It never loads
// Python, CUDA, a model, or a reference voice.
const http = require('http');

const host = '127.0.0.1';
const port = Number(process.env.MOCK_VOICE_PORT || 8717);
const events = [];
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, engine: 'mock', runtime: 'mock', referenceVoices: [{ id: '', label: 'none' }, { id: 'sample', label: 'sample' }] });
  if (req.method === 'GET' && url.pathname === '/v1/reference-voices') return json(res, 200, { ok: true, voices: [{ id: '', label: 'none' }, { id: 'sample', label: 'sample' }] });
  if (req.method === 'GET' && url.pathname === '/audio/mock.wav') {
    events.push({ method: 'GET', path: url.pathname, responseStatus: 200, at: Date.now() });
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store' });
    return res.end(wav);
  }
  if (req.method === 'GET' && url.pathname === '/__test/events') return json(res, 200, { ok: true, events });
  if (req.method === 'POST' && url.pathname === '/__test/reset') {
    events.length = 0;
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/v1/desktop-pet') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (_) { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
      const selectedPetId = String(body.petId || 'placeholder').trim() || 'placeholder';
      events.push({ method: 'POST', path: url.pathname, body, responseStatus: 200, at: Date.now() });
      return json(res, 200, { ok: true, selectedPetId, visible: true });
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/speak') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (_) { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
      const referenceVoice = String(body.voiceId || body.referenceVoice || '').trim();
      events.push({ method: 'POST', path: url.pathname, body, responseStatus: 200, at: Date.now() });
      return json(res, 200, { ok: true, engine: 'mock', runtime: 'mock', model: 'irodori-v3', voiceId: referenceVoice, voiceProfile: 'irodori-v3', referenceVoice, usedReferenceAudio: Boolean(referenceVoice), audioUrl: `http://${host}:${port}/audio/mock.wav` });
    });
    return;
  }
  return json(res, 404, { ok: false, error: 'not found' });
});

server.listen(port, host, () => console.log(`Mock Voice API listening on http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
