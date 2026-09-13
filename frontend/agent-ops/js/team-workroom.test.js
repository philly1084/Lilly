'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

function fixture(id = 'team-1') {
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), team: { id, name: `Persistent ${id}`, objective: 'Save a reviewed deliverable', limits: { maxAgents: 6, concurrency: 3 } },
    execution: { enabled: false, model: null, toolIds: [], origins: [], allowSideEffects: false, allowWebSockets: false, maxRounds: 12, maxCalls: 24, maxTimeMs: 120000 },
    agents: [{ id: `${id}-builder`, name: 'Mira', role: 'specialist', persona: 'Careful and concise', job: 'Build usable outputs', enabled: true, status: 'queued', currentTaskId: 'task-1' },
      { id: `${id}-reviewer`, name: 'Rex', role: 'reviewer', persona: 'Check recorded evidence', job: 'Review', enabled: true, status: 'idle' }],
    tasks: [{ id: 'task-1', agentId: `${id}-builder`, title: 'Build a usable result', instruction: 'Save the deliverable', status: 'queued' }],
    events: [{ id: 'e1', type: 'tool_finished', tool: 'artifact_write', agentId: `${id}-builder`, at: new Date().toISOString() }], messages: [],
    notes: [{ id: 'note-1', agentId: `${id}-builder`, content: 'Only shared evidence goes on the board.', source: 'Operator note' }], artifacts: [], skills: [], routines: [] };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('persistent team workroom interactions', () => {
  const windows = [];
  afterEach(() => windows.splice(0).forEach((window) => window.close()));
  function mount({ first = fixture(), intercept } = {}) {
    const snapshots = new Map([[first.team.id, first], ['team-2', fixture('team-2')]]);
    const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), { url: `https://fixture.test/agent-ops/?team=${first.team.id}`, runScripts: 'outside-only', pretendToBeVisual: true });
    windows.push(dom.window);
    let ids = 0;
    dom.window.crypto.randomUUID = () => `fixture-${++ids}`;
    dom.window.HTMLDialogElement.prototype.showModal = function open() { this.open = true; };
    dom.window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
    const respond = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
    dom.window.fetch = jest.fn(async (url, options = {}) => {
      const handled = intercept?.(url, options);
      if (handled) return handled;
      if (url === '/api/agent-teams/runtime') return respond({ enabled: false, visionEnabled: false, runtime: 'lilly' });
      if (url === '/api/agent-teams' && options.method !== 'POST') return respond({ teams: [...snapshots.values()].map((snapshot) => snapshot.team) });
      if (url.endsWith('/workroom')) return respond(snapshots.get(url.split('/')[3]));
      if (url.startsWith('/api/artifacts/')) return respond({ id: url.split('/').at(-1), filename: 'proof.md', downloadUrl: `${url}/download`, mimeType: 'text/markdown' });
      if (url === '/api/admin/agent-ops/overview') return respond({ project: { id: 'company', name: 'Existing company', goal: 'Existing mission' }, projects: [{ id: 'company', name: 'Existing company', active: true }], groups: {}, capabilities: { projects: true }, whiteboard: { notes: [] } });
      if (url === '/api/agent-teams' && options.method === 'POST') {
        const input = JSON.parse(options.body);
        const created = fixture('created-team'); created.team = { ...created.team, ...input }; created.agents = []; created.tasks = []; snapshots.set(created.team.id, created);
        return respond(created.team, 201);
      }
      if (url.endsWith('/commands')) {
        const snapshot = snapshots.get(url.split('/')[3]);
        const { action, input } = JSON.parse(options.body);
        if (action === 'create_agent') snapshot.agents.push({ id: 'new-agent', ...input, enabled: true, status: 'paused' });
        if (action === 'configure_execution') snapshot.execution = { ...snapshot.execution, ...input };
        if (action === 'control_agent') { const agent = snapshot.agents.find((entry) => entry.id === input.agentId); agent.enabled = input.action === 'resume'; agent.status = agent.enabled ? 'queued' : 'stopped'; }
        if (action === 'assign_task') snapshot.tasks.push({ id: 'new-task', ...input, status: 'queued' });
        if (action === 'remember') snapshot.notes.push({ id: 'new-note', ...input });
        if (action === 'send_message') snapshot.messages.push({ id: 'new-message', from: 'owner', ...input, createdAt: new Date().toISOString() });
        if (action === 'review_task') { const task = snapshot.tasks.find((entry) => entry.id === input.taskId); task.status = input.approved ? 'completed' : 'changes_requested'; task.review = { note: input.note, approved: input.approved }; }
        return respond({ result: { recorded: true } });
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    dom.window.eval(fs.readFileSync(path.join(__dirname, 'team-client.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.join(__dirname, 'agent-ops.js'), 'utf8'));
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    return { window: dom.window, document: dom.window.document, snapshots, first };
  }
  const submit = (window, form, submitter) => form.dispatchEvent(new window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }));
  const commands = (window) => window.fetch.mock.calls.filter(([url]) => url.endsWith('/commands')).map(([, options]) => JSON.parse(options.body));

  test('slow file detail does not block activity and late enrichment preserves the operator input', async () => {
    const first = fixture(); let release;
    first.agents[0].status = 'running'; first.agents[0].activity = { kind: 'waiting_for_team' };
    first.artifacts = [{ id: 'a1', sha256: 'a'.repeat(64), agentId: 'team-1-builder', taskId: 'task-1' }];
    const { document, window } = mount({ first, intercept: url => url === '/api/artifacts/a1'
      ? new Promise(resolve => { release = resolve; }) : null });
    await flush();
    expect(document.getElementById('stageContent').hidden).toBe(false);
    expect(document.getElementById('syncState').textContent).toContain('Live ·');
    expect(document.getElementById('selectedAgentState').textContent).toBe('Waiting for teammate');
    expect(document.querySelector('#artifactList a')).toBeNull();
    const input = document.querySelector('#panel-console textarea');
    input.value = 'Keep this unfinished message'; input.focus();
    release({ ok: true, json: async () => ({ id: 'a1', sha256: 'a'.repeat(64), filename: 'verified.md', downloadUrl: '/api/artifacts/a1/download' }) });
    await flush();
    expect(document.querySelector('#artifactList a').textContent).toContain('verified.md');
    expect(document.querySelector('#panel-console textarea')).toBe(input);
    expect(input.value).toBe('Keep this unfinished message'); expect(document.activeElement).toBe(input);
    expect(commands(window)).toEqual([]);
  });

  test('a newer activity refresh cannot be overwritten by old file details', async () => {
    const first = fixture(); let release; let signal;
    first.artifacts = [{ id: 'a1', sha256: 'a'.repeat(64), agentId: 'team-1-builder', taskId: 'task-1' }];
    const { document } = mount({ first, intercept: (url, options) => url === '/api/artifacts/a1'
      ? new Promise(resolve => { release = resolve; signal = options.signal; }) : null });
    await flush(); first.artifacts = []; first.agents[0].job = 'Newer activity';
    document.getElementById('refreshButton').click(); await flush(); expect(signal.aborted).toBe(false);
    release({ ok: true, json: async () => ({ id: 'a1', filename: 'OLD_ARTIFACT', sha256: 'a'.repeat(64) }) }); await flush();
    expect(document.getElementById('artifactCount').textContent).toBe('0');
    expect(document.body.textContent).not.toContain('OLD_ARTIFACT');
  });

  test('browser panel renders recorded checkpoints without private page fields or live-state claims', async () => {
    const first = fixture();
    first.events.push({ id: 'browser-1', agentId: 'team-1-builder', type: 'tool_finished', tool: 'computer_act',
      at: new Date().toISOString(), title: 'PRIVATE_PAGE', url: 'https://private.example', screenshot: 'data:image/png;base64,PRIVATE' });
    const { document, window } = mount({ first }); await flush();
    expect(document.getElementById('syncState').textContent).toContain('Live ·');
    expect(document.getElementById('syncState').textContent).not.toContain('Syncing');
    document.querySelector('[data-panel="screen"]').click();
    const panel = document.getElementById('panel-screen');
    expect(panel.textContent).toContain('Act in private browser · finished');
    expect(panel.textContent).toContain('do not confirm the browser is still running');
    expect(panel.innerHTML).not.toMatch(/PRIVATE|private.example|data:image|<iframe|<img/);
    expect(commands(window)).toEqual([]);
  });

  test('station and selected-agent labels show observed waits, tool work and heartbeat uncertainty', async () => {
    const { window, document, first } = mount();
    first.agents[0].status = 'running'; first.agents[0].activity = { kind: 'waiting_for_team' };
    first.tasks[0].status = 'running';
    await flush();
    document.getElementById('refreshButton').click(); await flush();
    expect(document.querySelector('#opsFloor .agent-station.waiting').textContent).toContain('Waiting for teammate');
    expect(document.getElementById('selectedAgentState').textContent).toBe('Waiting for teammate');
    first.agents[0].activity = { kind: 'using_tool', tool: 'artifact_read' };
    document.getElementById('refreshButton').click(); await flush();
    expect(document.querySelector('#opsFloor .agent-station.working').textContent).toContain('Using tool · artifact_read');
    first.agents[0].activity = { kind: 'unconfirmed' };
    document.getElementById('refreshButton').click(); await flush();
    expect(document.getElementById('selectedAgentState').textContent).toBe('Heartbeat unconfirmed');
    expect(document.querySelector('#opsFloor .agent-station.waiting').textContent).toContain('Heartbeat unconfirmed');
    expect(commands(window)).toEqual([]);
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
  });

  test('failed live refresh clears working claims and a successful refresh restores observed activity', async () => {
    let offline = false;
    const { document, first } = mount({ intercept: (url) => offline && url.endsWith('/workroom') ? Promise.reject(new Error('Fixture offline')) : null });
    first.agents[0].status = 'running'; first.agents[0].activity = { kind: 'waiting_for_team' };
    first.tasks[0].status = 'running';
    await flush(); document.getElementById('refreshButton').click(); await flush();
    expect(document.getElementById('selectedAgentState').textContent).toBe('Waiting for teammate');
    offline = true; document.getElementById('refreshButton').click(); await flush();
    expect(document.getElementById('syncState').textContent).toContain('Sync failed');
    expect(document.getElementById('selectedAgentState').textContent).toBe('Heartbeat unconfirmed');
    expect(document.getElementById('heartbeatCard').textContent).toContain('Live connection unconfirmed');
    expect(first.tasks[0].status).toBe('running');
    offline = false; document.getElementById('refreshButton').click(); await flush();
    expect(document.getElementById('selectedAgentState').textContent).toBe('Waiting for teammate');
  });

  test('renders persisted identities and true queued state without browser pixels or automatic execution', async () => {
    const { window, document } = mount(); await flush();
    expect(document.getElementById('teamToolbar').hidden).toBe(false);
    expect(document.getElementById('teamExecutionState').textContent).toBe('Execution paused');
    expect(document.getElementById('newGoalButton').getAttribute('aria-label')).toBe('Queue task');
    expect(document.getElementById('refreshButton').getAttribute('aria-label')).toBe('Sync workroom');
    expect(document.getElementById('selectedAgentState').textContent).toBe('queued');
    expect(document.querySelector('.agent-station.working')).toBeNull();
    expect(document.getElementById('sharedTeamNotes').textContent).toContain('Only shared evidence');
    expect(document.getElementById('panel-console').textContent).toContain('Activity log');
    expect(document.getElementById('panel-console').textContent).toContain('not a PTY');
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.getElementById('panel-desk').textContent).toContain('Careful and concise');
    expect(commands(window)).toEqual([]);
    expect(window.fetch.mock.calls.some(([url]) => url === '/api/agent-teams/team-1')).toBe(false);
  });

  test('adds a persistent teammate, queues a task, and enables execution only through explicit form save', async () => {
    const { window, document } = mount(); await flush();
    document.getElementById('addTeammateButton').click();
    const person = document.getElementById('teammateForm');
    person.elements.name.value = 'Ada'; person.elements.job.value = 'Research checked sources'; person.elements.persona.value = 'Evidence first';
    submit(window, person); await flush();
    expect(commands(window)[0]).toEqual({ action: 'create_agent', input: { name: 'Ada', role: 'specialist', job: 'Research checked sources', persona: 'Evidence first' } });
    document.getElementById('newGoalButton').click();
    const task = document.getElementById('teamTaskForm');
    task.elements.title.value = 'Save report'; task.elements.instruction.value = 'Write and check report'; task.elements.reviewerId.value = 'team-1-reviewer';
    submit(window, task); await flush();
    expect(commands(window)[1]).toMatchObject({ action: 'assign_task', input: { reviewerId: 'team-1-reviewer' } });
    expect(commands(window).some((entry) => entry.action === 'configure_execution')).toBe(false);
    document.getElementById('configureTeamButton').click();
    const execution = document.getElementById('teamExecutionForm');
    expect(execution.elements.enabled.checked).toBe(false);
    execution.elements.enabled.checked = true;
    submit(window, execution); await flush();
    expect(commands(window).at(-1)).toMatchObject({ action: 'configure_execution', input: { enabled: true, allowSideEffects: false, allowWebSockets: false } });
  });

  test('request, shared note, stop and resume use team commands without promising same-run restart', async () => {
    const { window, document } = mount(); await flush();
    const composer = document.querySelector('[data-agent-input-form]');
    composer.elements.message.value = 'Please check the report'; submit(window, composer); await flush();
    expect(commands(window)[0]).toEqual({ action: 'send_message', input: { to: ['team-1-builder'], kind: 'request', body: 'Please check the report' } });
    document.getElementById('newBoardNoteButton').click();
    expect(document.getElementById('wakeCrewInput').closest('label').hidden).toBe(true);
    document.getElementById('boardNoteInput').value = 'The read-back is required'; document.getElementById('createBoardNoteSubmit').click(); await flush();
    expect(commands(window)[1]).toMatchObject({ action: 'remember', input: { scope: 'team', content: 'The read-back is required' } });
    document.getElementById('stopAgentButton').click(); await flush();
    expect(document.getElementById('restartAgentButton').textContent).toContain('Resume');
    document.getElementById('restartAgentButton').click(); await flush();
    expect(commands(window).slice(-2)).toEqual([{ action: 'control_agent', input: { agentId: 'team-1-builder', action: 'stop' } }, { action: 'control_agent', input: { agentId: 'team-1-builder', action: 'resume' } }]);
  });

  test('creates inactive team with stable keyed request and no wake/configuration command', async () => {
    const { window, document } = mount(); await flush();
    document.getElementById('newTeamButton').click();
    const form = document.getElementById('teamCreateForm');
    form.elements.name.value = 'New crew'; form.elements.objective.value = 'Build a separate outcome'; submit(window, form); await flush();
    const create = window.fetch.mock.calls.find(([url, options]) => url === '/api/agent-teams' && options.method === 'POST');
    expect(create[1].headers['Idempotency-Key']).toMatch(/^workroom:/);
    expect(JSON.parse(create[1].body)).not.toHaveProperty('enabled');
    expect(commands(window)).toEqual([]);
    expect(document.getElementById('teamExecutionState').textContent).toBe('Execution paused');
    expect(document.getElementById('crewCount').textContent).toBe('0');
  });

  test('drafts survive refresh and team switching cannot revive late old-team responses', async () => {
    const { window, document } = mount(); await flush();
    const input = document.querySelector('[name="message"]'); input.value = 'Keep this draft'; input.dispatchEvent(new window.Event('input'));
    document.getElementById('refreshButton').click(); await flush();
    expect(document.querySelector('[name="message"]').value).toBe('Keep this draft');
    let delayed;
    const original = window.fetch.getMockImplementation();
    window.fetch.mockImplementation((url, options) => url.includes('team-1/workroom') ? new Promise((resolve) => { delayed = resolve; }) : original(url, options));
    document.getElementById('refreshButton').click(); await flush();
    const select = document.getElementById('projectSelect'); select.value = 'team:team-2'; select.dispatchEvent(new window.Event('change')); await flush();
    delayed({ ok: true, json: async () => fixture('team-1') }); await flush();
    expect(document.getElementById('projectSelect').value).toBe('team:team-2');
    expect(document.getElementById('selectedAgentName').textContent).toBe('Mira');
    expect(document.querySelector('[data-agent-input-form]').dataset.agentId).toBe('team-2-builder');
    expect(document.querySelector('[name="message"]').value).toBe('');
    expect(commands(window)).toEqual([]);
  });

  test('returning to company projects is a read-only selection, not implicit activation', async () => {
    const { window, document } = mount(); await flush();
    const select = document.getElementById('projectSelect');
    expect(select.querySelector('option[value="legacy"]').textContent).toBe('Return to company projects');
    select.value = 'legacy'; select.dispatchEvent(new window.Event('change')); await flush();
    expect(document.getElementById('missionTitle').textContent).toBe('Existing mission');
    expect(document.getElementById('newGoalButton').getAttribute('aria-label')).toBe('New mission');
    expect(window.fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toEqual([]);
  });

  test('owner review requires a note, linked artifact evidence and explicit inspection confirmation', async () => {
    const first = fixture(); const sha256 = 'a'.repeat(64);
    first.tasks[0].status = 'needs_review'; first.tasks[0].result = { summary: 'Saved report for review.', artifacts: [{ id: 'artifact-1', sha256 }] };
    first.artifacts = [{ id: 'artifact-1', sha256, taskId: 'task-1', agentId: 'team-1-builder', reviewStatus: 'needs_review' }];
    const { window, document } = mount({ first }); await flush();
    document.querySelector('[data-team-review]').click();
    const form = document.getElementById('teamReviewForm'); const approve = form.querySelector('[value="approve"]');
    expect(document.getElementById('reviewArtifactEvidence').textContent).toContain(sha256);
    expect(document.getElementById('reviewArtifactEvidence').querySelector('a').href).toContain('/download');
    form.elements.note.value = 'Read all output and checked the requested result.'; submit(window, form, approve); await flush();
    expect(commands(window)).toEqual([]);
    form.elements.inspected.checked = true; submit(window, form, approve); await flush();
    expect(commands(window).at(-1)).toMatchObject({ action: 'review_task', input: { approved: true, taskId: 'task-1' } });
  });

  test('changed artifact rejection keeps review draft open without marking completion', async () => {
    const first = fixture(); const sha256 = 'a'.repeat(64);
    first.tasks[0].status = 'needs_review'; first.tasks[0].result = { artifacts: [{ id: 'artifact-1', sha256 }] };
    first.artifacts = [{ id: 'artifact-1', sha256, taskId: 'task-1', agentId: 'team-1-builder' }];
    const { window, document } = mount({ first, intercept: (url, options) => url.endsWith('/commands') && JSON.parse(options.body).action === 'review_task'
      ? { ok: false, status: 409, json: async () => ({ error: { message: 'Artifact bytes changed; inspect the current result.' } }) } : null });
    await flush(); document.querySelector('[data-team-review]').click();
    const form = document.getElementById('teamReviewForm');
    form.elements.note.value = 'Checked the output.'; form.elements.inspected.checked = true;
    submit(window, form, form.querySelector('[value="approve"]')); await flush();
    expect(document.getElementById('teamReviewDialog').open).toBe(true);
    expect(form.elements.note.value).toBe('Checked the output.');
    expect(form.querySelector('.form-error').textContent).toContain('Artifact bytes changed');
    expect(first.tasks[0].status).toBe('needs_review');
  });

  test('review without artifact links cannot be approved from the UI', async () => {
    const first = fixture(); first.tasks[0].status = 'needs_review'; first.tasks[0].result = { summary: 'A claim without evidence.', artifacts: [] };
    const { document } = mount({ first }); await flush(); document.querySelector('[data-team-review]').click();
    expect(document.querySelector('#teamReviewForm [value="approve"]').disabled).toBe(true);
    expect(document.querySelector('#teamReviewForm [value="changes"]').disabled).toBe(false);
  });
  test('task templates expose only approved skill revisions and send selected skill id', async () => {
    const first = fixture(); first.skills = [{ id: 'draft', name: 'Unreviewed', status: 'draft', revision: 2 }, { id: 'approved', name: 'Checked', status: 'approved', revision: 1 }];
    const { document, window } = mount({ first }); await flush(); document.getElementById('newGoalButton').click();
    const form = document.getElementById('teamTaskForm');
    expect([...form.elements.skillId.options].map((option) => option.value)).toEqual(['', 'approved']);
    form.elements.title.value = 'Task with checked skill'; form.elements.instruction.value = 'Save the inspected output.'; form.elements.skillId.value = 'approved';
    submit(window, form); await flush(); expect(commands(window).at(-1)).toMatchObject({ action: 'assign_task', input: { skillId: 'approved' } });
  });
});
