const { config } = require('../config');
const { vectorStore } = require('./vector-store');
const { stripNullCharacters, chunkText } = require('../utils/text');
const { mergeMemoryKeywords, normalizeMemoryKeywords } = require('./memory-keywords');
const { runtimeDiagnostics } = require('../runtime-diagnostics');
const { verifiedAttestations } = require('../orchestration/completion-evidence');
const {
    buildScopedMemoryMetadata,
    isSessionIsolationEnabled,
    PROJECT_SHARED_MEMORY_NAMESPACE,
    SESSION_LOCAL_MEMORY_NAMESPACE,
    SURFACE_LOCAL_MEMORY_NAMESPACE,
    USER_GLOBAL_MEMORY_NAMESPACE,
} = require('../session-scope');

const DEFAULT_RECALL_PROFILE = 'default';
const RESEARCH_RECALL_PROFILE = 'research';
const FACT_MEMORY_TYPE = 'fact';
const ARTIFACT_MEMORY_TYPE = 'artifact';
const SKILL_MEMORY_TYPE = 'skill';
const RESEARCH_MEMORY_TYPE = 'research';
const WORKFLOW_SUMMARY_SKILL_KIND = 'workflow-summary';
const DEFAULT_FACT_LIMIT = 6;
const DEFAULT_ARTIFACT_LIMIT = 4;
const DEFAULT_SKILL_LIMIT = 3;
const DEFAULT_MEMORY_SCAN_LIMIT = 400;
const DEFAULT_FACT_IMPORTANCE = 0.6;
const DEFAULT_ARTIFACT_IMPORTANCE = 0.8;
const DEFAULT_SKILL_IMPORTANCE = 0.9;
const USER_GLOBAL_MEMORY_CLASSES = new Set([
    'user_preference',
    'collaboration_preference',
    'tool_preference',
    'reusable_skill',
]);
const PROJECT_CONTINUITY_MEMORY_CLASSES = new Set([
    'project_fact',
    'project_task',
    'workflow_summary',
    'tool_result',
    'production_context',
]);
const CONTINUITY_EXECUTION_PROFILES = new Set([
    'remote-build',
    'remote_builder',
    'remote-builder',
    'server-build',
    'server-builder',
    'software-builder',
]);
const CONTINUITY_SURFACES = new Set([
    'canvas',
    'document',
    'documents',
    'notation',
    'notes',
    'notes-app',
    'notes-editor',
    'web-chat',
]);
const PROGRAMMING_MEMORY_MARKERS = [
    /\b(?:src|frontend|backend|routes|components|lib|bin|k8s|tests?|__tests__)\/[A-Za-z0-9._/-]+\b/i,
    /\b[A-Za-z]:\\[^\s]+/i,
    /\b(?:npm|pnpm|yarn|jest|vitest|playwright|node|docker|kubectl|git)\s+(?:run\s+)?[A-Za-z0-9:_./-]+/i,
    /\b(?:stack trace|uncaught|exception|typeerror|referenceerror|syntaxerror|exit code|stderr|stdout)\b/i,
    /\b(?:implemented|patched|refactored|updated|fixed|debugged|deployed|ran tests?)\b[\s\S]{0,120}\b(?:file|route|module|component|function|test|repo|code|branch|commit)\b/i,
    /```(?:js|javascript|ts|typescript|jsx|tsx|json|bash|sh|powershell|yaml|yml|html|css|python)?\n/i,
];
const PRODUCTION_CONTINUITY_MARKERS = [
    /\b(?:deploy|deployment|production|prod|live|public|publish|published|rollout|ingress|tls|dns|host|domain|server|remote|ssh|k3s|k8s|kubernetes|kubectl|pod|service|container|docker)\b/i,
    /\b(?:document|doc|pdf|pptx|slides?|deck|report|brief|artifact|html|site|website|managed[- ]app|sandbox|preview|export)\b/i,
    /\b(?:blocked|blocker|next step|continue|resume|verified|verification|fixed|patched|created|updated|generated|failed|failing|error)\b/i,
];

function normalizeMemoryType(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if ([ARTIFACT_MEMORY_TYPE, SKILL_MEMORY_TYPE, RESEARCH_MEMORY_TYPE].includes(normalized)) {
        return normalized;
    }

    return FACT_MEMORY_TYPE;
}

function normalizeMemoryClassValue(value = '') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'conversation';
}

function hasProgrammingMemoryMarkers(text = '') {
    const normalizedText = stripNullCharacters(text).trim();
    return PROGRAMMING_MEMORY_MARKERS.some((pattern) => pattern.test(normalizedText));
}

function hasProductionContinuityMarkers(text = '') {
    const normalizedText = stripNullCharacters(text).trim();
    return PRODUCTION_CONTINUITY_MARKERS.some((pattern) => pattern.test(normalizedText));
}

function normalizeProfileValue(value = '') {
    return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function hasContinuityMetadataSignal(metadata = {}) {
    const memoryClass = normalizeMemoryClassValue(metadata?.memoryClass || metadata?.memory_class);
    const executionProfile = normalizeProfileValue(metadata?.executionProfile || metadata?.execution_profile);
    const sourceSurface = normalizeSourceSurface(metadata);
    return Boolean(
        metadata?.forceDurableMemory === true
        || metadata?.projectContinuity === true
        || PROJECT_CONTINUITY_MEMORY_CLASSES.has(memoryClass)
        || CONTINUITY_EXECUTION_PROFILES.has(executionProfile)
        || (metadata?.projectKey && CONTINUITY_SURFACES.has(String(sourceSurface || '').toLowerCase()))
        || (Array.isArray(metadata?.toolIds) && metadata.toolIds.length > 0)
        || Number(metadata?.toolEventCount || 0) > 0
        || metadata?.artifactId
    );
}

function inferContinuityMemoryClass(role = '', text = '', metadata = {}) {
    const currentClass = normalizeMemoryClassValue(metadata?.memoryClass || metadata?.memory_class);
    if (currentClass !== 'conversation') {
        return currentClass;
    }

    if (!hasContinuityMetadataSignal(metadata) || !hasProductionContinuityMarkers(text)) {
        return currentClass;
    }

    const normalizedRole = String(role || '').trim().toLowerCase();
    if (normalizedRole === 'tool') {
        return 'tool_result';
    }

    return 'project_task';
}

function withInferredContinuityMemoryClass(role = '', text = '', metadata = {}) {
    const inferredClass = inferContinuityMemoryClass(role, text, metadata);
    if (inferredClass === normalizeMemoryClassValue(metadata?.memoryClass || metadata?.memory_class)) {
        return metadata;
    }

    return {
        ...metadata,
        memoryClass: inferredClass,
        shareAcrossSurfaces: metadata?.shareAcrossSurfaces ?? true,
        forceDurableMemory: metadata?.forceDurableMemory ?? true,
    };
}

function shouldUseProjectContinuityRecall(options = {}, routing = {}, query = '') {
    if (!options?.ownerId || !routing?.projectKey) {
        return false;
    }

    const memoryClass = normalizeMemoryClassValue(routing?.memoryClass || options?.memoryClass || options?.memory_class);
    const executionProfile = normalizeProfileValue(options?.executionProfile || options?.execution_profile);
    return Boolean(
        options?.projectContinuity === true
        || PROJECT_CONTINUITY_MEMORY_CLASSES.has(memoryClass)
        || CONTINUITY_EXECUTION_PROFILES.has(executionProfile)
        || hasProductionContinuityMarkers(query)
    );
}

function normalizeImportance(value = null, fallback = DEFAULT_FACT_IMPORTANCE) {
    if ((typeof value !== 'number' && typeof value !== 'string')
        || (typeof value === 'string' && value.trim() === '')) {
        return fallback;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }

    return Math.max(0, Math.min(1, numeric));
}

function normalizeVisibility(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized || 'private';
}

function normalizeSourceSurface(metadata = {}) {
    const normalized = String(
        metadata?.sourceSurface
        || metadata?.clientSurface
        || metadata?.memoryScope
        || '',
    ).trim();
    return normalized || null;
}

function coerceTimestamp(value = null) {
    const timestamp = String(value || '').trim();
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function summarizeLine(value = '', limit = 220) {
    const normalized = stripNullCharacters(value).replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return '';
    }

    return normalized.length > limit
        ? `${normalized.slice(0, Math.max(0, limit - 3))}...`
        : normalized;
}

function summarizeSkillText({ objective = '', assistantText = '', toolEvents = [], artifact = null } = {}) {
    const toolSummaries = (Array.isArray(toolEvents) ? toolEvents : [])
        .slice(0, 6)
        .map((event) => {
            const toolId = String(event?.toolCall?.function?.name || event?.result?.toolId || '').trim();
            const reason = summarizeLine(event?.reason || '', 100);
            return toolId ? `${toolId}${reason ? `: ${reason}` : ''}` : '';
        })
        .filter(Boolean);
    const artifactSummary = artifact?.filename
        ? `Output artifact: ${artifact.filename}${artifact.format ? ` (${artifact.format})` : ''}.`
        : '';

    return [
        `Reusable workflow: ${summarizeLine(objective, 220)}`,
        toolSummaries.length > 0 ? `Verified steps: ${toolSummaries.join(' -> ')}` : '',
        artifactSummary,
        assistantText ? `Outcome: ${summarizeLine(assistantText, 260)}` : '',
    ].filter(Boolean).join('\n');
}

function summarizeToolEventKeywordText(toolEvents = []) {
    return (Array.isArray(toolEvents) ? toolEvents : [])
        .slice(0, 8)
        .map((event) => {
            const toolId = String(event?.toolCall?.function?.name || event?.result?.toolId || '').trim();
            const args = String(event?.toolCall?.function?.arguments || '').slice(0, 500);
            const reason = String(event?.reason || '').slice(0, 220);
            let resultText = '';
            try {
                resultText = typeof event?.result?.data === 'string'
                    ? event.result.data
                    : JSON.stringify(event?.result?.data || event?.result || {});
            } catch (_error) {
                resultText = String(event?.result?.summary || event?.result?.error || '');
            }
            return [
                toolId,
                reason,
                args,
                String(resultText || '').slice(0, 700),
            ].filter(Boolean).join('\n');
        })
        .filter(Boolean)
        .join('\n');
}

function normalizeToolFamily(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return '';
    }

    return normalized;
}

function deriveToolFamilyFromToolEvents(toolEvents = []) {
    const toolIds = (Array.isArray(toolEvents) ? toolEvents : [])
        .map((event) => String(event?.toolCall?.function?.name || event?.result?.toolId || '').trim())
        .filter(Boolean);

    if (toolIds.some((toolId) => ['remote-command', 'ssh-execute', 'k3s-deploy', 'docker-exec'].includes(toolId))) {
        return 'remote';
    }

    if (toolIds.some((toolId) => ['opencode-run', 'git-safe', 'file-write', 'file-read', 'file-search'].includes(toolId))) {
        return 'repo';
    }

    if (toolIds.some((toolId) => ['web-search', 'web-fetch', 'web-scrape'].includes(toolId))) {
        return 'research';
    }

    if (toolIds.some((toolId) => [ARTIFACT_MEMORY_TYPE, 'asset-search', 'image-from-url', 'image-search-unsplash'].includes(toolId))) {
        return 'artifact';
    }

    if (toolIds.some((toolId) => ['document-workflow', 'deep-research-presentation'].includes(toolId))) {
        return 'document';
    }

    if (toolIds.some((toolId) => ['image-generate', 'speech-generate'].includes(toolId))) {
        return 'media';
    }

    return toolIds[0] || '';
}

function inferQueryToolFamily(query = '') {
    const normalized = String(query || '').trim().toLowerCase();
    if (!normalized) {
        return '';
    }

    if (/\b(ssh|server|host|cluster|k3s|k8s|kubernetes|kubectl|deployment|pod|service|ingress|docker)\b/.test(normalized)) {
        return 'remote';
    }

    if (/\b(repo|repository|code|codebase|workspace|implement|refactor|fix|build|compile|test|commit|push)\b/.test(normalized)) {
        return 'repo';
    }

    if (/\b(research|latest|current|today|news|compare|comparison|look up|search|browse|pricing)\b/.test(normalized)) {
        return 'research';
    }

    if (/\b(document|report|brief|slides|presentation|deck|html|docx|pdf)\b/.test(normalized)) {
        return 'document';
    }

    if (/\b(artifact|file|image|images|photo|pdf|document|previous|earlier|generated|uploaded|attachment)\b/.test(normalized)) {
        return 'artifact';
    }

    return '';
}

function deriveKeywordOverlapForEntry(entry = {}, queryKeywords = []) {
    const normalizedQueryKeywords = normalizeMemoryKeywords(queryKeywords || []);
    if (!normalizedQueryKeywords.length) {
        return [];
    }

    const directOverlap = Array.isArray(entry?.keywordOverlap)
        ? normalizeMemoryKeywords(entry.keywordOverlap)
        : [];
    if (directOverlap.length > 0) {
        return directOverlap;
    }

    const metadataKeywords = normalizeMemoryKeywords(entry?.metadata?.keywords || []);
    const text = String(entry?.text || '').toLowerCase();
    return normalizedQueryKeywords.filter((keyword) => metadataKeywords.includes(keyword) || text.includes(keyword));
}

function extractProjectPlanFocus(session = null, explicitProjectPlan = null) {
    const candidate = explicitProjectPlan
        || session?.controlState?.projectPlan
        || session?.metadata?.controlState?.projectPlan
        || null;

    if (!candidate || typeof candidate !== 'object') {
        return '';
    }

    return summarizeLine(
        candidate.title
        || candidate.objective
        || candidate.summary
        || '',
        140,
    );
}

function buildRecallBundles(entries = []) {
    return {
        fact: entries.filter((entry) => entry?.typeGroup === 'fact'),
        artifact: entries.filter((entry) => entry?.typeGroup === 'artifact'),
        skill: entries.filter((entry) => entry?.typeGroup === 'skill'),
        research: entries.filter((entry) => entry?.typeGroup === 'research'),
    };
}

function isGenericReusableSkill({
    objective = '',
    assistantText = '',
    artifact = null,
    metadata = {},
} = {}) {
    if (artifact?.id || artifact?.filename) {
        return false;
    }

    const combined = [
        objective,
        assistantText,
        metadata?.sourcePrompt || '',
        metadata?.projectKey || '',
        metadata?.memoryScope || '',
    ].join('\n');
    if (!combined.trim()) {
        return false;
    }

    return !(
        /https?:\/\//i.test(combined)
        || /\/api\/artifacts\//i.test(combined)
        || /\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/.test(combined)
        || /[A-Za-z]:\\/.test(combined)
        || /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(combined)
    );
}

function isArtifactFollowupQuery(query = '') {
    const normalized = String(query || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(section|revise|update|edit|continue|same|that|this|previous|prior|latest|generated|document|pdf|html|docx|artifact|file|page|report|brief)\b/.test(normalized);
}

function normalizeKeywordOverlap(keywords = []) {
    return normalizeMemoryKeywords(Array.isArray(keywords) ? keywords : []);
}

function shouldKeepDurableMemory(role = '', text = '', metadata = {}) {
    const memoryClass = String(metadata?.memoryClass || '').trim().toLowerCase();
    const memoryType = normalizeMemoryType(metadata?.memoryType || '');
    if (
        memoryType === ARTIFACT_MEMORY_TYPE
        || memoryType === SKILL_MEMORY_TYPE
        || memoryType === RESEARCH_MEMORY_TYPE
        || USER_GLOBAL_MEMORY_CLASSES.has(memoryClass)
        || PROJECT_CONTINUITY_MEMORY_CLASSES.has(normalizeMemoryClassValue(memoryClass))
        || metadata?.shareAcrossSurfaces === true
        || metadata?.forceDurableMemory === true
    ) {
        return true;
    }

    const normalizedRole = String(role || '').trim().toLowerCase();
    if (!['user', 'assistant'].includes(normalizedRole)) {
        return true;
    }

    const normalizedText = stripNullCharacters(text).trim();
    if (!normalizedText) {
        return false;
    }

    return !hasProgrammingMemoryMarkers(normalizedText);
}

function selectMemoryChunks(text = '', {
    maxChunkChars = config.memory.storeChunkChars,
    maxChunks = config.memory.storeMaxChunks,
} = {}) {
    const normalized = stripNullCharacters(text).trim();
    if (!normalized) {
        return [];
    }

    const chunks = chunkText(normalized, maxChunkChars);
    if (chunks.length <= maxChunks) {
        return chunks;
    }

    if (maxChunks === 1) {
        return [chunks[0]];
    }

    return [
        ...chunks.slice(0, maxChunks - 1),
        chunks[chunks.length - 1],
    ];
}

class MemoryService {
    constructor() {
        this.store = vectorStore;
    }

    async initialize() {
        await this.store.initialize();
    }

    normalizeMetadata(role = 'user', text = '', metadata = {}) {
        const scopedMetadata = buildScopedMemoryMetadata(metadata);
        const memoryType = normalizeMemoryType(
            scopedMetadata?.memoryType
            || (role === 'research-note' ? RESEARCH_MEMORY_TYPE : FACT_MEMORY_TYPE),
        );
        const importance = normalizeImportance(
            scopedMetadata?.importance,
            memoryType === SKILL_MEMORY_TYPE
                ? DEFAULT_SKILL_IMPORTANCE
                : (memoryType === ARTIFACT_MEMORY_TYPE ? DEFAULT_ARTIFACT_IMPORTANCE : DEFAULT_FACT_IMPORTANCE),
        );

        return {
            role,
            memoryType,
            keywords: mergeMemoryKeywords(scopedMetadata?.memoryKeywords || scopedMetadata?.keywords || [], text),
            visibility: normalizeVisibility(
                scopedMetadata?.visibility
                || (memoryType === SKILL_MEMORY_TYPE ? 'frontend-shared' : 'private'),
            ),
            importance,
            timestamp: coerceTimestamp(scopedMetadata?.timestamp),
            sourceSurface: normalizeSourceSurface(scopedMetadata),
            ...(scopedMetadata?.ownerId ? { ownerId: String(scopedMetadata.ownerId).trim() } : {}),
            ...(scopedMetadata?.memoryScope ? { memoryScope: String(scopedMetadata.memoryScope).trim() } : {}),
            ...(scopedMetadata?.projectKey ? { projectKey: String(scopedMetadata.projectKey).trim() } : {}),
            ...(scopedMetadata?.memoryNamespace ? { memoryNamespace: String(scopedMetadata.memoryNamespace).trim() } : {}),
            ...(scopedMetadata?.memoryClass ? { memoryClass: String(scopedMetadata.memoryClass).trim() } : {}),
            ...(typeof scopedMetadata?.shareAcrossSurfaces === 'boolean'
                ? { shareAcrossSurfaces: scopedMetadata.shareAcrossSurfaces }
                : {}),
            ...(scopedMetadata?.artifactId ? { artifactId: String(scopedMetadata.artifactId).trim() } : {}),
            ...(scopedMetadata?.artifactFilename ? { artifactFilename: String(scopedMetadata.artifactFilename).trim() } : {}),
            ...(scopedMetadata?.artifactFormat ? { artifactFormat: String(scopedMetadata.artifactFormat).trim().toLowerCase() } : {}),
            ...(scopedMetadata?.skillId ? { skillId: String(scopedMetadata.skillId).trim() } : {}),
            ...(scopedMetadata?.skillKind ? { skillKind: String(scopedMetadata.skillKind).trim().toLowerCase() } : {}),
            ...(scopedMetadata?.toolFamily ? { toolFamily: normalizeToolFamily(scopedMetadata.toolFamily) } : {}),
            ...(Array.isArray(scopedMetadata?.toolIds) && scopedMetadata.toolIds.length > 0
                ? {
                    toolIds: scopedMetadata.toolIds
                        .map((toolId) => String(toolId || '').trim())
                        .filter(Boolean)
                        .slice(0, 8),
                }
                : {}),
            ...(scopedMetadata?.summary ? { summary: summarizeLine(scopedMetadata.summary, 280) } : {}),
            ...(scopedMetadata?.chunkIndex != null ? { chunkIndex: Number(scopedMetadata.chunkIndex) } : {}),
            ...(scopedMetadata?.sourceCharLength != null ? { sourceCharLength: Number(scopedMetadata.sourceCharLength) } : {}),
            ...(scopedMetadata?.sourceChunkCount != null ? { sourceChunkCount: Number(scopedMetadata.sourceChunkCount) } : {}),
            ...(scopedMetadata?.memoryTruncated === true ? { memoryTruncated: true } : {}),
            ...(scopedMetadata?.learningOutcome ? { learningOutcome: scopedMetadata.learningOutcome } : {}),
            ...(scopedMetadata?.evidenceIds ? { evidenceIds: scopedMetadata.evidenceIds } : {}),
            ...(scopedMetadata?.verifiedAt ? { verifiedAt: scopedMetadata.verifiedAt } : {}),
            ...(scopedMetadata?.revalidateAt ? { revalidateAt: scopedMetadata.revalidateAt } : {}),
            ...(scopedMetadata?.sourceRunId ? { sourceRunId: scopedMetadata.sourceRunId } : {}),
        };
    }

    async remember(sessionId, message, role = 'user', metadata = {}) {
        const normalizedMessage = stripNullCharacters(message).trim();
        if (!normalizedMessage) {
            return null;
        }

        const continuityMetadata = withInferredContinuityMemoryClass(role, normalizedMessage, metadata);

        if (!shouldKeepDurableMemory(role, normalizedMessage, continuityMetadata)) {
            return null;
        }

        const chunks = selectMemoryChunks(normalizedMessage);
        if (chunks.length <= 1 && chunks[0] === normalizedMessage) {
            return this.store.store(sessionId, normalizedMessage, this.normalizeMetadata(role, normalizedMessage, continuityMetadata));
        }

        const wasTruncated = chunks.join('').length < normalizedMessage.length || chunkText(normalizedMessage, config.memory.storeChunkChars).length > chunks.length;
        const writes = chunks.map((chunk, index) => this.store.store(sessionId, chunk, this.normalizeMetadata(role, chunk, {
            ...continuityMetadata,
            chunkIndex: index,
            sourceCharLength: normalizedMessage.length,
            sourceChunkCount: chunks.length,
            ...(wasTruncated ? { memoryTruncated: true } : {}),
        })));

        return Promise.all(writes);
    }

    async rememberArtifactResult(sessionId, {
        artifact = null,
        summary = '',
        sourceText = '',
        metadata = {},
    } = {}) {
        const summaryText = stripNullCharacters(summary).trim();
        const normalizedSource = stripNullCharacters(sourceText).trim();
        const artifactId = String(artifact?.id || metadata?.artifactId || '').trim() || null;
        const artifactFilename = String(artifact?.filename || metadata?.artifactFilename || '').trim() || null;
        const artifactFormat = String(artifact?.format || metadata?.artifactFormat || '').trim().toLowerCase() || null;
        const baseMetadata = {
            ...metadata,
            memoryType: ARTIFACT_MEMORY_TYPE,
            memoryClass: 'artifact',
            shareAcrossSurfaces: true,
            artifactId,
            artifactFilename,
            artifactFormat,
            importance: normalizeImportance(metadata?.importance, DEFAULT_ARTIFACT_IMPORTANCE),
        };

        const writes = [];
        if (summaryText) {
            writes.push(this.remember(sessionId, summaryText, 'artifact-summary', {
                ...baseMetadata,
                summary: summaryText,
                memoryKeywords: mergeMemoryKeywords(
                    metadata?.memoryKeywords || metadata?.keywords || [],
                    [summaryText, metadata?.sourcePrompt || '', artifactFilename || '', artifactFormat || ''].filter(Boolean).join('\n'),
                ),
            }));
        }

        if (normalizedSource) {
            const chunks = selectMemoryChunks(normalizedSource, {
                maxChunkChars: config.memory.storeChunkChars,
                maxChunks: config.artifacts.vectorizeMaxChunks,
            });
            for (let index = 0; index < chunks.length; index += 1) {
                writes.push(this.remember(sessionId, chunks[index], 'artifact-source', {
                    ...baseMetadata,
                    chunkIndex: index,
                    summary: summaryText || artifactFilename || artifactId || '',
                    memoryKeywords: mergeMemoryKeywords(
                        metadata?.memoryKeywords || metadata?.keywords || [],
                        [metadata?.sourcePrompt || '', artifactFilename || '', artifactFormat || '', summaryText, chunks[index]].filter(Boolean).join('\n'),
                    ),
                }));
            }
        }

        if (writes.length === 0) {
            return [];
        }

        return Promise.all(writes);
    }

    async rememberLearnedSkill(sessionId, {
        objective = '',
        assistantText = '',
        toolEvents = [],
        artifact = null,
        metadata = {},
        completion = null,
    } = {}) {
        const relevantToolEvents = (Array.isArray(toolEvents) ? toolEvents : [])
            .filter((event) => event?.result?.success === true);
        const evidence = relevantToolEvents.flatMap((event) => verifiedAttestations(event.result));
        const criteria = Array.isArray(completion?.criteria) ? completion.criteria : [];
        const required = criteria.filter((entry) => entry.required !== false);
        const evidenceIds = new Set(evidence.map((entry) => entry.id));
        const proven = evidence.length > 0 && required.length > 0
            && required.every((entry) => entry.status === 'satisfied'
                && entry.evidenceIds?.some((id) => evidenceIds.has(id)));
        if (!proven) {
            const failures = toolEvents.filter((event) => event?.result?.success === false);
            if (failures.length === 0) return null;
            return this.remember(sessionId, [
                `Failed attempt: ${summarizeLine(objective)}`,
                ...failures.slice(-3).map((event) => summarizeLine(event.result?.error || 'Tool failed')),
                'This is failure history, not a verified reusable procedure.',
            ].join('\n'), 'tool', {
                ...metadata, memoryType: FACT_MEMORY_TYPE, memoryClass: 'tool_result',
                learningOutcome: 'failed', shareAcrossSurfaces: false, importance: 0.4,
            });
        }
        if (!objective || (relevantToolEvents.length === 0 && !artifact)) {
            return null;
        }

        const skillText = summarizeSkillText({
            objective,
            assistantText: `${assistantText}\n${toolEvents.filter((event) => event.result?.success === false)
                .map((event) => `Recovered failure: ${summarizeLine(event.result.error)}`).join('\n')}`,
            toolEvents: relevantToolEvents,
            artifact,
        });
        if (!skillText) {
            return null;
        }

        const relevantToolIds = Array.from(new Set(relevantToolEvents
            .map((event) => String(event?.toolCall?.function?.name || event?.result?.toolId || '').trim())
            .filter(Boolean)));
        const toolFamily = deriveToolFamilyFromToolEvents(relevantToolEvents);
        if (toolFamily === 'repo' && metadata?.allowProgrammingMemory !== true) {
            return null;
        }

        const genericReusableSkill = isGenericReusableSkill({
            objective,
            assistantText,
            artifact,
            metadata,
        });

        return this.remember(sessionId, skillText, 'skill', {
            ...metadata,
            memoryType: SKILL_MEMORY_TYPE,
            learningOutcome: 'verified',
            evidenceIds: evidence.map((entry) => entry.id),
            verifiedAt: new Date().toISOString(),
            revalidateAt: new Date(Date.now() + 30 * 86400000).toISOString(),
            sourceRunId: metadata.runId || metadata.sourceRunId || sessionId,
            visibility: metadata?.visibility || 'frontend-shared',
            skillKind: WORKFLOW_SUMMARY_SKILL_KIND,
            memoryClass: genericReusableSkill ? 'reusable_skill' : 'task_specific_skill',
            shareAcrossSurfaces: genericReusableSkill,
            toolFamily,
            toolIds: relevantToolIds,
            importance: normalizeImportance(metadata?.importance, DEFAULT_SKILL_IMPORTANCE),
            memoryKeywords: mergeMemoryKeywords(
                metadata?.memoryKeywords || metadata?.keywords || [],
                [
                    objective,
                    assistantText,
                    artifact?.filename || '',
                    artifact?.format || '',
                    relevantToolIds.join(' '),
                    toolFamily,
                    summarizeToolEventKeywordText(relevantToolEvents),
                ].join('\n'),
            ),
        });
    }

    getRecallOptions({ profile = DEFAULT_RECALL_PROFILE, topK, scoreThreshold } = {}) {
        const normalizedProfile = String(profile || DEFAULT_RECALL_PROFILE).trim().toLowerCase();
        const isResearch = normalizedProfile === RESEARCH_RECALL_PROFILE;

        return {
            topK: Number.isFinite(Number(topK))
                ? Number(topK)
                : (isResearch ? config.memory.researchRecallTopK : config.memory.recallTopK),
            scoreThreshold: Number.isFinite(Number(scoreThreshold))
                ? Number(scoreThreshold)
                : (isResearch ? config.memory.researchRecallScoreThreshold : config.memory.recallScoreThreshold),
        };
    }

    entryMatchesScope(entry = {}, {
        sessionId = null,
        ownerId = null,
        memoryScope = null,
        projectKey = null,
        memoryNamespace = null,
        sourceSurface = null,
        memoryClass = null,
    } = {}) {
        const metadata = entry?.metadata || {};
        if (sessionId && metadata.sessionId !== sessionId) {
            return false;
        }
        if (!sessionId && ownerId && metadata.ownerId !== ownerId) {
            return false;
        }
        if (memoryScope && metadata.memoryScope !== memoryScope) {
            return false;
        }
        if (projectKey && metadata.projectKey !== projectKey) {
            return false;
        }
        if (memoryNamespace && metadata.memoryNamespace !== memoryNamespace) {
            return false;
        }
        if (sourceSurface && metadata.memoryNamespace === SURFACE_LOCAL_MEMORY_NAMESPACE && metadata.sourceSurface !== sourceSurface) {
            return false;
        }
        if (memoryClass && metadata.memoryClass !== memoryClass) {
            return false;
        }

        return true;
    }

    entryMatchesAnyScope(entry = {}, searchScopes = []) {
        return (Array.isArray(searchScopes) ? searchScopes : [])
            .some((scope) => this.entryMatchesScope(entry, scope));
    }

    buildRecallSearchScopes({
        sessionId = null,
        ownerId = null,
        routing = {},
    } = {}) {
        const scopes = [];
        const seen = new Set();
        const addScope = (scope = {}) => {
            const normalized = Object.fromEntries(
                Object.entries(scope).filter(([, value]) => value != null && value !== ''),
            );
            const signature = JSON.stringify(normalized);
            if (!signature || seen.has(signature)) {
                return;
            }
            seen.add(signature);
            scopes.push(normalized);
        };

        if (sessionId) {
            addScope({
                sessionId,
                memoryNamespace: SESSION_LOCAL_MEMORY_NAMESPACE,
            });
        }

        if (routing?.projectKey && ownerId) {
            addScope({
                ownerId,
                projectKey: routing.projectKey,
                memoryNamespace: SURFACE_LOCAL_MEMORY_NAMESPACE,
                sourceSurface: routing.sourceSurface || null,
            });
            addScope({
                ownerId,
                projectKey: routing.projectKey,
                memoryNamespace: PROJECT_SHARED_MEMORY_NAMESPACE,
            });
        }

        if (ownerId) {
            addScope({
                ownerId,
                memoryNamespace: USER_GLOBAL_MEMORY_NAMESPACE,
            });
        }

        return scopes;
    }

    getMemoryTypeGroup(entry = {}) {
        const memoryType = normalizeMemoryType(entry?.metadata?.memoryType || entry?.memoryType || '');
        if (memoryType === ARTIFACT_MEMORY_TYPE) {
            return 'artifact';
        }
        if (memoryType === SKILL_MEMORY_TYPE) {
            return 'skill';
        }
        if (memoryType === RESEARCH_MEMORY_TYPE) {
            return 'research';
        }
        return 'fact';
    }

    async keywordRecall(keywords = [], options = {}) {
        const normalizedKeywords = normalizeMemoryKeywords(keywords);
        if (normalizedKeywords.length === 0) {
            return [];
        }
        const searchScopes = Array.isArray(options.searchScopes) ? options.searchScopes : [];

        const scanLimit = options.scanLimit || DEFAULT_MEMORY_SCAN_LIMIT;
        const scopedRows = searchScopes.length > 0
            ? await Promise.all(searchScopes.map((scope) => this.store.scroll(this.store.collection, {
                limit: scanLimit,
                filter: typeof this.store.buildPayloadFilter === 'function'
                    ? this.store.buildPayloadFilter(scope)
                    : undefined,
                with_payload: true,
                with_vector: false,
            })))
            : [await this.store.scroll(this.store.collection, {
                limit: scanLimit,
                filter: typeof this.store.buildPayloadFilter === 'function'
                    ? this.store.buildPayloadFilter(options)
                    : undefined,
                with_payload: true,
                with_vector: false,
            })];

        const seenRows = new Set();
        const rows = scopedRows.flat().filter((row) => {
            const id = String(row?.id || '');
            if (!id || seenRows.has(id)) {
                return false;
            }
            seenRows.add(id);
            return true;
        });

        return rows
            .map((row) => ({
                id: row?.id,
                score: 0,
                text: row?.payload?.text || '',
                sessionId: row?.payload?.sessionId || null,
                timestamp: row?.payload?.timestamp || null,
                metadata: row?.payload || {},
            }))
            .filter((entry) => (
                searchScopes.length > 0
                    ? this.entryMatchesAnyScope(entry, searchScopes)
                    : this.entryMatchesScope(entry, options)
            ))
            .map((entry) => {
                const entryKeywords = normalizeKeywordOverlap(entry?.metadata?.keywords || []);
                const keywordOverlap = normalizedKeywords.filter((keyword) => entryKeywords.includes(keyword));
                if (keywordOverlap.length === 0) {
                    return null;
                }

                return {
                    ...entry,
                    keywordOverlap,
                };
            })
            .filter(Boolean);
    }

    scoreRecallEntry(entry = {}, {
        queryKeywords = [],
        artifactFollowup = false,
        preferredToolIds = [],
        objectiveToolFamily = '',
        activeProjectFocus = '',
        profile = DEFAULT_RECALL_PROFILE,
    } = {}) {
        const judgmentV2Enabled = config.runtime?.judgmentV2Enabled === true;
        const metadata = entry?.metadata || {};
        const keywordOverlap = deriveKeywordOverlapForEntry(entry, queryKeywords);
        const semanticScore = Number(entry?.semanticScore ?? entry?.score ?? 0);
        const importance = normalizeImportance(metadata?.importance, DEFAULT_FACT_IMPORTANCE);
        const timestamp = Date.parse(metadata?.timestamp || entry?.timestamp || '');
        const ageMs = Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : Number.POSITIVE_INFINITY;
        const recencyBoost = Number.isFinite(ageMs)
            ? Math.max(0, 0.18 - (ageMs / (1000 * 60 * 60 * 24 * 30)))
            : 0;
        const keywordBoost = keywordOverlap.length > 0
            ? Math.min(0.5, keywordOverlap.length * 0.16)
            : 0;
        const typeGroup = this.getMemoryTypeGroup(entry);
        const artifactBoost = artifactFollowup && typeGroup === 'artifact' ? 0.25 : 0;
        const skillKind = String(metadata?.skillKind || '').trim().toLowerCase();
        const workflowFamilyMatch = objectiveToolFamily
            && normalizeToolFamily(metadata?.toolFamily || '') === normalizeToolFamily(objectiveToolFamily);
        const workflowSimilarityBoost = skillKind === WORKFLOW_SUMMARY_SKILL_KIND
            ? (workflowFamilyMatch && keywordOverlap.length > 0 ? 0.28 : (workflowFamilyMatch ? 0.16 : -0.06))
            : 0;
        const preferredToolMatch = Array.isArray(metadata?.toolIds)
            && metadata.toolIds.some((toolId) => preferredToolIds.includes(toolId));
        const preferredToolBoost = judgmentV2Enabled && preferredToolMatch ? 0.1 : 0;
        const projectPlanBoost = judgmentV2Enabled && activeProjectFocus
            && String(entry?.text || '').toLowerCase().includes(activeProjectFocus.toLowerCase())
            ? 0.12
            : 0;
        const researchBoost = judgmentV2Enabled && typeGroup === 'research' && profile === RESEARCH_RECALL_PROFILE ? 0.08 : 0;
        const skillBoost = typeGroup === 'skill'
            ? (workflowSimilarityBoost + preferredToolBoost + projectPlanBoost + 0.04)
            : 0;
        const textBoost = queryKeywords.some((keyword) => String(entry?.text || '').toLowerCase().includes(keyword))
            ? 0.05
            : 0;

        return semanticScore
            + keywordBoost
            + recencyBoost
            + artifactBoost
            + (judgmentV2Enabled ? skillBoost : (typeGroup === 'skill' ? 0.1 : 0))
            + textBoost
            + researchBoost
            + importance;
    }

    buildRecallRationale(entry = {}, {
        queryKeywords = [],
        artifactFollowup = false,
        preferredToolIds = [],
        objectiveToolFamily = '',
        activeProjectFocus = '',
        profile = DEFAULT_RECALL_PROFILE,
    } = {}) {
        const metadata = entry?.metadata || {};
        const reasons = [];
        const keywordOverlap = deriveKeywordOverlapForEntry(entry, queryKeywords);
        const toolIds = Array.isArray(metadata?.toolIds) ? metadata.toolIds : [];
        const toolFamily = normalizeToolFamily(metadata?.toolFamily || '');
        const skillKind = String(metadata?.skillKind || '').trim().toLowerCase();

        if (Number(entry?.semanticScore || 0) >= 0.7) {
            reasons.push('strong semantic match');
        }
        if (keywordOverlap.length > 0) {
            reasons.push(`keyword overlap: ${keywordOverlap.join(', ')}`);
        }
        if (artifactFollowup && entry?.typeGroup === 'artifact') {
            reasons.push('artifact-followup boost');
        }
        if (skillKind === WORKFLOW_SUMMARY_SKILL_KIND && objectiveToolFamily && toolFamily === normalizeToolFamily(objectiveToolFamily)) {
            reasons.push(`workflow family match: ${toolFamily}`);
        }
        if (toolIds.some((toolId) => preferredToolIds.includes(toolId))) {
            reasons.push('matches preferred tools');
        }
        if (activeProjectFocus && String(entry?.text || '').toLowerCase().includes(activeProjectFocus.toLowerCase())) {
            reasons.push('matches active project focus');
        }
        if (entry?.typeGroup === 'research' && profile === RESEARCH_RECALL_PROFILE) {
            reasons.push('research recall profile');
        }

        return reasons.length > 0 ? reasons : ['semantic recall'];
    }

    mergeRecallResults(semanticResults = [], keywordResults = [], options = {}) {
        const merged = new Map();
        for (const entry of semanticResults) {
            merged.set(String(entry.id), {
                ...entry,
                semanticScore: Number(entry.score || 0),
                keywordOverlap: [],
            });
        }

        for (const entry of keywordResults) {
            const key = String(entry.id);
            const existing = merged.get(key);
            if (existing) {
                merged.set(key, {
                    ...existing,
                    keywordOverlap: Array.from(new Set([...(existing.keywordOverlap || []), ...(entry.keywordOverlap || [])])),
                });
                continue;
            }

            merged.set(key, {
                ...entry,
                semanticScore: 0,
            });
        }

        const queryKeywords = normalizeMemoryKeywords(options.queryKeywords || []);
        const artifactFollowup = Boolean(options.artifactFollowup);
        const preferredToolIds = Array.isArray(options.preferredToolIds)
            ? options.preferredToolIds.map((toolId) => String(toolId || '').trim()).filter(Boolean)
            : [];
        const objectiveToolFamily = inferQueryToolFamily(options.objective || '');
        const activeProjectFocus = summarizeLine(options.activeProjectFocus || '', 120);
        const profile = String(options.profile || DEFAULT_RECALL_PROFILE).trim().toLowerCase() || DEFAULT_RECALL_PROFILE;

        return Array.from(merged.values())
            .map((entry) => ({
                ...entry,
                typeGroup: this.getMemoryTypeGroup(entry),
                finalScore: this.scoreRecallEntry(entry, {
                    queryKeywords,
                    artifactFollowup,
                    preferredToolIds,
                    objectiveToolFamily,
                    activeProjectFocus,
                    profile,
                }),
                rationale: this.buildRecallRationale(entry, {
                    queryKeywords,
                    artifactFollowup,
                    preferredToolIds,
                    objectiveToolFamily,
                    activeProjectFocus,
                    profile,
                }),
            }))
            .sort((left, right) => right.finalScore - left.finalScore);
    }

    selectRecallGroups(entries = [], topK = DEFAULT_FACT_LIMIT + DEFAULT_ARTIFACT_LIMIT + DEFAULT_SKILL_LIMIT) {
        const caps = {
            fact: DEFAULT_FACT_LIMIT,
            artifact: DEFAULT_ARTIFACT_LIMIT,
            skill: DEFAULT_SKILL_LIMIT,
            research: DEFAULT_FACT_LIMIT,
        };
        const selected = [];
        const counts = {
            fact: 0,
            artifact: 0,
            skill: 0,
            research: 0,
        };

        for (const entry of entries) {
            const metadata = entry.metadata || entry.payload?.metadata || entry.payload || {};
            if (metadata.revalidateAt && Date.parse(metadata.revalidateAt) <= Date.now()) continue;
            if (metadata.skillKind === WORKFLOW_SUMMARY_SKILL_KIND && metadata.learningOutcome !== 'verified') continue;
            const typeGroup = entry?.typeGroup || 'fact';
            if ((counts[typeGroup] || 0) >= (caps[typeGroup] || DEFAULT_FACT_LIMIT)) {
                continue;
            }

            selected.push(entry);
            counts[typeGroup] += 1;
            if (selected.length >= topK) {
                break;
            }
        }

        return { selected, counts };
    }

    formatRecallSections(entries = []) {
        const sections = {
            fact: [],
            artifact: [],
            skill: [],
            research: [],
        };

        for (const entry of entries) {
            const typeGroup = entry?.typeGroup || 'fact';
            const text = summarizeLine(entry?.text || '', typeGroup === 'artifact' ? 280 : 220);
            if (!text) {
                continue;
            }

            const metadata = entry?.metadata || {};
            if (typeGroup === 'artifact') {
                const label = [
                    metadata?.artifactFilename || '',
                    metadata?.artifactFormat ? `(${metadata.artifactFormat})` : '',
                ].filter(Boolean).join(' ');
                sections.artifact.push(`- ${label ? `${label}: ` : ''}${text}`);
                continue;
            }

            if (typeGroup === 'skill') {
                sections.skill.push(`- ${text}`);
                continue;
            }

            if (typeGroup === 'research') {
                sections.research.push(`- ${text}`);
                continue;
            }

            sections.fact.push(`- ${text}`);
        }

        const rendered = [];
        if (sections.fact.length > 0) {
            rendered.push('Relevant facts:', ...sections.fact);
        }
        if (sections.artifact.length > 0) {
            rendered.push('Relevant prior artifacts:', ...sections.artifact);
        }
        if (sections.skill.length > 0) {
            rendered.push('Reusable skills:', ...sections.skill);
        }
        if (sections.research.length > 0) {
            rendered.push('Relevant research notes:', ...sections.research);
        }

        return rendered.length > 0 ? [rendered.join('\n')] : [];
    }

    async recallDetailed(query, {
        sessionId = null,
        ownerId = null,
        memoryScope = null,
        topK,
        scoreThreshold,
        profile = DEFAULT_RECALL_PROFILE,
        memoryKeywords = [],
        objective = '',
        session = null,
        projectPlan = null,
        preferredToolIds = [],
        sourceSurface = null,
        projectKey = null,
    } = {}) {
        const recallOptions = this.getRecallOptions({
            profile,
            topK,
            scoreThreshold,
        });
        const queryKeywords = mergeMemoryKeywords(memoryKeywords, query);
        const artifactFollowup = isArtifactFollowupQuery(query);
        const routing = buildScopedMemoryMetadata({
            ownerId,
            memoryScope: String(memoryScope || '').trim() || null,
            sourceSurface: sourceSurface || null,
            projectKey: projectKey || null,
            memoryClass: 'conversation',
            ...(sessionId ? { sessionIsolation: true } : {}),
        }, session || null);
        const searchScopes = this.buildRecallSearchScopes({
            sessionId,
            ownerId,
            routing,
        });
        const semanticResults = (await Promise.all(searchScopes.map((scope) => this.store.search(query, {
            ...scope,
            topK: recallOptions.topK,
            scoreThreshold: recallOptions.scoreThreshold,
        })))).flat().filter((entry) => this.entryMatchesAnyScope(entry, searchScopes));
        const keywordResults = await this.keywordRecall(queryKeywords, {
            searchScopes,
        });
        const mergedResults = this.mergeRecallResults(semanticResults, keywordResults, {
            queryKeywords,
            artifactFollowup,
            objective: objective || query,
            activeProjectFocus: extractProjectPlanFocus(session, projectPlan),
            preferredToolIds: preferredToolIds.length > 0
                ? preferredToolIds
                : (Array.isArray(session?.metadata?.agent?.tools) ? session.metadata.agent.tools : []),
            profile,
        });
        const { selected, counts } = this.selectRecallGroups(mergedResults, recallOptions.topK);
        const contextMessages = this.formatRecallSections(selected);
        const bundles = buildRecallBundles(selected);
        const trace = {
            query: summarizeLine(query, 200),
            matchedKeywords: queryKeywords,
            artifactFollowup,
            selected: selected.map((entry) => ({
                id: String(entry.id),
                memoryType: entry?.metadata?.memoryType || FACT_MEMORY_TYPE,
                typeGroup: entry.typeGroup,
                score: Number(entry.finalScore || 0),
                semanticScore: Number(entry.semanticScore || 0),
                keywordOverlap: entry.keywordOverlap || [],
                artifactId: entry?.metadata?.artifactId || null,
                projectKey: entry?.metadata?.projectKey || null,
                memoryNamespace: entry?.metadata?.memoryNamespace || null,
                memoryClass: entry?.metadata?.memoryClass || null,
                sourceSurface: entry?.metadata?.sourceSurface || null,
                shareAcrossSurfaces: entry?.metadata?.shareAcrossSurfaces === true,
                summary: summarizeLine(entry?.metadata?.summary || entry?.text || '', 120),
                rationale: entry?.rationale || [],
            })),
            counts,
            bundles: Object.fromEntries(
                Object.entries(bundles).map(([key, entries]) => [key, entries.length]),
            ),
            routing: {
                projectKey: routing.projectKey || null,
                memoryNamespace: routing.memoryNamespace || null,
                sourceSurface: routing.sourceSurface || null,
            },
            searchScopes,
        };

        runtimeDiagnostics.recordMemoryHitMix({
            fact: counts.fact || 0,
            artifact: counts.artifact || 0,
            skill: counts.skill || 0,
            research: counts.research || 0,
        });
        if (artifactFollowup && (counts.artifact || 0) > 0) {
            runtimeDiagnostics.incrementArtifactFollowupRecalls();
        }

        return {
            entries: selected,
            bundles,
            contextMessages,
            trace,
        };
    }

    async recall(query, {
        sessionId = null,
        ownerId = null,
        memoryScope = null,
        topK,
        scoreThreshold,
        profile = DEFAULT_RECALL_PROFILE,
        memoryKeywords = [],
        returnDetails = false,
        objective = '',
        session = null,
        projectPlan = null,
        preferredToolIds = [],
        sourceSurface = null,
        projectKey = null,
    } = {}) {
        const details = await this.recallDetailed(query, {
            sessionId,
            ownerId,
            memoryScope: String(memoryScope || '').trim() || null,
            topK,
            scoreThreshold,
            profile,
            memoryKeywords,
            objective,
            session,
            projectPlan,
            preferredToolIds,
            sourceSurface,
            projectKey,
        });

        return returnDetails ? details : details.contextMessages;
    }

    async process(sessionId, message, options = {}) {
        const ownerId = String(options?.ownerId || '').trim() || null;
        const memoryScope = String(options?.memoryScope || '').trim() || null;
        const memoryKeywords = normalizeMemoryKeywords(options?.memoryKeywords || []);
        const sessionIsolation = isSessionIsolationEnabled(options);
        const routing = buildScopedMemoryMetadata({
            ...(ownerId ? { ownerId } : {}),
            ...(memoryScope ? { memoryScope } : {}),
            ...(options?.projectKey ? { projectKey: options.projectKey } : {}),
            ...(memoryKeywords.length > 0 ? { memoryKeywords } : {}),
            sourceSurface: options?.sourceSurface || memoryScope || null,
            memoryClass: options?.memoryClass || 'conversation',
            ...(options?.executionProfile ? { executionProfile: options.executionProfile } : {}),
            ...(options?.projectContinuity === true ? { projectContinuity: true } : {}),
            ...(sessionIsolation ? { sessionIsolation: true } : {}),
        }, options?.session || null);
        const recallQuery = String(options?.recallQuery || message || '').trim() || String(message || '');
        this.remember(sessionId, message, 'user', routing).catch((err) => {
            console.error('[Memory] Failed to store message:', err.message);
        });

        try {
            const projectContinuityRecall = shouldUseProjectContinuityRecall(options, routing, recallQuery);
            const shouldLockToCurrentSession = !projectContinuityRecall && (sessionIsolation || !ownerId || !routing.projectKey);
            return await this.recall(recallQuery, {
                ...options,
                sessionId: shouldLockToCurrentSession ? sessionId : null,
                ownerId: shouldLockToCurrentSession ? null : ownerId,
                memoryScope,
                sessionIsolation: shouldLockToCurrentSession && routing.sessionIsolation === true,
                memoryKeywords,
                sourceSurface: routing.sourceSurface || null,
                projectKey: routing.projectKey || null,
                objective: options?.objective || recallQuery,
                session: options?.session || null,
                projectPlan: options?.projectPlan || null,
                preferredToolIds: options?.preferredToolIds || [],
            });
        } catch (err) {
            console.error('[Memory] Failed to recall context:', err.message);
            return options?.returnDetails
                ? { entries: [], contextMessages: [], trace: { error: err.message } }
                : [];
        }
    }

    async rememberResponse(sessionId, response, metadata = {}) {
        try {
            await this.remember(sessionId, response, 'assistant', metadata);
        } catch (err) {
            console.error('[Memory] Failed to store response:', err.message);
        }
    }

    async rememberResearchNote(sessionId, note, metadata = {}) {
        const normalizedNote = stripNullCharacters(note).trim();
        if (!normalizedNote) {
            return null;
        }

        try {
            return await this.store.store(sessionId, normalizedNote, this.normalizeMetadata('research-note', normalizedNote, {
                ...metadata,
                memoryType: RESEARCH_MEMORY_TYPE,
                memoryClass: 'research_note',
                shareAcrossSurfaces: true,
            }));
        } catch (err) {
            console.error('[Memory] Failed to store research note:', err.message);
            return null;
        }
    }

    async forget(sessionId) {
        await this.store.deleteSession(sessionId);
    }

    getDiagnostics() {
        return runtimeDiagnostics.snapshot();
    }
}

const memoryService = new MemoryService();

module.exports = {
    memoryService,
    MemoryService,
    DEFAULT_RECALL_PROFILE,
    RESEARCH_RECALL_PROFILE,
    FACT_MEMORY_TYPE,
    ARTIFACT_MEMORY_TYPE,
    SKILL_MEMORY_TYPE,
    RESEARCH_MEMORY_TYPE,
};
