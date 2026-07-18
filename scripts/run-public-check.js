#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const candidates = [
  process.env.PYTHON,
  path.join(ROOT, 'local-api', '.venv', 'Scripts', 'python.exe'),
  path.join(ROOT, 'local-api', '.venv', 'bin', 'python'),
  process.platform === 'win32' ? 'python' : 'python3',
  'python',
].filter(Boolean);

function isLocalPath(command) {
  return path.isAbsolute(command) || command.includes(path.sep);
}

for (const command of candidates) {
  if (isLocalPath(command) && (!fs.existsSync(command) || !fs.statSync(command).isFile())) continue;
  const result = spawnSync(command, ['scripts/check-public-tree.py'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (!result.error) process.exit(result.status ?? 1);
  if (result.error.code !== 'ENOENT') {
    console.error(result.error.message);
    process.exit(1);
  }
}

console.error('Python was not found. Run setup-voice-env.cmd or install Python 3.11.');
process.exit(1);
