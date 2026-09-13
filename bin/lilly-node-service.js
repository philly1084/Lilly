#!/usr/bin/env node
'use strict';

// Native host entrypoint only. Importing this module does not read credentials,
// connect, listen or register signal handlers.
async function main(args = process.argv.slice(2)) {
  if (args.length < 2 || args.length > 3 || args[0] !== '--config' || (args[2] !== undefined && args[2] !== '--check')) throw new Error('Invalid private node service invocation.');
  const { loadNodeServiceConfig } = require('../src/agent-computer/node-service-config');
  const { startNodeService } = require('../src/agent-computer/node-service');
  const config = loadNodeServiceConfig(args[1]);
  const running = await startNodeService({ config, checkOnly: args[2] === '--check',
    onEvent: event => console.error(`[LillyNode] ${event}`) });
  if (running.checked) { console.log('[LillyNode] local_preflight_passed'); return; }
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    try { await running.stop(); process.exit(0); }
    catch { console.error('[LillyNode] shutdown_unconfirmed'); process.exit(1); }
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  console.log('[LillyNode] listening');
}

if (require.main === module) main().catch(() => { console.error('[LillyNode] startup_unavailable'); process.exit(1); });
module.exports = { main };
