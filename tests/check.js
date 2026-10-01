#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const directories = ['bin', 'src', 'scripts', 'tests'];
const failures = [];
let checked = 0;

for (const directory of directories) {
  for (const file of walk(path.join(root, directory))) {
    if (!file.endsWith('.js')) continue;
    checked += 1;
    const result = childProcess.spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      failures.push(`${path.relative(root, file)}: ${result.stderr || result.stdout}`);
    }
  }
}

const payloadRoot = path.join(root, 'data', 'third-party-render');
const manifest = JSON.parse(fs.readFileSync(path.join(payloadRoot, 'manifest.json'), 'utf8'));
for (const [name, item] of Object.entries(manifest.components)) {
  const file = path.join(payloadRoot, name);
  if (!fs.existsSync(file)) {
    failures.push(`missing payload: ${name}`);
    continue;
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest !== item.sha256) failures.push(`payload hash mismatch: ${name}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`checked ${checked} files`);

function* walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}
