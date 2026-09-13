'use strict';

jest.mock('./node-rpc-client', () => ({ createNodeRpcClient: jest.fn(() => ({ bindContainer: jest.fn(), requestStop: jest.fn(), captureStop: jest.fn(), observeTermination: jest.fn(), bindExecutionOwner: jest.fn() })) }));
jest.mock('./kubernetes-supervisor', () => ({ createKubernetesComputerRuntime: jest.fn(() => ({ dispose: jest.fn() })) }));
const { createNodeRpcClient } = require('./node-rpc-client');
const { createKubernetesComputerRuntime } = require('./kubernetes-supervisor');
const { createConfiguredComputerFactory, createConfiguredOwnerBinder } = require('./configured-factory');
beforeEach(() => jest.clearAllMocks());
function fixture() {
  const config = { version: 1, nodes: [{ name: 'fixture-node', url: 'https://fixture-node.internal:9443/', fingerprint: 'a'.repeat(64) }],
    tlsFiles: { key: '/fixture/client.key', cert: '/fixture/client.crt', ca: '/fixture/ca.crt' } };
  const environment = { LILLY_TEAMS_NODE_RPC_CONFIG: '/fixture/config.json', LILLY_TEAMS_BROWSER_IMAGE: `registry.example/browser@sha256:${'b'.repeat(64)}`,
    LILLY_TEAMS_BROWSER_SECCOMP_PROFILE: 'lilly/chromium-v1.json' };
  const read = jest.fn(target => target === environment.LILLY_TEAMS_NODE_RPC_CONFIG ? JSON.stringify(config) : Buffer.from('TEST ONLY'));
  return { config, environment, read };
}
test('loads bounded backend credential files and wires only four private callbacks', () => {
  const f = fixture(); const factory = createConfiguredComputerFactory(f);
  expect(createKubernetesComputerRuntime).not.toHaveBeenCalled();
  expect(f.read.mock.calls.map(([target]) => target)).toEqual(['/fixture/config.json', '/fixture/client.key', '/fixture/client.crt', '/fixture/ca.crt']);
  const service = {}; const authorize = jest.fn(); factory({ service, authorize });
  const { bindExecutionOwner, ...browserOperations } = createNodeRpcClient.mock.results[0].value;
  expect(createKubernetesComputerRuntime).toHaveBeenCalledWith({ service, authorize, ...browserOperations,
    configuration: { namespace: 'lilly-team-workers', image: f.environment.LILLY_TEAMS_BROWSER_IMAGE, seccompProfile: 'lilly/chromium-v1.json' } });
});

test('startup binder routes only to the configured Downward API node without building a browser', async () => {
  const f = fixture(); f.environment.LILLY_TEAMS_BROKER_NODE_NAME = 'fixture-node';
  const binder = createConfiguredOwnerBinder(f);
  const remote = createNodeRpcClient.mock.results[0].value.bindExecutionOwner;
  expect(remote).not.toHaveBeenCalled();
  const owner = { bootId: 'fixture' }; await binder(owner);
  expect(remote).toHaveBeenCalledWith({ owner, nodeName: 'fixture-node' });
  expect(createKubernetesComputerRuntime).not.toHaveBeenCalled();
});

test.each([undefined, '../node', 'unknown-node'])('rejects missing/unconfigured startup node %s', node => {
  const f = fixture(); f.environment.LILLY_TEAMS_BROKER_NODE_NAME = node;
  expect(() => createConfiguredOwnerBinder(f)).toThrow('Configured private browser transport is unavailable.');
});
test.each(['relative_config', 'relative_key', 'extra', 'version', 'oversized', 'unreadable', 'tls_failure'])('rejects %s without fallback or secret diagnostics', mode => {
  const f = fixture();
  if (mode === 'relative_config') f.environment.LILLY_TEAMS_NODE_RPC_CONFIG = 'relative.json';
  if (mode === 'relative_key') f.config.tlsFiles.key = 'private.key';
  if (mode === 'extra') f.config.allowInsecure = true;
  if (mode === 'version') f.config.version = 2;
  if (mode === 'oversized') f.read.mockReturnValue('x'.repeat(65537));
  if (mode === 'unreadable') f.read.mockImplementation(() => { throw new Error('PRIVATE CREDENTIAL LOCATION'); });
  if (mode === 'tls_failure') createNodeRpcClient.mockImplementationOnce(() => { throw new Error('PRIVATE TLS DETAILS'); });
  expect(() => createConfiguredComputerFactory(f)).toThrow('Configured private browser transport is unavailable.');
  expect(createKubernetesComputerRuntime).not.toHaveBeenCalled();
});
