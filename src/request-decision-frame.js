const { getSessionControlState } = require('./runtime-control-state');

const FILENAME_PATTERN = /\b[a-z0-9][a-z0-9._-]{2,}\.(?:pdf|html?|docx?|pptx?|xlsx?|xml|md|markdown|txt|zip)\b/gi;
const DOMAIN_PATTERN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;

function compactText(value = '', limit = 220) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length <= limit) {
        return normalized;
    }

    return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function uniqueStrings(values = [], limit = 8) {
    return Array.from(new Set(
        (Array.isArray(values) ? values : [])
            .map((value) => String(value || '').trim())
            .filter(Boolean),
    )).slice(0, limit);
}

function extractMatches(text = '', pattern) {
    return uniqueStrings(String(text || '').match(pattern) || []);
}

function hasAny(normalized = '', patterns = []) {
    return patterns.some((pattern) => pattern.test(normalized));
}

function buildPreviousWorkSummary(session = null) {
    const metadata = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {};
    const controlState = getSessionControlState(session);
    const remoteWorkingState = controlState.remoteWorkingState && typeof controlState.remoteWorkingState === 'object'
        ? controlState.remoteWorkingState
        : {};

    return {
        ...(metadata.lastGeneratedArtifactId ? {
            lastArtifact: {
                id: metadata.lastGeneratedArtifactId,
                ...(metadata.lastOutputFormat ? { format: metadata.lastOutputFormat } : {}),
            },
        } : {}),
        ...(controlState.lastToolIntent ? { lastToolIntent: controlState.lastToolIntent } : {}),
        ...(controlState.lastRemoteObjective ? { lastRemoteObjective: compactText(controlState.lastRemoteObjective, 180) } : {}),
        ...(controlState.lastSshTarget?.host ? { lastRemoteTarget: controlState.lastSshTarget.host } : {}),
        ...(remoteWorkingState.lastTask ? { lastRemoteTask: compactText(remoteWorkingState.lastTask, 180) } : {}),
        ...(remoteWorkingState.workspacePath ? { lastRemoteWorkspace: remoteWorkingState.workspacePath } : {}),
    };
}

function detectRequestSignals(text = '', {
    outputFormat = null,
    candidateOutputFormat = null,
    artifactIds = [],
    effectiveArtifactIds = [],
} = {}) {
    const normalized = String(text || '').trim().toLowerCase();
    const filenames = extractMatches(text, FILENAME_PATTERN);
    const domains = extractMatches(text, DOMAIN_PATTERN)
        .filter((domain) => !/@/.test(domain));
    const selectedArtifactIds = uniqueStrings([
        ...(Array.isArray(effectiveArtifactIds) ? effectiveArtifactIds : []),
        ...(Array.isArray(artifactIds) ? artifactIds : []),
    ]);

    const explicitRemoteAgent = /\b(remote[-_\s]+cli[-_\s]+agent|remote clie agent|remote coding agent|remote[-_\s]+code[-_\s]+run|remote_code_run|agents sdk remote cli|assisted cli)\b/.test(normalized)
        || /\b(?:ask|get|have|use|call)\s+codex\s+(?:for\s+)?help\b/.test(normalized)
        || /\bcodex\s+help\b/.test(normalized)
        || /\buse\s+codex\s+for\s+(?:this|that|it|the task|the work)\b/.test(normalized);
    const managedAppTarget = hasAny(normalized, [
        /\b(managed[-_\s]+app|managed app catalog|managed[-_\s]+app catalog|managed control plane|managed platform)\b/,
        /\b(gitlab|gitlab ci|gitlab runner|build events webhook)\b/,
    ]) && !hasAny(normalized, [
        /\b(?:without|bypass|skip|do not use|don't use|not)\s+(?:the\s+)?(?:managed[-_\s]+app|managed app|gitlab)\b/,
    ]);
    const remoteTarget = explicitRemoteAgent
        || managedAppTarget
        || hasAny(normalized, [
            /\b(remote server|remote site|remote host|remote machine|on the server)\b/,
            /\b(cluster|k3s|k8s|kubernetes|kubectl|nginx|ingress|traefik|tls|ssh)\b/,
        ])
        || domains.some((domain) => /demoserver2\.buzz$/i.test(domain));
    const deploymentAction = hasAny(normalized, [
        /\b(deploy|redeploy|publish|launch|ship|go live|push|put|place|upload|copy|install|replace|update|serve)\b/,
        /\b(use|turn|convert)\b[\s\S]{0,40}\b(as|into|to)\b[\s\S]{0,30}\b(site|website|html page|page)\b/,
    ]);
    const websiteTarget = hasAny(normalized, [
        /\b(site|website|web|web page|webpage|html page|page|menu|homepage|landing page|index\.html|nginx|dashboard|frontend|front end|webapp|web app|ui mockup|html prototype|microsite)\b|\.html\b/,
    ]);
    const frontendBuildTarget = websiteTarget || hasAny(normalized, [
        /\b(app workspace|interactive sandbox|vite preview|vite sandbox|browser game|web game|video game|playable game|sandboxed game|game prototype|simulation|canvas game|webgl game)\b/,
    ]);
    const gameTarget = hasAny(normalized, [
        /\b(browser game|web game|video game|playable game|sandboxed game|game prototype|game object|game objects|sprites?|models?|npc|enemy|pickup|hazard|projectile|level|scene)\b/,
    ]);
    const complexDesignCue = hasAny(normalized, [
        /\b(complex|premium|high[-\s]?end|polished|sophisticated|rich|immersive|impressive|not cheap|cheap|same|generic|redesign|visual system|design system|design workflow|iterate|iteration|fallback|repair)\b/,
    ]);
    const placeholderAssetCue = hasAny(normalized, [
        /\b(placeholders?|fallback asset|missing asset|no files|without files|dont have files|don't have files|make objects|game objects|in place of real ones|procedural)\b/,
    ]);
    const artifactReference = selectedArtifactIds.length > 0
        || filenames.length > 0
        || hasAny(normalized, [
            /\b(pdf artifact|html artifact|document artifact|file artifact|the artifact|this artifact|that artifact)\b/,
            /\b(the pdf|this pdf|that pdf|the file|this file|that file|existing file|old file|previous file)\b/,
        ]);
    const artifactGeneration = Boolean(outputFormat || candidateOutputFormat);
    const researchCue = hasAny(normalized, [
        /\b(research|look up|search|sources?|citations?|verify current|latest|today)\b/,
        /\bonline\b[\s\S]{0,80}\b(resources?|sources?|websites?|sites?)\b/,
        /\b(?:company|companies|retailers?|shops?|stores?)\s+websites?\b/,
        /\bagents?\s+to\s+(?:gather|collect|find|research|search|verify)\b/,
        /\b(gather|collect|pull|compile)\b[\s\S]{0,80}\b(?:online|web|websites?|sites?|sources?|resources?|retailers?|shops?|stores?)\b/,
    ]);
    const notesCue = hasAny(normalized, [
        /\b(notes? page|current page|this page|the note|notes app)\b/,
    ]);

    return {
        normalized,
        filenames,
        domains,
        selectedArtifactIds,
        explicitRemoteAgent,
        managedAppTarget,
        remoteTarget,
        deploymentAction,
        websiteTarget,
        frontendBuildTarget,
        gameTarget,
        complexDesignCue,
        placeholderAssetCue,
        artifactReference,
        artifactGeneration,
        researchCue,
        notesCue,
    };
}

function classifyIntent(signals = {}, outputFormat = null, previousWork = {}) {
    const stickyRemoteContext = Boolean(
        previousWork.lastToolIntent
        || previousWork.lastRemoteTarget
        || previousWork.lastRemoteObjective
        || previousWork.lastRemoteTask
        || previousWork.lastRemoteWorkspace
    );

    if (signals.remoteTarget && signals.deploymentAction && signals.artifactReference) {
        return 'remote_deploy_existing_artifact';
    }

    if (signals.remoteTarget && signals.deploymentAction) {
        return 'remote_deploy_or_update';
    }

    if (stickyRemoteContext && signals.deploymentAction && (signals.websiteTarget || signals.artifactGeneration || signals.artifactReference)) {
        return signals.artifactReference
            ? 'remote_deploy_existing_artifact'
            : 'remote_deploy_or_update';
    }

    if (signals.remoteTarget) {
        return 'remote_inspect_or_operate';
    }

    if (signals.artifactReference && outputFormat) {
        return 'revise_or_convert_existing_artifact';
    }

    if (signals.notesCue) {
        return 'notes_or_page_edit';
    }

    if (signals.researchCue && (outputFormat || signals.artifactGeneration)) {
        return 'research_deliverable';
    }

    if (signals.researchCue) {
        return 'research_answer';
    }

    if (signals.frontendBuildTarget && (outputFormat || signals.artifactGeneration || signals.complexDesignCue || signals.gameTarget)) {
        return signals.complexDesignCue || signals.gameTarget
            ? 'complex_frontend_design_build'
            : 'frontend_design_build';
    }

    if (outputFormat || signals.artifactGeneration) {
        return 'generate_artifact';
    }

    return 'chat_answer';
}

function choosePreferredTool(intent = '', signals = {}, executionProfile = '', previousWork = {}) {
    if (signals.explicitRemoteAgent) {
        return 'remote-cli-agent';
    }

    if (intent === 'remote_deploy_existing_artifact' || intent === 'remote_deploy_or_update') {
        if (signals.managedAppTarget || previousWork.lastToolIntent === 'managed-app') {
            return 'managed-app';
        }
        return 'remote-cli-agent';
    }

    if (intent === 'remote_inspect_or_operate') {
        return String(executionProfile || '').trim() === 'remote-build'
            ? 'remote-command'
            : null;
    }

    if (intent === 'research_answer' || intent === 'research_deliverable') {
        return 'web-search';
    }

    if (intent === 'complex_frontend_design_build' || intent === 'frontend_design_build') {
        return 'document-workflow';
    }

    if (intent === 'generate_artifact' || intent === 'revise_or_convert_existing_artifact') {
        return 'artifact-service';
    }

    return null;
}

function buildBlockedActions(intent = '') {
    if (intent === 'remote_deploy_existing_artifact') {
        return [
            'generate_new_pdf',
            'generate_new_html',
            'generate_new_artifact',
            'generate_standalone_artifact_only',
            'create_replacement_preview',
            'answer_without_remote_verification',
            'guess_remote_website_path',
        ];
    }

    if (intent === 'remote_deploy_or_update') {
        return [
            'generate_standalone_artifact_only',
            'create_replacement_preview',
            'answer_without_remote_verification',
            'claim_live_without_public_check',
        ];
    }

    if (intent === 'complex_frontend_design_build' || intent === 'frontend_design_build') {
        return [
            'finalize_without_preview_or_qa',
            'reuse_generic_landing_page_scaffold',
            'hide_fallback_or_downgrade',
            'claim_ready_without_repair_redesign_decision',
        ];
    }

    return [];
}

function buildProofExpectations(intent = '') {
    if (intent === 'remote_deploy_existing_artifact') {
        return [
            'source artifact identified or downloaded',
            'managed-app/GitLab source and build evidence captured when requested',
            'remote website source/path inspected',
            'content converted or embedded into deployable HTML',
            'public URL verified by body/content check',
        ];
    }

    if (intent === 'remote_deploy_or_update') {
        return [
            'managed-app/GitLab source and build evidence captured when requested',
            'remote source/workload inspected',
            'deployment or file update applied',
            'public URL or rollout verified',
        ];
    }

    if (intent === 'generate_artifact' || intent === 'revise_or_convert_existing_artifact') {
        return [
            'artifact created or updated',
            'download/preview metadata returned',
        ];
    }

    if (intent === 'complex_frontend_design_build' || intent === 'frontend_design_build') {
        return [
            'design brief or resource context captured',
            'sandbox bundle generated with source files',
            'fallback path classified as repair, redesign, ask, or ready',
            'desktop and mobile browser QA completed after preview exists',
            'repair or redesign pass completed when QA shows blockers',
        ];
    }

    if (intent === 'research_deliverable') {
        return [
            'current source search completed',
            'important pages verified before synthesis',
            'document artifact generated only after grounded evidence exists',
        ];
    }

    return [];
}

function buildRequestDecisionCards({ intent, signals, targetDomain, preferredTool, sourceArtifacts, outputFormat }) {
    const subject = sourceArtifacts.filenames[0]
        || sourceArtifacts.ids[0]
        || (signals.artifactReference ? 'existing artifact/file' : 'user request');
    const target = targetDomain || (signals.remoteTarget ? 'remote target' : 'local/runtime response');
    const cards = [
        {
            title: 'Understanding',
            detail: intent === 'remote_deploy_existing_artifact'
                ? `Use ${subject} as source material for a remote website update.`
                : (intent === 'complex_frontend_design_build'
                    ? 'Treat this as a gated complex frontend/game design build, not a cheap one-shot artifact.'
                    : (intent === 'frontend_design_build'
                        ? 'Treat this as a previewable frontend design build with sandbox QA.'
                        : `Classified request as ${intent.replace(/_/g, ' ')}.`)),
        },
        {
            title: 'Context Pulled',
            detail: [
                sourceArtifacts.ids.length > 0 ? `Artifact ids: ${sourceArtifacts.ids.join(', ')}` : '',
                sourceArtifacts.filenames.length > 0 ? `Files: ${sourceArtifacts.filenames.join(', ')}` : '',
                targetDomain ? `Target: ${targetDomain}` : '',
                outputFormat ? `Output cue: ${outputFormat}` : '',
            ].filter(Boolean).join(' | ') || 'No prior artifact or remote target was required.',
        },
        {
            title: 'Routing Decision',
            detail: preferredTool
                ? `Use ${preferredTool} for the next step.`
                : 'Use the normal conversation path.',
        },
    ];

    if (target) {
        cards.push({
            title: 'Proof Needed',
            detail: intent.startsWith('remote_')
                ? `Verify ${target} with direct remote/public evidence before calling it done.`
                : (intent === 'complex_frontend_design_build' || intent === 'frontend_design_build'
                    ? 'Return sandbox preview evidence, QA screenshots, and the repair-vs-redesign decision.'
                    : 'Return the generated output and metadata needed by the UI.'),
        });
    }

    return cards;
}

function buildRequestDecisionFrame({
    text = '',
    session = null,
    outputFormat = null,
    candidateOutputFormat = null,
    outputFormatProvided = false,
    artifactIds = [],
    effectiveArtifactIds = [],
    executionProfile = '',
    taskType = 'chat',
    clientSurface = '',
    route = '',
} = {}) {
    const signals = detectRequestSignals(text, {
        outputFormat,
        candidateOutputFormat,
        artifactIds,
        effectiveArtifactIds,
    });
    const effectiveFormat = outputFormat || candidateOutputFormat || null;
    const previousWork = buildPreviousWorkSummary(session);
    const intent = classifyIntent(signals, effectiveFormat, previousWork);
    const preferredTool = choosePreferredTool(intent, signals, executionProfile, previousWork);
    const targetDomain = signals.domains.find((domain) => /demoserver2\.buzz$/i.test(domain))
        || signals.domains[0]
        || '';
    const sourceArtifacts = {
        ids: signals.selectedArtifactIds,
        filenames: signals.filenames,
    };
    const blockedActions = buildBlockedActions(intent);
    const proofExpectations = buildProofExpectations(intent);
    const cards = buildRequestDecisionCards({
        intent,
        signals,
        targetDomain,
        preferredTool,
        sourceArtifacts,
        outputFormat: effectiveFormat,
    });
    const missingContext = [];
    if (intent === 'remote_deploy_existing_artifact' && sourceArtifacts.ids.length === 0 && sourceArtifacts.filenames.length === 0) {
        missingContext.push('source_artifact');
    }
    if (intent === 'complex_frontend_design_build' && signals.placeholderAssetCue && signals.gameTarget) {
        missingContext.push('real_game_object_files_optional_varied_placeholders_allowed');
    }
    if (intent.startsWith('remote_') && !targetDomain && !signals.explicitRemoteAgent && !previousWork.lastRemoteTarget) {
        missingContext.push('remote_target');
    }

    const objective = intent === 'remote_deploy_existing_artifact'
        ? `Deploy existing artifact${sourceArtifacts.filenames[0] ? ` ${sourceArtifacts.filenames[0]}` : ''} to ${targetDomain || 'the remote website'} as HTML.`
        : (intent === 'complex_frontend_design_build'
            ? `${compactText(text, 160)} Build as a gated complex frontend/game design workflow with repair-vs-redesign fallback decisions, sandbox QA, and varied in-place placeholders when real assets are missing.`
            : (intent === 'frontend_design_build'
                ? `${compactText(text, 170)} Build as a previewable frontend sandbox with design context and browser QA.`
                : compactText(text, 180)));
    const userVisibleSummary = cards.map((card) => `${card.title}: ${card.detail}`).join('\n');

    return {
        version: 1,
        source: 'deterministic-request-frame',
        route,
        taskType,
        clientSurface,
        intent,
        objective,
        sourceArtifacts,
        target: {
            ...(targetDomain ? { domain: targetDomain } : {}),
            ...(signals.remoteTarget ? { kind: 'remote' } : {}),
        },
        preferredTool,
        outputFormat: outputFormat || null,
        candidateOutputFormat: candidateOutputFormat || null,
        outputFormatProvided: Boolean(outputFormatProvided),
        executionProfile: executionProfile || null,
        blockedActions,
        proofExpectations,
        missingContext,
        previousWork,
        cards,
        orchestrationHints: {
            selectedToolLane: preferredTool,
            objective,
            sourceMaterial: [
                ...sourceArtifacts.ids.map((id) => `artifact:${id}`),
                ...sourceArtifacts.filenames,
            ],
            target: targetDomain || previousWork.lastRemoteTarget || '',
            mustDo: proofExpectations,
            mustNotDo: blockedActions,
        },
        reasoningSummary: userVisibleSummary,
    };
}

function buildRequestDecisionMetadata(frame = null) {
    if (!frame || typeof frame !== 'object') {
        return {};
    }

    return {
        requestFrame: frame,
        decisionTrace: frame.cards || [],
        routingDecision: {
            intent: frame.intent || null,
            preferredTool: frame.preferredTool || null,
            target: frame.target || {},
            sourceArtifacts: frame.sourceArtifacts || {},
            blockedActions: frame.blockedActions || [],
            proofExpectations: frame.proofExpectations || [],
        },
        reasoningSummary: frame.reasoningSummary || '',
    };
}

function buildRequestFrameProgress(frame = null) {
    if (!frame || typeof frame !== 'object') {
        return null;
    }

    return {
        phase: 'understanding',
        detail: frame.cards?.[0]?.detail || frame.objective || 'Classified the request.',
        summary: frame.reasoningSummary || '',
        requestFrame: {
            intent: frame.intent,
            preferredTool: frame.preferredTool,
            target: frame.target,
            sourceArtifacts: frame.sourceArtifacts,
        },
    };
}

function formatRequestDecisionFrameForPrompt(frame = null) {
    if (!frame || typeof frame !== 'object') {
        return '';
    }

    const hints = frame.orchestrationHints || {};
    const lines = [
        'Request decision frame for this turn:',
        `- Intent: ${frame.intent || 'unknown'}`,
        frame.objective ? `- Objective: ${frame.objective}` : '',
        hints.selectedToolLane ? `- Preferred tool lane: ${hints.selectedToolLane}` : '',
        hints.sourceMaterial?.length ? `- Source material: ${hints.sourceMaterial.join(', ')}` : '',
        hints.target ? `- Target: ${hints.target}` : '',
        frame.outputFormat || frame.candidateOutputFormat ? `- Output cue: ${frame.outputFormat || frame.candidateOutputFormat}` : '',
        frame.previousWork && Object.keys(frame.previousWork).length > 0
            ? `- Previous work context: ${JSON.stringify(frame.previousWork)}`
            : '',
        frame.blockedActions?.length ? `- Do not: ${frame.blockedActions.join(', ')}` : '',
        frame.proofExpectations?.length ? `- Proof expected: ${frame.proofExpectations.join('; ')}` : '',
        'Use this frame to route the next action. If it says an existing artifact should be deployed remotely, do not replace that with a new local artifact generation step. If the preferred lane is managed-app, use managed-app as the control plane and treat remote-cli-agent as a worker inside that workflow rather than a competing top-level deploy lane.',
    ];

    return lines.filter(Boolean).join('\n');
}

module.exports = {
    buildRequestDecisionFrame,
    buildRequestDecisionMetadata,
    buildRequestFrameProgress,
    formatRequestDecisionFrameForPrompt,
};
