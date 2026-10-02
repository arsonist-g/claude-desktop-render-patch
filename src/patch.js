'use strict';

const fs = require('fs');
const path = require('path');
const { iterFiles, parseAsar, readAsar, readEntry, replaceFile, sha256 } = require('./asar');
const { createBackup, listBackups, readExeHash, restoreBackup, writeExeHash } = require('./backup');
const { SUPPORTED_VERSIONS } = require('./detect');

const PACKAGE = '@arsonist-g/claude-desktop-render-patch';
const TARGET_ENTRY = '.vite/build/index.chunk-6aZ703Pj.js';
const MAIN_VIEW_ENTRY = '.vite/build/mainView.js';
const CACHE_ENTRY = 'compile-cache/index.chunk-6aZ703Pj.js.x64.jsc';
const PAYLOAD_DIR = path.join(__dirname, '..', 'data', 'third-party-render');
const ANCHOR_PATH = path.join(__dirname, '..', 'data', 'anchor.txt');
const SHADOW_HOOK_PATH = path.join(__dirname, 'shadow-hook.js');
const LOADER_START = '/*__CLAUDE_TPR_LOADER_START__*/';
const LOADER_END = '/*__CLAUDE_TPR_LOADER_END__*/';
const SHADOW_HOOK_START = '/*__CLAUDE_TPR_SHADOW_HOOK_START__*/';
const SHADOW_HOOK_END = '/*__CLAUDE_TPR_SHADOW_HOOK_END__*/';

function loadPayload() {
  const manifestPath = path.join(PAYLOAD_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Payload is missing: ${manifestPath}. Run "npm run build" first.`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function loadAnchor() {
  return fs.readFileSync(ANCHOR_PATH, 'utf8').trim();
}

function applyPatch(installation, options = {}) {
  if (!installation.writable && !options.ignorePermissions) {
    throw new Error(`No write permission: ${installation.appAsar}`);
  }

  const manifest = loadPayload();
  const anchor = loadAnchor();
  const asar = readAsar(installation.appAsar);

  const originalMainView = stripShadowHookBlock(readEntry(asar, MAIN_VIEW_ENTRY).toString('utf8'));
  const shadowHook = fs.readFileSync(SHADOW_HOOK_PATH, 'utf8');
  let result = replaceFile(
    asar,
    MAIN_VIEW_ENTRY,
    Buffer.from(`${originalMainView}\n${shadowHook}`, 'utf8'),
  );
  let workingAsar = { data: result.data, ...parseAsar(result.data) };

  const injection = resolveInjectionPoint(asar, anchor);
  const current = readEntry(workingAsar, injection.entryPath).toString('utf8');
  const withoutPrevious = stripLoaderBlock(current);
  if (injection.insertAt > withoutPrevious.length) {
    throw new Error(`Injection offset is out of bounds in ${injection.entryPath}.`);
  }

  let loader = fs.readFileSync(path.join(PAYLOAD_DIR, 'main-inject.js'), 'utf8');
  if (injection.identifier !== 'b') {
    loader = loader.replace('attach(b.webContents);', `attach(${injection.identifier}.webContents);`);
  }
  const patched = `${withoutPrevious.slice(0, injection.insertAt)}\n${loader}\n${withoutPrevious.slice(injection.insertAt)}`;
  result = replaceFile(workingAsar, injection.entryPath, Buffer.from(patched, 'utf8'));

  let cacheInvalidated = false;
  try {
    const reparsed = { data: result.data, ...parseAsar(result.data) };
    result = replaceFile(reparsed, CACHE_ENTRY, Buffer.alloc(0));
    cacheInvalidated = true;
  } catch (_) {
    // Older/other builds may not ship a compile-cache entry for this chunk.
  }

  let backup = null;
  try {
    const originalHash = installation.exePath ? readExeHash(installation.exePath) : null;
    backup = options.noBackup ? null : createBackup(installation, originalHash);
    const payloadReport = writePayload(installation, manifest);
    atomicWrite(installation.appAsar, result.data);

    let hashUpdated = false;
    if (installation.exePath) {
      writeExeHash(installation.exePath, result.headerHash);
      hashUpdated = true;
    }

    return {
      action: 'apply',
      installation,
      backup,
      payload: payloadReport,
      targetEntry: injection.entryPath,
      mainViewEntry: MAIN_VIEW_ENTRY,
      headerHash: result.headerHash,
      hashUpdated,
      cacheInvalidated,
      patchedBytes: patched.length,
    };
  } catch (error) {
    if (backup) rollbackFailedApply(installation, backup, error);
    throw error;
  }
}

function restorePatch(installation, backupId) {
  const backups = listBackups(installation);
  const backup = backupId
    ? backups.find((item) => item.id === backupId)
    : backups[0];
  if (!backup) {
    throw new Error('No backup is available for this Claude installation.');
  }
  const result = restoreBackup(installation, backup);
  const removed = movePayloadAside(installation);
  return { action: 'restore', installation, backup: backup.id, removed, ...result };
}

function status(installation) {
  const result = {
    installation,
    supported: SUPPORTED_VERSIONS.includes(installation.version),
    installed: false,
    payloadReady: false,
    hashMatches: false,
    backupCount: 0,
  };
  try {
    const asar = readAsar(installation.appAsar);
    const patchedEntry = findPatchedEntry(asar);
    const mainView = readEntry(asar, MAIN_VIEW_ENTRY).toString('utf8');
    result.installed = Boolean(patchedEntry) &&
      mainView.includes(SHADOW_HOOK_START) &&
      mainView.includes(SHADOW_HOOK_END);
    if (patchedEntry) result.targetEntry = patchedEntry;
  } catch (_) {
    result.installed = false;
  }
  try {
    const manifest = loadPayload();
    result.payloadReady = Object.entries(manifest.components || {}).every(([name, item]) => {
      const file = path.join(installation.resourcesPath, 'third-party-render', name);
      return fs.existsSync(file) && sha256(fs.readFileSync(file)) === item.sha256;
    });
  } catch (_) {
    result.payloadReady = false;
  }
  try {
    const asar = readAsar(installation.appAsar);
    const headerHash = sha256(asar.headerString);
    const exeHash = installation.exePath ? readExeHash(installation.exePath) : null;
    result.hashMatches = exeHash === headerHash;
  } catch (_) {
    result.hashMatches = false;
  }
  result.backupCount = listBackups(installation).length;
  return result;
}

function writePayload(installation, manifest) {
  const destination = path.join(installation.resourcesPath, 'third-party-render');
  fs.mkdirSync(destination, { recursive: true });
  const written = [];
  for (const [name, source] of Object.entries(payloadFiles(manifest))) {
    const target = path.join(destination, name);
    fs.copyFileSync(source, target);
    written.push(name);
  }
  const localManifest = {
    package: PACKAGE,
    rendererVersion: manifest.rendererVersion,
    installedAt: new Date().toISOString(),
    appVersion: installation.version,
    components: manifest.components,
  };
  fs.writeFileSync(path.join(destination, 'manifest.json'), `${JSON.stringify(localManifest, null, 2)}\n`, 'utf8');
  written.push('manifest.json');
  return { directory: destination, files: written };
}

function payloadFiles(manifest) {
  const files = {};
  for (const name of Object.keys(manifest.components || {})) {
    files[name] = path.join(PAYLOAD_DIR, name);
  }
  files['main-inject.js'] = path.join(PAYLOAD_DIR, 'main-inject.js');
  return files;
}

function movePayloadAside(installation) {
  const source = path.join(installation.resourcesPath, 'third-party-render');
  if (!fs.existsSync(source)) return null;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const destination = path.join(installation.resourcesPath, '.third-party-render-backups', `removed-${stamp}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
  return destination;
}

function resolveInjectionPoint(asar, anchor) {
  try {
    const current = stripLoaderBlock(readEntry(asar, TARGET_ENTRY).toString('utf8'));
    const matches = countOccurrences(current, anchor);
    if (matches === 1) {
      return {
        entryPath: TARGET_ENTRY,
        identifier: 'b',
        insertAt: current.indexOf(anchor) + anchor.length,
      };
    }
    if (matches > 1) {
      throw new Error(`Found ${matches} injection points in ${TARGET_ENTRY}; expected 1.`);
    }
  } catch (error) {
    if (/Found \d+ injection points/.test(error.message)) throw error;
  }

  const candidates = [];
  for (const item of iterFiles(asar.header)) {
    if (!/^\.vite\/build\/index\.chunk-.*\.js$/.test(item.path)) continue;
    let content;
    try {
      content = stripLoaderBlock(readEntry(asar, item.path).toString('utf8'));
    } catch (_) {
      continue;
    }
    const marker = '".vite/build/mainView.js"';
    let markerIndex = -1;
    while ((markerIndex = content.indexOf(marker, markerIndex + 1)) >= 0) {
      const declarationStart = content.lastIndexOf('let ', markerIndex);
      if (declarationStart < 0 || markerIndex - declarationStart > 500) continue;
      const declaration = content.slice(declarationStart, markerIndex);
      const match = /^let\s+([A-Za-z_$][\w$]*)\s*=/.exec(declaration);
      if (!match) continue;
      const backgroundIndex = content.indexOf('setBackgroundColor("#00000000")', markerIndex);
      if (backgroundIndex < 0 || backgroundIndex - markerIndex > 500) continue;
      const statementEnd = content.indexOf(';', markerIndex);
      if (statementEnd < 0 || statementEnd > backgroundIndex) continue;
      candidates.push({
        entryPath: item.path,
        identifier: match[1],
        insertAt: statementEnd + 1,
      });
    }
  }

  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error('Could not locate the injection point in the .vite/build main chunks.');
  }
  throw new Error(`Could not locate a unique injection point; found ${candidates.length} candidates.`);
}

function findPatchedEntry(asar) {
  try {
    const current = readEntry(asar, TARGET_ENTRY).toString('utf8');
    if (current.includes(LOADER_START) && current.includes(LOADER_END)) return TARGET_ENTRY;
  } catch (_) {
    // The target chunk name changes between Claude Desktop builds.
  }
  const matches = [];
  for (const item of iterFiles(asar.header)) {
    if (!/^\.vite\/build\/index\.chunk-.*\.js$/.test(item.path)) continue;
    try {
      const current = readEntry(asar, item.path).toString('utf8');
      if (current.includes(LOADER_START) && current.includes(LOADER_END)) matches.push(item.path);
    } catch (_) {
      // A partially installed or foreign archive is not a patch target.
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function rollbackFailedApply(installation, backupPath, error) {
  const backup = {
    id: path.basename(backupPath),
    path: backupPath,
    appAsar: path.join(backupPath, 'app.asar'),
  };
  const rollback = {
    attempted: true,
    backup: backup.id,
    restored: false,
    payloadRemoved: false,
  };
  try {
    restoreBackup(installation, backup);
    rollback.restored = true;
  } catch (restoreError) {
    rollback.restoreError = restoreError.message;
  }
  try {
    rollback.removed = movePayloadAside(installation);
    rollback.payloadRemoved = true;
  } catch (cleanupError) {
    rollback.cleanupError = cleanupError.message;
  }
  if (!rollback.restored) rollback.error = rollback.restoreError;
  else if (!rollback.payloadRemoved) rollback.error = rollback.cleanupError;
  error.rollback = rollback;
  return error;
}

function stripShadowHookBlock(content) {
  const start = content.indexOf(SHADOW_HOOK_START);
  if (start < 0) return content;
  const end = content.indexOf(SHADOW_HOOK_END, start);
  if (end < 0) throw new Error('Existing shadow-root hook is malformed.');
  return content.slice(0, start) + content.slice(end + SHADOW_HOOK_END.length);
}

function stripLoaderBlock(content) {
  const start = content.indexOf(LOADER_START);
  if (start < 0) return content;
  const end = content.indexOf(LOADER_END, start);
  if (end < 0) throw new Error('Existing renderer loader is malformed.');
  return content.slice(0, start) + content.slice(end + LOADER_END.length);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) >= 0) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function atomicWrite(filePath, data) {
  const temporary = `${filePath}.third-party-render.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, filePath);
}

module.exports = {
  CACHE_ENTRY,
  LOADER_END,
  LOADER_START,
  MAIN_VIEW_ENTRY,
  PACKAGE,
  PAYLOAD_DIR,
  SHADOW_HOOK_END,
  SHADOW_HOOK_START,
  TARGET_ENTRY,
  applyPatch,
  loadPayload,
  restorePatch,
  status,
  stripLoaderBlock,
  stripShadowHookBlock,
};
