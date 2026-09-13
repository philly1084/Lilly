'use strict';

const path = require('path');
const os = require('node:os');
const { isIPv4 } = require('node:net');
const { TeamService } = require('./service');
const { TeamRunner } = require('./runner');
const { TeamReconciler } = require('./reconciler');
const { createTeamWorker, readBackArtifact } = require('./worker');
const { AgentComputerRuntime } = require('../agent-computer/runtime');
const { GrokWorkerBroker } = require('./worker-broker');
const { createExecutionOwnerResolver } = require('./execution-owner');

const BROKER_ORIGIN = 'http://lilly-worker-broker.kimibuilt.svc.cluster.local:3001';

function owningBrokerConfiguration(environment) {
  // Downward API values, not configurable Service routing or session affinity:
  // https://kubernetes.io/docs/concepts/workloads/pods/downward-api/
  // Release wiring: status.podIP, metadata.uid, metadata.name, metadata.namespace.
  // Match the IP to this process's network namespace as an additional guard
  // against accidentally retaining a Service IP or another replica's address.
  const brokerPodIP = environment.LILLY_TEAMS_BROKER_POD_IP;
  const brokerPodUid = environment.LILLY_TEAMS_BROKER_POD_UID;
  const brokerPodName = environment.LILLY_TEAMS_BROKER_POD_NAME;
  const namespace = environment.LILLY_TEAMS_BROKER_POD_NAMESPACE;
  if (environment.LILLY_TEAMS_BROKER_CLUSTER_IP || environment.LILLY_TEAMS_WORKER_BASE_URL) throw new Error('Shared worker broker routing is not supported.');
  if (!isIPv4(brokerPodIP || '') || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(brokerPodIP)
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(brokerPodUid || '')
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(brokerPodName || '') || namespace !== 'kimibuilt'
    || !Object.values(os.networkInterfaces()).flat().some(entry => entry && !entry.internal
      && ['IPv4', 4].includes(entry.family) && entry.address === brokerPodIP)) {
    throw new Error('Verified owning broker Pod identity is required.');
  }
  return { brokerPodIP, brokerPodUid, brokerPodName };
}

function createTeamRuntime({ sessionStore, artifactService, toolManager, getModelClient, defaultModel,
  chromium, store, environment = process.env, authorizeTool = null, observeToolSettlement = null,
  grokWorkerFactory = null, observeQuiescence = null, bindExecutionContainer = null, computerFactory = null }) {
  const enabled = environment.LILLY_TEAMS_ENABLED === 'true';
  const recoveryRequested = environment.LILLY_TEAMS_RECOVERY_ENABLED === 'true';
  if (observeQuiescence !== null && typeof observeQuiescence !== 'function') throw new Error('Invalid recovery observer.');
  if (bindExecutionContainer !== null && typeof bindExecutionContainer !== 'function') throw new Error('Invalid execution container binder.');
  if (computerFactory !== null && typeof computerFactory !== 'function') throw new Error('Invalid supervised computer factory.');
  const visionEnabled = environment.LILLY_TEAMS_VISION_ENABLED === 'true';
  const computerTransport = environment.LILLY_TEAMS_COMPUTER_TRANSPORT || 'in-process';
  if (!['in-process', 'kubernetes'].includes(computerTransport)) throw new Error('Unsupported private computer transport.');
  if (computerFactory && computerTransport === 'kubernetes') throw new Error('Configured computer transport cannot be overridden.');
  const engine = environment.LILLY_TEAMS_ENGINE || 'lilly';
  if (!['lilly', 'grok-build'].includes(engine)) throw new Error('Unsupported Lilly team engine.');
  const allowedToolIds = new Set(String(environment.LILLY_TEAMS_TOOL_ALLOWLIST || '').split(',').map((id) => id.trim()).filter(Boolean));
  const service = new TeamService({ store, verifyArtifact: async (scope) => {
    const artifact = await artifactService.getArtifact(scope.artifactId, { includeContent: true });
    return readBackArtifact(artifact, scope);
  } });
  // Recovery is separate from admission: an operator may disable execution yet
  // still need interrupted tasks investigated. Only deployment code can provide
  // the authoritative observer; neither environment flags nor owner commands
  // can manufacture quiescence evidence.
  const reconciler = recoveryRequested && observeQuiescence
    ? new TeamReconciler({ service, artifactService, observeQuiescence }) : null;
  let factory = grokWorkerFactory;
  const brokerConfiguration = engine === 'grok-build' && (factory || environment.LILLY_TEAMS_GROK_IMAGE)
    ? owningBrokerConfiguration(environment) : null;
  if (engine === 'grok-build' && !factory && environment.LILLY_TEAMS_GROK_IMAGE) {
    factory = require('../grok-build/kubernetes-supervisor').createKubernetesWorkerFactory({
      service, configuration: { namespace: 'lilly-team-workers', image: environment.LILLY_TEAMS_GROK_IMAGE,
        ...brokerConfiguration },
    });
  }
  const engineAvailable = engine === 'lilly' || typeof factory === 'function';
  const bindOwnerRequested = environment.LILLY_TEAMS_BIND_EXECUTION_OWNER === 'true';
  if (bindOwnerRequested && bindExecutionContainer) throw new Error('Configured execution owner binding cannot be overridden.');
  const executionBinder = enabled && engineAvailable && bindOwnerRequested
    ? require('../agent-computer/configured-factory').createConfiguredOwnerBinder({ environment }) : bindExecutionContainer;
  const broker = engine === 'grok-build' && engineAvailable ? new GrokWorkerBroker({
    // Each worker resolves this private alias to THIS Pod's verified address.
    // The alias deliberately has no Service/DNS fallback to another process.
    baseUrl: BROKER_ORIGIN,
    modelRequest: (body, options) => getModelClient().responses.create(body, options),
    authorize: async (scope) => !(await service.heartbeat(scope.teamId, scope.ownerId, scope.claim)).cancelled,
  }) : null;
  const provisionGrokWorker = broker ? async (scope) => {
    const model = scope.model || defaultModel;
    // Broker stores only trusted identity and budgets, never its own token in
    // a team row. Credentials are passed privately into the worker's Secret.
    const { signal, ...identity } = scope;
    const lease = broker.open(identity, { signal, model, deadlineMs: scope.maxTimeMs, maxModelCalls: scope.maxModelCalls });
    try {
      const worker = await factory({ ...scope, model, modelEndpoint: lease.modelEndpoint, modelToken: lease.modelToken });
      return { ...worker, connectBridge: lease.connectBridge,
        close: async () => { lease.close(); await worker.close(); } };
    } catch (error) { lease.close(); throw error; }
  } : null;
  const computerOptions = enabled && engineAvailable && visionEnabled ? {
    chromium,
    rootDir: path.resolve(environment.LILLY_TEAMS_COMPUTER_ROOT || path.join(process.cwd(), 'data', 'team-computers')),
    executablePath: environment.PLAYWRIGHT_EXECUTABLE_PATH || environment.CHROME_BIN || undefined,
    allowWebSockets: environment.LILLY_TEAMS_WEBSOCKETS_ENABLED === 'true',
    authorize: async ({ identity, operation, url }) => {
      const team = await service.get(identity.teamId, identity.ownerId);
      const agent = team.agents.find((entry) => entry.id === identity.agentId);
      if (!team.execution?.enabled || !agent?.enabled) return false;
      try { service.engineTask(team, { ...identity, taskId: identity.claim?.taskId }); }
      catch (_) { return false; }
      let origin;
      try {
        const target = new URL(url);
        if (!['http:', 'https:', ...(operation === 'websocket' ? ['ws:', 'wss:'] : [])].includes(target.protocol)) return false;
        origin = target.origin.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
      } catch (_) { return false; }
      if (!team.execution.origins.includes(origin)) return false;
      if (operation === 'act' && !team.execution.allowSideEffects) return false;
      if (operation === 'websocket' && (!team.execution.allowWebSockets || !team.execution.allowSideEffects)) return false;
      return true;
    },
  } : null;
  // Deployment owns process/container acquisition and injects its private
  // transport. Models and owner commands cannot select a transport or command.
  // An explicit transport opt-in loads backend-only mTLS configuration. Failure
  // is terminal for construction; never downgrade an opted-in supervised browser.
  const selectedComputerFactory = computerOptions && computerTransport === 'kubernetes'
    ? require('../agent-computer/configured-factory').createConfiguredComputerFactory({ environment }) : computerFactory;
  const computer = computerOptions ? (selectedComputerFactory ? selectedComputerFactory({ ...computerOptions, service }) : new AgentComputerRuntime(computerOptions)) : null;
  const execute = createTeamWorker({ service, sessionStore, artifactService, toolManager, computer, visionEnabled,
    // Generic remote tools may return a job handle before their work stops.
    // A dedicated adapter must establish settlement for those tools. Our default
    // synchronous search lane completes when its request promise resolves.
    observeToolSettlement: observeToolSettlement || (async ({ toolId, result }) => toolId === 'web-search'
      && result?.success === true && !result.error && !result.errorCode
      && !['pending', 'queued', 'running', 'accepted'].includes(result.status)
      && !result.jobId && !result.taskId),
    ...(engine === 'grok-build' && engineAvailable ? {
      loop: require('./grok-loop').createGrokTaskLoop({ createWorker: provisionGrokWorker }),
    } : {}),
    authorizeTool: async (request) => {
      const current = await service.get(request.identity.teamId, request.identity.ownerId);
      if (!current.execution?.enabled || !current.execution.toolIds.includes(request.toolId) || !allowedToolIds.has(request.toolId)) return false;
      if (authorizeTool) return authorizeTool({ ...request, team: current });
      // Default: no host filesystem, remote shell, self-delegating or general
      // browser tool bypass. Richer adapters require explicit scoped policies.
      // web-fetch also supports writes and internal artifact URLs. Its name is
      // not a read-only capability; require a scoped adapter before granting it.
      return request.toolId === 'web-search';
    },
    respond: async ({ input, tools, instructions, model, signal }) => {
      const response = await getModelClient().responses.create({ model: model || defaultModel, input, tools, instructions,
        max_output_tokens: 8192, store: false }, { signal, maxRetries: 0 });
      return response;
    },
  });
  const runner = new TeamRunner({ service, resolveExecutionOwner: createExecutionOwnerResolver({ environment, bindContainer: executionBinder }), execute: engineAvailable ? execute : async () => {
    throw new Error('Grok supervisor unavailable; no engine fallback permitted.');
  } });
  let stopped = false;
  let resourceShutdown = null;
  let shutdownReport = null;
  let listenerAcquisition = null;
  return {
    service, runner, computer, broker, reconciler,
    status: () => ({ enabled: enabled && engineAvailable && !stopped, visionEnabled: Boolean(computer) && !stopped, runtime: engine,
      grokEnabled: enabled && engine === 'grok-build' && engineAvailable && !stopped,
      ...(recoveryRequested ? { recovery: { available: Boolean(reconciler), enabled: Boolean(reconciler?.timer) && !stopped,
        pending: Boolean(reconciler?.pending), ...(!reconciler ? { reason: 'quiescence_observer_unavailable' } : {}) } } : {}),
      ...(stopped ? { shutdown: shutdownReport ? { settled: shutdownReport.settled,
        resourcesClosed: shutdownReport.resourcesClosed, pendingTasks: shutdownReport.pendingTaskIds.length,
        admissionUncertain: shutdownReport.admissionUncertain } : { settled: false } } : {}),
      ...(!engineAvailable ? { reason: 'grok_supervisor_unavailable' } : {}) }),
    start: async () => {
      // Browser disposal and token revocation are one-way for this instance.
      // A new runtime must investigate durable unsettled work, not revive it.
      if (stopped) throw Object.assign(new Error('Stopped team runtime cannot restart.'), { code: 'team_runtime_stopped' });
      if (enabled && engineAvailable) {
        await runner.prepareOwner();
        if (stopped) throw Object.assign(new Error('Stopped team runtime cannot restart.'), { code: 'team_runtime_stopped' });
        if (broker) { listenerAcquisition = broker.listen(); await listenerAcquisition; }
        if (stopped) {
          // Shutdown owns the same acquisition promise and its late cleanup.
          throw Object.assign(new Error('Stopped team runtime cannot restart.'), { code: 'team_runtime_stopped' });
        }
        runner.start();
      }
      reconciler?.start();
    },
    stop: async ({ timeoutMs = 10000 } = {}) => {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid runtime shutdown deadline.');
      stopped = true;
      runner.stop();
      reconciler?.stop();
      // Retain the SAME cleanup promise after an observation timeout. A second
      // stop call must not mistake a quick no-op for the old cleanup completing.
      if (!resourceShutdown) resourceShutdown = Promise.allSettled([
        // A rejected investigation is settled, not a successful recovery. The
        // controller keeps unresolved work occupied. Never replace a still-live
        // investigation with a quick second stop or declare shutdown complete.
        Promise.resolve(reconciler?.pending).catch(() => {}),
        Promise.resolve().then(async () => {
          await broker?.close();
          if (broker && listenerAcquisition) {
            await listenerAcquisition.catch(() => {});
            await broker.close();
          }
        }),
        Promise.resolve().then(() => computer?.dispose()).then((results) => {
          if (Array.isArray(results) && results.some((result) => result.status !== 'fulfilled')) throw new Error('Browser cleanup incomplete.');
        }),
      ]).then((results) => results.every((result) => result.status === 'fulfilled'));
      let timer;
      try {
        const [drain, resourcesClosed] = await Promise.all([
          runner.drain({ timeoutMs }),
          Promise.race([resourceShutdown, new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]),
        ]);
        shutdownReport = { ...drain, resourcesClosed, settled: drain.settled && resourcesClosed };
        return shutdownReport;
      } finally { clearTimeout(timer); }
    },
  };
}

module.exports = { createTeamRuntime };
