'use strict';

jest.mock('./recovery-controller', () => ({ createProfileRecoveryController: jest.fn(() => ({ recover: jest.fn() })) }));
jest.mock('./recovery-node-adapter', () => ({ createRecoveryNodeAdapter: jest.fn(() => ({ requestStop: jest.fn(), captureStop: jest.fn() })) }));
jest.mock('./recovery-supervisor', () => ({ createRecoverySupervisor: jest.fn(() => ({ recover: jest.fn() })) }));
jest.mock('./recovery-helper-observer', () => ({ bindRecoveryHelperContainer: jest.fn(async () => ({ binding: true })) }));
jest.mock('./browser-node-adapter', () => ({ createBrowserNodeAdapter: jest.fn(() => ({ bindContainer: jest.fn(), requestStop: jest.fn(), captureStop: jest.fn(), observeTermination: jest.fn() })) }));

const { createNodeRecoveryRuntime, createNodeComputerOperations } = require('./recovery-runtime');
const { createBrowserNodeAdapter } = require('./browser-node-adapter');
const { createProfileRecoveryController } = require('./recovery-controller');
const { createRecoveryNodeAdapter } = require('./recovery-node-adapter');
const { createRecoverySupervisor } = require('./recovery-supervisor');
const { bindRecoveryHelperContainer } = require('./recovery-helper-observer');
beforeEach(() => jest.clearAllMocks());
function fixture() {
  const options = { service: {}, reader: {}, cluster: { request: jest.fn(async () => ({ observed: true })), exec: jest.fn() },
    configuration: { namespace: 'lilly-team-workers', image: `registry.example/recovery@sha256:${'a'.repeat(64)}` },
    volumeReader: {}, storageRoot: '/fixture/storage', now: () => '2026-09-07T04:00:00.000Z' };
  const runtime = createNodeRecoveryRuntime(options);
  return { options, runtime, controller: createProfileRecoveryController.mock.calls[0][0], supervisor: createRecoverySupervisor.mock.calls[0][0] };
}

test('one inactive entrypoint composes mounted recovery, binding, exact stop and archived capture', async () => {
  const f = fixture(); expect(Object.keys(f.runtime)).toEqual(['recover']);
  expect(f.options.cluster.request).not.toHaveBeenCalled(); expect(f.options.cluster.exec).not.toHaveBeenCalled();
  expect(f.supervisor.controller).toBe(createProfileRecoveryController.mock.results[0].value);
  expect(f.supervisor.requestStop).toBe(createRecoveryNodeAdapter.mock.results[0].value.requestStop);
  expect(f.supervisor.captureStop).toBe(createRecoveryNodeAdapter.mock.results[0].value.captureStop);
  expect(f.controller).toMatchObject({ service: f.options.service, reader: f.options.reader, volumeReader: f.options.volumeReader, storageRoot: '/fixture/storage' });
  const signal = new AbortController().signal; const lease = {};
  await f.supervisor.bindContainer({ lease, signal });
  expect(bindRecoveryHelperContainer).toHaveBeenCalledWith({ lease, signal, reader: f.options.reader, readPod: f.controller.readPod, now: f.options.now });
});

test.each([
  ['readPod', 'pods', true], ['readPVC', 'persistentvolumeclaims', true], ['readPV', 'persistentvolumes', false],
])('%s is a bounded GET with cancellation', async (key, kind, namespaced) => {
  const f = fixture(); const signal = new AbortController().signal;
  expect(await f.controller[key]({ namespace: 'lilly-team-workers', name: 'fixture-owned', signal })).toEqual({ observed: true });
  expect(f.options.cluster.request).toHaveBeenCalledWith('GET', `/api/v1${namespaced ? '/namespaces/lilly-team-workers' : ''}/${kind}/fixture-owned`, undefined, { signal });
});

test.each(['foreign_namespace', 'path', 'query', 'abort'])('read wrappers reject %s before API access', async mode => {
  const f = fixture(); const input = { namespace: 'lilly-team-workers', name: 'fixture-owned' };
  if (mode === 'foreign_namespace') input.namespace = 'kimibuilt';
  if (mode === 'path') input.name = '../secrets';
  if (mode === 'query') input.name = 'fixture?watch=true';
  if (mode === 'abort') { const abort = new AbortController(); abort.abort(); input.signal = abort.signal; }
  await expect(f.controller.readPod(input)).rejects.toThrow(); expect(f.options.cluster.request).not.toHaveBeenCalled();
});

test('requires explicit private Kubernetes client and worker namespace', () => {
  expect(() => createNodeRecoveryRuntime()).toThrow();
  expect(() => createNodeRecoveryRuntime({ cluster: { request() {}, exec() {} }, configuration: { namespace: 'kimibuilt' } })).toThrow();
});

test('computer operations share the reviewed recovery runtime without activating resources', () => {
  const f = fixture(); jest.clearAllMocks();
  const operations = createNodeComputerOperations(f.options);
  expect(Object.keys(operations)).toEqual(['bindContainer', 'requestStop', 'captureStop', 'observeTermination']);
  expect(createBrowserNodeAdapter).toHaveBeenCalledWith(expect.objectContaining({ service: f.options.service, reader: f.options.reader,
    recovery: createRecoverySupervisor.mock.results[0].value, now: f.options.now }));
  expect(f.options.cluster.request).not.toHaveBeenCalled(); expect(f.options.cluster.exec).not.toHaveBeenCalled();
});
