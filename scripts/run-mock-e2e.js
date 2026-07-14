#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const runner = spawn(command, [
  'playwright',
  'test',
  'tests/e2e/extension-mock-ci.spec.js',
  '--headed',
  '--workers=1',
], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => runner.kill(signal));
}

runner.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
runner.on('exit', (code) => process.exit(code ?? 1));
