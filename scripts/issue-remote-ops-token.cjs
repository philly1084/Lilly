'use strict';
const { config } = require('/app/src/config');
const { createAuthToken } = require('/app/src/auth/service');
(async () => {
  const issued = createAuthToken(config.auth.username);
  const response = await fetch('https://lilly.secdevsolutions.help/api/tools/remote-ops', {
    headers: { Authorization: `Bearer ${issued.token}` },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 200 || (await response.json()).schema !== 'LillyRemoteOps/v1') throw new Error('Token verification failed');
  process.stdout.write(JSON.stringify({ token: issued.token, expiresAt: new Date(issued.expiresAt * 1000).toISOString(), baseUrl: 'https://lilly.secdevsolutions.help', authorizationScheme: 'Bearer', permissions: 'Existing Lilly operator/admin access' }));
})().catch(() => { process.stderr.write('Token issuance or verification failed\n'); process.exitCode = 1; });
