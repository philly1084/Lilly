'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const {
  normalizeOverview,
  normalizeWorkspace,
  normalizeAgent,
  agentStatusClass,
  buildAgentWorkspaceUrl,
  safeUrl,
  escapeHtml,
} = require('./agent-ops');

describe('Agent Workroom data boundary', () => {
  test('normalizes real operations groups without inventing runtime data', () => {
    const overview = normalizeOverview({
      project: { id: 'project-1', name: 'Release room' },
      groups: {
        needsInput: [{ agentId: 'release', displayName: 'Rex', task: 'Approve release' }],
        working: [{ id: 'builder', name: 'Mira', currentAction: 'Running tests', model: null }],
      },
    });

    expect(overview.groups.needsInput[0]).toMatchObject({ id: 'release', name: 'Rex', statusClass: 'waiting' });
    expect(overview.groups.working[0]).toMatchObject({ id: 'builder', name: 'Mira', statusClass: 'working', model: 'model not reported' });
    expect(overview.groups.idle).toEqual([]);
  });

  test('maps execution states to visible game-floor states', () => {
    expect(agentStatusClass('waiting_for_approval')).toBe('waiting');
    expect(agentStatusClass('blocked')).toBe('waiting');
    expect(agentStatusClass('verifying')).toBe('working');
    expect(agentStatusClass('completed')).toBe('idle');
    expect(normalizeAgent({ id: 'a1' }, 'working').statusClass).toBe('working');
  });

  test('normalizes every recorded workstation channel', () => {
    const workspace = normalizeWorkspace({
      agentId: 'builder',
      timeline: [{ id: 'event-1' }],
      files: [{ name: 'index.html' }],
      editor: [{ content: '<main></main>' }],
      terminal: [{ command: 'npm test' }],
      browser: [{ url: '/preview/' }],
      artifacts: [{ id: 'artifact-1' }],
      messages: [{ message: 'Done' }],
      whiteboard: { path: '.kimibuilt/agent-company/board.md' },
      controls: { canReceiveInput: true },
    });

    expect(workspace).toMatchObject({
      agentId: 'builder',
      activity: [{ id: 'event-1' }],
      terminal: [{ command: 'npm test' }],
      browser: [{ url: '/preview/' }],
      messages: [{ message: 'Done' }],
      whiteboard: { path: '.kimibuilt/agent-company/board.md' },
      controls: { canReceiveInput: true },
    });
  });

  test('normalizes durable shared-board notes', () => {
    const overview = normalizeOverview({
      whiteboard: {
        path: '.kimibuilt/agent-company/board.md',
        sections: ['now', 'waiting', 'done'],
        notes: [{ id: 'note-1', column: 'waiting', content: 'Need operator evidence.' }],
      },
    });

    expect(overview.whiteboard).toEqual({
      path: '.kimibuilt/agent-company/board.md',
      sections: ['now', 'waiting', 'done'],
      notes: [{ id: 'note-1', column: 'waiting', content: 'Need operator evidence.' }],
    });
  });

  test('builds an isolated embedded Web Chat desk for each agent', () => {
    const url = buildAgentWorkspaceUrl({ id: 'Release Guardian', name: 'Rex' });
    const parsed = new URL(url, 'https://example.test');

    expect(parsed.pathname).toBe('/web-chat/');
    expect(parsed.searchParams.get('workspace')).toBe('agent-release-guardian');
    expect(parsed.searchParams.get('workspaceLabel')).toBe('Rex desk');
    expect(parsed.searchParams.get('embedded')).toBe('1');
  });

  test('escapes UI text and only accepts bounded preview URLs', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toContain('&lt;img');
    expect(safeUrl('/api/artifacts/a/preview')).toBe('/api/artifacts/a/preview');
    expect(safeUrl('https://example.test/preview')).toBe('https://example.test/preview');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('Agent Workroom interactions', () => {
  function createWorkroom() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, 'agent-ops.js'), 'utf8');
    const overview = {
      project: { id: 'main', name: 'Main room', goal: 'Ship visible proof.', status: 'active', progress: 50 },
      projects: [{ id: 'main', name: 'Main room', active: true }],
      heartbeat: { status: 'healthy', ageSeconds: 2 },
      budget: {},
      groups: {
        needsInput: [{ id: 'release', name: 'Rex', role: 'Release guardian', task: 'Approve rollout', status: 'needs_input', approval: { id: 'approval-1', title: 'Promote release' } }],
        working: [{ id: 'builder', name: 'Mira', role: 'Builder', task: 'Build the site', status: 'working', currentAction: 'Running tests' }],
        idle: [],
      },
      selectedAgentId: 'release',
      goalItems: [
        { id: 'goal-1', title: 'Build the site', agentName: 'Mira', status: 'working' },
        { id: 'goal-2', title: 'Approve rollout', agentName: 'Rex', status: 'needs_input' },
      ],
      artifacts: [{ id: 'artifact-1', name: 'report.md', detail: 'Markdown', previewUrl: '/api/artifacts/artifact-1/preview' }],
      messages: [{ from: 'Mira', message: 'Build ready for Rex.', timestamp: '2026-09-03T12:00:00.000Z' }],
      whiteboard: { path: '.kimibuilt/agent-company/board.md', notes: [] },
      capabilities: {
        goalCreation: { enabled: true, endpoint: '/goals' },
        projects: { enabled: true, collectionEndpoint: '/projects', activateEndpointTemplate: '/projects/{projectId}/activate' },
        workspace: { enabled: true, endpointTemplate: '/agents/{agentId}/workspace' },
        operatorInput: { enabled: true, endpointTemplate: '/agents/{agentId}/input' },
        whiteboard: { enabled: true, endpoint: '/whiteboard/notes' },
        approvals: true,
      },
    };
    const workspaces = {
      release: {
        agentId: 'release',
        terminal: [{ command: 'agent.wait', output: 'Waiting for approval', status: 'waiting', timestamp: '2026-09-03T12:00:00.000Z' }],
        browser: [{ name: 'Canary', url: '/launchpad/' }],
        files: [{ id: 'artifact-1', name: 'report.md', detail: 'Markdown', url: '/api/artifacts/artifact-1/download' }],
        artifacts: [], messages: [], editor: [], activity: [], controls: { canReceiveInput: true },
      },
      builder: { agentId: 'builder', terminal: [{ command: 'npm test', output: '12 passed' }], browser: [], files: [], artifacts: [], messages: [], editor: [], activity: [], controls: { canReceiveInput: true } },
    };
    const dom = new JSDOM(html, { url: 'https://example.test/agent-ops/', runScripts: 'outside-only', pretendToBeVisual: true });
    dom.window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
    dom.window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
    dom.window.fetch = jest.fn(async (url) => {
      const source = String(url);
      const workspaceMatch = source.match(/\/agents\/([^/]+)\/workspace$/);
      const body = source.endsWith('/overview') ? overview : workspaceMatch ? workspaces[decodeURIComponent(workspaceMatch[1])] : {};
      return { ok: true, status: 200, statusText: 'OK', json: async () => body };
    });
    dom.window.eval(script);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    return { dom, overview };
  }

  test('renders a live game floor, terminal, whiteboard, handoff, and artifact shelf', async () => {
    const { dom } = createWorkroom();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(dom.window.document.querySelectorAll('.agent-station')).toHaveLength(2);
    expect(dom.window.document.querySelector('.agent-station.waiting').textContent).toContain('Rex');
    expect(dom.window.document.getElementById('panel-console').textContent).toContain('agent.wait');
    expect(dom.window.document.getElementById('boardColumns').textContent).toContain('Build the site');
    expect(dom.window.document.getElementById('artifactList').textContent).toContain('report.md');
    expect(dom.window.document.getElementById('handoffList').textContent).toContain('Build ready for Rex.');
    expect(dom.window.document.getElementById('loadingState').hidden).toBe(true);
    dom.window.close();
  });

  test('switches workstations and opens a real isolated Web Chat desk only on demand', async () => {
    const { dom } = createWorkroom();
    await new Promise((resolve) => setTimeout(resolve, 25));

    dom.window.document.querySelector('[data-agent-id="builder"]').click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(dom.window.document.getElementById('selectedAgentName').textContent).toBe('Mira');
    expect(dom.window.document.getElementById('panel-console').textContent).toContain('npm test');
    expect(dom.window.document.querySelector('#panel-desk iframe')).toBeNull();

    dom.window.document.getElementById('tab-desk').click();
    const frame = dom.window.document.querySelector('#panel-desk iframe');
    expect(frame).not.toBeNull();
    expect(new URL(frame.src).searchParams.get('workspace')).toBe('agent-builder');
    expect(new URL(frame.src).searchParams.get('embedded')).toBe('1');
    dom.window.close();
  });

  test('resolves a waiting agent approval through the real operations endpoint', async () => {
    const { dom } = createWorkroom();
    await new Promise((resolve) => setTimeout(resolve, 25));

    dom.window.document.querySelector('[data-approval-id="approval-1"]').click();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(dom.window.fetch).toHaveBeenCalledWith(
      '/api/admin/agent-ops/approvals/approval-1/resolve',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ decision: 'approve' }) }),
    );
    dom.window.close();
  });

  test('records operator input on the selected agent run', async () => {
    const { dom } = createWorkroom();
    await new Promise((resolve) => setTimeout(resolve, 25));

    dom.window.document.querySelector('[data-agent-id="builder"]').click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const form = dom.window.document.querySelector('[data-agent-input-form=""]');
    const input = form.querySelector('[name="message"]');
    input.value = 'Use the existing browser proof and finish the handoff.';
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(dom.window.fetch).toHaveBeenCalledWith(
      '/api/admin/agent-ops/agents/builder/input',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'Use the existing browser proof and finish the handoff.' }),
      }),
    );
    dom.window.close();
  });

  test('pins a durable shared-board note and wakes the crew', async () => {
    const { dom } = createWorkroom();
    await new Promise((resolve) => setTimeout(resolve, 25));

    dom.window.document.getElementById('newBoardNoteButton').click();
    dom.window.document.getElementById('boardNoteColumn').value = 'waiting';
    dom.window.document.getElementById('boardNoteInput').value = 'Verify the public artifact before promotion.';
    dom.window.document.getElementById('createBoardNoteSubmit').click();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(dom.window.fetch).toHaveBeenCalledWith(
      '/api/admin/agent-ops/whiteboard/notes',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          column: 'waiting',
          content: 'Verify the public artifact before promotion.',
          wakeCrew: true,
          targetAgentId: 'release',
        }),
      }),
    );
    dom.window.close();
  });
});
