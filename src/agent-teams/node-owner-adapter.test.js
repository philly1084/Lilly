'use strict';

const { createNodeOwnerBinder, backendPodNames } = require('./node-owner-adapter');
const { ownerFixture } = require('./node-owner-test-fixture');
const make = f => createNodeOwnerBinder({ nodeName: 'fixture-node', podNames: ['backend-a'], cluster: f.cluster, reader: f.reader });

test('binds an explicitly named backend through twice-matched API, CRI, kernel and cgroup reads', async () => {
  const f = ownerFixture(); const bind = make(f); expect(f.cluster.request).not.toHaveBeenCalled();
  const result = await bind({ owner: f.owner });
  expect(result).toMatchObject({ version: 2, hostPid: 510, nodeName: 'fixture-node', cgroup: f.group.identity });
  expect(f.cluster.request).toHaveBeenCalledTimes(2);
  expect(f.cluster.request).toHaveBeenCalledWith('GET', '/api/v1/namespaces/kimibuilt/pods/backend-a', undefined, { signal: undefined });
  for (const read of Object.values(f.reader)) expect(read).toHaveBeenCalledTimes(2);
  expect(result).not.toHaveProperty('ownerStopped');
});

test.each(['pod', 'container', 'platform', 'aborted'])('rejects %s input before reading any host state', async mode => {
  const f = ownerFixture(); const signal = new AbortController();
  if (mode === 'pod') f.owner.pod.name = 'backend-other';
  if (mode === 'container') f.owner.pod.containerName = 'other';
  if (mode === 'platform') { f.owner.platform = 'win32'; f.owner.kernel = null; }
  if (mode === 'aborted') signal.abort();
  await expect(make(f)({ owner: f.owner, signal: signal.signal })).rejects.toMatchObject({ code: 'team_owner_binding_unavailable' });
  expect(f.cluster.request).not.toHaveBeenCalled();
  for (const read of Object.values(f.reader)) expect(read).not.toHaveBeenCalled();
});

test.each(['node', 'uid', 'cgroup', 'abort-during-read'])('rejects mismatched %s without a partial owner binding', async mode => {
  const f = ownerFixture(); const abort = new AbortController();
  if (mode === 'node') f.pod.spec.nodeName = 'foreign-node';
  if (mode === 'uid') f.pod.metadata.uid = 'foreign';
  if (mode === 'cgroup') f.reader.observeCgroup.mockResolvedValueOnce(f.group).mockResolvedValueOnce({ ...f.group, identity: { ...f.group.identity, inode: '1001' } });
  if (mode === 'abort-during-read') f.reader.inspectContainer.mockImplementation(async () => { abort.abort(); return f.runtime; });
  await expect(make(f)({ owner: f.owner, signal: abort.signal })).rejects.toMatchObject({ code: 'team_owner_binding_unavailable' });
});

test.each([null, '*', ['*'], ['../backend'], ['backend-a', 'backend-a'], Array(33).fill('backend-a')])('rejects broad Pod policy %#', value => {
  expect(() => backendPodNames(value)).toThrow();
});

test('snapshots deployment policy so later caller mutations cannot widen it', async () => {
  const f = ownerFixture(); const names = [];
  const bind = createNodeOwnerBinder({ nodeName: 'fixture-node', podNames: names, cluster: f.cluster, reader: f.reader });
  names.push('backend-a');
  await expect(bind({ owner: f.owner })).rejects.toBeDefined(); expect(f.cluster.request).not.toHaveBeenCalled();
});
