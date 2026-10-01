#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeHeader, integrity } = require('../src/asar');
const { applyPatch, restorePatch, status } = require('../src/patch');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-render-patch-'));
const resourcesPath = path.join(root, 'resources');
fs.mkdirSync(resourcesPath, { recursive: true });
const anchor = fs.readFileSync(path.join(__dirname, '..', 'data', 'anchor.txt'), 'utf8').trim();
const mainSource = `'use strict';${anchor}b.setBackgroundColor("#00000000");`;
const packageJson = Buffer.from('{"version":"2.9939.2"}');
const main = Buffer.from(mainSource);
const appAsar = buildMinimalAsar({
  'package.json': packageJson,
  '.vite/build/mainView.js': Buffer.from('\"use strict\";'),
  '.vite/build/index.chunk-6aZ703Pj.js': main,
});
const appAsarPath = path.join(resourcesPath, 'app.asar');
fs.writeFileSync(appAsarPath, appAsar);
const installation = {
  id: 'fixture',
  kind: 'fixture',
  appRoot: root,
  resourcesPath,
  appAsar: appAsarPath,
  exePath: null,
  version: '2.9939.2',
  supported: true,
  writable: true,
};

const before = status(installation);
assert.strictEqual(before.installed, false);
const applied = applyPatch(installation, { noBackup: false });
assert.ok(applied.backup);
const after = status(installation);
assert.strictEqual(after.installed, true);
assert.strictEqual(after.payloadReady, true);
assert.strictEqual(after.backupCount, 1);
const patchedText = fs.readFileSync(appAsarPath);
assert.ok(patchedText.includes(Buffer.from('__CLAUDE_TPR_LOADER_START__')));
restorePatch(installation, applied.backup.split(path.sep).pop());
const restored = status(installation);
assert.strictEqual(restored.installed, false);
console.log('simulated install/restore passed');

function buildMinimalAsar(files) {
  const rootNode = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [filePath, content] of Object.entries(files)) {
    const entry = { size: content.length, offset: String(offset), integrity: integrity(content) };
    setPath(rootNode, filePath, entry);
    chunks.push(content);
    offset += content.length;
  }
  const { encoded } = encodeHeader(rootNode);
  return Buffer.concat([encoded, ...chunks]);
}

function setPath(rootNode, filePath, value) {
  const parts = filePath.split('/');
  let node = rootNode;
  for (let index = 0; index < parts.length - 1; index += 1) {
    node.files[parts[index]] = node.files[parts[index]] || { files: {} };
    node = node.files[parts[index]];
  }
  node.files[parts[parts.length - 1]] = value;
}
