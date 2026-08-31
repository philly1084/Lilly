(function agentOpsModule(globalScope) {
  'use strict';

  const API_ROOT = '/api/admin/agent-ops';
  const GROUPS = [
    { key: 'needsInput', label: 'Needs you' },
    { key: 'working', label: 'Working' },
    { key: 'idle', label: 'Idle' },
  ];
  const TABS = ['activity', 'files', 'editor', 'terminal', 'browser', 'artifacts', 'messages'];

  const demoOverview = {
    generatedAt: '2026-08-30T13:11:38.000Z',
    project: { id: 'checkout-reliability', name: 'Checkout Reliability', status: 'On track', progress: 42, target: 'Sep 5, 2026' },
    heartbeat: { healthy: true, ageSeconds: 12, label: 'All systems nominal' },
    budget: { spent: 1842.63, limit: 5000, period: 'MTD' },
    capabilities: { goalCreation: false, takeOver: false, stream: false },
    selectedAgentId: 'mira',
    groups: {
      needsInput: [{ id: 'rex', name: 'Rex', role: 'Release guardian', task: 'Prepare v2.18.0', action: 'Promote release to prod', actionDetail: 'Production approval gate', status: 'waiting', model: 'gpt-4o', elapsed: '02:17', cpu: 2, memory: '412MB', lastHeartbeat: '8s', approval: { id: 'approval-release-218', title: 'Approval required' } }],
      working: [
        { id: 'mira', name: 'Mira', role: 'Test investigator', task: 'Investigate CI flake', action: 'Re-running flaky spec', actionDetail: 'cart.spec.ts · checkout flow', status: 'running', model: 'claude-3.5', elapsed: '14:32', cpu: 18, memory: '1.2GB', lastHeartbeat: '6s', files: [{ name: 'cart.spec.ts', detail: 'Modified' }, { name: 'checkout.ts', detail: 'Read' }], artifacts: [{ name: 'flake-analysis.md', detail: '18.6 KB' }] },
        { id: 'sol', name: 'Sol', role: 'Code implementer', task: 'Fix discount rounding', action: 'Committing changes', actionDetail: 'feat(pricing): round discount totals', status: 'running', model: 'claude-3.5', elapsed: '22:08', cpu: 22, memory: '1.6GB', lastHeartbeat: '5s' },
        { id: 'kai', name: 'Kai', role: 'Docs writer', task: 'Update pricing docs', action: 'Editing document', actionDetail: 'docs/pricing/discounts.md', status: 'running', model: 'gpt-4o-mini', elapsed: '07:43', cpu: 6, memory: '384MB', lastHeartbeat: '9s' },
      ],
      idle: [
        { id: 'uma', name: 'Uma', role: 'Data explorer', task: 'Analyze failure patterns', action: 'Waiting for next goal', actionDetail: 'No active work', status: 'idle', model: 'gpt-4o-mini', elapsed: '—', cpu: 0, memory: '256MB', lastHeartbeat: '14s' },
        { id: 'nia', name: 'Nia', role: 'Research scout', task: 'Evaluate retry strategies', action: 'Standing by', actionDetail: 'Ready for assignment', status: 'idle', model: 'claude-3.5-haiku', elapsed: '—', cpu: 0, memory: '248MB', lastHeartbeat: '16s' },
      ],
    },
    goalItems: [
      { id: 'g1', title: 'Reproduce CI flake', assignee: 'Mira · Test investigator', status: 'complete' },
      { id: 'g2', title: 'Fix discount rounding', assignee: 'Sol · Code implementer', status: 'in progress' },
      { id: 'g3', title: 'Add regression tests', assignee: 'Mira · Test investigator', status: 'pending' },
      { id: 'g4', title: 'Update docs', assignee: 'Kai · Docs writer', status: 'pending' },
      { id: 'g5', title: 'Release v2.18.0', assignee: 'Rex · Release guardian', status: 'blocked' },
    ],
  };

  const demoTimeline = [
    { id: 'e1', type: 'start', status: 'success', title: 'Agent started', detail: 'Goal: Investigate CI flake in cart checkout flow', timestamp: '2026-08-30T13:11:02.000Z' },
    { id: 'e2', type: 'tool', status: 'success', title: 'Tool call', detail: 'checkout__fetch_run · run_id=20987456231', evidence: '{ "status": "completed", "result": "success" }', timestamp: '2026-08-30T13:11:05.000Z' },
    { id: 'e3', type: 'checkpoint', status: 'success', title: 'Checkpoint', detail: 'Baseline captured before re-run · cp-7f3a9b2', timestamp: '2026-08-30T13:11:13.000Z' },
    { id: 'e4', type: 'tool', status: 'failure', title: 'Test failed', detail: 'cart.spec.ts:42 should apply percentage discount', evidence: 'Expected: 89.99\nReceived: 90.99', timestamp: '2026-08-30T13:11:15.000Z' },
    { id: 'e5', type: 'handoff', status: 'success', title: 'Handoff from Sol · Code implementer', detail: 'Potential rounding fix pushed to branch bugfix/discount-rounding', timestamp: '2026-08-30T13:11:28.000Z' },
    { id: 'e6', type: 'tool', status: 'success', title: 'Test passed', detail: 'cart.spec.ts:42 should apply percentage discount', timestamp: '2026-08-30T13:11:38.000Z' },
  ];

  const state = { overview: null, selectedAgent: null, activeTab: 'activity', activity: new Map(), query: '', demo: false };

  function text(value, fallback = 'Not reported') {
    if (value === null || value === undefined || value === '') return fallback;
    return String(value);
  }

  function escapeHtml(value) {
    return text(value, '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  }

  function normalizeAgent(agent, groupKey) {
    const raw = agent && typeof agent === 'object' ? agent : {};
    return {
      ...raw,
      id: text(raw.id || raw.agentId, `agent-${groupKey}`),
      name: text(raw.name || raw.displayName, 'Unnamed agent'),
      role: text(raw.role || raw.agentRole, 'Role not reported'),
      task: text(raw.task || raw.goal || raw.assignment, 'No task reported'),
      action: text(raw.action || raw.currentAction, 'No current action reported'),
      actionDetail: text(raw.actionDetail || raw.currentPath || raw.resource || raw.detail, 'No action detail reported'),
      status: text(raw.status, groupKey === 'needsInput' ? 'waiting' : groupKey === 'working' ? 'running' : 'idle').toLowerCase(),
      model: text(raw.model), elapsed: text(raw.elapsed, '—'), cpu: raw.cpu ?? raw.metrics?.cpu ?? null,
      memory: raw.memory ?? raw.metrics?.memory ?? null,
      lastHeartbeat: raw.lastHeartbeat ?? raw.heartbeatAge ?? null,
      approval: raw.approval || (raw.approvalId ? { id: raw.approvalId } : null),
      groupKey,
    };
  }

  function normalizeOverview(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const groups = {};
    GROUPS.forEach(({ key }) => { groups[key] = Array.isArray(source.groups?.[key]) ? source.groups[key].map((agent) => normalizeAgent(agent, key)) : []; });
    return {
      generatedAt: source.generatedAt || null,
      project: source.project && typeof source.project === 'object' ? source.project : { name: text(source.project, 'No project reported') },
      heartbeat: source.heartbeat && typeof source.heartbeat === 'object' ? source.heartbeat : {},
      budget: source.budget && typeof source.budget === 'object' ? source.budget : {},
      groups,
      selectedAgentId: source.selectedAgentId || null,
      goalItems: Array.isArray(source.goalItems) ? source.goalItems : [],
      capabilities: source.capabilities && typeof source.capabilities === 'object' ? source.capabilities : {},
    };
  }

  function allAgents(overview = state.overview) {
    return overview ? GROUPS.flatMap(({ key }) => overview.groups[key]) : [];
  }

  function matchesAgent(agent, query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return true;
    return [agent.name, agent.role, agent.task, agent.action, agent.status, agent.model].some((value) => String(value || '').toLowerCase().includes(needle));
  }

  function money(value) {
    const number = Number(value);
    return Number.isFinite(number) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(number) : 'Not reported';
  }

  function capability(name) {
    return state.overview?.capabilities?.[name];
  }

  async function request(path, options = {}) {
    const response = await fetch(`${API_ROOT}${path}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    let body = null;
    try { body = await response.json(); } catch (_error) { body = null; }
    if (!response.ok) {
      const error = new Error(body?.message || body?.error?.message || body?.error || `${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function showToast(message, isError = false) {
    const region = document.getElementById('toastRegion');
    if (!region) return;
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' error' : ''}`;
    toast.textContent = message;
    region.replaceChildren(toast);
    globalScope.setTimeout(() => toast.remove(), 4200);
  }

  function renderHeader() {
    const { project, heartbeat, budget } = state.overview;
    const select = document.getElementById('projectSelect');
    select.replaceChildren(new Option(text(project.name || project.title), text(project.id || project.name, 'active')));
    const heartbeatEl = document.getElementById('heartbeat');
    const healthy = heartbeat.healthy !== false;
    heartbeatEl.className = `heartbeat${healthy ? '' : ' error'}`;
    const heartbeatTitle = healthy ? `Healthy · ${text(heartbeat.ageSeconds, '?')}s` : 'Heartbeat unhealthy';
    heartbeatEl.innerHTML = `<span class="status-dot"></span><span class="heartbeat-copy"><strong>${escapeHtml(heartbeatTitle)}</strong><small>${escapeHtml(text(heartbeat.label, healthy ? 'All systems nominal' : 'Coordination needs attention'))}</small></span>`;
    const spent = Number(budget.spent); const limit = Number(budget.limit);
    const ratio = Number.isFinite(spent) && Number.isFinite(limit) && limit > 0 ? Math.min(100, Math.max(0, spent / limit * 100)) : 0;
    document.getElementById('budget').innerHTML = `<span>Budget</span><strong>${money(budget.spent)} / ${money(budget.limit)}</strong><div class="meter" title="${Math.round(ratio)}% used"><span style="width:${ratio}%"></span></div>`;
  }

  function renderAgentRow(agent) {
    const selected = state.selectedAgent?.id === agent.id;
    const needsInput = agent.groupKey === 'needsInput';
    const approval = agent.approval;
    const statusCell = approval ? `<div class="approval-actions"><button class="approve-button" type="button" data-approval="${escapeHtml(approval.id)}" data-decision="approve">Approve</button><button class="reject-button" type="button" data-approval="${escapeHtml(approval.id)}" data-decision="reject">Reject</button></div>` : `<span class="status-chip ${escapeHtml(agent.status)}">${escapeHtml(agent.status)}</span>`;
    return `<tr class="agent-row ${needsInput ? 'needs-input' : ''}${selected ? ' selected' : ''}" data-agent-id="${escapeHtml(agent.id)}" tabindex="0" aria-selected="${selected}">
      <td><span class="agent-primary"><i class="fa-regular fa-user" aria-hidden="true"></i>${escapeHtml(agent.name)} · ${escapeHtml(agent.role)}</span><span class="agent-secondary">${escapeHtml(agent.task)}</span></td>
      <td><span class="action-primary"><span class="action-dot"></span>${escapeHtml(approval?.title || agent.action)}</span><span class="action-secondary">${escapeHtml(approval ? agent.action : agent.actionDetail)}</span></td>
      <td><span class="row-metric">${escapeHtml(agent.elapsed)}</span><span class="row-submetric">${escapeHtml(text(agent.lastHeartbeat, 'Not reported'))} heartbeat</span></td>
      <td><span class="model-chip">${escapeHtml(agent.model)}</span><span class="row-submetric">${escapeHtml(agent.cpu === null ? 'CPU not reported' : `${agent.cpu}% CPU`)} · ${escapeHtml(text(agent.memory))}</span></td>
      <td>${statusCell}</td>
    </tr>`;
  }

  function renderGroups() {
    const container = document.getElementById('agentGroups');
    let visibleCount = 0;
    container.innerHTML = GROUPS.map(({ key, label }) => {
      const agents = state.overview.groups[key].filter((agent) => matchesAgent(agent, state.query));
      visibleCount += agents.length;
      if (state.query && agents.length === 0) return '';
      return `<section class="agent-group" data-group="${key}"><button class="group-header" type="button" aria-expanded="true"><span class="group-dot"></span><h2>${label}</h2><span class="group-count">${agents.length}</span><i class="fa-solid fa-chevron-up" aria-hidden="true"></i></button><div class="group-table"><table><thead><tr><th>Agent / Task</th><th>Current action</th><th>Elapsed</th><th>Runtime</th><th>Status</th></tr></thead><tbody>${agents.map(renderAgentRow).join('') || `<tr><td colspan="5"><span class="agent-secondary">No agents reported in this group.</span></td></tr>`}</tbody></table></div></section>`;
    }).join('');
    document.getElementById('filterEmpty').hidden = visibleCount !== 0;
    const approvals = state.overview.groups.needsInput.filter((agent) => agent.approval).length;
    document.getElementById('approvalCount').textContent = String(approvals);
  }

  function formatEventTime(timestamp) {
    if (!timestamp) return '—';
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? text(timestamp) : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  function renderActivity(events, loading = false, error = null) {
    const panel = document.getElementById('panel-activity');
    if (!panel) return;
    if (loading) { panel.innerHTML = '<div class="honest-state"><i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i><h3>Loading activity</h3><p>Reading this agent’s recorded timeline.</p></div>'; return; }
    if (error) { panel.innerHTML = `<div class="honest-state"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><h3>Activity unavailable</h3><p>${escapeHtml(error)}</p></div>`; return; }
    if (!events.length) { panel.innerHTML = '<div class="honest-state"><i class="fa-regular fa-clock" aria-hidden="true"></i><h3>No recorded activity</h3><p>The API returned an empty timeline for this agent.</p></div>'; return; }
    panel.innerHTML = `<p class="timeline-date">Latest recorded activity</p><ol class="timeline">${events.map((event) => `<li class="timeline-event ${escapeHtml(event.status || '')}"><time datetime="${escapeHtml(event.timestamp || '')}">${escapeHtml(formatEventTime(event.timestamp))}</time><h3>${escapeHtml(event.title || event.type || 'Event')}</h3><p>${escapeHtml(event.detail || 'No event detail reported.')}</p>${event.evidence ? `<pre class="event-output">${escapeHtml(typeof event.evidence === 'string' ? event.evidence : JSON.stringify(event.evidence, null, 2))}</pre>` : ''}</li>`).join('')}</ol>`;
  }

  const tabMeta = {
    files: { icon: 'fa-regular fa-folder-open', title: 'No files reported', description: 'The agent activity API did not report a workspace file list.' },
    editor: { icon: 'fa-solid fa-code', title: 'Editor not attached', description: 'No live editor session or source buffer was reported for this agent.' },
    terminal: { icon: 'fa-solid fa-terminal', title: 'Terminal not attached', description: 'Terminal output requires a backend workspace stream; this view will not simulate one.' },
    browser: { icon: 'fa-regular fa-window-maximize', title: 'Browser not attached', description: 'No browser session or preview URL was reported for this agent.' },
    artifacts: { icon: 'fa-solid fa-box-archive', title: 'No artifacts reported', description: 'Completed outputs will appear here when the API records them.' },
    messages: { icon: 'fa-regular fa-comments', title: 'No messages reported', description: 'Agent-to-agent messages are shown only when provided by the operations API.' },
  };

  function resourceArray(agent, tab) {
    const workspace = agent.workspace && typeof agent.workspace === 'object' ? agent.workspace : {};
    const value = agent[tab] || workspace[tab];
    return Array.isArray(value) ? value : [];
  }

  function renderResourcePanel(tab, agent) {
    const panel = document.getElementById(`panel-${tab}`);
    const items = resourceArray(agent, tab);
    if (items.length) {
      panel.innerHTML = `<ul class="resource-list">${items.map((item) => `<li><i class="${tabMeta[tab].icon}" aria-hidden="true"></i><span>${escapeHtml(item.name || item.title || item.path || item.message || item)}</span><small>${escapeHtml(item.detail || item.status || item.size || '')}</small></li>`).join('')}</ul>`;
      return;
    }
    const meta = tabMeta[tab];
    panel.innerHTML = `<div class="honest-state"><i class="${meta.icon}" aria-hidden="true"></i><h3>${meta.title}</h3><p>${meta.description}</p></div>`;
  }

  function renderInspector() {
    const inspector = document.getElementById('inspector');
    const agent = state.selectedAgent;
    inspector.setAttribute('aria-hidden', agent ? 'false' : 'true');
    document.getElementById('inspectorEmpty').hidden = Boolean(agent);
    document.getElementById('inspectorContent').hidden = !agent;
    if (!agent) return;
    document.getElementById('inspectorTitle').textContent = `${agent.name} · ${agent.role}`;
    document.getElementById('inspectorTask').textContent = agent.task;
    const panels = document.getElementById('workspacePanels');
    panels.innerHTML = TABS.map((tab) => `<section class="tab-panel" id="panel-${tab}" role="tabpanel" aria-labelledby="tab-${tab}"${tab === state.activeTab ? '' : ' hidden'}></section>`).join('');
    renderActivity(state.activity.get(agent.id) || [], !state.activity.has(agent.id));
    TABS.filter((tab) => tab !== 'activity').forEach((tab) => renderResourcePanel(tab, agent));
    document.querySelectorAll('[role="tab"]').forEach((tab) => { const active = tab.dataset.tab === state.activeTab; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; });
  }

  async function loadActivity(agent) {
    if (state.demo) { state.activity.set(agent.id, agent.id === 'mira' ? demoTimeline : []); renderActivity(state.activity.get(agent.id)); return; }
    renderActivity([], true);
    try {
      const response = await request(`/agents/${encodeURIComponent(agent.id)}/activity`);
      const events = Array.isArray(response) ? response : Array.isArray(response?.events) ? response.events : Array.isArray(response?.timeline) ? response.timeline : [];
      state.activity.set(agent.id, events);
      if (state.selectedAgent?.id === agent.id) renderActivity(events);
    } catch (error) {
      if (state.selectedAgent?.id === agent.id) renderActivity([], false, error.status === 404 ? 'No activity endpoint exists for this agent.' : error.message);
    }
  }

  function selectAgent(agentId, openDrawer = true) {
    const agent = allAgents().find((candidate) => candidate.id === agentId);
    if (!agent) return;
    state.selectedAgent = agent;
    state.activeTab = 'activity';
    renderGroups(); renderInspector();
    if (openDrawer && globalScope.matchMedia?.('(max-width: 900px)').matches) openPanel('inspector');
    loadActivity(agent);
  }

  function renderGoal() {
    const project = state.overview.project;
    const progress = Number(project.progress);
    document.getElementById('goalSummary').innerHTML = `<h2>${escapeHtml(project.name || project.title || 'Active goal')}</h2><p>${escapeHtml(project.status || 'Goal state not reported')}</p><div class="goal-meta"><span>Goal progress</span><strong>${Number.isFinite(progress) ? `${progress}%` : 'Not reported'}</strong><span>${escapeHtml(project.target || '')}</span></div><div class="goal-progress"><span style="width:${Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0}%"></span></div>`;
    document.getElementById('goalItems').innerHTML = state.overview.goalItems.map((item) => `<li class="${String(item.status).toLowerCase().includes('progress') ? 'active' : ''}"><span class="goal-item-title">${escapeHtml(item.title || item.name || 'Untitled step')}</span><p class="goal-item-meta">${escapeHtml(item.assignee || item.agent || 'Unassigned')}<span class="goal-item-status ${escapeHtml(item.status || '')}">${escapeHtml(item.status || 'Status not reported')}</span></p></li>`).join('');
  }

  function renderReady() {
    renderHeader(); renderGroups(); renderGoal();
    document.getElementById('loadState').hidden = true;
    document.getElementById('fleetContent').hidden = false;
    const initial = state.overview.selectedAgentId && allAgents().find((agent) => agent.id === state.overview.selectedAgentId);
    if (initial) selectAgent(initial.id, false); else renderInspector();
  }

  function showLoadError(error) {
    const load = document.getElementById('loadState');
    load.className = 'load-state error';
    load.innerHTML = `<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><h1>Agent operations unavailable</h1><p>${escapeHtml(error.message || 'The overview API could not be reached.')}</p><button class="primary-button retry-button" type="button" id="retryLoad"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Retry live connection</button>`;
    document.getElementById('retryLoad').addEventListener('click', loadOverview);
  }

  async function loadOverview() {
    const load = document.getElementById('loadState');
    load.hidden = false; load.className = 'load-state';
    load.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i><h1>Connecting to agent operations</h1><p>Loading fleet, heartbeat, and goal state…</p>';
    document.getElementById('fleetContent').hidden = true;
    try {
      state.overview = normalizeOverview(state.demo ? demoOverview : await request('/overview'));
      renderReady();
    } catch (error) { showLoadError(error); }
  }

  async function resolveApproval(approvalId, decision, button) {
    button.disabled = true;
    try {
      if (state.demo) await new Promise((resolve) => globalScope.setTimeout(resolve, 250));
      else await request(`/approvals/${encodeURIComponent(approvalId)}/resolve`, { method: 'POST', body: JSON.stringify({ decision }) });
      const agent = allAgents().find((candidate) => candidate.approval?.id === approvalId);
      if (agent) { agent.approval = null; agent.status = decision === 'approve' ? 'running' : 'idle'; }
      renderGroups();
      showToast(`${decision === 'approve' ? 'Approved' : 'Rejected'} successfully.`);
    } catch (error) {
      const message = decision === 'reject' && error.status === 501 ? 'Reject is not supported by this backend. No approval state was changed.' : `Could not ${decision}: ${error.message}`;
      showToast(message, true); button.disabled = false;
    }
  }

  function setTab(tabName, focus = false) {
    if (!TABS.includes(tabName)) return;
    state.activeTab = tabName;
    document.querySelectorAll('[role="tab"]').forEach((tab) => { const active = tab.dataset.tab === tabName; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; if (active && focus) tab.focus(); });
    document.querySelectorAll('.tab-panel').forEach((panel) => { panel.hidden = panel.id !== `panel-${tabName}`; });
  }

  function openPanel(which) {
    const nav = document.getElementById('primaryNav'); const inspector = document.getElementById('inspector'); const backdrop = document.getElementById('drawerBackdrop');
    nav.classList.toggle('open', which === 'nav'); inspector.classList.toggle('open', which === 'inspector'); backdrop.hidden = !which;
    document.getElementById('navToggle').setAttribute('aria-expanded', String(which === 'nav'));
  }

  function setupGoalDialog() {
    const dialog = document.getElementById('goalDialog');
    const creation = capability('goalCreation');
    const endpoint = typeof creation === 'object' ? creation.endpoint : null;
    const enabled = creation === true || creation?.enabled === true;
    const submit = document.getElementById('createGoalSubmit');
    const note = document.getElementById('goalCapabilityNote');
    submit.disabled = !enabled || (!endpoint && !state.demo);
    note.textContent = !enabled ? 'Goal creation is unavailable: this backend did not advertise the goal-creation capability.' : !endpoint && !state.demo ? 'Goal creation is advertised, but no creation endpoint was provided by the backend capability.' : 'This goal will be sent to the configured operations goal endpoint.';
    document.getElementById('newGoalButton').onclick = () => dialog.showModal();
    submit.onclick = async (event) => {
      if (submit.disabled) { event.preventDefault(); return; }
      const title = document.getElementById('goalTitleInput').value.trim();
      if (!title) { event.preventDefault(); document.getElementById('goalTitleInput').reportValidity(); return; }
      event.preventDefault(); submit.disabled = true;
      try {
        if (!state.demo) await request(endpoint, { method: 'POST', body: JSON.stringify({ title, successCriteria: document.getElementById('goalCriteriaInput').value.trim() }) });
        dialog.close(); showToast(state.demo ? 'Preview goal captured locally; no live operation was created.' : 'Goal created.');
      } catch (error) { submit.disabled = false; showToast(`Could not create goal: ${error.message}`, true); }
    };
  }

  function bindEvents() {
    document.getElementById('agentSearch').addEventListener('input', (event) => { state.query = event.target.value; renderGroups(); });
    document.getElementById('agentGroups').addEventListener('click', (event) => {
      const approvalButton = event.target.closest('[data-approval]');
      if (approvalButton) { event.stopPropagation(); resolveApproval(approvalButton.dataset.approval, approvalButton.dataset.decision, approvalButton); return; }
      const header = event.target.closest('.group-header');
      if (header) { const group = header.closest('.agent-group'); group.classList.toggle('collapsed'); header.setAttribute('aria-expanded', String(!group.classList.contains('collapsed'))); return; }
      const row = event.target.closest('.agent-row'); if (row) selectAgent(row.dataset.agentId);
    });
    document.getElementById('agentGroups').addEventListener('keydown', (event) => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.agent-row')) { event.preventDefault(); selectAgent(event.target.dataset.agentId); } });
    document.getElementById('workspaceTabs').addEventListener('click', (event) => { const tab = event.target.closest('[role="tab"]'); if (tab) setTab(tab.dataset.tab); });
    document.getElementById('workspaceTabs').addEventListener('keydown', (event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const current = TABS.indexOf(state.activeTab); const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length; setTab(TABS[next], true); });
    document.getElementById('takeOverButton').addEventListener('click', () => { const note = document.getElementById('takeoverNote'); const takeOver = capability('takeOver'); note.hidden = false; note.textContent = takeOver ? 'Takeover is advertised, but this release exposes no mutation endpoint. Agent execution continues unchanged.' : 'Takeover is unavailable for this backend. The agent keeps working; no execution state was changed.'; });
    document.getElementById('navToggle').addEventListener('click', () => openPanel(document.getElementById('primaryNav').classList.contains('open') ? null : 'nav'));
    document.getElementById('closeInspector').addEventListener('click', () => openPanel(null));
    document.getElementById('drawerBackdrop').addEventListener('click', () => openPanel(null));
    document.getElementById('goalToggle').addEventListener('click', () => { const strip = document.getElementById('goalStrip'); strip.classList.toggle('open'); document.getElementById('goalToggle').setAttribute('aria-expanded', String(strip.classList.contains('open'))); });
  }

  function init() {
    state.demo = new URLSearchParams(globalScope.location.search).get('demo') === '1';
    document.getElementById('previewBanner').hidden = !state.demo;
    bindEvents(); loadOverview().then(setupGoalDialog);
  }

  const publicApi = { normalizeOverview, matchesAgent, normalizeAgent, escapeHtml, demoOverview };
  if (typeof module !== 'undefined' && module.exports) module.exports = publicApi;
  if (globalScope.document) {
    if (globalScope.document.readyState === 'loading') globalScope.document.addEventListener('DOMContentLoaded', init);
    else init();
  }
}(typeof window !== 'undefined' ? window : globalThis));
