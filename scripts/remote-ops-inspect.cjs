'use strict';
const { config } = require('/app/src/config');
const { createAuthToken } = require('/app/src/auth/service');
const { token } = createAuthToken(config.auth.username);
(async () => {
  const ssh = require('/app/src/routes/admin/settings.controller').getEffectiveSshConfig();
  console.log(JSON.stringify({ ssh: { host: ssh.host, username: ssh.username, privateKeyPath: ssh.privateKeyPath, hasPassword: Boolean(ssh.password) } }));
  for (const route of ['/api/tools/remote-cli-agent/targets']) {
    const response = await fetch('https://lilly.secdevsolutions.help' + route, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    const body = await response.json();
    console.log(JSON.stringify({ route, status: response.status, data: route.endsWith('targets') ? body : { runtime: body.data?.runtime, support: body.data?.support } }));
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
