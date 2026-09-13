'use strict';
const { JSDOM } = require('jsdom');
const { create } = require('./team-manager');

describe('owner team management', () => {
  const windows = [];
  afterEach(() => windows.splice(0).forEach((window) => window.close()));
  const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
  function mount() {
    const window = new JSDOM('<body></body>', { url: 'https://fixture.test' }).window; windows.push(window);
    window.HTMLDialogElement.prototype.showModal = function open() { this.open = true; };
    window.HTMLDialogElement.prototype.close = function close() { this.open = false; this.dispatchEvent(new window.Event('close')); };
    const snapshot = { agents: [{ id: 'a', name: 'Mira', role: 'specialist', job: 'Build', persona: 'Careful' }], skills: [
      { id: 'draft', name: 'Draft', instructions: 'Inspect the output.', acceptance: 'Saved output read back.', status: 'draft', revision: 1 },
      { id: 'approved', name: 'Approved', instructions: 'Check.', acceptance: 'Evidence.', status: 'approved', revision: 1 },
    ], routines: [{ id: 'r', title: 'Check output', agentId: 'a', skillId: 'approved', instruction: 'Review.', intervalSeconds: 3600, enabled: false }] };
    const current = { teamId: 'team-1', snapshot };
    const client = { memories: jest.fn(async () => [{ id: 'm', agentId: 'a', scope: 'private', content: 'Private fact only', source: 'Owner' }]), command: jest.fn(async (teamId, action, input) => {
      if (action === 'save_skill') { const item = { id: 'next', ...input, status: 'draft', revision: 2 }; snapshot.skills.push(item); return item; }
      if (action === 'approve_skill') { const item = snapshot.skills.find((entry) => entry.id === input.skillId); item.status = 'approved'; return item; }
      if (action === 'control_routine') { snapshot.routines[0].enabled = input.enabled; return snapshot.routines[0]; }
      if (action === 'forget') return { forgotten: true };
      return { id: 'created', ...input };
    }) };
    const manager = create({ document: window.document, client, context: () => current, refresh: async () => {} }); manager.open();
    const get = (selector) => window.document.querySelector(selector);
    const clickTab = async (tab) => { get(`[data-manager-tab="${tab}"]`).click(); await flush(); };
    const submit = (form) => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    return { window, snapshot, current, client, manager, get, clickTab, submit };
  }
  test('opens without private memory fetch or execution writes; private data clears on leave and close', async () => {
    const { client, get, clickTab, manager } = mount();
    expect(client.memories).not.toHaveBeenCalled(); expect(client.command).not.toHaveBeenCalled();
    await clickTab('memories'); expect(client.memories).toHaveBeenCalledTimes(1);
    get('[data-entry="m"]').click(); expect(get('#managerMemories').elements.content.value).toBe('Private fact only');
    await clickTab('skills'); expect(get('#managerMemories').elements.content.value).toBe(''); expect(get('#managerList').textContent).not.toContain('Private fact');
    await clickTab('memories'); manager.close(); expect(get('#managerList').textContent).toBe(''); expect(get('#managerMemories').elements.content.value).toBe('');
  });
  test('late private fetch after close is discarded', async () => {
    const { client, get, manager } = mount(); let finish;
    client.memories.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    get('[data-manager-tab="memories"]').click(); manager.close(); finish([{ id: 'late', content: 'Never render me' }]); await flush();
    expect(get('#managerList').textContent).toBe('');
  });
  test('skill drafts require reviewed saved revision and reject approving unsaved edits', async () => {
    const { client, get, submit } = mount(); const form = get('#managerSkills');
    get('[data-entry="draft"]').click(); get('#managerApproveSkill').click(); expect(client.command).not.toHaveBeenCalled();
    form.elements.inspected.checked = true; form.elements.instructions.value = 'Changed locally'; get('#managerApproveSkill').click(); expect(client.command).not.toHaveBeenCalled();
    submit(form); await flush(); expect(client.command).toHaveBeenLastCalledWith('team-1', 'save_skill', expect.objectContaining({ replaces: 'draft', instructions: 'Changed locally' }));
    form.elements.inspected.checked = true; get('#managerApproveSkill').click(); await flush(); expect(client.command).toHaveBeenLastCalledWith('team-1', 'approve_skill', { skillId: 'next' });
  });
  test('routine templates list approved skills only and creation stays paused; enabling requires consent', async () => {
    const { client, get, clickTab, submit } = mount(); await clickTab('routines'); const form = get('#managerRoutines');
    expect([...form.elements.skillId.options].map((option) => option.value)).toEqual(['approved']);
    form.elements.title.value = 'Daily check'; form.elements.instruction.value = 'Read output'; submit(form); await flush();
    expect(client.command).toHaveBeenLastCalledWith('team-1', 'create_routine', expect.not.objectContaining({ enabled: true }));
    get('[data-entry="r"]').click(); get('#managerControlRoutine').click(); expect(client.command).toHaveBeenCalledTimes(1);
    form.elements.confirmed.checked = true; get('#managerControlRoutine').click(); await flush();
    expect(client.command).toHaveBeenLastCalledWith('team-1', 'control_routine', { routineId: 'r', enabled: true });
    get('#managerControlRoutine').click(); await flush(); expect(client.command).toHaveBeenLastCalledWith('team-1', 'control_routine', { routineId: 'r', enabled: false });
  });
  test('memory updates preserve scope and require explicit forget confirmation', async () => {
    const { client, get, clickTab, submit } = mount(); await clickTab('memories'); get('[data-entry="m"]').click(); const form = get('#managerMemories');
    expect(form.elements.scope.disabled).toBe(true); form.elements.content.value = 'Corrected fact'; submit(form); await flush();
    expect(client.command).toHaveBeenLastCalledWith('team-1', 'update_memory', { memoryId: 'm', content: 'Corrected fact', source: 'Owner' });
    get('#managerForgetMemory').click(); expect(client.command).toHaveBeenCalledTimes(1); form.elements.confirmed.checked = true; get('#managerForgetMemory').click(); await flush();
    expect(client.command).toHaveBeenLastCalledWith('team-1', 'forget', { memoryId: 'created' });
  });
  test('failed save preserves fields and does not mutate team selection', async () => {
    const { client, get, submit, current } = mount(); client.command.mockRejectedValue(new Error('Network uncertain'));
    const form = get('#managerSkills'); form.elements.name.value = 'Draft name'; form.elements.instructions.value = 'Instructions'; form.elements.acceptance.value = 'Checks'; submit(form); await flush();
    expect(form.elements.name.value).toBe('Draft name'); expect(get('#managerError').textContent).toBe('Network uncertain'); expect(current.teamId).toBe('team-1');
  });
  test('profile edits send only owner-editable fields and do not change role or execution', async () => {
    const { client, get, clickTab, submit } = mount(); await clickTab('people'); get('[data-entry="a"]').click(); const form = get('#managerPeople'); form.elements.persona.value = 'Precise'; submit(form); await flush();
    expect(client.command).toHaveBeenLastCalledWith('team-1', 'update_agent', { agentId: 'a', name: 'Mira', job: 'Build', persona: 'Precise' });
  });
  test('late save retains original team scope and cannot restore private content after a switch', async () => {
    const { client, get, clickTab, submit, current, manager } = mount(); await clickTab('memories'); get('[data-entry="m"]').click(); let finish;
    client.command.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const form = get('#managerMemories'); form.elements.content.value = 'Private edit'; submit(form);
    manager.close(); current.teamId = 'team-2'; manager.open(); finish({ id: 'm', content: 'Private edit', source: 'Owner', scope: 'private', agentId: 'a' }); await flush();
    expect(client.command.mock.calls[0][0]).toBe('team-1');
    expect(form.elements.content.value).toBe(''); expect(get('#managerList').textContent).not.toContain('Private edit');
  });
});
