const { artifactService } = require('./artifacts/artifact-service');
const { inferFormat, normalizeFormat, SUPPORTED_GENERATION_FORMATS } = require('./artifacts/constants');
const { buildSessionInstructions } = require('./session-instructions');
const { config } = require('./config');
const { getSessionControlState } = require('./runtime-control-state');
const { resolveDeferredWorkloadPreflight } = require('./workloads/preflight');
const { isDashboardRequest } = require('./dashboard-template-catalog');
const { extractArtifactsFromToolEvents } = require('./runtime-artifacts');
const settingsController = require('./routes/admin/settings.controller');
const { parseLenientJson } = require('./utils/lenient-json');
const { isInteractiveDocumentRequest } = require('./artifacts/artifact-experience');
const { stripHtml } = require('./utils/text');
const {
    prepareWorkbookRelationshipInput,
    inferWorkbookRelationshipCalculationRequest,
} = require('./pii');

const REMOTE_CONTINUATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ALLOWED_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const SELECTED_ARTIFACT_REVISION_LIMIT = 60000;
const SELECTED_ARTIFACT_REVISION_PER_FILE_LIMIT = 30000;
const IMAGE_COUNT_WORDS = new Map([
    ['one', 1],
    ['two', 2],
    ['three', 3],
    ['four', 4],
    ['five', 5],
    ['couple', 2],
    ['few', 3],
    ['several', 3],
    ['multiple', 2],
]);
const OPENAI_VISION_INPUT_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
]);

function normalizeReasoningEffort(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    return ALLOWED_REASONING_EFFORTS.has(normalized) ? normalized : null;
}

function truncateArtifactRevisionText(value = '', limit = SELECTED_ARTIFACT_REVISION_PER_FILE_LIMIT) {
    const text = String(value || '').replace(/\u0000/g, '').trim();
    if (!text || text.length <= limit) {
        return text;
    }

    return `${text.slice(0, Math.max(0, limit - 80)).trim()}\n\n[Selected artifact content truncated for prompt size.]`;
}

function artifactBufferLooksTextual(artifact = null) {
    const extension = String(artifact?.extension || artifact?.format || '').trim().toLowerCase();
    const mimeType = String(artifact?.mimeType || '').trim().toLowerCase().split(';')[0];
    return mimeType.startsWith('text/')
        || ['html', 'htm', 'md', 'markdown', 'txt', 'json', 'xml', 'csv', 'mmd', 'mermaid', 'pq'].includes(extension);
}

function extractArtifactRevisionSource(artifact = null) {
    if (!artifact) {
        return '';
    }

    if (artifact.contentBuffer && artifactBufferLooksTextual(artifact)) {
        const content = truncateArtifactRevisionText(artifact.contentBuffer.toString('utf8'));
        if (content) {
            return content;
        }
    }

    const extension = String(artifact.extension || artifact.format || '').trim().toLowerCase();
    if ((extension === 'html' || extension === 'htm') && String(artifact.previewHtml || '').trim()) {
        return truncateArtifactRevisionText(artifact.previewHtml);
    }

    if (String(artifact.extractedText || '').trim()) {
        return truncateArtifactRevisionText(artifact.extractedText);
    }

    if (String(artifact.previewHtml || '').trim()) {
        return truncateArtifactRevisionText(stripHtml(artifact.previewHtml));
    }

    return '';
}

function hasArtifactRevisionActionIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const revisionVerb = '(?:continue|finish|refine|revise|update|improve|polish|expand|edit|redo|rework)';
    return new RegExp(`^${revisionVerb}\\b`, 'i').test(normalized)
        || new RegExp(`\\b${revisionVerb}\\b[\\s\\S]{0,60}\\b(?:artifact|file|document|doc|pdf|html|page|report|brief|spreadsheet|workbook|diagram|mermaid)\\b`, 'i').test(normalized)
        || new RegExp(`\\b${revisionVerb}\\b[\\s\\S]{0,30}\\b(?:it|this|that|same one|selected|upload|uploaded)\\b`, 'i').test(normalized)
        || /\b(?:add|remove|change|replace|insert)\b[\s\S]{0,80}\b(?:in|on|to|from)\b[\s\S]{0,40}\b(?:artifact|file|document|doc|pdf|html|page|report|brief|spreadsheet|workbook|diagram|mermaid)\b/i.test(normalized);
}

function normalizeArtifactRevisionOutputFormat(artifact = null) {
    const explicitFormat = artifact?.extension
        || artifact?.format
        || artifact?.metadata?.format
        || inferFormat(artifact?.filename || '', artifact?.mimeType || '');
    const format = normalizeFormat(explicitFormat);

    if (SUPPORTED_GENERATION_FORMATS.has(format)) {
        return format;
    }
    if (format === 'docx' || format === 'doc') {
        return 'html';
    }
    return null;
}

async function inferOutputFormatFromArtifactContext({
    sessionId = '',
    artifactIds = [],
    text = '',
} = {}) {
    const normalizedSessionId = String(sessionId || '').trim();
    const ids = Array.from(new Set(
        (Array.isArray(artifactIds) ? artifactIds : [])
            .map((artifactId) => String(artifactId || '').trim())
            .filter(Boolean),
    )).slice(0, 4);

    if (!normalizedSessionId || ids.length === 0 || !hasArtifactRevisionActionIntent(text)) {
        return null;
    }

    for (const artifactId of ids) {
        try {
            const artifact = await artifactService.getArtifact(artifactId);
            if (!artifact || artifact.sessionId !== normalizedSessionId) {
                continue;
            }

            const format = normalizeArtifactRevisionOutputFormat(artifact);
            if (format) {
                return format;
            }
        } catch (error) {
            console.warn(`[Artifacts] Failed to infer output format from selected artifact ${artifactId}: ${error.message}`);
        }
    }

    return null;
}

async function buildSelectedArtifactRevisionContext({
    sessionId = '',
    artifactIds = [],
} = {}) {
    const normalizedSessionId = String(sessionId || '').trim();
    const ids = Array.from(new Set(
        (Array.isArray(artifactIds) ? artifactIds : [])
            .map((artifactId) => String(artifactId || '').trim())
            .filter(Boolean),
    )).slice(0, 4);

    if (!normalizedSessionId || ids.length === 0) {
        return { content: '', sourceArtifactIds: [] };
    }

    const blocks = [];
    const sourceArtifactIds = [];
    let remaining = SELECTED_ARTIFACT_REVISION_LIMIT;
    for (const artifactId of ids) {
        if (remaining <= 0) {
            break;
        }

        let artifact = null;
        try {
            artifact = await artifactService.getArtifact(artifactId, { includeContent: true });
        } catch (error) {
            console.warn(`[Artifacts] Failed to load selected artifact ${artifactId} for revision context: ${error.message}`);
            continue;
        }

        if (!artifact || artifact.sessionId !== normalizedSessionId) {
            continue;
        }

        const source = truncateArtifactRevisionText(extractArtifactRevisionSource(artifact), remaining);
        if (!source) {
            continue;
        }

        const header = [
            `[Selected artifact to revise]`,
            `Artifact ID: ${artifact.id}`,
            `Filename: ${artifact.filename || 'untitled'}`,
            `Format: ${artifact.extension || artifact.format || 'file'}`,
            '',
            source,
        ].join('\n');
        blocks.push(header);
        sourceArtifactIds.push(artifact.id);
        remaining -= header.length;
    }

    return {
        content: blocks.join('\n\n---\n\n'),
        sourceArtifactIds,
    };
}

function resolveReasoningEffort(payload = {}, fallback = null) {
    const candidate = [
        payload?.reasoningEffort,
        payload?.reasoning_effort,
        payload?.reasoning?.effort,
        payload?.metadata?.reasoningEffort,
        payload?.metadata?.reasoning_effort,
        payload?.metadata?.reasoning?.effort,
        fallback,
        config.openai.reasoningEffort,
    ].find((value) => typeof value === 'string' && value.trim());

    return normalizeReasoningEffort(candidate);
}

async function buildInstructionsWithArtifacts(session, baseInstructions = '', artifactIds = []) {
    let artifactContext = '';
    try {
        artifactContext = artifactIds && artifactIds.length > 0
            ? await artifactService.buildPromptContext(session.id, artifactIds)
            : '';
    } catch (error) {
        console.error('[Artifacts] Failed to build prompt context:', error.message);
    }

    return buildSessionInstructions(
        session,
        [baseInstructions, artifactContext].filter(Boolean).join('\n\n'),
    );
}

function isWorkbookArtifact(artifact = {}) {
    const extension = String(artifact.extension || artifact.format || '').trim().toLowerCase();
    const mimeType = String(artifact.mimeType || artifact.mime_type || '').trim().toLowerCase();
    return extension === 'xlsx'
        || mimeType.includes('spreadsheetml.sheet')
        || String(artifact.filename || '').toLowerCase().endsWith('.xlsx');
}

async function buildPiiWorkbookRelationshipToolContext({
    sessionId = '',
    artifactIds = [],
    text = '',
    ownerId = null,
    clientSurface = '',
    route = '',
    metadata = {},
    policy = null,
} = {}) {
    const normalizedSessionId = String(sessionId || '').trim();
    const ids = Array.from(new Set(
        (Array.isArray(artifactIds) ? artifactIds : [])
            .map((artifactId) => String(artifactId || '').trim())
            .filter(Boolean),
    )).slice(0, 4);
    if (!normalizedSessionId || ids.length === 0) {
        return null;
    }

    const structuredTables = [];
    const workbookArtifactIds = [];
    for (const artifactId of ids) {
        let artifact = null;
        try {
            artifact = await artifactService.getArtifact(artifactId, { includeContent: true });
        } catch (error) {
            console.warn(`[PII] Failed to inspect workbook artifact ${artifactId}: ${error.message}`);
            continue;
        }
        const artifactSessionId = String(artifact.sessionId || artifact.session_id || '').trim();
        if (!artifact || artifactSessionId !== normalizedSessionId || !isWorkbookArtifact(artifact)) {
            continue;
        }
        const artifactTables = Array.isArray(artifact.metadata?.structuredTables)
            ? artifact.metadata.structuredTables
            : [];
        if (artifactTables.length === 0) {
            continue;
        }
        structuredTables.push(...artifactTables);
        workbookArtifactIds.push(artifactId);
    }

    if (structuredTables.length === 0) {
        return null;
    }

    const prepared = await prepareWorkbookRelationshipInput({
        structuredTables,
        sessionId: normalizedSessionId,
        ownerId,
        clientSurface: clientSurface || 'web-chat',
        route: route || '/api/chat',
        metadata,
        policy,
    });
    const request = inferWorkbookRelationshipCalculationRequest({
        text,
        tables: prepared.tables,
    });
    if (!request) {
        return null;
    }

    return {
        request,
        context: prepared.context,
        artifactIds: workbookArtifactIds,
        tableCount: prepared.tables.length,
        rowCount: prepared.tables.reduce((count, table) => count + (Array.isArray(table.rows) ? table.rows.length : 0), 0),
    };
}

async function maybeGenerateOutputArtifact({
    sessionId,
    session = null,
    mode,
    outputFormat,
    content,
    prompt = '',
    title,
    responseId,
    artifactIds = [],
    existingContent = '',
    model = null,
    reasoningEffort = null,
    contextMessages = [],
    recentMessages = [],
    missionId = null,
    parentArtifactId = null,
    revision = null,
    provenance = {},
}) {
    if (!outputFormat) {
        return [];
    }

    try {
        if (prompt) {
            const result = await artifactService.generateArtifact({
                session,
                sessionId,
                mode,
                prompt,
                format: outputFormat,
                artifactIds,
                existingContent,
                model,
                reasoningEffort,
                contextMessages,
                recentMessages,
                missionId,
                parentArtifactId,
                revision,
                provenance,
            });
            return [result.artifact];
        }
    } catch (error) {
        console.error('[Artifacts] Prompt-based generation failed:', error.message);
        if (!content) {
            throw error;
        }
    }

    if (!content) {
        return [];
    }

    const artifact = await artifactService.storeGeneratedArtifactFromContent({
        sessionId,
        mode,
        format: outputFormat,
        content,
        title,
        parentArtifactId,
        missionId,
        revision,
        provenance,
        metadata: {
            sourceResponseId: responseId,
            artifactIds,
            missionId,
            revision,
            provenance,
        },
    });

    return [artifact];
}

function buildArtifactCompletionMessage(outputFormat, artifact) {
    const normalizedFormat = normalizeFormat(outputFormat) || 'file';
    const isSiteBundle = artifact?.metadata?.siteBundle
        || (Array.isArray(artifact?.metadata?.bundle?.files) && artifact.metadata.bundle.files.length > 1)
        || (
            typeof artifact?.previewUrl === 'string'
            && /\/api\/artifacts\/.+\/preview(?:\/|$)/i.test(artifact.previewUrl)
            && Boolean(artifact?.bundleDownloadUrl)
        );
    const formatLabel = {
        pdf: 'PDF',
        docx: 'HTML document',
        html: isSiteBundle ? 'HTML site bundle' : 'HTML document',
        xml: 'XML file',
        mermaid: 'Mermaid diagram',
        xlsx: 'Excel workbook',
        'power-query': 'Power Query script',
    }[normalizedFormat] || normalizedFormat.toUpperCase();

    const filename = artifact?.filename ? ` (${artifact.filename})` : '';
    if (isSiteBundle) {
        const preview = artifact?.previewUrl || artifact?.sandboxUrl || '';
        const bundle = artifact?.bundleDownloadUrl || artifact?.downloadUrl || '';
        return [
            `Created the ${formatLabel} artifact${filename}.`,
            preview ? `Play it: ${preview}` : '',
            bundle ? `Download ZIP: ${bundle}` : '',
        ].filter(Boolean).join('\n');
    }

    const download = artifact?.downloadUrl || '';
    const preview = [artifact?.previewUrl, artifact?.sandboxUrl]
        .find((url) => url && url !== download) || '';
    return [
        `Created the ${formatLabel} artifact${filename}.`,
        preview ? `Preview: ${preview}` : '',
        download ? `Download: ${download}` : '',
    ].filter(Boolean).join('\n');
}

function shouldDeferArtifactGenerationToWorkload(text = '', outputFormat = null, options = {}) {
    const normalizedFormat = normalizeFormat(outputFormat);
    if (!normalizedFormat) {
        return false;
    }

    return resolveDeferredWorkloadPreflight({
        text,
        recentMessages: options?.recentMessages || [],
        timezone: options?.timezone || null,
        now: options?.now || null,
    }).shouldSchedule;
}

function hasExplicitArtifactGenerationIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(export|download|save|convert|turn\b[\s\S]{0,20}\binto|turn\b[\s\S]{0,20}\bas|format\b[\s\S]{0,20}\bas)\b/i.test(normalized)
        || /\b(put|place|package|compile)\b[\s\S]{0,60}\b(into|in|as)\b[\s\S]{0,24}\b(file|artifact|document|report|brief|pdf|html|docx|spreadsheet|excel|workbook)\b/i.test(normalized)
        || /\b(create|make|generate|build|produce|render|prepare|draft)\b[\s\S]{0,60}\b(file|artifact|document|page|report|brief|pdf|html|docx|xml|spreadsheet|excel|workbook|mermaid|diagram|flowchart|sequence diagram|erd|class diagram|state diagram)\b/i.test(normalized)
        || /\b(as|into|in)\s+(?:an?\s+)?(?:pdf|html|docx|xml|spreadsheet|excel workbook|workbook|mermaid|mmd)\b/i.test(normalized)
        || /\b(pdf|html|docx|xml|spreadsheet|excel|workbook)\s+(?:file|document|artifact|export)\b/i.test(normalized);
}

function hasExplicitMermaidArtifactIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    if (/\b(mermaid|\.mmd\b)\b/i.test(normalized)) {
        return hasExplicitArtifactGenerationIntent(normalized)
            || /\b(mermaid|mmd)\s+(?:file|artifact|diagram|chart|export)\b/i.test(normalized);
    }

    return /\b(create|make|generate|build|produce|render|export|draw)\b[\s\S]{0,60}\b(diagram|flowchart|sequence diagram|erd|entity relationship|class diagram|state diagram)\b/i.test(normalized)
        || /\b(diagram|flowchart|sequence diagram|erd|entity relationship|class diagram|state diagram)\s+(?:file|artifact|export)\b/i.test(normalized);
}

function hasExplicitMermaidFileIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\.(?:mmd)\b/i.test(normalized)
        || (/\bmermaid\b/i.test(normalized)
            && /\b(file|artifact|export|download|save|share|shareable|link)\b/i.test(normalized))
        || /\b(export|download|save|share|shareable|link)\b[\s\S]{0,60}\b(mermaid|mmd|diagram)\b/i.test(normalized)
        || /\b(mermaid|mmd)\s+(?:file|artifact|export|download)\b/i.test(normalized);
}

function isNotesSurfaceTaskType(taskType = '') {
    const normalized = String(taskType || '').trim().toLowerCase();
    return [
        'notes',
        'notes-app',
        'notes_app',
        'notes-editor',
        'notes_editor',
    ].includes(normalized);
}

function isWebChatSurface(clientSurface = '') {
    return String(clientSurface || '').trim().toLowerCase() === 'web-chat';
}

function hasExplicitArtifactDeliveryIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(export|download|save|artifact|file|link|share|attachment)\b/i.test(normalized);
}

function hasExplicitStandaloneHtmlIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(standalone html|html file|downloadable html|shareable html|html artifact|html export)\b/i.test(normalized);
}

function hasPlanningConversationIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const planningPatterns = [
        /\b(help me|let'?s|lets|can we|could we|i want to|we should)\s+(plan|outline|brainstorm|think through|talk through|discuss|ideate|sketch out|map out)\b/,
        /\b(just|only)\s+(plan|outline|brainstorm|discuss)\b/,
        /\b(plan|outline|brainstorm|think through|talk through|discuss|ideate|sketch out|map out)\b[\s\S]{0,40}\b(before|first)\b/,
        /\b(before|first)\b[\s\S]{0,30}\b(edit|update|rewrite|apply|write|change|rebuild)\b/,
        /\b(do not|don't|dont|not)\b[\s\S]{0,20}\b(edit|update|rewrite|apply|write|change|rebuild)\b[\s\S]{0,20}\b(yet|first)\b/,
    ];
    const planningTarget = /\b(page|notes?|document|doc|brief|report|spec|guide|proposal|outline|section|content|html page|web page|landing page|website)\b/.test(normalized);

    return planningTarget && planningPatterns.some((pattern) => pattern.test(normalized));
}

function hasExplicitNotesPageEditIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /\b(put|add|insert|place|append|prepend|move|drop|apply|write|turn|convert|use|set)\b[\s\S]{0,40}\b(on|into|to|in)\b[\s\S]{0,20}\b(page|note|document|doc)\b/,
        /\b(edit|update|rewrite|reformat|reorganize|restyle|clean up|fix)\b[\s\S]{0,40}\b(page|note|document|doc)\b/,
        /\b(current page|this page|the page|this note|the note)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasImplicitNotesPageBuildIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const pageWritingVerb = /\b(create|make|build|draft|write|expand|fill out|flesh out|continue|finish|polish|rewrite|turn|convert|organize|restructure|rework|improve|work on)\b/.test(normalized);
    const pageTarget = /\b(page|notes|note|document|doc|brief|report|spec|plan|guide|proposal|outline|section|content)\b/.test(normalized);
    const asksForFullerContent = /\b(more detail|more details|fill it out|flesh it out|expand it|make it better|make it fuller|build it out|finish the page|work on the page)\b/.test(normalized);

    return (pageWritingVerb && pageTarget) || asksForFullerContent;
}

function stripInjectedNotesPageEditDirective(text = '') {
    const source = String(text || '');
    if (!source) {
        return '';
    }

    const patterns = [
        /\n+\s*Interpret ["']page["'] as the current notes page shown in this editor\.[\s\S]*$/i,
        /\n+\s*This is a direct page edit request, so return notes-actions[\s\S]*$/i,
    ];

    for (const pattern of patterns) {
        const match = source.match(pattern);
        if (match?.index >= 0) {
            const stripped = source.slice(0, match.index).trimEnd();
            return stripped || source.trim();
        }
    }

    return source;
}

function shouldSuppressNotesSurfaceArtifact({
    taskType = '',
    text = '',
    outputFormat = null,
    outputFormatProvided = false,
} = {}) {
    const normalizedFormat = normalizeFormat(outputFormat);
    const explicitDeliveryIntent = hasExplicitArtifactDeliveryIntent(text);
    if (!normalizedFormat || !isNotesSurfaceTaskType(taskType)) {
        return false;
    }

    if (normalizedFormat === 'mermaid' && !outputFormatProvided) {
        return !hasExplicitMermaidFileIntent(text);
    }

    if (normalizedFormat === 'power-query') {
        return !explicitDeliveryIntent;
    }

    if (normalizedFormat === 'html' && hasExplicitStandaloneHtmlIntent(text)) {
        return false;
    }

    return !explicitDeliveryIntent;
}

function shouldSuppressImplicitMermaidArtifact({
    taskType = '',
    text = '',
    outputFormat = null,
    outputFormatProvided = false,
} = {}) {
    if (normalizeFormat(outputFormat) !== 'mermaid' || outputFormatProvided) {
        return false;
    }

    if (isNotesSurfaceTaskType(taskType)) {
        return !hasExplicitMermaidFileIntent(text);
    }

    return false;
}

function shouldSuppressWebChatImplicitHtmlArtifact({
    clientSurface = '',
    text = '',
    outputFormat = null,
    outputFormatProvided = false,
} = {}) {
    if (normalizeFormat(outputFormat) !== 'html' || outputFormatProvided || !isWebChatSurface(clientSurface)) {
        return false;
    }

    return hasPlanningConversationIntent(text);
}

function shouldSuppressArtifactGenerationForRemoteAction({
    text = '',
    outputFormat = null,
    outputFormatProvided = false,
    remoteContext = false,
} = {}) {
    if (!normalizeFormat(outputFormat)) {
        return false;
    }

    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const explicitRemoteAgent = /\b(remote[-_\s]+cli[-_\s]+agent|remote clie agent|remote coding agent|remote[-_\s]+code[-_\s]+run|remote_code_run|agents sdk remote cli|assisted cli)\b/.test(normalized);
    const managedAppTarget = /\b(managed[-_\s]+app|managed app catalog|managed[-_\s]+app catalog|managed control plane|gitlab|gitlab ci|gitlab runner|build events webhook)\b/.test(normalized)
        && !/\b(?:without|bypass|skip|do not use|don't use|not)\s+(?:the\s+)?(?:managed[-_\s]+app|managed app|gitlab)\b/.test(normalized);
    const remoteTarget = Boolean(remoteContext)
        || explicitRemoteAgent
        || managedAppTarget
        || /\b(remote server|remote site|remote host|remote machine|on the server|cluster|k3s|k8s|kubernetes|kubectl|nginx|ingress|traefik|tls|ssh)\b/.test(normalized)
        || /\b[a-z0-9-]+\.demoserver2\.buzz\b/.test(normalized);
    const negatedDeploymentAction = /\b(?:without|bypass|skip|do not|don't|dont|not)\s+(?:deploying|deploy|redeploying|redeploy|publishing|publish|launching|launch|shipping|ship|going live|go live|pushing|push|uploading|upload|installing|install|serving|serve)\b/.test(normalized);
    const deploymentAction = !negatedDeploymentAction
        && /\b(deploy|redeploy|publish|launch|ship|go live|push|put|place|upload|copy|install|replace|update|serve)\b/.test(normalized);
    const websiteTarget = /\b(site|website|web|html|web page|webpage|html page|page|menu|homepage|landing page|index\.html|nginx|pdf|artifact|file|preview)\b|\.html\b/.test(normalized);
    const explicitLocalArtifactOnly = !explicitRemoteAgent && !managedAppTarget && [
        /\b(create|generate|make|draft|write|export|download|save)\b[\s\S]{0,80}\b(local|standalone|preview|artifact|file|document)\b/,
        /\b(local|standalone|preview)\b[\s\S]{0,50}\b(artifact|file|document)\b/,
        /\b(sandbox|sandboxed|browser preview|previewable)\b[\s\S]{0,80}\b(html|site|website|page|document|artifact|file)\b/,
        /\b(html|site|website|page|document|artifact|file)\b[\s\S]{0,80}\b(sandbox|sandboxed|browser preview|previewable)\b/,
    ].some((pattern) => pattern.test(normalized));

    if (explicitLocalArtifactOnly && !(remoteTarget && deploymentAction)) {
        return false;
    }

    return explicitRemoteAgent || (remoteTarget && deploymentAction && websiteTarget);
}

function hasRemoteCliAgentToolEvent(toolEvents = []) {
    return (Array.isArray(toolEvents) ? toolEvents : []).some((event) => {
        const toolId = String(
            event?.toolCall?.function?.name
            || event?.result?.toolId
            || event?.toolName
            || event?.tool
            || '',
        ).trim();
        return toolId === 'remote-cli-agent';
    });
}

function shouldGenerateOutputArtifactForToolResponse({
    outputFormat = null,
    outputFormatProvided = false,
    toolEvents = [],
} = {}) {
    if (!normalizeFormat(outputFormat)) {
        return false;
    }
    if (outputFormatProvided) {
        return true;
    }

    return !hasRemoteCliAgentToolEvent(toolEvents);
}

function isRecoverableArtifactGenerationError(error = null) {
    const code = String(error?.code || '').toLowerCase();
    const message = String(error?.message || '').toLowerCase();
    return code === 'tool_orchestration_failed'
        || /\btool orchestration\b/.test(message)
        || /\brequest timed out\b/.test(message)
        || /\bprovider command timed out\b/.test(message)
        || /\btimed out while waiting\b/.test(message);
}

function inferResilientArtifactTitle(prompt = '', outputFormat = '') {
    const cleaned = String(prompt || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\b(?:create|make|generate|build|produce|render|prepare|draft|write)\b/ig, ' ')
        .replace(/\b(?:html|pdf|document|file|artifact|sandbox|preview|website|webpage|web page)\b/ig, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const title = cleaned
        .split(/[.!?\n]/)[0]
        .replace(/\b(?:about|for|on|into|as|with|using|please|can you|could you)\b/ig, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (title) {
        return title
            .split(' ')
            .slice(0, 9)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    return normalizeFormat(outputFormat) === 'pdf' ? 'Polished Document' : 'Polished HTML Site';
}

function buildResilientArtifactFallbackHtml(prompt = '', outputFormat = 'html') {
    const normalizedFormat = normalizeFormat(outputFormat) || 'html';
    const title = inferResilientArtifactTitle(prompt, normalizedFormat);
    const safeTitle = title.replace(/[<>&"]/g, (char) => ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
    }[char]));
    const requestSummary = String(prompt || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 420)
        .replace(/[<>&"]/g, (char) => ({
            '<': '&lt;',
            '>': '&gt;',
            '&': '&amp;',
            '"': '&quot;',
        }[char]));
    const isPdf = normalizedFormat === 'pdf';

    return [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '  <meta charset="utf-8">',
        '  <meta name="viewport" content="width=device-width, initial-scale=1">',
        `  <title>${safeTitle}</title>`,
        '  <style>',
        '    :root { --ink:#13201f; --muted:#526261; --paper:#fbf8ef; --panel:#ffffff; --accent:#d24b35; --accent-2:#187078; --accent-3:#e5b83e; --line:rgba(19,32,31,.16); --shadow:0 22px 60px rgba(19,32,31,.16); }',
        isPdf ? '    @page { size: 11.33in 14.67in portrait; margin: 0.72in 0.65in 0.68in; }' : '',
        '    * { box-sizing: border-box; }',
        '    body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:linear-gradient(135deg,#fbf8ef 0%,#e9f1ee 42%,#f8e5d3 100%); }',
        '    main { width:min(1180px, calc(100% - 32px)); margin:0 auto; padding:32px 0 72px; }',
        '    .hero { min-height:58vh; display:grid; grid-template-columns:minmax(0,1.08fr) minmax(280px,.92fr); gap:26px; align-items:stretch; }',
        '    .hero-copy { padding:42px; border:1px solid var(--line); background:rgba(255,255,255,.86); box-shadow:var(--shadow); }',
        '    .eyebrow { margin:0 0 14px; color:var(--accent-2); text-transform:uppercase; font-size:.78rem; font-weight:800; letter-spacing:.14em; }',
        '    h1 { margin:0; font-size:clamp(2.4rem, 6vw, 5.6rem); line-height:.93; max-width:12ch; letter-spacing:0; }',
        '    .standfirst { max-width:58ch; margin:22px 0 0; color:var(--muted); font-size:1.08rem; line-height:1.7; }',
        '    .visual { position:relative; min-height:360px; overflow:hidden; background:linear-gradient(160deg,var(--accent-2),#113b49 58%,var(--accent)); border:1px solid rgba(255,255,255,.5); box-shadow:var(--shadow); }',
        '    .visual::before { content:""; position:absolute; inset:28px; border:1px solid rgba(255,255,255,.48); }',
        '    .visual-grid { position:absolute; inset:0; background-image:linear-gradient(rgba(255,255,255,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.18) 1px, transparent 1px); background-size:34px 34px; mask-image:linear-gradient(135deg, transparent, #000 26%, #000 72%, transparent); }',
        '    .visual-card { position:absolute; left:34px; right:34px; bottom:34px; padding:22px; background:rgba(255,255,255,.88); color:var(--ink); border:1px solid rgba(255,255,255,.72); }',
        '    .nav { display:flex; flex-wrap:wrap; gap:10px; margin:24px 0; }',
        '    .nav a { color:var(--ink); text-decoration:none; border:1px solid var(--line); background:rgba(255,255,255,.75); padding:10px 13px; font-weight:700; }',
        '    .section { display:grid; grid-template-columns:92px minmax(0,1fr); gap:22px; margin:20px 0; padding:26px; border:1px solid var(--line); background:rgba(255,255,255,.82); box-shadow:0 14px 40px rgba(19,32,31,.08); }',
        '    .num { color:var(--accent); font-size:2rem; font-weight:900; line-height:1; }',
        '    h2 { margin:0 0 12px; font-size:clamp(1.45rem, 3vw, 2.35rem); line-height:1.05; }',
        '    p, li { line-height:1.68; }',
        '    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; margin-top:18px; }',
        '    .card { padding:18px; background:var(--paper); border:1px solid var(--line); min-height:150px; }',
        '    .card strong { display:block; margin-bottom:8px; color:var(--accent-2); }',
        '    .band { margin:22px 0; padding:26px; background:var(--ink); color:#fffaf0; }',
        '    .band p { color:rgba(255,250,240,.82); max-width:76ch; }',
        '    @media (max-width: 820px) { .hero, .section { grid-template-columns:1fr; } .hero-copy { padding:28px; } .visual { min-height:300px; } }',
        '    @media print { body { background:#fff; } main { width:100%; padding:0; } .hero-copy, .section, .card { box-shadow:none; break-inside:avoid; } .nav { display:none; } }',
        '  </style>',
        '</head>',
        '<body>',
        '  <main>',
        '    <section class="hero">',
        '      <div class="hero-copy">',
        '        <p class="eyebrow">Generated artifact</p>',
        `        <h1>${safeTitle}</h1>`,
        `        <p class="standfirst">${requestSummary || 'A complete, visually structured artifact generated from the user request, with readable sections, responsive layout, and print-safe styling.'}</p>`,
        '      </div>',
        '      <div class="visual" aria-label="Abstract composed visual field"><div class="visual-grid"></div><div class="visual-card"><strong>Visual direction</strong><p>Layered editorial composition, strong contrast, and reusable sections instead of a blank white page.</p></div></div>',
        '    </section>',
        '    <nav class="nav" aria-label="Page sections"><a href="#story">Story</a><a href="#experience">Experience</a><a href="#system">System</a><a href="#delivery">Delivery</a></nav>',
        '    <section class="section" id="story"><div class="num">01</div><div><h2>Purpose And Reader Job</h2><p>This artifact gives the requested subject a concrete first-pass structure: a clear opening, useful section flow, visual contrast, and enough detail for review or iteration.</p><div class="cards"><div class="card"><strong>Audience</strong><p>Built for a reader who needs the point quickly, then wants enough supporting detail to act.</p></div><div class="card"><strong>Promise</strong><p>Move beyond a note about making something and provide a real surfaced artifact immediately.</p></div></div></div></section>',
        '    <section class="section" id="experience"><div class="num">02</div><div><h2>Experience Architecture</h2><p>The page uses a hero, navigation, repeated content modules, visual panels, and print rules so it works as both a browser preview and an export source.</p><ul><li>Responsive layout with no default white-body fallback.</li><li>Readable contrast tokens for page, panels, links, and dark bands.</li><li>Stable section IDs for follow-up edits and export workflows.</li></ul></div></section>',
        '    <section class="band"><h2>Design System Snapshot</h2><p>Warm paper, teal structure, red-orange emphasis, and golden highlights create visual variety without depending on fragile external assets.</p></section>',
        '    <section class="section" id="system"><div class="num">03</div><div><h2>Reusable Content Modules</h2><div class="cards"><div class="card"><strong>Hero</strong><p>Owns the subject and sets the visual tone in the first viewport.</p></div><div class="card"><strong>Evidence Panels</strong><p>Let later passes add research, charts, images, or source-backed details cleanly.</p></div><div class="card"><strong>Action Close</strong><p>Leaves the artifact ready for QA, export, or deployment.</p></div></div></div></section>',
        '    <section class="section" id="delivery"><div class="num">04</div><div><h2>Delivery Checks</h2><p>The artifact includes browser-safe CSS, responsive behavior, print styles, and explicit color surfaces. A follow-up generation pass can replace this resilient version with deeper model-authored copy without changing the delivery path.</p></div></section>',
        '  </main>',
        '</body>',
        '</html>',
    ].filter(Boolean).join('\n');
}

function hasVerifiedResearchContext(recentMessages = []) {
    return (Array.isArray(recentMessages) ? recentMessages : []).some((message) => {
        const text = String(message?.content || message?.text || '').toLowerCase();
        return /\b(verified source excerpts|candidate pages|sources verified|research sources|web-search|web-fetch|citations?)\b/.test(text);
    });
}

function shouldSuppressResearchFirstArtifactGeneration({
    text = '',
    outputFormat = null,
    outputFormatProvided = false,
    artifactIds = [],
    recentMessages = [],
} = {}) {
    if (!normalizeFormat(outputFormat)) {
        return false;
    }

    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    if (hasVerifiedResearchContext(recentMessages)) {
        return false;
    }

    const hasSourceArtifact = Array.isArray(artifactIds) && artifactIds.some((artifactId) => String(artifactId || '').trim());
    const explicitCurrentResearchCue = [
        /\b(deep research|in-depth research|comprehensive research|thorough research)\b/,
        /\b(do|doing|some|more|public|web|online)\s+research\b/,
        /\bresearch\s+(?:on|into|about)\b/,
        /\b(look up|look into|search|browse|verify|fact[-\s]?check)\b/,
        /\b(latest|current|recent|today|news|release notes?|version|support pages?|tech support|citations?|sources?|evidence)\b/,
        /\bonline\b[\s\S]{0,80}\b(resources?|sources?|websites?|sites?)\b/,
        /\b(?:company|companies|retailers?|shops?|stores?)\s+websites?\b/,
        /\bagents?\s+to\s+(?:gather|collect|find|research|search|verify)\b/,
        /\b(gather|collect|pull|compile)\b[\s\S]{0,80}\b(?:online|web|websites?|sites?|sources?|resources?|retailers?|shops?|stores?)\b/,
    ].some((pattern) => pattern.test(normalized));
    if (!explicitCurrentResearchCue) {
        return false;
    }

    const hasDeliverableCue = outputFormatProvided
        || hasExplicitArtifactGenerationIntent(normalized)
        || /\b(document|doc|report|brief|paper|whitepaper|white paper|dossier|guide|pdf|html|training class|training material|training materials|class design|curriculum|lesson plan)\b/.test(normalized);
    if (!hasDeliverableCue) {
        return false;
    }

    const hasSequencedResearchCue = /\b(first|to start|start with|then|after that|once we have enough|once we know|goal is to build|building up|when we have enough data)\b/.test(normalized);
    if (hasSourceArtifact && !hasSequencedResearchCue) {
        return false;
    }

    return true;
}

function isArtifactStorageAvailable() {
    if (typeof artifactService.canStoreArtifacts === 'function') {
        return artifactService.canStoreArtifacts();
    }

    return typeof artifactService.isEnabled === 'function'
        ? artifactService.isEnabled()
        : false;
}

function isWebsiteDesignExampleRequest(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const hasWebsiteImplementationCue = /\b(web page|webpage|website|site|frontend|ui|vite|react|nextjs|microsite|landing page|browser game|web game|video game|sandboxed game|playable game|game prototype|interactive sandbox|vite preview|vite sandbox|multi step frontend|multi-step frontend)\b/.test(normalized);
    const hasDesignPrototypeCue = /\b(template|prototype|mockup|example|demo|starter|boilerplate|layout|wireframe|design system|component)\b/.test(normalized);
    const hasPresentationOrDocumentCue = /\b(slides|slide deck|deck|presentation|storyboard|report|brief|document|doc)\b/.test(normalized);
    const hasSlideDeckCue = /\b(powerpoint|pptx?|slide deck|slides?|presentation|deck)\b/.test(normalized);
    const hasWebsiteDesignCue = /\b(website design|web design|site design|product design|ui design|design reference|design example|design template)\b/.test(normalized);

    return (hasWebsiteImplementationCue && hasDesignPrototypeCue)
        || (hasPresentationOrDocumentCue && !hasSlideDeckCue && (hasWebsiteImplementationCue || hasWebsiteDesignCue));
}

function shouldUseAgentSandboxForProjectArtifact(text = '', outputFormat = null) {
    if (normalizeFormat(outputFormat) !== 'html') {
        return false;
    }

    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized || /\b(text only|text-only|plain text|no artifact|no file|inline only|no sandbox|without sandbox)\b/.test(normalized)) {
        return false;
    }

    const hasBuildIntent = /\b(create|make|generate|build|built|produce|render|prepare|draft|mock(?:\s|-)?up|prototype)\b/.test(normalized);
    const hasProjectSurface = /\b(project|website|web page|webpage|html page|landing page|homepage|microsite|marketing site|frontend|front-end|ui|dashboard|web app|app workspace|prototype|mockup|demo|browser game|web game|video game|sandboxed game|playable game|multi step frontend|multi-step frontend)\b/.test(normalized)
        || isDashboardRequest(normalized);
    const hasDocumentSurface = /\b(document|doc|report|brief|guide|manual|workbook|dossier|whitepaper|white paper|article|paper|proposal|plan|spec)\b/.test(normalized);

    return hasBuildIntent && (hasProjectSurface || hasDocumentSurface || isInteractiveDocumentRequest(normalized));
}

async function maybeGenerateAgentSandboxArtifact({
    sessionId,
    prompt = '',
    outputFormat = null,
    model = null,
    reasoningEffort = null,
    toolManager = null,
    toolContext = {},
} = {}) {
    if (!sessionId
        || !shouldUseAgentSandboxForProjectArtifact(prompt, outputFormat)
        || typeof toolManager?.executeTool !== 'function') {
        return null;
    }

    if (typeof toolManager.getTool === 'function' && !toolManager.getTool('document-workflow')) {
        return null;
    }

    const params = {
        action: 'generate-suite',
        prompt,
        formats: ['html'],
        format: 'html',
        buildMode: 'sandbox',
        useSandbox: true,
        includeContent: true,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
    };

    const toolEvent = {
        toolCall: {
            function: {
                name: 'document-workflow',
                arguments: JSON.stringify(params),
            },
        },
        result: await toolManager.executeTool('document-workflow', params, {
            ...toolContext,
            sessionId,
            toolManager,
        }),
        reason: 'Use the agent sandbox project path for a previewable HTML/document project.',
    };

    if (toolEvent.result?.success === false) {
        throw new Error(toolEvent.result?.error || 'document-workflow sandbox generation failed.');
    }

    const artifacts = extractArtifactsFromToolEvents([toolEvent]);
    if (artifacts.length === 0) {
        throw new Error('document-workflow sandbox generation completed without a reusable artifact.');
    }

    const primaryArtifact = artifacts.find((artifact) => artifact?.sandboxUrl || artifact?.bundleDownloadUrl)
        || artifacts.find((artifact) => artifact?.previewUrl)
        || artifacts[0];

    return {
        responseId: `document-workflow-${Date.now()}`,
        artifact: primaryArtifact,
        artifacts,
        outputText: String(toolEvent.result?.data?.sandboxBuild?.stdout || ''),
        model,
        assistantMessage: buildArtifactCompletionMessage(outputFormat, primaryArtifact),
        metadata: {
            agentSandbox: true,
            toolEvents: [toolEvent],
        },
    };
}

function inferRequestedOutputFormat(text = '') {
    const normalized = String(text || '').toLowerCase();
    if (!normalized) {
        return null;
    }

    const hasArtifactIntent = hasExplicitArtifactGenerationIntent(normalized);
    const hasBuildIntent = /\b(create|make|generate|build|built|produce|render|prepare|draft)\b/.test(normalized);
    const hasWebsiteArtifactSubject = (
        /\b(website|web page|webpage|html page|page|landing page|homepage|microsite|marketing site|frontend demo|front-end demo|site mockup|site prototype|browser game|web game|video game|sandboxed game|playable game|game prototype|interactive sandbox|vite preview|vite sandbox|multi step frontend|multi-step frontend)\b/.test(normalized)
        || isDashboardRequest(normalized)
    );
    const hasSandboxPreviewCue = /\b(sandbox|preview|browser preview|live preview|full screen preview|fullscreen preview)\b/.test(normalized);
    const hasPrototypeHtmlCue = /\b(demo|prototype|mockup|mock-up|wireframe|microsite)\b/.test(normalized);
    const hasExplicitHtmlCue = /\bhtml\b/.test(normalized);
    const hasExplicitHtmlOutputCue = hasExplicitHtmlCue
        && (
            hasWebsiteArtifactSubject
            || /\bhtml\s+(?:page|file|document|artifact|site|website|preview|output)\b/.test(normalized)
            || /\b(?:page|file|document|artifact|site|website|preview|output)\s+(?:as|in|to|into)\s+html\b/.test(normalized)
        );
    const hasExplicitPdfOutputCue = /\bpdf\s+(?:file|artifact|document|output|export|download|version|copy|report|brief)\b/.test(normalized)
        || /\b(?:as|to|into|in)\s+(?:a\s+)?pdf\b/.test(normalized)
        || /\bexport\s+(?:this\s+)?(?:as\s+)?(?:a\s+)?pdf\b/.test(normalized)
        || /\bmake\s+(?:me\s+)?(?:a\s+)?pdf\b/.test(normalized);
    const hasExplicitPptxCue = /\b(powerpoint|pptx?|\.(pptx|ppt)\b)\b/.test(normalized);
    const hasSlideDeckSubject = /\b(slide deck|slides?|presentation|deck)\b/.test(normalized);
    const hasInteractiveCue = /\b(interactive|clickable|animated|browser-native|web-native|playable|gameplay)\b/.test(normalized);
    const hasFrontendTemplateCue = /\b(vite|react|nextjs|frontend template|front-end template)\b/.test(normalized);
    const hasLongFormDocumentSubject = /\b(research paper|research report|research brief|whitepaper|white paper|case study|dossier|long[-\s]?form|large[-\s]?form|article|paper)\b/.test(normalized);
    const hasDocumentArtifactCue = /\b(document|doc|report|brief|paper|whitepaper|white paper|article|dossier|guide)\b/.test(normalized);
    const wantsGeneratedDocument = hasBuildIntent && (hasLongFormDocumentSubject || (hasDocumentArtifactCue && /\b(research|source|sources|citations?|evidence|visual|images?|photos?)\b/.test(normalized)));

    if ((/\b(power\s*query|\.(pq|m)\b)/.test(normalized) && hasArtifactIntent)
        || /\b(power\s*query)\s+(?:file|script|artifact|export)\b/.test(normalized)) {
        return 'power-query';
    }

    if ((/\b(xlsx|spreadsheet|excel|workbook)\b/.test(normalized) && hasArtifactIntent)
        || /\b(excel|spreadsheet|workbook)\s+(?:file|artifact|export)\b/.test(normalized)) {
        return 'xlsx';
    }

    if (hasExplicitHtmlOutputCue && (hasBuildIntent || hasArtifactIntent || hasSandboxPreviewCue) && !hasExplicitPdfOutputCue) {
        return 'html';
    }

    if (/\bpdf\b/.test(normalized) && hasArtifactIntent) {
        if (hasExplicitHtmlOutputCue && !hasExplicitPdfOutputCue) {
            return 'html';
        }
        return 'pdf';
    }

    if (/\b(docx|word document)\b/.test(normalized) && hasArtifactIntent) {
        return 'html';
    }

    if (/\bxml\b/.test(normalized) && hasArtifactIntent) {
        return 'xml';
    }

    if (hasExplicitMermaidArtifactIntent(normalized)) {
        return 'mermaid';
    }

    if ((hasArtifactIntent || hasBuildIntent || hasExplicitPptxCue) && (hasSlideDeckSubject || hasExplicitPptxCue)) {
        if (hasExplicitHtmlCue || hasInteractiveCue || hasFrontendTemplateCue || hasExplicitStandaloneHtmlIntent(normalized)) {
            return 'html';
        }

        return 'pptx';
    }

    if (isInteractiveDocumentRequest(normalized)) {
        return 'html';
    }

    if (wantsGeneratedDocument && !/\b(text only|text-only|plain text|no artifact|no file|inline only)\b/.test(normalized)) {
        return 'html';
    }

    if (hasArtifactIntent
        && hasDocumentArtifactCue
        && !/\b(text only|text-only|plain text|no artifact|no file|inline only)\b/.test(normalized)) {
        return 'html';
    }

    if (hasWebsiteArtifactSubject && (
        hasExplicitStandaloneHtmlIntent(normalized)
        || (hasExplicitHtmlCue && hasBuildIntent)
        || (hasPrototypeHtmlCue && hasBuildIntent)
        || (hasSandboxPreviewCue && hasBuildIntent)
    )) {
        return 'html';
    }

    if (hasExplicitHtmlCue && (hasBuildIntent || hasSandboxPreviewCue || hasArtifactIntent)) {
        return 'html';
    }

    if (hasWebsiteArtifactSubject && hasBuildIntent && !hasPlanningConversationIntent(normalized)) {
        return 'html';
    }

    if ((hasArtifactIntent || hasBuildIntent) && isWebsiteDesignExampleRequest(normalized)) {
        return 'html';
    }

    if (/\bhtml\b/.test(normalized) && hasArtifactIntent) {
        return 'html';
    }

    return null;
}

function isArtifactContinuationPrompt(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    if (hasImplementationTransitionIntent(normalized)
        && !hasExplicitStandaloneHtmlIntent(normalized)
        && !hasExplicitArtifactDeliveryIntent(normalized)) {
        return false;
    }

    const continuationPatterns = [
        /^(continue|finish|refine|revise|update|improve|polish|expand|edit|redo|rework)\b/,
        /\b(another pass|next pass|keep going|work on it|finish it|continue it|same one|current page content)\b/,
        /\b(the pdf|this pdf|that pdf|the document|this document|that document|the file|this file|that file)\b/,
    ];

    return continuationPatterns.some((pattern) => pattern.test(normalized));
}

function isGenericContinuationPrompt(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const genericContinuation = [
        /^(continue|finish|keep going|go ahead|next|then|retry|rerun|re-run|recheck|resume|proceed)\b/,
        /\b(keep going|go ahead|retry that|rerun that|re-run that|recheck that|keep working on it|continue now)\b/,
    ].some((pattern) => pattern.test(normalized));
    if (!genericContinuation) {
        return false;
    }

    return !/\b(artifact|file|document|html|page|markup|pdf|docx|spreadsheet|workbook|diagram|mermaid|export|download|bundle|zip)\b/i.test(normalized);
}

function hasActiveForegroundContinuationWork(session = null) {
    const controlState = getSessionControlState(session);
    if (!controlState || typeof controlState !== 'object') {
        return false;
    }

    const workflowStatus = String(controlState?.workflow?.status || '').trim().toLowerCase();
    const projectPlanStatus = String(controlState?.projectPlan?.status || '').trim().toLowerCase();
    const hasWorkflow = Boolean(controlState?.workflow) && !['completed', 'failed', 'cancelled', 'done', 'stopped'].includes(workflowStatus);
    const hasProjectPlan = Boolean(controlState?.projectPlan) && !['completed', 'cancelled', 'done'].includes(projectPlanStatus);
    const hasActiveTaskFrame = Boolean(String(controlState?.activeTaskFrame?.objective || '').trim());
    const hasContinuationGate = controlState?.foregroundContinuationGate?.paused === true;
    const hasRemoteContinuation = Boolean(
        String(controlState?.lastRemoteObjective || '').trim()
        || controlState?.lastSshTarget?.host
        || controlState?.remoteWorkingState?.target?.host
        || String(controlState?.remoteWorkingState?.lastCommand || '').trim()
        || String(controlState?.remoteWorkingState?.lastError || '').trim(),
    );

    return hasWorkflow
        || hasProjectPlan
        || hasActiveTaskFrame
        || hasContinuationGate
        || hasRemoteContinuation;
}

function hasImplementationTransitionIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /\b(start|begin|kick off|move|switch)\b[\s\S]{0,24}\b(making|building|implementing|coding|developing|working)\b/,
        /\b(start|begin|go ahead and|let'?s|lets|can you|please)\b[\s\S]{0,24}\b(build|make|implement|code|develop|wire up|ship)\b[\s\S]{0,24}\b(it|this|that|the app|the site|the website|the landing page|the product|the project|the implementation)\b/,
        /\b(move|switch)\b[\s\S]{0,24}\b(into|to)\b[\s\S]{0,24}\b(implementation|building|coding|development)\b/,
        /\b(make it real|actually build it|actually make it|turn this into the real)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasImplicitArtifactFollowupReference(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    if (hasImplementationTransitionIntent(normalized)
        && !hasExplicitStandaloneHtmlIntent(normalized)
        && !hasExplicitArtifactDeliveryIntent(normalized)) {
        return false;
    }

    if (isArtifactContinuationPrompt(normalized)) {
        return true;
    }

    return /\b(last|latest|generated|previous|prior|same|that|this|current)\b[\s\S]{0,40}\b(artifact|file|document|html|page|markup|pdf|docx|spreadsheet|workbook|diagram|mermaid|export|download)\b/i.test(normalized)
        || /\b(artifact|generated html|generated page|generated file|download link|download url|export file|html artifact|pdf artifact|docx artifact|spreadsheet artifact)\b/i.test(normalized);
}

function hasImplicitImageArtifactFollowupReference(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(last|generated|previous|prior|same|those|these|this|earlier|above)\b[\s\S]{0,40}\b(images?|photos?|pictures?|illustrations?|renders?)\b/i.test(normalized)
        || /\b(images?|photos?|pictures?|illustrations?|renders?)\b[\s\S]{0,60}\b(from earlier|from before|from above|you made|you generated|we generated|from the last turn)\b/i.test(normalized)
        || /\b(use|put|place|include|embed|make|turn|convert|compile)\b[\s\S]{0,40}\b(those|these|the generated|the previous|the earlier)\b[\s\S]{0,20}\b(images?|photos?|pictures?)\b/i.test(normalized)
        || /\b(make|use|set|place|turn)\b[\s\S]{0,30}\b(this|that|it|the generated|the previous|the earlier|same)\b[\s\S]{0,30}\b(static\s+)?(background|hero|backdrop|wallpaper)\b/i.test(normalized)
        || /\b(this|that|it|the generated|the previous|the earlier|same)\b[\s\S]{0,30}\b(static\s+)?(background|hero|backdrop|wallpaper)\b/i.test(normalized);
}

function hasImplicitUploadedImageArtifactReference(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(uploaded|attached|selected|provided|sent)\b[\s\S]{0,50}\b(images?|photos?|pictures?|screenshots?)\b/i.test(normalized)
        || /\b(images?|photos?|pictures?|screenshots?)\b[\s\S]{0,50}\b(uploaded|attached|selected|provided|sent)\b/i.test(normalized)
        || /\b(this|that|the|my)\b[\s\S]{0,20}\b(images?|photos?|pictures?|screenshots?)\b/i.test(normalized)
        || /\b(describe|analy[sz]e|inspect|read|look at|what'?s in|what is in)\b[\s\S]{0,30}\b(this|that|it|the upload|the attachment)\b/i.test(normalized);
}

function hasImplicitUploadedArtifactReference(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const uploadCue = /\b(uploaded|attached|selected|provided|sent|dropped|added)\b/i;
    const sourceCue = /\b(files?|documents?|docs?|pdfs?|attachments?|uploads?|artifacts?|sources?|materials?|spreadsheets?|sheets?|csvs?|reports?|slides?|decks?|presentations?)\b/i;
    return (uploadCue.test(normalized) && sourceCue.test(normalized))
        || /\b(this|that|these|those|the|my)\b[\s\S]{0,20}\b(files?|documents?|docs?|pdfs?|attachments?|uploads?|artifacts?|sources?|materials?)\b/i.test(normalized)
        || /\b(from|using|use|with|based on|turn|make|create|generate|produce)\b[\s\S]{0,50}\b(the\s+)?(uploaded|attached|provided|selected|sent)\b[\s\S]{0,40}\b(files?|documents?|docs?|pdfs?|attachments?|uploads?|artifacts?|sources?|materials?)\b/i.test(normalized)
        || /\b(genetec|ccure|c[-\s]?cure)\b[\s\S]{0,60}\b(files?|documents?|docs?|pdfs?|attachments?|uploads?|artifacts?|sources?|materials?)\b/i.test(normalized)
        || /\b(files?|documents?|docs?|pdfs?|attachments?|uploads?|artifacts?|sources?|materials?)\b[\s\S]{0,60}\b(genetec|ccure|c[-\s]?cure)\b/i.test(normalized);
}

function hasExplicitImageGenerationIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    if (hasImplicitImageArtifactFollowupReference(normalized)) {
        const hasDirectImageAuthoringCue = /\b(generate|create|make|render|design|draw|illustrate|produce|craft)\b[\s\S]{0,50}\b(image|images|photo|photos|picture|pictures|illustration|illustrations|render|renders|artwork|cover image|cover art|poster)\b[\s\S]{0,24}\b(of|showing|depicting|featuring|based on)\b/i.test(normalized)
            || /\b(new|another|fresh|more)\s+(images?|photos?|pictures?|illustrations?|renders?)\b/i.test(normalized)
            || /\b(generate|create|render|design|draw|illustrate|produce|craft)\b[\s\S]{0,24}\b(new|another|fresh|more)\b[\s\S]{0,24}\b(images?|photos?|pictures?|illustrations?|renders?)\b/i.test(normalized);
        if (!hasDirectImageAuthoringCue) {
            return false;
        }
    }

    return /\b(generate|create|make|render|design|draw|illustrate|produce|craft)\b[\s\S]{0,50}\b(image|images|photo|photos|picture|pictures|illustration|illustrations|render|renders|artwork|cover image|cover art|poster)\b/i.test(normalized)
        || /\b(text[-\s]?to[-\s]?image|image generation)\b/i.test(normalized)
        || /\b(image|photo|picture|illustration|render|artwork|poster)\b[\s\S]{0,20}\b(of|showing|depicting|featuring)\b/i.test(normalized);
}

function shouldPreGenerateImagesForArtifactRequest({
    text = '',
    outputFormat = null,
} = {}) {
    const normalizedFormat = normalizeFormat(outputFormat);
    const normalized = String(text || '').trim().toLowerCase();
    if (!['pdf', 'html'].includes(normalizedFormat)) {
        return false;
    }

    if (hasExplicitImageGenerationIntent(normalized)) {
        return true;
    }

    const referencesPriorImages = /\b(those|these|this|that|it|previous|prior|earlier|above|same)\b[\s\S]{0,40}\b(images?|photos?|pictures?|illustrations?|renders?|visuals?|background|hero|backdrop)\b/i.test(normalized)
        || /\b(images?|photos?|pictures?|illustrations?|renders?|visuals?)\b[\s\S]{0,60}\b(from earlier|from before|from above|you made|you generated|we generated|from the last turn)\b/i.test(normalized);

    if (normalizedFormat === 'html'
        && /\b(website|web page|webpage|landing page|homepage|microsite|frontend|site)\b/.test(normalized)
        && /\b(generate|generated|generative|ai[-\s]?generated|ai image|custom|create|created|make|made)\b[\s\S]{0,40}\b(images?|photos?|pictures?|illustrations?|renders?|visuals?)\b/i.test(normalized)
        && !referencesPriorImages
        && !hasImplicitUploadedImageArtifactReference(normalized)) {
        return true;
    }

    return false;
}

function parseRequestedImageCountToken(value = '', fallback = null) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return fallback;
    }

    if (/^\d+$/.test(normalized)) {
        return Math.min(Math.max(Number(normalized), 1), 5);
    }

    if (IMAGE_COUNT_WORDS.has(normalized)) {
        return Math.min(Math.max(IMAGE_COUNT_WORDS.get(normalized), 1), 5);
    }

    return fallback;
}

function singularizeImageNoun(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return 'image';
    }

    const singularMap = {
        images: 'image',
        image: 'image',
        photos: 'photo',
        photo: 'photo',
        pictures: 'picture',
        picture: 'picture',
        illustrations: 'illustration',
        illustration: 'illustration',
        renders: 'render',
        render: 'render',
    };

    return singularMap[normalized] || 'image';
}

function extractRequestedImageCount(text = '', fallback = 1) {
    const prompt = String(text || '').trim();
    if (!prompt) {
        return fallback;
    }

    const patterns = [
        /\b(?<count>\d+|one|two|three|four|five)\s+(?:different\s+|distinct\s+|separate\s+)?(?:images?|photos?|pictures?|illustrations?|renders?)\b/i,
        /\b(?:a\s+)?(?<count>couple|few)\s+of?\s*(?:different\s+|distinct\s+|separate\s+)?(?:images?|photos?|pictures?|illustrations?|renders?)\b/i,
        /\b(?<count>multiple|several)\s+(?:different\s+|distinct\s+|separate\s+)?(?:images?|photos?|pictures?|illustrations?|renders?)\b/i,
        /^\s*(?:make|create|generate|build|produce|prepare|render|design|draw|illustrate|craft)\b(?:\s+(?:me|us))?\s+(?<count>\d+|one|two|three|four|five|multiple|several|(?:a\s+)?couple|(?:a\s+)?few)\b/i,
    ];

    for (const pattern of patterns) {
        const match = prompt.match(pattern);
        const token = String(match?.groups?.count || '').trim().replace(/^a\s+/i, '');
        const parsed = parseRequestedImageCountToken(token, null);
        if (parsed != null) {
            return parsed;
        }
    }

    return fallback;
}

function stripRequestedImageBatchLanguage(text = '', requestedCount = 1) {
    let cleaned = String(text || '').trim();
    if (!cleaned || requestedCount <= 1) {
        return cleaned;
    }

    cleaned = cleaned.replace(
        /^\s*(?<verb>make|create|generate|build|produce|prepare|render|design|draw|illustrate|craft)\s+(?:me\s+|us\s+)?(?:a\s+couple\s+of|a\s+few|multiple|several|\d+|one|two|three|four|five)\s+(?<subject>.+?)\s+(?<noun>images?|photos?|pictures?|illustrations?|renders?)\b/i,
        (_match, verb, subject, noun) => {
            const normalizedSubject = String(subject || '')
                .replace(/^(?:different|distinct|separate)\s+/i, '')
                .trim();
            return `${verb} ${normalizedSubject} ${singularizeImageNoun(noun)}`.trim();
        },
    );

    cleaned = cleaned.replace(
        /\b(?:a\s+couple\s+of|a\s+few|multiple|several|\d+|one|two|three|four|five)\s+(?:different\s+|distinct\s+|separate\s+)?(?<noun>images?|photos?|pictures?|illustrations?|renders?)\b/gi,
        (_match, noun) => `an ${singularizeImageNoun(noun)}`,
    );

    return cleaned
        .replace(/\ban image\b/gi, 'an image')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildImagePromptFromArtifactRequest(text = '') {
    const prompt = String(text || '').trim();
    if (!prompt) {
        return '';
    }

    let cleaned = prompt
        .replace(/\b(?:and then|then|and)?\s*(?:put|place|embed|include|insert|compile|turn|convert)\b[\s\S]*$/i, '')
        .replace(/\b(?:for|into|in|as)\s+(?:an?\s+)?(?:pdf|docx|html|document|page|file|artifact|brochure|booklet|report|brief)\b[\s\S]*$/i, '')
        .replace(/\b(?:make|create|generate|build|produce|prepare)\b[\s\S]{0,20}\b(?:a|an)\s+(?:pdf|docx|html|document|page|file|artifact)\b[\s\S]*$/i, '')
        .trim();

    if (!cleaned || cleaned.length < 12) {
        cleaned = prompt;
    }

    return stripRequestedImageBatchLanguage(cleaned, extractRequestedImageCount(prompt, 1));
}

function promptHasExplicitSshIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\bssh\b/.test(normalized)
        || /\b(remote host|remote server|remote machine)\b/.test(normalized)
        || /\b(remote cli|remote command|run remotely|execute remotely)\b/.test(normalized)
        || /\bremote cli into\b/.test(normalized)
        || /\bremote into\b/.test(normalized)
        || /\b(login to|log into|ssh into|ssh to|connect to)\b/.test(normalized);
}

function hasExplicitSshTargetCue(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return promptHasExplicitSshIntent(normalized)
        || /\b(host|server|machine|node|target)\b/.test(normalized);
}

function isFileLikeSshTargetHost(host = '') {
    const normalized = String(host || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const blockedExtensions = new Set([
        'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
        'json', 'yaml', 'yml', 'xml', 'txt', 'md', 'pdf',
        'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
    ]);

    const lastLabel = normalized.split('.').pop() || '';
    return blockedExtensions.has(lastLabel);
}

function isPublicGitProviderSshHost(host = '') {
    const normalized = String(host || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        'github.com',
        'ssh.github.com',
        'gist.github.com',
        'gitlab.com',
        'bitbucket.org',
    ].includes(normalized);
}

function hasImmediateSshTargetContext(text = '', matchIndex = 0) {
    const source = String(text || '');
    const prefix = source.slice(Math.max(0, matchIndex - 48), Math.max(0, matchIndex)).toLowerCase();
    if (!prefix) {
        return false;
    }

    return /\b(?:ssh(?:\s+into|\s+to)?|connect(?:\s+to)?|login(?:\s+to)?|log\s+into|remote cli(?:\s+into|\s+on)?|remote command(?:\s+into|\s+on)?|execute(?:\s+on|\s+against)?|run(?:\s+on|\s+against)?|targeting|target|host|server|machine|node)\b[\s\S]{0,24}$/.test(prefix);
}

function extractExplicitSshTarget(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return null;
    }

    if (!hasExplicitSshTargetCue(normalized)) {
        return null;
    }

    const candidates = normalized.matchAll(/\b(?:(?<username>[a-zA-Z0-9._-]+)@)?(?<host>(?:\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?::(?<port>\d{2,5}))?\b/g);

    for (const match of candidates) {
        const host = match?.groups?.host || '';
        if (!host || isSuspiciousSshTargetHost(host) || isFileLikeSshTargetHost(host)) {
            continue;
        }

        if (match?.groups?.username && !hasImmediateSshTargetContext(normalized, match.index || 0)) {
            continue;
        }

        return {
            host,
            username: match.groups.username || null,
            port: match.groups.port ? Number(match.groups.port) : null,
        };
    }

    return null;
}

function extractRequestedSshCommand(text = '') {
    const prompt = String(text || '').trim();
    if (!prompt) {
        return null;
    }
    const normalized = prompt.toLowerCase();
    const hasInspectionIntent = /\b(check|inspect|verify|diagnose|debug|troubleshoot|status|state|health|healthy|look at|show|list|see what'?s wrong)\b/.test(normalized);
    const hasReportIntent = /\b(report|summary|overview)\b/.test(normalized);
    const hasRemoteTarget = /\b(remote server|remote host|remote machine|server|host|cluster|k3s|k8s|kubernetes)\b/.test(normalized);
    const hasClusterTarget = /\b(cluster|k3s|k8s|kubernetes|kubectl|nodes?|pods?|namespaces?)\b/.test(normalized);
    const hasRemoteStatusQuestion = hasRemoteTarget && (
        /\b(how'?s|hows|how is|how are|what'?s|what is)\b[\s\S]{0,60}\b(remote server|remote host|remote machine|server|host|cluster|k3s|k8s|kubernetes)\b/.test(normalized)
        || /\b(remote server|remote host|remote machine|server|host|cluster|k3s|k8s|kubernetes)\b[\s\S]{0,50}\b(doing|status|state|health|healthy|uptime|running|reachable|alive|ok|okay)\b/.test(normalized)
        || /\b(status|state|health|healthy|uptime|running|reachable|alive|ok|okay)\b[\s\S]{0,50}\b(remote server|remote host|remote machine|server|host|cluster|k3s|k8s|kubernetes)\b/.test(normalized)
    );

    const quotedPatterns = [
        /\b(?:run|execute)\s+`([^`]+)`/i,
        /\b(?:run|execute)\s+"([^"]+)"/i,
        /\b(?:run|execute)\s+'([^']+)'/i,
    ];

    for (const pattern of quotedPatterns) {
        const match = prompt.match(pattern);
        if (match?.[1]) {
            return match[1].trim();
        }
    }

    if (/\b(?:check|show|get|display|what(?:'s| is))\b[\s\S]{0,24}\b(?:time|clock)\b/i.test(prompt)
        || /\b(?:server|host|remote)\s+time\b/i.test(prompt)) {
        return 'date';
    }

    if (!hasClusterTarget && ((hasInspectionIntent && hasReportIntent)
        || /\bhealth report\b/i.test(prompt)
        || /\bserver state\b/i.test(prompt)
        || /\bstate report\b/i.test(prompt)
        || /\bhealth summary\b/i.test(prompt))) {
        return 'hostname && uptime && (df -h / || true) && (free -m || true)';
    }

    if (hasInspectionIntent && /\b(?:namespace|namespaces)\b/i.test(prompt) && /\b(kubernetes|k8s|cluster|kubectl)\b/i.test(prompt)) {
        return 'kubectl get namespaces';
    }

    if (hasInspectionIntent && /\b(?:pod|pods)\b/i.test(prompt) && /\b(kubernetes|k8s|cluster|kubectl)\b/i.test(prompt)) {
        return 'kubectl get pods -A';
    }

    if (!hasClusterTarget && (/\b(?:check|inspect|verify|look at)\b[\s\S]{0,40}\b(?:health|status)\b/i.test(prompt)
        || /\bhealth check\b/i.test(prompt)
        || hasRemoteStatusQuestion)) {
        return 'hostname && uptime && (df -h / || true) && (free -m || true)';
    }

    return null;
}

function getConfiguredSshTarget() {
    const sshConfig = settingsController.getEffectiveSshConfig();
    if (!sshConfig?.enabled || !sshConfig?.host) {
        return null;
    }

    return {
        host: String(sshConfig.host || '').trim(),
        username: String(sshConfig.username || '').trim() || null,
        port: Number(sshConfig.port) || 22,
    };
}

function isSuspiciousSshTargetHost(host = '') {
    const normalized = String(host || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    if (/[\s{}"'`$\\/]/.test(normalized) || /^https?:\/\//.test(normalized)) {
        return true;
    }

    return isPublicGitProviderSshHost(normalized)
        || /^(?:web-fetch|web-search|web-scrape|file-read|file-search|file-write|remote-command|ssh-execute|docker-exec|tool-doc-read|code-sandbox)(?:\.[a-z0-9_-]+)+$/i.test(normalized)
        || /^(?:result|results|data|response|output|tool)(?:\.[a-z0-9_-]+)+$/i.test(normalized);
}

function isSshHostnameResolutionFailure(error = '') {
    const normalized = String(error || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /could not resolve hostname/i.test(normalized)
        || /name or service not known/i.test(normalized)
        || /temporary failure in name resolution/i.test(normalized);
}

function hasRecentRemoteWorkingState(session = null) {
    const remoteWorkingState = getSessionControlState(session).remoteWorkingState;
    if (!remoteWorkingState || typeof remoteWorkingState !== 'object') {
        return false;
    }

    const lastUpdated = Date.parse(remoteWorkingState.lastUpdated || '');
    if (Number.isFinite(lastUpdated)) {
        return (Date.now() - lastUpdated) <= REMOTE_CONTINUATION_MAX_AGE_MS;
    }

    return Boolean(
        remoteWorkingState?.target?.host
        || remoteWorkingState?.lastCommand
        || remoteWorkingState?.lastError,
    );
}

function isSshContinuationPrompt(text = '', { allowGenericContinuation = false } = {}) {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const genericContinuation = /^(continue|finish|keep going|go ahead|next|then|retry|rerun|re-run|recheck)\b/.test(normalized)
        || /\b(keep going|go ahead|retry that|rerun that|re-run that|recheck that|keep working on it)\b/.test(normalized);
    const remoteSpecificLanguage = /\b(ssh|server|host|cluster|k3s|k8s|kubernetes|kubectl|node|namespace|pod|deployment|service|container|docker|helm|traefik|ingress|tls|ssl|acme|let'?s encrypt|certificate|cert|journalctl|systemctl|restart|rollout|daemonset|statefulset|logs?|tunnel)\b/.test(normalized)
        || /\b(deployed|live|production)\b[\s\S]{0,20}\b(site|app|service)\b/.test(normalized);

    return remoteSpecificLanguage || (allowGenericContinuation && genericContinuation);
}

function formatSshTarget(target = {}) {
    if (!target?.host) {
        return '';
    }

    const username = target.username ? `${target.username}@` : '';
    const port = target.port && Number(target.port) !== 22 ? `:${target.port}` : '';
    return `${username}${target.host}${port}`;
}

function isRemoteCommandToolId(toolId = '') {
    const normalized = String(toolId || '').trim().toLowerCase();
    return normalized === 'ssh-execute' || normalized === 'remote-command' || normalized === 'remote-cli-agent';
}

function canonicalizeRemoteToolId(toolId = '') {
    return isRemoteCommandToolId(toolId) ? 'remote-command' : String(toolId || '').trim();
}

function previewRemoteText(value = '', limit = 240) {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }

    return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function detectRemoteArchitecture(text = '') {
    const normalized = String(text || '').toLowerCase();

    if (/\b(aarch64|arm64)\b/.test(normalized)) {
        return 'arm64';
    }

    if (/\b(x86_64|amd64)\b/.test(normalized)) {
        return 'amd64';
    }

    return null;
}

function detectRemoteOs(text = '') {
    const source = String(text || '');
    const prettyName = source.match(/PRETTY_NAME="?([^"\r\n]+)"?/i);
    if (prettyName?.[1]) {
        return previewRemoteText(prettyName[1], 120);
    }

    const name = source.match(/\bNAME="?([^"\r\n]+)"?/i);
    const version = source.match(/\bVERSION="?([^"\r\n]+)"?/i);
    const parts = [name?.[1], version?.[1]].filter(Boolean);
    return parts.length > 0 ? previewRemoteText(parts.join(' '), 120) : null;
}

function buildRemoteWorkingStateFromEvent(event = {}, parsedArgs = {}, { host = null, username = null, port = null } = {}) {
    const result = event?.result || {};
    const data = result?.data || {};
    const command = String(parsedArgs?.command || '').trim();
    const stdout = previewRemoteText(data?.stdout || '', 320);
    const stderr = previewRemoteText(data?.stderr || '', 240);
    const combinedOutput = [command, data?.stdout || '', data?.stderr || ''].join('\n');
    const detectedArchitecture = detectRemoteArchitecture(combinedOutput);
    const detectedOs = detectRemoteOs(combinedOutput);
    const target = host
        ? {
            host,
            ...(username ? { username } : {}),
            port: port || 22,
        }
        : null;

    return {
        lastUpdated: result?.timestamp || new Date().toISOString(),
        toolId: canonicalizeRemoteToolId(event?.toolCall?.function?.name || result?.toolId || ''),
        ...(target ? { target } : {}),
        ...(command ? { lastCommand: command } : {}),
        lastCommandSucceeded: result?.success !== false,
        ...(Number.isInteger(data?.exitCode) ? { lastExitCode: data.exitCode } : {}),
        ...(result?.success === false && result?.error ? { lastError: previewRemoteText(result.error, 200) } : {}),
        ...(stdout ? { lastStdoutPreview: stdout } : {}),
        ...(stderr ? { lastStderrPreview: stderr } : {}),
        ...(detectedArchitecture ? { detectedArchitecture } : {}),
        ...(detectedOs ? { detectedOs } : {}),
    };
}

function getPreferredRemoteToolId(toolManager = null) {
    if (typeof toolManager?.getTool === 'function') {
        if (toolManager.getTool('remote-command')) {
            return 'remote-command';
        }

        if (toolManager.getTool('ssh-execute')) {
            return 'ssh-execute';
        }
    }

    return 'remote-command';
}

function resolveSshRequestContext(text = '', session = null) {
    const prompt = String(text || '').trim();
    const normalizedPrompt = prompt.toLowerCase();
    const controlState = getSessionControlState(session);
    const explicitIntent = promptHasExplicitSshIntent(prompt);
    const explicitTarget = extractExplicitSshTarget(prompt);
    const configuredTarget = getConfiguredSshTarget();
    const sessionTarget = controlState.lastSshTarget || null;
    const safeSessionTarget = sessionTarget?.host && !isSuspiciousSshTargetHost(sessionTarget.host)
        ? sessionTarget
        : null;
    const target = explicitTarget
        || safeSessionTarget
        || configuredTarget
        || null;
    const stickySsh = isRemoteCommandToolId(controlState.lastToolIntent);
    const continuation = !explicitIntent
        && stickySsh
        && target?.host
        && isSshContinuationPrompt(prompt, {
            allowGenericContinuation: hasRecentRemoteWorkingState(session),
        });
    const retryLikeExplicitContinuation = explicitIntent
        && stickySsh
        && target?.host
        && /\b(try again|retry|rerun|re-run|recheck)\b/.test(normalizedPrompt);
    const effectivePrompt = continuation
        || retryLikeExplicitContinuation
        ? `SSH into ${formatSshTarget(target)} and ${prompt}`
        : prompt;
    const retryLikeContinuation = (continuation || retryLikeExplicitContinuation)
        && /\b(try again|retry|rerun|re-run|recheck)\b/.test(normalizedPrompt);
    const previousCommand = String(controlState?.remoteWorkingState?.lastCommand || '').trim();
    const command = extractRequestedSshCommand(effectivePrompt)
        || (retryLikeContinuation && previousCommand ? previousCommand : null);

    return {
        explicitIntent,
        continuation: continuation || retryLikeExplicitContinuation,
        shouldTreatAsSsh: explicitIntent || continuation || retryLikeExplicitContinuation,
        effectivePrompt,
        target,
        command,
        directParams: target?.host && command
            ? {
                host: target.host,
                ...(target.username ? { username: target.username } : {}),
                ...(target.port ? { port: target.port } : {}),
                command,
            }
            : null,
    };
}

function formatSshToolResult(result = {}, fallbackTarget = null) {
    if (!result?.success) {
        return `SSH request failed: ${result?.error || 'Unknown SSH error'}`;
    }

    const host = result?.data?.host || formatSshTarget(fallbackTarget) || 'remote host';
    const stdout = String(result?.data?.stdout || '').trim();
    const stderr = String(result?.data?.stderr || '').trim();
    const sections = [`SSH command completed on ${host}.`];

    if (stdout) {
        sections.push(`STDOUT:\n${stdout}`);
    }

    if (stderr) {
        sections.push(`STDERR:\n${stderr}`);
    }

    return sections.join('\n\n');
}

function extractSshSessionMetadataFromToolEvents(toolEvents = []) {
    const events = Array.isArray(toolEvents) ? toolEvents : [];
    let fallbackMetadata = null;

    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const rawToolName = String(event?.toolCall?.function?.name || event?.result?.toolId || '').trim();
        if (rawToolName === 'remote-cli-agent') {
            const args = parseLenientJson(event?.toolCall?.function?.arguments || '{}') || {};
            const data = event?.result?.data && typeof event.result.data === 'object' ? event.result.data : {};
            const task = String(args.task || '').trim();
            const remoteCliAgent = {
                ...(task ? { lastTask: task } : {}),
                lastTaskAt: new Date().toISOString(),
                ...(event?.result?.success === false
                    ? {
                        lastFailure: {
                            task,
                            reason: String(event?.result?.error || 'remote-cli-agent failed').trim(),
                            failedAt: new Date().toISOString(),
                        },
                    }
                    : {}),
                ...(data.sessionId ? { sessionId: data.sessionId } : {}),
                ...(data.mcpSessionId ? { mcpSessionId: data.mcpSessionId } : {}),
                ...(data.targetId ? { targetId: data.targetId } : {}),
                ...(data.cwd || args.cwd ? { cwd: data.cwd || args.cwd } : {}),
                ...(data.remoteCodeSessionId ? { remoteCodeSessionId: data.remoteCodeSessionId } : {}),
                ...(data.remoteCodeJobId ? { remoteCodeJobId: data.remoteCodeJobId } : {}),
                ...(data.gitRepo ? { gitRepo: data.gitRepo } : {}),
                ...(data.gitBranch ? { gitBranch: data.gitBranch } : {}),
                ...(data.gitBaseCommit ? { gitBaseCommit: data.gitBaseCommit } : {}),
                ...(data.gitCommit ? { gitCommit: data.gitCommit } : {}),
                ...(Array.isArray(data.changedFiles) && data.changedFiles.length > 0 ? { changedFiles: data.changedFiles } : {}),
                ...(data.deployment ? { deployment: data.deployment } : {}),
                ...(data.publicHost ? { publicHost: data.publicHost } : {}),
                ...(data.publicUrl ? { publicUrl: data.publicUrl } : {}),
                ...(data.uiCheckReport ? { uiCheckReport: data.uiCheckReport } : {}),
                ...(Array.isArray(data.uiScreenshots) && data.uiScreenshots.length > 0 ? { uiScreenshots: data.uiScreenshots } : {}),
                ...(data.whatChanged ? { whatChanged: data.whatChanged } : {}),
                ...(data.supportAgentRequest ? { supportAgentRequest: data.supportAgentRequest } : {}),
                ...(data.supportAgentContext ? { supportAgentContext: data.supportAgentContext } : {}),
                ...(Array.isArray(data.verifyCommands) && data.verifyCommands.length > 0 ? { verifyCommands: data.verifyCommands } : {}),
                ...(Array.isArray(data.verifyResults) && data.verifyResults.length > 0 ? { verifyResults: data.verifyResults } : {}),
                ...(data.blocker ? { blocker: data.blocker } : {}),
                ...(data.completionStatus ? { completionStatus: data.completionStatus } : {}),
                ...(data.model ? { model: data.model } : {}),
            };

            return {
                lastToolIntent: 'remote-cli-agent',
                remoteCliAgent,
            };
        }

        const toolName = canonicalizeRemoteToolId(event?.toolCall?.function?.name);
        if (!isRemoteCommandToolId(toolName)) {
            continue;
        }

        const args = parseLenientJson(event?.toolCall?.function?.arguments || '{}') || {};
        const hostField = String(event?.result?.data?.host || '').trim();
        const hostMatch = hostField.match(/^(?<host>[^:]+)(?::(?<port>\d+))?$/);
        const hostFromResult = hostMatch?.groups?.host && !isSuspiciousSshTargetHost(hostMatch.groups.host)
            ? hostMatch.groups.host
            : null;
        const hostFromArgs = args.host && !isSuspiciousSshTargetHost(args.host)
            ? String(args.host).trim()
            : null;
        const resolutionFailure = event?.result?.success === false && isSshHostnameResolutionFailure(event?.result?.error || '');
        const host = hostFromResult || (!resolutionFailure ? hostFromArgs : null);
        const port = args.port || (hostMatch?.groups?.port ? Number(hostMatch.groups.port) : null);
        const username = args.username || null;
        const remoteWorkingState = buildRemoteWorkingStateFromEvent(event, args, {
            host,
            username,
            port,
        });

        if (!host) {
            fallbackMetadata = fallbackMetadata || {
                lastToolIntent: toolName,
                remoteWorkingState,
            };
            continue;
        }

        return {
            lastToolIntent: toolName,
            lastSshTarget: {
                host,
                username,
                port: port || 22,
            },
            remoteWorkingState,
        };
    }

    return fallbackMetadata;
}

function inferOutputFormatFromSession(text = '', session = null) {
    const lastOutputFormat = normalizeFormat(session?.metadata?.lastOutputFormat || '');
    const lastGeneratedArtifactId = session?.metadata?.lastGeneratedArtifactId || '';
    if (!lastOutputFormat || !lastGeneratedArtifactId) {
        return null;
    }

    if (hasImplementationTransitionIntent(text)
        && !hasExplicitStandaloneHtmlIntent(text)
        && !hasExplicitArtifactDeliveryIntent(text)) {
        return null;
    }

    if (isGenericContinuationPrompt(text) && hasActiveForegroundContinuationWork(session)) {
        return null;
    }

    if (lastOutputFormat === 'mermaid') {
        const normalized = String(text || '').trim().toLowerCase();
        if (!normalized) {
            return null;
        }

        const mermaidContinuation = /\b(mermaid|diagram|flowchart|sequence diagram|erd|entity relationship|class diagram|state diagram|artifact|file|export)\b/i.test(normalized);
        return (isArtifactContinuationPrompt(normalized) && mermaidContinuation) ? lastOutputFormat : null;
    }

    return isArtifactContinuationPrompt(text) ? lastOutputFormat : null;
}

function resolveArtifactContextIds(session = null, artifactIds = [], text = '') {
    if (Array.isArray(artifactIds) && artifactIds.length > 0) {
        return artifactIds;
    }

    if (hasExplicitImageGenerationIntent(text)) {
        return [];
    }

    const lastGeneratedImageArtifactIds = Array.isArray(session?.metadata?.lastGeneratedImageArtifactIds)
        ? session.metadata.lastGeneratedImageArtifactIds.filter((entry) => typeof entry === 'string' && entry.trim())
        : [];
    if (lastGeneratedImageArtifactIds.length > 0 && hasImplicitImageArtifactFollowupReference(text)) {
        return lastGeneratedImageArtifactIds;
    }

    const lastUploadedImageArtifactIds = Array.isArray(session?.metadata?.lastUploadedImageArtifactIds)
        ? session.metadata.lastUploadedImageArtifactIds.filter((entry) => typeof entry === 'string' && entry.trim())
        : [];
    if (lastUploadedImageArtifactIds.length > 0 && hasImplicitUploadedImageArtifactReference(text)) {
        return lastUploadedImageArtifactIds;
    }

    const lastUploadedArtifactIds = Array.isArray(session?.metadata?.lastUploadedArtifactIds)
        ? session.metadata.lastUploadedArtifactIds.filter((entry) => typeof entry === 'string' && entry.trim())
        : [];
    if (lastUploadedArtifactIds.length > 0 && hasImplicitUploadedArtifactReference(text)) {
        return lastUploadedArtifactIds;
    }

    const lastGeneratedArtifactId = session?.metadata?.lastGeneratedArtifactId;
    return lastGeneratedArtifactId && hasImplicitArtifactFollowupReference(text)
        ? [lastGeneratedArtifactId]
        : [];
}

function isVisionInputArtifact(artifact = null) {
    const mimeType = String(artifact?.mimeType || '').trim().toLowerCase().split(';')[0];
    const extension = String(artifact?.extension || artifact?.format || '').trim().toLowerCase();

    return OPENAI_VISION_INPUT_MIME_TYPES.has(mimeType)
        || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension);
}

function normalizeVisionInputMimeType(artifact = null) {
    const mimeType = String(artifact?.mimeType || '').trim().toLowerCase().split(';')[0];
    if (OPENAI_VISION_INPUT_MIME_TYPES.has(mimeType)) {
        return mimeType;
    }

    const extension = String(artifact?.extension || artifact?.format || '').trim().toLowerCase();
    if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
    if (extension === 'png') return 'image/png';
    if (extension === 'gif') return 'image/gif';
    if (extension === 'webp') return 'image/webp';
    return '';
}

function normalizeUserInputContentParts(content = null, text = '') {
    const normalizedText = String(text || '');
    if (!Array.isArray(content)) {
        return [{ type: 'input_text', text: normalizedText }];
    }

    const parts = [];
    let insertedText = false;

    content.forEach((part) => {
        if (typeof part === 'string') {
            if (!insertedText) {
                parts.push({ type: 'input_text', text: normalizedText });
                insertedText = true;
            }
            return;
        }

        if (!part || typeof part !== 'object') {
            return;
        }

        if (['text', 'input_text', 'output_text'].includes(String(part.type || ''))) {
            if (!insertedText) {
                parts.push({ type: 'input_text', text: normalizedText });
                insertedText = true;
            }
            return;
        }

        if (part.type === 'input_image') {
            parts.push({
                type: 'input_image',
                ...(part.file_id ? { file_id: part.file_id } : {}),
                ...(part.image_url ? { image_url: part.image_url } : {}),
                detail: part.detail || 'auto',
            });
            return;
        }

        if (part.type === 'image_url' || part.image_url || part.imageUrl || part.url) {
            const imageUrl = typeof part.image_url === 'object'
                ? part.image_url.url
                : (part.image_url || part.imageUrl || part.url);
            if (imageUrl) {
                parts.push({
                    type: 'input_image',
                    image_url: imageUrl,
                    detail: part.detail || 'auto',
                });
            }
        }
    });

    if (!insertedText) {
        parts.unshift({ type: 'input_text', text: normalizedText });
    }

    return parts;
}

async function buildUserInputWithImageArtifacts({
    sessionId = '',
    text = '',
    content = null,
    artifactIds = [],
    detail = 'auto',
} = {}) {
    const normalizedText = String(text || '');
    const baseParts = Array.isArray(content)
        ? normalizeUserInputContentParts(content, normalizedText)
        : null;
    const ids = Array.from(new Set(
        (Array.isArray(artifactIds) ? artifactIds : [])
            .map((artifactId) => String(artifactId || '').trim())
            .filter(Boolean),
    )).slice(0, 4);

    if (!sessionId || ids.length === 0) {
        return baseParts && baseParts.some((part) => part.type === 'input_image')
            ? baseParts
            : normalizedText;
    }

    const imageParts = [];
    for (const artifactId of ids) {
        let artifact = null;
        try {
            artifact = await artifactService.getArtifact(artifactId, { includeContent: true });
        } catch (error) {
            console.warn(`[Artifacts] Failed to load image artifact ${artifactId} for vision input: ${error.message}`);
            continue;
        }

        if (!artifact || artifact.sessionId !== sessionId || !artifact.contentBuffer || !isVisionInputArtifact(artifact)) {
            continue;
        }

        const mimeType = normalizeVisionInputMimeType(artifact);
        if (!mimeType) {
            continue;
        }

        imageParts.push({
            type: 'input_image',
            image_url: `data:${mimeType};base64,${artifact.contentBuffer.toString('base64')}`,
            detail,
        });
    }

    if (imageParts.length === 0) {
        return baseParts && baseParts.some((part) => part.type === 'input_image')
            ? baseParts
            : normalizedText;
    }

    return [
        ...(baseParts || [{ type: 'input_text', text: normalizedText }]),
        ...imageParts,
    ];
}

async function maybePrepareImagesForArtifactPrompt({
    toolManager = null,
    sessionId = '',
    route = '',
    transport = 'http',
    taskType = 'chat',
    text = '',
    outputFormat = null,
    artifactIds = [],
    failOpen = true,
} = {}) {
    const resolvedArtifactIds = Array.isArray(artifactIds) ? artifactIds.filter(Boolean) : [];
    if (!shouldPreGenerateImagesForArtifactRequest({ text, outputFormat })) {
        return {
            artifactIds: resolvedArtifactIds,
            artifacts: [],
            toolEvents: [],
            imagePrompt: null,
            resetPreviousResponse: false,
        };
    }

    const imagePrompt = buildImagePromptFromArtifactRequest(text);
    const requestedImageCount = extractRequestedImageCount(text, 1);
    const buildFailureResult = (message, result = null) => ({
        artifactIds: resolvedArtifactIds,
        artifacts: [],
        imagePrompt,
        resetPreviousResponse: false,
        toolEvents: [{
            toolCall: {
                function: {
                    name: 'image-generate',
                    arguments: JSON.stringify({
                        prompt: imagePrompt,
                        ...(requestedImageCount > 1 ? { n: requestedImageCount } : {}),
                    }),
                },
            },
            result: {
                success: false,
                toolId: 'image-generate',
                ...(result && typeof result === 'object' ? result : {}),
                error: message,
            },
            reason: `Image generation failed before creating the ${normalizeFormat(outputFormat) || 'requested'} artifact; continuing without generated image artifacts.`,
        }],
    });

    if (!toolManager?.executeTool || !toolManager?.getTool?.('image-generate')) {
        const error = new Error('Image generation is required for this request, but the image-generate tool is not available.');
        error.statusCode = 503;
        if (failOpen) {
            console.warn(`[Artifacts] ${error.message} Continuing without generated images.`);
            return buildFailureResult(error.message);
        }
        throw error;
    }

    let toolResult = null;
    try {
        toolResult = await toolManager.executeTool(
            'image-generate',
            {
                prompt: imagePrompt,
                ...(requestedImageCount > 1 ? { n: requestedImageCount } : {}),
            },
            {
                sessionId,
                route,
                transport,
                taskType,
            },
        );
    } catch (error) {
        if (!failOpen) {
            throw error;
        }
        const message = error?.message || 'Image generation failed before artifact creation.';
        console.warn(`[Artifacts] ${message} Continuing without generated images.`);
        return buildFailureResult(message, {
            errorName: error?.name || null,
            statusCode: error?.statusCode || error?.status || null,
        });
    }

    if (!toolResult?.success) {
        const error = new Error(toolResult?.error || 'Image generation failed before artifact creation.');
        error.statusCode = 502;
        if (failOpen) {
            console.warn(`[Artifacts] ${error.message} Continuing without generated images.`);
            return buildFailureResult(error.message, toolResult);
        }
        throw error;
    }

    const generatedArtifacts = Array.isArray(toolResult?.data?.artifacts)
        ? toolResult.data.artifacts.filter((artifact) => artifact?.id)
        : [];
    if (generatedArtifacts.length === 0) {
        const error = new Error('Image generation completed, but no image artifacts were persisted for the follow-up document.');
        error.statusCode = 502;
        if (failOpen) {
            console.warn(`[Artifacts] ${error.message} Continuing without generated images.`);
            return buildFailureResult(error.message, toolResult);
        }
        throw error;
    }

    const mergedArtifactIds = [
        ...resolvedArtifactIds,
        ...generatedArtifacts.map((artifact) => artifact.id),
    ].filter((value, index, array) => array.indexOf(value) === index);

    return {
        artifactIds: mergedArtifactIds,
        artifacts: generatedArtifacts,
        imagePrompt,
        resetPreviousResponse: true,
        toolEvents: [{
            toolCall: {
                function: {
                    name: 'image-generate',
                    arguments: JSON.stringify({
                        prompt: imagePrompt,
                        ...(requestedImageCount > 1 ? { n: requestedImageCount } : {}),
                    }),
                },
            },
            result: toolResult,
            reason: `Generate image artifacts before creating the ${normalizeFormat(outputFormat) || 'requested'} artifact.`,
        }],
    };
}

async function generateOutputArtifactFromPrompt({
    sessionId,
    session = null,
    mode,
    outputFormat,
    prompt = '',
    artifactIds = [],
    existingContent = '',
    model = null,
    reasoningEffort = null,
    parentArtifactId = null,
    missionId = null,
    revision = null,
    provenance = {},
    contextMessages = [],
    recentMessages = [],
    toolManager = null,
    toolContext = {},
    executionProfile = 'default',
}) {
    if (!outputFormat) {
        return null;
    }

    if (!prompt) {
        const error = new Error('A user prompt is required to generate an output artifact');
        error.statusCode = 400;
        throw error;
    }

    const startedAt = Date.now();
    const normalizedOutputFormat = normalizeFormat(outputFormat);
    const selectedRevisionContext = await buildSelectedArtifactRevisionContext({
        sessionId,
        artifactIds,
    });
    const effectiveExistingContent = [
        selectedRevisionContext.content,
        existingContent,
    ].filter(Boolean).join('\n\n---\n\n');
    const effectiveParentArtifactId = parentArtifactId
        || selectedRevisionContext.sourceArtifactIds[0]
        || null;

    if (selectedRevisionContext.sourceArtifactIds.length === 0) {
        try {
            const sandboxResult = await maybeGenerateAgentSandboxArtifact({
                sessionId,
                prompt,
                outputFormat,
                model,
                reasoningEffort,
                toolManager,
                toolContext,
            });
            if (sandboxResult) {
                return sandboxResult;
            }
        } catch (error) {
            console.warn(`[Artifacts] Agent sandbox generation failed; falling back to direct artifact generation: ${error.message}`);
        }
    }

    const directGenerationStartedAt = Date.now();
    let result;
    let fallbackGeneration = false;
    try {
        result = await artifactService.generateArtifact({
            session,
            sessionId,
            mode,
            prompt,
            format: outputFormat,
            artifactIds,
            existingContent: effectiveExistingContent,
            model,
            reasoningEffort,
            parentArtifactId: effectiveParentArtifactId,
            missionId: missionId || toolContext?.missionId || toolContext?.metadata?.missionId || null,
            revision,
            provenance: {
                ...(provenance && typeof provenance === 'object' ? provenance : {}),
                sourceSurface: provenance?.sourceSurface || toolContext?.clientSurface || mode || 'artifact-generation',
                runId: provenance?.runId || toolContext?.runId || null,
                sessionId: provenance?.sessionId || sessionId,
            },
            contextMessages,
            recentMessages,
            toolManager,
            toolContext,
            executionProfile,
        });
    } catch (error) {
        if (!isRecoverableArtifactGenerationError(error) || !['html', 'pdf'].includes(normalizedOutputFormat)) {
            throw error;
        }
        const content = buildResilientArtifactFallbackHtml(prompt, normalizedOutputFormat);
        const artifact = await artifactService.storeGeneratedArtifactFromContent({
            sessionId,
            session,
            mode,
            format: normalizedOutputFormat,
            content,
            title: inferResilientArtifactTitle(prompt, normalizedOutputFormat),
            parentArtifactId: effectiveParentArtifactId,
            missionId: missionId || toolContext?.missionId || toolContext?.metadata?.missionId || null,
            revision,
            provenance: {
                ...(provenance && typeof provenance === 'object' ? provenance : {}),
                sourceSurface: provenance?.sourceSurface || toolContext?.clientSurface || mode || 'artifact-generation',
                runId: provenance?.runId || toolContext?.runId || null,
                sessionId: provenance?.sessionId || sessionId,
            },
            metadata: {
                sourceResponseId: null,
                artifactIds,
                generationStrategy: 'resilient-artifact-fallback',
                fallbackReason: error.message,
            },
            ownerId: toolContext?.ownerId || null,
        });
        result = {
            responseId: `artifact-fallback-${Date.now()}`,
            artifact,
            outputText: content,
            model: model || null,
            usage: null,
        };
        fallbackGeneration = true;
    }
    const completedAt = Date.now();
    const directStep = {
        type: 'artifact_generation',
        name: `${String(normalizedOutputFormat || outputFormat || 'output').toUpperCase()} artifact generated`,
        startTime: new Date(directGenerationStartedAt).toISOString(),
        endTime: new Date(completedAt).toISOString(),
        duration: Math.max(0, completedAt - directGenerationStartedAt),
        status: 'completed',
        details: {
            outputFormat: normalizedOutputFormat || outputFormat || null,
            strategy: 'direct-artifact-service',
            artifactId: result.artifact?.id || null,
            filename: result.artifact?.filename || result.artifact?.name || null,
            model: result.model || model || null,
        },
    };

    return {
        responseId: result.responseId,
        artifact: result.artifact,
        artifacts: [result.artifact],
        outputText: result.outputText,
        model: result.model || model || null,
        assistantMessage: buildArtifactCompletionMessage(outputFormat, result.artifact),
        metadata: {
            artifactGeneration: {
                strategy: fallbackGeneration ? 'resilient-artifact-fallback' : 'direct-artifact-service',
                outputFormat: normalizedOutputFormat || outputFormat || null,
                duration: Math.max(0, completedAt - startedAt),
                artifactId: result.artifact?.id || null,
                filename: result.artifact?.filename || result.artifact?.name || null,
                ...(fallbackGeneration ? { recoveredFromTransientFailure: true } : {}),
                ...(selectedRevisionContext.sourceArtifactIds.length > 0
                ? {
                    sourceArtifactIds: selectedRevisionContext.sourceArtifactIds,
                    parentArtifactId: effectiveParentArtifactId,
                }
                : {}),
            },
            executionTrace: [directStep],
            ...(result.usage
            ? {
                usage: result.usage,
                tokenUsage: result.usage,
            }
            : {}),
        },
    };
}

module.exports = {
    buildInstructionsWithArtifacts,
    maybeGenerateOutputArtifact,
    generateOutputArtifactFromPrompt,
    buildArtifactCompletionMessage,
    resolveDeferredWorkloadPreflight,
    shouldDeferArtifactGenerationToWorkload,
    hasExplicitMermaidArtifactIntent,
    hasExplicitMermaidFileIntent,
    hasExplicitStandaloneHtmlIntent,
    hasPlanningConversationIntent,
    hasExplicitNotesPageEditIntent,
    hasImplicitNotesPageBuildIntent,
    stripInjectedNotesPageEditDirective,
    extractRequestedImageCount,
    hasExplicitImageGenerationIntent,
    inferRequestedOutputFormat,
    inferOutputFormatFromArtifactContext,
    isArtifactContinuationPrompt,
    buildImagePromptFromArtifactRequest,
    hasExplicitArtifactDeliveryIntent,
    shouldPreGenerateImagesForArtifactRequest,
    shouldSuppressNotesSurfaceArtifact,
    shouldSuppressImplicitMermaidArtifact,
    shouldSuppressWebChatImplicitHtmlArtifact,
    shouldSuppressArtifactGenerationForRemoteAction,
    hasRemoteCliAgentToolEvent,
    shouldGenerateOutputArtifactForToolResponse,
    shouldSuppressResearchFirstArtifactGeneration,
    isArtifactStorageAvailable,
    isWebsiteDesignExampleRequest,
    normalizeReasoningEffort,
    resolveReasoningEffort,
    resolveSshRequestContext,
    formatSshToolResult,
    getPreferredRemoteToolId,
    canonicalizeRemoteToolId,
    isRemoteCommandToolId,
    isSuspiciousSshTargetHost,
    extractSshSessionMetadataFromToolEvents,
    inferOutputFormatFromSession,
    resolveArtifactContextIds,
    buildUserInputWithImageArtifacts,
    maybePrepareImagesForArtifactPrompt,
    buildPiiWorkbookRelationshipToolContext,
};

