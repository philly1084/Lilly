'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { systemdProperties } = require('../../bin/lilly-node-service-proof');

const template = fs.readFileSync(path.resolve(__dirname, '../../deploy/lilly-node/lilly-node.service'), 'utf8');
const paths = { runtime: '/tmp/proof/node24', cli: '/tmp/proof/service.js', configPath: '/tmp/proof/config.json' };

test('transient proof carries every service limit from the checked-in template', () => {
  const properties = systemdProperties(template, paths);
  expect(properties).toHaveLength(17);
  for (const line of ['Type=simple', 'User=root', 'Group=root', 'Restart=on-failure', 'RestartSec=5', 'UMask=0077',
    'NoNewPrivileges=true', 'CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_SYS_PTRACE',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK', 'LimitNOFILE=256', 'TasksMax=64', 'MemoryMax=512M',
    'CPUQuota=100%', 'TimeoutStopSec=70', 'KillMode=control-group']) expect(properties).toContain(line);
  expect(properties).toContain('ExecStartPre=/tmp/proof/node24 /tmp/proof/service.js --config /tmp/proof/config.json --check');
  expect(properties.some(value => value.startsWith('ExecStart='))).toBe(false);
});

test('new, missing or duplicate template settings require proof review', () => {
  for (const value of [template.replace('[Service]', '[Service]\nPrivateTmp=true'),
    template.replace('MemoryMax=512M', ''), template.replace('TasksMax=64', 'TasksMax=64\nTasksMax=64')]) {
    expect(() => systemdProperties(value, paths)).toThrow('Review changed unit properties');
  }
});

test('transient command paths reject whitespace and systemd expansion characters', () => {
  for (const runtime of ['/tmp/two words', '/tmp/$NODE', '/tmp/%i', 'relative/node']) {
    expect(() => systemdProperties(template, { ...paths, runtime })).toThrow();
  }
});
