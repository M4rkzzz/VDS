'use strict';

const fs = require('node:fs');

const messagePath = process.argv[2];
if (!messagePath) throw new Error('Expected a Git commit message path');
const message = fs.readFileSync(messagePath, 'utf8');
if (!message.includes('[skip render]') && !message.includes('[render skip]')) {
  fs.appendFileSync(messagePath, `${message.endsWith('\n') ? '' : '\n'}\n[skip render]\n`);
}
