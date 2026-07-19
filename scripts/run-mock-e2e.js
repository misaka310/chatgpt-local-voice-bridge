#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const playwrightCli = require.resolve('@playwright/test/cli');
const config = path.join('scripts', 'playwright-mock.config.js');
const runner = spawn(process.execPath, [
  playwrightCli,
  'test',
  '--config',
  config,
], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: false,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => runner.kill(signal));
}

runner.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
runner.on('exit', (code) => process.exit(code ?? 1));
