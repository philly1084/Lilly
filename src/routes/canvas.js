const { Router } = require('express');
const { validate } = require('../middleware/validate');
const { sessionStore } = require('../session-store');
const { memoryService } = require('../memory/memory-service');
const { executeConversationRuntime, resolveConversationExecutorFlag } = require('../runtime-execution');
const { buildInstructionsWithArtifacts, maybeGenerateOutputArtifact, resolveReasoningEffort } = require('../ai-route-utils');
const { extractResponseText } = require('../artifacts/artifact-service');
const { startRuntimeTask, completeRuntimeTask, failRuntimeTask } = require('../admin/runtime-monitor');
const { buildDashboardTemplatePromptContext, isDashboardRequest } = require('../dashboard-template-catalog');
const {
    buildFrontendFallbackMetadata,
    normalizeFrontendMetadata,
} = require('../frontend-bundles');
const { normalizeMemoryKeywords } = require('../memory/memory-keywords');
const { extractArtifactsFromToolEvents, mergeRuntimeArtifacts } = require('../runtime-artifacts');
const {
    buildScopedMemoryMetadata,
    buildScopedSessionMetadata,
    isSessionIsolationEnabled,
    resolveClientSurface,
    resolveSessionScope,
} = require('../session-scope');
const {
    buildNaturalContext,
    buildNaturalContextInstructions,
    buildSkillsTreeInstructions,
} = require('../natural-context');
const { formatFrontendQualityBarForPrompt } = require('../orchestration/agent-roles');
const {
    buildRequestDecisionFrame,
    buildRequestDecisionMetadata,
    formatRequestDecisionFrameForPrompt,
} = require('../request-decision-frame');

const router = Router();

function normalizeClientNow(value = '') {
    const normalized = String(value || '').trim();
    if (!normalized) {
        return null;
    }

    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function getRequestOwnerId(req) {
    return String(req.user?.username || '').trim() || null;
}

function buildOwnerMemoryMetadata(ownerId = null, memoryScope = null, extra = {}) {
    return buildScopedMemoryMetadata({
        ...(ownerId ? { ownerId } : {}),
        ...(memoryScope ? { memoryScope } : {}),
        ...extra,
    });
}

const canvasSchema = {
    message: { required: true, type: 'string' },
    sessionId: { required: false, type: 'string' },
    canvasType: { required: false, type: 'string', enum: ['code', 'document', 'diagram', 'frontend'] },
    existingContent: { required: false, type: 'string' },
    model: { required: false, type: 'string' },
    reasoningEffort: { required: false, type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] },
    reasoning_effort: { required: false, type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] },
    reasoning: { required: false, type: 'object' },
    artifactIds: { required: false, type: 'array' },
    outputFormat: { required: false, type: 'string' },
    enableConversationExecutor: { required: false, type: 'boolean' },
    useAgentExecutor: { required: false, type: 'boolean' },
    executionProfile: { required: false, type: 'string' },
    memoryKeywords: { required: false, type: 'array' },
    metadata: { required: false, type: 'object' },
    templateId: { required: false, type: 'string' },
    templateIds: { required: false, type: 'array' },
    templateVariables: { required: false, type: 'object' },
};

function normalizeTemplateIds(value) {
    if (Array.isArray(value)) {
        return value
            .map((entry) => String(entry || '').trim())
            .filter(Boolean);
    }

    if (typeof value === 'string') {
        return String(value || '').trim() ? [String(value).trim()] : [];
    }

    return [];
}

async function buildCanvasTemplateSelection(templateStore, {
    canvasType = 'document',
    message = '',
    existingContent = '',
    templateId = null,
    templateIds = [],
    templateVariables = {},
} = {}) {
    if (!templateStore) {
        return { matches: [], context: '' };
    }

    const explicitTemplateIds = [
        ...normalizeTemplateIds(templateId),
        ...normalizeTemplateIds(templateIds),
    ];
    const kind = canvasType === 'frontend'
        ? (isDashboardRequest(message, existingContent) ? 'dashboard' : 'page')
        : (canvasType === 'document' ? 'document' : '');
    const surface = canvasType === 'frontend'
        ? 'frontend'
        : (canvasType === 'document' ? 'document' : '');
    const selection = templateStore.buildPromptContext({
        explicitTemplateIds,
        query: message,
        existingContent,
        surface,
        kind,
        limit: explicitTemplateIds.length > 0 ? 4 : 3,
        variables: templateVariables,
    });

    if (selection.matches.length > 0) {
        await templateStore.noteTemplateUse(selection.matches.map((template) => template.id));
    }

    return selection;
}

router.post('/', validate(canvasSchema), async (req, res, next) => {
    let runtimeTask = null;
    const startedAt = Date.now();
    try {
        const {
            message,
            canvasType = 'document',
            existingContent = '',
            model = null,
            reasoning: _ignoredReasoning = null,
            artifactIds = [],
            outputFormat = null,
            executionProfile = null,
            templateId = null,
            templateIds = [],
            templateVariables = {},
        } = req.body;
        const reasoningEffort = resolveReasoningEffort(req.body);
        const enableConversationExecutor = resolveConversationExecutorFlag(req.body);
        let { sessionId } = req.body;
        const memoryKeywords = normalizeMemoryKeywords(
            req.body.memoryKeywords || req.body?.metadata?.memoryKeywords || [],
        );
        const ownerId = getRequestOwnerId(req);
        const requestTimezone = String(
            req.body?.metadata?.timezone
            || req.body?.metadata?.timeZone
            || req.get('x-timezone')
            || '',
        ).trim() || null;
        const requestNow = normalizeClientNow(
            req.body?.metadata?.clientNow
            || req.body?.metadata?.client_now
            || req.get('x-client-now')
            || '',
        );
        const effectiveRequestMetadata = {
            ...(req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {}),
            ...(requestTimezone ? { timezone: requestTimezone } : {}),
            ...(requestNow ? { clientNow: requestNow } : {}),
            ...(memoryKeywords.length > 0 ? { memoryKeywords } : {}),
        };
        const requestedClientSurface = resolveClientSurface(req.body || {}, null, 'canvas');
        const requestedSessionMetadata = buildScopedSessionMetadata({
            ...effectiveRequestMetadata,
            mode: 'canvas',
            taskType: 'canvas',
            canvasType,
            clientSurface: requestedClientSurface,
        });

        const session = await sessionStore.resolveOwnedSession(
            sessionId,
            requestedSessionMetadata,
            ownerId,
        );
        if (session) {
            sessionId = session.id;
        }
        if (!session) {
            return res.status(404).json({ error: { message: 'Session not found' } });
        }
        const clientSurface = resolveClientSurface(req.body || {}, session, 'canvas');
        const memoryScope = resolveSessionScope({
            ...requestedSessionMetadata,
            clientSurface,
        }, session);
        const sessionIsolation = isSessionIsolationEnabled(requestedSessionMetadata, session);
        const templateSelection = await buildCanvasTemplateSelection(req.app.locals.templateStore, {
            canvasType,
            message,
            existingContent,
            templateId,
            templateIds,
            templateVariables,
        });
        const naturalContext = buildNaturalContext({
            session,
            metadata: effectiveRequestMetadata,
            clientSurface,
            taskType: 'canvas',
            userText: message,
        });
        const naturalInstructions = [
            buildSkillsTreeInstructions({ clientSurface, taskType: 'canvas' }),
            buildNaturalContextInstructions(naturalContext),
        ].filter(Boolean).join('\n\n');
        const requestFrame = buildRequestDecisionFrame({
            text: message,
            session,
            outputFormat,
            candidateOutputFormat: outputFormat,
            outputFormatProvided: Boolean(outputFormat),
            artifactIds,
            effectiveArtifactIds: artifactIds,
            executionProfile,
            taskType: 'canvas',
            clientSurface,
            route: '/api/canvas',
        });
        const requestFrameMetadata = buildRequestDecisionMetadata(requestFrame);
        const requestFrameInstructions = formatRequestDecisionFrameForPrompt(requestFrame);

        runtimeTask = startRuntimeTask({
            sessionId,
            input: message,
            model: model || null,
            mode: 'canvas',
            transport: 'http',
            metadata: { route: '/api/canvas', canvasType, phase: 'preflight', reasoningEffort, ...requestFrameMetadata },
        });
        const instructions = await buildInstructionsWithArtifacts(
            session,
            [
                requestFrameInstructions,
                buildCanvasInstructions(canvasType, existingContent, message, templateSelection.context),
                naturalInstructions,
            ].filter(Boolean).join('\n\n'),
            artifactIds,
        );

        const execution = await executeConversationRuntime(req.app, {
            input: message,
            session,
            sessionId,
            memoryInput: message,
            previousResponseId: session.previousResponseId,
            instructions,
            stream: false,
            model,
            reasoningEffort,
            toolContext: {
                sessionId,
                route: '/api/canvas',
                transport: 'http',
                memoryService,
                ownerId,
                clientSurface,
                memoryScope,
                sessionIsolation,
                memoryKeywords,
                timezone: requestTimezone,
                now: requestNow,
                artifactIds,
                workloadService: req.app.locals.agentWorkloadService,
            },
            executionProfile,
            enableConversationExecutor,
            taskType: 'canvas',
            clientSurface,
            memoryScope,
            metadata: {
                ...effectiveRequestMetadata,
                ...requestFrameMetadata,
                clientSurface,
                naturalContext,
            },
            ownerId,
        });
        const response = execution.response;
        if (!execution.handledPersistence) {
            await sessionStore.recordResponse(
                sessionId,
                response.id,
                response?.metadata?.promptState ? { promptState: response.metadata.promptState } : null,
            );
        }

        const outputText = extractResponseText(response);
        if (!execution.handledPersistence) {
            memoryService.rememberResponse(sessionId, outputText, buildOwnerMemoryMetadata(ownerId, memoryScope, {
                sourceSurface: clientSurface || 'canvas',
                memoryKeywords,
            }));
            await sessionStore.appendMessages(sessionId, [
                { role: 'user', content: message },
                { role: 'assistant', content: outputText, metadata: requestFrameMetadata },
            ]);
        }
        const structured = parseCanvasResponse(outputText, canvasType);
        const generatedArtifacts = await maybeGenerateOutputArtifact({
            sessionId,
            session,
            mode: 'canvas',
            outputFormat,
            content: structured.content,
            prompt: message,
            title: structured.metadata?.title || 'canvas-output',
            responseId: response.id,
            artifactIds,
            existingContent,
            model,
            reasoningEffort,
            recentMessages: await sessionStore.getRecentMessages(sessionId),
        });
        const artifacts = mergeRuntimeArtifacts(
            extractArtifactsFromToolEvents(response?.metadata?.toolEvents || []),
            generatedArtifacts,
        );
        if (artifacts.length > 0) {
            await Promise.all(artifacts.map((artifact) => memoryService.rememberArtifactResult(sessionId, {
                artifact,
                summary: `Created the ${artifact.format || outputFormat || 'generated'} artifact (${artifact.filename}).`,
                sourceText: structured.content,
                metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || 'canvas',
                    memoryKeywords,
                    sourcePrompt: message,
                }),
            })));
            await memoryService.rememberLearnedSkill(sessionId, {
                objective: message,
                assistantText: structured.content,
                toolEvents: response?.metadata?.toolEvents || [],
                artifact: artifacts[artifacts.length - 1],
                metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || 'canvas',
                    memoryKeywords,
                }),
            });
        }

        completeRuntimeTask(runtimeTask?.id, {
            responseId: response.id,
            output: structured.content,
            model: response.model || model || null,
            duration: Date.now() - startedAt,
            metadata: {
                canvasType,
                ...requestFrameMetadata,
                ...(response?.metadata || {}),
            },
        });

        res.json({
            sessionId,
            responseId: response.id,
            canvasType,
            artifacts,
            assistant_metadata: requestFrameMetadata,
            assistantMetadata: requestFrameMetadata,
            templateMatches: templateSelection.matches,
            ...structured,
        });
    } catch (err) {
        failRuntimeTask(runtimeTask?.id, {
            error: err,
            duration: Date.now() - startedAt,
            model: req.body?.model || null,
            metadata: { canvasType: req.body?.canvasType || 'document', reasoningEffort: resolveReasoningEffort(req.body) },
        });
        next(err);
    }
});

function buildFrontendFormatGuide() {
    return [
        '<frontend_format_router>',
        'Choose the artifact family that best matches the request before writing any HTML.',
        '- marketing-landing :: product launches, brand storytelling, conversion-focused pages :: hero, proof, feature beats, CTA',
        '- dashboard-control-room :: ops, admin, analytics, support, finance, internal monitoring :: filters, metrics, tables, alerts, drill-downs',
        '- app-workspace :: SaaS tools, product UIs, settings, portals, builders :: navigation, toolbar, panels, data views, task flows',
        '- documentation-site :: docs, manuals, guides, references, help centers, API pages :: table of contents, anchors, examples, callouts, code or reference blocks',
        '- report-or-brief :: executive briefs, case studies, findings, analytical summaries :: headline takeaway, evidence panels, charts, recommendations',
        '- editorial-feature :: magazine-style stories, explainers, timelines, immersive narratives :: chapter rhythm, pull quotes, image-led sections, calmer reading flow',
        '- campaign-microsite :: event pages, launches, seasonal campaigns, narrative promos :: scene-based sections, strong transitions, focused CTA',
        '- portfolio-showcase :: studio, creator, or product showcase pages :: project index, case studies, credibility, contact or inquiry path',
        'Selection rules:',
        '- Match the request. Do not default to a hero-features-testimonials-pricing stack unless the prompt clearly calls for it.',
        '- For documentation or reference requests, prioritize information architecture, wayfinding, examples, and utilities over marketing polish.',
        '- For reports or briefs, prioritize findings, proof, and decisions over conversion patterns.',
        '- For app, dashboard, game, or agent-build requests, build a structured work surface with phases, commands, object/data regions, and proof gates rather than brochure sections. Do not satisfy this by inserting the same stock controls every time; infer the build surface from the work the user is trying to do.',
        '- Create multi-page bundles only when the request implies a full site, documentation set, or multiple destinations.',
        '- For complex, premium, or redesign requests, include a visible design-system choice and a Unity-like structured CLI/workbench choice: phase rail, command palette, inspector, scene/object hierarchy, script/function hooks, object factories, QA gates, and repair/redesign loop where useful.',
        '- Never expose internal template labels, section archetype names, dashboard zone labels, or planning language in the visible copy.',
        '</frontend_format_router>',
    ].join('\n');
}

function buildImpressiveFrontendWebsiteGuide() {
    return formatFrontendQualityBarForPrompt({ includeCanvasHandoff: true, includeGameAddendum: true });
}

function buildFrontendTechnologyGuide() {
    return [
        '<frontend_technology_router>',
        'Choose the implementation technology before generating files.',
        '- static-html :: simple read-only pages, lightweight document previews, and small snippets only.',
        '- react-vite :: default for app workspaces, dashboards, interactive websites, multi-step flows, complex component state, agent build workbenches, editors, and reusable repo handoff.',
        '- three-webgl :: 3D scenes, spatial visualizations, data worlds, product configurators, immersive backgrounds, and any request that should feel dimensional.',
        '- game-simulation :: browser games, physics toys, particle systems, p5/Matter.js sketches, keyboard/pointer/touch play, score/HUD/reset loops, and pause/restart controls.',
        '- data-visualization :: charts, graph explorers, timelines, maps, dashboards, and analytical UIs using Chart.js, D3, ECharts, Plotly, Cytoscape, force-graph, or 3D Force Graph.',
        '- code-document-workbench :: source/document viewers, documentation sites, code review panes, report readers, API references, and import/export prototypes using CodeMirror, highlight.js, Marked, PDF.js, Mammoth, or docx.js.',
        'Rules:',
        '- For anything app-like, game-like, dashboard-like, 3D, animated, or stateful, set metadata.frameworkTarget to "vite" or "react" and build a multi-file bundle instead of one flat HTML file.',
        '- Prefer local sandbox library routes under /api/sandbox-libraries/ for Three.js, GSAP, Matter.js, p5.js, D3, Chart.js, ECharts, Plotly, Cytoscape, force-graph, 3D Force Graph, CodeMirror, highlight.js, Marked, PDF.js, Mammoth, and docx.js, with CDN fallbacks only when needed.',
        '- For code/document viewing requests, include real reader or editor affordances: tabs or file tree, line numbers, syntax highlighting, rendered Markdown, document outline/search, PDF/DOCX preview import when relevant, copy/download controls, and empty/error/loading states.',
        '- Keep the sandbox preview browser-runnable immediately. If package.json and vite.config.js are included for repo handoff, index.html must still render in the KimiBuilt preview without npm install.',
        '- Add AGENT_SANDBOX_BUILD.md when the bundle is non-trivial. It should summarize the user goal, technology choice, files, local QA checks, remaining assumptions, and live-promotion notes.',
        '- Include metadata.buildPipeline with localSandbox, visualQa, remoteBuild, and livePromotion notes when the user hints at publishing, deployment, repository handoff, or future iteration.',
        '</frontend_technology_router>',
    ].join('\n');
}

function buildCanvasInstructions(canvasType, existingContent, requestPrompt = '', templateContext = '') {
    const base = `You are an AI assistant working in canvas mode. You generate structured content that can be displayed in an editable canvas interface.

Always respond with valid JSON in this format:
{
  "content": "the main generated content",
  "metadata": { "language": "...", "title": "..." },
  "suggestions": ["suggestion 1", "suggestion 2"]
}`;
    const dashboardPromptContext = canvasType === 'frontend' && isDashboardRequest(requestPrompt, existingContent)
        ? buildDashboardTemplatePromptContext({
            prompt: requestPrompt,
            existingContent,
            limit: 3,
        })
        : '';

    const typeInstructions = {
        code: '\n\nYou are generating CODE. Include the programming language in metadata.language. Provide working, well-commented code. Suggestions should be improvements or alternative approaches.',
        document: '\n\nYou are generating a DOCUMENT. Use markdown formatting. Include a title in metadata.title. Suggestions should be ways to expand or improve the document.',
        diagram: '\n\nYou are generating a DIAGRAM using Mermaid syntax. Include the diagram type in metadata.type (flowchart, sequence, etc). Suggestions should be ways to enhance the diagram.',
        frontend: '\n\nYou are generating a DEMO WEBSITE FRONTEND or STRUCTURED AGENT CLI/WORKBENCH. Favor polished but request-matched HTML artifacts: landing pages, product sites, dashboards, app workspaces, documentation sites, editorial features, briefs, microsites, games, simulations, data explorers, 3D/interactive scenes, or structured build tools with deliberate visual direction. Treat metadata.bundle.files as the source of truth for the complete project. Include the full runnable project only in metadata.bundle.files; do not duplicate the same multi-file project or giant HTML payload in multiple fields. The content field may be a short preview summary or the entry page HTML only when the complete project is present in metadata.bundle.files. Include metadata.language as "html", metadata.frameworkTarget as "static", "vite", "react", or "nextjs", and metadata.previewMode as "iframe". Include metadata.bundle in the shape {"entry":"index.html","files":[{"path":"index.html","language":"html","purpose":"Preview entry","content":"..."},{"path":"src/main.jsx","language":"javascript","purpose":"React/Vite entry or app logic","content":"..."},{"path":"styles.css","language":"css","purpose":"Shared styles","content":"..."},{"path":"AGENT_SANDBOX_BUILD.md","language":"markdown","purpose":"Local build and promotion handoff","content":"..."}]}. When the request implies a full website or multiple pages, include a linked multi-page bundle instead of a single screen. If metadata.frameworkTarget is "vite" or "react", still keep the preview files browser-runnable from a static server by using relative modules or browser-compatible URLs instead of unresolved bare imports. Include metadata.handoff in the shape {"summary":"...","targetFramework":"...","componentMap":[{"name":"Hero","purpose":"...","targetPath":"src/components/Hero.jsx"}],"buildWorkbench":{"mode":"agent-build-workbench","phases":[{"id":"brief","name":"Brief","purpose":"...","entryCondition":"...","actions":["..."],"exitCheck":"..."}],"commands":[{"name":"create_scene","purpose":"...","when":"...","args":["..."]}],"hookPoints":[{"phase":"assemble","kind":"script|function|library|asset-generator","description":"...","scriptOrFunction":"..."}],"callableHooks":[{"name":"...","type":"script|function","when":"...","input":"...","output":"...","proof":"..."}],"objectFactories":[{"name":"...","purpose":"...","creates":"...","placeholderStrategy":"..."}],"qaGates":[{"name":"...","checks":["..."],"onFail":"repair|redesign|ask"}]},"designMoves":[{"name":"...","purpose":"Why this move fits the domain","interaction":"How the user uses it","effect":"What changes visually, spatially, or behaviorally","fallback":"Simpler repair path if it fails"}],"integrationSteps":["..."],"qaPlan":["desktop/mobile screenshot checks","opened interactive states to inspect","broken-image, console-error, contrast, overflow, clipped-text, and canvas/WebGL render checks"],"fallbackGate":{"decision":"repair|redesign|ask|ready","reason":"...","nextAction":"..."}}. Include metadata.buildPipeline when useful in the shape {"localSandbox":"...","visualQa":"...","remoteBuild":"...","livePromotion":"..."}. Keep the demo portable so the bundle files can be copied into a real repository later or promoted through managed-app/remote-cli-agent with artifact IDs and QA notes. Use realistic example data by default, and when a live source is known, wire it behind a small fetch layer or clearly swappable data adapter. Build a structured agent-facing CLI/workbench from the domain instead of copying a fixed list of UI controls. Prefer a Unity-like surface when it fits: phase rail, scene/object hierarchy, inspector, asset shelf, command palette, script/function hook slots, object factories, play/test loop, console, QA gate, and build/promotion pipeline. Familiar pieces such as filters, tabs, carousels, drill-downs, chart toggles, search, animation controls, game loops, 3D controls, and simulated workflow state are seed examples only. Let the system compose or invent build commands, object systems, generated placeholders, layout mechanics, motion rules, state visualizations, and callable hooks that help the agent progress through the build. Name those in metadata.handoff.buildWorkbench so the next agent can run the same phase, add a script/function, repair the implementation, or redesign the workbench without guessing. When real game object files, sprites, textures, or models are not available, create varied in-place placeholder objects using CSS, canvas, SVG, procedural meshes, or data-driven object factories; distinguish heroes, hazards, pickups, scenery, goals, enemies, NPCs, vehicles, doors, and projectiles with different silhouettes, colors, scale, motion, labels, materials, and collision/interaction behavior. Document those placeholders in AGENT_SANDBOX_BUILD.md or metadata.handoff so real assets can replace them later without changing gameplay contracts. Do not default every request to the same landing-page scaffold. For complex, premium, or redesign requests, make a distinct design-system choice plus a structured CLI/workbench choice, then use the fallback gate to state whether the next pass should repair implementation issues, redesign the visual/build system, ask for direction, or mark ready. For documentation requests, build a docs-style experience with information architecture and wayfinding. For report or brief requests, build an evidence-led reading experience rather than a marketing page. When the request is dashboard-oriented, choose one dashboard template from the provided catalog only as a starting point, include metadata.dashboardTemplate as {"id":"...","label":"...","rationale":"..."}, include metadata.dashboardTemplateOptions as [{"id":"...","label":"..."}], set <body data-dashboard-template="template-id">, and add data-dashboard-zone attributes on major layout regions. Suggestions should be concrete next build-workbench iterations and at least one script/function hook or object factory to add.',
    };

    let instructions = base + (typeInstructions[canvasType] || typeInstructions.document);

    if (canvasType === 'frontend') {
        instructions += `\n\n${buildFrontendFormatGuide()}`;
        instructions += `\n\n${buildFrontendTechnologyGuide()}`;
        instructions += `\n\n${buildImpressiveFrontendWebsiteGuide()}`;
    }

    if (templateContext) {
        instructions += `\n\n${templateContext}`;
    }

    if (dashboardPromptContext) {
        instructions += `\n\n${dashboardPromptContext}`;
    }

    if (existingContent) {
        instructions += `\n\nThe user has existing content that they want to modify or build upon:\n\`\`\`\n${existingContent}\n\`\`\``;
    }

    return instructions;
}

function parseCanvasResponse(text, canvasType) {
    try {
        const parsed = JSON.parse(text);
        if (
            canvasType === 'diagram'
            && (Array.isArray(parsed.actions) || Array.isArray(parsed.elements))
            && parsed.content === undefined
        ) {
            return {
                content: JSON.stringify({
                    message: typeof parsed.message === 'string' ? parsed.message : '',
                    actions: Array.isArray(parsed.actions) ? parsed.actions : [],
                    elements: Array.isArray(parsed.elements) ? parsed.elements : [],
                }),
                metadata: {
                    type: canvasType,
                    surface: parsed?.metadata?.surface || parsed?.surface || 'canvas',
                    actionContract: parsed?.metadata?.actionContract || parsed?.actionContract || 'canvas-actions',
                },
                suggestions: parsed.suggestions || [],
            };
        }
        const parsedContent = typeof parsed.content === 'string'
            ? parsed.content
            : String(parsed.content || '');
        const metadata = canvasType === 'frontend'
            ? normalizeFrontendMetadata(parsed.metadata, parsedContent)
            : (parsed.metadata || { type: canvasType });
        return {
            content: parsedContent || text,
            metadata,
            suggestions: parsed.suggestions || [],
        };
    } catch {
        if (canvasType === 'frontend') {
            return {
                content: text,
                metadata: buildFrontendFallbackMetadata(text),
                suggestions: [],
            };
        }

        return {
            content: text,
            metadata: { type: canvasType },
            suggestions: [],
        };
    }
}

module.exports = router;
module.exports._private = {
    buildCanvasInstructions,
    buildImpressiveFrontendWebsiteGuide,
    buildFrontendTechnologyGuide,
    parseCanvasResponse,
    buildFrontendFallbackMetadata,
    normalizeFrontendMetadata,
};

