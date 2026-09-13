'use strict';
const config = require('/app/src/config');
const dns = require('node:dns').promises;
async function main() {
  const base = new URL(config.openai.baseURL);
  const address = await dns.lookup(base.hostname).catch(e => ({ errorCode: e.code }));
  console.log(JSON.stringify({ protocol: base.protocol, hostname: base.hostname, port: base.port, pathname: base.pathname, address }));
  try {
    const response = await fetch(`${base.href.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${config.openai.apiKey}` }, signal: AbortSignal.timeout(10000) });
    console.log(JSON.stringify({ modelsHttpStatus: response.status })); await response.body?.cancel();
  } catch (e) {
    console.log(JSON.stringify({ networkError: e.name, causeCode: e.cause?.code, causeType: e.cause?.name }));
  }
}
main().catch(() => process.exitCode = 1);
