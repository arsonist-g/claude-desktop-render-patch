#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { parseAsar, readEntry, replaceFile } = require('../src/asar');

const original = buildMinimalAsar({
  'package.json': Buffer.from('{"name":"fixture","version":"1.0.0"}'),
  'main.js': Buffer.from('console.log("hello")'),
});
const asar = { data: original, ...parseAsar(original) };
assert.strictEqual(readEntry(asar, 'main.js').toString(), 'console.log("hello")');
const nextContent = Buffer.from('console.log("hello");\n// changed\n');
const result = replaceFile(asar, 'main.js', nextContent);
const reparsed = { data: result.data, ...parseAsar(result.data) };
assert.strictEqual(readEntry(reparsed, 'main.js').toString(), nextContent.toString());
assert.strictEqual(readEntry(reparsed, 'package.json').toString(), '{"name":"fixture","version":"1.0.0"}');
console.log('asar roundtrip passed');

function buildMinimalAsar(files) {
  const { encodeHeader, integrity } = require('../src/asar');
  const root = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [filePath, content] of Object.entries(files)) {
    const entry = {
      size: content.length,
      offset: String(offset),
      integrity: integrity(content),
    };
    setPath(root, filePath, entry);
    chunks.push(content);
    offset += content.length;
  }
  const { encoded } = encodeHeader(root);
  return Buffer.concat([encoded, ...chunks]);
}

function setPath(root, filePath, value) {
  const parts = filePath.split('/');
  let node = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    node.files[parts[index]] = node.files[parts[index]] || { files: {} };
    node = node.files[parts[index]];
  }
  node.files[parts[parts.length - 1]] = value;
}
