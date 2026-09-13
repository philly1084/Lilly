'use strict';
const { randomUUID } = require('node:crypto');
const { readBackArtifact } = require('./worker');

// Live scenario, not scripted inference. The caller owns isolated workers,
// private browser, shared model budget and authoritative resource cleanup.
async function runLiveTeamScenario({ service, runner, artifactService, browserOrigin, signal,
  ownerId = 'proof-owner', onProgress = () => {} }) {
  const marker = randomUUID();
  const team = await service.create(ownerId, { name: `Live Grok team ${marker.slice(0, 8)}`,
    objective: 'Use the private test page, collaborate, save and independently review a deliverable.',
    maxAgents: 3, maxTasks: 5, concurrency: 3, restSeconds: 0 });
  const command = (action, input) => service.ownerCommand(team.id, ownerId, action, input, randomUUID());
  const writer = await command('create_agent', { name: 'Writer', job: 'Observe the private fixture, write a draft and incorporate peer feedback.' });
  const peer = await command('create_agent', { name: 'Peer', job: 'Read the writer draft, save team memory and reply with concise feedback.' });
  const reviewer = await command('create_agent', { name: 'Reviewer', role: 'reviewer', job: 'Read every submitted artifact before deciding whether to approve.' });
  const origin = await browserOrigin({ team, agents: [writer, peer, reviewer] });
  let writerTask;
  try {
    await command('configure_execution', { enabled: true, toolIds: [], origins: [origin],
      allowSideEffects: false, maxRounds: 20, maxCalls: 24, maxTimeMs: 300000 });
    writerTask = await command('assign_task', { agentId: writer.id, reviewerId: reviewer.id, title: 'Observe and collaborate',
      requiredArtifacts: ['draft.md', 'final.md'],
      instruction: `Open ${origin} with computer_open and describe only what you can actually observe. Save draft.md containing marker ${marker} and the observed page title. Send exactly one request message to peer ${peer.id}, including the draft artifact ID and instructions to read it, save team memory, and reply to your request with the marker and one concrete observation. That request automatically schedules the peer. Use team_wait for their reply, then save final.md incorporating it. Do not create agents or separately assign tasks. Never publish browser image data.` });
    onProgress({ type: 'team_created', teamId: team.id, marker });
    await runner.tick();
    let state;
    while (!signal.aborted) {
      state = await service.get(team.id, ownerId);
      const failed = state.tasks.find(t => ['failed', 'reconciling', 'cancelled'].includes(t.status));
      if (failed) throw Object.assign(new Error('Live worker outcome unconfirmed'), { code: 'live_team_worker_unconfirmed' });
      if (state.tasks.find(t => t.id === writerTask.id)?.status === 'completed' && runner.active.size === 0) break;
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 250); signal.addEventListener('abort', done, { once: true });
      });
      if (!signal.aborted) await runner.tick();
    }
    if (signal.aborted) throw Object.assign(new Error('Live test deadline reached'), { code: 'live_team_deadline' });
    const task = state.tasks.find(t => t.id === writerTask.id);
    const verified = [];
    for (const ref of task.result?.artifacts || []) {
      const artifactId = typeof ref === 'string' ? ref : ref.id;
      verified.push(readBackArtifact(await artifactService.getArtifact(artifactId, { includeContent: true }), { ownerId, teamId: team.id, taskId: task.id }));
    }
    if (!verified.some(a => a.filename === 'final.md' && a.content.includes(marker))
      || !state.messages.some(m => m.from === peer.id) || !state.memories.length) {
      throw Object.assign(new Error('Live collaboration evidence missing'), { code: 'live_team_evidence_missing' });
    }
    return { teamId: team.id, marker, writerTaskId: task.id, artifacts: verified.map(({ id, sha256, filename }) => ({ id, sha256, filename })) };
  } finally {
    runner.stop();
    await command('configure_execution', { enabled: false });
  }
}
module.exports = { runLiveTeamScenario };
