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
    refreshTimer: null,
    refreshing: false,
    hasLoaded: false,
    lastSyncAt: null,
    deskFocused: false,
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
    if (['needs_input', 'waiting', 'waiting_for_input', 'waiting_for_approval', 'blocked', 'paused'].some((part) => normalized.includes(part))) return 'waiting';
    if (['working', 'running', 'planning', 'executing', 'verifying', 'queued'].some((part) => normalized.includes(part))) return 'working';
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
    const projects = state.overview.projects;
    if (!projects.length) {
      select.innerHTML = '<option value="">No project rooms</option>';
      select.disabled = true;
      return;
    }
    select.innerHTML = projects.map((project) => `<option value="${escapeHtml(project.id)}"${project.active || project.id === state.overview.project.id ? ' selected' : ''}>${escapeHtml(project.name || 'Untitled project')}</option>`).join('');
    select.disabled = !capabilityEnabled('projects');
  }

  function renderHeartbeat() {
    const heartbeat = state.overview.heartbeat;
    const card = globalScope.document.getElementById('heartbeatCard');
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
      floor.innerHTML = '<div class="empty-panel"><i class="fa-solid fa-satellite-dish" aria-hidden="true"></i><h3>The floor is quiet</h3><p>Create a mission to dispatch agents into visible workstations.</p></div>';
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
      && !approval;
    const inputEndpoint = state.demo || inputCapability?.endpointTemplate;
    const inputNote = approval
      ? 'Resolve the approval above before steering this run.'
      : canReceiveInput && inputEndpoint
        ? 'Your instruction is recorded in this agent’s session and wakes the same workload.'
        : 'This runtime has not advertised operator input for this agent.';
    const composer = `<form class="operator-console" data-agent-input-form data-agent-id="${escapeHtml(agent.id)}"><label for="operator-input-${escapeHtml(slug(agent.id))}">Message ${escapeHtml(agent.name)}<textarea id="operator-input-${escapeHtml(slug(agent.id))}" name="message" rows="2" maxlength="4000" required placeholder="Continue this run with…"${canReceiveInput && inputEndpoint ? '' : ' disabled'}></textarea></label><button class="primary-button" type="submit"${canReceiveInput && inputEndpoint ? '' : ' disabled'}><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Send to run</button><p class="operator-console-note">${escapeHtml(inputNote)}</p></form>`;
    const conversation = workspace.messages.length ? workspace.messages.map((item) => {
      const links = [...asArray(item.links), ...asArray(item.attachments)]
        .filter((link) => safeUrl(link.url))
        .map((link) => `<a href="${escapeHtml(safeUrl(link.url))}" target="_blank" rel="noopener">${escapeHtml(link.label || 'Open result')}</a>`).join('');
      return `<article class="crew-message"><header><strong>${escapeHtml(item.from || agent.name)}</strong><span>${escapeHtml(item.status || item.task || '')}</span><time>${escapeHtml(formatTime(item.timestamp))}</time></header><p>${escapeHtml(item.message || '')}</p>${links ? `<div class="crew-message-links">${links}</div>` : ''}</article>`;
    }).join('') : '<div class="empty-compact">Message this teammate to continue the mission. Replies and linked results will appear here.</div>';
    const lines = items.map((item) => `<span class="timestamp">[${escapeHtml(formatTime(item.timestamp))}]</span> <span class="command">${escapeHtml(item.command || item.status || 'event')}</span>\n${escapeHtml(item.output || '')}`).join('\n\n');
    const logsOpen = panel.querySelector('.crew-run-details')?.open === true;
    panel.innerHTML = `${approvalHtml}<section class="crew-conversation" aria-label="Conversation with ${escapeHtml(agent.name)}">${conversation}</section>${composer}<details class="crew-run-details"${logsOpen ? ' open' : ''}><summary>Run details · ${items.length} recorded events</summary><pre class="terminal-buffer">${lines || 'No run events recorded yet.'}</pre></details>`;
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
    const last = browser.lastActivityAt ? formatAge((Date.now() - new Date(browser.lastActivityAt).getTime()) / 1000) : 'not used yet';
    panel.innerHTML = `<div class="desk-empty"><i class="fa-solid fa-user-secret" aria-hidden="true"></i><h3>Private browser belongs to ${escapeHtml(agent.name)}</h3><p>The rendered Web Chat and page viewport are sent to the agent’s browser model, not embedded in your command center.</p><div class="private-browser-facts"><span>${escapeHtml(text(browser.status, 'ready'))}</span><span>${escapeHtml(String(browser.captureCount || 0))} private captures</span><span>last activity ${escapeHtml(last)}</span></div></div>`;
  }

  function renderScreen(agent, workspace) {
    const panel = globalScope.document.getElementById('panel-screen');
    const signals = asArray(workspace?.privateBrowser?.signals);
    if (!signals.length) {
      panel.innerHTML = '<div class="empty-panel"><i class="fa-solid fa-eye-slash" aria-hidden="true"></i><h3>No private browser signals yet</h3><p>When the agent operates its browser, this panel reports bounded page titles and hosts without revealing the rendered viewport.</p></div>';
      return;
    }
    panel.innerHTML = `<div class="private-signal-list">${signals.map((signal) => `<article><i class="fa-solid fa-eye" aria-hidden="true"></i><span><strong>${escapeHtml(signal.title || 'Rendered page')}</strong><small>${escapeHtml(signal.host || 'private page')} · ${escapeHtml(formatTime(signal.timestamp))}</small></span></article>`).join('')}</div>`;
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
    status.textContent = agent.statusClass === 'waiting' ? 'Waiting on you' : agent.statusClass;
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
    globalScope.document.getElementById('missionStatus').textContent = project.id ? `Room status: ${text(project.status, 'idle')}. The board refreshes with the agent heartbeat.` : 'Create a project and mission to start the crew.';

    const definitions = [{ key: 'now', label: 'Now' }, { key: 'waiting', label: 'Waiting' }, { key: 'done', label: 'Done' }];
    const board = state.overview.whiteboard;
    const items = [
      ...state.overview.goalItems,
      ...board.notes.map((note) => ({
        ...note,
        title: note.content || note.title || 'Shared note',
        agentName: note.author || note.agentName || 'Operator',
        boardColumn: ['now', 'waiting', 'done'].includes(note.column) ? note.column : 'now',
        manual: true,
      })),
    ];
    globalScope.document.getElementById('boardColumns').innerHTML = definitions.map(({ key, label }) => {
      const notes = items.filter((item) => boardBucket(item) === key);
      return `<section class="board-column ${key}"><header><span>${label}</span><span>${notes.length}</span></header>${notes.length ? notes.map((item) => `<div class="board-note${item.manual ? ' manual' : ''}">${escapeHtml(item.title || item.name || 'Untitled step')}<small>${escapeHtml(item.agentName || item.assignee || 'Unassigned')}${item.blockedBy ? ` · ${escapeHtml(item.blockedBy)}` : ''}</small></div>`).join('') : '<div class="empty-compact">No notes here.</div>'}</section>`;
    }).join('');
    let path = globalScope.document.querySelector('.whiteboard-path');
    if (!path) {
      path = globalScope.document.createElement('p');
      path.className = 'whiteboard-path';
      globalScope.document.getElementById('boardColumns').after(path);
    }
    path.hidden = !board.path;
    path.textContent = board.path ? `Shared file: ${board.path}` : '';

    const artifacts = state.overview.artifacts;
    globalScope.document.getElementById('artifactCount').textContent = artifacts.length;
    globalScope.document.getElementById('artifactList').innerHTML = artifacts.length ? artifacts.slice(0, 8).map((item) => { const url = safeUrl(item.previewUrl || item.downloadUrl || item.url); const tag = url ? 'a' : 'div'; const href = url ? ` href="${escapeHtml(url)}" target="_blank" rel="noopener"` : ''; return `<${tag} class="artifact-item"${href}><span class="artifact-icon"><i class="fa-regular fa-file-lines" aria-hidden="true"></i></span><span><strong>${escapeHtml(item.name || item.filename || 'Artifact')}</strong><small>${escapeHtml(item.detail || item.mimeType || 'Recorded output')}</small></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></${tag}>`; }).join('') : '<div class="empty-compact">Finished work will appear below the board.</div>';

    const messages = state.overview.messages;
    globalScope.document.getElementById('handoffList').innerHTML = messages.length ? messages.slice(0, 6).map((item) => `<article class="handoff-item"><div class="handoff-meta"><span>${escapeHtml(item.from || 'Agent')}</span><time datetime="${escapeHtml(item.timestamp || '')}">${escapeHtml(formatTime(item.timestamp))}</time></div><p>${escapeHtml(item.message || item.detail || 'Recorded update')}</p></article>`).join('') : '<div class="empty-compact">No crew handoffs recorded yet.</div>';
  }

  function renderAll() {
    renderCommandBar(); renderProjectPicker(); renderHeartbeat(); renderCrew(); renderFloor(); renderSelectedAgent(); renderBoard();
    globalScope.document.getElementById('loadingState').hidden = true;
    globalScope.document.getElementById('stageContent').hidden = false;
    setupDialogs();
  }

  function renderLoadError(error) {
    const loading = globalScope.document.getElementById('loadingState');
    loading.hidden = false;
    loading.innerHTML = `<div class="error-state"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><h1>Could not open the workroom</h1><p>${escapeHtml(error.message)}</p><button class="primary-button" id="retryButton" type="button"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Retry connection</button></div>`;
    globalScope.document.getElementById('retryButton').addEventListener('click', () => refresh(true));
  }

  async function loadWorkspace(agent) {
    if (state.demo) {
      const workspace = normalizeWorkspace(demoWorkspaces[agent.id] || { agentId: agent.id, terminal: [], messages: [], browser: [], files: [], artifacts: [] });
      state.workspaces.set(agent.id, workspace);
      state.workspaceErrors.delete(agent.id);
      return workspace;
    }
    try {
      const workspace = normalizeWorkspace(await request(`/agents/${encodeURIComponent(agent.id)}/workspace`));
      state.workspaces.set(agent.id, workspace);
      state.workspaceErrors.delete(agent.id);
      return workspace;
    } catch (error) {
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
    if (state.hasLoaded) renderCommandBar();
    try {
      const overview = normalizeOverview(state.demo ? demoOverview : await request('/overview'));
      state.overview = overview;
      const agents = allAgents(overview);
      if (!agents.some((agent) => agent.id === state.selectedAgentId)) state.selectedAgentId = overview.selectedAgentId || agents[0]?.id || null;
      await refreshWorkstations();
      state.lastSyncAt = new Date();
      state.hasLoaded = true;
      renderAll();
      if (manual) showToast('Workroom synchronized.');
    } catch (error) {
      if (!state.hasLoaded) renderLoadError(error);
      else {
        const sync = globalScope.document.getElementById('syncState');
        sync.className = 'sync-state error';
        sync.innerHTML = `<span class="pulse-dot"></span><span>Sync failed</span>`;
        showToast(`Live sync paused: ${error.message}`, true);
      }
    } finally { state.refreshing = false; scheduleRefresh(); }
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
    if (!message) { input?.reportValidity(); return; }
    button.disabled = true;
    input.disabled = true;
    try {
      if (state.demo) {
        const workspace = state.workspaces.get(agentId) || normalizeWorkspace({ agentId });
        workspace.terminal.push({ timestamp: new Date().toISOString(), status: 'queued', command: 'operator.continue', output: message });
        workspace.messages.push({ from: 'Operator', message, timestamp: new Date().toISOString() });
        state.workspaces.set(agentId, workspace);
      } else {
        const template = capability('operatorInput')?.endpointTemplate;
        if (!template) throw new Error('Operator input is unavailable in this runtime.');
        await request(endpointFromTemplate(template, 'agentId', agentId), { method: 'POST', body: JSON.stringify({ message }) });
      }
      input.value = '';
      state.messageDrafts.delete(`${state.overview.project.id}:${agentId}`);
      showToast('Instruction recorded and queued on the existing agent run.');
      if (state.demo) renderSelectedAgent();
      else await refresh(false);
    } catch (error) {
      button.disabled = false;
      input.disabled = false;
      showToast(`Could not steer agent: ${error.message}`, true);
    }
  }

  async function controlAgent(action, button) {
    const agent = selectedAgent();
    if (!agent || !['stop', 'restart'].includes(action)) return;
    button.disabled = true;
    try {
      if (state.demo) {
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
      showToast(action === 'stop'
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
    button.disabled = true;
    try {
      if (state.demo) {
        state.overview.whiteboard.notes.push({ id: `demo-note-${Date.now()}`, column, content, author: 'Operator', createdAt: new Date().toISOString() });
      } else {
        const endpoint = capability('whiteboard')?.endpoint;
        if (!endpoint) throw new Error('Shared-board notes are unavailable in this runtime.');
        await request(endpoint, { method: 'POST', body: JSON.stringify({ column, content, wakeCrew, targetAgentId: state.selectedAgentId || undefined }) });
      }
      dialog.close();
      dialog.querySelector('form').reset();
      globalScope.document.getElementById('wakeCrewInput').checked = true;
      showToast(wakeCrew ? 'Shared note saved and the crew was nudged.' : 'Shared note saved.');
      if (state.demo) { renderBoard(); setupDialogs(); }
      else await refresh(false);
    } catch (error) {
      button.disabled = false;
      showToast(`Could not save note: ${error.message}`, true);
    }
  }

  function setupDialogs() {
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

  function bindEvents() {
    globalScope.document.getElementById('refreshButton').addEventListener('click', () => refresh(true));
    globalScope.document.getElementById('newGoalButton').addEventListener('click', () => globalScope.document.getElementById('goalDialog').showModal());
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
    globalScope.document.getElementById('workstationPanels').addEventListener('click', (event) => { const button = event.target.closest('[data-approval-id]'); if (button) resolveApproval(button.dataset.approvalId, button); });
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
    state.demo = new URLSearchParams(globalScope.location.search).get('demo') === '1';
    bindEvents();
    refresh(false);
  }

  const publicApi = { normalizeOverview, normalizeWorkspace, normalizeAgent, agentStatusClass, safeUrl, escapeHtml, demoOverview };
  if (typeof module !== 'undefined' && module.exports) module.exports = publicApi;
  if (globalScope.document) {
    if (globalScope.document.readyState === 'loading') globalScope.document.addEventListener('DOMContentLoaded', init);
    else init();
  }
}(typeof window !== 'undefined' ? window : globalThis));
