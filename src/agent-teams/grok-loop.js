'use strict';

const { createTaskMcpBridge } = require('../grok-build/task-mcp-bridge');

const fault = (code) => Object.assign(new Error(`Grok task: ${code}`), { code: `team_grok_${code}` });

// createWorker is a TRUSTED deployment adapter, not a model tool. It must
// provision an isolated supervised worker, scoped model route and persistent
// home, returning { client, sessionId?, saveSession(id), close() }. close must
// resolve only once the worker and its descendants have actually terminated.
// No host-shell fallback exists here. A transport client alone is insufficient.
function createGrokTaskLoop({ createWorker, createBridge = createTaskMcpBridge }) {
  if (typeof createWorker !== 'function') throw fault('supervisor_required');
  return async ({ scope, tools, dispatch, input, instructions, signal, onEvent = () => {}, maxCalls = 24, maxTimeMs = 120000,
    hasCompletionEvidence = async () => true }) => {
    if (!scope?.teamId || !scope?.agentId || !scope?.ownerId || !scope?.taskId) throw fault('scope_required');
    if (!Number.isSafeInteger(maxTimeMs) || maxTimeMs < 1000 || maxTimeMs > 600000) throw fault('invalid_deadline');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, maxTimeMs);
    let worker;
    let bridge;
    let summary = '';
    let overflow = false;
    const guard = () => { if (controller.signal.aborted) throw fault('cancelled_or_timed_out'); };
    const update = ({ update: entry } = {}) => {
      // Only final assistant text is considered a report; thought chunks,
      // browser frames, tool arguments and tool results stay private.
      if (entry?.sessionUpdate !== 'agent_message_chunk' || entry.content?.type !== 'text') return;
      if (typeof entry.content.text !== 'string' || summary.length + entry.content.text.length > 12000) {
        overflow = true; controller.abort(); return;
      }
      summary += entry.content.text;
      if (/data:image\//i.test(summary)) { overflow = true; controller.abort(); }
    };
    const cancel = () => {
      try { worker?.client.cancel(); } catch (_) { /* Supervisor close is authoritative. */ }
      // A stopped ACP transport rejects the pending prompt. The enclosing
      // finally still waits for supervisor confirmation of descendant exit.
      try { worker?.client.close(); } catch (_) { /* Supervisor close follows. */ }
    };
    controller.signal.addEventListener('abort', cancel, { once: true });
    try {
      guard();
      // The factory must honour signal while acquiring its lease. We await its
      // actual result instead of dropping a late worker creation promise.
      worker = await createWorker({ ...scope, signal: controller.signal });
      if (!worker?.client || typeof worker.close !== 'function' || typeof worker.saveSession !== 'function') throw fault('invalid_supervisor');
      guard();
      const init = await worker.client.start(worker.startOptions || {});
      guard();
      // Screenshots arrive as authenticated MCP tool-result image blocks, not
      // ACP session/prompt attachments. The pinned Grok binary's real loop
      // consumes these even though promptCapabilities.image is omitted.
      // HTTP MCP is required; model vision is still an explicit runtime opt-in
      // and needs its own live perception proof. Never put pixels in prompt text.
      if (tools.some((tool) => tool.name.startsWith('computer_')) && init.agentCapabilities?.mcpCapabilities?.http !== true) throw fault('private_image_transport_unsupported');
      bridge = await createBridge({ tools, dispatch, signal: controller.signal, onEvent, maxCalls, deadlineMs: maxTimeMs });
      guard();
      const descriptor = worker.connectBridge ? await worker.connectBridge(bridge.mcpServer) : bridge.mcpServer;
      guard();
      if (typeof worker.client.setTaskMcpPermissions !== 'function') throw fault('task_permissions_unavailable');
      worker.client.setTaskMcpPermissions({ serverName: descriptor.name, toolNames: tools.map(tool => tool.name) });
      const session = await worker.client.openSession({ sessionId: worker.sessionId, mcpServers: [descriptor] });
      await worker.saveSession(session.sessionId);
      guard();
      // Grok loads MCP catalogs asynchronously after session creation/replay.
      // Never spend the assignment's first prompt discovering an empty catalog.
      if (typeof bridge.waitForCatalog !== 'function') throw fault('catalog_readiness_unavailable');
      const discovery = await bridge.waitForCatalog({ signal: controller.signal, timeoutMs: Math.min(30000, maxTimeMs) });
      guard();
      if (discovery?.catalogServed !== true) throw fault('catalog_not_served');
      // Attach after session replay so prior-turn messages do not become the
      // current result. The session id was durably saved before new work starts.
      worker.client.on('update', update);
      const prompt = `${instructions}\n\nAssigned task:\n${JSON.stringify(input)}`;
      if (Buffer.byteLength(prompt) > 128 * 1024) throw fault('prompt_limit');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await worker.client.prompt(attempt === 0 ? prompt
          : 'Your assignment is missing required saved deliverables. Check the original assignment and required filenames, continue using the scoped tools, and save the actual remaining deliverables with artifact_write. A promise to save them is not execution. Do not create extra agents, change permissions, or expand the task.');
        guard();
        if (overflow) throw fault('private_or_excess_output');
        if (result.stopReason !== 'end_turn' || !summary.trim()) throw fault('incomplete_turn');
        const complete = await hasCompletionEvidence();
        guard();
        if (complete === true) return { summary: summary.trim() };
        if (complete !== false) throw fault('invalid_completion_evidence');
        summary = '';
      }
      throw fault('completion_evidence_missing');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort();
      controller.signal.removeEventListener('abort', cancel);
      worker?.client?.removeListener?.('update', update);
      // Revoke tools first; never permit a closing worker to keep changing the
      // team. If shutdown cannot be confirmed, throw and retain reconciliation.
      try {
        if (bridge && (await bridge.close())?.settled !== true) throw fault('tools_unsettled');
      } finally { if (typeof worker?.close === 'function') await worker.close(); }
    }
  };
}

module.exports = { createGrokTaskLoop };
