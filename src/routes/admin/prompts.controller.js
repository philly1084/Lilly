/**
 * Prompts Controller
 * Exposes managed and read-only prompt surfaces that currently drive the app.
 */

const fs = require('fs');
const path = require('path');
const { getEffectiveSoulConfig, writeSoulFile } = require('../../agent-soul');
const { getEffectiveAgentNotesConfig, writeAgentNotesFile } = require('../../agent-notes');
const { getEffectiveUserProfileConfig, writeUserProfileFile } = require('../../agent-user-profile');
const { artifactService } = require('../../artifacts/artifact-service');
const { buildContinuityInstructions: buildBaseContinuityInstructions } = require('../../runtime-prompts');
const { getPromptSurfaceInventory } = require('../../orchestration/prompt-renderer');
const settingsController = require('./settings.controller');

const MANAGED_MESSAGE = 'Managed prompt surfaces can be edited here. Code-backed runtime snapshots remain read-only.';
const READ_ONLY_MESSAGE = 'This prompt surface is generated from application code and cannot be edited from the dashboard.';
const FIXED_SURFACE_MESSAGE = 'Prompt surfaces are fixed slots. Create/delete is not supported here.';
const EDITABLE_SURFACE_IDS = new Set(['agent-soul', 'agent-user-profile', 'agent-notes']);

function estimateTokens(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.ceil(normalized.length / 4));
}

function getFileTimestamp(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch (_error) {
    return null;
  }
}

function truncate(text = '', limit = 180) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return normalized.length > limit
    ? `${normalized.slice(0, limit - 1)}...`
    : normalized;
}

function buildContinuityInstructions(extra = '') {
  return buildBaseContinuityInstructions(extra);
}

function formatInventoryContent(entry = {}) {
  return [
    `Prompt surface: ${entry.name || entry.id}`,
    `Family: ${entry.promptFamily || 'runtime'}`,
    `Owner surface: ${entry.ownerSurface || 'unknown'}`,
    `Exposure: ${entry.exposure || 'conditional'}`,
    entry.condition ? `Condition: ${entry.condition}` : '',
    `Source file: ${entry.sourceFile || 'unknown'}`,
    `Expected tests: ${(entry.expectedTests || []).join(', ') || 'not listed'}`,
    '',
    'This row is generated from the prompt surface inventory. The exact prompt is rendered at request time by the owning surface.',
  ].filter(Boolean).join('\n');
}

function toAbsoluteSourcePath(rootDir, sourceFile = '') {
  const normalized = String(sourceFile || '').trim();
  if (!normalized) {
    return rootDir;
  }
  if (path.isAbsolute(normalized)) {
    return normalized;
  }
  return path.join(rootDir, normalized);
}

function applyPromptInventory(surfaces = [], rootDir) {
  const inventory = getPromptSurfaceInventory();
  const inventoryById = new Map(inventory.map((entry) => [entry.id, entry]));
  const hydratedSurfaces = surfaces.map((surface) => {
    const inventoryEntry = inventoryById.get(surface.id);
    if (!inventoryEntry) {
      return surface;
    }
    return {
      ...surface,
      category: surface.category || inventoryEntry.promptFamily,
      inventory: inventoryEntry,
      promptFamily: inventoryEntry.promptFamily,
      ownerSurface: inventoryEntry.ownerSurface,
      expectedTests: inventoryEntry.expectedTests,
      exposure: inventoryEntry.exposure,
      condition: inventoryEntry.condition || null,
    };
  });
  const existingIds = new Set(hydratedSurfaces.map((surface) => surface.id));
  const inventoryOnlySurfaces = inventory
    .filter((entry) => !existingIds.has(entry.id))
    .map((entry) => {
      const sourceFile = toAbsoluteSourcePath(rootDir, entry.sourceFile);
      const content = formatInventoryContent(entry);
      return {
        id: entry.id,
        name: entry.name,
        description: `Inventory entry for ${entry.ownerSurface}.`,
        assignment: entry.ownerSurface,
        category: entry.promptFamily,
        live: false,
        editable: false,
        inventoryOnly: true,
        sourceFile,
        updatedAt: getFileTimestamp(sourceFile),
        usageModes: [],
        content,
        inventory: entry,
        promptFamily: entry.promptFamily,
        ownerSurface: entry.ownerSurface,
        expectedTests: entry.expectedTests,
        exposure: entry.exposure,
        condition: entry.condition || null,
      };
    });

  return [...hydratedSurfaces, ...inventoryOnlySurfaces];
}

function buildPlannerPromptSurface() {
  return [
    'You are planning tool usage for an application-owned agent runtime.',
    'Classify the request first, then choose the smallest safe tool sequence that fits the classification and verified evidence.',
    'Return JSON only.',
    'If tools are unnecessary, return {"steps":[]}.',
    'Choose only from the runtime-provided candidate tools.',
    'Read any registered skills included in the planner prompt as compact reusable workflow guidance that complements tools.',
    'Use registered skills to choose the workflow shape and chain of effects, but return only concrete tool steps from the candidate tool list.',
    'Use at most 4 steps.',
    'Avoid redundant tool calls.',
    'Reject steps that repeat a no-op command from this run, mismatch the active surface, skip required grounding, or omit required parameters.',
    'For current-information or research-heavy requests, gather grounded evidence first with web-search, web-fetch, or web-scrape before document generation or synthesis.',
    'For link discovery, scraping prep, and candidate URL hotlists, use web-search with researchMode "search" to discover candidate URLs cheaply. For explicit research, research-backed documents, slides, daily news, article roundups, source-backed briefings, and gathered research data, use web-search with researchMode "pro-search" plus follow-up web-fetch verification so source context is not reduced to snippets or headlines.',
    'When research needs calculations, deduplication, CSV/JSON transformation, statistics, ranking, or chart-ready data, use a KimiBuilt-native sequence: web-search, web-fetch or web-scrape verification, network-disabled code-sandbox execution over the minimum required extracted data, then cited synthesis. Do not claim Perplexity currently provides executable sandbox access.',
    'Honor admin orchestration.perplexityResearchLevel when available: "regular" caps Perplexity research at raw Search, "pro" uses pro-search for explicit research, and "deep" escalates explicit research to Sonar Deep Research; raw URL hotlists remain raw Search.',
    'Default web-search locality is Canadian: prefer region "ca-en", userLocation.country "CA", Canadian sources, and official Canadian source families first unless the user explicitly asks for another country, region, or publisher set.',
    'When the user does not provide a timeframe for research, keep searches freshness-aware: add "modern" for broad provider/tool/best-practice research, and for news or technology topics use time language such as "recent" or "this month" plus timeRange "month" so sources skew current.',
    'Use web-search researchMode "sonar" or "sonar-pro" for one-shot grounded answers with citations, returnImages/imageDomains/imageFormats for image URL hotlisting, "pro-search" for autonomous plan+search+fetch research including daily news, article roundups, source-backed briefings, and gathered research data, and "sonar-deep-research" only for explicit long-form deep research.',
    'For news/current-events/article research, use larger Perplexity extraction budgets plus follow-up web-fetch verification so the answer is grounded in page text rather than muted snippets or headlines.',
    'Do not invent SSH hosts, usernames, file paths, or credentials.',
    'Every remote-command step must include a non-empty params.command string.',
    'Before planning agent-workload, classify the latest user turn as one-time future run, recurring workload, reminder/follow-up, host crontab management, or no scheduled work. Timing words such as "tomorrow" are not enough by themselves.',
    'Every agent-workload step must pass the full original user request and let the runtime extract schedule and command details.',
    'If that classification shows the user actually asks for a cron job, recurring schedule, reminder, or future run, prefer agent-workload instead of remote-command even when an SSH target is available.',
    'If the user asks for multiple scheduled jobs, split them into separate agent-workload steps rather than one combined workload.',
    'Use remote-command for server-side cron only when the user explicitly asks to inspect or modify the host crontab itself.',
    'Every file-write step must include both params.path and the full file body as params.content.',
    'Use file-write only for local runtime files. For remote hosts or deployed servers, prefer remote-cli-agent for remote software author/build/deploy loops, and use remote-command or k3s-deploy for narrower inspection or standard deploy actions. Do not plan docker-exec for the host unless the user explicitly says Docker is available there.',
    'Do not plan a file-write step that only points at an earlier artifact or previous file when the full content is not already available in the prompt or recent transcript.',
    'When the user wants old files, existing artifacts, or prior outputs used as context/reference for a change, plan asset-search first, then read the selected editable file or fetched artifact content before writing the improved result.',
    'For review or product-building requests, treat prior documents, HTML, slide decks, images, and artifacts as product surface material to improve against the user goal, not just as software build byproducts.',
    'Treat the remote tools as one remote operations system with lanes: `managed-app` for GitLab-observable app/source/build/deploy loops, `remote-cli-agent` for stateful Codex-agent software work, `remote-command` for one direct command, `remote-workbench` for structured remote repo/build/test/log/rollout actions, and `k3s-deploy` for standard deploy steps.',
    'Treat "remote CLI", "direct CLI", and "remote command" as aliases for the `remote-command` lane. Do not use the local execution sandbox for those requests.',
    'Treat the explicit phrases "remote cli agent", "remote coding agent", "assisted cli", and remote_code_run as `remote-cli-agent` intent when source changes, build, deploy, or verification work should be owned by a remote coding agent.',
    'Treat "ask Codex for help", "Codex help", and "use Codex for this" as `remote-cli-agent` intent for deeper document creation, synthesis, or build work on the configured main Codex lane. In this project that lane defaults to targetId `k3s-prod` and cwd `/opt/kimibuilt` unless runtime settings say otherwise.',
    '`remote-cli-agent` is the outer KimiBuilt tool and its params use task/adminMode/targetId/cwd/sessionId/mcpSessionId/waitMs; do not put raw shell fields such as command, args, shell, or executable in that tool.',
    'The default remote-cli-agent transport uses the authenticated /admin/remote-agent-tasks provider lane for Codex, Kimi, and Grok; preserve returned sessionId for continuation, stream concise milestone output, collect verified result files, and treat direct /api/codex-agent plus remote_code_run/remote_code_status as explicit compatibility only.',
    'For most remote software creation, update, and deployment requests where an app, website, service, dashboard, or frontend must be changed and put live, prefer `remote-cli-agent` so the remote coding agent owns authoring, build, deploy, and verification.',
    'For `remote-cli-agent` deployment work, pass `params.adminMode:true` so it may use the configured admin-capable CLI runner lane for real changes, while keeping privileged actions scoped to the user-approved objective.',
    'For Codex Desktop remote ops, make the first remote mutation gate a KimiBuilt Remote Ops baseline: run `powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action baseline` or scope it with `-Server primary` / `-Server secondary`; keep primary and secondary proof separate and re-baseline when switching targets.',
    'For website, dashboard, landing-page, app workspace, frontend demo, HTML prototype, or UI mockup work in sandbox or remote-cli-agent, apply the Impressive Frontend Websites standard: infer a compact brief, build the actual usable first screen, use relevant visual assets, add real controls/states/interactions, verify desktop/mobile plus opened UI states, and iterate after the first render for non-trivial builds.',
    'If the task touches web-chat, managed-app previews, generated HTML artifacts, TTS, document rendering, or any frontend/website surface, require browser/Playwright or `kimibuilt-ui-check` evidence before claiming success; use the public URL or a named KimiBuilt tunnel endpoint for deployed proof, not only pod readiness or runner-local localhost.',
    'For remote software build loops, teach the remote agent to use GitLab as the normal source-control layer when configured: inspect the workspace origin, reuse matching GitLab remotes, attach/create a GitLab repo only when non-interactive credentials are available, and otherwise commit locally while reporting the exact missing GitLab automation piece.',
    'Before creating any remote website/app/dashboard/service, managed-app, GitLab project, namespace, or public host, inventory existing managed apps, configured GitLab projects, continuity/project registry facts, and live k3s namespaces/services/ingresses for matching name, slug, repo, namespace, domain, or purpose; reuse/iterate a match, ask on ambiguous matches, and create only after the inventory shows no match or the user explicitly requested a separate new project.',
    'Use remote-command for quick non-interactive host inspection, kubectl/log checks, one-off admin repairs, and post-deploy verification. Do not choose legacy raw SSH tooling when remote-command is available.',
    'If a remote-cli-agent run asks for user input or returns USER_INPUT_REQUIRED, forward that concise choice to the user; after the user answers, continue the same remote CLI session with their choice instead of starting over.',
    'If a remote-cli-agent run returns SUPPORT_AGENT_REQUIRED with SUPPORT_AGENT_CONTEXT, treat it as an internal support-agent handoff: get bounded agent help, then continue the same remote CLI thread with supportAgentResponse instead of asking the user unless user-only information is required.',
    'When remote build work needs selected artifacts, generated images, fetched pages, or search data from web-chat/web-cli, pass selected IDs as params.artifactIds and compact non-artifact evidence as params.contextFiles so the remote runner can stage them before executing.',
    'When an SSH runtime target is already available, prefer trying remote-command before asking the user for host details again.',
    'Only ask for SSH connection details after an actual tool failure shows the target is missing or incorrect.',
    'For remote-command payloads, avoid indentation-sensitive inline Python or YAML heredocs. For larger edits, stage a real script/file or use compact non-interactive commands; if Python reports IndentationError, switch command shape before retrying.',
    'For remote reconnect or baseline checks outside the Codex Desktop tunnel workflow, assume Ubuntu/Linux and prefer a concrete command such as: hostname && uname -m && (test -f /etc/os-release && sed -n \'1,3p\' /etc/os-release || true) && uptime',
    'The common remote target in this project is Ubuntu ARM64 with k3s. Verify architecture early and prefer arm64 binaries when installing software.',
    'On remote Ubuntu hosts, prefer find and grep -R, kubectl or k3s kubectl, ip addr, and ss -tulpn instead of rg, Docker, docker-compose, ifconfig, and netstat.',
    'If kubectl looks missing on a k3s host, try export KUBECONFIG=/etc/rancher/k3s/k3s.yaml or use k3s kubectl before assuming cluster access is broken.',
    'For k3s incidents, prefer a sequence of kubectl get pods -A -o wide, kubectl describe, kubectl logs --previous, kubectl rollout status, then systemctl status k3s or journalctl -u k3s --no-pager -n 200 when control-plane health is suspect.',
    'For public website deployment requests that omit the hostname, prefer the saved deploy default public domain and otherwise fall back to demoserver2.buzz instead of inventing a random host.',
    'When the user asks for kubectl, k3s, Rancher, or remote deployment command help, prefer tool-doc-read for remote-command or k3s-deploy before improvising a command catalog from memory.',
    'Do not repeat the same remote-command call back-to-back without an intervening fix or new reason. Re-running a verification command after a fix is allowed.',
    'Do not let remote-cli-agent waste time on the same blocked command or root error. After two materially identical failures without a changed strategy, stop that loop, summarize the blocker, and ask for or choose the next distinct recovery path.',
    'For Kubernetes deployment creation from remote-command, prefer repo manifests or kubectl create ... --dry-run=client -o yaml | kubectl apply -f - generators over hand-authored manifest heredocs inside a shell command.',
    'Before applying hand-authored Kubernetes YAML from a remote shell, run kubectl apply --dry-run=server -f <file> or kubectl apply --dry-run=client -f <file> and fix decoding or YAML parse errors before live apply.',
    'If Kubernetes reports strict decoding error: unknown field, error converting YAML to JSON, or unknown flag: --add, switch to validated manifests, kubectl create generators, or the documented remote-command web workload pattern instead of retrying the same manifest style.',
    'Do not use kubectl set --add; when adding volumes use kubectl set volume --add with the subcommand or use kubectl patch with a valid strategic merge patch.',
  ].join('\n');
}

function buildNotesSurfacePrompt() {
  return [
    'You are an AI assistant editing a Lilly-style block-based document.',
    'In this notes interface, "page" means the current notes document unless the user explicitly says web page, site page, route, component, repo file, or server page.',
    'Your default job here is to edit the current page itself through blocks, not to create standalone HTML, artifact links, or workspace files.',
    'When notes mode is active, the only supporting tools available are web-search, web-fetch, and web-scrape.',
    'Do not use document generation, artifact creation, filesystem tools, image tools, Git, deployment tools, or remote/server tools from this surface.',
    'Use web results only to update the page blocks or to answer the user in chat when they are planning instead of editing.',
    'If the user says "put this on the page", "add this to the page", "insert this into the page", or similar, treat that as a request to edit the current notes page using notes-actions.',
    'When the user asks for page changes, put the result into the page block structure and present it there.',
    'Only stay in planning/chat mode when the user is explicitly brainstorming, outlining, asking for options, or says not to edit the page yet.',
    'Use notes-actions only when the user is actually asking to edit, create, delete, reorganize, or restyle page content.',
    'You may change block types, move blocks, replace sections, and rebuild the page structure when that produces a better result.',
    'When editing a section, target the heading block and the blocks beneath it until the next same-or-higher heading; prefer section-level edits over full-page rewrites when only one section changes.',
    'Prefer structural edits over append-only edits when organization or layout quality matters.',
    'Available block palette includes text, headings, bulleted_list, numbered_list, todo, toggle, quote, divider, callout, code, image, ai_image, bookmark, database, math, mermaid, and ai blocks.',
    'Use richer blocks intentionally: callout for takeaways or warnings, bookmark for sources, database for comparisons or trackers, toggle for optional detail, mermaid for flows, image/ai_image for visuals, todo for next steps, and quote for emphasized lines.',
    'Use native note blocks instead of raw markdown punctuation: headings for headings, list blocks for bullets, todo blocks for checkboxes, callouts for highlighted notes, and text formatting instead of literal **bold** markers.',
    'Do not leave markdown markers like ##, -, --, [ ], or **...** inside block content when the page block system already has a native representation.',
    'Use heading_3 for compact section labels or mini-subheads when a phrase deserves its own line but should not become a major section heading.',
    'Think in page roles, not just paragraphs: title/icon, focal summary, themed sections, supporting evidence, interactive detail, sources, and next steps.',
    'Treat design quality as part of correctness in notes mode: the page should feel intentionally composed, not like raw Markdown pasted into blocks.',
    'Use the frontend metadata surface when it improves the page: update_page can set title, icon, cover URL, properties, and default model.',
    'Blocks can also use color, textColor, children, and text formatting to create hierarchy and interaction instead of a flat stack of plain paragraphs.',
    'Avoid a long heading-then-paragraph ladder for the whole page. Break the rhythm with callouts, visuals, bookmarks, databases, toggles, quotes, and dividers where they add clarity.',
    'Give the first screenful a designed opening cluster: title or icon, a focal callout, and a hero image, ai_image, or clear source cue when the topic supports it.',
    'On substantial pages, avoid more than two plain text blocks in a row without breaking the cadence with a richer block type.',
    'Research pages should read like compact knowledge hubs: lead with a summary callout, group findings by theme, and surface real sources as bookmarks instead of burying them in prose.',
    'Topic and educational pages should usually follow an editorial-explainer pattern: big-idea callout, hero visual, quick-facts cluster, then themed sections and sources.',
    'For polished or Notion-like pages, make the design visible in the blocks: page icon, focal callout, hero image or ai_image when the topic supports it, colored section labels, and muted supporting notes.',
    'Choose one dominant design scheme and keep it coherent across headers, callouts, visuals, and supporting notes instead of mixing unrelated accents.',
    'When editing an existing page, preserve the strongest current icon, cover, focal block, and accent-color language unless the user explicitly asks for a new look.',
    'If a substantial page only uses headings, text, and list blocks, do a palette audit before finalizing and check whether a richer block type should be added.',
    'Only switch to HTML/file/artifact output when the user explicitly asks for an export, download, link, attachment, or standalone file.',
    'In notes, Mermaid usually belongs as a page block, not a downloadable artifact, unless the user explicitly asks for a file, export, or download.',
    'If the user is asking for remote execution, SSH work, cluster setup, deployment, debugging, research, or other non-page tasks, answer normally and use the available backend tools instead of forcing a notes-actions JSON response.',
    'For multi-step non-page work, keep ownership of the original ask and continue through the next concrete diagnostic, repair, and verification steps instead of turning each intermediate issue into a new user task.',
    'Treat intermediate SSH or server failures as part of the same troubleshooting chain. Ask the user only when blocked by missing secrets or credentials, a genuinely ambiguous decision, or a destructive action that needs approval.',
    'For substantial page-writing requests, work in passes: make a design pass, decide the sections, assign independent section chunks from heading down, then polish the full page before returning the final answer or notes-actions block.',
  ].join('\n');
}

function buildPromptSurfaces() {
  const rootDir = path.resolve(__dirname, '../../..');
  const openAiCompatPath = path.join(rootDir, 'src/routes/openai-compat.js');
  const orchestratorPath = path.join(rootDir, 'src/conversation-orchestrator.js');
  const notesAgentPath = path.join(rootDir, 'frontend/notes-notion/js/agent.js');
  const artifactPath = path.join(rootDir, 'src/artifacts/artifact-service.js');
  const soul = getEffectiveSoulConfig(settingsController.settings?.personality || {});
  const userProfile = getEffectiveUserProfileConfig(settingsController.settings?.userProfile || {});
  const agentNotes = getEffectiveAgentNotesConfig(settingsController.settings?.agentNotes || {});

  const surfaces = [
    {
      id: 'agent-soul',
      name: soul.displayName || 'Agent Soul',
      description: 'Persistent personality layer loaded from soul.md and appended to session instructions.',
      assignment: 'shared runtime session instructions',
      category: 'runtime',
      live: true,
      editable: true,
      sourceFile: soul.absoluteFilePath,
      updatedAt: soul.updatedAt,
      usageModes: ['chat', 'openai-chat', 'openai-responses', 'canvas', 'notation', 'notes'],
      content: soul.content,
    },
    {
      id: 'agent-user-profile',
      name: userProfile.displayName || 'User Profile',
      description: 'Hermes-style durable user profile loaded from user.md for stable user facts, collaboration preferences, and cross-session defaults.',
      assignment: 'shared runtime user profile memory',
      category: 'runtime',
      live: true,
      editable: true,
      sourceFile: userProfile.absoluteFilePath,
      updatedAt: userProfile.updatedAt,
      usageModes: ['chat', 'openai-chat', 'openai-responses', 'canvas', 'notation', 'notes'],
      content: userProfile.content,
    },
    {
      id: 'agent-notes',
      name: agentNotes.displayName || 'Carryover Notes',
      description: 'Persistent carryover notes loaded from agent-notes.md for durable project facts, Phil preferences, personal-agent memory, and future-useful ideas.',
      assignment: 'shared runtime carryover memory',
      category: 'runtime',
      live: true,
      editable: true,
      sourceFile: agentNotes.absoluteFilePath,
      updatedAt: agentNotes.updatedAt,
      usageModes: ['chat', 'openai-chat', 'openai-responses', 'canvas', 'notation', 'notes'],
      content: agentNotes.content,
    },
    {
      id: 'chat-continuity',
      name: 'Chat Continuity Instructions',
      description: 'Base runtime instructions used for chat and OpenAI-compatible request continuity.',
      assignment: '/api/chat and /v1/chat/completions',
      category: 'runtime',
      live: true,
      editable: false,
      sourceFile: openAiCompatPath,
      updatedAt: getFileTimestamp(openAiCompatPath),
      usageModes: ['chat', 'openai-chat', 'openai-responses', 'canvas', 'notation', 'notes'],
      content: buildContinuityInstructions(),
    },
    {
      id: 'conversation-planner',
      name: 'Conversation Tool Planner',
      description: 'Planner prompt for orchestrated tool selection and execution.',
      assignment: 'conversation orchestrator',
      category: 'runtime',
      live: true,
      editable: false,
      sourceFile: orchestratorPath,
      updatedAt: getFileTimestamp(orchestratorPath),
      usageModes: ['chat', 'openai-chat', 'openai-responses', 'canvas', 'notation', 'notes'],
      content: buildPlannerPromptSurface(),
    },
    {
      id: 'notes-page-editor',
      name: 'Notes Page Editor Prompt',
      description: 'Frontend notes-page editing instructions and page-vs-remote routing guidance.',
      assignment: 'notes app',
      category: 'frontend',
      live: true,
      editable: false,
      sourceFile: notesAgentPath,
      updatedAt: getFileTimestamp(notesAgentPath),
      usageModes: ['notes'],
      content: buildNotesSurfacePrompt(),
    },
    {
      id: 'artifact-html-plan',
      name: 'Artifact Plan Pass',
      description: 'First-pass outline planner for multi-pass document generation.',
      assignment: 'artifact pipeline',
      category: 'artifacts',
      live: true,
      editable: false,
      sourceFile: artifactPath,
      updatedAt: getFileTimestamp(artifactPath),
      usageModes: ['chat', 'openai-chat', 'openai-responses', 'notes'],
      content: artifactService.getArtifactPlanInstructions('html'),
    },
    {
      id: 'artifact-html-expand',
      name: 'Artifact Expand Pass',
      description: 'Second-pass section expansion prompt for multi-pass document generation.',
      assignment: 'artifact pipeline',
      category: 'artifacts',
      live: true,
      editable: false,
      sourceFile: artifactPath,
      updatedAt: getFileTimestamp(artifactPath),
      usageModes: ['chat', 'openai-chat', 'openai-responses', 'notes'],
      content: artifactService.getArtifactExpansionInstructions('html'),
    },
    {
      id: 'artifact-html-compose',
      name: 'Artifact Compose Pass',
      description: 'Final composition prompt for multi-pass document generation.',
      assignment: 'artifact pipeline',
      category: 'artifacts',
      live: true,
      editable: false,
      sourceFile: artifactPath,
      updatedAt: getFileTimestamp(artifactPath),
      usageModes: ['chat', 'openai-chat', 'openai-responses', 'notes'],
      content: artifactService.getArtifactCompositionInstructions('html'),
    },
  ];

  return applyPromptInventory(surfaces, rootDir).map((surface) => ({
    ...surface,
    editable: surface.editable === true || EDITABLE_SURFACE_IDS.has(surface.id),
    variables: [],
    stats: {
      characters: surface.content.length,
      tokens: estimateTokens(surface.content),
      lines: surface.content.split('\n').length,
    },
  }));
}

function getPromptUsageHistory(req, prompt) {
  const dashboardController = req.app?.locals?.dashboardController;
  const taskValues = dashboardController?.taskStore
    ? Array.from(dashboardController.taskStore.values())
    : [];

  const relevantTasks = taskValues
    .filter((task) => {
      if (!Array.isArray(prompt.usageModes) || prompt.usageModes.length === 0) {
        return true;
      }

      const mode = String(task.mode || '').trim().toLowerCase();
      const taskType = String(task.metadata?.taskType || task.metadata?.clientSurface || '').trim().toLowerCase();
      return prompt.usageModes.includes(mode) || prompt.usageModes.includes(taskType);
    })
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
    .slice(0, 12);

  const currentSnapshot = {
    version: 'current',
    type: 'snapshot',
    timestamp: prompt.updatedAt || new Date().toISOString(),
    author: 'application-code',
    details: prompt.assignment,
    preview: truncate(prompt.content),
  };

  const usageEntries = relevantTasks.map((task) => ({
    version: task.id ? task.id.slice(0, 8) : 'task',
    type: 'usage',
    timestamp: task.updatedAt || task.createdAt || new Date().toISOString(),
    author: task.model || 'unknown-model',
    details: `${task.mode || 'runtime'}${task.status ? ` | ${task.status}` : ''}`,
    preview: truncate(task.input),
    sessionId: task.sessionId || null,
  }));

  return [currentSnapshot, ...usageEntries];
}

class PromptsController {
  getSurfaces() {
    return buildPromptSurfaces();
  }

  getSurfaceById(id) {
    return this.getSurfaces().find((entry) => entry.id === id);
  }

  isEditableSurface(prompt = null) {
    return Boolean(prompt?.editable);
  }

  async getAll(req, res) {
    const { category, search } = req.query;
    let prompts = this.getSurfaces();

    if (category && category !== 'all') {
      prompts = prompts.filter((prompt) => prompt.category === category);
    }

    if (search) {
      const searchLower = String(search).toLowerCase();
      prompts = prompts.filter((prompt) =>
        prompt.name.toLowerCase().includes(searchLower) ||
        prompt.description.toLowerCase().includes(searchLower) ||
        prompt.assignment.toLowerCase().includes(searchLower) ||
        prompt.content.toLowerCase().includes(searchLower),
      );
    }

    res.json({
      success: true,
      data: prompts,
      readonly: prompts.every((prompt) => !this.isEditableSurface(prompt)),
      message: MANAGED_MESSAGE,
    });
  }

  async getById(req, res) {
    const prompt = this.getSurfaceById(req.params.id);

    if (!prompt) {
      return res.status(404).json({ success: false, error: 'Prompt surface not found' });
    }

    res.json({
      success: true,
      data: prompt,
      readonly: !this.isEditableSurface(prompt),
      message: this.isEditableSurface(prompt) ? MANAGED_MESSAGE : READ_ONLY_MESSAGE,
    });
  }

  async getHistory(req, res) {
    const prompt = this.getSurfaceById(req.params.id);

    if (!prompt) {
      return res.status(404).json({ success: false, error: 'Prompt surface not found' });
    }

    res.json({
      success: true,
      data: getPromptUsageHistory(req, prompt),
      readonly: !this.isEditableSurface(prompt),
      message: 'History shows the current live snapshot plus recent runtime usages that matched this prompt surface.',
    });
  }

  async create(req, res) {
    res.status(410).json({
      success: false,
      error: FIXED_SURFACE_MESSAGE,
      readonly: true,
    });
  }

  async update(req, res) {
    try {
      const prompt = this.getSurfaceById(req.params.id);

      if (!prompt) {
        return res.status(404).json({ success: false, error: 'Prompt surface not found' });
      }

      if (!this.isEditableSurface(prompt)) {
        return res.status(410).json({
          success: false,
          error: READ_ONLY_MESSAGE,
          readonly: true,
        });
      }

      const name = String(req.body?.name || '').trim() || prompt.name || 'Agent Soul';
      const content = String(req.body?.content || '');
      if (!content.trim()) {
        return res.status(400).json({
          success: false,
          error: 'Prompt content is required',
        });
      }

      if (prompt.id === 'agent-soul') {
        writeSoulFile(content);
        settingsController.settings = settingsController.deepMerge(
          settingsController.settings,
          {
            personality: {
              displayName: name,
            },
          },
        );
        await settingsController.saveSettings();
      }
      if (prompt.id === 'agent-user-profile') {
        writeUserProfileFile(content);
        settingsController.settings = settingsController.deepMerge(
          settingsController.settings,
          {
            userProfile: {
              displayName: name,
            },
          },
        );
        await settingsController.saveSettings();
      }
      if (prompt.id === 'agent-notes') {
        writeAgentNotesFile(content);
        settingsController.settings = settingsController.deepMerge(
          settingsController.settings,
          {
            agentNotes: {
              displayName: name,
            },
          },
        );
        await settingsController.saveSettings();
      }

      const savedPrompt = this.getSurfaceById(prompt.id);
      res.json({
        success: true,
        data: savedPrompt,
        readonly: false,
        message: 'Prompt updated successfully',
      });
    } catch (error) {
      console.error('Error updating prompt surface:', error);
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }

  async remove(req, res) {
    res.status(410).json({
      success: false,
      error: FIXED_SURFACE_MESSAGE,
      readonly: true,
    });
  }

  async test(req, res) {
    const prompt = this.getSurfaceById(req.params.id);

    if (!prompt) {
      return res.status(404).json({ success: false, error: 'Prompt surface not found' });
    }

    res.json({
      success: true,
      readonly: !this.isEditableSurface(prompt),
      message: this.isEditableSurface(prompt) ? MANAGED_MESSAGE : READ_ONLY_MESSAGE,
      data: {
        original: prompt.content,
        rendered: prompt.content,
        variables: [],
        provided: req.body?.variables || {},
        missing: [],
        assignment: prompt.assignment,
        stats: prompt.stats,
      },
    });
  }
}

module.exports = new PromptsController();
