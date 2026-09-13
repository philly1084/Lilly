'use strict';
const fs = require('node:fs'); const assert = require('node:assert/strict'); const crypto = require('node:crypto');
const config = require('/app/src/config');
config.auth.tokenTtlSeconds = 60;
const { createAuthToken } = require('/app/src/auth/service');
const { token } = createAuthToken(config.auth.username);
async function main() {
  const base = 'https://lilly.secdevsolutions.help';
  const checks = [];
  const get = async route => {
    const response = await fetch(base + route, { headers: { Cookie: `${config.auth.cookieName}=${token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, `Unexpected HTTP status for ${route}`); return response;
  };
  for (const file of ['index.html', 'js/team-client.js', 'js/team-manager.js', 'js/agent-ops.js', 'css/agent-ops.css']) {
    const bytes = Buffer.from(await (await get(`/agent-ops/${file}`)).arrayBuffer());
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    assert.equal(hash(bytes), hash(fs.readFileSync(`/app/frontend/agent-ops/${file}`)));
    checks.push(file);
  }
  const runtime = await (await get('/api/agent-teams/runtime')).json(); assert.equal(runtime.enabled, false);
  const list = await (await get('/api/agent-teams')).json(); assert.ok(Array.isArray(list.teams));
  console.log(JSON.stringify({ authenticatedAssetsMatched: checks, runtime, teamListReadable: true, visualBrowserTested: false }));
}
main().catch(error => { console.log(JSON.stringify({ passed: false, error: error.message?.slice(0, 160) })); process.exitCode = 1; });
