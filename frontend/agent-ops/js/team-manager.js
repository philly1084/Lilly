(function teamManagerModule(scope) {
  'use strict';
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const field = (name, label, max, rows = 0) => `<label>${label}${rows ? `<textarea name="${name}" rows="${rows}" maxlength="${max}" required></textarea>` : `<input name="${name}" maxlength="${max}" required>`}</label>`;
  function create({ document, client, context, refresh }) {
    const dialog = document.createElement('dialog');
    dialog.id = 'teamManagerDialog'; dialog.className = 'workroom-dialog team-manager-dialog'; dialog.setAttribute('aria-labelledby', 'teamManagerTitle');
    dialog.innerHTML = `<div class="manager-shell"><header><div><span class="eyebrow">Team library</span><h2 id="teamManagerTitle">Teammates & knowledge</h2></div><button class="icon-button" type="button" data-manager-close aria-label="Close team management">×</button></header>
      <nav class="manager-nav" aria-label="Team management sections">${['people', 'skills', 'routines', 'memories'].map((tab) => `<button class="hud-button" type="button" data-manager-tab="${tab}" aria-pressed="false">${tab === 'people' ? 'Teammates' : tab[0].toUpperCase() + tab.slice(1)}</button>`).join('')}</nav>
      <div class="manager-body"><p id="managerNotice" class="capability-note"></p><p id="managerError" class="form-error" role="alert"></p><div class="manager-layout"><section class="manager-catalog" aria-label="Saved entries"><button class="hud-button" type="button" id="managerNew">New entry</button><div id="managerList"></div></section>
      <form id="managerPeople" hidden>${field('name', 'Name', 100)}${field('job', 'Responsibility', 4000, 3)}<label>Persona<textarea name="persona" maxlength="4000" rows="4"></textarea></label><p class="capability-note">Editing preserves this teammate’s role, identity, memory and permissions.</p><button class="primary-button" type="submit">Save profile</button></form>
      <form id="managerSkills" hidden>${field('name', 'Skill name', 120)}${field('instructions', 'Reusable instructions', 12000, 6)}${field('acceptance', 'Acceptance checks', 4000, 3)}<p id="skillRevision" class="capability-note"></p><button class="primary-button" type="submit">Save draft revision</button><label class="team-check" id="skillConsent"><input type="checkbox" name="inspected"> I reviewed this saved revision and its acceptance checks.</label><button class="hud-button" type="button" id="managerApproveSkill">Approve saved revision</button></form>
      <form id="managerRoutines" hidden>${field('title', 'Routine title', 200)}<label>Teammate<select name="agentId" required></select></label><label>Approved skill<select name="skillId" required></select></label>${field('instruction', 'Recurring outcome', 12000, 4)}<label>Interval in minutes<input name="minutes" type="number" min="1" max="44640" value="1440" required></label><p id="routineSchedule" class="capability-note"></p><button class="primary-button" type="submit">Create paused routine</button><label class="team-check" id="routineConsent"><input type="checkbox" name="confirmed"> Allow this routine to queue recurring tasks; enabled team execution may run them.</label><button class="hud-button" type="button" id="managerControlRoutine">Enable routine</button></form>
      <form id="managerMemories" hidden><label>Teammate<select name="agentId" required></select></label><label>Visibility<select name="scope"><option value="private">Private to teammate + owner</option><option value="team">Shared with team</option></select></label>${field('content', 'Memory', 4000, 5)}${field('source', 'Source or reason', 1000, 2)}<button class="primary-button" type="submit">Save memory</button><details id="memoryForget"><summary>Forget this memory</summary><p class="capability-note">Removes this saved memory. Existing task outputs are unchanged.</p><label class="team-check"><input type="checkbox" name="confirmed"> I want to forget the selected memory.</label><button class="hud-button" type="button" id="managerForgetMemory">Forget selected memory</button></details></form>
      </div></div><footer><span id="managerStatus" role="status" aria-live="polite"></span><button class="hud-button" type="button" data-manager-close>Close</button></footer></div>`;
    document.body.append(dialog);
    const find = (selector) => dialog.querySelector(selector);
    const forms = { people: find('#managerPeople'), skills: find('#managerSkills'), routines: find('#managerRoutines'), memories: find('#managerMemories') };
    let teamId = null; let tab = 'skills'; let selected = null; let memories = []; let snapshot = null; let token = 0; let controller; let pending = false;
    const notice = { people: 'Edit saved profiles without starting agents.', skills: 'Draft, inspect and approve reusable instructions. Revisions do not change previously queued tasks or existing routines.',
      routines: 'Routines are created paused. Enabling a routine is separate from team execution; no work starts from opening this view.', memories: 'Owner-only view. Private memories are fetched only here and cleared from this view when you leave. They never enter the shared room feed.' };
    const entries = () => tab === 'people' ? snapshot?.agents || [] : tab === 'memories' ? memories : snapshot?.[tab] || [];
    const options = (items, label) => items.map((item) => `<option value="${escape(item.id)}">${escape(label(item))}</option>`).join('');
    function clearMemory() {
      controller?.abort(); controller = null; memories = []; forms.memories.reset();
      forms.memories.elements.agentId.replaceChildren();
      if (tab === 'memories') find('#managerList').replaceChildren();
    }
    function close() { token += 1; clearMemory(); teamId = null; snapshot = null; selected = null; find('#managerList').replaceChildren(); Object.values(forms).forEach((form) => form.reset()); if (dialog.open) dialog.close(); }
    dialog.addEventListener('close', () => { if (teamId) close(); });
    dialog.addEventListener('cancel', () => close());
    dialog.querySelectorAll('[data-manager-close]').forEach((button) => button.addEventListener('click', close));
    function error(error) { find('#managerError').textContent = error.message || String(error); }
    function renderList() {
      find('#managerList').innerHTML = entries().map((item) => `<button class="manager-entry" type="button" data-entry="${escape(item.id)}" aria-pressed="${item.id === selected}"><strong>${escape(item.name || item.title || item.content.slice(0, 90))}</strong><small>${escape(tab === 'skills' ? `${item.status} · revision ${item.revision}` : tab === 'routines' ? item.enabled ? 'Enabled' : 'Paused' : tab === 'memories' ? `${item.scope} · ${snapshot.agents.find((agent) => agent.id === item.agentId)?.name || 'Teammate'}` : item.role)}</small></button>`).join('') || '<p class="empty-compact">No saved entries yet.</p>';
    }
    function edit(id = null) {
      selected = id; const item = entries().find((entry) => entry.id === id); const form = forms[tab]; form.reset();
      find('#managerError').textContent = ''; find('#managerStatus').textContent = '';
      for (const name of ['agentId', 'skillId']) {
        const input = form.elements[name]; if (!input) continue;
        input.innerHTML = name === 'agentId' ? options(snapshot.agents, (agent) => agent.name) : options(snapshot.skills.filter((skill) => skill.status === 'approved'), (skill) => `${skill.name} · v${skill.revision}`);
      }
      if (item) for (const input of form.elements) { if (input.name && input.type !== 'checkbox' && typeof item[input.name] === 'string') input.value = item[input.name]; }
      if (tab === 'skills') {
        find('#skillRevision').textContent = item ? `Saved ${item.status} revision ${item.revision}. Save creates a new draft; approval applies only to this saved revision, never unsaved edits.` : 'New skills are drafts until you explicitly approve a saved revision.';
        find('#managerApproveSkill').hidden = !item || item.status === 'approved'; find('#skillConsent').hidden = !item || item.status === 'approved';
      }
      if (tab === 'routines') {
        form.elements.minutes.value = item ? item.intervalSeconds / 60 : 1440;
        for (const input of form.elements) if (input.name && input.type !== 'checkbox') input.disabled = Boolean(item);
        form.querySelector('[type="submit"]').hidden = Boolean(item);
        find('#routineSchedule').textContent = item ? `${item.enabled ? 'Enabled' : 'Paused'} · ${item.nextAt ? `Next due: ${new Date(item.nextAt).toLocaleString()}` : 'No next occurrence scheduled'}. Existing routine definitions are immutable; create a new paused routine to change its template.` : 'Save creates a paused routine. No tasks are queued by creation.';
        find('#managerControlRoutine').hidden = !item; find('#managerControlRoutine').textContent = item?.enabled ? 'Pause routine' : 'Enable routine'; find('#routineConsent').hidden = !item || item.enabled;
      }
      if (tab === 'memories') { form.elements.agentId.disabled = Boolean(item); form.elements.scope.disabled = Boolean(item); find('#memoryForget').hidden = !item; find('#memoryForget').open = false; }
      form.hidden = tab === 'people' && !item; renderList();
    }
    async function loadMemories(currentToken) {
      clearMemory(); controller = new AbortController(); find('#managerStatus').textContent = 'Loading owner-only memories…';
      try {
        const result = await client.memories(teamId, controller.signal);
        if (currentToken !== token || !dialog.open || tab !== 'memories') return;
        memories = result; edit(); find('#managerStatus').textContent = `${memories.length} saved memories`;
      } catch (reason) { if (currentToken === token && dialog.open) { error(reason); find('#managerStatus').textContent = 'Memory fetch failed. Reopen this section to retry.'; } }
    }
    async function switchTab(next) {
      if (pending) return;
      token += 1; clearMemory(); tab = next; selected = null;
      snapshot = context().snapshot; if (!snapshot || context().teamId !== teamId) { close(); return; }
      Object.entries(forms).forEach(([key, form]) => { form.hidden = key !== tab; });
      dialog.querySelectorAll('[data-manager-tab]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.managerTab === tab)));
      find('#managerNotice').textContent = notice[tab]; find('#managerNew').hidden = tab === 'people'; find('#managerNew').textContent = `New ${tab === 'memories' ? 'memory' : tab.slice(0, -1)}`;
      edit(); if (tab === 'memories') await loadMemories(token);
    }
    async function run(action, input) {
      if (pending || !teamId) return;
      const currentToken = token; const currentTeam = teamId; pending = true; dialog.setAttribute('aria-busy', 'true');
      find('#managerError').textContent = ''; find('#managerStatus').textContent = 'Saving…';
      const buttons = [...dialog.querySelectorAll('button:not([data-manager-close])')].map((button) => [button, button.disabled]); buttons.forEach(([button]) => { button.disabled = true; });
      try {
        const result = await client.command(currentTeam, action, input);
        if (currentToken !== token || context().teamId !== currentTeam || !dialog.open) return;
        await refresh(); if (currentToken !== token || context().teamId !== currentTeam || !dialog.open) return;
        snapshot = context().snapshot;
        if (tab === 'memories') { memories = action === 'forget' ? memories.filter((item) => item.id !== input.memoryId) : [...memories.filter((item) => item.id !== (result.id || input.memoryId)), result]; }
        edit(action === 'forget' ? null : result.id || selected); find('#managerStatus').textContent = 'Saved. No execution setting was changed.';
      } catch (reason) { if (currentToken === token && dialog.open) { error(reason); find('#managerStatus').textContent = 'Not confirmed. Keep this draft and retry the same command.'; } }
      finally { pending = false; dialog.setAttribute('aria-busy', 'false'); buttons.forEach(([button, disabled]) => { button.disabled = disabled; }); }
    }
    find('#managerNew').addEventListener('click', () => edit());
    find('#managerList').addEventListener('click', (event) => { const button = event.target.closest('[data-entry]'); if (button && !pending) edit(button.dataset.entry); });
    dialog.querySelectorAll('[data-manager-tab]').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.managerTab)));
    Object.entries(forms).forEach(([key, form]) => form.addEventListener('submit', (event) => {
      event.preventDefault(); if (pending || !form.reportValidity()) return;
      const value = (name) => form.elements[name].value.trim();
      if (key === 'people') run('update_agent', { agentId: selected, name: value('name'), job: value('job'), persona: value('persona') });
      if (key === 'skills') run('save_skill', { name: value('name'), instructions: value('instructions'), acceptance: value('acceptance'), ...(selected ? { replaces: selected } : {}) });
      if (key === 'routines') run('create_routine', { title: value('title'), agentId: value('agentId'), skillId: value('skillId'), instruction: value('instruction'), intervalSeconds: Number(value('minutes')) * 60 });
      if (key === 'memories') run(selected ? 'update_memory' : 'remember', { ...(selected ? { memoryId: selected } : { agentId: value('agentId'), scope: value('scope') }), content: value('content'), source: value('source') });
    }));
    find('#managerApproveSkill').addEventListener('click', () => {
      const saved = snapshot.skills.find((item) => item.id === selected); const form = forms.skills;
      if (!form.elements.inspected.checked) { error(new Error('Inspect the saved revision and confirm review before approving.')); return; }
      if (['name', 'instructions', 'acceptance'].some((key) => form.elements[key].value !== saved[key])) { error(new Error('Unsaved changes are not the saved revision. Save a new draft before approving.')); return; }
      run('approve_skill', { skillId: selected });
    });
    find('#managerControlRoutine').addEventListener('click', () => {
      const routine = snapshot.routines.find((item) => item.id === selected);
      if (!routine.enabled && !forms.routines.elements.confirmed.checked) { error(new Error('Confirm recurring task permission before enabling this routine.')); return; }
      run('control_routine', { routineId: selected, enabled: !routine.enabled });
    });
    find('#managerForgetMemory').addEventListener('click', () => { if (!forms.memories.elements.confirmed.checked) { error(new Error('Confirm forgetting the selected memory first.')); return; } run('forget', { memoryId: selected }); });
    return { close, open: () => { const current = context(); if (!current.teamId || !current.snapshot) return; teamId = current.teamId; snapshot = current.snapshot; dialog.showModal(); switchTab('skills'); find('[data-manager-tab="skills"]').focus(); } };
  }
  const api = { create }; if (typeof module !== 'undefined' && module.exports) module.exports = api; scope.LillyTeamManager = api;
}(typeof window !== 'undefined' ? window : globalThis));
