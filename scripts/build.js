#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'third-party-render');
const files = {
  'mathjax-config.js': path.join(root, 'src', 'mathjax-config.js'),
  'mathjax-tex-svg-full.js': path.join(root, 'vendor', 'mathjax-3.2.2-tex-svg-full.js'),
  'mathjax-tex-mhchem.js': path.join(root, 'vendor', 'mathjax-3.2.2-tex-mhchem.js'),
  'mhchemparser-4.2.1.js': path.join(root, 'vendor', 'mhchemparser-4.2.1.js'),
  'katex.min.js': path.join(root, 'vendor', 'katex-0.16.22.min.js'),
  'katex.min.css': path.join(root, 'vendor', 'katex-0.16.22.min.css'),
  'katex-mhchem.min.js': path.join(root, 'vendor', 'katex-0.16.22-mhchem.min.js'),
  'mermaid.min.js': path.join(root, 'vendor', 'mermaid-12.0.0.min.js'),
  'runtime.js': path.join(root, 'src', 'runtime.js'),
  'main-inject.js': path.join(root, 'src', 'main-inject.js'),
  'shadow-hook-main-world.js': path.join(root, 'src', 'shadow-hook-main-world.js'),
};

fs.mkdirSync(output, { recursive: true });
const components = {};
for (const [name, source] of Object.entries(files)) {
  const destination = path.join(output, name);
  let data;
  if (name === 'katex-mhchem.min.js') {
    /* 上游是 UMD，浏览器里需要 window.katex 已存在；包一层避免 require 分支 */
    const raw = fs.readFileSync(source, 'utf8');
    data = Buffer.from(
      `(function(){var exports=undefined,module=undefined,require=undefined;\n${raw}\n})();\n`,
      'utf8',
    );
    fs.writeFileSync(destination, data);
  } else if (name === 'mhchemparser-4.2.1.js') {
    /* 上游是 CommonJS 构建，这里包一层浏览器外壳，暴露 window.mhchemParser */
    const raw = fs.readFileSync(source, 'utf8');
    data = Buffer.from(
      `(function(){var exports={},module={exports:exports};\n${raw}\nwindow.mhchemParser=exports.mhchemParser||module.exports;})();\n`,
      'utf8',
    );
    fs.writeFileSync(destination, data);
  } else {
    fs.copyFileSync(source, destination);
    data = fs.readFileSync(destination);
  }
  components[name] = {
    bytes: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  };
}
// runtime.js 里内嵌 mhchem 扩展源码：由它在页面内按需求值注册，避免依赖 loader
const runtimePath = path.join(output, 'runtime.js');
const mhchemPath = path.join(root, 'vendor', 'mathjax-3.2.2-tex-mhchem.js');
const runtimeSource = fs.readFileSync(runtimePath, 'utf8');
const mhchemSource = fs.readFileSync(mhchemPath, 'utf8');
const withMhchem = runtimeSource.split('/*__MH CHEM_SOURCE__*/').join(JSON.stringify(mhchemSource).slice(1, -1));
fs.writeFileSync(runtimePath, withMhchem, 'utf8');
components['runtime.js'] = {
  bytes: Buffer.byteLength(withMhchem),
  sha256: crypto.createHash('sha256').update(withMhchem).digest('hex'),
};

const manifest = {
  rendererVersion: '1.0.0',
  builtAt: new Date().toISOString(),
  components,
};
fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`built: ${output}`);
for (const [name, item] of Object.entries(components)) {
  console.log(`  ${name}: ${item.bytes} bytes sha256=${item.sha256.slice(0, 16)}`);
}
