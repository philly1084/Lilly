const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadMissionContext(document = null) {
  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
    .replace(/\/\/ Initialize app when DOM is ready[\s\S]*$/, 'globalThis.ChatApp = ChatApp;');
  const documentRef = document || {
    getElementById: () => null,
    addEventListener: () => {},
  };
  const uiHelpers = {
    reinitializeIcons: jest.fn(),
    buildProofPackMarkup: jest.fn(() => '<section class="proof-pack">Typed proof</section>'),
    showToast: jest.fn(),
  };
  const sessionManager = {
    currentSessionId: 'session-1',
    getCurrentSession: jest.fn(() => null),
    mergeSessionMetadataLocally: jest.fn(),
    persistSessionMetadata: jest.fn(async () => true),
  };
  const context = {
    window: {
      location: { origin: 'https://chat.example.test', search: '' },
      KimiBuiltWebChatWorkspace: null,
      KimiBuiltWebChatWorkspaceEmbed: null,
      setTimeout,
      clearTimeout,
    },
    document: documentRef,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    Event: document?.defaultView?.Event || Event,
    console,
    uiHelpers,
    sessionManager,
    apiClient: {},
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'app.js' });
  return context;
}

describe('Lilly Mission Mode', () => {
  test('decodes a launchpad mission as an explicit prefill with no auto-run signal', () => {
    const context = loadMissionContext();
    const app = Object.create(context.ChatApp.prototype);
    const starter = 'Build a launch-ready demo, then prove the live route.';

    const launch = app.readMissionLaunchParams(`?mission=build-launch&starter=${encodeURIComponent(starter)}&autorun=1`);

    expect(launch).toEqual(expect.objectContaining({
      templateId: 'build-launch',
      label: 'Build and launch',
      starterPrompt: starter,
    }));
    expect(launch).not.toHaveProperty('autorun');
    expect(app.readMissionLaunchParams('?mission=unknown')).toBeNull();
  });

  test('renders persistent objective, run state, controls, timeline, proof, and raw detail', () => {
    const dom = new JSDOM(`
      <section id="mission-mode" class="hidden">
        <h2 id="mission-objective"></h2><span id="mission-state-label"></span>
        <span id="mission-phase-label"></span><span id="mission-elapsed-label"></span>
        <span id="mission-permission-label"></span><p id="mission-status-note"></p>
        <button data-mission-action="start"></button><button data-mission-action="pause"></button>
        <button data-mission-action="resume"></button><button data-mission-action="replay"></button>
        <button data-mission-action="fork"></button><button data-mission-action="cancel"></button>
        <ol id="mission-timeline"></ol><div id="mission-proof-pack"></div><pre id="mission-raw-events"></pre>
      </section>
    `);
    const context = loadMissionContext(dom.window.document);
    const app = Object.create(context.ChatApp.prototype);
    app.missionMode = dom.window.document.getElementById('mission-mode');
    ['Objective', 'StateLabel', 'PhaseLabel', 'ElapsedLabel', 'PermissionLabel', 'StatusNote', 'Timeline', 'ProofPack', 'RawEvents']
      .forEach((suffix) => {
        const id = `mission-${suffix.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replace(/^-/, '')}`;
        app[`mission${suffix}`] = dom.window.document.getElementById(id);
      });
    app.missionActionInFlight = false;
    app.missionState = app.createMissionState({
      active: true,
      objective: 'Ship the impressive demo',
      permission: 'Approval before deploy',
      uiState: 'streaming',
      phase: 'Verifying',
      statusNote: 'Checking the served route.',
      startedAt: new Date(Date.now() - 3000).toISOString(),
      run: { id: 'run-1', state: 'verifying', objective: 'Ship the impressive demo', evidence: { checks: [{ label: 'UI check', passed: true }] } },
      events: [{ eventId: 'event-1', type: 'browser_check', status: 'completed', payload: { title: 'Browser check' } }],
    });

    app.renderMissionMode();

    expect(app.missionMode.classList.contains('hidden')).toBe(false);
    expect(app.missionObjective.textContent).toBe('Ship the impressive demo');
    expect(app.missionStateLabel.textContent).toBe('Verifying');
    expect(app.missionTimeline.textContent).toContain('Browser check');
    expect(app.missionProofPack.innerHTML).toContain('Typed proof');
    expect(app.missionRawEvents.textContent).toContain('"id": "run-1"');
    expect(app.missionMode.querySelector('[data-mission-action="pause"]').hidden).toBe(false);
    expect(app.missionMode.querySelector('[data-mission-action="start"]').hidden).toBe(true);
  });

  test('routes mission controls through the real AgentRun action adapter', async () => {
    const context = loadMissionContext();
    context.apiClient.postAgentRunAction = jest.fn(async () => ({
      run: { id: 'run-1', state: 'waiting_for_approval' },
      events: [],
      uiState: 'streaming',
    }));
    const app = Object.create(context.ChatApp.prototype);
    app.missionState = app.createMissionState({ active: true, run: { id: 'run-1', state: 'executing' } });
    app.missionActionInFlight = false;
    app.renderMissionMode = jest.fn();
    app.buildMissionTimeline = jest.fn(() => []);
    app.updateMissionFromPayload = jest.fn();

    await app.handleMissionAction('pause');

    expect(context.apiClient.postAgentRunAction).toHaveBeenCalledWith(
      'run-1',
      'pause',
      expect.objectContaining({ reason: 'Paused from Lilly Mission Mode.' }),
    );
    expect(app.updateMissionFromPayload).toHaveBeenCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ state: 'waiting_for_approval' }) }),
      expect.objectContaining({ persistRemote: true }),
    );
  });

  test('does not attach an immutable terminal AgentRun to later request metadata', () => {
    const context = loadMissionContext();
    const app = Object.create(context.ChatApp.prototype);
    app.missionState = app.createMissionState({
      active: true,
      missionId: 'run-complete',
      run: { id: 'run-complete', state: 'completed' },
    });

    const metadata = app.getMissionRequestMetadata();
    const options = app.buildMissionSendOptions({
      metadata: { agentRunId: 'run-complete', agent_run_id: 'run-complete' },
    });

    expect(metadata).toEqual(expect.objectContaining({
      missionId: 'run-complete',
      missionContinuationRequired: 'fork-or-new-mission',
    }));
    expect(metadata).not.toHaveProperty('agentRunId');
    expect(options.metadata).not.toHaveProperty('agentRunId');
    expect(options.metadata).not.toHaveProperty('agent_run_id');
  });

  test('carries server-issued approval receipts into the next active mission request', () => {
    const context = loadMissionContext();
    const app = Object.create(context.ChatApp.prototype);
    const signedReceipt = {
      version: 'ApprovalReceipt/v1',
      id: 'approval-1',
      status: 'approved',
      authority: { version: 'ApprovalAuthority/v1', signature: 'signed' },
    };
    app.missionState = app.createMissionState({
      active: true,
      run: {
        id: 'run-active',
        state: 'executing',
        approvals: [signedReceipt, { id: 'pending', status: 'pending' }],
      },
    });

    expect(app.getMissionRequestMetadata()).toEqual(expect.objectContaining({
      agentRunId: 'run-active',
      approvalReceipts: [signedReceipt],
    }));
  });

  test('preserves a follow-up draft until the terminal mission is forked or replaced', async () => {
    const context = loadMissionContext();
    const app = Object.create(context.ChatApp.prototype);
    app.messageInput = { value: 'Continue this completed mission', focus: jest.fn() };
    app.missionState = app.createMissionState({
      active: true,
      run: { id: 'run-complete', state: 'completed' },
    });
    app.tryHandleToolCommand = jest.fn();
    app.sendPreparedMessage = jest.fn();

    await app.sendMessage();

    expect(app.messageInput.value).toBe('Continue this completed mission');
    expect(app.messageInput.focus).toHaveBeenCalled();
    expect(app.tryHandleToolCommand).not.toHaveBeenCalled();
    expect(app.sendPreparedMessage).not.toHaveBeenCalled();
    expect(context.uiHelpers.showToast).toHaveBeenCalledWith(
      expect.stringContaining('Fork it or start a new chat'),
      'warning',
    );
  });

  test('stages artifact iteration/deploy with mission lineage and no success claim', () => {
    const context = loadMissionContext();
    context.window.artifactManager = { prepareArtifactUpdate: jest.fn() };
    const app = Object.create(context.ChatApp.prototype);
    app.missionState = app.createMissionState({ active: true, missionId: 'run-1', run: { id: 'run-1' } });
    app.setInput = jest.fn();
    const control = {
      dataset: {
        artifactLineageAction: 'deploy',
        artifactId: 'artifact-2',
        parentArtifactId: 'artifact-1',
        missionId: 'run-1',
        artifactRevision: '3',
      },
    };

    expect(app.handleArtifactLineageAction({ preventDefault: jest.fn() }, control)).toBe(true);
    const options = app.buildMissionSendOptions({});

    expect(context.window.artifactManager.prepareArtifactUpdate).toHaveBeenCalledWith('artifact-2');
    expect(app.setInput).toHaveBeenCalledWith(expect.stringContaining('Deploy this artifact'));
    expect(options.artifactIds).toEqual(['artifact-2']);
    expect(options.metadata).toEqual(expect.objectContaining({
      missionId: 'run-1',
      parentArtifactId: 'artifact-1',
      revision: '3',
      requestedArtifactAction: 'deploy',
    }));
    expect(context.uiHelpers.showToast).toHaveBeenCalledWith(expect.stringContaining('staged'), 'info');
  });
});
