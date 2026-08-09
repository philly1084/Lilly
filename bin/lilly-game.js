#!/usr/bin/env node
'use strict';

const { runCli } = require('../src/game-studio/cli-client');

runCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
