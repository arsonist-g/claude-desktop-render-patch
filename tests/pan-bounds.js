#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'runtime.js'), 'utf8');
const start = '/*__TPR_PAN_MATH_START__*/';
const end = '/*__TPR_PAN_MATH_END__*/';
const from = source.indexOf(start);
const to = source.indexOf(end);
assert(from >= 0 && to > from, 'pan math markers are missing from src/runtime.js');
const { computePanBounds } = new Function(
  `${source.slice(from + start.length, to)}\nreturn { computePanBounds };`,
)();

const box = (left, top, width, height) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});
const viewport = (width, height) => ({ width, height });

// content that fits stays locked
let bounds = computePanBounds(
  box(0, 0, 400, 300),
  viewport(400, 300),
  { left: 0, top: 0, width: 400, height: 300 },
);
assert.deepStrictEqual(
  bounds,
  { minX: 0, maxX: 0, minY: 0, maxY: 0, overflowX: false, overflowY: false },
  'content that fits must not be pannable',
);

// taller than the viewport pans vertically only
bounds = computePanBounds(
  box(0, 0, 400, 460),
  viewport(400, 460),
  { left: 0, top: 0, width: 400, height: 900 },
);
assert.strictEqual(bounds.overflowY, true, 'tall content must be pannable');
assert.strictEqual(bounds.overflowX, false, 'fitting width must stay locked');
assert.strictEqual(bounds.minY, -440, 'vertical pan must reach the bottom edge');
assert.strictEqual(bounds.maxY, 0, 'vertical pan must stop at the top edge');

// wider than the viewport pans horizontally only
bounds = computePanBounds(
  box(0, 0, 400, 300),
  viewport(400, 300),
  { left: 0, top: 0, width: 1600, height: 300 },
);
assert.strictEqual(bounds.overflowX, true, 'wide content must be pannable');
assert.strictEqual(bounds.minX, -1200, 'horizontal pan must reach the right edge');
assert.strictEqual(bounds.maxX, 0, 'horizontal pan must stop at the left edge');

// padding keeps the natural offset so the right edge still aligns
bounds = computePanBounds(
  box(0, 0, 400, 300),
  viewport(400, 300),
  { left: 16, top: 16, width: 1600, height: 300 },
);
assert.strictEqual(bounds.minX, -1216, 'padded content must align its right edge with the box');
assert.strictEqual(bounds.maxX, 0, 'padded content must not drift right');

// a centred element narrower than the viewport must not move at all
bounds = computePanBounds(
  box(0, 0, 400, 300),
  viewport(400, 300),
  { left: 100, top: 40, width: 200, height: 220 },
);
assert.strictEqual(bounds.minX, 0, 'narrow centred content must stay put');
assert.strictEqual(bounds.maxX, 0, 'narrow centred content must stay put');
assert.strictEqual(bounds.minY, 0, 'short centred content must stay put');

// sub-pixel rounding must not enable panning
bounds = computePanBounds(
  box(0, 0, 400, 300),
  viewport(400, 300),
  { left: 0, top: 0, width: 400.5, height: 300.5 },
);
assert.strictEqual(bounds.overflowX, false, 'sub-pixel overflow must be ignored');
assert.strictEqual(bounds.overflowY, false, 'sub-pixel overflow must be ignored');

// the caller passes a natural rect (current pan already removed); the clamp
// follows that natural position instead of drifting with the pan
bounds = computePanBounds(
  box(0, 0, 400, 300),
  viewport(400, 300),
  { left: -600, top: 0, width: 1600, height: 300 },
);
assert.strictEqual(bounds.minX, -600, 'right edge alignment follows the natural position');
assert.strictEqual(bounds.maxX, 600, 'left edge alignment follows the natural position');

console.log('pan bounds ok');
