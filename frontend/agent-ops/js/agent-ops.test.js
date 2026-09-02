const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const {
  normalizeOverview,
  normalizeWorkspace,
  matchesAgent,
  escapeHtml,
  renderMessageText,
  renderMessageList,
} = require('./agent-ops');

describe('Agent Command Center data boundary', () => {
  test('renders safe clickable handoff links without executing agent HTML', () => {
    const dom = new JSDOM(renderMessageList([{ from: 'Builder', message: 'Ready\n[Open website](https://canada.demoserver2.buzz/)\n<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))', links: [{ label: 'Unsafe', url: 'javascript:alert(1)' }], attachments: [{ label: 'Source', url: '/api/artifacts/source/download' }] }]));
    expect(dom.window.document.querySelector('img')).toBeNull();
    expect([...dom.window.document.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://canada.demoserver2.buzz/', '/api/artifacts/source/download']);
    expect(dom.window.document.querySelector('a').textContent).toBe('Open website');
    expect(dom.window.document.querySelector('a').rel).toContain('noopener');
    expect(renderMessageText('See https://example.test/path.')).toContain('href="https://example.test/path"');
    dom.window.close();
  });
  test('normalizes missing groups and null runtime metrics without inventing values', () => {
    const overview = normalizeOverview({
      project: { name: 'Runtime truth' },
      projects: [{ id: 'runtime', name: 'Runtime truth' }],
      groups: { working: [{ agentId: 'a1', displayName: 'Ada', metrics: { cpu: null, memory: null } }] },
    });

    expect(overview.groups.needsInput).toEqual([]);
    expect(overview.groups.idle).toEqual([]);
    expect(overview.groups.working[0]).toMatchObject({ id: 'a1', name: 'Ada', cpu: null, memory: null });
    expect(overview.projects).toEqual([{ id: 'runtime', name: 'Runtime truth' }]);
  });

  test('filters across operational agent fields case-insensitively', () => {
    const agent = normalizeOverview({ groups: { working: [{ id: 'mira', name: 'Mira', role: 'Test investigator', task: 'Investigate CI flake', currentAction: 'Re-running spec', model: 'gpt-5' }] } }).groups.working[0];

    expect(matchesAgent(agent, 'ci FLAKE')).toBe(true);
    expect(matchesAgent(agent, 'gpt-5')).toBe(true);
    expect(matchesAgent(agent, 'billing')).toBe(false);
  });

  test('escapes server-provided content before HTML rendering', () => {
    const dom = new JSDOM(`<div>${escapeHtml('<img src=x onerror=alert(1)>')}</div>`);

    expect(dom.window.document.querySelector('img')).toBeNull();
    expect(dom.window.document.querySelector('div').textContent).toBe('<img src=x onerror=alert(1)>');
  });

  test('normalizes every recorded workspace panel without inventing resources', () => {
    const workspace = normalizeWorkspace({
      agentId: 'builder',
      activity: [{ id: 'event-1' }],
      files: [{ name: 'index.html' }],
      editor: [{ name: 'index.html', content: '<main></main>' }],
      terminal: [{ command: 'run.started' }],
      browser: [{ url: '/api/artifacts/preview' }],
      artifacts: [{ id: 'artifact-1' }],
      messages: [{ message: 'Build started' }],
    });

    expect(workspace).toMatchObject({
      agentId: 'builder',
      files: [{ name: 'index.html' }],
      editor: [{ name: 'index.html', content: '<main></main>' }],
      terminal: [{ command: 'run.started' }],
      browser: [{ url: '/api/artifacts/preview' }],
      artifacts: [{ id: 'artifact-1' }],
      messages: [{ message: 'Build started' }],
    });
    expect(normalizeWorkspace({}).files).toEqual([]);
  });
});

describe('Agent Command Center interactions', () => {
  test('opens every operations view and hydrates every agent workspace tab', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, 'agent-ops.js'), 'utf8');
    const overview = {
      project: { id: 'main', name: 'Main project', goal: 'Ship verified work.', status: 'active', progress: 50 },
      projects: [{ id: 'main', name: 'Main project', active: true }],
      heartbeat: { healthy: true, ageSeconds: 2 },
      budget: {},
      groups: {
        needsInput: [],
        working: [{ id: 'builder', name: 'Builder', role: 'Engineer', task: 'Build the deck', status: 'running' }],
        idle: [],
      },
      selectedAgentId: 'builder',
      goalItems: [{ id: 'goal-1', title: 'Build', status: 'working' }],
      workflows: [{ id: 'workflow-1', title: 'Build workflow', status: 'running' }],
      artifacts: [{ id: 'artifact-1', name: 'report.md', previewUrl: '/api/artifacts/artifact-1/preview', deletable: true }],
      approvals: [],
      messages: [{ from: 'Builder', message: 'Site is ready. [Open website](https://example.test/site)', links: [{ label: 'Website', url: 'https://example.test/site' }] }],
      capabilities: {
        goalCreation: { enabled: true, endpoint: '/goals' },
        projects: { enabled: true, collectionEndpoint: '/projects', activateEndpointTemplate: '/projects/{projectId}/activate', deleteEndpointTemplate: '/projects/{projectId}' },
        artifactDeletion: { enabled: true, endpointTemplate: '/artifacts/{artifactId}' },
      },
    };
    const workspace = {
      agentId: 'builder',
      activity: [{ id: 'event-1', type: 'run.started', title: 'Run started', timestamp: '2026-08-31T12:00:00.000Z' }],
      files: [{ id: 'artifact-1', name: 'report.md', detail: 'markdown', url: '/api/artifacts/artifact-1/download', deletable: true }],
      editor: [{ name: 'report.md', path: 'report.md', language: 'markdown', content: '# Verified report' }],
      terminal: [{ command: 'run.started', output: 'Run started', status: 'running', timestamp: '2026-08-31T12:00:00.000Z' }],
      browser: [{ name: 'Report preview', url: '/api/artifacts/artifact-1/preview' }],
      artifacts: [{ id: 'artifact-1', name: 'report.md', previewUrl: '/api/artifacts/artifact-1/preview', deletable: true }],
      messages: [{ from: 'Builder', message: 'Run started', timestamp: '2026-08-31T12:00:00.000Z' }],
    };
    const dom = new JSDOM(html, {
      url: 'https://example.test/agent-ops/#agents',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    dom.window.matchMedia = jest.fn(() => ({ matches: false }));
    dom.window.fetch = jest.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => String(url).endsWith('/overview') ? overview : workspace,
    }));
    dom.window.eval(script);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dom.window.document.getElementById('latestAgentUpdate').hidden).toBe(false);
    expect(dom.window.document.querySelector('#latestAgentUpdate a[href="https://example.test/site"]')).not.toBeNull();
    for (const view of ['goals', 'agents', 'workflows', 'artifacts', 'approvals', 'messages']) {
      dom.window.document.querySelector(`[data-view="${view}"]`).click();
      expect(dom.window.document.getElementById(`view-${view}`).hidden).toBe(false);
      expect(dom.window.document.querySelector(`[data-view="${view}"]`).getAttribute('aria-current')).toBe('page');
    }

    for (const [tab, expected] of [
      ['activity', 'Run started'],
      ['files', 'report.md'],
      ['editor', 'Verified report'],
      ['terminal', 'run.started'],
      ['browser', 'Report preview'],
      ['artifacts', 'report.md'],
      ['messages', 'Run started'],
    ]) {
      dom.window.document.getElementById(`tab-${tab}`).click();
      const panel = dom.window.document.getElementById(`panel-${tab}`);
      expect(panel.hidden).toBe(false);
      expect(panel.textContent).toContain(expected);
    }
    expect(dom.window.document.getElementById('createGoalSubmit').disabled).toBe(false);
    expect(dom.window.fetch).toHaveBeenCalledWith(
      '/api/admin/agent-ops/agents/builder/workspace',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    dom.window.close();
  });

  test('creates and switches projects, then confirms scoped file and final project deletion', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, 'agent-ops.js'), 'utf8');
    const overview = {
      project: { id: 'main', name: 'Main project', goal: '', status: 'idle' },
      projects: [
        { id: 'main', name: 'Main project', active: true },
        { id: 'next', name: 'Next project', active: false },
      ],
      heartbeat: { healthy: true }, budget: {},
      groups: { needsInput: [], working: [], idle: [] },
      goalItems: [], workflows: [], approvals: [],
      artifacts: [{ id: 'artifact-1', name: 'report.md', deletable: true }],
      capabilities: {
        goalCreation: { enabled: true, endpoint: '/goals' },
        projects: { enabled: true, collectionEndpoint: '/projects', activateEndpointTemplate: '/projects/{projectId}/activate', deleteEndpointTemplate: '/projects/{projectId}' },
        artifactDeletion: { enabled: true, endpointTemplate: '/artifacts/{artifactId}' },
      },
    };
    const dom = new JSDOM(html, {
      url: 'https://example.test/agent-ops/#goals',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    dom.window.matchMedia = jest.fn(() => ({ matches: false }));
    dom.window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
    dom.window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
    dom.window.fetch = jest.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => String(url).endsWith('/overview') ? overview : {},
    }));
    dom.window.eval(script);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const projectSelect = dom.window.document.getElementById('projectSelect');
    projectSelect.value = 'next';
    projectSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dom.window.fetch).toHaveBeenCalledWith(
      '/api/admin/agent-ops/projects/next/activate',
      expect.objectContaining({ method: 'POST' }),
    );

    dom.window.document.querySelector('.view-new-project').click();
    dom.window.document.getElementById('projectNameInput').value = 'Fresh build';
    dom.window.document.getElementById('createProjectSubmit').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dom.window.fetch).toHaveBeenCalledWith(
      '/api/admin/agent-ops/projects',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Fresh build', companyGoal: '' }) }),
    );

    dom.window.document.querySelector('[data-delete-artifact="artifact-1"]').click();
    expect(dom.window.document.getElementById('deleteArtifactDialog').open).toBe(true);
    dom.window.document.getElementById('deleteArtifactSubmit').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dom.window.fetch).toHaveBeenCalledWith(
      '/api/admin/agent-ops/artifacts/artifact-1',
      expect.objectContaining({ method: 'DELETE' }),
    );

    dom.window.document.querySelector('.view-delete-project').click();
    expect(dom.window.document.getElementById('deleteProjectMessage').textContent).toContain('Main project');
    dom.window.document.getElementById('deleteProjectSubmit').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dom.window.fetch).toHaveBeenCalledWith(
      '/api/admin/agent-ops/projects/main',
      expect.objectContaining({ method: 'DELETE' }),
    );
    dom.window.close();
  });
});
