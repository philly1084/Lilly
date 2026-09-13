'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
function run(bin, args) { return execFileSync(bin, args, { encoding: 'utf8', timeout: 30000 }); }
const endpoints = JSON.parse(run('/usr/local/bin/kubectl', ['get', 'endpoints', 'postgres', '-n', 'kimibuilt', '-o', 'json']));
const addresses = endpoints.subsets.flatMap(s => s.addresses || []).map(a => a.ip);
assert.equal(addresses.length, 1); assert.match(addresses[0], /^10\.42\.0\.\d{1,3}$/);
const file = '/etc/systemd/system/lilly-node.service';
const source = fs.readFileSync(file, 'utf8');
assert.ok(source.includes('IPAddressAllow=10.43.84.112/32\n'));
assert.ok(!source.includes(`IPAddressAllow=${addresses[0]}/32`));
run('/usr/bin/systemctl', ['stop', 'lilly-node.service']);
fs.writeFileSync(file, source.replace('IPAddressAllow=10.43.84.112/32\n', `IPAddressAllow=10.43.84.112/32\nIPAddressAllow=${addresses[0]}/32\n`));
run('/usr/bin/systemctl', ['daemon-reload']);
run('/usr/bin/systemctl', ['start', 'lilly-node.service']);
console.log(run('/usr/bin/systemctl', ['show', 'lilly-node.service', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID']));
