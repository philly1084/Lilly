'use strict';

const {
  buildDeploymentImagePatch,
  buildLeasePatch,
  buildReleasePatch,
  buildRenewPatch,
  chooseLeaseAction,
  hashConfigData,
  isLeaseStale,
  provenanceAnnotations,
} = require('./deployment-coordination');

describe('deployment coordination policy', () => {
  const now = Date.parse('2026-09-05T19:00:00.000Z');

  test('waits for a live competing owner and takes over only a stale owner', () => {
    const live = {
      metadata: { resourceVersion: '11' },
      spec: { holderIdentity: 'release-old', renewTime: '2026-09-05T18:59:30.000Z' },
    };
    const stale = {
      metadata: { resourceVersion: '12' },
      spec: { holderIdentity: 'release-old', renewTime: '2026-09-05T18:30:00.000Z' },
    };

    expect(chooseLeaseAction(live, { owner: 'release-new', nowMs: now, staleAfterSeconds: 120 })).toBe('wait');
    expect(chooseLeaseAction(stale, { owner: 'release-new', nowMs: now, staleAfterSeconds: 120 })).toBe('takeover');
    expect(isLeaseStale(stale, now, 120)).toBe(true);
  });

  test('uses resource-version and holder tests for takeover and owner-only release', () => {
    const lease = {
      metadata: { resourceVersion: '41' },
      spec: {
        holderIdentity: 'release-old',
        acquireTime: '2026-09-05T18:00:00.000Z',
        renewTime: '2026-09-05T18:00:00.000Z',
      },
    };
    const takeover = buildLeasePatch(lease, { owner: 'release-new', now: '2026-09-05T19:00:00.000Z' });
    expect(takeover.slice(0, 2)).toEqual([
      { op: 'test', path: '/metadata/resourceVersion', value: '41' },
      { op: 'test', path: '/spec/holderIdentity', value: 'release-old' },
    ]);
    expect(takeover).toContainEqual({ op: 'replace', path: '/spec/holderIdentity', value: 'release-new' });

    const release = buildReleasePatch(lease, 'release-old');
    expect(release).toContainEqual({ op: 'test', path: '/spec/holderIdentity', value: 'release-old' });
    expect(release).toContainEqual({ op: 'replace', path: '/spec/holderIdentity', value: '' });
    expect(() => buildReleasePatch(lease, 'release-new')).toThrow(/owned by 'release-old'/);
    expect(buildRenewPatch({ ...lease, spec: { ...lease.spec, holderIdentity: 'release-new' } }, { owner: 'release-new' })[1])
      .toEqual({ op: 'test', path: '/spec/holderIdentity', value: 'release-new' });
  });

  test('produces stable config checksums and a guarded image patch with provenance', () => {
    expect(hashConfigData({ B: '2', A: '1' })).toBe(hashConfigData({ A: '1', B: '2' }));
    const annotations = provenanceAnnotations({
      releaseId: 'release-1',
      sourceSha: 'abc123',
      image: 'ghcr.io/example/app:abc123',
      previousImage: 'ghcr.io/example/app:old',
      configChecksum: 'deadbeef',
      actor: 'ci',
    });
    const patch = buildDeploymentImagePatch({
      metadata: { annotations: {} },
      spec: {
        template: {
          metadata: { annotations: {} },
          spec: { containers: [{ name: 'backend', image: 'ghcr.io/example/app:old' }] },
        },
      },
    }, { expectedImage: 'ghcr.io/example/app:old', image: 'ghcr.io/example/app:abc123', annotations });
    expect(patch[0]).toEqual({ op: 'test', path: '/spec/template/spec/containers/0/image', value: 'ghcr.io/example/app:old' });
    expect(patch).toContainEqual({ op: 'replace', path: '/spec/template/spec/containers/0/image', value: 'ghcr.io/example/app:abc123' });
    expect(patch).toContainEqual({ op: 'add', path: '/spec/template/metadata/annotations/kimibuilt.secdevsolutions.help~1config-checksum', value: 'deadbeef' });
  });
});
