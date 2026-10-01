'use strict';

const { spawn, spawnSync } = require('child_process');

function isClaudeRunning() {
  if (process.platform === 'win32') {
    const result = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq Claude.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return /claude\.exe/i.test(result.stdout || '');
  }
  const result = spawnSync('pgrep', ['-f', '(Claude|claude-desktop)'], { encoding: 'utf8' });
  return result.status === 0 && Boolean((result.stdout || '').trim());
}

function stopClaude() {
  if (process.platform === 'win32') {
    const results = ['Claude.exe', 'cowork-svc.exe'].map((name) => {
      const result = spawnSync('taskkill.exe', ['/IM', name, '/F'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return { name, status: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.trim() };
    });
    return results;
  }
  const result = spawnSync('pkill', ['-f', 'Claude|claude-desktop'], { encoding: 'utf8' });
  return [{ name: 'Claude', status: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.trim() }];
}

function restartClaude(installation) {
  if (process.platform === 'win32' && installation.kind === 'msix') {
    const packageName = packageFamilyName(installation.appAsar);
    if (packageName) {
      const child = spawn('explorer.exe', [`shell:AppsFolder\\${packageName}!Claude`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      return true;
    }
  }
  if (!installation.exePath) return false;
  const child = spawn(installation.exePath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return true;
}

function packageFamilyName(appAsar) {
  const match = String(appAsar).match(/WindowsApps[\\/](Claude_[^\\/]+)[\\/]/i);
  if (!match) return null;
  const parts = match[1].split('_');
  if (parts.length < 5) return null;
  return `${parts[0]}_${parts[parts.length - 1]}`;
}

module.exports = {
  isClaudeRunning,
  packageFamilyName,
  restartClaude,
  stopClaude,
};
