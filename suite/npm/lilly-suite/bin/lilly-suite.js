#!/usr/bin/env node

'use strict';

require('../lib/cli').main(process.argv.slice(2)).catch((error) => {
  console.error(`[lilly-suite] ERROR ${error.message}`);
  process.exitCode = error.exitCode || 1;
});
