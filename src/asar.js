'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;

function readAsar(filePath) {
  const data = fs.readFileSync(filePath);
  const parsed = parseAsar(data, filePath);
  return { path: filePath, data, ...parsed };
}

function parseAsar(data, filePath = '<memory>') {
  if (!Buffer.isBuffer(data) || data.length < 16) {
    throw new Error(`Not an asar archive: ${filePath}`);
  }
  const sizePicklePayload = data.readUInt32LE(0);
  const headerSize = data.readUInt32LE(4);
  const headerPayloadSize = data.readUInt32LE(8);
  const headerStringSize = data.readInt32LE(12);
  if (sizePicklePayload !== 4 || headerSize <= 0 || 8 + headerSize > data.length) {
    throw new Error(`Unsupported asar header: ${filePath}`);
  }
  if (headerStringSize < 0 || 16 + headerStringSize > data.length) {
    throw new Error(`Unsupported asar header string: ${filePath}`);
  }
  const headerString = data.subarray(16, 16 + headerStringSize);
  let header;
  try {
    header = JSON.parse(headerString.toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid asar JSON header: ${error.message}`);
  }
  if (!header || typeof header !== 'object' || !header.files) {
    throw new Error(`Invalid asar JSON header: ${filePath}`);
  }
  return {
    header,
    headerString,
    headerSize,
    headerPayloadSize,
    dataStart: 8 + headerSize,
  };
}

function getEntry(header, filePath) {
  const parts = filePath.split('/');
  let node = header;
  for (const part of parts) {
    if (!node || typeof node !== 'object' || !node.files || !node.files[part]) {
      throw new Error(`asar entry not found: ${filePath}`);
    }
    node = node.files[part];
  }
  if (!node || node.files || node.offset === undefined || node.size === undefined) {
    throw new Error(`asar entry is not a file: ${filePath}`);
  }
  return node;
}

function readEntry(asar, filePath) {
  const entry = getEntry(asar.header, filePath);
  const start = asar.dataStart + Number(entry.offset);
  const end = start + Number(entry.size);
  if (start < asar.dataStart || end > asar.data.length) {
    throw new Error(`asar entry bounds are invalid: ${filePath}`);
  }
  return asar.data.subarray(start, end);
}

function* iterFiles(node, prefix = '') {
  if (!node || !node.files) return;
  for (const [name, child] of Object.entries(node.files)) {
    const childPath = prefix ? `${prefix}/${name}` : name;
    if (child && child.files) {
      yield* iterFiles(child, childPath);
    } else if (child && child.offset !== undefined && child.size !== undefined) {
      yield { path: childPath, entry: child };
    }
  }
}

function integrity(data) {
  const blocks = [];
  if (data.length === 0) {
    blocks.push(sha256(data));
  } else {
    for (let offset = 0; offset < data.length; offset += INTEGRITY_BLOCK_SIZE) {
      blocks.push(sha256(data.subarray(offset, offset + INTEGRITY_BLOCK_SIZE)));
    }
  }
  return {
    algorithm: 'SHA256',
    hash: sha256(data),
    blockSize: INTEGRITY_BLOCK_SIZE,
    blocks,
  };
}

function encodeHeader(header) {
  const headerString = Buffer.from(JSON.stringify(header), 'utf8');
  let headerPayloadSize = 4 + headerString.length;
  headerPayloadSize += (4 - (headerPayloadSize % 4)) % 4;
  const headerPickleSize = 4 + headerPayloadSize;
  const out = Buffer.alloc(8 + headerPickleSize);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(headerPickleSize, 4);
  out.writeUInt32LE(headerPayloadSize, 8);
  out.writeInt32LE(headerString.length, 12);
  headerString.copy(out, 16);
  return { encoded: out, headerString };
}

function replaceFile(asar, filePath, newContent) {
  const header = JSON.parse(asar.headerString.toString('utf8'));
  const entry = getEntry(header, filePath);
  const targetOffset = Number(entry.offset);
  const oldSize = Number(entry.size);
  const delta = newContent.length - oldSize;

  if (delta !== 0) {
    for (const item of iterFiles(header)) {
      if (item.path === filePath) continue;
      if (Number(item.entry.offset) > targetOffset) {
        item.entry.offset = String(Number(item.entry.offset) + delta);
      }
    }
  }

  entry.size = newContent.length;
  entry.integrity = integrity(newContent);
  const { encoded, headerString } = encodeHeader(header);
  const body = asar.data.subarray(asar.dataStart);
  const targetEnd = targetOffset + oldSize;
  if (targetEnd > body.length) {
    throw new Error(`Existing asar entry is out of bounds: ${filePath}`);
  }
  const nextBody = Buffer.concat([
    body.subarray(0, targetOffset),
    newContent,
    body.subarray(targetEnd),
  ]);
  return {
    data: Buffer.concat([encoded, nextBody]),
    headerString,
    headerHash: sha256(headerString),
  };
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readPackageVersion(asar) {
  const packageJson = JSON.parse(readEntry(asar, 'package.json').toString('utf8'));
  return String(packageJson.version || '');
}

function fileSizeLabel(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function resolveInside(asar, filePath) {
  return path.join(asar.path, '..', 'app.asar.unpacked', filePath);
}

module.exports = {
  INTEGRITY_BLOCK_SIZE,
  encodeHeader,
  fileSizeLabel,
  getEntry,
  integrity,
  iterFiles,
  parseAsar,
  readAsar,
  readEntry,
  readPackageVersion,
  replaceFile,
  resolveInside,
  sha256,
};
