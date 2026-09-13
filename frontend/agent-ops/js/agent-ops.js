(function agentWorkroomModule(globalScope) {
  'use strict';

  const API_ROOT = '/api/admin/agent-ops';
  const ACTIVE_REFRESH_MS = 4500;
  const IDLE_REFRESH_MS = 11000;
  const REQUEST_TIMEOUT_MS = 12000;
  const PANELS = ['console', 'desk', 'screen', 'files'];

  const demoOverview = {
    generatedAt: new Date().toISOString(),
    project: { id: 'demo-project', name: 'Orbital release room', goal: 'Ship the verified release without losing the remote job cursor.', progress: 58, status: 'active' },
    projects: [{ id: 'demo-project', name: 'Orbital release room', active: true, sessionId: 'agent-company-demo' }],
    heartbeat: { status: 'healthy', ageSeconds: 7, reason: 'crew_tick_completed', intervalSeconds: 30 },
    budget: { usedTokens: 29400, limitTokens: 72000, utilizationPercent: 40.8 },
    groups: {
      needsInput: [{ id: 'release', name: 'Rex', role: 'Release guardian', task: 'Promote build 2.18', currentAction: 'Approval needed: production rollout', status: 'needs_input', model: 'gpt-5.6-sol', lastHeartbeatSeconds: 9, enabled: true, controls: { canStop: true, canRestart: false }, approval: { id: 'approval-demo', title: 'Production approval' } }],
      working: [
        { id: 'builder', name: 'Mira', role: 'Builder', task: 'Repair checkout workspace', currentAction: 'Running browser verification', status: 'working', model: 'gpt-5.6-sol', lastHeartbeatSeconds: 4, enabled: true, controls: { canStop: true, canRestart: false } },
        { id: 'research', name: 'Ada', role: 'Researcher', task: 'Check provider contracts', currentAction: 'Comparing primary sources', status: 'working', model: 'gpt-5.6-terra', lastHeartbeatSeconds: 6, enabled: true, controls: { canStop: true, canRestart: false } },
      ],
      idle: [{ id: 'review', name: 'Lin', role: 'Reviewer', task: 'Await verified artifact', currentAction: 'Standing by', status: 'idle', model: 'gpt-5.6-luna', lastHeartbeatSeconds: 18, enabled: false, controls: { canStop: false, canRestart: true } }],
    },
    selectedAgentId: 'release',
    goalItems: [
      { id: 'goal-1', title: 'Repair checkout workspace', agentName: 'Mira', status: 'working' },
      { id: 'goal-2', title: 'Verify provider contract', agentName: 'Ada', status: 'working' },
      { id: 'goal-3', title: 'Approve production rollout', agentName: 'Rex', status: 'needs_input', blockedBy: 'Operator approval required.' },
      { id: 'goal-4', title: 'Publish release evidence', agentName: 'Lin', status: 'planned' },
    ],
    artifacts: [{ id: 'artifact-demo', name: 'checkout-proof.md', detail: 'Markdown · 18 KB', previewUrl: '#demo-artifact' }],
    messages: [{ id: 'handoff-demo', from: 'Mira', task: 'Checkout repair', message: 'Browser verification passed. Handing the release proof to Rex.', timestamp: new Date().toISOString() }],
    whiteboard: { path: '.kimibuilt/agent-company/2026-W36-whiteboard.md', notes: [] },
    approvals: [{ id: 'approval-demo', agentId: 'release', agentName: 'Rex', title: 'Production approval', task: 'Promote build 2.18' }],
    capabilities: {
      goalCreation: { enabled: true, endpoint: '/goals' },
      projects: { enabled: true, collectionEndpoint: '/projects', activateEndpointTemplate: '/projects/{projectId}/activate' },
      workspace: { enabled: true, endpointTemplate: '/agents/{agentId}/workspace' },
      operatorInput: { enabled: true, endpointTemplate: '/agents/{agentId}/input' },
      agentControl: { enabled: true, endpointTemplate: '/agents/{agentId}/control', actions: ['stop', 'restart'] },
      whiteboard: { enabled: true, endpoint: '/whiteboard/notes' },
      approvals: true,
      approvalDecisions: ['approve'],
      stream: false,
    },
  };

  const demoWorkspaces = {
    release: {
      agentId: 'release',
      terminal: [
        { timestamp: new Date(Date.now() - 18000).toISOString(), status: 'running', command: 'kubectl rollout status', output: 'deployment/kimibuilt successfully rolled out' },
        { timestamp: new Date(Date.now() - 9000).toISOString(), status: 'waiting', command: 'agent.wait', output: 'Production promotion is waiting for operator approval.' },
      ],
      messages: [{ from: 'Rex', message: 'The image and public canary are ready. I need approval to promote.', timestamp: new Date().toISOString() }],
      browser: [{ name: 'Release canary', url: '/launchpad/' }],
      files: [{ id: 'artifact-demo', name: 'checkout-proof.md', detail: 'Verified release evidence', url: '#demo-artifact' }],
      artifacts: [{ id: 'artifact-demo', name: 'checkout-proof.md', detail: 'Markdown · 18 KB', previewUrl: '#demo-artifact' }],
      editor: [],
      activity: [],
      privateBrowser: { private: true, persistent: true, exposedToOperator: false, status: 'active', captureCount: 2, lastActivityAt: new Date().toISOString(), signals: [{ title: 'Release canary', host: 'localhost', timestamp: new Date().toISOString() }] },
    },
    builder: {
      agentId: 'builder',
      terminal: [{ timestamp: new Date().toISOString(), status: 'running', command: 'node bin/kimibuilt-ui-check.js', output: 'desktop: passed\nmobile: passed\nhorizontal-overflow: 0' }],
      messages: [{ from: 'Mira', message: 'The repaired workspace is visible on desktop and mobile.', timestamp: new Date().toISOString() }],
      browser: [{ name: 'Checkout preview', url: '/web-chat/' }],
      files: [], artifacts: [], editor: [], activity: [],
      privateBrowser: { private: true, persistent: true, exposedToOperator: false, status: 'active', captureCount: 1, lastActivityAt: new Date().toISOString(), signals: [{ title: 'Checkout preview', host: 'localhost', timestamp: new Date().toISOString() }] },
    },
  };

  const state = {
    demo: false,
    overview: null,
    selectedAgentId: null,
    activePanel: 'console',
    workspaces: new Map(),
    workspaceErrors: new Map(),
    messageDrafts: new Map(),
    pendingMessages: new Set(),
    refreshTimer: null,
    refreshing: false,
    hasLoaded: false,
    lastSyncAt: null,
    deskFocused: false,
    teamId: null,
    teamClient: null,
    teamSnapshot: null,
    teamRuntime: null,
    teamList: [],
    legacyProjects: [],
    generation: 0,
    refreshToken: 0,
    refreshAbort: null,
  };

  function asArray(value) { return Array.isArray(value) ? value : []; }
  function text(value, fallback = '') { return value === null || value === undefined || value === '' ? fallback : String(value); }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  }
  function slug(value) {
    return String(value || 'agent').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'agent';
  }
  function initials(value) {
    return String(value || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
  }
  function safeUrl(value) {
    const source = String(value || '').trim();
    if (/^\/(?!\/)[^\s\\]*$/.test(source) || /^#[a-z0-9_-]+$/i.test(source)) return source;
    try {
      const parsed = new URL(source);
      return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null;
    } catch (_error) { return null; }
  }
  function formatTime(value) {
    const date = new Date(value || 0);
    return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function formatAge(seconds) {
    const amount = Number(seconds);
    if (!Number.isFinite(amount)) return 'not reported';
    if (amount < 60) return `${Math.max(0, Math.round(amount))}s ago`;
    return `${Math.round(amount / 60)}m ago`;
  }

  function agentStatusClass(status = '') {
    const normalized = String(status).toLowerCase();
    if (['needs_input', 'waiting', 'connection_unconfirmed', 'waiting_for_input', 'waiting_for_approval', 'blocked', 'paused', 'queued', 'needs_review', 'changes_requested', 'reconciling', 'stopping', 'failed', 'cancelled'].some((part) => normalized.includes(part))) return 'waiting';
    if (['working', 'running', 'planning', 'executing', 'verifying'].some((part) => normalized.includes(part))) return 'working';
    return 'idle';
  }

  function normalizeAgent(agent = {}, groupKey = '') {
    const status = text(agent.status, groupKey === 'needsInput' ? 'needs_input' : groupKey === 'working' ? 'working' : 'idle');
    return {
      ...agent,
      id: text(agent.id || agent.agentId || agent.roleId, 'unknown-agent'),
      name: text(agent.name || agent.displayName || agent.role, 'Unnamed agent'),
      role: text(agent.role || agent.roleName || agent.name, 'Agent'),
      task: text(agent.task || agent.mission || agent.title, 'Awaiting assignment'),
      currentAction: text(agent.currentAction || agent.action || agent.actionDetail, 'Standing by'),
      status,
      statusClass: agentStatusClass(status),
      model: text(agent.model, 'model not reported'),
      lastHeartbeatSeconds: agent.lastHeartbeatSeconds ?? agent.heartbeatAge ?? null,
      approval: agent.approval && typeof agent.approval === 'object' ? agent.approval : null,
      groupKey,
    };
  }

  function normalizeOverview(payload = {}) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const groups = {};
    ['needsInput', 'working', 'idle'].forEach((key) => {
      groups[key] = asArray(source.groups?.[key]).map((agent) => normalizeAgent(agent, key));
    });
    return {
      generatedAt: source.generatedAt || null,
      project: source.project && typeof source.project === 'object' ? source.project : {},
      projects: asArray(source.projects),
      heartbeat: source.heartbeat && typeof source.heartbeat === 'object' ? source.heartbeat : {},
      budget: source.budget && typeof source.budget === 'object' ? source.budget : {},
      groups,
      selectedAgentId: source.selectedAgentId || null,
      goalItems: asArray(source.goalItems),
      artifacts: asArray(source.artifacts),
      messages: asArray(source.messages),
      whiteboard: source.whiteboard && typeof source.whiteboard === 'object'
        ? { path: source.whiteboard.path || null, sections: asArray(source.whiteboard.sections), notes: asArray(source.whiteboard.notes) }
        : { path: null, sections: [], notes: [] },
      approvals: asArray(source.approvals),
      capabilities: source.capabilities && typeof source.capabilities === 'object' ? source.capabilities : {},
    };
  }

  function normalizeWorkspace(payload = {}) {
    const source = payload && typeof payload === 'object' ? payload : {};
    return {
      agentId: source.agentId || null,
      generatedAt: source.generatedAt || null,
      activity: asArray(source.activity || source.timeline),
      files: asArray(source.files),
      editor: asArray(source.editor),
      terminal: asArray(source.terminal),
      browser: asArray(source.browser),
      artifacts: asArray(source.artifacts),
      messages: asArray(source.messages),
      whiteboard: source.whiteboard && typeof source.whiteboard === 'object' ? source.whiteboard : {},
      controls: source.controls && typeof source.controls === 'object' ? source.controls : {},
      tasks: asArray(source.tasks),
      persona: source.persona || '',
      job: source.job || '',
      privateBrowser: source.privateBrowser && typeof source.privateBrowser === 'object'
        ? source.privateBrowser
        : { private: true, persistent: true, exposedToOperator: false, status: 'ready', captureCount: 0, signals: [] },
    };
  }

  function allAgents(overview = state.overview) {
    if (!overview) return [];
    return [...overview.groups.needsInput, ...overview.groups.working, ...overview.groups.idle];
  }
  function selectedAgent() { return allAgents().find((agent) => agent.id === state.selectedAgentId) || null; }
  function capability(name) { return state.overview?.capabilities?.[name]; }
  function capabilityEnabled(name) { const value = capability(name); return value === true || value?.enabled === true; }
  function endpointFromTemplate(template, key, value) { return String(template || '').replace(`{${key}}`, encodeURIComponent(value)); }

  let cooldownUntil = 0;
  function cooldownError() {
    const error = new Error(`Requests paused. Retry in ${Math.ceil((cooldownUntil - Date.now()) / 1000)} seconds. The last recorded state is still shown.`);
    error.status = 429;
    return error;
  }
  async function request(path, options = {}) {
    if (Date.now() < cooldownUntil) throw cooldownError();
    const abortController = typeof globalScope.AbortController === 'function' ? new globalScope.AbortController() : null;
    const timeout = globalScope.setTimeout(() => abortController?.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await globalScope.fetch(`${API_ROOT}${path}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
        ...options,
        ...(abortController ? { signal: abortController.signal } : {}),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 429) {
          const header = response.headers?.get('Retry-After');
          const delay = header && /^\d+(\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header || '') - Date.now();
          cooldownUntil = Math.max(cooldownUntil, Date.now() + (Number.isFinite(delay) ? Math.max(1000, delay) : 60000));
          throw cooldownError();
        }
        const error = new Error(body?.error?.message || body?.message || `${response.status} ${response.statusText}`);
        error.status = response.status;
        error.code = body?.error?.code || null;
        throw error;
      }
      return body;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The operations request timed out. The last recorded state is still shown.');
      throw error;
    } finally { globalScope.clearTimeout(timeout); }
  }

  function showToast(message, isError = false) {
    const region = globalScope.document.getElementById('toastRegion');
    const toast = globalScope.document.createElement('div');
    toast.className = `toast${isError ? ' error' : ''}`;
    toast.textContent = message;
    region.append(toast);
    globalScope.setTimeout(() => toast.remove(), 4200);
  }

  function latestSignal(agent) {
    if (state.teamId) return agent.currentAction;
    const workspace = state.workspaces.get(agent.id);
    const terminal = workspace?.terminal?.at(-1);
    const message = workspace?.messages?.at(-1);
    return text(terminal?.command || message?.message || agent.currentAction, 'Standing by');
  }

  function renderCommandBar() {
    const project = state.overview.project;
    globalScope.document.getElementById('missionTitle').textContent = text(project.goal || project.name, 'No active mission');
    const sync = globalScope.document.getElementById('syncState');
    if (Date.now() < cooldownUntil) {
      sync.className = 'sync-state error';
      sync.textContent = `Sync paused · retry in ${Math.ceil((cooldownUntil - Date.now()) / 1000)}s`;
      return;
    }
    sync.className = 'sync-state';
    sync.innerHTML = `<span class="pulse-dot"></span><span>${state.refreshing ? 'Syncing' : `Live · ${formatTime(state.lastSyncAt)}`}</span>`;
  }

  function renderProjectPicker() {
    const select = globalScope.document.getElementById('projectSelect');
    const projects = state.teamId ? state.legacyProjects : state.overview.projects;
    if (!projects.length && !state.teamList.length && !state.teamId) {
      select.innerHTML = '<option value="">No project rooms</option>';
      select.disabled = true;
      return;
    }
    const legacy = state.teamId ? '<option value="legacy">Return to company projects</option>' : projects.length ? projects.map((project) => `<option value="${escapeHtml(project.id)}"${project.active || project.id === state.overview.project.id ? ' selected' : ''}>${escapeHtml(project.name || 'Untitled project')}</option>`).join('') : '<option value="legacy">Existing company projects</option>';
    const teams = state.teamList.some((team) => team.id === state.teamId) || !state.teamId ? state.teamList : [...state.teamList, { id: state.teamId, name: state.teamSnapshot?.team.name || 'Selected team' }];
    select.innerHTML = `<optgroup label="Company projects">${legacy}</optgroup>${teams.length ? `<optgroup label="Persistent teams">${teams.map((team) => `<option value="team:${escapeHtml(team.id)}"${team.id === state.teamId ? ' selected' : ''}>${escapeHtml(team.name)}</option>`).join('')}</optgroup>` : ''}`;
    select.disabled = !state.teamId && !capabilityEnabled('projects') && !teams.length;
  }

  function renderHeartbeat() {
    const heartbeat = state.overview.heartbeat;
    const card = globalScope.document.getElementById('heartbeatCard');
    if (state.teamId) {
      const running = asArray(state.teamSnapshot?.tasks).filter((task) => task.status === 'running');
      const heartbeatAt = running.map((task) => task.heartbeatAt).filter(Boolean).sort().at(-1);
      const seconds = heartbeatAt ? (Date.now() - Date.parse(heartbeatAt)) / 1000 : null;
      const unconfirmed = asArray(state.teamSnapshot.agents).filter(agent => agent.activity?.kind === 'unconfirmed').length;
      const label = !state.teamRuntime?.enabled ? 'Runtime unavailable' : !state.teamSnapshot.execution.enabled ? 'Execution paused'
        : unconfirmed ? `${unconfirmed} heartbeat${unconfirmed === 1 ? '' : 's'} unconfirmed` : running.length ? 'Worker heartbeat' : 'Ready for queued work';
      card.className = `heartbeat-card${!state.teamRuntime?.enabled || !state.teamSnapshot.execution.enabled || unconfirmed ? ' unhealthy' : ''}`;
      card.innerHTML = `<span class="heartbeat-orbit"><span></span></span><div><strong>${escapeHtml(label)}</strong><small>${seconds === null ? 'No active worker heartbeat' : escapeHtml(formatAge(seconds))}</small></div>`;
      return;
    }
    const status = String(heartbeat.status || 'unavailable').toLowerCase();
    const age = Number(heartbeat.ageSeconds);
    const interval = Number(heartbeat.intervalSeconds);
    const stale = Number.isFinite(age) && age > Math.max(Number.isFinite(interval) ? interval * 2 : 0, 120);
    const offline = ['disabled', 'unavailable', 'idle'].includes(status) || status.includes('no_active') || stale;
    const resting = ['resting', 'cooldown'].includes(status);
    const unhealthy = status.includes('fail') || status.includes('degrad') || status.includes('error');
    const label = offline ? 'Heartbeat offline' : unhealthy ? 'Heartbeat needs attention' : resting ? 'Crew resting' : 'Heartbeat online';
    const detail = resting && heartbeat.restUntil
      ? `until ${formatTime(heartbeat.restUntil)}`
      : formatAge(heartbeat.ageSeconds);
    card.className = `heartbeat-card${offline || unhealthy ? ' unhealthy' : ''}${resting ? ' resting' : ''}`;
    card.innerHTML = `<span class="heartbeat-orbit"><span></span></span><div><strong>${label}</strong><small>${escapeHtml(detail)}${heartbeat.reason ? ` · ${escapeHtml(heartbeat.reason)}` : ''}</small></div>`;
  }

  function renderCrew() {
    const agents = allAgents();
    globalScope.document.getElementById('crewCount').textContent = agents.length;
    const list = globalScope.document.getElementById('crewList');
    if (!agents.length) {
      list.innerHTML = '<div class="empty-compact">No agents are assigned to this room yet.</div>';
      return;
    }
    list.innerHTML = agents.map((agent) => `<button class="crew-card${agent.id === state.selectedAgentId ? ' selected' : ''}" type="button" data-agent-id="${escapeHtml(agent.id)}" aria-pressed="${agent.id === state.selectedAgentId}"><span class="crew-card-top"><span class="mini-avatar">${escapeHtml(initials(agent.name))}</span><span class="crew-card-name"><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.role)}</small></span><span class="status-light ${agent.statusClass}" aria-label="${escapeHtml(agent.statusClass)}"></span></span><span class="crew-card-task">${escapeHtml(agent.task)}</span><span class="crew-card-signal">&gt; ${escapeHtml(latestSignal(agent))}</span></button>`).join('');
  }

  function renderFloor() {
    const agents = allAgents();
    const floor = globalScope.document.getElementById('opsFloor');
    if (!agents.length) {
      floor.innerHTML = `<div class="empty-panel"><i class="fa-solid fa-satellite-dish" aria-hidden="true"></i><h3>The floor is quiet</h3><p>${state.teamId ? 'Add persistent teammates, then queue their first task. Execution stays paused until you enable it.' : 'Create a mission to dispatch agents into visible workstations.'}</p></div>`;
      return;
    }
    floor.innerHTML = agents.map((agent) => `<button class="agent-station ${agent.statusClass}${agent.id === state.selectedAgentId ? ' selected' : ''}" type="button" data-agent-id="${escapeHtml(agent.id)}" aria-pressed="${agent.id === state.selectedAgentId}"><span class="station-badge" aria-hidden="true"></span><span class="floor-avatar">${escapeHtml(initials(agent.name))}</span><span class="station-copy"><strong>${escapeHtml(agent.name)}</strong><span>${escapeHtml(agent.task)}</span><code>&gt; ${escapeHtml(latestSignal(agent))}</code></span></button>`).join('');
  }

  function renderTerminal(agent, workspace) {
    const panel = globalScope.document.getElementById('panel-console');
    const oldInput = panel.querySelector('[name="message"]');
    const restoreFocus = oldInput === globalScope.document.activeElement
      && oldInput?.closest('form')?.dataset.agentId === agent.id;
    const selection = restoreFocus ? [oldInput.selectionStart, oldInput.selectionEnd] : null;
    const draftKey = `${state.overview.project.id}:${agent.id}`;
    const error = state.workspaceErrors.get(agent.id);
    if (error) {
      panel.innerHTML = `<div class="error-state"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><h3>Run log unavailable</h3><p>${escapeHtml(error)}</p></div>`;
      return;
    }
    if (!workspace) {
      panel.innerHTML = '<div class="empty-panel"><i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i><h3>Attaching to the workstation</h3><p>Reading the latest recorded run events.</p></div>';
      return;
    }
    const items = workspace.terminal;
    const approval = agent.approval;
    const approvalHtml = approval ? `<div class="terminal-approval"><span>INPUT REQUIRED · ${escapeHtml(approval.title || 'Approval required')}</span><button class="primary-button" type="button" data-approval-id="${escapeHtml(approval.id)}">Approve and continue</button></div>` : '';
    const inputCapability = capability('operatorInput');
    const canReceiveInput = (state.demo || capabilityEnabled('operatorInput'))
      && agent.canReceiveInput !== false
      && workspace.controls?.canReceiveInput !== false
      && !state.pendingMessages.has(draftKey)
      && !approval;
    const inputEndpoint = state.demo || inputCapability?.endpointTemplate;
    const inputNote = state.teamId
      ? 'A request queues a new task for this teammate. It does not interrupt or rewrite the current run.'
      : approval
      ? 'Resolve the approval above before steering this run.'
      : canReceiveInput && inputEndpoint
        ? 'Your instruction is recorded in this agent’s session and wakes the same workload.'
        : 'This runtime has not advertised operator input for this agent.';
    const composer = `<form class="operator-console" data-agent-input-form data-agent-id="${escapeHtml(agent.id)}"><label for="operator-input-${escapeHtml(slug(agent.id))}">Message ${escapeHtml(agent.name)}<textarea id="operator-input-${escapeHtml(slug(agent.id))}" name="message" rows="2" maxlength="4000" required placeholder="${state.teamId ? 'Queue a request for this teammate…' : 'Continue this run with…'}"${canReceiveInput && inputEndpoint ? '' : ' disabled'}></textarea></label><button class="primary-button" type="submit"${canReceiveInput && inputEndpoint ? '' : ' disabled'}><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> ${state.teamId ? 'Queue request' : 'Send to run'}</button><p class="operator-console-note">${escapeHtml(inputNote)}</p></form>`;
    const conversation = workspace.messages.length ? workspace.messages.map((item) => {
      const links = [...asArray(item.links), ...asArray(item.attachments)]
        .filter((link) => safeUrl(link.url))
        .map((link) => `<a href="${escapeHtml(safeUrl(link.url))}" target="_blank" rel="noopener">${escapeHtml(link.label || 'Open result')}</a>`).join('');
      return `<article class="crew-message"><header><strong>${escapeHtml(item.from || agent.name)}</strong><span>${escapeHtml(item.status || item.task || '')}</span><time>${escapeHtml(formatTime(item.timestamp))}</time></header><p>${escapeHtml(item.message || '')}</p>${links ? `<div class="crew-message-links">${links}</div>` : ''}</article>`;
    }).join('') : '<div class="empty-compact">Message this teammate to continue the mission. Replies and linked results will appear here.</div>';
    const lines = items.map((item) => `<span class="timestamp">[${escapeHtml(formatTime(item.timestamp))}]</span> <span class="command">${escapeHtml(item.command || item.status || 'event')}</span>\n${escapeHtml(item.output || '')}`).join('\n\n');
    const logsOpen = panel.querySelector('.crew-run-details')?.open === true;
    const taskResults = state.teamId ? asArray(workspace.tasks).slice(-8).reverse().map((task) => `<article class="team-task-result"><header><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.status.replace(/_/g, ' '))}</span></header>${task.result?.summary ? `<p>${escapeHtml(task.result.summary)}</p>` : '<p>Waiting for a recorded result.</p>'}${task.review?.note ? `<p>Review: ${escapeHtml(task.review.note)}</p>` : ''}${task.status === 'needs_review' ? `<button class="hud-button" type="button" data-team-review="${escapeHtml(task.id)}">Review saved result</button>` : ''}</article>`).join('') : '';
    panel.innerHTML = `${approvalHtml}<section class="crew-conversation" aria-label="Conversation with ${escapeHtml(agent.name)}">${conversation}</section>${composer}${taskResults}<details class="crew-run-details"${logsOpen ? ' open' : ''}><summary>${state.teamId ? 'Activity log' : 'Run details'} · ${items.length} recorded events</summary>${state.teamId ? '<p class="capability-note">Model and tool checkpoints, not a PTY or raw terminal transcript.</p>' : ''}<pre class="terminal-buffer">${lines || 'No run events recorded yet.'}</pre></details>`;
    const newInput = panel.querySelector('[name="message"]');
    newInput.value = state.messageDrafts.get(draftKey) || '';
    newInput.addEventListener('input', () => state.messageDrafts.set(draftKey, newInput.value));
    if (restoreFocus && !newInput.disabled) {
      newInput.focus({ preventScroll: true });
      newInput.setSelectionRange(...selection);
    }
  }

  function renderDesk(agent) {
    const panel = globalScope.document.getElementById('panel-desk');
    const workspace = state.workspaces.get(agent.id);
    const browser = workspace?.privateBrowser || {};
    if (state.teamId) {
      panel.innerHTML = `<div class="desk-empty"><i class="fa-solid fa-user-secret" aria-hidden="true"></i><h3>${escapeHtml(agent.name)}’s private workspace</h3><p>Browser pixels stay inside the agent runtime. This workroom displays only recorded activity and shared deliverables.</p><div class="private-browser-facts"><span>${escapeHtml(browser.status || 'Unavailable')}</span></div></div><section class="teammate-persona"><h3>Responsibility</h3><p>${escapeHtml(workspace?.job || agent.job)}</p><h3>Persona</h3><p>${escapeHtml(workspace?.persona || 'No custom persona recorded.')}</p></section>`;
      return;
    }
    const last = browser.lastActivityAt ? formatAge((Date.now() - new Date(browser.lastActivityAt).getTime()) / 1000) : 'not used yet';
    panel.innerHTML = `<div class="desk-empty"><i class="fa-solid fa-user-secret" aria-hidden="true"></i><h3>Private browser belongs to ${escapeHtml(agent.name)}</h3><p>The rendered Web Chat and page viewport are sent to the agent’s browser model, not embedded in your command center.</p><div class="private-browser-facts"><span>${escapeHtml(text(browser.status, 'ready'))}</span><span>${escapeHtml(String(browser.captureCount || 0))} private captures</span><span>last activity ${escapeHtml(last)}</span></div></div>`;
  }

  function renderScreen(agent, workspace) {
    const panel = globalScope.document.getElementById('panel-screen');
    const signals = asArray(workspace?.privateBrowser?.signals);
    if (!signals.length) {
      panel.innerHTML = `<div class="empty-panel"><i class="fa-solid fa-eye-slash" aria-hidden="true"></i><h3>${state.teamId ? 'Browser screens stay private' : 'No private browser signals yet'}</h3><p>${state.teamId ? 'Computer tool checkpoints appear in the activity log. Browser titles, URLs, and pixels are not part of this projection.' : 'When the agent operates its browser, this panel reports bounded page titles and hosts without revealing the rendered viewport.'}</p></div>`;
      return;
    }
    const note = state.teamId ? '<p class="browser-checkpoint-note">Recorded computer-tool checkpoints, newest first. These do not confirm the browser is still running. Page titles, URLs, and pixels stay private.</p>' : '';
    panel.innerHTML = `${note}<div class="private-signal-list">${signals.map((signal) => `<article><i class="fa-solid ${state.teamId ? 'fa-clock-rotate-left' : 'fa-eye'}" aria-hidden="true"></i><span><strong>${escapeHtml(signal.title || 'Rendered page')}</strong><small>${escapeHtml(state.teamId ? 'Recorded checkpoint' : signal.host || 'private page')} · ${escapeHtml(formatTime(signal.timestamp))}</small></span></article>`).join('')}</div>`;
  }

  function renderFiles(workspace) {
    const panel = globalScope.document.getElementById('panel-files');
    const resources = [...asArray(workspace?.files), ...asArray(workspace?.artifacts)].filter((item, index, list) => list.findIndex((candidate) => (candidate.id || candidate.name) === (item.id || item.name)) === index);
    if (!resources.length) {
      panel.innerHTML = '<div class="empty-panel"><i class="fa-regular fa-folder-open" aria-hidden="true"></i><h3>No files on this desk yet</h3><p>Recorded source, evidence, and finished artifacts will land here automatically.</p></div>';
      return;
    }
    panel.innerHTML = `<div class="files-grid">${resources.map((item) => { const url = safeUrl(item.url || item.previewUrl || item.downloadUrl); const content = `<i class="fa-regular fa-file-code" aria-hidden="true"></i><strong>${escapeHtml(item.name || item.path || item.title || 'Artifact')}</strong><small>${escapeHtml(item.detail || item.status || item.language || 'Recorded file')}</small>`; return url ? `<a class="file-card" href="${escapeHtml(url)}" target="_blank" rel="noopener">${content}</a>` : `<div class="file-card">${content}</div>`; }).join('')}</div>`;
  }

  function renderSelectedAgent() {
    const agent = selectedAgent();
    const panels = PANELS.map((name) => globalScope.document.getElementById(`panel-${name}`));
    panels.forEach((panel) => { panel.hidden = panel.id !== `panel-${state.activePanel}`; });
    globalScope.document.querySelectorAll('#workroomTabs [role="tab"]').forEach((tab) => {
      const active = tab.dataset.panel === state.activePanel;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    const focus = globalScope.document.getElementById('focusDeskButton');
    const stop = globalScope.document.getElementById('stopAgentButton');
    const restart = globalScope.document.getElementById('restartAgentButton');
    if (!agent) {
      globalScope.document.getElementById('selectedAvatar').textContent = '?';
      globalScope.document.getElementById('selectedAgentRole').textContent = 'No workstation selected';
      globalScope.document.getElementById('selectedAgentName').textContent = 'The crew floor is empty';
      globalScope.document.getElementById('selectedAgentTask').textContent = 'Create a mission to begin.';
      globalScope.document.getElementById('selectedAgentState').textContent = 'Offline';
      focus.disabled = true;
      stop.disabled = true;
      restart.disabled = true;
      stop.hidden = false;
      restart.hidden = true;
      panels.forEach((panel) => { panel.innerHTML = '<div class="empty-panel"><i class="fa-solid fa-gamepad" aria-hidden="true"></i><h3>Waiting for a player</h3><p>Select an agent workstation when the crew arrives.</p></div>'; });
      return;
    }
    const status = globalScope.document.getElementById('selectedAgentState');
    status.className = `agent-state-pill ${agent.statusClass}`;
    status.textContent = state.teamId ? globalScope.LillyTeamClient.statusLabel(agent.status) : agent.statusClass === 'waiting' ? 'Waiting on you' : agent.statusClass;
    globalScope.document.getElementById('selectedAvatar').textContent = initials(agent.name);
    globalScope.document.getElementById('selectedAgentRole').textContent = `${agent.role} · ${agent.model}`;
    globalScope.document.getElementById('selectedAgentName').textContent = agent.name;
    globalScope.document.getElementById('selectedAgentTask').textContent = agent.task;
    focus.disabled = false;
    const controlEnabled = state.demo || capabilityEnabled('agentControl');
    stop.disabled = !controlEnabled || agent.controls?.canStop === false || agent.enabled === false;
    restart.disabled = !controlEnabled || agent.controls?.canRestart === false || agent.enabled !== false;
    stop.hidden = agent.enabled === false;
    restart.hidden = agent.enabled !== false;
    restart.querySelector('span').textContent = state.teamId ? 'Resume' : 'Restart';
    restart.setAttribute('aria-label', state.teamId ? 'Resume selected teammate' : 'Restart selected agent');
    const workspace = state.workspaces.get(agent.id);
    renderTerminal(agent, workspace);
    renderDesk(agent);
    renderScreen(agent, workspace);
    renderFiles(workspace);
  }

  function boardBucket(item) {
    if (['now', 'waiting', 'done'].includes(item.boardColumn)) return item.boardColumn;
    const status = agentStatusClass(item.status);
    if (status === 'waiting' || String(item.status).toLowerCase() === 'blocked') return 'waiting';
    if (String(item.status).toLowerCase() === 'completed') return 'done';
    return 'now';
  }

  function renderBoard() {
    const project = state.overview.project;
    const progress = Number(project.progress);
    const safeProgress = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
    globalScope.document.getElementById('missionProgress').textContent = `${safeProgress}%`;
    globalScope.document.getElementById('missionProgressBar').style.width = `${safeProgress}%`;
    globalScope.document.getElementById('missionGoal').textContent = text(project.goal || project.name, 'No active mission');
    globalScope.document.getElementById('missionStatus').textContent = state.teamId ? project.taskSummary : project.id ? `Room status: ${text(project.status, 'idle')}. The board refreshes with the agent heartbeat.` : 'Create a project and mission to start the crew.';

    const definitions = [{ key: 'now', label: 'Now' }, { key: 'waiting', label: 'Waiting' }, { key: 'done', label: 'Done' }];
    const board = state.overview.whiteboard;
    const items = [
      ...state.overview.goalItems,
      ...(state.teamId ? [] : board.notes).map((note) => ({
        ...note,
        title: note.content || note.title || 'Shared note',
        agentName: note.author || note.agentName || 'Operator',
        boardColumn: ['now', 'waiting', 'done'].includes(note.column) ? note.column : 'now',
        manual: true,
      })),
    ];
    globalScope.document.getElementById('boardColumns').innerHTML = definitions.map(({ key, label }) => {
      const notes = items.filter((item) => boardBucket(item) === key);
      return `<section class="board-column ${key}"><header><span>${label}</span><span>${notes.length}</span></header>${notes.length ? notes.map((item) => `<div class="board-note${item.manual ? ' manual' : ''}">${escapeHtml(item.title || item.name || 'Untitled step')}<small>${escapeHtml(item.agentName || item.assignee || 'Unassigned')}${item.blockedBy ? ` · ${escapeHtml(item.blockedBy)}` : ''}</small></div>`).join('') : `<div class="empty-compact">${state.teamId ? 'No tasks here.' : 'No notes here.'}</div>`}</section>`;
    }).join('');
    let path = globalScope.document.querySelector('.whiteboard-path');
    if (!path) {
      path = globalScope.document.createElement('p');
      path.className = 'whiteboard-path';
      globalScope.document.getElementById('boardColumns').after(path);
    }
    path.hidden = !board.path;
    path.textContent = board.path ? `Shared file: ${board.path}` : '';
    let sharedNotes = globalScope.document.getElementById('sharedTeamNotes');
    if (!sharedNotes) { sharedNotes = globalScope.document.createElement('section'); sharedNotes.id = 'sharedTeamNotes'; sharedNotes.className = 'shared-team-notes'; path.after(sharedNotes); }
    sharedNotes.hidden = !state.teamId;
    sharedNotes.innerHTML = state.teamId ? `<h3>Pinned shared notes</h3>${board.notes.length ? board.notes.slice(-12).reverse().map((note) => `<article><p>${escapeHtml(note.content)}</p><small>${escapeHtml(note.author)} · ${escapeHtml(note.source)}</small></article>`).join('') : '<p class="empty-compact">Shared facts and decisions will appear here. Private memories are not shown.</p>'}` : '';

    renderArtifactShelf();

    const messages = state.overview.messages;
    globalScope.document.getElementById('handoffList').innerHTML = messages.length ? messages.slice(0, 6).map((item) => `<article class="handoff-item"><div class="handoff-meta"><span>${escapeHtml(item.from || 'Agent')}</span><time datetime="${escapeHtml(item.timestamp || '')}">${escapeHtml(formatTime(item.timestamp))}</time></div><p>${escapeHtml(item.message || item.detail || 'Recorded update')}</p></article>`).join('') : '<div class="empty-compact">No crew handoffs recorded yet.</div>';
  }

  function renderArtifactShelf() {
    const artifacts = state.overview.artifacts;
    globalScope.document.getElementById('artifactCount').textContent = artifacts.length;
    globalScope.document.getElementById('artifactList').innerHTML = artifacts.length ? artifacts.slice(0, 8).map((item) => { const url = safeUrl(item.previewUrl || item.downloadUrl || item.url); const tag = url ? 'a' : 'div'; const href = url ? ` href="${escapeHtml(url)}" target="_blank" rel="noopener"` : ''; return `<${tag} class="artifact-item"${href}><span class="artifact-icon"><i class="fa-regular fa-file-lines" aria-hidden="true"></i></span><span><strong>${escapeHtml(item.name || item.filename || 'Artifact')}</strong><small>${escapeHtml(item.detail || item.mimeType || 'Recorded output')}</small></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></${tag}>`; }).join('') : '<div class="empty-compact">Finished work will appear below the board.</div>';

  }

  function renderAll() {
    renderCommandBar(); renderProjectPicker(); renderHeartbeat(); renderCrew(); renderFloor(); renderSelectedAgent(); renderBoard();
    globalScope.document.getElementById('loadingState').hidden = true;
    globalScope.document.getElementById('stageContent').hidden = false;
    setupDialogs();
    renderTeamControls();
  }

  function renderLoadError(error) {
    const loading = globalScope.document.getElementById('loadingState');
    loading.hidden = false;
    loading.innerHTML = `<div class="error-state"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><h1>Could not open the workroom</h1><p>${escapeHtml(error.message)}</p><button class="primary-button" id="retryButton" type="button"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Retry connection</button></div>`;
    globalScope.document.getElementById('retryButton').addEventListener('click', () => refresh(true));
  }

  async function loadWorkspace(agent) {
    if (state.teamId) return state.workspaces.get(agent.id) || null;
    const generation = state.generation;
    if (state.demo) {
      const workspace = normalizeWorkspace(demoWorkspaces[agent.id] || { agentId: agent.id, terminal: [], messages: [], browser: [], files: [], artifacts: [] });
      state.workspaces.set(agent.id, workspace);
      state.workspaceErrors.delete(agent.id);
      return workspace;
    }
    try {
      const workspace = normalizeWorkspace(await request(`/agents/${encodeURIComponent(agent.id)}/workspace`));
      if (generation !== state.generation) return null;
      state.workspaces.set(agent.id, workspace);
      state.workspaceErrors.delete(agent.id);
      return workspace;
    } catch (error) {
      if (generation !== state.generation) return null;
      state.workspaceErrors.set(agent.id, error.message);
      return null;
    }
  }

  async function refreshWorkstations() {
    const agents = allAgents();
    const selected = selectedAgent();
    const ordered = [selected, ...agents.filter((agent) => agent.id !== selected?.id && agent.statusClass !== 'idle')].filter(Boolean).slice(0, 4);
    await Promise.allSettled(ordered.map(loadWorkspace));
  }

  function nextRefreshDelay() {
    return Math.max(cooldownUntil - Date.now(), allAgents().some((agent) => agent.statusClass !== 'idle') ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
  }

  function scheduleRefresh() {
    globalScope.clearTimeout(state.refreshTimer);
    state.refreshTimer = globalScope.setTimeout(() => refresh(false), nextRefreshDelay());
  }

  async function refresh(manual = false) {
    if (state.refreshing) return;
    if (!manual && globalScope.document?.hidden) { scheduleRefresh(); return; }
    state.refreshing = true;
    const token = ++state.refreshToken;
    const generation = state.generation;
    const teamId = state.teamId;
    let synchronized = false;
    let enrichArtifacts;
    state.refreshAbort?.abort();
    state.refreshAbort = new globalScope.AbortController();
    if (state.hasLoaded) renderCommandBar();
    try {
      let overview;
      if (teamId) {
        if (!state.teamClient) throw new Error('Persistent team client unavailable. Reload this page.');
        const loaded = await state.teamClient.load(teamId, state.refreshAbort.signal);
        if (generation !== state.generation || token !== state.refreshToken) return;
        state.teamSnapshot = loaded.snapshot;
        state.teamRuntime = loaded.runtime;
        const projected = globalScope.LillyTeamClient.projectSnapshot(loaded.snapshot, loaded.runtime, loaded.metadata);
        overview = normalizeOverview(projected.overview);
        state.workspaces = new Map([...projected.workspaces].map(([id, workspace]) => [id, normalizeWorkspace(workspace)]));
        enrichArtifacts = () => loaded.loadMetadata(() => {
          if (generation !== state.generation || token !== state.refreshToken || teamId !== state.teamId) return;
          const enriched = globalScope.LillyTeamClient.projectSnapshot(loaded.snapshot, loaded.runtime, loaded.metadata);
          state.overview.artifacts = normalizeOverview(enriched.overview).artifacts;
          for (const [id, workspace] of enriched.workspaces) {
            const current = state.workspaces.get(id);
            if (current) current.artifacts = normalizeWorkspace(workspace).artifacts;
          }
          // Do not rebuild stations, messages or the user's input for file data.
          renderArtifactShelf(); renderFiles(state.workspaces.get(state.selectedAgentId));
        });
      } else {
        overview = normalizeOverview(state.demo ? demoOverview : await request('/overview'));
        if (generation !== state.generation || token !== state.refreshToken) return;
        state.legacyProjects = overview.projects;
      }
      state.overview = overview;
      const agents = allAgents(overview);
      if (!agents.some((agent) => agent.id === state.selectedAgentId)) state.selectedAgentId = overview.selectedAgentId || agents[0]?.id || null;
      await refreshWorkstations();
      if (generation !== state.generation || token !== state.refreshToken) return;
      state.lastSyncAt = new Date();
      state.hasLoaded = true;
      renderAll();
      synchronized = true;
      enrichArtifacts?.();
      if (manual) showToast('Workroom synchronized.');
    } catch (error) {
      if (generation !== state.generation || token !== state.refreshToken) return;
      if (!state.hasLoaded) renderLoadError(error);
      else {
        if (state.teamId) {
          // Cached activity is useful, but a failed refresh cannot keep claiming
          // a live working/waiting observation. Leave durable task state alone.
          const cachedAgents = allAgents();
          for (const agent of cachedAgents) if (['running', 'waiting_for_team'].includes(agent.status)) {
            agent.status = 'connection_unconfirmed'; agent.statusClass = 'waiting';
            agent.currentAction = 'Heartbeat unconfirmed'; agent.groupKey = 'needsInput';
          }
          state.overview.groups = {
            working: cachedAgents.filter(agent => agent.statusClass === 'working'),
            needsInput: cachedAgents.filter(agent => agent.statusClass === 'waiting'),
            idle: cachedAgents.filter(agent => agent.statusClass === 'idle'),
          };
          renderCrew(); renderFloor(); renderSelectedAgent();
          const heartbeat = globalScope.document.getElementById('heartbeatCard');
          heartbeat.className = 'heartbeat-card unhealthy';
          heartbeat.querySelector('strong').textContent = 'Live connection unconfirmed';
          heartbeat.querySelector('small').textContent = 'Showing last saved activity';
        }
        const sync = globalScope.document.getElementById('syncState');
        sync.className = 'sync-state error';
        sync.innerHTML = `<span class="pulse-dot"></span><span>Sync failed</span>`;
        showToast(`Live sync paused: ${error.message}`, true);
      }
    } finally {
      if (token === state.refreshToken) {
        state.refreshing = false;
        if (synchronized) renderCommandBar();
        scheduleRefresh();
      }
    }
  }

  function selectAgent(agentId) {
    if (!allAgents().some((agent) => agent.id === agentId)) return;
    state.selectedAgentId = agentId;
    state.activePanel = 'console';
    renderCrew(); renderFloor(); renderSelectedAgent();
    const agent = selectedAgent();
    if (agent) loadWorkspace(agent).then(() => { renderCrew(); renderFloor(); renderSelectedAgent(); });
  }

  function setPanel(panelName, focus = false) {
    if (!PANELS.includes(panelName)) return;
    state.activePanel = panelName;
    renderSelectedAgent();
    if (focus) globalScope.document.querySelector(`[data-panel="${panelName}"]`)?.focus();
  }

  async function resolveApproval(approvalId, button) {
    button.disabled = true;
    try {
      if (!state.demo) await request(`/approvals/${encodeURIComponent(approvalId)}/resolve`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
      showToast(state.demo ? 'Preview approval accepted locally.' : 'Approved. The agent can continue on its next heartbeat.');
      await refresh(true);
    } catch (error) { button.disabled = false; showToast(`Approval failed: ${error.message}`, true); }
  }

  async function sendAgentInstruction(agentId, form) {
    const input = form.querySelector('[name="message"]');
    const button = form.querySelector('button[type="submit"]');
    const message = input?.value.trim();
    const teamId = state.teamId;
    const generation = state.generation;
    if (!message) { input?.reportValidity(); return; }
    const draftKey = `${teamId || state.overview.project.id}:${agentId}`;
    if (state.pendingMessages.has(draftKey)) return;
    state.pendingMessages.add(draftKey);
    button.disabled = true;
    input.disabled = true;
    try {
      if (teamId) {
        await state.teamClient.command(teamId, 'send_message', { to: [agentId], kind: 'request', body: message });
      } else if (state.demo) {
        const workspace = state.workspaces.get(agentId) || normalizeWorkspace({ agentId });
        workspace.terminal.push({ timestamp: new Date().toISOString(), status: 'queued', command: 'operator.continue', output: message });
        workspace.messages.push({ from: 'Operator', message, timestamp: new Date().toISOString() });
        state.workspaces.set(agentId, workspace);
      } else {
        const template = capability('operatorInput')?.endpointTemplate;
        if (!template) throw new Error('Operator input is unavailable in this runtime.');
        await request(endpointFromTemplate(template, 'agentId', agentId), { method: 'POST', body: JSON.stringify({ message }) });
      }
      state.messageDrafts.delete(draftKey);
      if (generation !== state.generation) return;
      input.value = '';
      showToast(teamId ? 'Request recorded as a new queued task. It runs only when execution is enabled.' : 'Instruction recorded and queued on the existing agent run.');
      if (state.demo) renderSelectedAgent();
      else await refresh(false);
    } catch (error) {
      button.disabled = false;
      input.disabled = false;
      showToast(`Could not steer agent: ${error.message}`, true);
    } finally { state.pendingMessages.delete(draftKey); if (generation === state.generation) renderSelectedAgent(); }
  }

  async function controlAgent(action, button) {
    const agent = selectedAgent();
    if (!agent || !['stop', 'restart'].includes(action)) return;
    button.disabled = true;
    const teamId = state.teamId;
    const generation = state.generation;
    try {
      if (teamId) {
        await state.teamClient.command(teamId, 'control_agent', { agentId: agent.id, action: action === 'restart' ? 'resume' : 'stop' });
        if (generation !== state.generation) return;
      } else if (state.demo) {
        agent.enabled = action === 'restart';
        agent.controls = { canStop: agent.enabled, canRestart: !agent.enabled };
        agent.status = agent.enabled ? 'queued' : 'stopped';
        agent.statusClass = agentStatusClass(agent.status);
        agent.currentAction = agent.enabled ? `Restarting ${agent.task}` : `Stopped · ready to restart ${agent.task}`;
      } else {
        const template = capability('agentControl')?.endpointTemplate;
        if (!template) throw new Error('Agent lifecycle control is unavailable in this runtime.');
        await request(endpointFromTemplate(template, 'agentId', agent.id), {
          method: 'POST',
          body: JSON.stringify({ action }),
        });
      }
      showToast(teamId ? action === 'stop' ? 'Stop requested. Active work remains visible until cancellation is confirmed.' : 'Teammate resumed. Existing queued tasks can run; cancelled tasks were not duplicated.' : action === 'stop'
        ? 'Agent will stop after its current command and keep its workspace.'
        : 'Existing agent workspace restarted; no duplicate was created.');
      if (state.demo) renderAll();
      else await refresh(true);
    } catch (error) {
      button.disabled = false;
      showToast(`Could not ${action} agent: ${error.message}`, true);
    }
  }

  async function createBoardNote() {
    const dialog = globalScope.document.getElementById('boardNoteDialog');
    const input = globalScope.document.getElementById('boardNoteInput');
    const column = globalScope.document.getElementById('boardNoteColumn').value;
    const wakeCrew = globalScope.document.getElementById('wakeCrewInput').checked;
    const content = input.value.trim();
    if (!content) { input.reportValidity(); return; }
    const button = globalScope.document.getElementById('createBoardNoteSubmit');
    const teamId = state.teamId;
    const generation = state.generation;
    button.disabled = true;
    try {
      if (teamId) {
        const agentId = state.selectedAgentId || state.teamSnapshot.agents[0]?.id;
        if (!agentId) throw new Error('Add a teammate before recording shared notes.');
        await state.teamClient.command(teamId, 'remember', { agentId, scope: 'team', content, source: 'Operator workroom note' });
        if (generation !== state.generation) return;
      } else if (state.demo) {
        state.overview.whiteboard.notes.push({ id: `demo-note-${Date.now()}`, column, content, author: 'Operator', createdAt: new Date().toISOString() });
      } else {
        const endpoint = capability('whiteboard')?.endpoint;
        if (!endpoint) throw new Error('Shared-board notes are unavailable in this runtime.');
        await request(endpoint, { method: 'POST', body: JSON.stringify({ column, content, wakeCrew, targetAgentId: state.selectedAgentId || undefined }) });
      }
      dialog.close();
      dialog.querySelector('form').reset();
      globalScope.document.getElementById('wakeCrewInput').checked = true;
      showToast(teamId ? 'Shared note saved. No new task was created.' : wakeCrew ? 'Shared note saved and the crew was nudged.' : 'Shared note saved.');
      if (state.demo) { renderBoard(); setupDialogs(); }
      else await refresh(false);
    } catch (error) {
      button.disabled = false;
      showToast(`Could not save note: ${error.message}`, true);
    }
  }

  function setupDialogs() {
    if (state.teamId) {
      globalScope.document.getElementById('newGoalButton').disabled = !state.teamSnapshot?.agents.length;
      globalScope.document.getElementById('newGoalButton').querySelector('span').textContent = 'Queue task';
      globalScope.document.getElementById('newProjectButton').hidden = true;
      globalScope.document.getElementById('newBoardNoteButton').disabled = !state.teamSnapshot?.agents.length;
      globalScope.document.getElementById('createBoardNoteSubmit').disabled = !state.teamSnapshot?.agents.length;
      globalScope.document.getElementById('createBoardNoteSubmit').textContent = 'Save shared note';
      globalScope.document.getElementById('boardNoteColumn').closest('label').hidden = true;
      globalScope.document.getElementById('wakeCrewInput').closest('label').hidden = true;
      globalScope.document.getElementById('boardCapabilityNote').textContent = 'Stored as shared team memory. Teammates read it through their context; saving does not wake agents.';
      return;
    }
    globalScope.document.getElementById('newGoalButton').querySelector('span').textContent = 'New mission';
    globalScope.document.getElementById('newProjectButton').hidden = false;
    globalScope.document.getElementById('createBoardNoteSubmit').textContent = 'Pin and wake crew';
    globalScope.document.getElementById('boardNoteColumn').closest('label').hidden = false;
    globalScope.document.getElementById('wakeCrewInput').closest('label').hidden = false;
    const project = state.overview.project;
    const goalCapability = capability('goalCreation');
    const goalSubmit = globalScope.document.getElementById('createGoalSubmit');
    const goalEnabled = Boolean(project.id) && capabilityEnabled('goalCreation') && (state.demo || goalCapability?.endpoint);
    goalSubmit.disabled = !goalEnabled;
    globalScope.document.getElementById('newGoalButton').disabled = !project.id;
    globalScope.document.getElementById('goalCapabilityNote').textContent = !project.id ? 'Create a project room first.' : goalEnabled ? 'The mission is sent to the real operations heartbeat.' : 'This runtime has not advertised mission creation.';
    globalScope.document.getElementById('projectCapabilityNote').textContent = capabilityEnabled('projects') ? 'The room becomes active immediately. Add a mission now or dispatch one later.' : 'Project creation is unavailable in this runtime.';
    globalScope.document.getElementById('createProjectSubmit').disabled = !capabilityEnabled('projects') && !state.demo;
    const boardEnabled = Boolean(project.id) && (state.demo || (capabilityEnabled('whiteboard') && capability('whiteboard')?.endpoint));
    globalScope.document.getElementById('newBoardNoteButton').disabled = !boardEnabled;
    globalScope.document.getElementById('createBoardNoteSubmit').disabled = !boardEnabled;
    globalScope.document.getElementById('boardCapabilityNote').textContent = !project.id
      ? 'Create a project room first.'
      : boardEnabled
        ? 'The note is stored in the project session and appears on every agent desk.'
        : 'This runtime has not advertised durable shared-board notes.';
  }

  async function loadTeamList() {
    if (!state.teamClient) return;
    try { state.teamList = await state.teamClient.list(); if (state.overview) renderProjectPicker(); }
    catch (_error) { /* Existing company projects stay usable when team auth/runtime is unavailable. */ }
  }

  function selectTeam(teamId) {
    state.teamManager?.close();
    state.teamClient?.cancelMetadata();
    state.generation += 1;
    state.refreshToken += 1;
    state.refreshAbort?.abort();
    state.teamId = teamId;
    state.teamSnapshot = null;
    state.teamRuntime = null;
    state.workspaces.clear(); state.workspaceErrors.clear();
    state.selectedAgentId = null;
    state.hasLoaded = false;
    state.overview = null;
    state.refreshing = false;
    globalScope.document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    globalScope.document.getElementById('loadingState').hidden = false;
    globalScope.document.getElementById('stageContent').hidden = true;
    globalScope.document.getElementById('missionTitle').textContent = 'Opening selected room…';
    globalScope.document.getElementById('crewList').innerHTML = '';
    globalScope.document.getElementById('boardColumns').innerHTML = '';
    globalScope.document.getElementById('artifactList').innerHTML = '';
    globalScope.document.getElementById('handoffList').innerHTML = '';
    globalScope.document.getElementById('sharedTeamNotes')?.replaceChildren();
    globalScope.document.getElementById('teamToolbar').hidden = true;
    globalScope.document.getElementById('newGoalButton').disabled = true;
    globalScope.document.getElementById('newBoardNoteButton').disabled = true;
    const url = new URL(globalScope.location.href);
    if (teamId) url.searchParams.set('team', teamId); else url.searchParams.delete('team');
    globalScope.history.replaceState(null, '', url);
    refresh(false);
  }

  function renderTeamControls() {
    const toolbar = globalScope.document.getElementById('teamToolbar');
    toolbar.hidden = !state.teamId;
    globalScope.document.getElementById('stageContent').classList.toggle('team-mode', Boolean(state.teamId));
    globalScope.document.querySelector('.rail-heading h1').textContent = state.teamId ? 'Teammates' : 'Live agents';
    globalScope.document.getElementById('newGoalButton').setAttribute('aria-label', state.teamId ? 'Queue task' : 'New mission');
    globalScope.document.getElementById('newTeamButton').hidden = state.demo;
    globalScope.document.getElementById('manageTeamButton').hidden = !state.teamId;
    globalScope.document.getElementById('floorTitle').textContent = state.teamId ? 'Persistent crew' : 'Operations floor';
    if (!state.teamId || !state.teamSnapshot) return;
    const snapshot = state.teamSnapshot;
    const enabled = snapshot.execution.enabled;
    globalScope.document.getElementById('teamExecutionState').textContent = enabled ? 'Execution enabled' : 'Execution paused';
    globalScope.document.getElementById('teamRuntimeNote').textContent = `${state.teamRuntime?.enabled ? `Runtime configured · ${state.teamRuntime.runtime || 'Lilly'}` : 'Runtime unavailable; queued tasks will wait'} · ${snapshot.agents.length}/${snapshot.team.limits.maxAgents} teammates · ${snapshot.team.limits.concurrency} parallel slots`;
    globalScope.document.getElementById('addTeammateButton').disabled = snapshot.agents.length >= snapshot.team.limits.maxAgents;
  }

  function openTeamDialog(id) {
    if (!state.teamClient) { showToast('Persistent teams require the connected team API. Reload or sign in.', true); return; }
    const dialog = globalScope.document.getElementById(id);
    const form = dialog.querySelector('form');
    if (form.dataset.teamId && form.dataset.teamId !== state.teamId) form.reset();
    form.dataset.teamId = state.teamId || '';
    form.querySelector('.form-error').textContent = '';
    dialog.showModal();
    form.querySelector('input, textarea, select')?.focus();
  }

  function openTeamTask() {
    if (!state.teamSnapshot) return;
    const form = globalScope.document.getElementById('teamTaskForm');
    form.elements.agentId.innerHTML = state.teamSnapshot.agents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)} · ${escapeHtml(agent.role)}</option>`).join('');
    form.elements.agentId.value = state.selectedAgentId || state.teamSnapshot.agents[0]?.id || '';
    form.elements.reviewerId.innerHTML = '<option value="">Owner review</option>' + state.teamSnapshot.agents.filter((agent) => agent.role === 'reviewer').map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</option>`).join('');
    form.elements.skillId.innerHTML = '<option value="">No skill template</option>' + state.teamSnapshot.skills.filter((skill) => skill.status === 'approved').map((skill) => `<option value="${escapeHtml(skill.id)}">${escapeHtml(skill.name)} · v${skill.revision}</option>`).join('');
    openTeamDialog('teamTaskDialog');
  }

  function openExecutionSettings() {
    if (!state.teamSnapshot) return;
    openTeamDialog('teamExecutionDialog');
    const form = globalScope.document.getElementById('teamExecutionForm');
    const execution = state.teamSnapshot.execution;
    form.elements.model.value = execution.model || '';
    form.elements.toolIds.value = execution.toolIds.join('\n');
    form.elements.origins.value = execution.origins.join('\n');
    form.elements.maxCalls.value = execution.maxCalls;
    form.elements.seconds.value = execution.maxTimeMs / 1000;
    for (const key of ['enabled', 'allowSideEffects', 'allowWebSockets']) form.elements[key].checked = execution[key] === true;
    globalScope.document.getElementById('executionRuntimeAvailability').textContent = state.teamRuntime?.enabled ? `Server runtime: ${state.teamRuntime.runtime || 'Lilly'}. Changes apply to this team only.` : 'The server worker runtime is unavailable. Saving permissions does not start workers until it becomes available.';
  }

  function openTaskReview(taskId) {
    const task = state.teamSnapshot?.tasks.find((entry) => entry.id === taskId);
    if (!task || task.status !== 'needs_review') return;
    openTeamDialog('teamReviewDialog');
    const form = globalScope.document.getElementById('teamReviewForm');
    form.reset();
    form.elements.taskId.value = task.id;
    form.elements.inspected.checked = false;
    globalScope.document.getElementById('reviewTaskTitle').textContent = task.title;
    globalScope.document.getElementById('reviewTaskSummary').textContent = task.result?.summary || 'No result summary recorded.';
    const artifacts = asArray(task.result?.artifacts).map((artifact) => ({ ...artifact, detail: state.overview.artifacts.find((entry) => entry.id === artifact.id && entry.sha256 === artifact.sha256) }));
    const inspectable = artifacts.length > 0 && artifacts.every((artifact) => /^[a-f0-9]{64}$/i.test(artifact.sha256) && safeUrl(artifact.detail?.downloadUrl));
    globalScope.document.getElementById('reviewArtifactEvidence').innerHTML = artifacts.length ? artifacts.map((artifact) => {
      const url = safeUrl(artifact.detail?.downloadUrl);
      return `<article>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">Inspect ${escapeHtml(artifact.detail.name)}</a>` : '<strong>Artifact unavailable for inspection</strong>'}<small>Recorded SHA-256</small><code>${escapeHtml(artifact.sha256 || 'No hash recorded')}</code></article>`;
    }).join('') : '<p>No recorded artifact evidence. Approval is unavailable; request changes.</p>';
    form.querySelector('[value="approve"]').disabled = !inspectable;
  }

  function bindTeamForms() {
    globalScope.document.getElementById('newTeamButton').addEventListener('click', () => openTeamDialog('teamDialog'));
    globalScope.document.getElementById('addTeammateButton').addEventListener('click', () => openTeamDialog('teammateDialog'));
    globalScope.document.getElementById('configureTeamButton').addEventListener('click', openExecutionSettings);
    globalScope.document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
    const values = (form) => Object.fromEntries(new globalScope.FormData(form));
    const lines = (value) => String(value || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const bind = (id, mutate, success) => {
      const form = globalScope.document.getElementById(id);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (form.dataset.pending === 'true' || !form.reportValidity()) return;
        const generation = state.generation;
        const teamId = form.dataset.teamId;
        const button = form.querySelector('[type="submit"]');
        form.dataset.pending = 'true'; button.disabled = true;
        form.querySelector('.form-error').textContent = '';
        try {
          const result = await mutate(teamId, values(form), form, event);
          if (generation !== state.generation) { showToast('Change saved in its original team.'); return; }
          form.closest('dialog').close(); form.reset();
          await success(result);
        } catch (error) {
          form.querySelector('.form-error').textContent = error.message;
          showToast(error.message, true);
        } finally { form.dataset.pending = 'false'; button.disabled = false; }
      });
    };
    bind('teamCreateForm', (_teamId, input) => state.teamClient.create({ name: input.name.trim(), objective: input.objective.trim(), maxAgents: Number(input.maxAgents), concurrency: Number(input.concurrency) }), async (team) => {
      await loadTeamList(); showToast('Persistent team created paused. No agents were started.'); selectTeam(team.id);
    });
    bind('teammateForm', (teamId, input) => state.teamClient.command(teamId, 'create_agent', { name: input.name.trim(), role: input.role, job: input.job.trim(), persona: input.persona.trim() }), async () => { showToast('Persistent teammate saved.'); await refresh(true); });
    bind('teamTaskForm', (teamId, input) => state.teamClient.command(teamId, 'assign_task', { agentId: input.agentId, title: input.title.trim(), instruction: input.instruction.trim(), writeTargets: lines(input.writeTargets), ...(input.reviewerId ? { reviewerId: input.reviewerId } : {}), ...(input.skillId ? { skillId: input.skillId } : {}) }), async () => { showToast('Task queued. Execution settings and capacity determine when it runs.'); await refresh(true); });
    bind('teamExecutionForm', (teamId, input, form) => state.teamClient.command(teamId, 'configure_execution', { model: input.model.trim() || null,
      toolIds: lines(input.toolIds), origins: lines(input.origins), maxCalls: Number(input.maxCalls), maxTimeMs: Number(input.seconds) * 1000,
      enabled: form.elements.enabled.checked, allowSideEffects: form.elements.allowSideEffects.checked, allowWebSockets: form.elements.allowWebSockets.checked }), async () => { showToast('Execution settings recorded. Check worker activity for actual progress.'); await refresh(true); });
    bind('teamReviewForm', (teamId, input, form, event) => {
      const approved = event.submitter?.value === 'approve';
      if (approved && !form.elements.inspected.checked) throw new Error('Inspect the linked artifacts and confirm that you checked the requested outcome before approving.');
      return state.teamClient.command(teamId, 'review_task', { taskId: input.taskId, approved, note: input.note.trim() });
    }, async () => { showToast('Owner review recorded.'); await refresh(true); });
  }

  function bindEvents() {
    globalScope.document.getElementById('refreshButton').addEventListener('click', () => refresh(true));
    globalScope.document.getElementById('newGoalButton').addEventListener('click', () => { if (state.teamId) openTeamTask(); else globalScope.document.getElementById('goalDialog').showModal(); });
    globalScope.document.getElementById('newProjectButton').addEventListener('click', () => globalScope.document.getElementById('projectDialog').showModal());
    globalScope.document.getElementById('newBoardNoteButton').addEventListener('click', () => {
      const dialog = globalScope.document.getElementById('boardNoteDialog');
      dialog.showModal();
      globalScope.document.getElementById('boardNoteInput').focus();
    });
    globalScope.document.getElementById('crewList').addEventListener('click', (event) => { const card = event.target.closest('[data-agent-id]'); if (card) selectAgent(card.dataset.agentId); });
    globalScope.document.getElementById('opsFloor').addEventListener('click', (event) => { const station = event.target.closest('[data-agent-id]'); if (station) selectAgent(station.dataset.agentId); });
    globalScope.document.getElementById('workroomTabs').addEventListener('click', (event) => { const tab = event.target.closest('[data-panel]'); if (tab) setPanel(tab.dataset.panel); });
    globalScope.document.getElementById('workroomTabs').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = PANELS.indexOf(state.activePanel);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? PANELS.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + PANELS.length) % PANELS.length;
      setPanel(PANELS[next], true);
    });
    globalScope.document.getElementById('workstationPanels').addEventListener('click', (event) => { const review = event.target.closest('[data-team-review]'); if (review) openTaskReview(review.dataset.teamReview); const button = event.target.closest('[data-approval-id]'); if (button) resolveApproval(button.dataset.approvalId, button); });
    globalScope.document.getElementById('workstationPanels').addEventListener('submit', (event) => {
      const form = event.target.closest('[data-agent-input-form]');
      if (!form) return;
      event.preventDefault();
      sendAgentInstruction(form.dataset.agentId, form);
    });
    globalScope.document.getElementById('focusDeskButton').addEventListener('click', () => setPanel('desk'));
    globalScope.document.getElementById('stopAgentButton').addEventListener('click', (event) => controlAgent('stop', event.currentTarget));
    globalScope.document.getElementById('restartAgentButton').addEventListener('click', (event) => controlAgent('restart', event.currentTarget));
    globalScope.document.getElementById('projectSelect').addEventListener('change', async (event) => {
      if (event.target.value.startsWith('team:')) { selectTeam(event.target.value.slice(5)); return; }
      if (state.teamId) { selectTeam(null); return; }
      if (event.target.value === 'legacy') return;
      const template = capability('projects')?.activateEndpointTemplate;
      if (!event.target.value || !template || state.demo) return;
      event.target.disabled = true;
      try { await request(endpointFromTemplate(template, 'projectId', event.target.value), { method: 'POST' }); state.workspaces.clear(); state.selectedAgentId = null; await refresh(true); } catch (error) { event.target.disabled = false; showToast(`Could not switch rooms: ${error.message}`, true); }
    });
    globalScope.document.getElementById('createGoalSubmit').addEventListener('click', async (event) => {
      event.preventDefault();
      const titleInput = globalScope.document.getElementById('goalTitleInput');
      const title = titleInput.value.trim();
      if (!title) { titleInput.reportValidity(); return; }
      const button = event.currentTarget; button.disabled = true;
      try {
        if (!state.demo) await request(capability('goalCreation').endpoint, { method: 'POST', body: JSON.stringify({ title, successCriteria: globalScope.document.getElementById('goalCriteriaInput').value.trim() }) });
        globalScope.document.getElementById('goalDialog').close();
        globalScope.document.getElementById('goalDialog').querySelector('form').reset();
        showToast('Mission dispatched to the crew.');
        await refresh(false);
      } catch (error) { button.disabled = false; showToast(`Could not start mission: ${error.message}`, true); }
    });
    globalScope.document.getElementById('createProjectSubmit').addEventListener('click', async (event) => {
      event.preventDefault();
      const nameInput = globalScope.document.getElementById('projectNameInput');
      const name = nameInput.value.trim();
      if (!name) { nameInput.reportValidity(); return; }
      const button = event.currentTarget; button.disabled = true;
      try {
        if (!state.demo) await request(capability('projects').collectionEndpoint || '/projects', { method: 'POST', body: JSON.stringify({ name, companyGoal: globalScope.document.getElementById('projectGoalInput').value.trim() }) });
        globalScope.document.getElementById('projectDialog').close();
        globalScope.document.getElementById('projectDialog').querySelector('form').reset();
        state.selectedAgentId = null; state.workspaces.clear();
        showToast('Project room opened.');
        await refresh(false);
      } catch (error) { button.disabled = false; showToast(`Could not open room: ${error.message}`, true); }
    });
    globalScope.document.getElementById('createBoardNoteSubmit').addEventListener('click', async (event) => {
      event.preventDefault();
      await createBoardNote();
    });
    globalScope.document.addEventListener('visibilitychange', () => { if (!globalScope.document.hidden) refresh(false); });
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    state.demo = new URLSearchParams(globalScope.location.search).get('demo') === '1';
    if (globalScope.LillyTeamClient && !state.demo) {
      state.teamClient = globalScope.LillyTeamClient.createClient({ fetch: (...args) => globalScope.fetch(...args), storage: globalScope.sessionStorage });
      state.teamId = new URLSearchParams(globalScope.location.search).get('team') || null;
    }
    bindEvents();
    bindTeamForms();
    if (state.teamClient && globalScope.LillyTeamManager) {
      state.teamManager = globalScope.LillyTeamManager.create({ document: globalScope.document, client: state.teamClient,
        context: () => ({ teamId: state.teamId, snapshot: state.teamSnapshot }), refresh: () => refresh(true) });
      globalScope.document.getElementById('manageTeamButton').addEventListener('click', () => state.teamManager.open());
    }
    loadTeamList();
    refresh(false);
  }

  const publicApi = { normalizeOverview, normalizeWorkspace, normalizeAgent, agentStatusClass, safeUrl, escapeHtml, demoOverview };
  if (typeof module !== 'undefined' && module.exports) module.exports = publicApi;
  if (globalScope.document) {
    if (globalScope.document.readyState === 'loading') globalScope.document.addEventListener('DOMContentLoaded', init);
    else init();
  }
}(typeof window !== 'undefined' ? window : globalThis));
