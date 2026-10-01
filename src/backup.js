'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BACKUP_DIR_NAME = '.third-party-render-backups';
const EXE_MARKER = Buffer.from('resources\\\\app.asar","alg":"SHA256","value":"', 'ascii');

function backupRoot(installation) {
  return path.join(installation.resourcesPath, BACKUP_DIR_NAME);
}

function listBackups(installation) {
  const root = backupRoot(installation);
  if (!fs.existsSync(root)) return [];
  const entries = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const metaPath = path.join(directory, 'meta.json');
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (_) {
      meta = {};
    }
    const asarPath = path.join(directory, 'app.asar');
    if (!fs.existsSync(asarPath)) continue;
    entries.push({
      id: entry.name,
      path: directory,
      appAsar: asarPath,
      meta,
      bytes: fs.statSync(asarPath).size,
    });
  }
  return entries.sort((a, b) => b.id.localeCompare(a.id));
}

function createBackup(installation, originalHash) {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const directory = path.join(backupRoot(installation), `${installation.version}-${timestamp}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(installation.appAsar, path.join(directory, 'app.asar'));
  const meta = {
    package: '@arsonist-g/claude-desktop-render-patch',
    version: installation.version,
    kind: installation.kind,
    createdAt: new Date().toISOString(),
    appAsar: installation.appAsar,
    exePath: installation.exePath,
    originalHash,
  };
  fs.writeFileSync(path.join(directory, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  if (originalHash) {
    fs.writeFileSync(path.join(directory, 'original-hash.txt'), `${originalHash}\n`, 'ascii');
  }
  return directory;
}

function restoreBackup(installation, backup) {
  fs.copyFileSync(backup.appAsar, installation.appAsar);
  const hashPath = path.join(backup.path, 'original-hash.txt');
  if (installation.exePath && fs.existsSync(hashPath)) {
    const originalHash = fs.readFileSync(hashPath, 'ascii').trim();
    if (/^[a-f0-9]{64}$/i.test(originalHash)) {
      writeExeHash(installation.exePath, originalHash);
    }
  }
  return {
    restoredFrom: backup.id,
    hashRestored: Boolean(installation.exePath && fs.existsSync(hashPath)),
  };
}

function readExeHash(exePath) {
  if (!exePath || !fs.existsSync(exePath)) return null;
  const offset = findMarkerOffset(exePath, EXE_MARKER);
  if (offset < 0) return null;
  const handle = fs.openSync(exePath, 'r');
  try {
    const buffer = Buffer.alloc(64);
    const read = fs.readSync(handle, buffer, 0, 64, offset + EXE_MARKER.length);
    if (read !== 64) return null;
    const value = buffer.toString('ascii');
    return /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
  } finally {
    fs.closeSync(handle);
  }
}

function writeExeHash(exePath, hash) {
  if (!exePath || !fs.existsSync(exePath)) return false;
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Refusing to write a non-SHA256 app.asar hash');
  const offset = findMarkerOffset(exePath, EXE_MARKER);
  if (offset < 0) throw new Error('Claude executable is missing the app.asar integrity marker');
  const handle = fs.openSync(exePath, 'r+');
  try {
    fs.writeSync(handle, Buffer.from(hash.toLowerCase(), 'ascii'), 0, 64, offset + EXE_MARKER.length);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return true;
}

function findMarkerOffset(filePath, marker) {
  const size = fs.statSync(filePath).size;
  const chunkSize = 4 * 1024 * 1024;
  const overlap = marker.length - 1;
  const buffer = Buffer.allocUnsafe(chunkSize + overlap);
  let carry = 0;
  let position = 0;
  const handle = fs.openSync(filePath, 'r');
  try {
    while (position < size) {
      const read = fs.readSync(handle, buffer, carry, chunkSize, position);
      if (read <= 0) break;
      const length = carry + read;
      const index = buffer.subarray(0, length).indexOf(marker);
      if (index >= 0) return position - carry + index;
      carry = Math.min(overlap, length);
      buffer.copy(buffer, 0, length - carry, length);
      position += read;
    }
    return -1;
  } finally {
    fs.closeSync(handle);
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

module.exports = {
  BACKUP_DIR_NAME,
  EXE_MARKER,
  backupRoot,
  createBackup,
  findMarkerOffset,
  listBackups,
  readExeHash,
  restoreBackup,
  sha256File,
  writeExeHash,
};
