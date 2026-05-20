const { isDefaultBusinessAgentProfile } = require('./business-agent');
const { buildSoulInstructions } = require('./agent-soul');
const { buildAssetManagerInstructions } = require('./asset-manager');
const { buildAgentNotesInstructions } = require('./agent-notes');
const { buildUserProfileInstructions } = require('./agent-user-profile');
const { buildProjectMemoryInstructions } = require('./project-memory');
const { buildSessionCompactionInstructions } = require('./session-compaction');
const settingsController = require('./routes/admin/settings.controller');
const { getSessionControlState } = require('./runtime-control-state');
const { isSessionIsolationEnabled } = require('./session-scope');

function formatRemoteTarget(target = {}) {
    if (!target?.host) {
        return '';
    }

    const username = target.username ? `${target.username}@` : '';
    const port = target.port && Number(target.port) !== 22 ? `:${target.port}` : '';
    return `${username}${target.host}${port}`;
}

function oneLinePreview(value = '', limit = 180) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) {
        return '';
    }

    return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function buildRemoteWorkingStateInstructions(session = null) {
    const controlState = getSessionControlState(session);
    const remote = controlState.remoteWorkingState;
    if (!remote || typeof remote !== 'object') {
        return '';
    }

    const lines = [
        '[Remote working state]',
        'Reuse these verified remote facts for follow-up SSH or server work.',
    ];

    const targetLabel = formatRemoteTarget(remote.target || controlState.lastSshTarget || {});
    if (targetLabel) {
        lines.push(`- Target: ${targetLabel}`);
    }

    if (remote.lastCommand) {
        lines.push(`- Last command: ${oneLinePreview(remote.lastCommand, 200)}`);
    }

    if (typeof remote.lastCommandSucceeded === 'boolean') {
        const status = remote.lastCommandSucceeded ? 'succeeded' : 'failed';
        const details = remote.lastError ? ` (${oneLinePreview(remote.lastError, 140)})` : '';
        lines.push(`- Last result: ${status}${details}`);
    }

    if (remote.detectedArchitecture) {
        lines.push(`- Architecture: ${remote.detectedArchitecture}`);
    }

    if (remote.detectedOs) {
        lines.push(`- OS: ${oneLinePreview(remote.detectedOs, 120)}`);
    }

    if (remote.lastStdoutPreview) {
        lines.push(`- Recent stdout: ${oneLinePreview(remote.lastStdoutPreview, 180)}`);
    } else if (remote.lastStderrPreview) {
        lines.push(`- Recent stderr: ${oneLinePreview(remote.lastStderrPreview, 180)}`);
    }

    return lines.join('\n');
}

function buildHumanCentricResponseInstructions({
    clientSurface = '',
    taskType = '',
} = {}) {
    const surface = String(clientSurface || '').trim().toLowerCase();
    const mode = String(taskType || '').trim().toLowerCase();
    const isChatSurface = ['chat', 'web-chat', 'cli', 'web-cli'].includes(surface)
        || (!surface && (!mode || mode === 'chat'))
        || mode === 'chat';
    if (!isChatSurface) {
        return '';
    }

    const surfaceNote = surface === 'cli' || surface === 'web-cli'
        ? 'The answer will be rendered in a terminal Markdown view, so avoid very wide tables and keep lists compact.'
        : 'The answer will be rendered in a web chat Markdown view, so use semantic Markdown that parses cleanly.';

    return [
        '[Human-facing response format]',
        'Write for a person reading conversationally, not for a raw transcript parser.',
        surfaceNote,
        '- Start with the direct answer, recommendation, or current result in 1-3 short sentences.',
        '- Use short Markdown sections only when the answer has multiple parts; prefer descriptive headings over a wall of prose.',
        '- Use bullets or numbered steps for actions, tradeoffs, findings, and next steps. Keep each bullet to one idea.',
        '- Use fenced code blocks with a language label for code, commands, JSON, Mermaid, logs, or config. Do not hide large code inside inline text.',
        '- Use compact tables only when comparison is clearer than bullets.',
        '- Keep paragraphs short enough to scan in chat. Add blank lines between distinct ideas.',
        '- Use presentation cues sparingly when they improve comprehension: `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!SUCCESS]`, or `> [!DANGER]` for callouts; `==short phrase==` for a small highlight; and `::info[text]`, `::success[text]`, `::warning[text]`, `::danger[text]`, `::accent[text]`, or `::muted[text]` for subtle inline tone.',
        '- Do not use presentation cues as decoration. Use them only for status, risk, result, warning, next action, or a key phrase the user should notice.',
        '- End with a concrete next step or a necessary clarifying question only when it helps the user move forward.',
        '- If the user asks for exact text, raw code, JSON-only output, or another strict format, follow that requested format instead of these presentation defaults.',
    ].join('\n');
}

function buildSessionInstructions(session, baseInstructions = '') {
    const parts = [];
    const sessionIsolation = isSessionIsolationEnabled(session?.metadata || {}, session);

    if (baseInstructions) {
        parts.push(baseInstructions.trim());
    }

    const soulInstructions = buildSoulInstructions(settingsController.settings?.personality || {});
    if (soulInstructions) {
        parts.push(soulInstructions);
    }

    if (sessionIsolation) {
        parts.push([
            '[Session isolation]',
            'Treat this chat as isolated from other chats by default.',
            'Use only this session transcript, this session memory, and this session artifacts unless the user explicitly asks to reuse material from another session.',
            'Do not rely on durable carryover notes or cross-session asset lookup in this session.',
        ].join('\n'));
    } else {
        const userProfileInstructions = buildUserProfileInstructions(settingsController.settings?.userProfile || {});
        if (userProfileInstructions) {
            parts.push(userProfileInstructions);
        }

        const agentNotesInstructions = buildAgentNotesInstructions(settingsController.settings?.agentNotes || {});
        if (agentNotesInstructions) {
            parts.push(agentNotesInstructions);
        }

        const assetManagerInstructions = buildAssetManagerInstructions();
        if (assetManagerInstructions) {
            parts.push(assetManagerInstructions);
        }
    }

    const agent = session?.metadata?.agent;
    if (agent?.instructions && !isDefaultBusinessAgentProfile(agent)) {
        parts.push(`Saved agent profile: ${agent.instructions.trim()}`);
    }

    if (agent?.name && !isDefaultBusinessAgentProfile(agent)) {
        parts.push(`Agent name: ${agent.name}`);
    }

    if (!isDefaultBusinessAgentProfile(agent) && Array.isArray(agent?.tools) && agent.tools.length > 0) {
        parts.push(`Preferred workflow tools: ${agent.tools.join(', ')}. You may also use any runtime-provided tools available in this session when they are relevant.`);
    }

    const projectMemory = buildProjectMemoryInstructions(session);
    if (projectMemory) {
        parts.push(projectMemory);
    }

    const sessionCompaction = buildSessionCompactionInstructions(session);
    if (sessionCompaction) {
        parts.push(sessionCompaction);
    }

    const remoteWorkingState = buildRemoteWorkingStateInstructions(session);
    if (remoteWorkingState) {
        parts.push(remoteWorkingState);
    }

    return parts.filter(Boolean).join('\n\n');
}

module.exports = {
    buildHumanCentricResponseInstructions,
    buildSessionInstructions,
};
