'use strict';

const eventTypes = [
  'queued',
  'started',
  'lease_recovered',
  'heartbeat',
  'progress',
  'safety',
  'tool_message',
  'tool_started',
  'tool_completed',
  'tool_failed',
  'tool_skipped',
  'checkpoint',
  'lock_acquired',
  'lock_wait',
  'webhook_received',
  'completed',
  'failed',
  'cancelled',
  'cancel_requested',
];

const state = {
  activeRun: null,
  eventSource: null,
  lastCursor: 0,
  pendingEvents: [],
  flushing: false,
  seenEvents: new Set(),
  runCursors: new Map(),
  runs: [],
};

const els = {
  form: document.getElementById('runForm'),
  task: document.getElementById('taskInput'),
  adapter: document.getElementById('adapterInput'),
  target: document.getElementById('targetInput'),
  idempotency: document.getElementById('idempotencyInput'),
  liveRemote: document.getElementById('liveRemoteInput'),
  start: document.getElementById('startButton'),
  cancel: document.getElementById('cancelButton'),
  reconnect: document.getElementById('reconnectButton'),
  refreshStatus: document.getElementById('refreshStatus'),
  runtimeLine: document.getElementById('runtimeLine'),
  connectionDot: document.getElementById('connectionDot'),
  connectionLabel: document.getElementById('connectionLabel'),
  eventMeta: document.getElementById('eventMeta'),
  eventList: document.getElementById('eventList'),
  runStatus: document.getElementById('runStatus'),
  runIdValue: document.getElementById('runIdValue'),
  adapterValue: document.getElementById('adapterValue'),
  targetValue: document.getElementById('targetValue'),
  busValue: document.getElementById('busValue'),
  remoteValue: document.getElementById('remoteValue'),
  runSelect: document.getElementById('runSelect'),
  loadRun: document.getElementById('loadRunButton'),
};

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function setConnection(label, mode = 'idle') {
  els.connectionLabel.textContent = label;
  els.connectionDot.className = `dot dot-${mode}`;
}

function setControlsEnabled(enabled) {
  els.start.disabled = !enabled;
  els.cancel.disabled = !state.activeRun || ['completed', 'cancelled', 'failed'].includes(state.activeRun.status);
  els.reconnect.disabled = !state.activeRun;
  els.loadRun.disabled = !enabled || !els.runSelect.value;
}

function updateRunDetails(run = null) {
  state.activeRun = run;
  const status = run?.status || 'none';
  els.runStatus.textContent = status;
  els.runStatus.className = `status-pill ${status}`;
  els.runIdValue.textContent = run?.id || 'none';
  els.adapterValue.textContent = run?.adapter || 'none';
  els.targetValue.textContent = run?.targetKey || 'none';
  els.remoteValue.textContent = run
    ? (run.liveRemoteAllowed ? 'allowed' : (run.liveRemoteRequested ? 'requested, blocked' : 'not requested'))
    : 'not requested';
  setControlsEnabled(true);
}

function updateRuntimeStatus(status = {}) {
  const bus = status.bus || {};
  const enabled = status.enabled === true;
  els.runtimeLine.textContent = enabled
    ? `${status.namespace || 'async lab'} | ${bus.backend || 'memory'} bus | live remote ${status.allowLiveRemote ? 'allowed' : 'dry-run'}`
    : `Async runtime lab ${status.requestedEnabled ? 'requested' : 'standby'} | Valkey ${status.valkeyConfigured ? 'configured' : 'not configured'}`;
  els.busValue.textContent = `${bus.backend || 'unknown'}${bus.available ? ' connected' : ''}`;
}

async function loadStatus() {
  if (window.location.protocol === 'file:') {
    updateRuntimeStatus({
      enabled: false,
      namespace: 'file preview',
      bus: { backend: 'offline' },
      allowLiveRemote: false,
    });
    setConnection('File preview', 'warn');
    setControlsEnabled(false);
    return;
  }

  try {
    const payload = await fetchJson('/api/async-lab/status');
    const status = payload.status || {};
    updateRuntimeStatus(status);
    if (!status.enabled) {
      setConnection(status.requestedEnabled ? 'Requested' : 'Standby', 'warn');
      setControlsEnabled(false);
      return;
    }
    setConnection('Ready', 'live');
    setControlsEnabled(true);
    await loadRuns();
  } catch (error) {
    els.runtimeLine.textContent = error.message;
    setConnection('Disabled', 'bad');
    setControlsEnabled(false);
  }
}

async function loadRuns() {
  try {
    const payload = await fetchJson('/api/async-lab/runs?limit=40');
    state.runs = Array.isArray(payload.runs) ? payload.runs : [];
    renderRunSelect();
  } catch (_error) {
    state.runs = [];
    renderRunSelect();
  }
}

function renderRunSelect() {
  const selected = state.activeRun?.id || '';
  els.runSelect.textContent = '';
  if (state.runs.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No runs loaded';
    els.runSelect.appendChild(option);
  } else {
    for (const run of state.runs) {
      const option = document.createElement('option');
      option.value = run.id;
      option.textContent = `${run.status} | ${run.adapter} | ${run.targetKey}`;
      option.selected = run.id === selected;
      els.runSelect.appendChild(option);
    }
  }
  setControlsEnabled(true);
}

function resetEvents() {
  state.lastCursor = 0;
  state.pendingEvents = [];
  state.seenEvents.clear();
  els.eventList.textContent = '';
  els.eventMeta.textContent = 'Waiting for events';
}

function enqueueEvent(event = {}) {
  const cursor = Number(event.cursor || 0);
  const key = event.eventId || `${cursor}:${event.type || 'message'}`;
  if (state.seenEvents.has(key)) {
    return;
  }
  state.seenEvents.add(key);
  state.lastCursor = Math.max(state.lastCursor, cursor);
  if (state.activeRun?.id) {
    state.runCursors.set(state.activeRun.id, state.lastCursor);
  }
  state.pendingEvents.push(event);
  if (!state.flushing) {
    state.flushing = true;
    requestAnimationFrame(flushEvents);
  }
}

function flushEvents() {
  const batch = state.pendingEvents.splice(0, 40);
  for (const event of batch) {
    els.eventList.appendChild(renderEvent(event));
    if (event.status && state.activeRun) {
      updateRunDetails({
        ...state.activeRun,
        status: event.status,
      });
    }
  }

  const eventCount = els.eventList.children.length;
  els.eventMeta.textContent = state.activeRun
    ? `${eventCount} events | cursor ${state.lastCursor}`
    : 'No run selected';
  els.eventList.scrollTop = els.eventList.scrollHeight;

  if (state.pendingEvents.length > 0) {
    requestAnimationFrame(flushEvents);
    return;
  }
  state.flushing = false;
}

function renderEvent(event = {}) {
  const item = document.createElement('li');
  item.className = 'event';
  item.dataset.status = event.status || '';
  item.dataset.type = event.type || '';

  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const message = payload.message || event.type || 'event';
  const timestamp = event.timestamp || new Date().toISOString();
  const payloadText = JSON.stringify(payload, null, 2);

  item.innerHTML = `
    <div class="event-cursor">#${escapeHtml(event.cursor || '')}</div>
    <div class="event-body">
      <div class="event-title">
        <strong>${escapeHtml(event.type || 'message')}</strong>
        <time datetime="${escapeHtml(timestamp)}">${escapeHtml(new Date(timestamp).toLocaleTimeString())}</time>
      </div>
      <div class="event-message">${escapeHtml(message)}</div>
      <pre class="event-json">${escapeHtml(payloadText)}</pre>
    </div>
  `;
  return item;
}

function closeEventSource() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

function connectEvents(runId, after = 0) {
  closeEventSource();
  const source = new EventSource(`/api/async-lab/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(after)}&stream=true`);
  state.eventSource = source;
  setConnection('Streaming', 'live');

  for (const type of eventTypes) {
    source.addEventListener(type, (message) => {
      try {
        enqueueEvent(JSON.parse(message.data));
      } catch (error) {
        enqueueEvent({
          cursor: state.lastCursor + 1,
          type: 'client_error',
          status: 'running',
          payload: { message: error.message },
          timestamp: new Date().toISOString(),
        });
      }
    });
  }

  source.onopen = () => {
    setConnection('Streaming', 'live');
  };
  source.onerror = () => {
    setConnection('Reconnect needed', 'warn');
  };
}

async function refreshRun() {
  if (!state.activeRun) {
    return;
  }
  try {
    const payload = await fetchJson(`/api/async-lab/runs/${encodeURIComponent(state.activeRun.id)}?after=${state.lastCursor}`);
    updateRunDetails(payload.run);
    for (const event of payload.events || []) {
      enqueueEvent(event);
    }
  } catch (error) {
    setConnection(error.message, 'bad');
  }
}

async function openRun(runId) {
  const id = String(runId || '').trim();
  if (!id) {
    return;
  }
  closeEventSource();
  state.lastCursor = state.runCursors.get(id) || 0;
  state.pendingEvents = [];
  state.seenEvents.clear();
  els.eventList.textContent = '';
  setConnection('Loading run', 'warn');

  try {
    const payload = await fetchJson(`/api/async-lab/runs/${encodeURIComponent(id)}`);
    updateRunDetails(payload.run);
    for (const event of payload.events || []) {
      enqueueEvent(event);
    }
    connectEvents(id, state.lastCursor);
  } catch (error) {
    setConnection(error.message, 'bad');
  }
}

async function startRun(event) {
  event.preventDefault();
  els.start.disabled = true;
  setConnection('Queueing', 'warn');
  resetEvents();

  try {
    const payload = await fetchJson('/api/async-lab/runs', {
      method: 'POST',
      body: JSON.stringify({
        task: els.task.value,
        adapter: els.adapter.value,
        targetKey: els.target.value,
        idempotencyKey: els.idempotency.value,
        liveRemote: els.liveRemote.checked,
      }),
    });
    updateRunDetails(payload.run);
    await loadRuns();
    for (const item of payload.events || []) {
      enqueueEvent(item);
    }
    connectEvents(payload.run.id, state.lastCursor);
  } catch (error) {
    setConnection(error.message, 'bad');
  } finally {
    setControlsEnabled(true);
  }
}

async function cancelRun() {
  if (!state.activeRun) {
    return;
  }

  els.cancel.disabled = true;
  try {
    const payload = await fetchJson(`/api/async-lab/runs/${encodeURIComponent(state.activeRun.id)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    updateRunDetails(payload.run);
    await refreshRun();
  } catch (error) {
    setConnection(error.message, 'bad');
  } finally {
    setControlsEnabled(true);
  }
}

els.form.addEventListener('submit', startRun);
els.cancel.addEventListener('click', cancelRun);
els.reconnect.addEventListener('click', () => {
  if (state.activeRun) {
    connectEvents(state.activeRun.id, state.lastCursor);
  }
});
els.runSelect.addEventListener('change', () => setControlsEnabled(true));
els.loadRun.addEventListener('click', () => openRun(els.runSelect.value));
els.refreshStatus.addEventListener('click', loadStatus);

window.addEventListener('beforeunload', closeEventSource);

loadStatus();
