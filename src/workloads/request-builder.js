'use strict';

const { isDashboardRequest } = require('../dashboard-template-catalog');
const { extractStructuredExecution } = require('./execution-extractor');
const {
    deriveWorkloadTitle,
    hasImmediateOrNoDeferCue,
    hasWorkloadIntent,
    inferWorkloadPolicy,
    parseWorkloadScenario,
    stripBrutalBuilderDirectiveText,
} = require('./natural-language');

function sanitizeText(value = '') {
    return String(value || '').trim();
}

function normalizeMessageText(value) {
    if (typeof value === 'string') {
        return value.trim();
    }

    if (Array.isArray(value)) {
        return value
            .map((entry) => {
                if (typeof entry === 'string') {
                    return entry.trim();
                }

                if (entry && typeof entry === 'object') {
                    return sanitizeText(entry.text || entry.content || '');
                }

                return '';
            })
            .filter(Boolean)
            .join(' ')
            .trim();
    }

    if (value && typeof value === 'object') {
        return sanitizeText(value.text || value.content || '');
    }

    return '';
}

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function hasRemoteExecutionShape(params = {}) {
    const combinedText = [
        params.action,
        params.tool,
        params.command,
        params.title,
        params.prompt,
        params.request,
        params.scenario,
        params.description,
        params.schedule,
        params.metadata?.scenarioRequest,
    ]
        .map((value) => sanitizeText(value))
        .filter(Boolean)
        .join('\n');
    const toolId = sanitizeText(params.tool || params.execution?.tool || params.execution?.name || params.action).toLowerCase();

    return Boolean(
        sanitizeText(params.host || params.execution?.host || params.execution?.params?.host)
        || sanitizeText(params.username || params.execution?.username || params.execution?.params?.username)
        || Number(params.port || params.execution?.port || params.execution?.params?.port) > 0
        || toolId === 'remote-command'
        || toolId === 'ssh-execute'
        || /\b(remote|server|ssh|host|machine)\b/i.test(combinedText),
    );
}

function buildLooseScenarioSource(params = {}) {
    const prompt = sanitizeText(params.prompt);
    const title = sanitizeText(params.title);
    const command = sanitizeText(
        params.command
        || params.execution?.command
        || params.execution?.params?.command,
    );
    const schedule = sanitizeText(
        params.schedule
        || params.when
        || params.recurrence
        || params.repeat
        || params.timing,
    );
    const baseTask = prompt
        || (command
            ? `Run \`${command}\`${hasRemoteExecutionShape(params) ? ' on the server' : ''}`
            : title);

    if (baseTask && schedule) {
        return `${baseTask} ${schedule}`.trim();
    }

    if (prompt) {
        return title && title.toLowerCase() !== prompt.toLowerCase()
            ? `${title}. ${prompt}`.trim()
            : prompt;
    }

    if (command) {
        return `Run \`${command}\`${hasRemoteExecutionShape(params) ? ' on the server' : ''}`.trim();
    }

    return title;
}

function extractWorkloadScenarioSource(params = {}) {
    const direct = [
        params.request,
        params.scenario,
        params.description,
        params.metadata?.scenarioRequest,
        params.metadata?.originalRequest,
    ]
        .map((value) => sanitizeText(value))
        .find(Boolean);

    if (direct) {
        return direct;
    }

    return buildLooseScenarioSource(params);
}

function collectRecentUserMessages(recentMessages = [], limit = 6) {
    if (!Array.isArray(recentMessages) || recentMessages.length === 0) {
        return [];
    }

    return recentMessages
        .filter((message) => message?.role === 'user')
        .map((message) => normalizeMessageText(message?.content))
        .filter(Boolean)
        .slice(-Math.max(0, limit));
}

function collectRecentContextMessages(recentMessages = [], limit = 8, charLimit = 4000) {
    if (!Array.isArray(recentMessages) || recentMessages.length === 0) {
        return [];
    }

    const collected = [];
    let remainingChars = Math.max(0, Number(charLimit) || 0);
    const sourceMessages = recentMessages
        .filter((message) => ['user', 'assistant', 'system'].includes(String(message?.role || '').trim()))
        .slice(-Math.max(0, limit));

    for (const message of sourceMessages) {
        if (remainingChars <= 0) {
            break;
        }

        const role = String(message?.role || '').trim();
        const content = normalizeMessageText(message?.content);
        if (!role || !content) {
            continue;
        }

        const truncated = content.length > remainingChars
            ? `${content.slice(0, Math.max(0, remainingChars - 3)).trim()}...`
            : content;
        if (!truncated) {
            continue;
        }

        collected.push({
            role,
            content: truncated,
        });
        remainingChars -= truncated.length;
    }

    return collected;
}

function buildWorkloadCreationContext({
    params = {},
    options = {},
    scenarioSource = '',
    prompt = '',
} = {}) {
    const recentMessages = collectRecentContextMessages(options.recentMessages);
    const originalRequest = sanitizeText(
        params.metadata?.originalRequest
        || params.metadata?.scenarioRequest
        || params.request
        || params.scenario
        || params.description
        || scenarioSource,
    );
    const resolvedRequest = sanitizeText(scenarioSource || prompt);

    if (!originalRequest && !resolvedRequest && recentMessages.length === 0) {
        return null;
    }

    return {
        ...(originalRequest ? { originalRequest } : {}),
        ...(resolvedRequest && resolvedRequest.toLowerCase() !== originalRequest.toLowerCase()
            ? { resolvedRequest }
            : {}),
        ...(recentMessages.length > 0 ? { recentMessages } : {}),
        instruction: 'Use this recent chat context to resolve references like it, that, the previous plan, or the described job before executing the workload. If the objective is still underspecified, first define the concrete task from the context and proceed; ask for clarification only when the intent cannot be recovered.',
    };
}

function buildScenarioSourceCandidates(baseSource = '', recentMessages = []) {
    const directSource = sanitizeText(baseSource);
    const candidates = [];
    const seen = new Set();
    const addCandidate = (value) => {
        const normalized = sanitizeText(value);
        if (!normalized) {
            return;
        }
        const key = normalized.toLowerCase();
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        candidates.push(normalized);
    };

    addCandidate(directSource);

    const recentUserMessages = collectRecentUserMessages(recentMessages);
    if (recentUserMessages.length === 0 || !isDeferredContextFollowupPrompt(directSource)) {
        return candidates;
    }

    const stripReferentialScheduleWrapper = (value = '') => sanitizeText(value)
        .replace(/^(?:can|could|would)\s+you\s+/i, '')
        .replace(/^(?:please\s+)?(?:run|do|schedule|set up|make|create)\s+(?:it|that|this|them|those)\s+/i, '')
        .replace(/^(?:please\s+)?(?:run|do)\s+the commands(?:\s+you\s+listed(?:\s+there)?)?\s+/i, '')
        .trim();
    let merged = directSource;
    for (let index = recentUserMessages.length - 1; index >= 0; index -= 1) {
        const prior = recentUserMessages[index];
        if (!prior || prior.toLowerCase() === directSource.toLowerCase()) {
            continue;
        }

        merged = merged ? `${prior}. ${merged}` : prior;
        addCandidate(merged);
        if (directSource) {
            const directFragment = stripReferentialScheduleWrapper(directSource);
            const priorFragment = stripReferentialScheduleWrapper(prior);
            if (directFragment && directFragment.toLowerCase() !== directSource.toLowerCase()) {
                addCandidate(`${prior} ${directFragment}`);
            }
            if (priorFragment && priorFragment.toLowerCase() !== prior.toLowerCase()) {
                addCandidate(`${priorFragment} ${directSource}`);
                addCandidate(`${directSource} ${priorFragment}`);
            }
        }
    }

    return candidates;
}

function isDeferredContextFollowupPrompt(prompt = '') {
    const normalized = sanitizeText(prompt).toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /^(?:in|after|at|tomorrow|later today|once|one[- ]time|daily|hourly|every)\b/,
        /\bfrom now\b/,
        /^(?:do|run|schedule|set up|queue|create|make|get|fetch|check)\s+(?:it|that|this|them|those)\b/,
        /\b(the commands|what you listed|the one you listed|the ones you listed|what i asked|same task|same thing|that one)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function isReferentialWorkloadPrompt(prompt = '') {
    const normalized = sanitizeText(prompt).toLowerCase();
    if (!normalized) {
        return true;
    }

    return [
        /^(?:it|that|this|them|those)\b/,
        /^(?:run|do|schedule|set up|make|create)\s+(?:it|that|this|them|those)\b/,
        /\b(?:the commands|what you listed|what i asked|same thing|same task)\b/,
        /^(?:do|run)\s+the commands\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasExplicitArtifactGenerationIntent(text = '') {
    const normalized = sanitizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(export|download|save|convert|turn\b[\s\S]{0,20}\binto|turn\b[\s\S]{0,20}\bas|format\b[\s\S]{0,20}\bas)\b/i.test(normalized)
        || /\b(create|make|generate|build|produce|render|prepare|draft)\b[\s\S]{0,60}\b(file|artifact|document|page|report|brief|pdf|html|docx)\b/i.test(normalized)
        || /\b(as|into|in)\s+(?:an?\s+)?(?:pdf|html|docx)\b/i.test(normalized)
        || /\b(pdf|html|docx)\s+(?:file|document|artifact|export)\b/i.test(normalized);
}

function inferDeferredArtifactOutputFormat(prompt = '') {
    const normalized = sanitizeText(prompt).toLowerCase();
    const hasArtifactIntent = hasExplicitArtifactGenerationIntent(normalized);
    const hasBuildIntent = /\b(create|make|generate|build|produce|render|prepare|draft)\b/.test(normalized);
    if (!normalized || (!hasArtifactIntent && !hasBuildIntent)) {
        return null;
    }

    if (/\bpdf\b/.test(normalized)) {
        return 'pdf';
    }

    if (/\b(docx|word document)\b/.test(normalized)) {
        return 'html';
    }

    if (/\bhtml\b/.test(normalized)
        || (
            /\b(website|web page|webpage|landing page|homepage|microsite|marketing site|frontend demo|front-end demo|site mockup|site prototype)\b/.test(normalized)
            || isDashboardRequest(normalized)
        )) {
        return 'html';
    }

    return null;
}

function buildDeferredArtifactContentPrompt(prompt = '', outputFormat = '') {
    const trimmedPrompt = sanitizeText(prompt);
    if (!trimmedPrompt || !outputFormat) {
        return trimmedPrompt;
    }

    const formatLabel = {
        pdf: 'PDF',
        docx: 'HTML',
        html: 'HTML',
    }[outputFormat] || outputFormat.toUpperCase();
    const formatToken = outputFormat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rewrittenPrompt = trimmedPrompt
        .replace(
            new RegExp(`\\b(?:make|create|generate|build|produce|prepare|render)\\s+(?:a|an)\\s+${formatToken}\\s+(?:document|file|artifact)\\b`, 'i'),
            'write the document',
        )
        .replace(
            new RegExp(`\\b(?:make|create|generate|build|produce|prepare|render)\\s+(?:a|an)\\s+${formatToken}\\b`, 'i'),
            'write the document',
        )
        .replace(
            new RegExp(`\\b(?:as|into|in)\\s+(?:an?\\s+)?${formatToken}\\s+(?:document|file|artifact)?\\b`, 'i'),
            '',
        )
        .replace(/\s{2,}/g, ' ')
        .trim();
    const basePrompt = rewrittenPrompt || trimmedPrompt;

    return `${basePrompt}\n\nImportant: This scheduled run is split into content generation followed by ${formatLabel} export. In this step, produce only the final document/report content that should go into the ${formatLabel}. Do not say that you created, will create, or are attaching the ${formatLabel}. Do not narrate your process, research steps, or tool usage unless that material belongs inside the actual document itself.`;
}

function buildDeferredArtifactStages(outputFormat = '') {
    if (!outputFormat) {
        return undefined;
    }

    return [{
        when: 'on_success',
        delayMs: 0,
        outputFormat,
        metadata: {
            generatedFromDeferredArtifactRequest: true,
        },
    }];
}

function resolveDocxFallbackFormat(prompt = '') {
    const normalized = sanitizeText(prompt).toLowerCase();
    if (/\b(html|website|web page|webpage|landing page|homepage|site|document|docx|word document)\b/.test(normalized)) {
        return 'html';
    }

    return 'html';
}

function resolveBrutalBuilderArtifactPlan(prompt = '', requestedOutputFormat = '') {
    const requested = sanitizeText(requestedOutputFormat).toLowerCase();
    if (!requested) {
        return {
            requestedOutputFormat: '',
            effectiveOutputFormat: '',
            warnings: [],
        };
    }

    if (requested !== 'docx') {
        return {
            requestedOutputFormat: requested,
            effectiveOutputFormat: requested,
            warnings: [],
        };
    }

    const fallbackFormat = resolveDocxFallbackFormat(prompt);
    return {
        requestedOutputFormat: requested,
        effectiveOutputFormat: fallbackFormat,
        warnings: [
            `DOCX output was requested, but brutal builder downgraded it to ${fallbackFormat.toUpperCase()} because DOCX downloads are unstable in this workflow.`,
        ],
    };
}

function buildBrutalBuilderInitialPrompt(prompt = '', plan = {}) {
    const basePrompt = stripBrutalBuilderDirectiveText(prompt) || sanitizeText(prompt);
    const totalRuns = Math.max(1, Number(plan.totalRuns || 1));

    return [
        basePrompt,
        '',
        '[Brutal builder pass instructions]',
        `This is pass 1 of ${totalRuns}.`,
        'Produce a complete first version of the requested deliverable.',
        'If the user asked for multiple documents, output the full document set for this pass.',
        'Focus on strong structure, hierarchy, clarity, and design quality from the start.',
        'Return the deliverable itself, not commentary about what you plan to improve later.',
    ].filter(Boolean).join('\n');
}

function buildBrutalBuilderRevisionPrompt(plan = {}, passNumber = 2) {
    const totalRuns = Math.max(1, Number(plan.totalRuns || passNumber));

    return [
        '[Brutal builder pass instructions]',
        `This is pass ${passNumber} of ${totalRuns}.`,
        'Review the previous pass and produce a full revised replacement.',
        'Improve structure, design quality, hierarchy, readability, polish, and usefulness.',
        'Preserve the original request and keep the output concrete.',
        'If the user asked for multiple documents, return the full updated document set again.',
        'Return only the revised deliverable, not notes or a diff.',
    ].join('\n');
}

function buildBrutalBuilderStages(plan = {}, outputFormat = '') {
    const totalRuns = Math.max(1, Number(plan.totalRuns || 1));
    const intervalMs = Math.max(0, Number(plan.intervalMs || 0));
    if (totalRuns <= 1) {
        return [];
    }

    return Array.from({ length: totalRuns - 1 }, (_entry, index) => ({
        when: 'on_success',
        delayMs: intervalMs,
        prompt: buildBrutalBuilderRevisionPrompt(plan, index + 2),
        ...(outputFormat ? { outputFormat } : {}),
        metadata: {
            brutalBuilder: true,
            brutalBuilderPass: index + 2,
            brutalBuilderTotalRuns: totalRuns,
        },
    }));
}

function scoreCanonicalCandidate(candidate = {}) {
    const payload = candidate?.payload || null;
    if (!payload?.prompt || !payload?.title || !payload?.trigger) {
        return Number.NEGATIVE_INFINITY;
    }

    let score = 0;
    if (payload.trigger.type === 'cron' || payload.trigger.type === 'once') {
        score += 100;
    }
    if (payload.execution) {
        score += 20;
    }
    if (!isReferentialWorkloadPrompt(payload.prompt)) {
        score += 15;
    }
    score += Math.min(payload.prompt.length, 120) / 10;

    return score;
}

function buildFallbackExecution(params = {}, session = null, scenarioSource = '') {
    const source = sanitizeText(scenarioSource);
    const extracted = source
        ? extractStructuredExecution({
            request: source,
            session,
        })
        : null;
    if (extracted) {
        return extracted;
    }

    const command = sanitizeText(
        params.command
        || params.execution?.command
        || params.execution?.params?.command,
    );
    if (!command || !hasRemoteExecutionShape(params)) {
        return null;
    }

    const sessionTarget = session?.metadata?.lastSshTarget
        || session?.metadata?.remoteWorkingState?.target
        || null;
    const host = sanitizeText(params.host || params.execution?.host || params.execution?.params?.host || sessionTarget?.host);
    const username = sanitizeText(params.username || params.execution?.username || params.execution?.params?.username || sessionTarget?.username);
    const port = Number(params.port || params.execution?.port || params.execution?.params?.port || sessionTarget?.port || 0);

    return {
        tool: 'remote-command',
        params: {
            ...(host ? { host } : {}),
            ...(username ? { username } : {}),
            ...(Number.isFinite(port) && port > 0 ? { port } : {}),
            command,
        },
    };
}

function buildCanonicalWorkloadPayloadForSource(params = {}, options = {}, scenarioSource = '') {
    const session = options.session || null;
    const timezone = sanitizeText(options.timezone || params.timezone);
    const now = options.now || params.now || null;
    const metadata = isRecord(params.metadata) ? { ...params.metadata } : {};
    const explicitPrompt = sanitizeText(params.prompt);
    const explicitTitle = sanitizeText(params.title);
    const explicitTrigger = isRecord(params.trigger) ? params.trigger : null;
    const explicitPolicy = isRecord(params.policy) ? params.policy : null;
    const explicitExecution = isRecord(params.execution) ? params.execution : null;
    const explicitStages = Array.isArray(params.stages) ? params.stages : undefined;

    let scenario = null;
    if (scenarioSource && (
        !explicitPrompt
        || !explicitTitle
        || !explicitTrigger
        || !explicitPolicy
        || (!explicitExecution && hasRemoteExecutionShape(params))
    )) {
        if (!explicitTrigger && !hasWorkloadIntent(scenarioSource)) {
            return null;
        }

        if (hasWorkloadIntent(scenarioSource)) {
            scenario = parseWorkloadScenario(scenarioSource, {
                ...(timezone ? { timezone } : {}),
                ...(now ? { now } : {}),
            });
        }
    }

    const prompt = explicitPrompt || scenario?.prompt || '';
    const brutalBuilder = explicitStages ? null : (scenario?.brutalBuilder || null);
    const inferredArtifactFormat = explicitStages ? null : inferDeferredArtifactOutputFormat(prompt);
    const brutalBuilderArtifactPlan = brutalBuilder
        ? resolveBrutalBuilderArtifactPlan(prompt, inferredArtifactFormat)
        : null;
    const inferredDeferredArtifactFormat = brutalBuilder ? null : inferredArtifactFormat;
    const brutalBuilderOutputFormat = brutalBuilderArtifactPlan?.effectiveOutputFormat || '';
    const effectivePrompt = brutalBuilder
        ? buildBrutalBuilderInitialPrompt(prompt, brutalBuilder)
        : inferredDeferredArtifactFormat
        ? buildDeferredArtifactContentPrompt(prompt, inferredDeferredArtifactFormat)
        : prompt;
    const title = explicitTitle || scenario?.title || (prompt ? deriveWorkloadTitle(prompt) : '');
    const trigger = explicitTrigger || scenario?.trigger || null;
    const execution = explicitExecution || buildFallbackExecution(params, session, scenarioSource || prompt);
    const policy = explicitPolicy || scenario?.policy || (effectivePrompt ? inferWorkloadPolicy(effectivePrompt) : undefined);
    const scenarioRequest = sanitizeText(metadata.scenarioRequest || scenarioSource);
    const creationContext = metadata.creationContext || buildWorkloadCreationContext({
        params,
        options,
        scenarioSource,
        prompt: effectivePrompt,
    });

    if (!effectivePrompt || !title || !trigger) {
        return null;
    }

    return {
        payload: {
            title,
            prompt: effectivePrompt,
            ...(hasOwn(params, 'callableSlug') ? { callableSlug: params.callableSlug } : {}),
            ...(hasOwn(params, 'mode') ? { mode: params.mode } : {}),
            ...(hasOwn(params, 'enabled') ? { enabled: params.enabled } : {}),
            trigger,
            ...(execution ? { execution } : {}),
            ...(policy ? { policy } : {}),
            ...(explicitStages
                ? { stages: explicitStages }
                : brutalBuilder
                    ? { stages: buildBrutalBuilderStages(brutalBuilder, brutalBuilderOutputFormat) }
                : (inferredDeferredArtifactFormat
                    ? { stages: buildDeferredArtifactStages(inferredDeferredArtifactFormat) }
                    : {})),
            metadata: {
                ...metadata,
                ...(inferredDeferredArtifactFormat
                    ? { requestedOutputFormat: inferredDeferredArtifactFormat }
                    : {}),
                ...(brutalBuilder
                    ? {
                        brutalBuilder: {
                            ...brutalBuilder,
                        },
                        brutalBuilderEnabled: true,
                        ...(brutalBuilderArtifactPlan?.requestedOutputFormat
                            ? { requestedOutputFormat: brutalBuilderArtifactPlan.requestedOutputFormat }
                            : {}),
                        ...(brutalBuilderOutputFormat
                            ? { defaultOutputFormat: brutalBuilderOutputFormat }
                            : {}),
                        ...(brutalBuilderArtifactPlan?.requestedOutputFormat
                            ? { resolvedOutputFormat: brutalBuilderOutputFormat || brutalBuilderArtifactPlan.requestedOutputFormat }
                            : {}),
                        ...(Array.isArray(brutalBuilderArtifactPlan?.warnings) && brutalBuilderArtifactPlan.warnings.length > 0
                            ? { outputFormatWarnings: brutalBuilderArtifactPlan.warnings }
                            : {}),
                    }
                    : {}),
                ...(scenarioRequest
                    ? {
                        createdFromScenario: true,
                        scenarioRequest,
                    }
                    : {}),
                ...(creationContext ? { creationContext } : {}),
            },
        },
        scenario,
        scenarioSource,
    };
}

function buildCanonicalWorkloadPayload(params = {}, options = {}) {
    const scenarioSource = extractWorkloadScenarioSource(params);
    const explicitPrompt = sanitizeText(params.prompt);
    const explicitTitle = sanitizeText(params.title);
    const explicitTrigger = isRecord(params.trigger) ? params.trigger : null;
    const explicitPolicy = isRecord(params.policy) ? params.policy : null;
    const explicitExecution = isRecord(params.execution) ? params.execution : null;
    const shouldInferFromScenario = Boolean(
        scenarioSource
        && (
            !explicitPrompt
            || !explicitTitle
            || !explicitTrigger
            || !explicitPolicy
            || (!explicitExecution && hasRemoteExecutionShape(params))
        ),
    );

    const candidateSources = shouldInferFromScenario
        ? buildScenarioSourceCandidates(scenarioSource, options.recentMessages)
        : [scenarioSource];

    let bestCandidate = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    candidateSources.forEach((candidateSource) => {
        const candidate = buildCanonicalWorkloadPayloadForSource(params, options, candidateSource);
        const score = scoreCanonicalCandidate(candidate);
        if (score > bestScore) {
            bestCandidate = candidate;
            bestScore = score;
        }
    });

    return bestCandidate;
}

function buildCanonicalWorkloadAction(params = {}, options = {}) {
    const scenarioSource = extractWorkloadScenarioSource(params);
    if (hasImmediateOrNoDeferCue(scenarioSource)) {
        return null;
    }

    const canonical = buildCanonicalWorkloadPayload(params, options);
    if (!canonical || canonical?.payload?.trigger?.type === 'manual') {
        return null;
    }

    return {
        action: 'create',
        ...canonical.payload,
    };
}

module.exports = {
    buildCanonicalWorkloadAction,
    buildCanonicalWorkloadPayload,
    extractWorkloadScenarioSource,
    hasRemoteExecutionShape,
};
