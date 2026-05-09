const MAX_EXCERPT_CHARS = 2400;
const MAX_TARGET_CHARS = 90;
const MAX_TARGETS = 12;
let skillStore = null;

function getSkillStore() {
    if (!skillStore) {
        ({ skillStore } = require('./skills/skill-store'));
    }
    return skillStore;
}

function normalizeText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value = '', limit = MAX_EXCERPT_CHARS) {
    const normalized = String(value || '').trim();
    if (!normalized || normalized.length <= limit) {
        return normalized;
    }

    return `${normalized.slice(0, Math.max(0, limit - 24)).trim()}...[truncated]`;
}

function normalizeList(value = []) {
    if (!Array.isArray(value)) {
        return [];
    }

    const seen = new Set();
    return value
        .map((entry) => normalizeText(
            typeof entry === 'string'
                ? entry
                : (entry?.label || entry?.title || entry?.text || entry?.name || ''),
        ))
        .filter(Boolean)
        .map((entry) => truncateText(entry, MAX_TARGET_CHARS))
        .filter((entry) => {
            const key = entry.toLowerCase();
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        })
        .slice(0, MAX_TARGETS);
}

function normalizeCanvasContext(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const selectedText = truncateText(value.selectedText || value.selection || '', 1200);
    const contentExcerpt = truncateText(value.contentExcerpt || value.excerpt || value.currentContent || '', MAX_EXCERPT_CHARS);
    const normalized = {
        type: normalizeText(value.type || value.canvasType || ''),
        title: normalizeText(value.title || ''),
        language: normalizeText(value.language || ''),
        selectedText,
        selectionLabel: normalizeText(value.selectionLabel || ''),
        cursorLine: Number.isFinite(Number(value.cursorLine)) ? Number(value.cursorLine) : null,
        contentExcerpt,
        contentLength: Number.isFinite(Number(value.contentLength)) ? Number(value.contentLength) : null,
    };

    return Object.fromEntries(Object.entries(normalized).filter(([, entry]) => (
        entry !== null && entry !== ''
    )));
}

function extractTargetsFromText(text = '') {
    const source = String(text || '');
    const targets = [];
    const headingPattern = /^(#{1,6}\s+.+)$/gm;
    let match;
    while ((match = headingPattern.exec(source))) {
        targets.push(match[1].replace(/^#{1,6}\s+/, ''));
    }

    const quotedPattern = /["'`](.{3,90}?)["'`]/g;
    while ((match = quotedPattern.exec(source))) {
        targets.push(match[1]);
    }

    const nounPattern = /\b(?:the|this|that|current|last|second|first|third)\s+([a-z][a-z0-9 -]{2,50}?(?:section|paragraph|line|title|heading|button|card|table|list|canvas|page|document|answer|response|block))\b/gi;
    while ((match = nounPattern.exec(source))) {
        targets.push(match[0]);
    }

    return normalizeList(targets);
}

function mergeRecentTargets(...targetLists) {
    return normalizeList(targetLists.flat());
}

function normalizeNaturalContext(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    const activeCanvas = normalizeCanvasContext(value.activeCanvas || value.canvas || {});
    return {
        version: 1,
        activeSurface: normalizeText(value.activeSurface || value.clientSurface || ''),
        activeMode: normalizeText(value.activeMode || value.taskType || value.mode || ''),
        activeArtifactId: normalizeText(value.activeArtifactId || ''),
        activeArtifactTitle: normalizeText(value.activeArtifactTitle || ''),
        activeCanvas,
        recentTargets: normalizeList(value.recentTargets || value.targets || []),
        lastUserRequest: truncateText(value.lastUserRequest || '', 600),
        lastAssistantSummary: truncateText(value.lastAssistantSummary || '', 600),
        userPreferences: value.userPreferences && typeof value.userPreferences === 'object' && !Array.isArray(value.userPreferences)
            ? value.userPreferences
            : {},
        updatedAt: normalizeText(value.updatedAt || ''),
    };
}

function buildNaturalContext({
    session = null,
    metadata = {},
    clientSurface = '',
    taskType = '',
    userText = '',
} = {}) {
    const stored = normalizeNaturalContext(session?.metadata?.naturalContext || {});
    const clientContext = normalizeNaturalContext(
        metadata?.naturalContext
        || metadata?.workingContext
        || metadata?.interactionContext
        || {},
    );
    const activeCanvas = normalizeCanvasContext(
        clientContext.activeCanvas
        || stored.activeCanvas
        || metadata?.activeCanvas
        || {},
    );
    const activeSurface = normalizeText(clientSurface || clientContext.activeSurface || stored.activeSurface);
    const activeMode = normalizeText(taskType || clientContext.activeMode || stored.activeMode);
    const recentTargets = mergeRecentTargets(
        extractTargetsFromText(userText),
        clientContext.recentTargets,
        stored.recentTargets,
    );

    return {
        ...stored,
        ...clientContext,
        activeSurface,
        activeMode,
        activeCanvas,
        recentTargets,
        lastUserRequest: truncateText(userText || stored.lastUserRequest || '', 600),
        updatedAt: new Date().toISOString(),
    };
}

function buildNaturalContextInstructions(context = {}) {
    const normalized = normalizeNaturalContext(context);
    if (!normalized.activeSurface && !normalized.activeCanvas && normalized.recentTargets.length === 0) {
        return '';
    }

    const lines = [
        '<natural_context>',
        'The user may refer to prior work naturally with phrases like "that", "this part", "the second section", "same thing", "make it tighter", or "fix the current one". Resolve those references against this working context before asking them to restate exact wording.',
        'Act on the most likely target when the risk is low. State the assumption briefly only when it helps clarity. Ask one concise question only when two or more plausible targets would lead to materially different or destructive changes.',
        'For canvas/document/code edits, preserve unrelated content. Prefer exact range, selection, heading, or named-section edits over full rewrites when the user asks for a small change.',
        `Active surface: ${normalized.activeSurface || '(unknown)'}`,
        `Active mode: ${normalized.activeMode || '(unknown)'}`,
    ];

    if (normalized.activeCanvas) {
        lines.push(`Active canvas: ${JSON.stringify(normalized.activeCanvas)}`);
    }
    if (normalized.activeArtifactId || normalized.activeArtifactTitle) {
        lines.push(`Active artifact: ${JSON.stringify({
            id: normalized.activeArtifactId || null,
            title: normalized.activeArtifactTitle || null,
        })}`);
    }
    if (normalized.recentTargets.length > 0) {
        lines.push(`Recent referents: ${JSON.stringify(normalized.recentTargets)}`);
    }
    if (normalized.lastAssistantSummary) {
        lines.push(`Last assistant summary: ${normalized.lastAssistantSummary}`);
    }
    if (Object.keys(normalized.userPreferences || {}).length > 0) {
        lines.push(`User preferences: ${JSON.stringify(normalized.userPreferences)}`);
    }

    lines.push('</natural_context>');
    return lines.join('\n');
}

function buildSkillsTreeInstructions({ clientSurface = '', taskType = '' } = {}) {
    const surface = normalizeText(clientSurface || taskType || '');
    return [
        '<skills_tree>',
        `Current surface: ${surface || '(unknown)'}`,
        'Pass: lets create context by interaction with the user to avoid slop.',
        'Use this compact state machine before choosing skills or tools. Decide the current state internally, then load only the context, skill, or tool guidance needed for that state:',
        '- read_context: read the user turn plus available session, artifact, canvas, and recent-message context.',
        '- classify_direction: identify whether the turn is chat, clarification, edit, creation, research/tool work, document production, or export.',
        '- context_gap_check: identify the minimum context needed and whether any missing detail is a true blocker.',
        '- ask_or_assume: ask one or two questions only for blockers; otherwise apply safe defaults and continue.',
        '- route_skill_tool: choose the smallest skill/tool path that can satisfy the state without overloading the prompt.',
        '- produce_or_act: answer, edit, create, research, or export in the selected path.',
        '- verify_handoff: check the result against the user goal and include assumptions or next handoff details only when useful.',
        'Skills progression is not replaced by the state machine. The state machine decides when to advance; the skills tree decides what capability path to use. Carry the selected skill path forward until the user changes direction, the state reaches verify_handoff, or a blocker requires clarification.',
        'For mixed requests, progress through skill paths in order: gather only the missing context, materialize required assets first, then build the artifact, then verify or hand off. Example: webpage with generated images and facts -> context_by_interaction -> tool_or_research/image generation -> canvas_generate or artifact_export -> verify_handoff.',
        'Default to a quick, useful response with a warm, capable personality. Avoid turning normal chat into an intake form.',
        'Ask at most one or two concise follow-up questions when required details would materially change the output, risk destructive edits, or determine audience, format, source material, deadline, or success criteria. If reasonable defaults are safe, state or silently apply them and continue.',
        'For creation requests, gather enough context by interaction to make the artifact feel intentional: purpose, audience, format, constraints, source material, and done criteria. Do not ask for information already present in the session or artifact context.',
        'Route the turn through the smallest useful skill path before answering:',
        '- context_by_interaction: use first for new directions, underspecified creation requests, document requests, or any turn where a brief context check prevents generic output.',
        '- natural_reference_resolver: use first when the request says this, that, current, last, same, second, selected, or otherwise depends on recent context.',
        '- chat_response: answer directly when the user is asking, discussing, deciding, or refining an idea without requesting an artifact mutation.',
        '- canvas_exact_edit: use when the user asks to change selected/current/named canvas text, a section, line, paragraph, heading, or small part of code/docs/diagrams.',
        '- canvas_generate: use when the user asks to create or substantially regenerate code, a document, diagram, or frontend artifact.',
        '- web_cli_command: use on the web-cli surface for command-like tasks, session actions, model/tool inspection, remote build actions, or terminal-style workflows.',
        '- tool_or_research: use when verified external/current information, saved artifacts, remote operations, or runtime tools are needed.',
        '- artifact_export: use when the user asks to save, download, package, export, copy, or convert output.',
        '- clarification: use only when the resolver cannot identify a target and the likely choices would cause materially different results.',
        'Prefer continuing from the active skill path and current working context instead of making the user repeat exact phrases.',
        '</skills_tree>',
    ].join('\n');
}

function normalizeToolIds(value = []) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => normalizeText(typeof entry === 'string' ? entry : (entry?.id || entry?.tool || entry?.toolId || '')))
        .filter(Boolean)
        .slice(0, 20);
}

function buildRegisteredSkillsInstructions({
    userText = '',
    metadata = {},
    toolIds = [],
} = {}) {
    return buildRegisteredSkillsContext({ userText, metadata, toolIds }).block;
}

function buildRegisteredSkillsContext({
    userText = '',
    metadata = {},
    toolIds = [],
} = {}) {
    try {
        const selectedSkillIds = normalizeList(
            metadata?.skillIds
            || metadata?.skills
            || metadata?.selectedSkills
            || metadata?.registeredSkills
            || [],
        );
        const metadataToolIds = normalizeToolIds(
            metadata?.toolIds
            || metadata?.tools
            || metadata?.plannedTools
            || [],
        );

        const naturalContext = normalizeNaturalContext(
            metadata?.naturalContext
            || metadata?.workingContext
            || metadata?.interactionContext
            || {},
        );
        return getSkillStore().buildContext({
            text: userText,
            toolIds: [...metadataToolIds, ...normalizeToolIds(toolIds)],
            selectedSkillIds,
            surface: metadata?.clientSurface || metadata?.client_surface || naturalContext.activeSurface || '',
            taskType: metadata?.taskType || metadata?.task_type || naturalContext.activeMode || '',
            capabilityNeeds: metadata?.capabilityNeeds || metadata?.capabilities || [],
        });
    } catch (error) {
        console.warn('[NaturalContext] Failed to build registered skill instructions:', error.message);
        return { block: '', selectedSkills: [] };
    }
}

function buildNaturalContextUpdate({
    previous = {},
    metadata = {},
    clientSurface = '',
    taskType = '',
    userText = '',
    assistantText = '',
    artifacts = [],
} = {}) {
    const current = buildNaturalContext({
        session: { metadata: { naturalContext: previous } },
        metadata,
        clientSurface,
        taskType,
        userText,
    });
    const latestArtifact = Array.isArray(artifacts) && artifacts.length > 0
        ? artifacts[artifacts.length - 1]
        : null;

    return normalizeNaturalContext({
        ...current,
        activeArtifactId: latestArtifact?.id || current.activeArtifactId || '',
        activeArtifactTitle: latestArtifact?.title || latestArtifact?.filename || current.activeArtifactTitle || '',
        recentTargets: mergeRecentTargets(
            extractTargetsFromText(userText),
            extractTargetsFromText(assistantText),
            current.recentTargets,
        ),
        lastUserRequest: userText,
        lastAssistantSummary: assistantText,
        updatedAt: new Date().toISOString(),
    });
}

module.exports = {
    buildNaturalContext,
    buildNaturalContextInstructions,
    buildRegisteredSkillsContext,
    buildSkillsTreeInstructions,
    buildRegisteredSkillsInstructions,
    buildNaturalContextUpdate,
    normalizeNaturalContext,
    _private: {
        extractTargetsFromText,
        normalizeCanvasContext,
    },
};
