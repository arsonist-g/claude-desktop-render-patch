'use strict';

const readline = require('readline');

const ESC = '\x1b[';
const ANSI = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
  gray: `${ESC}90m`,
  brightCyan: `${ESC}96m`,
  brightWhite: `${ESC}97m`,
  clear: `${ESC}2J${ESC}3J${ESC}H`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
};

function color(text, code) {
  if (!process.stdout.isTTY || !code) return String(text);
  return `${code}${text}${ANSI.reset}`;
}

function clearScreen() {
  if (process.stdout.isTTY) process.stdout.write(ANSI.clear);
}

function hideCursor() {
  if (process.stdout.isTTY) process.stdout.write(ANSI.hideCursor);
}

function showCursor() {
  if (process.stdout.isTTY) process.stdout.write(ANSI.showCursor);
}

function writeLine(text = '') {
  process.stdout.write(`${text}\n`);
}

function box(title, lines, width = 62) {
  const inner = Math.max(1, width - 2);
  const titleText = title ? ` ${title} ` : '';
  const top = `╭${titleText}${'─'.repeat(Math.max(0, inner - titleText.length))}╮`;
  const body = lines.map((line) => `│${padRight(String(line), inner)}│`);
  const bottom = `╰${'─'.repeat(inner)}╯`;
  return [top, ...body, bottom];
}

function padRight(value, width) {
  const visible = visibleLength(value);
  return value + ' '.repeat(Math.max(0, width - visible));
}

function visibleLength(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '').length;
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function confirm(question, defaultValue = false) {
  const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] ';
  const answer = String(await prompt(question + suffix)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === 'y' || answer === 'yes' || answer === '是';
}

async function selectMenu(options) {
  const items = options.items.filter((item) => !item.hidden);
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CI) {
    return selectNumbered(options, items);
  }
  if (items.length === 0) return null;
  let index = Math.max(0, items.findIndex((item) => item.selected));
  if (index < 0) index = 0;
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  hideCursor();

  return new Promise((resolve) => {
    const render = () => {
      clearScreen();
      const lines = [];
      lines.push(...box(options.title || '', options.headerLines || []));
      lines.push('');
      items.forEach((item, itemIndex) => {
        const active = itemIndex === index;
        const cursor = active ? color('❯', ANSI.brightCyan) : ' ';
        const label = active ? color(item.label, ANSI.bold + ANSI.brightWhite) : item.label;
        const description = item.description ? color(`  ${item.description}`, ANSI.gray) : '';
        lines.push(`${cursor} ${label}${description}`);
      });
      lines.push('');
      lines.push(color(options.footer || '↑/↓ 选择   Enter 确认   q 退出', ANSI.gray));
      process.stdout.write(lines.join('\n') + '\n');
    };
    const cleanup = () => {
      stdin.removeListener('keypress', onKey);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      showCursor();
    };
    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + items.length) % items.length;
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % items.length;
        render();
      } else if (key.name === 'return' || key.name === 'enter' || key.name === 'space') {
        cleanup();
        resolve(items[index].value);
      } else if (key.name === 'q' || key.name === 'escape') {
        cleanup();
        resolve(null);
      }
    };
    stdin.on('keypress', onKey);
    render();
  });
}

async function selectNumbered(options, items) {
  writeLine(options.title || '');
  (options.headerLines || []).forEach((line) => writeLine(line));
  items.forEach((item, index) => {
    writeLine(`  ${index + 1}. ${item.label}${item.description ? `  ${item.description}` : ''}`);
  });
  const answer = String(await prompt('请选择: ')).trim();
  if (answer.toLowerCase() === 'q') return null;
  const index = Number(answer) - 1;
  return items[index] ? items[index].value : null;
}

module.exports = {
  ANSI,
  box,
  clearScreen,
  color,
  confirm,
  hideCursor,
  padRight,
  prompt,
  selectMenu,
  showCursor,
  visibleLength,
  writeLine,
};
