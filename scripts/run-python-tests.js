#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST_MODULES = [
  'tests.test_server_loopback',
  'tests.test_control_state',
  'tests.test_control_panel',
  'tests.test_conversation_controller',
  'tests.test_preflight_versions',
  'tests.test_irodori_cache',
  'tests.test_desktop_pet_config',
  'tests.test_desktop_pet',
  'tests.test_tray_controller',
  'tests.test_tray_controller_processes',
  'tests.test_tray_qt_runtime',
  'tests.test_windows_gui_smoke_script',
  'tests.test_windows_process_identity',
];

function pythonCandidates() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push(process.env.PYTHON);
  candidates.push(path.join(ROOT, 'local-api', '.venv', 'Scripts', 'python.exe'));
  candidates.push(path.join(ROOT, 'local-api', '.venv', 'bin', 'python'));
  if (process.platform === 'win32') {
    candidates.push('python');
    return candidates;
  }
  candidates.push('python', 'python3');
  return candidates;
}

function isLocalPath(command) {
  return path.isAbsolute(command) || command.includes(path.sep);
}

for (const command of pythonCandidates()) {
  if (isLocalPath(command) && (!fs.existsSync(command) || !fs.statSync(command).isFile())) continue;
  const result = spawnSync(command, ['-m', 'unittest', ...TEST_MODULES], {
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
