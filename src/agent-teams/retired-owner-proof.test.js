'use strict';

const { randomUUID } = require('node:crypto');
const { fixture, run } = require('../../bin/lilly-retired-owner-proof');
const input = () => ({ proofId: randomUUID(), namespace: 'kimibuilt-async-lab',
  image: `ghcr.io/philly1084/lilly@sha256:${'a'.repeat(64)}`, nodeName: 'fixture-node' });

test('retirement fixture is a bounded fixed process with no agent credentials or project mounts', () => {
  const { pod } = fixture(input());
  expect(pod.spec.restartPolicy).toBe('Never'); expect(pod.spec.activeDeadlineSeconds).toBe(180);
  expect(pod.spec.automountServiceAccountToken).toBe(false); expect(pod.spec.enableServiceLinks).toBe(false);
  expect(pod.spec.securityContext.runAsNonRoot).toBe(true);
  expect(pod.spec.volumes).toBeUndefined(); expect(pod.spec.hostPID).toBeUndefined(); expect(pod.spec.hostNetwork).toBeUndefined();
  expect(pod.spec.containers).toHaveLength(1);
  const worker = pod.spec.containers[0];
  expect(worker.command).toEqual(['/bin/sleep', '120']); expect(worker.imagePullPolicy).toBe('Never');
  for (const key of ['env', 'envFrom', 'ports', 'volumeMounts']) expect(worker[key]).toBeUndefined();
  expect(worker.securityContext).toEqual({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
  expect(worker.resources.limits).toEqual({ cpu: '100m', memory: '64Mi' });
});

test('deny-all network policy selects only the unique fixture, never other lab work', () => {
  const value = input(); const { pod, networkPolicy } = fixture(value);
  expect(networkPolicy.spec).toEqual({ podSelector: { matchLabels: { 'lilly.proof-id': value.proofId } },
    policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] });
  expect(pod.metadata.labels).toEqual(networkPolicy.spec.podSelector.matchLabels);
  expect(fixture(input()).pod.metadata.name).not.toBe(pod.metadata.name);
});

test.each(['namespace', 'image', 'proofId', 'nodeName'])('invalid %s rejects before fixture creation', key => {
  const value = input(); value[key] = key === 'namespace' ? 'kimibuilt' : 'invalid input';
  expect(() => fixture(value)).toThrow();
});

test('cluster execution refuses absent approval before platform checks or commands', async () => {
  await expect(run({ ...input(), approved: false })).rejects.toThrow('Explicit sandbox approval');
});
