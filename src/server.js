const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const helmet = require('helmet');

const { config, validate } = require('./config');
const { errorHandler } = require('./middleware/error-handler');
const { buildCorsOptions, createRateLimit, isToolInvokePath } = require('./middleware/security');
const { memoryService } = require('./memory/memory-service');
const { setupWebSocket } = require('./ws/handler');
const { embedder } = require('./memory/embedder');
const { vectorStore } = require('./memory/vector-store');
const { sessionStore } = require('./session-store');

const chatRouter = require('./routes/chat');
const canvasRouter = require('./routes/canvas');
const notationRouter = require('./routes/notation');
const notesRouter = require('./routes/notes');
const sessionsRouter = require('./routes/sessions');
const preferencesRouter = require('./routes/preferences');
const modelsRouter = require('./routes/models');
const ttsRouter = require('./routes/tts');
const audioRouter = require('./routes/audio');
const podcastRouter = require('./routes/podcast');
const { ttsService } = require('./tts/tts-service');
const { audioProcessingService } = require('./audio/audio-processing-service');
const imagesRouter = require('./routes/images');
const artifactsRouter = require('./routes/artifacts');
const sandboxWorkspacesRouter = require('./routes/sandbox-workspaces');
const sandboxLibrariesRouter = require('./routes/sandbox-libraries');
const { artifactService } = require('./artifacts/artifact-service');
const openaiCompatRouter = require('./routes/openai-compat');
const documentsRouter = require('./routes/documents');
const templatesRouter = require('./routes/templates');
const designResourcesRouter = require('./routes/design-resources');
const unsplashRouter = require('./routes/unsplash');
const adminRouter = require('./routes/admin');
const settingsController = require('./routes/admin/settings.controller');
const logsController = require('./routes/admin/logs.controller');
const authRouter = require('./routes/auth');
const toolsRouter = require('./routes/tools');
const skillsRouter = require('./routes/skills');
const workloadsRouter = require('./routes/workloads');
const managedAppsRouter = require('./routes/managed-apps');
const runnersRouter = require('./routes/runners');
const asyncLabRouter = require('./routes/async-lab');
const asyncLabWebhooksRouter = require('./routes/async-lab-webhooks');
const agentRunsRouter = require('./routes/agent-runs');
const giteaIntegrationsRouter = require('./routes/integrations-gitea');
const gitlabIntegrationsRouter = require('./routes/integrations-gitlab');
const providerSessionsRouter = require('./routes/provider-sessions');
const remoteAgentTasksRouter = require('./routes/remote-agent-tasks');
const DashboardController = require('./routes/admin/dashboard.controller');
const { getToolManager } = require('./agent-sdk/tools');
const { setDashboardController } = require('./admin/runtime-monitor');
const { getAuthenticatedUser, getSafeReturnTo, requireAuth } = require('./auth/service');
const { ConversationOrchestrator } = require('./conversation-orchestrator');
const { ConversationRunService } = require('./conversation-run-service');
const { AgentWorkloadService } = require('./workloads/service');
const { AgentWorkloadRunner } = require('./workloads/runner');
const { AgentCompanyService } = require('./agent-company');
const { ManagedAppService } = require('./managed-apps/service');
const { ProviderSessionService } = require('./provider-session-service');
const { RemoteAgentTaskService } = require('./remote-agent-task-service');
const { TemplateStore } = require('./template-store');
const { podcastService } = require('./podcast/podcast-service');
const { podcastVideoService } = require('./video/podcast-video-service');
const { remoteRunnerService } = require('./remote-runner/service');
const { asyncLabService } = require('./async-lab/service');
const { AgentRunService } = require('./agent-runs');
const { startHttpAgentRunShadow } = require('./agent-runs/runtime-bridge');
const {
    buildSystemHealthReport,
    createStartupState,
    markStartupFailed,
    markStartupReady,
} = require('./observability/health-report');

// Document Service
const { DocumentService } = require('./documents/document-service');
const { createResponse } = require('./openai-client');
const { extractResponseText } = require('./artifacts/artifact-service');

validate();

const agentRunService = new AgentRunService({ store: asyncLabService.store });
const app = express();
app.set('trust proxy', 1);
app.locals.dashboardController = new DashboardController(null);
app.locals.asyncLabService = asyncLabService;
app.locals.agentRunService = agentRunService;
setDashboardController(app.locals.dashboardController);

let startupState = {
    ...createStartupState(),
};
app.locals.startupState = startupState;

app.use(helmet({
    contentSecurityPolicy: false,
    originAgentCluster: false,
}));
app.use((req, res, next) => cors(buildCorsOptions(config.security, req))(req, res, next));
app.use(express.json({ limit: '10mb' }));

const loginRateLimit = createRateLimit({
    name: 'login',
    max: config.security.loginRateLimitMax,
    windowMs: config.security.rateLimitWindowMs,
});
const apiRateLimit = createRateLimit({
    name: 'api',
    max: config.security.rateLimitMax,
    windowMs: config.security.rateLimitWindowMs,
    skip: isToolInvokePath,
});
const toolRateLimit = createRateLimit({
    name: 'tool-invoke',
    max: config.security.toolRateLimitMax,
    windowMs: config.security.rateLimitWindowMs,
});

app.get('/health', async (_req, res) => {
    const health = await buildSystemHealthReport({
        app,
        startupState,
    });
    res.status(health.httpStatus).json(health);
});

app.get('/live', (_req, res) => {
    res.status(200).json({
        status: 'live',
        timestamp: new Date().toISOString(),
    });
});

app.get('/ready', (_req, res) => {
    res.status(startupState.ready ? 200 : 503).json({
        status: startupState.ready ? 'ready' : (startupState.status === 'degraded' ? 'degraded' : 'starting'),
        startedAt: startupState.startedAt,
        initializedAt: startupState.initializedAt || null,
        error: startupState.lastError || null,
        timestamp: new Date().toISOString(),
    });
});

const frontendPath = process.env.FRONTEND_PATH || path.join(__dirname, '../frontend');

const FRONTEND_HTML_CACHE_CONTROL = 'no-store';
const FRONTEND_VERSIONED_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const FRONTEND_SHORT_ASSET_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=86400';
const FRONTEND_EARLY_SHELL_MARKER = '<!-- kb-fast-shell-end -->';
const FRONTEND_EARLY_SHELL_YIELD_MS = Number(process.env.FRONTEND_EARLY_SHELL_YIELD_MS || 16);
const FRONTEND_FULL_ENTRY_QUERY = '__kb_full';

function isVersionedFrontendAssetRequest(req = {}, filePath = '') {
    const requestUrl = String(req.originalUrl || req.url || '');
    try {
        const parsed = new URL(requestUrl, 'http://localhost');
        if (parsed.searchParams.has('v')) {
            return true;
        }
    } catch (_error) {
        // Fall back to filename matching below.
    }

    return /[.-][a-f0-9]{8,}\.(?:css|js|mjs|png|jpe?g|webp|gif|svg|woff2?)$/i.test(String(filePath || ''));
}

function buildFrontendStaticOptions() {
    return {
        setHeaders(res, filePath) {
            if (String(filePath || '').toLowerCase().endsWith('.html')) {
                res.setHeader('Cache-Control', FRONTEND_HTML_CACHE_CONTROL);
                return;
            }

            res.setHeader('Cache-Control', isVersionedFrontendAssetRequest(res.req, filePath)
                ? FRONTEND_VERSIONED_ASSET_CACHE_CONTROL
                : FRONTEND_SHORT_ASSET_CACHE_CONTROL);
        },
    };
}

function splitFrontendHtmlForEarlyShell(html = '') {
    const source = String(html);
    const markerIndex = source.indexOf(FRONTEND_EARLY_SHELL_MARKER);
    if (markerIndex === -1) {
        return [source, ''];
    }

    const splitIndex = markerIndex + FRONTEND_EARLY_SHELL_MARKER.length;
    return [source.slice(0, splitIndex), source.slice(splitIndex)];
}

function streamFrontendEntryHtml(filePath) {
    return async (_req, res, next) => {
        try {
            const html = await fs.promises.readFile(filePath, 'utf8');
            const [shellHtml, restHtml] = splitFrontendHtmlForEarlyShell(html);

            res.status(200);
            res.setHeader('Content-Type', 'text/html; charset=UTF-8');
            res.setHeader('Cache-Control', FRONTEND_HTML_CACHE_CONTROL);
            res.write(shellHtml);

            if (typeof res.flushHeaders === 'function') {
                res.flushHeaders();
            }

            if (!restHtml) {
                res.end();
                return;
            }

            setTimeout(() => {
                res.end(restHtml);
            }, Math.max(0, FRONTEND_EARLY_SHELL_YIELD_MS));
        } catch (error) {
            next(error);
        }
    };
}

function escapeHtmlAttribute(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function buildFrontendBootstrapHtml({
    label,
    fullPath,
    background = '#0b1020',
    text = '#f8fafc',
    accent = '#38bdf8',
} = {}) {
    const safeLabel = escapeHtmlAttribute(label || 'KimiBuilt');
    const safeFullPath = escapeHtmlAttribute(fullPath || '/');
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>${safeLabel}</title>
    <style>
        html, body { margin: 0; min-height: 100%; background: ${background}; color: ${text}; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        body { display: grid; place-items: center; min-height: 100vh; }
        .kb-fast-shell { display: grid; gap: 10px; justify-items: center; }
        .kb-fast-shell__mark { width: 34px; height: 34px; border-radius: 8px; background: ${accent}; box-shadow: 0 0 0 1px rgba(255,255,255,.14), 0 12px 32px color-mix(in srgb, ${accent} 30%, transparent); }
        .kb-fast-shell__label { font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    </style>
</head>
<body>
    <main class="kb-fast-shell" aria-label="Loading ${safeLabel}">
        <div class="kb-fast-shell__mark" aria-hidden="true"></div>
        <div class="kb-fast-shell__label">${safeLabel}</div>
    </main>
    <script>
        (function loadFullFrontend() {
            var fullUrl = ${JSON.stringify(safeFullPath)};
            var shellReadyMs = Math.round(performance.now());
            window.KimiBuiltFrontendLoadMetrics = {
                label: ${JSON.stringify(safeLabel)},
                criticalShellReadyMs: shellReadyMs,
                fullFrontendDelayMs: 64
            };
            if (performance.mark) {
                performance.mark('kimibuilt-critical-shell-ready');
            }
            window.KimiBuiltFrontendFullUrl = fullUrl;
            function appendLoader() {
                var script = document.createElement('script');
                script.src = '/shared/frontend-entry-loader.js?v=20260621a';
                document.body.appendChild(script);
            }
            setTimeout(appendLoader, 64);
        })();
    </script>
</body>
</html>`;
}

function sendFrontendBootstrapHtml(options) {
    const bootstrapHtml = buildFrontendBootstrapHtml(options);

    return (_req, res) => {
        res.status(200);
        res.setHeader('Content-Type', 'text/html; charset=UTF-8');
        res.setHeader('Cache-Control', FRONTEND_HTML_CACHE_CONTROL);
        res.send(bootstrapHtml);
    };
}

function registerFrontendEntryHtmlRoutes(targetApp, mountPath, filePath, bootstrapOptions = {}) {
    const fullHandler = streamFrontendEntryHtml(filePath);
    const bootstrapHandler = sendFrontendBootstrapHtml(bootstrapOptions);
    const entryHandler = (req, res, next) => {
        if (req.query?.[FRONTEND_FULL_ENTRY_QUERY] === '1') {
            return fullHandler(req, res, next);
        }
        return bootstrapHandler(req, res, next);
    };

    targetApp.get(mountPath, entryHandler);
    targetApp.get(`${mountPath}/`, entryHandler);
    targetApp.get(`${mountPath}/index.html`, entryHandler);
}

app.get('/login', (req, res) => {
    const authState = getAuthenticatedUser(req);
    if (authState.authenticated) {
        return res.redirect(getSafeReturnTo(req.query.returnTo || '/'));
    }
    return res.sendFile(path.join(frontendPath, 'auth', 'login.html'));
});

app.use('/api/auth/login', loginRateLimit);
app.use('/api/auth/mfa/verify', loginRateLimit);
app.use('/api/auth', authRouter);
app.use('/api/integrations/gitlab', gitlabIntegrationsRouter);
app.use('/api/integrations/gitea', giteaIntegrationsRouter);
app.use('/api/async-lab/webhooks', asyncLabWebhooksRouter);
app.use('/api/sandbox-libraries', sandboxLibrariesRouter);
app.post('/api/runners/register', (req, res, next) => {
    try {
        remoteRunnerService.authenticateRequest(req);
        const runner = remoteRunnerService.registerRunner(req.body || {});
        res.status(201).json({ runner });
    } catch (error) {
        res.status(error.message.includes('Invalid') ? 401 : 503).json({
            error: {
                message: error.message,
            },
        });
    }
});
app.use(requireAuth);
app.use('/api', apiRateLimit);

// Serve only the 4 active frontends
registerFrontendEntryHtmlRoutes(app, '/web-chat', path.join(frontendPath, 'web-chat', 'app.html'), {
    label: 'Lilly Workspace',
    fullPath: `/web-chat/app.html?${FRONTEND_FULL_ENTRY_QUERY}=1`,
    background: '#0b1020',
    text: '#f8fafc',
    accent: '#38bdf8',
});
app.get('/web-chat/app.html', streamFrontendEntryHtml(path.join(frontendPath, 'web-chat', 'app.html')));
registerFrontendEntryHtmlRoutes(app, '/web-cli', path.join(frontendPath, 'web-cli', 'index.html'), {
    label: 'Web CLI',
    fullPath: `/web-cli/index.html?${FRONTEND_FULL_ENTRY_QUERY}=1`,
    background: '#0d1117',
    text: '#e6edf3',
    accent: '#58a6ff',
});
registerFrontendEntryHtmlRoutes(app, '/notes', path.join(frontendPath, 'notes-notion', 'index.html'), {
    label: 'Notes',
    fullPath: `/notes/index.html?${FRONTEND_FULL_ENTRY_QUERY}=1`,
    background: '#f8fafc',
    text: '#0f172a',
    accent: '#2563eb',
});
registerFrontendEntryHtmlRoutes(app, '/canvas', path.join(frontendPath, 'canvas-excalidraw', 'index.html'), {
    label: 'Canvas',
    fullPath: `/canvas/index.html?${FRONTEND_FULL_ENTRY_QUERY}=1`,
    background: '#f8fafc',
    text: '#111827',
    accent: '#7c3aed',
});
app.use('/web-chat', express.static(path.join(frontendPath, 'web-chat'), buildFrontendStaticOptions()));
app.use('/web-cli', express.static(path.join(frontendPath, 'web-cli'), buildFrontendStaticOptions()));
app.use('/notes', express.static(path.join(frontendPath, 'notes-notion'), buildFrontendStaticOptions()));
app.use('/canvas', express.static(path.join(frontendPath, 'canvas-excalidraw'), buildFrontendStaticOptions()));
app.use('/podcast-video', express.static(path.join(frontendPath, 'podcast-video'), buildFrontendStaticOptions()));
app.use('/admin', express.static(path.join(frontendPath, 'agent-dashboard'), buildFrontendStaticOptions()));
app.use('/async-lab', express.static(path.join(frontendPath, 'async-lab'), buildFrontendStaticOptions()));
app.use('/launchpad', express.static(path.join(frontendPath, 'launchpad'), buildFrontendStaticOptions()));

app.get('/', (_req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Lilly</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 800px;
            margin: 50px auto;
            padding: 20px;
            background: #0d0d0d;
            color: #fafafa;
        }
        h1 { color: #3b82f6; }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-top: 30px;
        }
        .card {
            background: #1f1f1f;
            border: 1px solid #333;
            border-radius: 12px;
            padding: 20px;
            text-decoration: none;
            color: inherit;
            transition: all 0.2s;
        }
        .card:hover {
            border-color: #3b82f6;
            transform: translateY(-2px);
        }
        .card h3 {
            margin-top: 0;
            color: #3b82f6;
        }

    </style>
</head>
<body>
    <h1>Lilly</h1>
    <p>Choose your interface:</p>
    <div class="grid">
        <a href="/web-chat/" class="card">
            <h3>Web Chat</h3>
            <p>ChatGPT-style interface</p>
        </a>
        <a href="/web-cli/" class="card">
            <h3>Web CLI</h3>
            <p>Terminal-style AI interface</p>
        </a>
        <a href="/notes/" class="card">
            <h3>Notes</h3>
            <p>Lilly-style note taking with AI</p>
        </a>
        <a href="/canvas/" class="card">
            <h3>Canvas</h3>
            <p>Visual canvas with Lilly drawing tools</p>
        </a>
        <a href="/podcast-video/" class="card">
            <h3>Podcast Wave</h3>
            <p>Turn podcast audio into waveform MP4</p>
        </a>
        <a href="/admin/" class="card" style="border-color: #22c55e;">
            <h3>🎛️ Admin Dashboard</h3>
            <p>Agent SDK control and monitoring</p>
        </a>
    </div>
</body>
</html>
    `);
});

app.use('/api/chat', chatRouter);
app.use('/api/async-lab', asyncLabRouter);
app.use('/api/agent-runs', agentRunsRouter);
app.use('/api/canvas', async (req, res, next) => {
    if (req.method !== 'POST') return next();
    try {
        await startHttpAgentRunShadow(req, res, {
            surface: 'canvas-http',
            mode: 'canvas',
            state: 'executing',
            objective: req.body?.message || req.body?.prompt || 'Canvas request',
            eventType: 'canvas.response',
        });
        return next();
    } catch (error) {
        return next(error);
    }
});
app.use('/api/canvas', canvasRouter);
app.use('/api/notation', async (req, res, next) => {
    if (req.method !== 'POST') return next();
    try {
        await startHttpAgentRunShadow(req, res, {
            surface: 'notation-http',
            mode: 'notation',
            state: 'executing',
            objective: req.body?.notation || req.body?.message || 'Notation request',
            eventType: 'notation.response',
        });
        return next();
    } catch (error) {
        return next(error);
    }
});
app.use('/api/notation', notationRouter);
app.use('/api/notes', notesRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/preferences', preferencesRouter);
app.use('/api/models', modelsRouter);
app.use('/api/tts', ttsRouter);
app.use('/api/audio', audioRouter);
app.use('/api/podcast', podcastRouter);
app.use('/api/images', imagesRouter);
app.use('/api/artifacts', artifactsRouter);
app.use('/api/sandbox-workspaces', sandboxWorkspacesRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/design-resources', designResourcesRouter);
app.use('/api/unsplash', unsplashRouter);
app.use('/v1', openaiCompatRouter);
app.use('/openai/v1', openaiCompatRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin', providerSessionsRouter);
app.use('/api/admin', remoteAgentTasksRouter);
app.use('/admin', providerSessionsRouter);
app.use('/admin', remoteAgentTasksRouter);
app.use('/api/tools/invoke', toolRateLimit);
app.use('/api/tools', toolsRouter);
app.use('/api/skills', skillsRouter);
app.use('/api', workloadsRouter);
app.use('/api', managedAppsRouter);
app.use('/api', runnersRouter);

app.use(express.static(path.join(__dirname, '../frontend'), buildFrontendStaticOptions()));

app.use((_req, res) => {
    res.status(404).json({ error: { message: 'Not found' } });
});

app.use(errorHandler);

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const runnerWss = new WebSocketServer({ noServer: true });
setupWebSocket(wss, app);
runnerWss.on('connection', (ws, req) => {
    try {
        remoteRunnerService.attachWebSocket(ws, req);
    } catch (error) {
        ws.close(4401, error.message);
    }
});
server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
        pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch (_error) {
        socket.destroy();
        return;
    }

    const targetWss = pathname === '/ws/runners'
        ? runnerWss
        : (pathname === '/ws' ? wss : null);

    if (!targetWss) {
        socket.destroy();
        return;
    }

    targetWss.handleUpgrade(req, socket, head, (ws) => {
        targetWss.emit('connection', ws, req);
    });
});

async function initializeRuntimeServices(targetApp = app, state = startupState) {
    try {
        console.log('[Boot] Initializing session store...');
        await sessionStore.initialize();
        console.log('[Boot] Session store ready');
        await settingsController.loadSettings();
        console.log('[Boot] Admin settings loaded');

        let runtimeVectorStore = vectorStore;
        console.log('[Boot] Initializing memory service...');
        try {
            await memoryService.initialize();
            console.log('[Boot] Memory service ready');
        } catch (error) {
            runtimeVectorStore = null;
            console.warn(`[Boot] Memory service unavailable, continuing without vector-backed recall: ${error.message}`);
        }

        console.log('[Boot] Initializing tool platform...');
        const toolManager = getToolManager();
        await toolManager.initialize();
        app.locals.toolManager = toolManager;
        console.log(`[Boot] Tool platform ready (${toolManager.registry.getAllTools().length} tools)`);
        
        console.log('[Boot] Initializing template store...');
        const templateStore = new TemplateStore();
        await templateStore.initialize();
        app.locals.templateStore = templateStore;
        console.log('[Boot] Template store ready');

        console.log('[Boot] Initializing document service...');
        // Create OpenAI-compatible client for document generation
        const openaiClient = {
            createResponse: async (params) => {
                return createResponse(params);
            },
            complete: async (prompt, options = {}) => {
                const response = await createResponse({
                    input: prompt,
                    stream: false,
                    model: options.model || null,
                    reasoningEffort: options.reasoningEffort || null,
                });

                return extractResponseText(response);
            },
        };
        openaiClient.responses = {
            create: async (params = {}) => createResponse({
                input: params.input || params.messages || '',
                stream: Boolean(params.stream),
                model: params.model || null,
                reasoningEffort: params.reasoning?.effort || params.reasoning_effort || null,
            }),
        };
        openaiClient.chat = {
            completions: {
                create: async (params = {}) => {
                    const response = await createResponse({
                        input: params.messages || params.input || '',
                        stream: Boolean(params.stream),
                        model: params.model || null,
                        reasoningEffort: params.reasoning_effort || params.reasoning?.effort || null,
                    });
                    const content = extractResponseText(response);

                    return {
                        id: response.id,
                        object: 'chat.completion',
                        created: response.created || Math.floor(Date.now() / 1000),
                        model: response.model || params.model || null,
                        choices: [{
                            index: 0,
                            message: {
                                role: 'assistant',
                                content,
                            },
                            finish_reason: 'stop',
                        }],
                    };
                },
            },
        };
        const documentService = new DocumentService(openaiClient);
        app.locals.documentService = documentService;
        app.locals.artifactService = artifactService;
        app.locals.podcastService = podcastService;
        app.locals.podcastVideoService = podcastVideoService;
        console.log('[Boot] Document service ready');

        console.log('[Boot] Initializing conversation orchestrator...');
        const conversationOrchestrator = new ConversationOrchestrator({
            llmClient: openaiClient,
            toolManager,
            sessionStore,
            memoryService,
            embedder,
            vectorStore: runtimeVectorStore,
        });
        console.log('[Boot] Conversation orchestrator ready');

        app.locals.conversationOrchestrator = conversationOrchestrator;
        app.locals.dashboardController.setOrchestrator(conversationOrchestrator);
        setDashboardController(app.locals.dashboardController);
        app.locals.providerSessionService = new ProviderSessionService();
        app.locals.remoteAgentTaskService = new RemoteAgentTaskService({
            providerSessionService: app.locals.providerSessionService,
        });
        app.locals.conversationRunService = new ConversationRunService({
            app,
            sessionStore,
            memoryService,
        });
        app.locals.agentWorkloadService = new AgentWorkloadService({
            sessionStore,
            conversationRunService: app.locals.conversationRunService,
            agentRunService,
        });
        app.locals.managedAppService = new ManagedAppService();
        app.locals.agentWorkloadRunner = new AgentWorkloadRunner({
            workloadService: app.locals.agentWorkloadService,
        });
        app.locals.agentWorkloadRunner.start();
        app.locals.agentCompanyService = new AgentCompanyService({
            settingsController,
            workloadService: app.locals.agentWorkloadService,
            sessionStore,
            logsController,
            agentRunService,
        });
        app.locals.agentCompanyService.start();
        app.locals.asyncLabService = asyncLabService;
        asyncLabService.configureExecutionRuntime?.({
            toolManager,
            sessionStore,
            toolExecutionContext: {
                memoryService,
                documentService: app.locals.documentService,
                managedAppService: app.locals.managedAppService,
                workloadService: app.locals.agentWorkloadService,
                providerSessionService: app.locals.providerSessionService,
                remoteAgentTaskService: app.locals.remoteAgentTaskService,
            },
        });
        const asyncRuntimeControl = settingsController.getEffectiveAsyncRuntimeConfig?.() || {
            enabled: config.asyncRuntime.enabled,
            adminToggleAllowed: config.asyncRuntime.adminToggleAllowed,
        };
        if (asyncRuntimeControl.requestedEnabled || asyncRuntimeControl.adminToggleAllowed) {
            console.log('[Boot] Applying async runtime lab control plane...');
            const asyncRuntimeResult = await asyncLabService.applyControlConfig(asyncRuntimeControl);
            const asyncRuntimeStatus = asyncLabService.getStatus();
            if (asyncRuntimeResult.active) {
                console.log(`[Boot] Async runtime lab ready (${asyncRuntimeStatus.bus.backend} bus)`);
            } else {
                console.log(`[Boot] Async runtime lab standby (${asyncRuntimeResult.reason}); production runtime continues unchanged`);
            }
        }
        const ttsConfig = ttsService.getPublicConfig();
        console.log(`[Boot] TTS ${ttsConfig.provider || 'unknown'} ${ttsConfig.diagnostics?.status || 'unknown'}: ${ttsConfig.diagnostics?.message || 'No details available.'}`);
        const audioProcessingConfig = audioProcessingService.getPublicConfig();
        console.log(`[Boot] Audio processing ${audioProcessingConfig.provider || 'unknown'} ${audioProcessingConfig.diagnostics?.status || 'unknown'}: ${audioProcessingConfig.diagnostics?.message || 'No details available.'}`);
        markStartupReady(state);
        targetApp.locals.startupState = state;
    } catch (err) {
        console.warn('[Boot] Service init failed (will retry on first use):', err.message);
        markStartupFailed(state, err);
        targetApp.locals.startupState = state;
    }
}

async function start({ listen = true, initialize = initializeRuntimeServices } = {}) {
    await initialize(app, startupState);

    if (listen && !server.listening) {
        server.listen(config.port, '0.0.0.0', () => {
            console.log(`Lilly backend listening on http://0.0.0.0:${config.port}`);
        });
    }

    return { app, server, startupState };
}

const startupPromise = process.env.NODE_ENV === 'test'
    ? Promise.resolve({ app, server, startupState })
    : start();

module.exports = {
    app,
    buildFrontendStaticOptions,
    initializeRuntimeServices,
    server,
    splitFrontendHtmlForEarlyShell,
    start,
    startupPromise,
    startupState,
};
