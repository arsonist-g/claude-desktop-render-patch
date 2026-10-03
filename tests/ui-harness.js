#!/usr/bin/env node
'use strict';

/*
 * Drives the renderer runtime in a real Chromium browser (Edge headless) over
 * the DevTools protocol and checks the card toolbar: zoom, drag panning, the
 * pan clamp and the full-view modal.
 *
 * Usage: node tests/ui-harness.js [--edge=<path>] [--keep]
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'tests', 'fixture.html');
const port = Number(process.env.TPR_HARNESS_PORT || 9455);
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const edgeArg = args.find((value) => value.startsWith('--edge='));
const EDGE_CANDIDATES = [
  edgeArg ? edgeArg.slice('--edge='.length) : '',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const failures = [];
const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push(`ok   ${name}`);
  } catch (error) {
    failures.push(`FAIL ${name}: ${error.message}`);
    checks.push(`FAIL ${name}: ${error.message}`);
  }
}

function findBrowser() {
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fileUrl(target) {
  const normalized = target.replace(/\\/g, '/');
  return `file:///${normalized.replace(/^\//, '')}`;
}

async function waitForTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) {
      /* the browser is still starting */
    }
    await sleep(200);
  }
  throw new Error('DevTools endpoint did not become ready');
}

function createClient(url, onEvent) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    socket.onerror = (event) => reject(new Error(`websocket error: ${event && event.message}`));
    socket.onclose = () => {
      for (const { reject: fail } of pending.values()) {
        fail(new Error('devtools connection closed'));
      }
      pending.clear();
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method && typeof onEvent === 'function') onEvent(message);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else entry.resolve(message.result);
    };
    socket.onopen = () => {
      resolve({
        send(method, params) {
          nextId += 1;
          const id = nextId;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            socket.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        close() {
          socket.close();
        },
      });
    };
  });
}

function value(result) {
  if (result && result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception
      ? result.exceptionDetails.exception.description || result.exceptionDetails.text
      : result.exceptionDetails.text);
  }
  return result && result.result ? result.result.value : undefined;
}

async function main() {
  const browser = findBrowser();
  assert(browser, 'no Edge/Chromium binary found; pass --edge=<path>');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tpr-ui-'));
  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1200,900',
    fileUrl(fixture),
  ], { stdio: 'ignore' });

  let client;
  const consoleErrors = [];
  try {
    const target = await waitForTarget(20000);
    client = await createClient(target.webSocketDebuggerUrl, (message) => {
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails || {};
        consoleErrors.push(details.exception ? details.exception.description : details.text);
      } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        consoleErrors.push(message.params.entry.text);
      }
    });
    await client.send('Runtime.enable');
    await client.send('Log.enable');
    await client.send('Page.enable');
    const evaluate = async (expression) => value(await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }));

    const deadline = Date.now() + 30000;
    let rendered = 0;
    while (Date.now() < deadline) {
      rendered = await evaluate("document.querySelectorAll('.tpr-rendered.tpr-mermaid .tpr-content svg').length");
      const ready = await evaluate("!!(document.querySelector('#tall-case .tpr-content svg') && document.querySelector('#wide-case .tpr-content svg'))");
      if (rendered >= 3 && ready) break;
      await sleep(300);
    }
    check('fixture renders mermaid cards', () => assert(rendered >= 3, `only ${rendered} diagrams rendered`));

    // --- geometry of the tall card -------------------------------------
    const tall = await evaluate(`(() => {
      const card = document.querySelector('#tall-case .tpr-rendered');
      if (!card) return null;
      card.scrollIntoView({ block: 'center' });
      const content = card.querySelector('.tpr-content');
      const svg = content.querySelector('svg');
      const plus = card.querySelectorAll('.tpr-actions button')[2];
      const expand = card.querySelector('.tpr-expand');
      const rectOf = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; };
      return {
        content: rectOf(content),
        plus: rectOf(plus),
        expand: rectOf(expand),
        svg: rectOf(svg),
        pannable: content.dataset.pannable,
        cap: getComputedStyle(content).maxHeight,
        overflow: getComputedStyle(content).overflow,
      };
    })()`);
    check('tall card exists', () => assert(tall, 'tall card not found'));
    check('tall card is pannable', () => assert.strictEqual(tall.pannable, 'true', `data-pannable=${tall.pannable}`));
    check('preview height follows the container width', () => assert(tall.content.h <= tall.content.w + 1, `height ${tall.content.h} vs width ${tall.content.w}`));
    check('preview clips its content without becoming a scroll box', () => assert.strictEqual(tall.overflow, 'clip', `overflow=${tall.overflow}`));
    const wheelPassThrough = await evaluate(`(() => {
      const el = document.querySelector('#tall-case .tpr-content');
      const before = el.scrollTop;
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
      return { before: before, after: el.scrollTop, scrollable: el.scrollHeight > el.clientHeight };
    })()`);
    check('the wheel never scrolls the clipped preview box itself', () => assert(wheelPassThrough.after === 0, JSON.stringify(wheelPassThrough)));

    const mouse = (type, x, y, extra) => client.send('Input.dispatchMouseEvent', Object.assign({
      type,
      x,
      y,
      button: 'left',
      clickCount: 1,
      buttons: type === 'mouseReleased' ? 0 : 1,
    }, extra || {}));

    const wheel = (x, y, deltaY, modifiers) => client.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: modifiers || 0,
    });

    // --- card toolbar ----------------------------------------------------
    const metrics = () => evaluate(`(() => {
      const card = document.querySelector('#tall-case .tpr-rendered');
      const content = card.querySelector('.tpr-content');
      const svg = content.querySelector('svg');
      const actions = Array.prototype.slice.call(card.querySelectorAll('.tpr-actions button'));
      return {
        visibleActions: actions.filter((b) => getComputedStyle(b).display !== 'none').length,
        box: Math.round(content.getBoundingClientRect().width),
        svg: Math.round(svg.getBoundingClientRect().width),
        layout: Math.round(svg.getBoundingClientRect().width)
      };
    })()`);
    const beforeZoom = await metrics();
    check('card keeps copy, zoom out, zoom in and expand', () => assert(beforeZoom.visibleActions === 4, JSON.stringify(beforeZoom)));
    const initialFit = await evaluate(`(() => {
      const content = document.querySelector('#tall-case .tpr-content');
      const svg = content.querySelector('svg');
      return {
        box: Math.round(content.clientWidth),
        svg: Math.round(svg.getBoundingClientRect().width),
        natural: Math.round(Number(svg.dataset.tprNaturalWidth || 0)),
        overflows: svg.getBoundingClientRect().width > content.clientWidth + 3
      };
    })()`);
    // 新契约：卡片宽度以容器为上限、以图自然宽度为准，不再把小图硬拉到满宽
    check('card view does not stretch the diagram past its natural width',
      () => assert(typeof initialFit.natural === 'number' && initialFit.natural > 0 && initialFit.svg <= initialFit.natural + 3,
        JSON.stringify(initialFit)));
    check('card view keeps the diagram inside its box',
      () => assert(!initialFit.overflows, JSON.stringify(initialFit)));

    const hostCopy = await evaluate(`(() => {
      const node = document.querySelector('#host-copy');
      return { exists: !!node, hidden: !!node && getComputedStyle(node).display === 'none' };
    })()`);
    check('host copy-code button is hidden under our card', () => assert(hostCopy.exists && hostCopy.hidden, JSON.stringify(hostCopy)));

    await sleep(2200);
    const lateHostCopy = await evaluate(`(() => {
      const node = document.querySelector('#late-host-copy');
      return { exists: !!node, hidden: !!node && getComputedStyle(node).display === 'none' };
    })()`);
    check('copy-code button added later is hidden too', () => assert(lateHostCopy.exists && lateHostCopy.hidden, JSON.stringify(lateHostCopy)));

    const shellCopy = await evaluate(`(() => {
      const node = document.querySelector('#empty-shell-copy');
      return { exists: !!node, label: node ? node.getAttribute('aria-label') : null, hidden: !!node && getComputedStyle(node).display === 'none' };
    })()`);
    check('copy button that only gets its label on hover is hidden too', () => assert(shellCopy.hidden, JSON.stringify(shellCopy)));

    // 悬浮层（挂在 body 上、盖在卡片上）也要藏；离卡片很远的复制按钮不能动
    await evaluate(`(() => {
      const card = document.querySelector('#tall-case .tpr-rendered');
      const rect = card.getBoundingClientRect();
      const portal = document.createElement('button');
      portal.id = 'portal-copy';
      portal.textContent = 'Copy code';
      portal.style.cssText = 'position:fixed;z-index:99999;left:' + Math.round(rect.right - 90) + 'px;top:' + Math.round(rect.top - 30) + 'px';
      document.body.appendChild(portal);
      const far = document.createElement('button');
      far.id = 'far-copy';
      far.setAttribute('aria-label', 'Copy code');
      far.textContent = 'Copy code';
      far.style.cssText = 'position:fixed;z-index:99999;left:-4000px;top:-4000px';
      document.body.appendChild(far);
    })()`);
    await sleep(400);
    await evaluate(`(() => {
      const card = document.querySelector('#tall-case .tpr-rendered');
      const rect = card.getBoundingClientRect();
      const wrapped = document.createElement('button');
      wrapped.id = 'wrapped-copy';
      wrapped.style.cssText = 'position:fixed;z-index:99999;left:' + Math.round(rect.right - 120) + 'px;top:' + Math.round(rect.top - 34) + 'px;width:70px;height:26px';
      const inner = document.createElement('span');
      inner.textContent = 'Copy code';
      wrapped.appendChild(inner);
      document.body.appendChild(wrapped);
    })()`);
    await sleep(400);
    const wrappedCheck = await evaluate(`(() => {
      const button = document.getElementById('wrapped-copy');
      const inner = button ? button.querySelector('span') : null;
      return {
        buttonHidden: !!button && getComputedStyle(button).display === 'none',
        innerHidden: !!inner && getComputedStyle(inner).display === 'none'
      };
    })()`);
    check('hiding a copy control hides its clickable button, not just the label', () => assert(wrappedCheck.buttonHidden, JSON.stringify(wrappedCheck)));

    await evaluate(`(() => {
      const card = document.querySelector('#tall-case .tpr-rendered');
      const rect = card.getBoundingClientRect();
      const shell = document.createElement('div');
      shell.id = 'plain-div-copy';
      shell.style.cssText = 'position:fixed;z-index:99999;left:' + Math.round(rect.right - 200) + 'px;top:' + Math.round(rect.top - 34) + 'px;width:74px;height:26px';
      const label = document.createElement('span');
      label.textContent = 'Copy code';
      shell.appendChild(label);
      document.body.appendChild(shell);
    })()`);
    await sleep(400);
    const plainDiv = await evaluate(`(() => {
      const shell = document.getElementById('plain-div-copy');
      const label = shell ? shell.querySelector('span') : null;
      return {
        shellHidden: !!shell && getComputedStyle(shell).display === 'none',
        labelHidden: !!label && getComputedStyle(label).display === 'none'
      };
    })()`);
    check('a plain div shell around the copy label is hidden too', () => assert(plainDiv.shellHidden, JSON.stringify(plainDiv)));

    await evaluate(`(() => {
      const card = document.querySelector('#tall-case .tpr-rendered');
      const band = card.querySelector('.tpr-toolbar').getBoundingClientRect();
      const overlay = document.createElement('div');
      overlay.id = 'blank-overlay';
      overlay.style.cssText = 'position:fixed;z-index:99999;left:' + Math.round(band.left + 20) + 'px;top:' + Math.round(band.top) + 'px;width:120px;height:' + Math.round(band.height) + 'px';
      document.body.appendChild(overlay);
    })()`);
    await sleep(1800);
    const overlayCheck = await evaluate(`(() => {
      const node = document.getElementById('blank-overlay');
      return { hidden: !!node && getComputedStyle(node).display === 'none' };
    })()`);
    // 契约更正：任意"压住工具栏"的普通元素不再隐藏；只有宿主复制控件才隐。
    // 旧断言要求这个空白 div 必须被隐藏，正是误删对话框/按钮的根因，故反转。
    check('a plain blank div over the card toolbar is left visible', () => assert(!overlayCheck.hidden, JSON.stringify(overlayCheck)));
    await evaluate("(() => { const node = document.getElementById('blank-overlay'); if (node) node.remove(); })()");

    await evaluate(`(() => {
      const card = document.querySelector('#tall-case .tpr-rendered');
      const block = document.createElement('div');
      block.className = 'epitaxy-codeblock';
      const strip = document.createElement('div');
      strip.id = 'mock-host-strip';
      strip.className = 'pointer-events-auto sticky flex';
      const inner = document.createElement('div');
      inner.className = 'pointer-events-none absolute inset-y-0 right-2';
      strip.appendChild(inner);
      block.appendChild(strip);
      const marker = document.createElement('div');
      marker.className = 'tpr-rendered';
      block.appendChild(marker);
      const holder = card.parentElement;
      holder.appendChild(block);
    })()`);
    await sleep(300);
    const mockStrip = await evaluate(`(() => {
      const strip = document.getElementById('mock-host-strip');
      return { hidden: !!strip && getComputedStyle(strip).display === 'none' };
    })()`);
    check('host codeblock toolbar layer is hidden by CSS', () => assert(mockStrip.hidden, JSON.stringify(mockStrip)));

    const layered = await evaluate(`(() => {
      const card = document.querySelector('#tall-case .tpr-rendered');
      const toolbar = card.querySelector('.tpr-toolbar');
      return {
        toolbarZ: Number(getComputedStyle(toolbar).zIndex),
        cardZ: Number(getComputedStyle(card).zIndex)
      };
    })()`);
    check('our toolbar sits above host layers', () => assert(layered.toolbarZ > 1000000, JSON.stringify(layered)));

    const stray = await evaluate(`(() => {
      const portal = document.getElementById('portal-copy');
      const far = document.getElementById('far-copy');
      return {
        portalHidden: !!portal && getComputedStyle(portal).display === 'none',
        farHidden: !!far && getComputedStyle(far).display === 'none'
      };
    })()`);
    check('a floating copy control over the card is hidden', () => assert(stray.portalHidden, JSON.stringify(stray)));
    check('copy controls away from our cards are left alone', () => assert(!stray.farHidden, JSON.stringify(stray)));

    await mouse('mousePressed', tall.plus.cx, tall.plus.cy);
    await mouse('mouseReleased', tall.plus.cx, tall.plus.cy);
    await sleep(350);
    const afterButton = await metrics();
    check('card zoom in enlarges the diagram', () => assert(afterButton.svg > beforeZoom.svg + 1, `${beforeZoom.svg} -> ${afterButton.svg}`));
    check('card zoom keeps the container width', () => assert(Math.abs(afterButton.box - beforeZoom.box) <= 1, `${beforeZoom.box} -> ${afterButton.box}`));

    await wheel(tall.content.cx, tall.content.cy, -120, 2);
    await sleep(300);
    const afterWheel = await metrics();
    check('ctrl + wheel zooms the card too', () => assert(afterWheel.svg > afterButton.svg + 1, `${afterButton.svg} -> ${afterWheel.svg}`));
    check('ctrl + wheel keeps the container width', () => assert(Math.abs(afterWheel.box - beforeZoom.box) <= 1, `${beforeZoom.box} -> ${afterWheel.box}`));

    // 把卡片缩放还原到 1，后面的拖动断言在原始比例下做
    const minusPoint = await evaluate(`(() => {
      const card = document.querySelector('#tall-case .tpr-rendered');
      const r = card.querySelectorAll('.tpr-actions button')[1].getBoundingClientRect();
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    })()`);
    for (let i = 0; i < 6; i += 1) {
      const current = Number(await evaluate("document.querySelector('#tall-case .tpr-rendered').dataset.tprZoom || '1'"));
      if (current <= 1.001) break;
      await mouse('mousePressed', minusPoint.cx, minusPoint.cy);
      await mouse('mouseReleased', minusPoint.cx, minusPoint.cy);
      await sleep(150);
    }
    const backToOne = await evaluate("document.querySelector('#tall-case .tpr-rendered').dataset.tprZoom || '1'");
    check('zoom out returns the card to its initial scale', () => assert(Math.abs(Number(backToOne) - 1) <= 0.01, `zoom=${backToOne}`));

    // --- drag panning ---------------------------------------------------
    const startX = tall.content.cx;
    const startY = tall.content.cy;
    await mouse('mousePressed', startX, startY);
    await mouse('mouseMoved', startX - 60, startY - 90, { buttons: 1 });
    await sleep(80);
    const mid = await evaluate("document.querySelector('#tall-case .tpr-content svg').style.transform");
    await mouse('mouseReleased', startX - 60, startY - 90, { buttons: 0 });
    check('dragging follows the pointer', () => assert(/^translate\(0px,-[\d.]+px\)(scale\([\d.]+\))?$/.test(String(mid || '').replace(/\s+/g, '')), `transform=${mid}`));

    const coverage = await evaluate(`(() => {
      const content = document.querySelector('#tall-case .tpr-content');
      const svg = content.querySelector('svg');
      const box = content.getBoundingClientRect();
      const rect = svg.getBoundingClientRect();
      return { top: rect.top - box.top, bottom: box.bottom - rect.bottom, height: rect.height, boxHeight: box.height };
    })()`);
    check('a panned diagram still covers the preview', () => {
      assert(coverage.height > coverage.boxHeight, `svg ${coverage.height} vs box ${coverage.boxHeight}`);
      assert(coverage.top <= 1, `blank strip above the diagram: ${coverage.top}`);
      assert(coverage.bottom <= 1, `blank strip below the diagram: ${coverage.bottom}`);
    });

    // dragging far past the edge must stop with the diagram edge on the box edge
    await mouse('mousePressed', startX, startY);
    await mouse('mouseMoved', startX, startY - 4000, { buttons: 1 });
    await sleep(80);
    const clamped = await evaluate(`(() => {
      const content = document.querySelector('#tall-case .tpr-content');
      const svg = content.querySelector('svg');
      const box = content.getBoundingClientRect();
      const rect = svg.getBoundingClientRect();
      return { transform: svg.style.transform, bottomGap: rect.bottom - box.bottom, topGap: rect.top - box.top };
    })()`);
    await mouse('mouseReleased', startX, startY - 4000, { buttons: 0 });
    check('vertical panning stops at the last line', () => {
      assert(/translate/.test(clamped.transform || ''), `no pan: ${clamped.transform}`);
      assert(Math.abs(clamped.bottomGap) <= 2, `diagram bottom is ${clamped.bottomGap}px from the box bottom`);
      assert(clamped.topGap < 0, 'the diagram did not move up');
    });

    // a narrow diagram must not slide sideways
    const sideways = await evaluate("document.querySelector('#tall-case .tpr-content svg').style.transform");
    check('a vertically-only diagram does not drift sideways', () => assert(/^translate\(0px,-/.test(String(sideways || '').replace(/\s+/g, '')), `transform=${sideways}`));

    // --- modal ----------------------------------------------------------
    const openModal = async () => {
      const button = await evaluate(`(() => {
        const card = document.querySelector('#tall-case .tpr-rendered');
        card.scrollIntoView({ block: 'center' });
        const node = card.querySelector('.tpr-expand');
        const rect = node.getBoundingClientRect();
        return { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 };
      })()`);
      await mouse('mousePressed', button.cx, button.cy);
      await mouse('mouseReleased', button.cx, button.cy);
      await sleep(500);
    };
    const modalState = () => evaluate(`(() => {
      const modal = document.getElementById('tpr-modal');
      const panel = modal && modal.querySelector('.tpr-modal-panel');
      const cardNode = document.querySelector('#tall-case .tpr-rendered');
      const cardRect = cardNode && cardNode.querySelector('.tpr-content')
        ? cardNode.querySelector('.tpr-content').getBoundingClientRect()
        : (cardNode ? cardNode.getBoundingClientRect() : null);
      const svg = modal && modal.querySelector('.tpr-modal-content svg');
      const plus = modal && modal.querySelectorAll('.tpr-modal-panel .tpr-actions button')[2];
      const p = panel ? panel.getBoundingClientRect() : null;
      const r = svg ? svg.getBoundingClientRect() : null;
      const q = plus ? plus.getBoundingClientRect() : null;
      return {
        hidden: !modal || modal.hidden,
        hasSvg: !!svg,
        fits: !!(p && r && r.width <= p.width + 1 && r.height <= p.height + 1),
        frame: p ? [Math.round(p.width), Math.round(p.height)] : null,
        svgWidth: r ? Math.round(r.width) : 0,
        toolbarInPanel: !!(modal && modal.querySelector('.tpr-modal-panel > .tpr-toolbar')),
        frameMatchesCard: !!(p && cardRect && Math.abs(p.width - cardRect.width) <= 2),
        frameWiderThanCard: !!(p && cardRect && p.width > cardRect.width + 2),
        withinViewport: !!(p && p.width <= window.innerWidth + 1 && p.height <= window.innerHeight + 1),
        zoomButtons: modal ? Array.prototype.filter.call(modal.querySelectorAll('.tpr-zoom'), (b) => getComputedStyle(b).display !== 'none').length : 0,
        plus: q ? { cx: q.x + q.width / 2, cy: q.y + q.height / 2 } : null
      };
    })()`);

    await openModal();
    const opened = await modalState();
    check('expand opens the full view', () => assert(!opened.hidden, 'modal stayed hidden'));
    check('full view shows the diagram', () => assert(opened.hasSvg, 'modal has no svg'));
    check('full view fits the whole diagram inside a fixed frame', () => assert(opened.fits, JSON.stringify(opened.frame)));
    check('full view carries the action bar', () => assert(opened.toolbarInPanel && opened.plus, JSON.stringify(opened)));
    // 新契约：全屏用视口大小，不再被卡片宽度限制，小图才有放大空间
    check('full view frame uses the viewport, not the card width',
      () => assert(opened.frameWiderThanCard && opened.withinViewport,
        JSON.stringify({ frame: opened.frame, wider: opened.frameWiderThanCard, withinViewport: opened.withinViewport })));
    check('full view shows the zoom buttons', () => assert(opened.zoomButtons === 2, `visible zoom buttons: ${opened.zoomButtons}`));

    await mouse('mousePressed', opened.plus.cx, opened.plus.cy);
    await mouse('mouseReleased', opened.plus.cx, opened.plus.cy);
    await sleep(400);
    const zoomed = await modalState();
    check('zoom buttons scale the diagram inside the full view', () => assert(zoomed.svgWidth > opened.svgWidth + 1, `${opened.svgWidth} -> ${zoomed.svgWidth}`));
    check('zooming does not resize the full view frame', () => assert(zoomed.frame[0] === opened.frame[0] && zoomed.frame[1] === opened.frame[1], `${opened.frame} -> ${zoomed.frame}`));

    // ctrl + wheel zooms, plain wheel pans
    const beforeWheel = await modalState();
    await wheel(beforeWheel.plus.cx, 300, -120, 2);
    await sleep(300);
    const afterWheelZoom = await modalState();
    check('ctrl + wheel zooms in the full view', () => assert(afterWheelZoom.svgWidth > beforeWheel.svgWidth + 1, `${beforeWheel.svgWidth} -> ${afterWheelZoom.svgWidth}`));
    check('ctrl + wheel keeps the frame size', () => assert(afterWheelZoom.frame[0] === beforeWheel.frame[0] && afterWheelZoom.frame[1] === beforeWheel.frame[1], `${beforeWheel.frame} -> ${afterWheelZoom.frame}`));
    await wheel(beforeWheel.plus.cx, 300, 120, 2);
    await sleep(300);
    const afterWheelOut = await modalState();
    check('ctrl + wheel zooms back out', () => assert(Math.abs(afterWheelOut.svgWidth - beforeWheel.svgWidth) <= 3, `${beforeWheel.svgWidth} -> ${afterWheelOut.svgWidth}`));

    // 先把图放大到确实超出全屏内容盒，再验证拖动被夹在框内
    const overflowBeforeDrag = await evaluate(`(() => {
      const content = document.querySelector('#tpr-modal .tpr-modal-content');
      const svg = content && content.querySelector('svg');
      if (!svg) return false;
      const r = svg.getBoundingClientRect();
      return r.height > content.clientHeight + 1 || r.width > content.clientWidth + 1;
    })()`);
    check('full view diagram overflows after zoom for the drag test', () => assert(overflowBeforeDrag, 'diagram did not overflow the full view'));
    await mouse('mousePressed', 400, 320);
    await mouse('mouseMoved', 400, 120, { buttons: 1 });
    await mouse('mouseMoved', 400, -3000, { buttons: 1 });
    await sleep(80);
    const modalPan = await evaluate(`(() => {
      const content = document.querySelector('#tpr-modal .tpr-modal-content');
      const svg = content && content.querySelector('svg');
      if (!svg) return { bottomGap: 999 };
      const b = content.getBoundingClientRect();
      const r = svg.getBoundingClientRect();
      return {
        transform: svg.style.transform,
        bottomGap: b.bottom - r.bottom,
        topGap: r.top - b.top,
        contentHeight: b.height,
        svgHeight: r.height
      };
    })()`);
    await mouse('mouseReleased', 400, -3000, { buttons: 0 });
    // 向下猛拖到底后，图应被夹住：底边贴到内容盒底部（或顶边贴顶）。
    check('dragging in the full view is clamped to the frame',
      () => assert(Math.abs(modalPan.bottomGap) <= 3 || Math.abs(modalPan.topGap) <= 3, JSON.stringify(modalPan)));

    await evaluate("document.querySelector('#tpr-modal .tpr-modal-close').click()");
    await sleep(400);
    const closed = await evaluate(`(() => {
      const modal = document.getElementById('tpr-modal');
      const card = document.querySelector('#tall-case .tpr-content svg');
      const bar = document.querySelector('#tall-case .tpr-rendered > .tpr-toolbar');
      return { hidden: modal.hidden, backInCard: !!card, transform: card ? card.style.transform : null, toolbarBack: !!bar };
    })()`);
    check('closing the full view restores the card', () => assert(closed.hidden && closed.backInCard, JSON.stringify(closed)));
    check('closing the full view returns the action bar to the card', () => assert(closed.toolbarBack, JSON.stringify(closed)));
    check('closing the full view resets the pan', () => {
      const value = String(closed.transform || '');
      assert(value === '' || /^translate\(0px,\s*0px\)/.test(value), `transform=${closed.transform}`);
    });

    // --- small diagram sizing --------------------------------------------
    // 回归：小竖图在卡片里不应被硬拉到容器宽度而高出预览框；全屏里应放大到放得下的大小。
    await evaluate(`(() => {
      const host = document.createElement('div');
      host.className = 'message';
      host.id = 'small-case';
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-mermaid';
      code.textContent = 'flowchart TD\\n  N1[开始] --> N2[处理]\\n  N2 --> N3[结束]';
      pre.appendChild(code);
      host.appendChild(pre);
      document.body.appendChild(host);
    })()`);
    let smallReady = false;
    for (let i = 0; i < 40; i += 1) {
      smallReady = await evaluate("!!document.querySelector('#small-case .tpr-content svg')");
      if (smallReady) break;
      await sleep(250);
    }
    check('small diagram card renders', () => assert(smallReady, 'small diagram never rendered'));
    const smallCard = await evaluate(`(() => {
      const card = document.querySelector('#small-case');
      const content = card && card.querySelector('.tpr-content');
      const svg = content && content.querySelector('svg');
      if (!svg) return null;
      const cs = getComputedStyle(content);
      return {
        natural: Math.round(Number(svg.dataset.tprNaturalWidth || 0)),
        contentWidth: Math.round(content.clientWidth),
        svgWidth: Math.round(svg.getBoundingClientRect().width),
        scrollWidth: content.scrollWidth,
        scrollHeight: content.scrollHeight,
        clientHeight: content.clientHeight,
        pannable: content.dataset.pannable
      };
    })()`);
    check('a small diagram is not stretched beyond its natural width',
      () => assert(smallCard && smallCard.natural > 0 && smallCard.svgWidth <= smallCard.natural + 3,
        JSON.stringify(smallCard)));
    check('a small diagram does not need scrolling inside its card',
      () => assert(smallCard && smallCard.scrollWidth <= smallCard.contentWidth + 3 && smallCard.scrollHeight <= smallCard.clientHeight + 3,
        JSON.stringify(smallCard)));

    await evaluate("document.querySelector('#small-case .tpr-expand').click()");
    await sleep(700);
    const smallFull = await evaluate(`(() => {
      const modal = document.getElementById('tpr-modal');
      const svg = modal && modal.querySelector('.tpr-modal-content svg');
      const content = modal && modal.querySelector('.tpr-modal-content');
      const panel = modal && modal.querySelector('.tpr-modal-panel');
      if (!svg || !panel) return null;
      const p = panel.getBoundingClientRect();
      const r = svg.getBoundingClientRect();
      return {
        svgWidth: Math.round(r.width),
        svgHeight: Math.round(r.height),
        fits: r.width <= p.width + 1 && r.height <= p.height + 1,
        modalOverflow: content.scrollWidth > content.clientWidth + 3 || content.scrollHeight > content.clientHeight + 3
      };
    })()`);
    const smallCardWidth = smallCard ? smallCard.svgWidth : 0;
    check('small diagram fills the full view instead of staying tiny',
      () => assert(smallFull && smallFull.svgWidth > smallCardWidth + 20, JSON.stringify(Object.assign({ cardWidth: smallCardWidth }, smallFull))));
    check('full view keeps the enlarged small diagram fully visible',
      () => assert(smallFull && smallFull.fits && !smallFull.modalOverflow, JSON.stringify(smallFull)));
    await evaluate("(() => { const node = document.getElementById('tpr-modal'); if (node) node.remove(); })()");

    // --- copy button -----------------------------------------------------
    const copyIcon = await evaluate(`(() => {
      const card = document.querySelector('#tall-case .tpr-rendered');
      return card.querySelectorAll('.tpr-actions button')[0].textContent;
    })()`);
    const copyPoint = await evaluate(`(() => {
      const card = document.querySelector('#tall-case .tpr-rendered');
      const r = card.querySelectorAll('.tpr-actions button')[0].getBoundingClientRect();
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    })()`);
    await mouse('mousePressed', copyPoint.cx, copyPoint.cy);
    await mouse('mouseReleased', copyPoint.cx, copyPoint.cy);
    await sleep(200);
    const ticked = await evaluate("document.querySelector('#tall-case .tpr-rendered .tpr-actions button').textContent");
    await sleep(1600);
    const restored = await evaluate("document.querySelector('#tall-case .tpr-rendered .tpr-actions button').textContent");
    check('copy shows a tick', () => assert(ticked === '✓', `icon=${ticked}`));
    check('copy icon goes back on its own', () => assert(restored === copyIcon, `${copyIcon} -> ${ticked} -> ${restored}`));

    // --- math ------------------------------------------------------------
    await sleep(1500);
    const mathChecks = await evaluate(`(() => {
      const split = document.getElementById('split-math');
      const chem = document.getElementById('chem-math');
      return {
        splitRendered: !!(split && split.querySelector('mjx-container')),
        chemRendered: !!(chem && chem.querySelector('mjx-container')),
        splitText: split ? split.textContent.slice(0, 24) : null
      };
    })()`);
    check('multi-node display math is typeset', () => assert(mathChecks.splitRendered, JSON.stringify(mathChecks)));
    check('mhchem chemistry is typeset', () => assert(mathChecks.chemRendered, JSON.stringify(mathChecks)));
    const lateRegistration = await evaluate(`(async () => {
      const api = window.__claudeThirdPartyRender;
      api.ensureMhchemNow();
      const p = document.createElement('p');
      const bs = String.fromCharCode(92);
      p.textContent = bs + '(' + bs + 'ce{NaCl}' + bs + ')';
      document.body.appendChild(p);
      await window.MathJax.typesetPromise([p]);
      const ok = !!p.querySelector('mjx-container') || !!p.closest('mjx-container');
      const text = (p.textContent || '').slice(0, 16);
      const tag = p.firstElementChild ? p.firstElementChild.tagName : null;
      p.remove();
      return { ok: ok, text: text, tag: tag };
    })()`);
    check('mhchem renders after late registration', () => assert(lateRegistration.ok, JSON.stringify(lateRegistration)));

    await sleep(2500);
    const katexChem = await evaluate(`(() => {
      const host = document.getElementById('host-katex');
      const rerendered = host ? host.querySelector('[data-tpr-chem="1"]') : null;
      return {
        hasOriginal: !!(host && host.querySelector('.katex:not([data-tpr-chem])')),
        rerendered: !!rerendered,
        error: !!(rerendered && rerendered.querySelector('.katex-error')),
        markup: rerendered ? rerendered.innerHTML.slice(0, 60) : null
      };
    })()`);
    check('chemistry inside host KaTeX markup is re-rendered with mhchem', () => {
      assert(katexChem.rerendered, JSON.stringify(katexChem));
      assert(!katexChem.error, JSON.stringify(katexChem));
    });

    // --- streaming -------------------------------------------------------
    const streamSteps = [
      'flowchart TD\n  S0[开始] --> S1[解析]',
      'flowchart TD\n  S0[开始] --> S1[解析]\n  S1 --> S2[校验]',
      'flowchart TD\n  S0[开始] --> S1[解析]\n  S1 --> S2[校验]\n  S2 --> S3[执行]',
      'flowchart TD\n  S0[开始] --> S1[解析]\n  S1 --> S2[校验]\n  S2 --> S3[执行]\n  S3 --> S4[完成]',
    ];
    let sawErrorWhileStreaming = false;
    let renderedWhileStreaming = false;
    const firstStreamSource = await evaluate("(() => { const w = document.querySelector('#stream-case .tpr-rendered'); return w ? w.dataset.source : null; })()");
    for (let i = 0; i < streamSteps.length; i += 1) {
      await evaluate(`(() => {
        const node = document.querySelector('#stream-code');
        node.textContent = ${JSON.stringify(streamSteps[i])};
      })()`);
      await sleep(140);
      const state = await evaluate(`(() => {
        const wrapper = document.querySelector('#stream-case .tpr-rendered');
        return { error: !!document.querySelector('#stream-case .tpr-error'), source: wrapper ? wrapper.dataset.source : null };
      })()`);
      if (state.error) sawErrorWhileStreaming = true;
      if (state.source !== firstStreamSource) renderedWhileStreaming = true;
    }
    await sleep(2200);
    const streamFinal = await evaluate(`(() => {
      const wrapper = document.querySelector('#stream-case .tpr-rendered');
      const content = wrapper && wrapper.querySelector('.tpr-content');
      const svg = content && content.querySelector('svg');
      return {
        error: !!document.querySelector('#stream-case .tpr-error'),
        svg: !!svg,
        nodes: svg ? svg.querySelectorAll('.node').length : 0,
        source: wrapper ? wrapper.dataset.source : null
      };
    })()`);
    check('streaming does not render half-finished diagrams', () => assert(!renderedWhileStreaming, 'rendered while the block was still streaming'));
    check('streaming never shows a syntax error box', () => assert(!sawErrorWhileStreaming, 'an error box appeared mid-stream'));
    check('the finished stream renders once', () => assert(streamFinal.svg && !streamFinal.error, JSON.stringify(streamFinal)));
    check('the finished diagram matches the final source', () => assert(streamFinal.nodes >= 5, `nodes=${streamFinal.nodes}`));

    // --- overlay sweep: app chrome must survive --------------------------
    // 回归：重叠在卡片工具栏带上的应用级 UI（模态对话框、左上角按钮簇）
    // 必须保持可见；只有宿主的 "Copy code"/"复制" 控件才允许被隐藏。
    const overlayCard = "document.querySelector('#tall-case .tpr-rendered')";
    await evaluate(`(() => { const card = ${overlayCard}; card.scrollIntoView({ block: 'start' }); })()`);
    await sleep(200);

    // (a) 盖住工具栏带的模态对话框必须保持可见
    const dialogFixture = await evaluate(`(() => {
      const card = ${overlayCard};
      const band = card.querySelector('.tpr-toolbar').getBoundingClientRect();
      const dialog = document.createElement('div');
      dialog.id = 'app-modal-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.style.cssText = 'position:fixed;z-index:2147483600;left:' + Math.round(band.left) + 'px;top:' + Math.round(band.top) + 'px;width:' + Math.round(band.width) + 'px;height:' + Math.round(Math.max(200, band.height * 4)) + 'px;background:#fafafa;color:#111;border:1px solid #333';
      dialog.textContent = 'synthetic dialog';
      document.body.appendChild(dialog);
      const rect = dialog.getBoundingClientRect();
      return {
        covers: rect.right > band.left && rect.left < band.right && rect.bottom > band.top && rect.top < band.bottom,
        dialogRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        band: { left: band.left, top: band.top, right: band.right, bottom: band.bottom }
      };
    })()`);
    await sleep(1800);
    const dialogState = await evaluate(`(() => {
      const node = document.getElementById('app-modal-dialog');
      return { hidden: !node || getComputedStyle(node).display === 'none' };
    })()`);
    check('the dialog fixture geometrically covers the toolbar band', () => assert(dialogFixture.covers, JSON.stringify(dialogFixture)));
    check('a modal dialog over the card toolbar stays visible', () => assert(!dialogState.hidden, JSON.stringify(dialogState)));
    await evaluate("(() => { const node = document.getElementById('app-modal-dialog'); if (node) node.remove(); })()");

    // (b) 左上角固定按钮簇压在工具栏带上时必须保持可见
    const clusterFixture = await evaluate(`(() => {
      const card = ${overlayCard};
      const band = card.querySelector('.tpr-toolbar').getBoundingClientRect();
      const cluster = document.createElement('div');
      cluster.id = 'app-button-cluster';
      const width = Math.ceil(band.left + band.width * 0.2) + 16;
      const height = Math.max(48, Math.ceil(band.top + band.height + 10));
      cluster.style.cssText = 'position:fixed;z-index:2147483600;left:8px;top:8px;width:' + width + 'px;height:' + height + 'px;display:flex;gap:4px;padding:3px;box-sizing:border-box;background:#eee;border:1px solid #333';
      for (let i = 0; i < 3; i += 1) {
        const button = document.createElement('button');
        button.id = 'app-chrome-button-' + i;
        button.setAttribute('aria-label', 'pane ' + i);
        button.textContent = 'P' + i;
        button.style.cssText = 'flex:1 1 0;min-width:0';
        cluster.appendChild(button);
      }
      document.body.appendChild(cluster);
      const rect = cluster.getBoundingClientRect();
      return {
        covers: rect.right > band.left && rect.left < band.right && rect.bottom > band.top && rect.top < band.bottom,
        clusterRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        band: { left: band.left, top: band.top, right: band.right, bottom: band.bottom }
      };
    })()`);
    await sleep(1800);
    const clusterState = await evaluate(`(() => {
      const cluster = document.getElementById('app-button-cluster');
      const buttons = cluster ? Array.prototype.slice.call(cluster.querySelectorAll('button')) : [];
      return {
        clusterHidden: !cluster || getComputedStyle(cluster).display === 'none',
        hiddenButtons: buttons.filter((button) => getComputedStyle(button).display === 'none').length,
        buttonCount: buttons.length
      };
    })()`);
    check('the top-left button cluster geometrically covers the toolbar band', () => assert(clusterFixture.covers, JSON.stringify(clusterFixture)));
    check('a top-left cluster of app buttons over the card toolbar stays visible', () =>
      assert(!clusterState.clusterHidden && clusterState.hiddenButtons === 0 && clusterState.buttonCount === 3, JSON.stringify(clusterState)));
    await evaluate("(() => { const node = document.getElementById('app-button-cluster'); if (node) node.remove(); })()");

    // (c) 压在工具栏带上的宿主 "Copy code" 控件仍然必须被隐藏
    await evaluate(`(() => {
      const card = ${overlayCard};
      const band = card.querySelector('.tpr-toolbar').getBoundingClientRect();
      const button = document.createElement('button');
      button.id = 'band-copy-control';
      button.setAttribute('aria-label', 'Copy code');
      button.textContent = 'Copy code';
      button.style.cssText = 'position:fixed;z-index:2147483600;left:' + Math.round(band.left + band.width / 2 - 40) + 'px;top:' + Math.round(band.top + 2) + 'px';
      document.body.appendChild(button);
    })()`);
    await sleep(1800);
    const bandCopy = await evaluate(`(() => {
      const node = document.getElementById('band-copy-control');
      return { exists: !!node, hidden: !!node && getComputedStyle(node).display === 'none' };
    })()`);
    check('a host "Copy code" control over the card toolbar is still hidden', () => assert(bandCopy.exists && bandCopy.hidden, JSON.stringify(bandCopy)));
    await evaluate("(() => { const node = document.getElementById('band-copy-control'); if (node) node.remove(); })()");

    // (d) 真实触发条件：长会话可滚动后，滚动/重排会让固定 UI 滑到卡片工具栏带上。
    // sweep 每 700ms 跑一次，多个周期后应用 UI 仍必须在（这是用户实际遇到的场景）。
    const longCase = await evaluate(`(() => {
      const spacer = document.createElement('div');
      spacer.id = 'long-conversation-spacer';
      spacer.style.cssText = 'height:2600px';
      document.body.insertBefore(spacer, document.querySelector('#tall-case'));

      const dock = document.createElement('div');
      dock.id = 'longcase-dock';
      dock.setAttribute('role', 'dialog');
      dock.style.cssText = 'position:fixed;z-index:2147483600;left:0;top:0;width:100%;height:64px;background:#f2f2f0;color:#111;border-bottom:1px solid #333';
      const left = document.createElement('div');
      left.id = 'longcase-top-left-buttons';
      left.style.cssText = 'position:fixed;left:8px;top:8px;display:flex;gap:4px';
      for (let i = 0; i < 3; i += 1) {
        const button = document.createElement('button');
        button.id = 'longcase-button-' + i;
        button.setAttribute('aria-label', 'pane ' + i);
        button.textContent = 'P' + i;
        left.appendChild(button);
      }
      document.body.appendChild(dock);
      document.body.appendChild(left);

      const card = ${overlayCard};
      const band = card.querySelector('.tpr-toolbar').getBoundingClientRect();
      const targetTop = 6;
      window.scrollBy(0, band.top - targetTop);
      const after = card.querySelector('.tpr-toolbar').getBoundingClientRect();
      return {
        scrollable: document.documentElement.scrollHeight > window.innerHeight + 500,
        scrolled: window.scrollY > 0,
        toolbarAtTop: after.top >= 0 && after.top < 20,
        dockCovers: after.top < 64 && after.left < window.innerWidth
      };
    })()`);
    await sleep(2600);
    const longState = await evaluate(`(() => {
      const dock = document.getElementById('longcase-dock');
      const left = document.getElementById('longcase-top-left-buttons');
      const buttons = left ? Array.prototype.slice.call(left.querySelectorAll('button')) : [];
      return {
        dockHidden: !dock || getComputedStyle(dock).display === 'none',
        leftHidden: !left || getComputedStyle(left).display === 'none',
        hiddenButtons: buttons.filter((button) => getComputedStyle(button).display === 'none').length,
        buttonCount: buttons.length
      };
    })()`);
    check('a long conversation actually became scrollable', () => assert(longCase.scrollable && longCase.scrolled, JSON.stringify(longCase)));
    check('scrolling parked the card toolbar under the fixed app UI', () => assert(longCase.toolbarAtTop && longCase.dockCovers, JSON.stringify(longCase)));
    check('app UI survives repeated sweeps after a long-conversation scroll', () =>
      assert(!longState.dockHidden && !longState.leftHidden && longState.hiddenButtons === 0 && longState.buttonCount === 3, JSON.stringify(longState)));
    await evaluate("(() => { ['longcase-dock','longcase-top-left-buttons','long-conversation-spacer'].forEach((id) => { const node = document.getElementById(id); if (node) node.remove(); }); })()");

    // --- no runtime errors ---------------------------------------------
    check('page reported no runtime errors', () => assert.strictEqual(consoleErrors.length, 0, consoleErrors.join(' | ')));
  } catch (error) {
    failures.push(`FAIL harness: ${error && error.message ? error.message : error}`);
    checks.push(`${failures[failures.length - 1]}`);
  } finally {
    if (client) client.close();
    if (!keep) {
      child.kill();
      await sleep(400);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  }

  console.log(checks.join('\n'));
  if (consoleErrors.length) console.log(`page errors: ${consoleErrors.join(' | ')}`);
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nui harness passed');
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
