'use strict';

const { normalizeRemoteWorkspace, resolveTargetDefaultWorkspace } = require('./workspace-contract');

test.each(['/opt/app', '/srv/my app', '`/opt/kimibuilt`'])(
  'accepts a single absolute workspace %s', (value) => expect(normalizeRemoteWorkspace(value)).toBeTruthy(),
);
test.each(['./app', '/opt/a\nWORKSPACE: /opt/b', "/var/www/test',\\n./src/test.js:413", '/opt/../etc', '{"cwd":"/opt/app"}'])(
  'rejects contaminated or relative metadata %s', (value) => expect(normalizeRemoteWorkspace(value)).toBe(''),
);
test('keeps defaults bound to the configured target', () => {
  const config = { defaultTargetId: 'k3s-prod', defaultCwd: '/opt/lilly-agent-workbench' };
  expect(resolveTargetDefaultWorkspace('k3s-prod', config)).toBe(config.defaultCwd);
  expect(resolveTargetDefaultWorkspace('k3s-secondary', config)).toBe('');
});
