'use strict';

const { createChannel } = require('./stdio-channel');
const { normalizeIdentity } = require('./runtime');
const fail = code => Object.assign(new Error(`Private computer transport: ${code}`), { code });
const METHODS = ['open', 'observe', 'act', 'getModelInput', 'tabs', 'close'];
const wireName = name => name === 'getModelInput' ? 'model_input' : name;

// Trusted deployment adapter supplies already-owned process pipes and an exact
// container termination function. No image/command/path/token comes from a model.
function connectComputer({ input, output, authorize, terminate, timeoutMs = 20000 } = {}) {
  if (typeof authorize !== 'function' || typeof terminate !== 'function') throw fail('computer_supervisor_required');
  let disposal; let stopped = false; let termination;
  const stopProcess = () => termination ||= Promise.resolve().then(terminate);
  const channel = createChannel({ input, output, timeoutMs,
    handlers: { authorize: async request => {
      if (stopped || !request || !['open', 'act', 'observe', 'navigate', 'request', 'websocket', 'model_input', 'tabs'].includes(request.operation)) return false;
      normalizeIdentity(request.identity);
      const verdict = await authorize(request);
      return !stopped && (verdict === true || verdict?.allowed === true);
    } },
    onBroken: () => { stopped = true; return stopProcess(); },
  });
  const runtime = {
    isPreDispatchFailure: error => channel.isPreDispatchFailure(error),
    dispose() {
      if (disposal) return disposal;
      stopped = true;
      disposal = (async () => {
        const result = await Promise.allSettled([channel.request('dispose', {})]);
        channel.close();
        const terminationResult = await Promise.allSettled([stopProcess()]);
        if (result[0].status === 'fulfilled' && result[0].value?.closed !== true) result[0] = { status: 'rejected', reason: fail('computer_remote_cleanup_unconfirmed') };
        return [...result, ...terminationResult];
      })();
      return disposal;
    },
  };
  for (const method of METHODS) runtime[method] = async (identity, args = {}) => {
    if (stopped) throw fail('computer_disposed');
    normalizeIdentity(identity);
    const { signal, ...value } = args;
    return channel.request(wireName(method), { identity, input: value }, { signal });
  };
  return runtime;
}

// Browser-process endpoint. createRuntime must construct the production browser
// runtime with the supplied authorization callback. No provider client belongs here.
function serveComputer({ input, output, createRuntime, timeoutMs = 20000 } = {}) {
  if (typeof createRuntime !== 'function') throw fail('computer_runtime_factory_required');
  let runtime; let disposal;
  const dispose = () => disposal ||= Promise.resolve().then(() => runtime.dispose());
  const handlers = { dispose: async () => ({ closed: (await dispose()).every(result => result.status === 'fulfilled') }) };
  for (const method of METHODS) handlers[wireName(method)] = async (value, signal) => {
    if (disposal) throw fail('computer_disposed');
    if (!value || !value.input || typeof value.input !== 'object' || Array.isArray(value.input)) throw fail('computer_invalid_request');
    normalizeIdentity(value.identity);
    return runtime[method](value.identity, { ...value.input, signal });
  };
  const channel = createChannel({ input, output, handlers, timeoutMs,
    errorProof: error => runtime?.isPreDispatchFailure(error) === true,
    onBroken: () => dispose(),
  });
  runtime = createRuntime({ authorize: ({ signal, ...request }) => channel.request('authorize', request, { signal }) });
  return { runtime, close: async () => { channel.close(); return dispose(); } };
}

module.exports = { connectComputer, serveComputer };
