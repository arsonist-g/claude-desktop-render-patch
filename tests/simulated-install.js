#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeHeader, integrity } = require('../src/asar');
const { applyPatch, restorePatch, status } = require('../src/patch');

const anchor = fs.readFileSync(path.join(__dirname, '..', 'data', 'anchor.txt'), 'utf8').trim();
const mainSource = `'use strict';${anchor}b.setBackgroundColor("#00000000");`;
const failures = [];

runTest('simulated install/restore', () => {
  const fixture = createFixture('2.9939.2', true);
  const before = status(fixture.installation);
  assert.strictEqual(before.installed, false);

  const applied = applyPatch(fixture.installation, { noBackup: false });
  assert.ok(applied.backup);
  const after = status(fixture.installation);
  assert.strictEqual(after.installed, true);
  assert.strictEqual(after.payloadReady, true);
  assert.strictEqual(after.backupCount, 1);

  const patchedBytes = fs.readFileSync(fixture.appAsarPath);
  assert.ok(patchedBytes.includes(Buffer.from('__CLAUDE_TPR_LOADER_START__')));

  restorePatch(fixture.installation, applied.backup.split(path.sep).pop());
  const restored = status(fixture.installation);
  assert.strictEqual(restored.installed, false);
});

runTest('applies patch to 2.19675.0 when it is not version-listed', () => {
  const fixture = createFixture('2.19675.0', false);
  applyPatch(fixture.installation, { noBackup: true });

  const after = status(fixture.installation);
  assert.strictEqual(after.installed, true);
  assert.ok(fs.readFileSync(fixture.appAsarPath).includes(Buffer.from('__CLAUDE_TPR_LOADER_START__')));
});

runTest('discovers the renamed main chunk in newer builds', () => {
  const targetEntry = '.vite/build/index.chunk-CN7MfJQH.js';
  const fixture = createFixture('2.19675.0', false, {
    targetEntry,
    targetSource: [
      "'use strict';",
      'let b=eCe({webPreferences:{preload:n.default.join(a.app.getAppPath(),".vite/build/mainView.js"),',
      'additionalArguments:["desktop"]}});',
      'b.setBackgroundColor("#00000000"),b.ready();',
    ].join(''),
  });
  const applied = applyPatch(fixture.installation, { noBackup: true });

  assert.strictEqual(applied.targetEntry, targetEntry);
  assert.strictEqual(status(fixture.installation).installed, true);
});

runTest('restores app.asar and clears payload after a late write failure', () => {
  const fixture = createFixture('2.9939.2', true);
  const exePath = path.join(fixture.root, 'Claude.exe');
  fs.writeFileSync(exePath, Buffer.concat([
    Buffer.from('resources\\\\app.asar","alg":"SHA256","value":"', 'ascii'),
    Buffer.from('0'.repeat(64), 'ascii'),
  ]));
  fixture.installation.exePath = exePath;

  const beforeBytes = fs.readFileSync(fixture.appAsarPath);
  const originalWriteSync = fs.writeSync;
  let failedAfterAsarReplacement = false;
  let backupPresentAtFailure = false;

  fs.writeSync = function writeSync(fd, buffer, ...args) {
    const isHashWrite = Buffer.isBuffer(buffer) &&
      buffer.length === 64 &&
      /^[a-f0-9]{64}$/i.test(buffer.toString('ascii'));
    if (isHashWrite && !failedAfterAsarReplacement) {
      failedAfterAsarReplacement = !fs.readFileSync(fixture.appAsarPath).equals(beforeBytes);
      backupPresentAtFailure = status(fixture.installation).backupCount === 1;
    }
    if (isHashWrite) {
      throw new Error('simulated executable hash write failure');
    }
    return originalWriteSync.call(fs, fd, buffer, ...args);
  };

  try {
    assert.throws(
      () => applyPatch(fixture.installation, { noBackup: false }),
      /simulated executable hash write failure/,
    );
  } finally {
    fs.writeSync = originalWriteSync;
  }

  assert.strictEqual(failedAfterAsarReplacement, true);
  assert.strictEqual(backupPresentAtFailure, true);
  assert.deepStrictEqual(
    {
      appAsarRestored: fs.readFileSync(fixture.appAsarPath).equals(beforeBytes),
      activePayloadRemoved: !fs.existsSync(path.join(fixture.resourcesPath, 'third-party-render')),
    },
    {
      appAsarRestored: true,
      activePayloadRemoved: true,
    },
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed:`);
  for (const failure of failures) {
    console.error(`\nFAIL ${failure.name}`);
    console.error(failure.error.stack || failure.error.message);
  }
  process.exitCode = 1;
} else {
  console.log('\nsimulated install/restore passed');
}

function runTest(name, callback) {
  try {
    callback();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
  }
}

function createFixture(version, supported, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-render-patch-'));
  const resourcesPath = path.join(root, 'resources');
  fs.mkdirSync(resourcesPath, { recursive: true });

  const main = Buffer.from(mainSource);
  const targetEntry = options.targetEntry || '.vite/build/index.chunk-6aZ703Pj.js';
  const appAsar = buildMinimalAsar({
    'package.json': Buffer.from(JSON.stringify({ version })),
    '.vite/build/mainView.js': Buffer.from('"use strict";'),
    [targetEntry]: options.targetSource ? Buffer.from(options.targetSource) : main,
  });
  const appAsarPath = path.join(resourcesPath, 'app.asar');
  fs.writeFileSync(appAsarPath, appAsar);

  return {
    root,
    resourcesPath,
    appAsarPath,
    installation: {
      id: 'fixture',
      kind: 'fixture',
      appRoot: root,
      resourcesPath,
      appAsar: appAsarPath,
      exePath: null,
      version,
      supported,
      writable: true,
    },
  };
}

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
