'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { readAsar, readPackageVersion, fileSizeLabel } = require('./asar');

const SUPPORTED_VERSIONS = ['2.9939.2'];

function detectInstallations() {
  const candidates = [];
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA || '';
    candidates.push(...windowsStoreCandidates(path.join(programFiles, 'WindowsApps')));
    candidates.push(...unpackagedCandidates(localAppData));
  } else if (process.platform === 'darwin') {
    candidates.push({
      kind: 'macos',
      appAsar: '/Applications/Claude.app/Contents/Resources/app.asar',
      exePath: '/Applications/Claude.app/Contents/MacOS/Claude',
    });
  } else {
    candidates.push({
      kind: 'linux',
      appAsar: '/usr/lib/claude-desktop/resources/app.asar',
      exePath: '/usr/lib/claude-desktop/claude-desktop',
    });
    candidates.push({
      kind: 'linux',
      appAsar: '/opt/Claude/resources/app.asar',
      exePath: '/opt/Claude/claude',
    });
    candidates.push({
      kind: 'linux',
      appAsar: '/opt/claude-desktop/resources/app.asar',
      exePath: '/opt/claude-desktop/claude-desktop',
    });
  }

  const seen = new Set();
  const installs = [];
  for (const candidate of candidates) {
    const appAsar = path.resolve(candidate.appAsar);
    if (seen.has(appAsar) || !fs.existsSync(appAsar)) continue;
    seen.add(appAsar);
    try {
      const asar = readAsar(appAsar);
      const version = readPackageVersion(asar);
      const resourcesPath = path.dirname(appAsar);
      const appRoot = path.resolve(resourcesPath, '..');
      const exePath = firstExisting(candidate.exePath, [
        path.join(appRoot, 'Claude.exe'),
        path.join(appRoot, 'claude.exe'),
      ]);
      const writable = canWrite(appAsar) && canWrite(resourcesPath);
      installs.push({
        id: stableId(appAsar),
        kind: candidate.kind,
        appRoot,
        resourcesPath,
        appAsar,
        exePath,
        version,
        supported: SUPPORTED_VERSIONS.includes(version),
        writable,
        asarBytes: fs.statSync(appAsar).size,
        asarSize: fileSizeLabel(fs.statSync(appAsar).size),
      });
    } catch (_) {
      // A partially installed or foreign app.asar is not a target.
    }
  }
  return installs.sort((a, b) => compareVersions(b.version, a.version));
}

function windowsStoreCandidates(root) {
  const out = [];
  const locations = new Set();
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-AppxPackage -Name Claude | Select-Object -ExpandProperty InstallLocation',
    ], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) {
      for (const line of String(result.stdout || '').split(/\r?\n/)) {
        const value = line.trim();
        if (value && fs.existsSync(value)) locations.add(value);
      }
    }
  } catch (_) {
    // Fall through to the directory scan when PowerShell is unavailable.
  }
  if (root && fs.existsSync(root)) {
    for (const entry of safeReadDir(root)) {
      if (!entry.isDirectory() || !entry.name.startsWith('Claude_')) continue;
      locations.add(path.join(root, entry.name));
    }
  }
  for (const location of locations) {
    out.push({
      kind: 'msix',
      appAsar: path.join(location, 'app', 'resources', 'app.asar'),
      exePath: path.join(location, 'app', 'Claude.exe'),
    });
  }
  return out;
}

function unpackagedCandidates(localAppData) {
  const out = [];
  if (!localAppData) return out;
  const base = path.join(localAppData, 'AnthropicClaude');
  if (fs.existsSync(base)) {
    for (const entry of safeReadDir(base)) {
      if (!entry.isDirectory() || !entry.name.startsWith('app-')) continue;
      out.push({
        kind: 'squirrel',
        appAsar: path.join(base, entry.name, 'resources', 'app.asar'),
        exePath: path.join(base, entry.name, 'Claude.exe'),
      });
    }
  }
  const programs = path.join(localAppData, 'Programs', 'Claude');
  out.push({
    kind: 'squirrel',
    appAsar: path.join(programs, 'resources', 'app.asar'),
    exePath: path.join(programs, 'Claude.exe'),
  });
  return out;
}

function safeReadDir(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function firstExisting(...values) {
  for (const value of values.flat()) {
    if (value && fs.existsSync(value)) return value;
  }
  return null;
}

function canWrite(target) {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function stableId(value) {
  return require('crypto').createHash('sha1').update(value.toLowerCase()).digest('hex').slice(0, 12);
}

function compareVersions(left, right) {
  const a = String(left).split('.').map((part) => Number(part) || 0);
  const b = String(right).split('.').map((part) => Number(part) || 0);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}

module.exports = {
  SUPPORTED_VERSIONS,
  compareVersions,
  detectInstallations,
};
