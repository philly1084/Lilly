#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createNodeRbac } = require('../src/agent-computer/node-rbac');

function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--config' || !path.isAbsolute(args[1])) throw new Error('Usage: lilly-node-rbac --config <absolute reviewed JSON path>');
  const file = fs.openSync(args[1], fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(file);
    if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid node RBAC input.');
    const buffer = Buffer.alloc(65537);
    let size = 0; let bytes;
    while (size < buffer.length && (bytes = fs.readSync(file, buffer, size, buffer.length - size, null))) size += bytes;
    if (size > 65536) throw new Error('Invalid node RBAC input.');
    const result = createNodeRbac(JSON.parse(buffer.subarray(0, size).toString('utf8')));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally { fs.closeSync(file); }
}

if (require.main === module) {
  try { main(); } catch { process.stderr.write('Node RBAC rendering failed; provide --config with an absolute reviewed JSON path.\n'); process.exitCode = 1; }
}
module.exports = { main };
