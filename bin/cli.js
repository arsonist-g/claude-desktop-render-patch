#!/usr/bin/env node
'use strict';

const { main } = require('../src/menu');

main(process.argv.slice(2)).then(
  (code) => process.exit(code || 0),
  (error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  },
);
