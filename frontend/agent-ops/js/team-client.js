(function teamClientModule(scope) {
  'use strict';
  const array = (value) => Array.isArray(value) ? value : [];
  const statusLabel = (value) => ({ waiting_for_team: 'Waiting for teammate', connection_unconfirmed: 'Heartbeat unconfirmed' }[value]
    || String(value || 'idle').replace(/_/g, ' '));

  function computerCheckpoints(events) {
    const tools = { computer_open: 'Open private browser', computer_observe: 'Observe private browser', computer_act: 'Act in private browser' };
    const states = { tool_started: 'started', tool_finished: 'finished', tool_failed: 'failed' };
    // History, not browser liveness. Never copy a page title, URL, tool arguments,
    // call identifier, result or image from an event into this operator surface.
    return array(events).filter(event => Object.hasOwn(tools, event.tool) && Object.hasOwn(states, event.type))
      .slice(-24).reverse().map(event => ({
        title: `${tools[event.tool]} · ${states[event.type]}`,
        timestamp: Number.isFinite(Date.parse(event.at)) ? event.at : null,
      }));
  }

  function createClient({ fetch: fetcher, storage, uuid = () => scope.crypto.randomUUID(), timeoutMs = 12000 } = {}) {
    const pending = new Map();
    const metadata = new Map();
    const metadataPending = new Map();
    let metadataAbort = new AbortController();
    const cancelMetadata = () => {
      metadataAbort.abort(); metadataAbort = new AbortController(); metadataPending.clear();
    };
    async function receiptSignature(value) {
      if (!scope.crypto?.subtle) return { key: value, persistent: false };
      const bytes = new TextEncoder().encode(value);
      const digest = await scope.crypto.subtle.digest('SHA-256', bytes);
      return { key: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''), persistent: true };
    }
    const read = (key) => { try { return JSON.parse(storage?.getItem(key) || 'null'); } catch { return null; } };
    const write = (key, value) => { try { if (value === null) storage?.removeItem(key); else storage?.setItem(key, JSON.stringify(value)); } catch { /* In-memory command keys still protect this page. */ } };
    async function request(url, options = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      const timer = setTimeout(abort, timeoutMs);
      try {
        const response = await fetcher(url, { ...options, credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...options.headers }, signal: controller.signal });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          const error = new Error(data?.error?.message || `Team request failed (${response.status}).`);
          error.status = response.status;
          error.uncertain = response.status >= 500;
          throw error;
        }
        return data;
      } catch (error) {
        if (!error.status) error.uncertain = true;
        if (error.name === 'AbortError') error.message = 'Request interrupted. A write may have been recorded; retrying the same command uses its original receipt.';
        throw error;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      }
    }
    const list = async (signal) => array((await request('/api/agent-teams', { signal }))?.teams);
    async function mutate(url, payload, signature) {
      const receipt = await receiptSignature(signature);
      signature = receipt.key;
      const storageKey = `lilly-team-command:${signature}`;
      const key = pending.get(signature) || (receipt.persistent && read(storageKey)) || `workroom:${uuid()}`;
      pending.set(signature, key); if (receipt.persistent) write(storageKey, key);
      try {
        const response = await request(url, {
          method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload),
        });
        pending.delete(signature); write(storageKey, null);
        return response;
      } catch (error) {
        if (!error.uncertain) { pending.delete(signature); write(storageKey, null); }
        throw error;
      }
    }
    async function command(teamId, action, input) {
      return (await mutate(`/api/agent-teams/${encodeURIComponent(teamId)}/commands`, { action, input }, JSON.stringify([teamId, action, input]))).result;
    }
    async function create(input) {
      const signature = JSON.stringify(['create', input]);
      const receipt = await receiptSignature(signature);
      if (!pending.has(receipt.key) && !(receipt.persistent && read(`lilly-team-command:${receipt.key}`))) {
        if ((await list()).some((team) => team.name === input.name)) throw new Error('A team with this name already exists. Select it from the room picker.');
      }
      return mutate('/api/agent-teams', input, signature);
    }
    async function load(teamId, signal) {
      const [snapshot, runtime] = await Promise.all([
        request(`/api/agent-teams/${encodeURIComponent(teamId)}/workroom`, { signal }),
        request('/api/agent-teams/runtime', { signal }).catch(() => ({ enabled: false, unavailable: true })),
      ]);
      if (snapshot?.schemaVersion !== 1 || snapshot?.team?.id !== teamId) throw new Error('Unsupported or mismatched team workroom response.');
      // Activity is authoritative without optional file-detail enrichment. Let
      // the caller render it first; each verified file can become usable later.
      let enrichment;
      const loadMetadata = (onUpdate = () => {}) => {
        if (!enrichment) enrichment = Promise.allSettled(array(snapshot.artifacts).slice(-20).map(async (artifact) => {
          const key = `${teamId}:${artifact.id}:${artifact.sha256}`;
          if (!metadata.has(key) && !signal?.aborted) {
            if (!metadataPending.has(key)) {
              // File reads outlive an individual activity refresh, otherwise a
              // slow response can be cancelled forever by the polling cadence.
              const controller = metadataAbort;
              const work = request(`/api/artifacts/${encodeURIComponent(artifact.id)}`, { signal: controller.signal }).then(item => {
                const reportedHash = item?.sha256 || item?.metadata?.sha256;
                if (item?.id !== artifact.id || (reportedHash && reportedHash !== artifact.sha256)) throw new Error('Artifact metadata does not match the recorded evidence.');
                if (!controller.signal.aborted) metadata.set(key, item);
              }).finally(() => { if (metadataPending.get(key) === work) metadataPending.delete(key); });
              metadataPending.set(key, work);
            }
            await metadataPending.get(key);
            if (signal?.aborted || !metadata.has(key)) return;
            onUpdate();
          }
        }));
        return enrichment;
      };
      return { snapshot, runtime, metadata, loadMetadata };
    }
    const memories = async (teamId, signal) => array((await request(`/api/agent-teams/${encodeURIComponent(teamId)}/memories`, { signal }))?.memories);
    return { list, command, create, load, memories, cancelMetadata };
  }

  function projectSnapshot(snapshot, runtime = {}, metadata = new Map()) {
    const { team, execution } = snapshot;
    const agents = array(snapshot.agents);
    const tasks = array(snapshot.tasks);
    const name = (id) => id === 'owner' ? 'You' : agents.find((agent) => agent.id === id)?.name || 'Teammate';
    const artifacts = array(snapshot.artifacts).map((artifact) => {
      const detail = metadata.get(`${team.id}:${artifact.id}:${artifact.sha256}`);
      return { id: artifact.id, sha256: artifact.sha256, agentId: artifact.agentId, taskId: artifact.taskId,
        name: detail?.filename || `Saved artifact ${artifact.id.slice(0, 8)}`,
        detail: `${statusLabel(artifact.reviewStatus)}${detail?.mimeType ? ` · ${detail.mimeType}` : ' · metadata unavailable'}`,
        ...(detail ? { downloadUrl: detail.downloadUrl, previewUrl: detail.previewUrl } : {}) };
    });
    const messages = array(snapshot.messages).map((message) => ({ id: message.id, from: name(message.from),
      fromId: message.from, to: message.to, message: message.body, status: message.kind, timestamp: message.createdAt }));
    const groups = { working: [], needsInput: [], idle: [] };
    const workspaces = new Map();
    for (const agent of agents) {
      const current = tasks.find((task) => task.id === agent.currentTaskId);
      const ownEvents = array(snapshot.events).filter((entry) => entry.agentId === agent.id || entry.actorId === agent.id);
      const checkpoints = computerCheckpoints(ownEvents);
      const activity = agent.status === 'running' ? agent.activity : null;
      const status = activity?.kind === 'waiting_for_team' ? 'waiting_for_team'
        : activity?.kind === 'unconfirmed' ? 'connection_unconfirmed' : agent.status;
      const group = status === 'running' ? 'working' : ['idle', 'stopped', 'resting'].includes(status) ? 'idle' : 'needsInput';
      groups[group].push({ ...agent, status, task: current?.title || agent.job,
        currentAction: activity?.kind === 'using_tool' ? `Using tool · ${activity.tool || 'in progress'}` : statusLabel(status), model: execution.model || runtime.runtime || 'model not configured',
        lastHeartbeatSeconds: agent.lastActivityAt ? Math.max(0, (Date.now() - Date.parse(agent.lastActivityAt)) / 1000) : null,
        controls: { canStop: agent.enabled, canRestart: !agent.enabled } });
      workspaces.set(agent.id, {
        agentId: agent.id, controls: { canReceiveInput: true },
        terminal: ownEvents.slice(-60).map((event) => ({ timestamp: event.at, command: `${event.type}${event.tool ? ` · ${event.tool}` : ''}`, output: '', status: event.type })),
        messages: messages.filter((message) => message.fromId === agent.id || array(message.to).includes(agent.id)),
        tasks: tasks.filter((task) => task.agentId === agent.id),
        persona: agent.persona, job: agent.job,
        artifacts: artifacts.filter((artifact) => artifact.agentId === agent.id), files: [],
        privateBrowser: { private: true, exposedToOperator: false,
          status: checkpoints.length ? 'Recorded browser activity · current browser state not reported' : runtime.visionEnabled ? 'Available when authorized' : 'Unavailable',
          signals: checkpoints },
      });
    }
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const overview = {
      generatedAt: snapshot.generatedAt,
      project: { id: team.id, name: team.name, goal: team.objective, progress: tasks.length ? Math.round(completed / tasks.length * 100) : 0,
        status: execution.enabled ? 'execution enabled' : 'paused', taskSummary: `${completed} of ${tasks.length} tasks reviewed complete` },
      projects: [], groups, heartbeat: {}, artifacts: artifacts.slice().reverse(), messages: messages.slice().reverse(),
      goalItems: tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, agentName: name(task.agentId),
        boardColumn: task.status === 'completed' ? 'done' : ['running'].includes(task.status) ? 'now' : 'waiting' })),
      whiteboard: { notes: array(snapshot.notes).map((note) => ({ ...note, author: name(note.agentId) })) },
      capabilities: { operatorInput: { enabled: true, endpointTemplate: 'team-command' }, agentControl: { enabled: true }, whiteboard: { enabled: true } },
    };
    return { overview, workspaces };
  }

  const api = { createClient, projectSnapshot, statusLabel, computerCheckpoints };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  scope.LillyTeamClient = api;
}(typeof window !== 'undefined' ? window : globalThis));
