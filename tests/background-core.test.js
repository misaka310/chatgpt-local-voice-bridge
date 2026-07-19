'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const core = require('../extension/background-core.js');

if (typeof btoa !== 'function') {
  global.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
}

test('reference voice normalization preserves an explicit none selection', () => {
  assert.equal(core.normalizeReferenceVoice(' none '), '');
  assert.equal(core.normalizeReferenceVoice('QWEN3'), '');
  assert.equal(core.normalizeReferenceVoice(' sample '), 'sample');
  assert.equal(core.resolveReferenceVoice('', 'old-value'), '');
  assert.equal(core.resolveReferenceVoice(undefined, ' sample '), 'sample');
});

test('audio URLs stay on the configured loopback service', () => {
  const settings = {
    apiUrl: 'http://127.0.0.1:8717/v1/speak',
    healthUrl: 'http://localhost:8717/health',
  };
  assert.equal(core.isAllowedAudioUrl('http://127.0.0.1:8717/audio/a.wav', settings), true);
  assert.equal(core.isAllowedAudioUrl('http://localhost:8717/audio/a.wav', settings), true);
  assert.equal(core.isAllowedAudioUrl('http://127.0.0.1:9999/audio/a.wav', settings), false);
  assert.equal(core.isAllowedAudioUrl('https://127.0.0.1:8717/audio/a.wav', settings), false);
  assert.equal(core.isAllowedAudioUrl('http://invalid.local:8717/audio/a.wav', settings), false);
  assert.equal(core.isAllowedAudioUrl('http://127.0.0.1:8717/health', settings), false);
  assert.equal(core.isAllowedAudioUrl('invalid-url', settings), false);
});

test('binary conversion and chunk labels are deterministic', () => {
  const bytes = new Uint8Array(0x8000 + 3);
  bytes[0] = 65;
  bytes[0x8000] = 66;
  assert.equal(Buffer.from(core.arrayBufferToBase64(bytes.buffer), 'base64').length, bytes.length);
  assert.equal(core.chunkLabel({ chunkIndex: 0, chunkCount: 3 }), '1/3');
  assert.equal(core.chunkLabel({ chunkIndex: 2, chunkCount: 3 }), '3/3');
  assert.equal(core.chunkLabel(null), '1');
});

test('manifest uses the core-backed service worker entry', () => {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const entry = fs.readFileSync(path.join(root, 'extension', 'background-entry.js'), 'utf8');
  assert.equal(manifest.background.service_worker, 'background-entry.js');
  assert.match(entry, /background-core\.js/);
  assert.match(entry, /background\.js/);
});
