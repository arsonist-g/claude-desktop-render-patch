'use strict';

const fs = require('fs');
const path = require('path');
const { detectInstallations } = require('./detect');
const { listBackups } = require('./backup');
const { applyPatch, restorePatch, status } = require('./patch');
const { isClaudeRunning, restartClaude, stopClaude } = require('./processes');
const {
  ANSI,
  box,
  clearScreen,
  color,
  confirm,
  prompt,
  selectMenu,
  writeLine,
} = require('./terminal');

const PACKAGE = require('../package.json');

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.version) {
    writeLine(PACKAGE.version);
    return 0;
  }
  if (args.command === 'status') return runStatus(args);
  if (args.command === 'apply') return runApply(args);
  if (args.command === 'restore') return runRestore(args);
  return runInteractive(args);
}

function parseArgs(argv) {
  const args = {
    command: null,
    help: false,
    version: false,
    yes: false,
    force: false,
    json: false,
    noBackup: false,
    kill: false,
    restart: false,
    target: null,
  };
  for (const value of argv) {
    if (value === '--help' || value === '-h') args.help = true;
    else if (value === '--version' || value === '-v') args.version = true;
    else if (value === '--yes' || value === '-y') args.yes = true;
    else if (value === '--force') args.force = true;
    else if (value === '--json') args.json = true;
    else if (value === '--no-backup') args.noBackup = true;
    else if (value === '--kill') args.kill = true;
    else if (value === '--restart') args.restart = true;
    else if (value.startsWith('--target=')) args.target = value.slice('--target='.length);
    else if (!value.startsWith('-') && !args.command) args.command = value;
  }
  return args;
}

async function runInteractive() {
  let installations = detectInstallations();
  let selected = preferredInstallation(installations);
  while (true) {
    clearScreen();
    const statusLine = selected
      ? `${installationLabel(selected)}  ${selected.writable ? color('可写', ANSI.green) : color('只读', ANSI.yellow)}`
      : color('未检测到 Claude Desktop', ANSI.yellow);
    const action = await selectMenu({
      title: 'Claude Desktop Render Patch',
      headerLines: [statusLine, color('Mermaid 12 + MathJax 3 full TeX', ANSI.gray)],
      items: [
        { value: 'apply', label: '应用补丁', description: '注入 Mermaid 与完整数学公式渲染' },
        { value: 'restore', label: '恢复原版', description: '从本机备份恢复 app.asar' },
        { value: 'status', label: '检查状态', description: '显示安装、载荷与完整性哈希状态' },
        { value: 'target', label: '切换目标', description: '选择其他 Claude Desktop 安装' },
        { value: 'refresh', label: '重新检测', description: '刷新 Claude Desktop 安装列表' },
        { value: 'quit', label: '退出', description: '' },
      ],
    });
    if (!action || action === 'quit') return 0;
    if (action === 'apply') {
      if (!selected) {
        await showNotice('没有可用的 Claude Desktop 安装。');
        continue;
      }
      await runApply({ ...parseArgs([]), interactive: true, targetInstallation: selected });
    } else if (action === 'restore') {
      if (!selected) {
        await showNotice('没有可用的 Claude Desktop 安装。');
        continue;
      }
      await runRestore({ ...parseArgs([]), interactive: true, targetInstallation: selected });
    } else if (action === 'status') {
      if (!selected) {
        await showNotice('没有可用的 Claude Desktop 安装。');
        continue;
      }
      await runStatus({ json: false, targetInstallation: selected, interactive: true });
    } else if (action === 'target') {
      installations = detectInstallations();
      selected = await chooseInstallation(installations, {});
    } else if (action === 'refresh') {
      installations = detectInstallations();
      selected = preferredInstallation(installations);
    }
  }
}

async function runApply(args = {}) {
  try {
    const installation = args.targetInstallation || await chooseInstallation(detectInstallations(), args);
    if (!installation) throw new Error('没有检测到 Claude Desktop。');
    if (!installation.supported) {
      throw new Error(`Claude ${installation.version} 暂不支持。`);
    }
    const current = status(installation);
    if (current.installed && !args.force && !(await confirm('补丁已经安装，是否重新写入？', true))) {
      return 0;
    }
    if (isClaudeRunning()) {
      if (!args.kill && !(await confirm('Claude Desktop 正在运行，是否关闭后继续？', true))) {
        writeLine(color('已取消。', ANSI.yellow));
        return 1;
      }
      writeLine(color('正在关闭 Claude Desktop...', ANSI.gray));
      stopClaude();
    }
    if (!args.yes && !(await confirm(`将修改 ${installation.appAsar}，继续吗？`, true))) {
      writeLine(color('已取消。', ANSI.yellow));
      return 0;
    }
    writeLine(color('正在创建备份并写入补丁...', ANSI.cyan));
    const result = applyPatch(installation, { noBackup: args.noBackup });
    printApplyReport(result);
    if (args.restart || (args.interactive && await confirm('是否重新启动 Claude Desktop？', true))) {
      restartClaude(installation);
    }
    if (args.interactive) await pause();
    return 0;
  } catch (error) {
    writeLine(color(`应用失败：${error.message}`, ANSI.red));
    if (args.interactive) await pause();
    return 1;
  }
}

async function runRestore(args = {}) {
  try {
    const installation = args.targetInstallation || await chooseInstallation(detectInstallations(), args);
    if (!installation) throw new Error('没有检测到 Claude Desktop。');
    const backups = listBackups(installation);
    if (backups.length === 0) {
      throw new Error('这台安装没有可用备份。');
    }
    const backupId = backups.length === 1
      ? backups[0].id
      : await selectMenu({
        title: '选择恢复点',
        headerLines: [installationLabel(installation)],
        items: backups.map((backup) => ({
          value: backup.id,
          label: backup.id,
          description: `${Math.round(backup.bytes / 1024 / 1024)} MB`,
        })),
      });
    if (!backupId) return 0;
    if (!args.yes && !(await confirm(`恢复 ${backupId}？`, true))) return 0;
    if (isClaudeRunning()) {
      if (!args.kill && !(await confirm('Claude Desktop 正在运行，是否关闭后继续？', true))) return 1;
      stopClaude();
    }
    const result = restorePatch(installation, backupId);
    writeLine('');
    writeLine(color('恢复完成。', ANSI.green));
    writeLine(`  恢复点: ${result.backup}`);
    writeLine(`  迁移载荷: ${result.removed || '无'}`);
    if (args.restart || (args.interactive && await confirm('是否重新启动 Claude Desktop？', true))) {
      restartClaude(installation);
    }
    if (args.interactive) await pause();
    return 0;
  } catch (error) {
    writeLine(color(`恢复失败：${error.message}`, ANSI.red));
    if (args.interactive) await pause();
    return 1;
  }
}

async function runStatus(args = {}) {
  try {
    const installations = args.targetInstallation ? [args.targetInstallation] : detectInstallations();
    const rows = installations.map((installation) => status(installation));
    if (args.json) {
      writeLine(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (rows.length === 0) {
      writeLine(color('未检测到 Claude Desktop。', ANSI.yellow));
      return 1;
    }
    for (const row of rows) {
      const install = row.installation;
      writeLine('');
      writeLine(color(installationLabel(install), ANSI.bold));
      writeLine(`  路径: ${install.appAsar}`);
      writeLine(`  版本: ${install.version}${row.supported ? '' : color(' (不支持)', ANSI.yellow)}`);
      writeLine(`  补丁: ${row.installed ? color('已安装', ANSI.green) : color('未安装', ANSI.gray)}`);
      writeLine(`  载荷: ${row.payloadReady ? color('完整', ANSI.green) : color('缺失或哈希不符', ANSI.yellow)}`);
      writeLine(`  完整性: ${row.hashMatches ? color('匹配', ANSI.green) : color('不匹配', ANSI.red)}`);
      writeLine(`  备份: ${row.backupCount}`);
    }
    if (args.interactive) await pause();
    return 0;
  } catch (error) {
    writeLine(color(`状态检查失败：${error.message}`, ANSI.red));
    if (args.interactive) await pause();
    return 1;
  }
}

function printApplyReport(result) {
  writeLine('');
  writeLine(color('补丁已应用。', ANSI.green));
  writeLine(`  目标版本: ${result.installation.version}`);
  writeLine(`  app.asar: ${result.installation.appAsar}`);
  writeLine(`  载荷目录: ${result.payload.directory}`);
  writeLine(`  备份: ${result.backup || '未创建'}`);
  writeLine(`  头部哈希: ${result.headerHash.slice(0, 16)}...`);
}

function preferredInstallation(installations) {
  return installations.find((item) => item.supported && item.writable) || installations[0] || null;
}

async function chooseInstallation(installations, args) {
  if (args.target) {
    const hit = installations.find((item) => item.id === args.target || item.appAsar === args.target);
    if (!hit) throw new Error(`找不到目标: ${args.target}`);
    return hit;
  }
  if (installations.length === 0) return null;
  if (installations.length === 1) return installations[0];
  return selectMenu({
    title: '选择 Claude Desktop 安装',
    items: installations.map((installation) => ({
      value: installation,
      label: installationLabel(installation),
      description: installation.appAsar,
    })),
  });
}

function installationLabel(installation) {
  return `${installation.kind} · Claude ${installation.version}`;
}

async function showNotice(message) {
  writeLine('');
  writeLine(color(message, ANSI.yellow));
  await pause();
}

async function pause() {
  try {
    await prompt('按 Enter 返回菜单...');
  } catch (_) {
    // Ignore a closed stdin.
  }
}

function printHelp() {
  const lines = [
    'Claude Desktop Render Patch',
    '',
    '用法:',
    '  claude-render-patch                交互式菜单',
    '  claude-render-patch apply          应用补丁',
    '  claude-render-patch restore        恢复最近备份',
    '  claude-render-patch status         检查状态',
    '',
    '选项:',
    '  --yes              跳过确认',
    '  --force            已安装时重新写入',
    '  --no-backup        不创建备份（不建议）',
    '  --kill             自动关闭 Claude Desktop',
    '  --restart          操作后重新启动 Claude Desktop',
    '  --target=<id|路径> 指定安装目标',
    '  --json             status 输出 JSON',
    '  -h, --help         显示帮助',
    '  -v, --version      显示版本',
  ];
  writeLine(lines.join('\n'));
}

module.exports = { main, runApply, runRestore, runStatus };
