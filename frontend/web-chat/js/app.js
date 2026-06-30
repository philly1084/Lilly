/**
 * Main Application for LillyBuilt AI Chat
 * Orchestrates all components and handles user interactions
 * Now using OpenAI SDK for API communication
 */

const AMBIENT_REASONING_ROTATE_MIN_MS = 20000;
const AMBIENT_REASONING_ROTATE_MAX_MS = 30000;
const AMBIENT_REASONING_TYPE_TICK_MS = 120;
const REAL_REASONING_DISPLAY_HOLD_MS = 40000;
const SYNTHETIC_REASONING_TITLE = 'Live progress';
const WEB_CHAT_QUEUE_MAX_SIZE = 3;
const STREAM_RENDER_BUFFER_MS = 90;
const MANAGED_APP_PROGRESS_RENDER_BUFFER_MS = 1200;
const WEB_CHAT_TOOL_MENU_STORAGE_KEY = 'kimibuilt_web_chat_plugin_lanes';
const WEB_CHAT_TOOL_COMMAND_STARTER_PARAMS = Object.freeze({
    'web-search': { query: '' },
    'web-fetch': { url: '' },
    'web-scrape': { url: '', browser: true },
    'news-scraper': { query: '' },
    'image-generate': { prompt: '' },
    'image-search-unsplash': { query: '' },
    'image-from-url': { url: '' },
    'asset-search': { query: '' },
    'document-workflow': { action: 'recommend', request: '' },
    'design-resource-search': { query: '' },
    'code-sandbox': { prompt: '' },
    'file-search': { pattern: '**/*.{html,css,js,jsx,ts,tsx}', cwd: '' },
    'file-read': { path: '' },
    'file-write': { path: '', content: '' },
    'git-safe': { action: 'status' },
    'remote-cli-agent': { task: '', adminMode: true },
    'remote-command': { command: '' },
    'remote-workbench': { action: 'inspect' },
    'k3s-deploy': { action: 'status' },
    'agent-workload': { action: 'recommend', prompt: '' },
});
const WEB_CHAT_REMOTE_TOOL_IDS = new Set([
    'remote-cli-agent',
    'managed-app',
    'k3s-deploy',
    'remote-command',
    'remote-workbench',
]);
const WEB_CHAT_ASYNC_REMOTE_EVENT_TYPES = [
    'queued',
    'started',
    'lease_recovered',
    'heartbeat',
    'progress',
    'safety',
    'tool_message',
    'tool_started',
    'tool_completed',
    'tool_failed',
    'tool_skipped',
    'checkpoint',
    'lock_acquired',
    'lock_wait',
    'webhook_received',
    'completed',
    'failed',
    'cancelled',
    'cancel_requested',
];
const WEB_CHAT_TOOL_INTENT_DEFINITIONS = Object.freeze([
    {
        id: 'research',
        label: 'Web',
        summary: 'Search and fetch current source pages before answering.',
        tools: ['web-search', 'web-fetch'],
        instructions: 'Use public web research when the answer depends on current, external, or source-backed information.',
        decisionTree: [
            'Start with web-search for broad discovery.',
            'Use web-fetch for selected source pages before relying on them.',
            'Summarize from verified source context rather than snippets when possible.',
        ],
    },
    {
        id: 'extract',
        label: 'Extract',
        summary: 'Use richer scraping and article extraction when snippets are not enough.',
        tools: ['web-search', 'web-fetch', 'web-scrape', 'news-scraper'],
        instructions: 'Use extraction tools when the user asks for articles, roundups, structured fields, or rendered page content.',
        decisionTree: [
            'Search for candidate pages first unless the user provides URLs.',
            'Fetch simple pages before scraping.',
            'Use web-scrape or news-scraper when rendered, structured, or full-article extraction is needed.',
        ],
    },
    {
        id: 'images',
        label: 'Images',
        summary: 'Create image artifacts from the user prompt.',
        tools: ['image-generate'],
        instructions: 'Use image generation when the user asks for a new visual asset, mock, illustration, hero image, or generated media.',
        decisionTree: [
            'Clarify only if the missing visual constraint would materially change the result.',
            'Prefer generating a concrete artifact over describing one.',
        ],
    },
    {
        id: 'references',
        label: 'Refs',
        summary: 'Find or reuse visual references and image URLs.',
        tools: ['image-search-unsplash', 'image-from-url', 'asset-search'],
        instructions: 'Use reference and asset tools when the request needs visual source material before synthesis.',
        decisionTree: [
            'Use image-from-url when the user gives a direct image link.',
            'Use image-search-unsplash or asset-search when the user needs reference material.',
        ],
    },
    {
        id: 'documents',
        label: 'Docs',
        summary: 'Route deliverables through document workflow tools.',
        tools: ['document-workflow'],
        instructions: 'Use document-workflow for structured documents, reports, PDFs, PPTX decks, XLSX workbooks, Markdown, and export-ready artifacts.',
        decisionTree: [
            'Plan the document structure before generation.',
            'Use document-workflow generate or generate-suite for final deliverables.',
        ],
    },
    {
        id: 'sandbox',
        label: 'Sandbox',
        summary: 'Build and verify previewable frontend artifacts.',
        tools: ['design-resource-search', 'code-sandbox', 'web-scrape'],
        instructions: 'Use design resources, sandbox build tools, and browser verification for frontend or website work.',
        decisionTree: [
            'Gather design context when the user asks for a visual build.',
            'Build in a previewable sandbox when the user wants an app, site, dashboard, or prototype.',
            'Verify the preview with browser scraping or screenshots before calling it done.',
        ],
    },
    {
        id: 'ide',
        label: 'IDE',
        summary: 'Improve reusable frontend source with search, reads, targeted edits, and verification.',
        tools: ['file-search', 'file-read', 'file-write', 'git-safe', 'code-sandbox', 'web-scrape'],
        metadata: {
            frontendEditMode: true,
            frontendSourceStrategy: 'search-read-targeted-edit-verify',
            frontendIterationPreferred: true,
        },
        instructions: 'Use an IDE-style loop for existing frontend work: search first, read only the smallest relevant files, preserve reusable source, make targeted edits, then run syntax/tests and browser or UI checks.',
        decisionTree: [
            'Find the relevant source with file-search or grep-style patterns before reading broad files.',
            'Read the smallest file slices needed to understand the current structure.',
            'Prefer targeted source edits over replacing the whole frontend when an existing project or bundle is available.',
            'Run focused syntax/tests and browser or UI-check proof after the edit.',
        ],
    },
    {
        id: 'remote',
        label: 'Remote',
        summary: 'Use the remote build lane for live server work.',
        tools: ['remote-cli-agent'],
        executionProfile: 'remote-build',
        metadata: {
            remoteBuildAutonomyApproved: true,
            frontendRemoteBuildAutonomyApproved: true,
            remoteBuildIntent: true,
            preferredTool: 'remote-cli-agent',
        },
        instructions: 'Use remote-cli-agent for scoped remote software creation, updates, builds, deployments, and live verification.',
        decisionTree: [
            'Use remote-cli-agent as the primary lane for remote build or deploy work.',
            'Keep the inner remote agent responsible for remote code execution and status checks.',
            'Report blockers rather than replacing failed remote work with local-only output.',
        ],
    },
    {
        id: 'workload',
        label: 'Workload',
        summary: 'Create or run background agent workloads.',
        tools: ['agent-workload'],
        instructions: 'Use agent-workload when the user asks for scheduled, recurring, monitor, or background agent work.',
        decisionTree: [
            'Infer a compact workload definition from the user request.',
            'Ask one checkpoint only when schedule or scope is genuinely ambiguous.',
        ],
    },
]);
const webChatWorkspaceHelpers = window.KimiBuiltWebChatWorkspace || null;
const webChatWorkspaceEmbedHelpers = window.KimiBuiltWebChatWorkspaceEmbed || null;
const WEB_CHAT_APP_WORKSPACE_CONTEXT = typeof webChatWorkspaceHelpers?.getWorkspaceContext === 'function'
    ? webChatWorkspaceHelpers.getWorkspaceContext()
    : {
        key: 'workspace-1',
        embedded: false,
    };
const AMBIENT_REASONING_STARTS = [
    'Just milking the moose',
    'Running with a fowl',
    'Kicking beavers with eagles',
    'Untangling the lobster antennae',
    'Polishing moon boots for the raccoon brigade',
    'Borrowing thunder from the gull patrol',
    'Tuning the otter orchestra',
    'Stacking pebbles for the badger council',
    'Whispering directions to the marmot express',
    'Juggling lanterns with the fox mechanics',
    'Warming the maple reactor',
    'Threading starlight through the goose gears',
    'Convincing the loon committee to stay on topic',
    'Measuring fog with the harbor crows',
    'Stitching sparks into the salmon net',
    'Calibrating the beehive semaphore',
    'Sorting clues in the porcupine pantry',
    'Teaching the heron engine to pirouette',
    'Sharpening pencils for the midnight beaver shift',
    'Coaching the moondust pigeons through customs',
    'Greasing the walrus elevator',
    'Sweeping confetti out of the raven observatory',
    'Translating the goose minutes into usable math',
    'Folding weather maps for the raccoon quartermaster',
    'Buffing the trout periscope',
    'Balancing teacups on the elk radar',
    'Rehearsing alibis with the seal accountants',
    'Untying knots in the owl telegraph',
    'Catching runaway commas for the squirrel newsroom',
    'Refilling lantern oil for the coyote librarians',
    'Re-threading the skunk carousel',
    'Checking torque on the pelican launch rig',
    'Sorting dominoes for the marmot weather bureau',
    'Testing brakes on the puffin monorail',
    'Patching constellations above the vole shipyard',
    'Herding suspicious semicolons past the loon customs desk',
    'Measuring soup pressure in the badger boiler room',
    'Dusting footprints off the otter blueprint vault',
    'Negotiating snacks with the ferret union',
    'Calming the yak signal repeater',
    'Unspooling twine across the gull foundry',
    'Rewinding cassette tapes for the beaver archives',
    'Counting thunderbolts in the muskrat pantry',
    'Polishing helmets for the pigeon cavalry',
    'Refitting the moose compass with fresh magnets',
    'Teaching the crab forklift some manners',
    'Mapping alleyways for the possum courier service',
    'Inventorying moonbeams in the heron warehouse',
    'Straightening the fox observatory curtains',
    'Filing reports for the wolf lighthouse board',
    'Defrosting the beehive jukebox',
    'Tightening bolts on the narwhal weather vane',
    'Running diagnostics on the cod parade float',
    'De-tangling fairy lights in the goose depot',
    'Tuning the accordion in the bat command center',
    'Chasing echoes through the mink tunnel network',
    'Aligning mirrors for the beaver eclipse lab',
    'Refreshing the marmalade reserves in the badger embassy',
    'Repainting lane markers for the penguin drag strip',
    'Calibrating the puffin rumor detector',
    'Untucking the seals from the filing cabinet',
    'Rebalancing the marmot chandelier',
    'Sharpening chalk for the heron cartographers',
    'Inflating backup tires for the squirrel rover',
    'Resetting the walrus espresso boiler',
    'Sorting moon rocks in the possum annex',
    'Greasing hinges on the beaver observatory hatch',
    'Counting freckles on the cod navigation chart',
    'Testing lantern batteries for the fox relay team',
    'Folding tarp corners in the loon machine room',
    'Waking the crab semaphore one claw at a time',
    'Stacking invoices for the otter ferry guild',
    'Brushing frost off the raven signal dish',
    'Refilling the badger weather cannon',
    'Untangling kite string in the puffin switchyard',
    'Checking flour levels in the raccoon bakery lab',
    'Polishing gauges on the elk tide engine',
    'Shuffling index cards for the muskrat dispatch desk',
    'Anchoring the gull weather balloon',
    'Cooling the porcupine soldering bench',
    'Winding springs for the mink transit clock',
    'Charting puddles for the moose survey corps',
    'Refitting the heron newsroom with quieter gears',
    'Straightening banners in the ferret hangar',
    'Sharpening compasses for the goose rescue flotilla',
    'Bundling spare bolts for the squirrel tram depot',
    'Counting biscuits for the wolf audit committee',
    'Resetting the badger hourglass array',
    'Teaching the otter lighthouse to blink on beat',
    'Inspecting hinges in the marmot archive vault',
    'De-icing the pelican message tube',
    'Balancing ledgers in the beaver tea room',
    'Rotating mirrors in the loon signal attic',
    'Checking spark plugs on the yak rumor wagon',
    'Ventilating the possum blueprint cellar',
    'Collecting spare feathers for the goose upholstery unit',
    'Debugging the trout weather choir',
    'Unpacking crates in the heron customs bay',
    'Calming the mink kettle drum',
    'Washing soot off the crab launch scaffold',
    'Tightening rivets on the raven rain catcher',
    'Refreshing ink wells in the owl map shop',
    'Sorting brass keys for the fox locksmith train',
    'Priming the beehive story engine',
    'Tallying footsteps in the badger corridor',
    'Leveling tables in the otter signal cafe',
    'Refolding the eel parade banners',
    'Refastening ropes on the puffin cargo lift',
    'Proofreading memos for the marmot switchboard',
    'Uncrumpling blueprints in the coyote drafting den',
    'Loading coal into the walrus tea locomotive',
    'Cleaning lenses for the seal horizon bureau',
    'Bracing ladders in the raccoon weather mill',
    'Running inventory on the beaver snack locker',
    'Spinning up the heron fog projector',
    'Counting paperclips in the fox observatory pantry',
    'Sanding splinters off the moose briefing bench',
    'Re-keying the gull workshop lockers',
    'Clearing steam from the otter signal tunnel',
    'Balancing lunch trays for the penguin design review',
    'Packing spare chalk for the badger courtroom sketch artist',
    'Resetting the pigeon tram timetable',
    'Unjamming the goose confetti cannon',
    'Checking rail ties beneath the marmot commuter loop',
    'Rinsing coffee cups in the fox weather bunker',
    'Tightening clamps on the raven echo bridge',
    'Sorting acorns for the squirrel pension office',
    'Measuring candlelight in the elk drafting hall',
    'Cooling the cod lantern forge',
    'Straightening pamphlets in the seal transit kiosk',
    'Repacking rope coils for the heron freight elevator',
    'Testing whistles in the otter shift tunnel',
    'Brushing chalk dust off the loon debate podium',
    'Refilling glue jars in the possum repair shed',
    'Reindexing the bat observatory notebooks',
    'Counting aprons in the beaver machine canteen',
    'Adjusting shutters on the fox weather camera',
    'Inspecting ladders in the puffin relay tower',
    'Folding spare maps for the wolf courier bench',
    'Re-centering dials on the goose barometer cart',
    'Labeling bins in the marmot parts library',
    'Debris-sweeping the narwhal dockside rail',
    'Pacing out chalk lines in the raccoon testing yard',
    'Untwisting cables in the otter projection booth',
    'Checking gasket seals on the badger steam kettle',
    'Rehanging curtains in the heron planning room',
    'Rotating bulbs in the owl archive corridor',
    'Inspecting bolts on the fox rooftop pulley',
    'Fanning smoke out of the penguin tool loft',
];
const AMBIENT_REASONING_ENDINGS = [
    'while the answer sharpens',
    'under a politely unreasonable amount of chaos',
    'before the next clue clicks',
    'with maple-syrup precision',
    'between static and daylight',
    'so the gears stop arguing',
    'while the idea stack settles',
    'in case the useful bit arrives sideways',
    'to keep the thread from tangling',
    'while the final sentence lines up',
    'before the sensible version lands',
    'so the breadcrumbs stop tap dancing',
    'while the good answer elbows past the weird one',
    'until the static starts paying rent',
    'with a suspicious amount of maritime confidence',
    'before the moonlight hits the paperwork',
    'so the puzzle quits pretending to be furniture',
    'while the spare gears learn some discipline',
    'until the thread stops doing cartwheels',
    'with exactly enough nonsense to stay operational',
    'before the raccoons unionize the timeline',
    'while the quiet part puts on boots',
    'so the useful sentence can find the exit',
    'before the idea fog condenses into something practical',
    'while the answer climbs out of the tool shed',
    'while the useful answer stops hiding in the rafters',
    'so the next sentence can land without skidding',
    'until the puzzle starts wearing a name tag',
    'while the loose ends sit down and cooperate',
    'before the obvious part misses its train',
    'so the answer arrives with all four tires attached',
    'while the quiet clues stop whispering through vents',
    'before the wrong hunch borrows the microphone',
    'so the facts can line up without elbowing each other',
    'while the practical answer untangles its shoelaces',
    'until the messy draft remembers its job',
    'so the final idea has somewhere dry to stand',
    'while the answer irons its own collar',
    'before the breadcrumbs try to form a jazz trio',
    'so the useful bit stops circling the block',
    'while the thread learns how to walk in a straight line',
    'before the question puts on another disguise',
    'so the reply can arrive without spare smoke',
    'while the rough edges file themselves into order',
    'until the good explanation clears customs',
    'so the hidden hinge stops squeaking',
    'while the answer trades static for traction',
    'before the obvious route gets stuck behind a goose',
    'so the final wording quits pacing the hallway',
    'while the real point climbs onto the stage',
    'until the steady version takes the wheel',
    'so the final draft stops wearing roller skates',
    'before the neat solution wanders into traffic',
    'while the useful details stop hiding behind curtains',
    'so the right sentence can clock in on time',
    'before the practical answer misses roll call',
    'while the clean explanation finds its footing',
    'so the final shape stops wobbling on stilts',
    'before the good answer gets buried under glitter',
    'while the sensible route untangles itself from the side quest',
    'so the real signal can get above the static',
    'until the durable answer clears its throat',
];
const AMBIENT_REASONING_LINES = [
    'Reading the conversation context and looking for the next useful step.',
    'Checking the request against the available tools and recent messages.',
    'Separating known facts from assumptions before drafting the answer.',
    'Updating the working plan as new progress arrives.',
    'Reviewing the active task list and keeping the next action in focus.',
    'Keeping a clear progress summary while the response continues.',
    'Scanning the current response path for missing details.',
    'Condensing the live work into the clearest visible update.',
    'Tracking completed steps while the final response comes together.',
    'Preparing the answer structure before writing it into the thread.',
    'Checking whether tool results changed the plan.',
    'Keeping the visible progress aligned with the latest stream event.',
];

function shuffleArray(items = []) {
    const nextItems = Array.isArray(items) ? [...items] : [];
    for (let index = nextItems.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [nextItems[index], nextItems[swapIndex]] = [nextItems[swapIndex], nextItems[index]];
    }
    return nextItems;
}

function buildAmbientReasoningLines() {
    return shuffleArray(AMBIENT_REASONING_LINES);
}

function extractChatDisplayText(value = null, options = {}) {
    if (typeof uiHelpers !== 'undefined' && typeof uiHelpers?.extractDisplayText === 'function') {
        return uiHelpers.extractDisplayText(value, options);
    }

    if (typeof value === 'string') {
        return value.replace(/\s+/g, ' ').trim();
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (Array.isArray(value)) {
        return value
            .map((entry) => extractChatDisplayText(entry, options))
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    if (value && typeof value === 'object') {
        for (const key of ['summary', 'detail', 'message', 'text', 'content', 'title', 'label', 'reason']) {
            const extracted = extractChatDisplayText(value[key], options);
            if (extracted) {
                return extracted;
            }
        }
        try {
            return JSON.stringify(value);
        } catch (_error) {
            return '';
        }
    }

    return '';
}

function extractChatReasoningText(value = null) {
    if (typeof uiHelpers !== 'undefined' && typeof uiHelpers?.extractReasoningText === 'function') {
        return uiHelpers.extractReasoningText(value);
    }

    return extractChatDisplayText(value);
}

function cleanChatStatusText(value = null, options = {}) {
    const text = extractChatDisplayText(value, options)
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) {
        return '';
    }

    return text
        .replace(/^\s*(?:output|stdout|stderr|result|response|message|detail|summary|label|manual\s+label|step)\s*:\s*/i, '')
        .replace(/^["'“”]+|["'“”]+$/g, '')
        .replace(/`([^`]{1,120})`/g, '$1')
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/([.!?]){2,}$/g, '$1')
        .trim();
}

function extractChatStreamText(value = null) {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => extractChatStreamText(entry)).join('');
    }
    return extractChatDisplayText(value);
}

function normalizeToolIntentId(value = '') {
    return String(value || '').trim().toLowerCase();
}

function getToolIntentDefinitionById(value = '') {
    const intentId = normalizeToolIntentId(value);
    return WEB_CHAT_TOOL_INTENT_DEFINITIONS.find((definition) => definition.id === intentId) || null;
}

function getUniqueToolIdsFromIntentDefinitions(definitions = []) {
    return Array.from(new Set((Array.isArray(definitions) ? definitions : [])
        .flatMap((definition) => Array.isArray(definition?.tools) ? definition.tools : [])
        .map((toolId) => String(toolId || '').trim())
        .filter(Boolean)));
}

function buildToolIntentSelectionSummary(definitions = []) {
    const labels = (Array.isArray(definitions) ? definitions : [])
        .map((definition) => String(definition?.label || definition?.id || '').trim())
        .filter(Boolean);
    if (labels.length === 0) {
        return 'None selected';
    }
    if (labels.length <= 3) {
        return labels.join(', ');
    }
    return `${labels.slice(0, 3).join(', ')} +${labels.length - 3}`;
}

function escapeToolMenuHtml(value = '') {
    const text = String(value ?? '');
    if (typeof uiHelpers !== 'undefined' && typeof uiHelpers?.escapeHtml === 'function') {
        return uiHelpers.escapeHtml(text);
    }
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeToolMenuHtmlAttr(value = '') {
    if (typeof uiHelpers !== 'undefined' && typeof uiHelpers?.escapeHtmlAttr === 'function') {
        return uiHelpers.escapeHtmlAttr(String(value ?? ''));
    }
    return escapeToolMenuHtml(value);
}

function cloneToolCommandStarterParams(params = {}) {
    try {
        return JSON.parse(JSON.stringify(params || {}));
    } catch (_error) {
        return {};
    }
}

function buildDefaultToolParameterValue(schema = {}) {
    const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
    if (schema && Object.prototype.hasOwnProperty.call(schema, 'default')) {
        return schema.default;
    }
    if (Array.isArray(schema?.enum) && schema.enum.length > 0) {
        return schema.enum[0];
    }
    if (type === 'boolean') {
        return false;
    }
    if (type === 'integer' || type === 'number') {
        return 0;
    }
    if (type === 'array') {
        return [];
    }
    if (type === 'object') {
        return {};
    }
    return '';
}

class ChatApp {
    constructor() {
        this.messageInput = document.getElementById('message-input');
        this.sendBtn = document.getElementById('send-btn');
        this.voiceInputBtn = document.getElementById('voice-input-btn');
        this.voiceOutputBtn = document.getElementById('voice-output-btn');
        this.voiceInputIndicator = document.getElementById('voice-input-indicator');
        this.toolMenuBtn = document.getElementById('tool-menu-btn');
        this.toolMenuPanel = document.getElementById('tool-menu-panel');
        this.toolMenuCount = document.getElementById('tool-menu-count');
        this.toolMenuSummary = document.getElementById('tool-menu-summary');
        this.toolMenuSkillBtn = typeof document.querySelector === 'function' ? document.querySelector('[data-tool-menu-action="skill"]') : null;
        this.toolMenuCommandBtn = typeof document.querySelector === 'function' ? document.querySelector('[data-tool-menu-action="command"]') : null;
        this.toolMenuClearBtn = typeof document.querySelector === 'function' ? document.querySelector('[data-tool-menu-action="clear"]') : null;
        this.toolCommandPicker = document.getElementById('tool-command-picker');
        this.toolCommandSearch = document.getElementById('tool-command-search');
        this.toolCommandStatus = document.getElementById('tool-command-status');
        this.toolCommandList = document.getElementById('tool-command-list');
        this.selectedToolChipTray = document.getElementById('selected-tool-chip-tray');
        this.messagesContainer = document.getElementById('messages-container');
        this.charCounter = document.getElementById('char-counter');
        this.currentSessionInfo = document.getElementById('current-session-info');
        this.typingIndicator = document.getElementById('typing-indicator');
        this.backgroundWorkloadStatus = document.getElementById('background-workload-status');
        this.workloadsBtn = document.getElementById('workloads-btn');
        this.workloadsPanel = document.getElementById('workloads-panel');
        this.workloadsEmpty = document.getElementById('workloads-empty');
        this.workloadsList = document.getElementById('workloads-list');
        this.refreshWorkloadsBtn = document.getElementById('refresh-workloads-btn');
        this.closeWorkloadsPanelBtn = document.getElementById('close-workloads-panel-btn');
        this.newWorkloadBtn = document.getElementById('new-workload-btn');
        this.workloadModal = document.getElementById('workload-modal');
        this.workloadModalTitle = document.getElementById('workload-modal-title');
        this.workloadFormError = document.getElementById('workload-form-error');
        this.workloadScenarioInput = document.getElementById('workload-scenario-input');
        this.workloadScenarioBuildBtn = document.getElementById('workload-scenario-build-btn');
        this.workloadTriggerHelp = document.getElementById('workload-trigger-help');
        this.workloadTitleInput = document.getElementById('workload-title-input');
        this.workloadPromptInput = document.getElementById('workload-prompt-input');
        this.workloadTriggerType = document.getElementById('workload-trigger-type');
        this.workloadCallableSlug = document.getElementById('workload-callable-slug');
        this.workloadRunAt = document.getElementById('workload-run-at');
        this.workloadCronExpression = document.getElementById('workload-cron-expression');
        this.workloadTimezone = document.getElementById('workload-timezone');
        this.workloadProfile = document.getElementById('workload-profile');
        this.workloadToolIds = document.getElementById('workload-tool-ids');
        this.workloadMaxRounds = document.getElementById('workload-max-rounds');
        this.workloadMaxToolCalls = document.getElementById('workload-max-tool-calls');
        this.workloadMaxDuration = document.getElementById('workload-max-duration');
        this.workloadAllowSideEffects = document.getElementById('workload-allow-side-effects');
        this.workloadLongAgentEnabled = document.getElementById('workload-long-agent-enabled');
        this.workloadLongAgentScratch = document.getElementById('workload-long-agent-scratch');
        this.workloadLongAgentSteps = document.getElementById('workload-long-agent-steps');
        this.workloadStagesJson = document.getElementById('workload-stages-json');
        this.workloadOnceRow = document.getElementById('workload-once-row');
        this.workloadCronRow = document.getElementById('workload-cron-row');
        this.workloadPresetGrid = document.getElementById('workload-preset-grid');
        this.workloadPresetSummary = document.getElementById('workload-preset-summary');
        this.saveWorkloadBtn = document.getElementById('save-workload-btn');
        this.cancelWorkloadBtn = document.getElementById('cancel-workload-btn');
        this.closeWorkloadModalBtn = document.getElementById('close-workload-modal-btn');
        this.projectViewport = document.getElementById('project-viewport');
        this.projectViewportFrame = document.getElementById('project-viewport-frame');
        this.projectViewportLabel = document.getElementById('project-viewport-label');
        this.projectViewportLink = document.getElementById('project-viewport-link');
        this.projectViewportState = document.getElementById('project-viewport-state');
        this.projectViewportStateLabel = document.getElementById('project-viewport-state-label');
        this.projectViewportStateDetail = document.getElementById('project-viewport-state-detail');
        
        this.isProcessing = false;
        this.isCancellingCurrentRequest = false;
        this.currentStreamingMessageId = null;
        this.pendingCheckpointToolCallBuffers = new Map();
        this.liveIndicatorHideTimer = null;
        this.liveResponseState = {
            phase: 'idle',
            detail: '',
            reasoningSummary: '',
            hasRealReasoning: false,
        };
        this.ambientReasoningDeck = buildAmbientReasoningLines();
        this.ambientReasoningDeckIndex = 0;
        this.ambientReasoningCycle = null;
        this.ambientReasoningTimer = null;
        this.lastReasoningDeltaAt = 0;
        this.autoResize = null;
        this.searchResults = [];
        this.currentSearchIndex = -1;
        
        // Track if we're generating an image
        this.isGeneratingImage = false;
        this.currentImageMessageId = null;
        this.workspaceContext = WEB_CHAT_APP_WORKSPACE_CONTEXT;
        this.messageQueue = [];
        this.isProcessingQueue = false;
        this.skillWizardState = null;
        this.selectedToolIntentIds = new Set(this.loadStoredToolIntentIds());
        this.selectedDirectTool = null;
        this.toolCatalogTools = [];
        this.toolCatalogLoaded = false;
        this.toolCatalogLoading = false;
        this.toolCatalogLoadError = '';
        
        // Track retry state
        this.retryAttempt = 0;
        this.maxRetries = 3;
        
        // Abort controller for current stream
        this.currentAbortController = null;
        this.isCancellingCurrentRequest = false;
        this.processingSessions = new Set();
        this.streamStatesBySession = new Map();
        this.voiceInputState = {
            mode: 'idle',
            recorder: null,
            stream: null,
            chunks: [],
        };
        this.workloadsOpen = false;
        this.workloadsAvailable = null;
        this.currentSessionWorkloads = [];
        this.workloadRunsById = new Map();
        this.hiddenCompletedWorkloadCount = 0;
        this.editingWorkload = null;
        this.workloadSocket = null;
        this.workloadSocketConnecting = false;
        this.workloadSocketReconnectTimer = null;
        this.pendingWorkloadSessionId = null;
        this.workloadSocketReconnectDelayMs = 1500;
        this.workloadSocketMaxReconnectDelayMs = 15000;
        this.workloadSocketConsecutiveFailures = 0;
        this.workloadSocketCircuitDelayMs = 60000;
        this.workloadSocketPaused = false;
        this.longAgentDefaultEnabled = uiHelpers.isLongAgentDefaultEnabled?.() === true;
        this.backgroundWorkloadStatusHideTimer = null;
        this.subscribedWorkloadSessionId = null;
        this.isRefreshingSessionSummaries = false;
        this.isLoadingWorkloads = false;
        this.loadingWorkloadsSessionId = null;
        this.deferredSessionDetailsTimer = null;
        this.deferredSessionDetailsRequestId = 0;
        this.deferredSessionDetailsSessionId = null;
        this.isSavingWorkload = false;
        this.sharedSessionSyncTimer = null;
        this.sharedSessionRefreshInFlight = false;
        this.pendingStreamingRenders = new Map();
        this.activeStreamRequest = null;
        this.pendingStreamResync = null;
        this.resumeSyncTimer = null;
        this.resumeSyncInFlight = false;
        this.pageWasHidden = this.isAppBackgrounded();
        this.lastResumeSyncAt = 0;
        this.connectionStatus = 'checking';
        this.managedAppProgressByKey = new Map();
        this.managedAppHostMessageByKey = new Map();
        this.pendingManagedAppProgressRenders = new Map();
        this.projectPreviewTokenCache = null;
        this.projectViewportRequestId = 0;
        this.ttsAutoPlayQueue = [];
        this.ttsAutoPlayQueuedIds = new Set();
        this.ttsAutoPlayActive = false;
        
        this.init();
    }

    async init() {
        // Add preload class to prevent transitions on load
        document.body.classList.add('preload');

        await sessionManager.ensureUserPreferencesLoaded();
        uiHelpers.rehydrateStoredPreferences({ appInstance: this });
        
        // Initialize theme
        uiHelpers.initTheme();
        uiHelpers.initLayoutMode(this);
        
        // Initialize auto-resize textarea
        this.autoResize = uiHelpers.initAutoResize(this.messageInput);
        
        // Setup event listeners
        this.setupEventListeners();
        this.setupSessionListeners();
        this.setupKeyboardShortcuts();
        this.setupModelListeners();
        
        // Check connection status
        this.updateConnectionStatus('checking');
        void apiClient.checkHealth()
            .then((health) => {
                this.updateConnectionStatus(health.connected ? 'connected' : 'disconnected');
            })
            .catch(() => {
                this.updateConnectionStatus('disconnected');
            });
        
        // Start periodic health checks
        this.startHealthCheckInterval();
        this.startSharedSessionSyncInterval();
        
        // Load models in background
        uiHelpers.loadModels();

        uiHelpers.ttsManager?.addEventListener('statechange', () => this.updateAudioControls());
        uiHelpers.ttsManager?.addEventListener('configchange', () => this.updateAudioControls());

        // Load sessions
        await this.loadSessions();
        
        // Initialize Lucide icons
        uiHelpers.reinitializeIcons();
        this.syncToolMenuState();
        this.renderSelectedDirectToolChip();
        
        // Restore input area state (hidden/shown)
        uiHelpers.restoreInputAreaState();
        
        // Focus input
        this.messageInput?.focus();
        this.updateAudioControls();
        
        // Remove preload class after a short delay
        setTimeout(() => {
            document.body.classList.remove('preload');
        }, 100);
        
        // Setup online/offline listeners
        this.setupConnectivityListeners();
    }

    // ============================================
    // Event Listeners
    // ============================================

    setupEventListeners() {
        // Send button
        this.sendBtn?.addEventListener('click', () => {
            if (this.isCurrentSessionProcessing()) {
                void this.cancelCurrentRequest();
                return;
            }

            this.sendMessage();
        });
        this.voiceInputBtn?.addEventListener('click', () => this.toggleVoiceInput());
        this.voiceOutputBtn?.addEventListener('click', () => this.toggleLatestAssistantSpeech());
        this.toolMenuBtn?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.toggleToolMenu();
        });
        this.toolMenuPanel?.addEventListener('click', (event) => {
            const toolCommandButton = event.target?.closest?.('[data-tool-command-id]');
            if (toolCommandButton) {
                event.preventDefault();
                this.selectToolForNextMessage(toolCommandButton.dataset.toolCommandId);
                return;
            }

            const checkbox = event.target?.closest?.('[data-tool-intent-checkbox]');
            if (checkbox) {
                this.handleToolIntentCheckboxChange(checkbox);
                return;
            }

            const actionButton = event.target?.closest?.('[data-tool-menu-action]');
            const action = String(actionButton?.dataset?.toolMenuAction || '').trim();
            if (!action) {
                return;
            }

            event.preventDefault();
            if (action === 'skill') {
                this.startSkillWizardFromToolMenu();
            } else if (action === 'command') {
                void this.openToolCommandPicker();
            } else if (action === 'clear') {
                this.clearToolIntentSelections();
            }
        });
        this.toolMenuPanel?.addEventListener('keydown', (event) => {
            this.handleToolMenuKeydown(event);
        });
        this.toolCommandSearch?.addEventListener('input', () => {
            this.renderToolCommandPicker();
        });
        this.toolCommandSearch?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') {
                return;
            }
            const firstTool = this.getToolCommandPickerTools()[0] || null;
            if (!firstTool) {
                return;
            }
            event.preventDefault();
            this.selectToolForNextMessage(firstTool.id);
        });
        this.selectedToolChipTray?.addEventListener('click', (event) => {
            const clearButton = event.target?.closest?.('[data-clear-selected-tool]');
            if (!clearButton) {
                return;
            }
            event.preventDefault();
            this.clearSelectedDirectTool();
        });
        document.addEventListener('click', (event) => {
            if (!this.toolMenuPanel || this.toolMenuPanel.classList.contains('hidden')) {
                return;
            }
            if (this.toolMenuPanel.contains(event.target) || this.toolMenuBtn?.contains?.(event.target)) {
                return;
            }
            this.closeToolMenu();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this.closeToolMenu();
            }
        });
        
        // Input handling
        this.messageInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });
        
        // Handle slash commands in input
        this.messageInput?.addEventListener('input', () => {
            this.updateSendButton();
            uiHelpers.updateCharCounter(this.messageInput, this.charCounter);
            this.updateAudioControls();
            
            // Check for slash commands
            const value = this.messageInput.value.trim();
            if (value.startsWith('/')) {
                this.handleInputSlashCommand(value);
            }
        });

        this.messagesContainer?.addEventListener('click', (event) => {
            const option = event.target?.closest?.('.agent-survey-option');
            if (option) {
                event.preventDefault();
                uiHelpers.toggleSurveyOption(option);
                return;
            }

            const submit = event.target?.closest?.('.agent-survey-card__submit');
            if (submit) {
                event.preventDefault();
                void this.submitAgentSurvey(submit);
                return;
            }

            const previous = event.target?.closest?.('.agent-survey-card__secondary');
            if (previous) {
                event.preventDefault();
                this.goToPreviousSurveyStep(previous);
            }
        });

        this.messagesContainer?.addEventListener('keydown', (event) => {
            const option = event.target?.closest?.('.agent-survey-option');
            if (option && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                uiHelpers.toggleSurveyOption(option);
                return;
            }

            const submit = event.target?.closest?.('.agent-survey-card__submit');
            if (submit && event.key === 'Enter') {
                event.preventDefault();
                void this.submitAgentSurvey(submit);
            }
        });

        this.messagesContainer?.addEventListener('input', (event) => {
            const notes = event.target?.closest?.('.agent-survey-card__notes');
            if (notes) {
                uiHelpers.syncSurveyFreeText(notes);
                return;
            }

            const input = event.target?.closest?.('.agent-survey-card__input');
            if (input) {
                uiHelpers.syncSurveyInputValue(input);
            }
        });
        
        // New chat button
        document.getElementById('new-chat-btn')?.addEventListener('click', () => {
            this.createNewSession();
        });
        
        // Clear chat button
        document.getElementById('clear-chat-btn')?.addEventListener('click', () => {
            this.clearCurrentSession();
        });
        
        // Theme gallery
        document.getElementById('theme-toggle')?.addEventListener('click', () => {
            uiHelpers.openThemeGallery();
        });
        window.addEventListener('longAgentDefaultChanged', (event) => {
            this.longAgentDefaultEnabled = event.detail?.enabled === true;
        });
        
        // Mobile sidebar toggle
        document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
            uiHelpers.toggleSidebar();
        });
        
        document.getElementById('sidebar-overlay')?.addEventListener('click', () => {
            uiHelpers.closeSidebar();
        });

        this.workloadsBtn?.addEventListener('click', () => {
            this.toggleWorkloadsPanel();
        });
        this.refreshWorkloadsBtn?.addEventListener('click', () => {
            this.loadSessionWorkloads(sessionManager.currentSessionId, { force: true });
        });
        this.closeWorkloadsPanelBtn?.addEventListener('click', () => {
            this.closeWorkloadsPanel();
        });
        this.projectViewport?.addEventListener('click', (event) => {
            const actionButton = event.target?.closest?.('[data-project-viewport-action]');
            if (actionButton) {
                event.preventDefault();
                event.stopPropagation();
                this.handleProjectViewportAction(actionButton.dataset.projectViewportAction);
                return;
            }

            const sizeButton = event.target?.closest?.('[data-project-viewport-size]');
            if (sizeButton) {
                event.preventDefault();
                event.stopPropagation();
                void this.setProjectViewportSize(sizeButton.dataset.projectViewportSize);
            }
        });
        this.projectViewportFrame?.addEventListener('load', () => {
            if (this.projectViewportFrame?.dataset.projectUrl) {
                this.setProjectViewportFrameState('ready');
            }
        });
        this.projectViewportFrame?.addEventListener('error', () => {
            this.setProjectViewportFrameState('error', 'Preview could not be loaded.', 'Check authentication or open it in a new tab.');
        });
        this.newWorkloadBtn?.addEventListener('click', () => {
            this.openWorkloadModal();
        });
        this.workloadScenarioBuildBtn?.addEventListener('click', () => {
            this.buildWorkloadFromScenario();
        });
        this.workloadTriggerType?.addEventListener('change', () => {
            this.updateWorkloadTriggerFields();
            this.clearWorkloadFormError();
        });
        [
            this.workloadScenarioInput,
            this.workloadTitleInput,
            this.workloadPromptInput,
            this.workloadCallableSlug,
            this.workloadRunAt,
            this.workloadCronExpression,
            this.workloadTimezone,
            this.workloadToolIds,
            this.workloadLongAgentScratch,
            this.workloadLongAgentSteps,
            this.workloadStagesJson,
        ].forEach((field) => {
            field?.addEventListener('input', () => {
                this.clearWorkloadFormError();
            });
        });
        this.workloadLongAgentEnabled?.addEventListener('change', () => this.clearWorkloadFormError());
        this.workloadTimezone?.addEventListener('input', () => {
            this.renderWorkloadPresetTable(
                this.workloadCronExpression?.value || '',
                this.workloadTimezone?.value || 'UTC',
            );
        });
        this.workloadCronExpression?.addEventListener('input', () => {
            this.renderWorkloadPresetTable(
                this.workloadCronExpression?.value || '',
                this.workloadTimezone?.value || 'UTC',
            );
        });
        this.workloadModal?.addEventListener('click', (event) => {
            const preset = event.target.closest('[data-workload-preset-expression]');
            if (preset) {
                this.applyWorkloadPreset({
                    expression: preset.dataset.workloadPresetExpression || '',
                    label: preset.dataset.workloadPresetLabel || '',
                });
                return;
            }

            if (event.target?.dataset?.closeWorkloadModal === 'true') {
                this.closeWorkloadModal();
            }
        });
        this.saveWorkloadBtn?.addEventListener('click', () => {
            this.saveWorkload();
        });
        this.cancelWorkloadBtn?.addEventListener('click', () => {
            this.closeWorkloadModal();
        });
        this.closeWorkloadModalBtn?.addEventListener('click', () => {
            this.closeWorkloadModal();
        });
        this.workloadsList?.addEventListener('click', (event) => {
            const actionNode = event.target.closest('[data-workload-action]');
            if (!actionNode) {
                return;
            }

            this.handleWorkloadAction(
                actionNode.dataset.workloadAction,
                actionNode.dataset.workloadId,
            );
        });
        
        // Window resize
        window.addEventListener('resize', () => {
            if (window.innerWidth > 768) {
                uiHelpers.closeSidebar();
            }
            this.renderBackgroundWorkloadStatus();
        });
        
        // Handle regenerate event
        window.addEventListener('regenerateMessage', (e) => {
            this.regenerateResponse(e.detail.messageId);
        });

        window.addEventListener('submitAlignmentFeedback', (e) => {
            this.submitAlignmentFeedback(e.detail?.messageId, e.detail?.rating);
        });
        
        // Handle model change event
        window.addEventListener('modelChanged', (e) => {
            const modelId = String(e.detail?.modelId || '').trim();
            if (!modelId) {
                return;
            }

            if (sessionManager.currentSessionId) {
                sessionManager.setSessionModel(sessionManager.currentSessionId, modelId);
                uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
            }
        });
        
        // Handle visibility change for resuming
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.pageWasHidden = true;
                this.markActiveStreamInterrupted('background');
                return;
            }

            this.scheduleResumeSync('visibility', 0);
        });

        window.addEventListener('focus', () => {
            if (this.pageWasHidden || this.pendingStreamResync) {
                this.scheduleResumeSync('focus', 0);
            }
        });

        window.addEventListener('kimibuilt-web-chat-workspace-activity', (event) => {
            this.handleWorkspaceActivityChange(event.detail?.active !== false);
        });
    }

    isHostWorkspaceActive() {
        if (this.workspaceContext?.embedded !== true) {
            return true;
        }

        if (typeof webChatWorkspaceEmbedHelpers?.isHostWorkspaceActive === 'function') {
            return webChatWorkspaceEmbedHelpers.isHostWorkspaceActive();
        }

        return window.__kimibuiltWebChatHostWorkspaceActive !== false;
    }

    isAppBackgrounded(context = {}) {
        return context?.hidden === true || document.hidden === true || !this.isHostWorkspaceActive();
    }

    handleWorkspaceActivityChange(active = true) {
        if (active !== false) {
            this.workloadSocketPaused = false;
            this.subscribeToSessionUpdates(sessionManager.currentSessionId);
            if (this.pageWasHidden || this.pendingStreamResync) {
                this.scheduleResumeSync('workspace-visibility', 0);
            }
            return;
        }

        this.pauseWorkloadSocket();
        this.pageWasHidden = true;
        this.markActiveStreamInterrupted('workspace_hidden');
        if ((this.pendingStreamResync || this.activeStreamRequest)?.acceptedByServer) {
            this.enterBackgroundStreamMode({
                detail: this.getBackgroundStreamDetail(),
            });
        }
    }

    loadStoredToolIntentIds() {
        let rawValue = '';
        try {
            if (typeof sessionManager !== 'undefined'
                && sessionManager
                && typeof sessionManager.safeStorageGet === 'function') {
                rawValue = sessionManager.safeStorageGet(WEB_CHAT_TOOL_MENU_STORAGE_KEY) || '';
            } else if (typeof localStorage !== 'undefined') {
                rawValue = localStorage.getItem(WEB_CHAT_TOOL_MENU_STORAGE_KEY) || '';
            }
        } catch (_error) {
            rawValue = '';
        }

        const parsed = (() => {
            try {
                return JSON.parse(rawValue || '[]');
            } catch (_error) {
                return [];
            }
        })();

        return (Array.isArray(parsed) ? parsed : [])
            .map((id) => normalizeToolIntentId(id))
            .filter((id) => getToolIntentDefinitionById(id));
    }

    saveStoredToolIntentIds() {
        const payload = JSON.stringify(Array.from(this.selectedToolIntentIds || []));
        try {
            if (typeof sessionManager !== 'undefined'
                && sessionManager
                && typeof sessionManager.safeStorageSet === 'function') {
                sessionManager.safeStorageSet(WEB_CHAT_TOOL_MENU_STORAGE_KEY, payload);
            } else if (typeof localStorage !== 'undefined') {
                localStorage.setItem(WEB_CHAT_TOOL_MENU_STORAGE_KEY, payload);
            }
        } catch (_error) {
            // Storage may be blocked; the in-memory selection still works.
        }
    }

    getSelectedToolIntentDefinitions(ids = null) {
        const sourceIds = ids
            ? Array.from(ids)
            : Array.from(this.selectedToolIntentIds || []);
        return sourceIds
            .map((id) => getToolIntentDefinitionById(id))
            .filter(Boolean);
    }

    syncToolMenuState() {
        const selectedDefinitions = this.getSelectedToolIntentDefinitions();
        const selectedIds = new Set(selectedDefinitions.map((definition) => definition.id));
        const selectedCount = selectedDefinitions.length;
        const isOpen = this.toolMenuPanel && !this.toolMenuPanel.classList.contains('hidden');

        if (this.toolMenuCount) {
            this.toolMenuCount.textContent = String(selectedCount);
            this.toolMenuCount.classList.toggle('hidden', selectedCount === 0);
        }
        if (this.toolMenuSummary) {
            this.toolMenuSummary.textContent = buildToolIntentSelectionSummary(selectedDefinitions);
            this.toolMenuSummary.title = selectedDefinitions
                .map((definition) => definition.summary || definition.label || definition.id)
                .filter(Boolean)
                .join('\n');
        }
        if (this.toolMenuBtn) {
            const triggerLabel = selectedCount > 0
                ? `Tools: ${buildToolIntentSelectionSummary(selectedDefinitions)}`
                : 'Choose tools';
            this.toolMenuBtn.classList.toggle('is-active', selectedCount > 0 || isOpen);
            this.toolMenuBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            this.toolMenuBtn.setAttribute('aria-label', triggerLabel);
            this.toolMenuBtn.title = triggerLabel;
        }

        this.toolMenuPanel?.querySelectorAll?.('[data-tool-intent-checkbox]').forEach((checkbox) => {
            const intentId = normalizeToolIntentId(checkbox.value);
            const isSelected = selectedIds.has(intentId);
            checkbox.checked = isSelected;
            const choice = checkbox.closest('.tool-menu-choice');
            choice?.classList.toggle('is-selected', isSelected);
            choice?.setAttribute('aria-checked', isSelected ? 'true' : 'false');
        });

        if (this.toolCommandPicker && !this.toolCommandPicker.classList.contains('hidden')) {
            this.renderToolCommandPicker();
        }
    }

    toggleToolMenu() {
        if (!this.toolMenuPanel) {
            return;
        }
        if (this.toolMenuPanel.classList.contains('hidden')) {
            this.openToolMenu();
        } else {
            this.closeToolMenu();
        }
    }

    openToolMenu() {
        if (!this.toolMenuPanel) {
            return;
        }
        this.toolMenuPanel.classList.remove('hidden');
        this.syncToolMenuState();
        uiHelpers.reinitializeIcons?.(this.toolMenuPanel);
    }

    closeToolMenu() {
        if (!this.toolMenuPanel) {
            return;
        }
        this.toolMenuPanel.classList.add('hidden');
        this.toolCommandPicker?.classList.add('hidden');
        this.syncToolMenuState();
    }

    getToolMenuFocusableItems() {
        if (!this.toolMenuPanel?.querySelectorAll) {
            return [];
        }

        return Array.from(this.toolMenuPanel.querySelectorAll([
            '[data-tool-intent-checkbox]',
            '[data-tool-menu-action]',
            '[data-tool-command-id]',
        ].join(','))).filter((element) => {
            if (!element || element.disabled) {
                return false;
            }
            return !element.closest?.('.hidden');
        });
    }

    focusToolMenuItem(index) {
        const items = this.getToolMenuFocusableItems();
        if (!items.length) {
            return false;
        }
        const nextIndex = ((index % items.length) + items.length) % items.length;
        items[nextIndex]?.focus?.();
        return true;
    }

    handleToolMenuKeydown(event) {
        if (!event || !this.toolMenuPanel || this.toolMenuPanel.classList.contains('hidden')) {
            return false;
        }

        const key = event.key;
        if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(key)) {
            return false;
        }

        const items = this.getToolMenuFocusableItems();
        if (!items.length) {
            return false;
        }

        const currentIndex = items.findIndex((item) => item === event.target || item.contains?.(event.target));
        let nextIndex = currentIndex;
        if (key === 'Home') {
            nextIndex = 0;
        } else if (key === 'End') {
            nextIndex = items.length - 1;
        } else if (key === 'ArrowDown' || key === 'ArrowRight') {
            nextIndex = currentIndex < 0 ? 0 : currentIndex + 1;
        } else if (key === 'ArrowUp' || key === 'ArrowLeft') {
            nextIndex = currentIndex < 0 ? items.length - 1 : currentIndex - 1;
        }

        event.preventDefault?.();
        this.focusToolMenuItem(nextIndex);
        return true;
    }

    handleToolIntentCheckboxChange(checkbox) {
        const intentId = normalizeToolIntentId(checkbox?.value);
        if (!getToolIntentDefinitionById(intentId)) {
            return;
        }
        if (checkbox.checked) {
            this.selectedToolIntentIds.add(intentId);
        } else {
            this.selectedToolIntentIds.delete(intentId);
        }
        this.saveStoredToolIntentIds();
        this.syncToolMenuState();
        if (this.toolCommandPicker && !this.toolCommandPicker.classList.contains('hidden')) {
            this.renderToolCommandPicker();
        }
    }

    clearToolIntentSelections() {
        this.selectedToolIntentIds.clear();
        this.saveStoredToolIntentIds();
        this.clearSelectedDirectTool({ quiet: true });
        this.syncToolMenuState();
        uiHelpers.showToast?.('Tool choices cleared.', 'info');
    }

    getSelectedPlannedToolIds() {
        return getUniqueToolIdsFromIntentDefinitions(this.getSelectedToolIntentDefinitions());
    }

    normalizeToolCatalogTools(tools = []) {
        const seen = new Set();
        return (Array.isArray(tools) ? tools : [])
            .map((tool) => ({
                ...tool,
                id: String(tool?.id || tool?.name || '').trim(),
                name: String(tool?.name || tool?.id || '').trim(),
                description: String(tool?.description || '').trim(),
                category: String(tool?.category || '').trim(),
                icon: String(tool?.icon || 'wrench').trim() || 'wrench',
            }))
            .filter((tool) => {
                if (!tool.id || seen.has(tool.id)) {
                    return false;
                }
                seen.add(tool.id);
                return true;
            });
    }

    getToolCatalogEntryById(toolId = '') {
        const normalizedToolId = String(toolId || '').trim();
        if (!normalizedToolId) {
            return null;
        }

        return this.normalizeToolCatalogTools(this.toolCatalogTools)
            .find((tool) => tool.id === normalizedToolId) || null;
    }

    normalizeDirectToolSelection(toolOrId = null) {
        const tool = typeof toolOrId === 'string'
            ? this.getToolCatalogEntryById(toolOrId) || { id: toolOrId }
            : toolOrId;
        const toolId = String(tool?.id || tool?.name || '').trim();
        if (!toolId) {
            return null;
        }

        return {
            id: toolId,
            name: String(tool?.name || toolId).trim() || toolId,
            description: String(tool?.description || '').trim(),
            category: String(tool?.category || '').trim(),
            icon: String(tool?.icon || 'wrench').trim() || 'wrench',
        };
    }

    renderSelectedDirectToolChip() {
        if (!this.selectedToolChipTray) {
            return false;
        }

        const tool = this.normalizeDirectToolSelection(this.selectedDirectTool);
        if (!tool) {
            this.selectedToolChipTray.innerHTML = '';
            this.selectedToolChipTray.classList.add('hidden');
            return false;
        }

        this.selectedToolChipTray.classList.remove('hidden');
        this.selectedToolChipTray.innerHTML = `
            <span class="selected-tool-chip" title="${escapeToolMenuHtmlAttr(tool.description || tool.name)}">
                <span class="selected-tool-chip__icon" aria-hidden="true">
                    <i data-lucide="${escapeToolMenuHtmlAttr(tool.icon)}" class="w-4 h-4"></i>
                </span>
                <span class="selected-tool-chip__name">${escapeToolMenuHtml(tool.name)}</span>
                <button type="button" class="selected-tool-chip__clear" data-clear-selected-tool aria-label="Remove selected tool ${escapeToolMenuHtmlAttr(tool.name)}">
                    <i data-lucide="x" class="w-3.5 h-3.5" aria-hidden="true"></i>
                </button>
            </span>
        `;
        uiHelpers.reinitializeIcons?.(this.selectedToolChipTray);
        return true;
    }

    removeToolCommandDraftFromInput() {
        const input = this.messageInput;
        if (!input) {
            return false;
        }

        const currentValue = String(input.value || '');
        if (!/^\/tool\s+\S+(?:\s+[\s\S]*)?$/i.test(currentValue.trim())) {
            return false;
        }

        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }

    selectToolForNextMessage(toolId = '') {
        const tool = this.normalizeDirectToolSelection(toolId);
        if (!tool) {
            return false;
        }

        this.selectedDirectTool = tool;
        this.removeToolCommandDraftFromInput();
        this.renderSelectedDirectToolChip();
        this.closeToolMenu();
        this.messageInput?.focus();
        uiHelpers.showToast?.(`${tool.name} selected for the next message.`, 'info');
        return true;
    }

    clearSelectedDirectTool(options = {}) {
        const hadSelection = Boolean(this.selectedDirectTool?.id);
        this.selectedDirectTool = null;
        this.renderSelectedDirectToolChip();
        if (hadSelection && options.quiet !== true) {
            uiHelpers.showToast?.('Selected tool removed.', 'info');
        }
        return hadSelection;
    }

    getToolCommandPickerTools(query = null) {
        const rawQuery = query === null
            ? String(this.toolCommandSearch?.value || '')
            : String(query || '');
        const normalizedQuery = rawQuery.trim().toLowerCase();
        const selectedPlannedToolIds = new Set(this.getSelectedPlannedToolIds());
        const remoteToolOrder = new Map([
            ['remote-cli-agent', 0],
            ['managed-app', 1],
            ['k3s-deploy', 2],
            ['remote-command', 3],
            ['remote-workbench', 4],
        ]);

        return this.normalizeToolCatalogTools(this.toolCatalogTools)
            .filter((tool) => {
                if (!normalizedQuery) {
                    return true;
                }
                return [
                    tool.id,
                    tool.name,
                    tool.description,
                    tool.category,
                ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
            })
            .sort((first, second) => {
                const firstSelected = selectedPlannedToolIds.has(first.id) ? 0 : 1;
                const secondSelected = selectedPlannedToolIds.has(second.id) ? 0 : 1;
                if (firstSelected !== secondSelected) {
                    return firstSelected - secondSelected;
                }

                const firstRank = remoteToolOrder.has(first.id) ? remoteToolOrder.get(first.id) : 50;
                const secondRank = remoteToolOrder.has(second.id) ? remoteToolOrder.get(second.id) : 50;
                if (firstRank !== secondRank) {
                    return firstRank - secondRank;
                }

                return (first.name || first.id).localeCompare(second.name || second.id);
            });
    }

    renderToolCommandPicker() {
        if (!this.toolCommandPicker || !this.toolCommandList) {
            return;
        }

        const selectedPlannedToolIds = new Set(this.getSelectedPlannedToolIds());
        const activeDirectToolId = String(this.selectedDirectTool?.id || '').trim();
        const matchingTools = this.getToolCommandPickerTools();
        const query = String(this.toolCommandSearch?.value || '').trim();

        if (this.toolCommandStatus) {
            if (this.toolCatalogLoading) {
                this.toolCommandStatus.textContent = 'Loading tools...';
            } else if (this.toolCatalogLoadError) {
                this.toolCommandStatus.textContent = 'Could not load tools';
            } else if (matchingTools.length === 0) {
                this.toolCommandStatus.textContent = query ? 'No matches' : 'No tools available';
            } else {
                this.toolCommandStatus.textContent = selectedPlannedToolIds.size > 0
                    ? `${matchingTools.length} tools, suggested first`
                    : `${matchingTools.length} tools`;
            }
        }

        if (this.toolCatalogLoading) {
            this.toolCommandList.innerHTML = '<div class="tool-command-empty">Loading available tools...</div>';
            return;
        }

        if (this.toolCatalogLoadError) {
            this.toolCommandList.innerHTML = `<div class="tool-command-empty">${escapeToolMenuHtml(this.toolCatalogLoadError)}</div>`;
            return;
        }

        if (matchingTools.length === 0) {
            this.toolCommandList.innerHTML = '<div class="tool-command-empty">No tools match this search.</div>';
            return;
        }

        this.toolCommandList.innerHTML = matchingTools.map((tool) => {
            const isSuggested = selectedPlannedToolIds.has(tool.id);
            const isActive = activeDirectToolId === tool.id;
            const params = Object.keys(this.getToolCommandStarterParams(tool));
            const metaParts = [
                tool.category || 'tool',
                isActive ? 'active next message' : '',
                isSuggested ? 'selected lane' : '',
                params.length ? `params: ${params.slice(0, 4).join(', ')}` : 'params: {}',
            ].filter(Boolean);

            return `
                <button type="button" class="tool-command-option ${isSuggested ? 'is-suggested' : ''} ${isActive ? 'is-active' : ''}" data-tool-command-id="${escapeToolMenuHtmlAttr(tool.id)}" role="option" aria-selected="${isActive ? 'true' : 'false'}">
                    <span class="tool-command-option__icon"><i data-lucide="${escapeToolMenuHtmlAttr(tool.icon)}" class="w-4 h-4" aria-hidden="true"></i></span>
                    <span class="tool-command-option__copy">
                        <span class="tool-command-option__name">${escapeToolMenuHtml(tool.name || tool.id)}</span>
                        <span class="tool-command-option__desc">${escapeToolMenuHtml(tool.description || tool.id)}</span>
                        <span class="tool-command-option__meta">${escapeToolMenuHtml(metaParts.join(' | '))}</span>
                    </span>
                </button>
            `;
        }).join('');
        uiHelpers.reinitializeIcons?.(this.toolCommandList);
    }

    async openToolCommandPicker() {
        if (!this.toolCommandPicker) {
            this.insertToolCommandTemplateFromToolMenu();
            return;
        }

        this.openToolMenu();
        this.toolCommandPicker.classList.remove('hidden');
        if (this.toolCommandSearch) {
            this.toolCommandSearch.value = '';
        }
        this.renderToolCommandPicker();
        this.toolCommandSearch?.focus();

        await this.loadToolCatalogForPicker();
    }

    async loadToolCatalogForPicker(options = {}) {
        if (this.toolCatalogLoaded && options.force !== true) {
            this.renderToolCommandPicker();
            return;
        }
        if (this.toolCatalogLoading) {
            return;
        }

        this.toolCatalogLoading = true;
        this.toolCatalogLoadError = '';
        this.renderToolCommandPicker();

        try {
            if (typeof apiClient === 'undefined' || typeof apiClient?.getAvailableTools !== 'function') {
                throw new Error('Tool catalog is not available in this session.');
            }
            const requestOptions = this.buildToolIntentRequestOptions();
            const response = await apiClient.getAvailableTools(null, {
                includeAll: true,
                ...(requestOptions.executionProfile ? { executionProfile: requestOptions.executionProfile } : {}),
            });
            this.toolCatalogTools = this.normalizeToolCatalogTools(response?.tools || []);
            this.toolCatalogLoaded = true;
        } catch (error) {
            this.toolCatalogLoadError = error?.message || 'Failed to load tools.';
            this.toolCatalogTools = [];
        } finally {
            this.toolCatalogLoading = false;
            this.renderToolCommandPicker();
        }
    }

    buildToolIntentRequestOptions() {
        const definitions = this.getSelectedToolIntentDefinitions();
        if (definitions.length === 0) {
            return {};
        }

        const plannedTools = getUniqueToolIdsFromIntentDefinitions(definitions);
        const mergedMetadata = definitions.reduce((metadata, definition) => ({
            ...metadata,
            ...((definition.metadata && typeof definition.metadata === 'object') ? definition.metadata : {}),
        }), {});
        const selectedPluginLanes = definitions.map((definition) => definition.id);
        const userToolIntents = definitions.map((definition) => ({
            id: definition.id,
            label: definition.label,
            summary: definition.summary,
            tools: Array.isArray(definition.tools) ? definition.tools : [],
            decisionTree: Array.isArray(definition.decisionTree) ? definition.decisionTree : [],
        }));
        const decisionTree = definitions.map((definition) => ({
            id: definition.id,
            label: definition.label,
            steps: Array.isArray(definition.decisionTree) ? definition.decisionTree : [],
        }));
        const instructionLines = definitions
            .map((definition) => `- ${definition.label}: ${definition.instructions || definition.summary || ''}`.trim())
            .filter(Boolean);
        const executionProfile = definitions.some((definition) => definition.executionProfile === 'remote-build')
            ? 'remote-build'
            : '';

        const metadata = {
            ...mergedMetadata,
            toolSelectionSource: 'web-chat-plugin-menu',
            selectedPluginLanes,
            plannedTools,
            userSelectedToolIds: plannedTools,
            userToolIntents,
            userToolDecisionTree: decisionTree,
            toolSelectionInstructions: instructionLines.join('\n'),
        };
        if (!metadata.preferredTool && plannedTools.length === 1) {
            metadata.preferredTool = plannedTools[0];
        }

        return {
            metadata,
            ...(executionProfile ? { executionProfile } : {}),
        };
    }

    buildSelectedDirectToolRequestOptions() {
        const tool = this.normalizeDirectToolSelection(this.selectedDirectTool);
        if (!tool) {
            return this.buildToolIntentRequestOptions();
        }

        const selectionOptions = this.buildToolIntentRequestOptions();
        const selectionMetadata = selectionOptions.metadata && typeof selectionOptions.metadata === 'object'
            ? selectionOptions.metadata
            : {};
        const selectedPlannedTools = Array.isArray(selectionMetadata.plannedTools)
            ? selectionMetadata.plannedTools
            : [];
        const selectedUserTools = Array.isArray(selectionMetadata.userSelectedToolIds)
            ? selectionMetadata.userSelectedToolIds
            : [];
        const plannedTools = Array.from(new Set([
            ...selectedPlannedTools,
            tool.id,
        ].filter(Boolean)));
        const userSelectedToolIds = Array.from(new Set([
            ...selectedUserTools,
            tool.id,
        ].filter(Boolean)));
        const remoteToolRequested = WEB_CHAT_REMOTE_TOOL_IDS.has(tool.id);
        const executionProfile = selectionOptions.executionProfile
            || (remoteToolRequested ? 'remote-build' : '');
        const existingInstructions = String(selectionMetadata.toolSelectionInstructions || '').trim();
        const toolInstruction = `The user activated the ${tool.name} tool chip for this message. Use that tool when it can satisfy the typed chat content; do not require the tool name to appear in the user's message.`;

        return {
            ...(executionProfile ? { executionProfile } : {}),
            metadata: {
                ...selectionMetadata,
                toolSelectionSource: selectionMetadata.toolSelectionSource
                    ? `${selectionMetadata.toolSelectionSource}+web-chat-tool-chip`
                    : 'web-chat-tool-chip',
                selectedToolSource: 'web-chat-tool-chip',
                selectedDirectTool: tool,
                selectedToolChip: tool,
                directToolId: tool.id,
                preferredTool: tool.id,
                plannedTools,
                userSelectedToolIds,
                toolSelectionInstructions: [
                    existingInstructions,
                    toolInstruction,
                ].filter(Boolean).join('\n'),
                ...(remoteToolRequested ? {
                    remoteBuildAutonomyApproved: true,
                    frontendRemoteBuildAutonomyApproved: true,
                    remoteBuildIntent: true,
                    asyncRuntimePreferred: tool.id === 'remote-cli-agent',
                } : {}),
            },
        };
    }

    insertTextAtCursor(text = '') {
        const input = this.messageInput;
        const value = String(text || '');
        if (!input || !value) {
            return false;
        }

        const currentValue = String(input.value || '');
        const start = typeof input.selectionStart === 'number' ? input.selectionStart : currentValue.length;
        const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
        const before = currentValue.slice(0, start);
        const after = currentValue.slice(end);
        const separator = before && !/\s$/.test(before) && !/^\s/.test(value) ? ' ' : '';
        input.value = `${before}${separator}${value}${after}`;
        const cursor = before.length + separator.length + value.length;
        if (typeof input.setSelectionRange === 'function') {
            input.setSelectionRange(cursor, cursor);
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        return true;
    }

    replaceOrInsertToolCommandTemplate(command = '') {
        const input = this.messageInput;
        const value = String(command || '').trim();
        if (!input || !value) {
            return false;
        }

        const currentValue = String(input.value || '').trim();
        if (!currentValue || /^\/tools?(?:\s|$)/i.test(currentValue)) {
            this.setInput(value);
            return true;
        }

        return this.insertTextAtCursor(value);
    }

    buildSkillWizardPromptFromToolMenu() {
        const definitions = this.getSelectedToolIntentDefinitions();
        const plannedTools = getUniqueToolIdsFromIntentDefinitions(definitions);
        const labels = definitions.map((definition) => definition.label).filter(Boolean);
        const decisionLines = definitions.flatMap((definition) => (
            Array.isArray(definition.decisionTree)
                ? definition.decisionTree.map((step) => `${definition.label}: ${step}`)
                : []
        ));
        return [
            `Create a reusable skill that combines these plugin lanes: ${labels.join(', ')}.`,
            plannedTools.length ? `Tool chain: ${plannedTools.join(', ')}.` : '',
            decisionLines.length ? `Decision tree: ${decisionLines.join(' ')}` : '',
            'Make it usable from chat when a user explicitly selects or asks for this combined workflow.',
        ].filter(Boolean).join(' ');
    }

    startSkillWizardFromToolMenu() {
        const prompt = this.buildSkillWizardPromptFromToolMenu();
        if (!prompt) {
            uiHelpers.showToast?.('Choose one or more plugins first.', 'warning');
            return;
        }
        this.closeToolMenu();
        void this.startSkillWizard(prompt);
    }

    getToolCommandStarterParams(tool = {}) {
        const toolId = String(tool?.id || '').trim();
        if (toolId && WEB_CHAT_TOOL_COMMAND_STARTER_PARAMS[toolId]) {
            return cloneToolCommandStarterParams(WEB_CHAT_TOOL_COMMAND_STARTER_PARAMS[toolId]);
        }

        const inputSchema = (tool?.inputSchema && typeof tool.inputSchema === 'object')
            ? tool.inputSchema
            : {};
        const schemaProperties = (inputSchema.properties && typeof inputSchema.properties === 'object')
            ? inputSchema.properties
            : {};
        const parameterProperties = (!Array.isArray(tool?.parameters) && tool?.parameters && typeof tool.parameters === 'object')
            ? tool.parameters
            : {};
        const properties = Object.keys(schemaProperties).length > 0
            ? schemaProperties
            : parameterProperties;
        const requiredKeys = Array.isArray(inputSchema.required)
            ? inputSchema.required.map((key) => String(key || '').trim()).filter(Boolean)
            : [];
        const keys = requiredKeys.filter((key) => Object.prototype.hasOwnProperty.call(properties, key)).slice(0, 8);

        return keys.reduce((params, key) => ({
            ...params,
            [key]: buildDefaultToolParameterValue(properties[key] || {}),
        }), {});
    }

    buildToolCommandTemplate(toolOrId = {}) {
        const tool = typeof toolOrId === 'string'
            ? this.normalizeToolCatalogTools(this.toolCatalogTools).find((entry) => entry.id === toolOrId) || { id: toolOrId }
            : toolOrId;
        const toolId = String(tool?.id || '').trim();
        if (!toolId) {
            return '/tools';
        }

        const payload = JSON.stringify(this.getToolCommandStarterParams(tool));
        return `/tool ${toolId} ${payload}`;
    }

    insertToolCommandTemplateForTool(toolId = '') {
        const command = this.buildToolCommandTemplate(String(toolId || '').trim());
        this.replaceOrInsertToolCommandTemplate(command);
        this.closeToolMenu();
    }

    insertToolCommandTemplateFromToolMenu() {
        const plannedTools = this.getSelectedPlannedToolIds();
        if (plannedTools.length === 0) {
            this.replaceOrInsertToolCommandTemplate('/tools');
            this.closeToolMenu();
            return;
        }

        this.insertToolCommandTemplateForTool(plannedTools[0]);
    }

    getTrackedStreamRequest() {
        return this.pendingStreamResync || this.activeStreamRequest || null;
    }

    getSessionStreamState(sessionId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return null;
        }

        if (!this.streamStatesBySession.has(normalizedSessionId)) {
            this.streamStatesBySession.set(normalizedSessionId, {
                sessionId: normalizedSessionId,
                activeStreamRequest: null,
                pendingStreamResync: null,
                currentStreamingMessageId: null,
                currentAbortController: null,
                isCancellingCurrentRequest: false,
                liveResponseState: {
                    phase: 'idle',
                    detail: '',
                    reasoningSummary: '',
                    hasRealReasoning: false,
                },
            });
        }

        return this.streamStatesBySession.get(normalizedSessionId);
    }

    isSessionProcessing(sessionId = sessionManager.currentSessionId) {
        const normalizedSessionId = String(sessionId || '').trim();
        return Boolean(normalizedSessionId) && this.processingSessions.has(normalizedSessionId);
    }

    isCurrentSessionProcessing() {
        return this.isSessionProcessing(sessionManager.currentSessionId);
    }

    captureVisibleStreamState(sessionId = sessionManager.currentSessionId) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId || !this.processingSessions.has(normalizedSessionId)) {
            return null;
        }

        const state = this.getSessionStreamState(normalizedSessionId);
        state.activeStreamRequest = this.activeStreamRequest;
        state.pendingStreamResync = this.pendingStreamResync;
        state.currentStreamingMessageId = this.currentStreamingMessageId;
        state.currentAbortController = this.currentAbortController;
        state.isCancellingCurrentRequest = this.isCancellingCurrentRequest;
        state.liveResponseState = {
            ...this.liveResponseState,
        };
        return state;
    }

    applyStreamStateToVisibleSession(sessionId = sessionManager.currentSessionId) {
        const normalizedSessionId = String(sessionId || '').trim();
        const state = normalizedSessionId ? this.streamStatesBySession.get(normalizedSessionId) : null;
        const isProcessingSession = Boolean(normalizedSessionId) && this.processingSessions.has(normalizedSessionId);

        this.activeStreamRequest = isProcessingSession ? (state?.activeStreamRequest || null) : null;
        this.pendingStreamResync = isProcessingSession ? (state?.pendingStreamResync || null) : null;
        this.currentStreamingMessageId = isProcessingSession ? (state?.currentStreamingMessageId || null) : null;
        this.currentAbortController = isProcessingSession ? (state?.currentAbortController || null) : null;
        this.isCancellingCurrentRequest = isProcessingSession ? (state?.isCancellingCurrentRequest === true) : false;
        this.liveResponseState = isProcessingSession && state?.liveResponseState
            ? { ...state.liveResponseState }
            : {
                phase: 'idle',
                detail: '',
                reasoningSummary: '',
                hasRealReasoning: false,
            };
        this.isProcessing = isProcessingSession;
        this.updateSendButton();
    }

    beginSessionStream(sessionId = '', statePatch = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return null;
        }

        this.processingSessions.add(normalizedSessionId);
        const state = this.getSessionStreamState(normalizedSessionId);
        Object.assign(state, statePatch);

        if (this.isVisibleSession(normalizedSessionId)) {
            this.applyStreamStateToVisibleSession(normalizedSessionId);
        } else {
            this.updateSendButton();
        }

        return state;
    }

    finishSessionStream(sessionId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return;
        }

        this.processingSessions.delete(normalizedSessionId);
        this.streamStatesBySession.delete(normalizedSessionId);
        if (this.isVisibleSession(normalizedSessionId)) {
            this.applyStreamStateToVisibleSession(normalizedSessionId);
        } else {
            this.updateSendButton();
        }
    }

    withSessionStreamContext(sessionId = '', callback = () => {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return callback();
        }

        this.captureVisibleStreamState(sessionManager.currentSessionId);

        const previousGlobals = {
            activeStreamRequest: this.activeStreamRequest,
            pendingStreamResync: this.pendingStreamResync,
            currentStreamingMessageId: this.currentStreamingMessageId,
            currentAbortController: this.currentAbortController,
            isCancellingCurrentRequest: this.isCancellingCurrentRequest,
            liveResponseState: { ...this.liveResponseState },
            isProcessing: this.isProcessing,
        };
        const targetState = this.getSessionStreamState(normalizedSessionId);

        this.activeStreamRequest = targetState.activeStreamRequest;
        this.pendingStreamResync = targetState.pendingStreamResync;
        this.currentStreamingMessageId = targetState.currentStreamingMessageId;
        this.currentAbortController = targetState.currentAbortController;
        this.isCancellingCurrentRequest = targetState.isCancellingCurrentRequest === true;
        this.liveResponseState = {
            ...(targetState.liveResponseState || previousGlobals.liveResponseState),
        };
        this.isProcessing = this.processingSessions.has(normalizedSessionId);

        try {
            return callback();
        } finally {
            if (this.processingSessions.has(normalizedSessionId)) {
                targetState.activeStreamRequest = this.activeStreamRequest;
                targetState.pendingStreamResync = this.pendingStreamResync;
                targetState.currentStreamingMessageId = this.currentStreamingMessageId;
                targetState.currentAbortController = this.currentAbortController;
                targetState.isCancellingCurrentRequest = this.isCancellingCurrentRequest;
                targetState.liveResponseState = { ...this.liveResponseState };
            } else {
                this.streamStatesBySession.delete(normalizedSessionId);
            }

            if (this.isVisibleSession(normalizedSessionId)) {
                this.applyStreamStateToVisibleSession(normalizedSessionId);
            } else {
                Object.assign(this, previousGlobals);
                this.applyStreamStateToVisibleSession(sessionManager.currentSessionId);
            }
        }
    }

    getTrackedStreamSessionId(fallbackSessionId = '') {
        return String(
            this.getTrackedStreamRequest()?.sessionId
            || fallbackSessionId
            || sessionManager.currentSessionId
            || '',
        ).trim();
    }

    getStreamingMessageSessionId(messageId = '') {
        const normalizedMessageId = String(messageId || this.currentStreamingMessageId || '').trim();
        const trackedRequest = this.getTrackedStreamRequest();
        if (trackedRequest && (!normalizedMessageId || trackedRequest.assistantMessageId === normalizedMessageId)) {
            return String(trackedRequest.sessionId || '').trim();
        }

        return String(sessionManager.currentSessionId || '').trim();
    }

    isVisibleSession(sessionId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        return Boolean(normalizedSessionId)
            && normalizedSessionId === String(sessionManager.currentSessionId || '').trim();
    }

    getCurrentQueueSessionId() {
        return String(sessionManager.currentSessionId || this.getTrackedStreamSessionId('')).trim();
    }

    isQueuedMessageForSession(entry = {}, sessionId = this.getCurrentQueueSessionId()) {
        const normalizedSessionId = String(sessionId || '').trim();
        const normalizedEntrySessionId = String(entry?.sessionId || '').trim();
        const normalizedWorkspaceKey = String(this.workspaceContext?.key || '').trim();
        const normalizedEntryWorkspaceKey = String(entry?.workspaceKey || normalizedWorkspaceKey).trim();
        return Boolean(normalizedSessionId)
            && normalizedEntryWorkspaceKey === normalizedWorkspaceKey
            && normalizedEntrySessionId === normalizedSessionId;
    }

    getQueuedMessageCount(sessionId = this.getCurrentQueueSessionId()) {
        return this.messageQueue.filter((entry) => this.isQueuedMessageForSession(entry, sessionId)).length;
    }

    discardQueuedMessagesForSession(sessionId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return;
        }

        this.messageQueue = this.messageQueue.filter((entry) => !this.isQueuedMessageForSession(entry, normalizedSessionId));
    }

    remapSessionScopedState(previousSessionId = '', nextSessionId = '') {
        const normalizedPreviousSessionId = String(previousSessionId || '').trim();
        const normalizedNextSessionId = String(nextSessionId || '').trim();
        if (!normalizedPreviousSessionId || !normalizedNextSessionId || normalizedPreviousSessionId === normalizedNextSessionId) {
            return normalizedNextSessionId || normalizedPreviousSessionId;
        }

        [this.activeStreamRequest, this.pendingStreamResync].forEach((request) => {
            if (request?.sessionId === normalizedPreviousSessionId) {
                request.sessionId = normalizedNextSessionId;
            }
        });
        if (this.processingSessions.has(normalizedPreviousSessionId)) {
            this.processingSessions.delete(normalizedPreviousSessionId);
            this.processingSessions.add(normalizedNextSessionId);
        }
        const streamState = this.streamStatesBySession.get(normalizedPreviousSessionId);
        if (streamState) {
            this.streamStatesBySession.delete(normalizedPreviousSessionId);
            streamState.sessionId = normalizedNextSessionId;
            if (streamState.activeStreamRequest?.sessionId === normalizedPreviousSessionId) {
                streamState.activeStreamRequest.sessionId = normalizedNextSessionId;
            }
            if (streamState.pendingStreamResync?.sessionId === normalizedPreviousSessionId) {
                streamState.pendingStreamResync.sessionId = normalizedNextSessionId;
            }
            this.streamStatesBySession.set(normalizedNextSessionId, streamState);
        }
        this.messageQueue = this.messageQueue.map((entry) => (
            this.isQueuedMessageForSession(entry, normalizedPreviousSessionId)
                ? {
                    ...entry,
                    sessionId: normalizedNextSessionId,
                }
                : entry
        ));

        if (this.pendingWorkloadSessionId === normalizedPreviousSessionId) {
            this.pendingWorkloadSessionId = normalizedNextSessionId;
        }
        if (this.subscribedWorkloadSessionId === normalizedPreviousSessionId) {
            this.subscribedWorkloadSessionId = normalizedNextSessionId;
        }

        return normalizedNextSessionId;
    }

    handleInputSlashCommand(value) {
        // Could implement inline command suggestions here
        // For now, commands are handled via the command palette
    }

    setupSessionListeners() {
        // Session events
        sessionManager.addEventListener('sessionsChanged', (e) => {
            uiHelpers.renderSessionsList(e.detail.sessions, sessionManager.currentSessionId);
            this.renderWorkloadsPanel();
            this.renderProjectViewport();
            this.updateSessionInfo();
        });
        
        sessionManager.addEventListener('sessionCreated', (e) => {
            apiClient.setSessionId(e.detail.session.id);
            if (e.detail.session?.model) {
                uiHelpers.setCurrentModel(e.detail.session.model);
            }
            uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
            this.loadSessionMessages(e.detail.session.id);
            this.subscribeToSessionUpdates(e.detail.session.id);
            this.loadSessionWorkloads(e.detail.session.id);
            this.renderProjectViewport();
            this.updateSessionInfo();
        });
        
        sessionManager.addEventListener('sessionSwitched', (e) => {
            this.captureVisibleStreamState(e.detail.previousSessionId);
            apiClient.setSessionId(e.detail.sessionId);
            this.applyStreamStateToVisibleSession(e.detail.sessionId);
            const session = sessionManager.getCurrentSession();
            if (session?.model) {
                uiHelpers.setCurrentModel(session.model);
            }
            uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
            this.updateSessionInfo();

            const cachedMessages = this.syncAnnotatedSurveyStates(e.detail.sessionId);
            this.renderMessages(cachedMessages.length > 0 ? cachedMessages : (e.detail.messages || []));
            this.setDeferredSessionDetailsLoading(e.detail.sessionId, true);
            this.hideDeferredSessionSurfaces(e.detail.sessionId);

            const switchedSessionId = e.detail.sessionId;
            this.loadSessionMessages(switchedSessionId, {
                refreshManagedApp: false,
            })
                .finally(() => {
                    if (sessionManager.currentSessionId !== switchedSessionId) {
                        return;
                    }

                    this.subscribeToSessionUpdates(switchedSessionId);
                    this.scheduleDeferredSessionDetails(switchedSessionId);
                    this.updateSessionInfo();
                    void this.processMessageQueue({ sessionId: switchedSessionId });
                    uiHelpers.closeSidebar();
                });
        });

        sessionManager.addEventListener('sessionDeleted', (e) => {
            this.discardQueuedMessagesForSession(e.detail.sessionId);
            apiClient.setSessionId(e.detail.newCurrentSessionId || null);
            if (e.detail.newCurrentSessionId) {
                const session = sessionManager.getCurrentSession();
                if (session?.model) {
                    uiHelpers.setCurrentModel(session.model);
                }
                this.loadSessionMessages(e.detail.newCurrentSessionId);
                this.subscribeToSessionUpdates(e.detail.newCurrentSessionId);
                this.loadSessionWorkloads(e.detail.newCurrentSessionId);
            } else {
                uiHelpers.clearMessages();
                uiHelpers.showWelcomeMessage();
                this.subscribeToSessionUpdates(null);
                this.currentSessionWorkloads = [];
                this.workloadRunsById.clear();
                this.hiddenCompletedWorkloadCount = 0;
                this.renderWorkloadsPanel();
            }
            this.renderProjectViewport();
            this.updateSessionInfo();
        });
        
        sessionManager.addEventListener('messagesCleared', () => {
            uiHelpers.clearMessages();
            uiHelpers.showWelcomeMessage();
        });

        sessionManager.addEventListener('sessionPromoted', (e) => {
            this.remapSessionScopedState(e.detail.previousSessionId, e.detail.sessionId);
            if (this.isVisibleSession(e.detail.sessionId)) {
                this.subscribeToSessionUpdates(e.detail.sessionId);
                this.loadSessionWorkloads(e.detail.sessionId);
            }
            const promotedMessages = Array.isArray(e.detail.messages) ? e.detail.messages : [];
            promotedMessages.forEach((message) => {
                this.persistSessionMessageIfNeeded(e.detail.sessionId, message);
            });
        });
    }

    setupModelListeners() {
        // Listen for model changes from UI
        // This is handled by the modelChanged event dispatched in ui.js
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Command palette: Ctrl+K or Cmd+K
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                if (document.getElementById('command-palette').classList.contains('hidden')) {
                    uiHelpers.openCommandPalette();
                } else {
                    uiHelpers.closeCommandPalette();
                }
            }
            
            // Image generation: Ctrl+I or Cmd+I (handled in ui.js)
            
            // Search: Ctrl+F or Cmd+F
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                if (!sessionManager.currentSessionId) {
                    uiHelpers.showToast('Open a conversation first', 'info');
                    return;
                }
                uiHelpers.openSearch();
            }
            
            // New chat: Ctrl+N or Cmd+N
            if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
                e.preventDefault();
                this.createNewSession();
            }
            
            // Toggle sidebar: Ctrl+B or Cmd+B
            if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
                e.preventDefault();
                uiHelpers.toggleSidebar();
            }

            // Toggle minimalist mode: Ctrl+Shift+M
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'M') {
                e.preventDefault();
                uiHelpers.toggleMinimalistMode({ appInstance: this });
            }
            
            // Toggle input area: Ctrl+Shift+H
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'H') {
                e.preventDefault();
                uiHelpers.toggleInputArea();
            }
            
            // Escape handling with priority: Modal > Command Palette > Search > Streaming
            if (e.key === 'Escape') {
                this.handleEscapeKey();
            }
        });
    }
    
    /**
     * Handle Escape key with proper priority:
     * 1. Close any open modal
     * 2. Close command palette
     * 3. Close search
     * 4. Cancel streaming
     */
    handleEscapeKey() {
        // Priority 1: Check for any open modals (export, import, image, shortcuts)
        const openModals = document.querySelectorAll('.modal:not(.hidden)');
        if (openModals.length > 0) {
            // Close the last opened modal
            const lastModal = openModals[openModals.length - 1];
            const modalId = lastModal.id;
            
            if (modalId === 'export-modal') {
                uiHelpers.closeExportModal();
            } else if (modalId === 'import-modal') {
                uiHelpers.closeImportModal();
            } else if (modalId === 'image-modal') {
                uiHelpers.closeImageModal();
            } else if (modalId === 'shortcuts-modal') {
                uiHelpers.closeShortcutsModal();
            } else if (modalId === 'image-lightbox') {
                uiHelpers.closeImageLightbox();
            } else if (modalId === 'workload-modal') {
                this.closeWorkloadModal();
            } else {
                // Generic modal close
                lastModal.classList.add('hidden');
                lastModal.setAttribute('aria-hidden', 'true');
            }
            return;
        }
        
        // Priority 2: Check for model selector dropdown
        const modelDropdown = document.getElementById('model-selector-dropdown');
        if (modelDropdown && !modelDropdown.classList.contains('hidden')) {
            uiHelpers.closeModelSelector();
            return;
        }
        
        // Priority 3: Check for command palette
        const commandPalette = document.getElementById('command-palette');
        if (commandPalette && !commandPalette.classList.contains('hidden')) {
            uiHelpers.closeCommandPalette();
            return;
        }
        
        // Priority 4: Check for search
        const searchBar = document.getElementById('search-bar');
        if (searchBar && !searchBar.classList.contains('hidden')) {
            this.closeSearch();
            return;
        }
        
        // Priority 5: Cancel current streaming if active
        if (this.isCurrentSessionProcessing()) {
            void this.cancelCurrentRequest();
        }
    }

    setupConnectivityListeners() {
        window.addEventListener('online', () => {
            console.log('Browser went online');
            this.scheduleResumeSync('online', 0);
        });
        
        window.addEventListener('offline', () => {
            console.log('Browser went offline');
            this.pageWasHidden = true;
            this.markActiveStreamInterrupted('offline');
            this.updateConnectionStatus('disconnected');
            if ((this.pendingStreamResync || this.activeStreamRequest)?.acceptedByServer) {
                this.enterBackgroundStreamMode({
                    detail: this.getBackgroundStreamDetail(),
                });
                return;
            }
            uiHelpers.showToast('You are offline', 'warning');
        });
    }

    // ============================================
    // Session Management
    // ============================================

    async loadSessions() {
        try {
            await sessionManager.loadSessions({ preserveCurrentSession: true });
            const health = await apiClient.checkHealth();
            this.updateConnectionStatus(health.connected ? 'connected' : 'disconnected');
            uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
            apiClient.setSessionId(sessionManager.currentSessionId || null);
            
            // If we have a current session, load its messages
            if (sessionManager.currentSessionId) {
                await this.loadSessionMessages(sessionManager.currentSessionId, {
                    renderCachedFirst: true,
                    refreshManagedApp: false,
                });
                this.subscribeToSessionUpdates(sessionManager.currentSessionId);
                this.scheduleDeferredSessionDetails(sessionManager.currentSessionId);
            } else {
                this.renderWorkloadsPanel();
                this.renderProjectViewport();
            }
            
            this.renderProjectViewport();
            this.updateSessionInfo();
        } catch (error) {
            console.error('Failed to load sessions:', error);
            this.updateConnectionStatus('disconnected');
            // Show empty state
            uiHelpers.renderSessionsList([], null);
            this.renderWorkloadsPanel();
            this.renderProjectViewport();
        }
    }

    async createNewSession() {
        try {
            this.clearTtsAutoPlayQueue();
            uiHelpers.stopSpeechPlayback();
            await sessionManager.createSession('chat');
            uiHelpers.hideWelcomeMessage();
            uiHelpers.clearMessages();
            this.loadSessionWorkloads(sessionManager.currentSessionId);
            this.messageInput?.focus();
            uiHelpers.showToast('New conversation started', 'success');
        } catch (error) {
            uiHelpers.showToast('Failed to create new session', 'error');
        }
    }

    async loadSessionMessages(sessionId, options = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return [];
        }

        this.clearTtsAutoPlayQueue();
        uiHelpers.stopSpeechPlayback();
        const shouldReconcileVisible = options.reconcileVisible === true && this.isVisibleSession(normalizedSessionId);
        const previousVisibleMessages = shouldReconcileVisible
            ? (Array.isArray(options.previousMessages)
                ? options.previousMessages
                : [...sessionManager.getMessages(normalizedSessionId)])
            : [];
        if (options.renderCachedFirst === true && this.isVisibleSession(normalizedSessionId)) {
            const cachedMessages = this.syncAnnotatedSurveyStates(normalizedSessionId);
            this.renderMessages(cachedMessages);
        }

        if (options.refreshBackend !== false) {
            await sessionManager.loadSessionMessagesFromBackend(normalizedSessionId);
        }
        if (options.refreshManagedApp !== false) {
            await this.refreshManagedAppProgressForSession(normalizedSessionId);
        }
        let messages = this.syncAnnotatedSurveyStates(normalizedSessionId);
        const resumedBackgroundStream = this.resumePersistedBackgroundStream(normalizedSessionId, messages);
        if (resumedBackgroundStream) {
            messages = this.syncAnnotatedSurveyStates(normalizedSessionId);
        }
        if (options.render === false || !this.isVisibleSession(normalizedSessionId)) {
            return messages;
        }

        this.renderProjectViewport();
        if (shouldReconcileVisible) {
            this.reconcileVisibleMessages(previousVisibleMessages, messages);
        } else {
            this.renderMessages(messages);
        }
        if (options.notifyNewAssistant === true && Array.isArray(options.previousMessages)) {
            this.playCueForNewAssistantMessages(options.previousMessages, messages);
        }
        return messages;
    }

    setDeferredSessionDetailsLoading(sessionId = '', loading = true) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (loading && normalizedSessionId) {
            this.deferredSessionDetailsSessionId = normalizedSessionId;
        } else if (!normalizedSessionId || this.deferredSessionDetailsSessionId === normalizedSessionId) {
            this.deferredSessionDetailsSessionId = null;
        }

        this.updateSessionInfo();
        if (normalizedSessionId && this.isVisibleSession(normalizedSessionId)) {
            this.renderWorkloadsPanel();
        }
    }

    hideDeferredSessionSurfaces(sessionId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId || !this.isVisibleSession(normalizedSessionId)) {
            return;
        }

        const appShell = document.getElementById('app');
        appShell?.classList.remove('has-project-viewport', 'has-project-viewport-collapsed');

        if (this.projectViewport) {
            this.projectViewport.classList.add('hidden', 'is-suspended');
            this.projectViewport.setAttribute('aria-hidden', 'true');
        }
        if (this.projectViewportFrame) {
            this.projectViewportFrame.dataset.rawProjectUrl = '';
            this.projectViewportFrame.dataset.rawProjectUrlKey = '';
            this.projectViewportFrame.dataset.projectUrl = '';
            this.projectViewportFrame.dataset.suspendedProjectUrl = '';
            this.projectViewportFrame.removeAttribute('src');
        }
        this.setProjectViewportFrameState('suspended', 'Loading preview', 'Conversation history is ready; project details will appear next.');

        this.currentSessionWorkloads = [];
        this.workloadRunsById.clear();
        this.hiddenCompletedWorkloadCount = 0;
        this.renderWorkloadsPanel();
    }

    scheduleDeferredSessionDetails(sessionId = '', options = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return;
        }

        if (this.deferredSessionDetailsTimer) {
            window.clearTimeout(this.deferredSessionDetailsTimer);
            this.deferredSessionDetailsTimer = null;
        }

        const requestId = ++this.deferredSessionDetailsRequestId;
        const delayMs = Number.isFinite(Number(options.delayMs)) ? Math.max(0, Number(options.delayMs)) : 120;
        this.setDeferredSessionDetailsLoading(normalizedSessionId, true);

        this.deferredSessionDetailsTimer = window.setTimeout(() => {
            this.deferredSessionDetailsTimer = null;
            void this.loadDeferredSessionDetails(normalizedSessionId, requestId);
        }, delayMs);
    }

    async loadDeferredSessionDetails(sessionId = '', requestId = this.deferredSessionDetailsRequestId) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId || requestId !== this.deferredSessionDetailsRequestId) {
            return;
        }

        try {
            await this.refreshManagedAppProgressForSession(normalizedSessionId);
            if (requestId !== this.deferredSessionDetailsRequestId || !this.isVisibleSession(normalizedSessionId)) {
                return;
            }

            this.renderProjectViewport();
            await this.loadSessionWorkloads(normalizedSessionId, {
                force: true,
                quiet: true,
            });
        } finally {
            if (requestId === this.deferredSessionDetailsRequestId) {
                this.setDeferredSessionDetailsLoading(normalizedSessionId, false);
                this.updateSessionInfo();
            }
        }
    }

    async loadSessionWorkloads(sessionId, options = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            this.workloadsAvailable = true;
            this.currentSessionWorkloads = [];
            this.workloadRunsById.clear();
            this.hiddenCompletedWorkloadCount = 0;
            this.renderWorkloadsPanel();
            return [];
        }

        if (window.sessionManager?.isLocalSession?.(normalizedSessionId)) {
            this.workloadsAvailable = false;
            this.currentSessionWorkloads = [];
            this.workloadRunsById.clear();
            this.hiddenCompletedWorkloadCount = 0;
            this.renderWorkloadsPanel();
            return [];
        }

        if (this.isLoadingWorkloads && this.loadingWorkloadsSessionId === normalizedSessionId && !options.force) {
            return this.currentSessionWorkloads;
        }

        this.isLoadingWorkloads = true;
        this.loadingWorkloadsSessionId = normalizedSessionId;
        try {
            const result = await apiClient.getSessionWorkloads(normalizedSessionId);
            const nextWorkloadsAvailable = result.available !== false;
            const allWorkloads = Array.isArray(result.workloads) ? result.workloads : [];

            const nextWorkloadRunsById = new Map();
            if (nextWorkloadsAvailable && allWorkloads.length > 0) {
                const runs = await Promise.all(allWorkloads.map((workload) =>
                    apiClient.getWorkloadRuns(workload.id, 6)
                        .then((items) => [workload.id, items])
                        .catch((error) => {
                            console.warn('Failed to load workload runs:', error);
                            return [workload.id, []];
                        })));

                runs.forEach(([workloadId, items]) => {
                    nextWorkloadRunsById.set(workloadId, items);
                });
            }

            if (!this.isVisibleSession(normalizedSessionId)) {
                return allWorkloads;
            }

            this.workloadsAvailable = nextWorkloadsAvailable;
            if (!this.workloadsAvailable) {
                this.pauseWorkloadSocket();
            }

            this.workloadRunsById = nextWorkloadRunsById;
            this.currentSessionWorkloads = allWorkloads.filter((workload) => !this.shouldHideCompletedWorkload(
                workload,
                this.workloadRunsById.get(workload.id) || [],
            ));
            this.hiddenCompletedWorkloadCount = Math.max(0, allWorkloads.length - this.currentSessionWorkloads.length);

            this.renderWorkloadsPanel();
            if (this.workloadsAvailable) {
                this.workloadSocketPaused = false;
                this.subscribeToSessionUpdates(normalizedSessionId);
            }
            return this.currentSessionWorkloads;
        } catch (error) {
            console.error('Failed to load workloads:', error);
            if (!this.isVisibleSession(normalizedSessionId)) {
                return [];
            }
            this.workloadsAvailable = true;
            this.currentSessionWorkloads = [];
            this.workloadRunsById.clear();
            this.hiddenCompletedWorkloadCount = 0;
            this.renderWorkloadsPanel();
            if (options.quiet !== true) {
                uiHelpers.showToast(error.message || 'Failed to load workloads', 'error');
            }
            return [];
        } finally {
            if (this.loadingWorkloadsSessionId === normalizedSessionId) {
                this.isLoadingWorkloads = false;
                this.loadingWorkloadsSessionId = null;
            }
        }
    }

    renderMessages(messages) {
        this.clearBufferedStreamingRenders();
        uiHelpers.clearMessages();
        
        if (messages.length === 0) {
            uiHelpers.showWelcomeMessage();
            this.updateAudioControls();
            return;
        }
        
        uiHelpers.hideWelcomeMessage();

        const fragment = document.createDocumentFragment();
        messages.forEach((message) => {
            const messageEl = uiHelpers.renderMessage(message);
            fragment.appendChild(messageEl);
        });

        this.messagesContainer.appendChild(fragment);
        uiHelpers.reinitializeIcons(this.messagesContainer);
        uiHelpers.updateMessageSpeechButtons(this.messagesContainer);
        uiHelpers.highlightCodeBlocks(this.messagesContainer);
        uiHelpers.scrollToBottom(false);
        this.updateAudioControls();
    }

    reconcileVisibleMessages(previousMessages = [], nextMessages = []) {
        const nextList = Array.isArray(nextMessages) ? nextMessages : [];
        if (nextList.length === 0) {
            this.renderMessages(nextList);
            return;
        }

        const existingEls = Array.from(this.messagesContainer.querySelectorAll('.message[data-message-id]'));
        const existingIds = existingEls.map((entry) => String(entry.dataset.messageId || entry.id || '').trim());
        const nextIds = nextList.map((message) => String(message?.id || '').trim());
        const canPatchInPlace = existingIds.length === nextIds.length
            && nextIds.every((id, index) => id && id === existingIds[index]);

        if (!canPatchInPlace) {
            this.renderMessages(nextList);
            return;
        }

        const previousById = new Map(
            (Array.isArray(previousMessages) ? previousMessages : [])
                .filter((message) => message?.id)
                .map((message) => [message.id, this.buildMessageRefreshSignature([message])]),
        );

        nextList.forEach((message) => {
            if (!message?.id) {
                return;
            }
            const previousSignature = previousById.get(message.id);
            const nextSignature = this.buildMessageRefreshSignature([message]);
            if (previousSignature !== nextSignature) {
                uiHelpers.updateMessageContent(message.id, message, message.isStreaming === true);
            }
        });

        uiHelpers.updateMessageSpeechButtons(this.messagesContainer);
        this.updateAudioControls();
    }

    clearCurrentSession() {
        if (!sessionManager.currentSessionId) return;
        
        if (confirm('Clear all messages in this conversation? This cannot be undone.')) {
            this.clearTtsAutoPlayQueue();
            uiHelpers.stopSpeechPlayback();
            sessionManager.clearSessionMessages(sessionManager.currentSessionId);
            uiHelpers.showToast('Messages cleared', 'success');
        }
    }

    updateSessionInfoLegacy() {
        const session = sessionManager.getCurrentSession();
        if (session) {
            const messageCount = sessionManager.getMessages(session.id)?.length || 0;
            this.currentSessionInfo.innerHTML = `
                ${sessionManager.getSessionModeLabel(session.mode)} • 
                ${sessionManager.formatTimestamp(session.updatedAt)} • 
                ${messageCount} message${messageCount !== 1 ? 's' : ''}
            `;
        } else {
            this.currentSessionInfo.textContent = 'No active session';
        }
    }

    toggleWorkloadsPanel() {
        this.workloadsOpen = !this.workloadsOpen;
        this.syncWorkloadsPanelState();

        if (this.workloadsOpen) {
            this.loadSessionWorkloads(sessionManager.currentSessionId, { force: true });
            window.requestAnimationFrame(() => {
                this.workloadsPanel?.scrollIntoView({
                    block: 'start',
                    behavior: uiHelpers.isMinimalistMode() ? 'smooth' : 'auto',
                });
                if (typeof this.workloadsPanel?.focus === 'function') {
                    try {
                        this.workloadsPanel.focus({ preventScroll: true });
                    } catch (_error) {
                        this.workloadsPanel.focus();
                    }
                }
            });
        }
    }

    closeWorkloadsPanel() {
        this.workloadsOpen = false;
        this.syncWorkloadsPanelState();
        this.workloadsBtn?.focus?.();
    }

    syncWorkloadsPanelState() {
        const isOpen = this.workloadsOpen === true;
        this.workloadsPanel?.classList.toggle('hidden', !isOpen);
        this.workloadsPanel?.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
        this.workloadsBtn?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    renderWorkloadsPanel() {
        if (!this.workloadsPanel || !this.workloadsEmpty || !this.workloadsList) {
            this.renderBackgroundWorkloadStatus();
            return;
        }

        const sessionId = sessionManager.currentSessionId;
        if (this.refreshWorkloadsBtn) {
            this.refreshWorkloadsBtn.disabled = !sessionId || !this.workloadsAvailable;
        }
        if (this.newWorkloadBtn) {
            this.newWorkloadBtn.disabled = !sessionId || !this.workloadsAvailable;
        }
        this.renderBackgroundWorkloadStatus();
        this.updateSessionInfo();

        if (!sessionId) {
            this.workloadsEmpty.textContent = 'Open a conversation to manage workloads.';
            this.workloadsEmpty.classList.remove('hidden');
            this.workloadsList.innerHTML = '';
            return;
        }

        if (this.deferredSessionDetailsSessionId === sessionId) {
            this.workloadsEmpty.textContent = 'Loading conversation details...';
            this.workloadsEmpty.classList.remove('hidden');
            this.workloadsList.innerHTML = '';
            return;
        }

        if (this.workloadsAvailable === false) {
            this.workloadsEmpty.textContent = 'Deferred workloads require Postgres-backed persistence.';
            this.workloadsEmpty.classList.remove('hidden');
            this.workloadsList.innerHTML = '';
            return;
        }

        if (this.currentSessionWorkloads.length === 0) {
            this.workloadsEmpty.textContent = this.hiddenCompletedWorkloadCount > 0
                ? 'No active workloads for this conversation. Completed one-time workloads are hidden.'
                : 'No workloads yet for this conversation.';
            this.workloadsEmpty.classList.remove('hidden');
            this.workloadsList.innerHTML = '';
            return;
        }

        this.workloadsEmpty.classList.add('hidden');
        this.workloadsList.innerHTML = this.currentSessionWorkloads
            .map((workload) => this.renderWorkloadCard(workload))
            .join('');
        uiHelpers.reinitializeIcons(this.workloadsList);
    }

    getCurrentBackgroundWorkloadSnapshot() {
        const session = sessionManager.getCurrentSession();
        const sessionSummary = session?.workloadSummary || {};
        const aggregatedSummary = this.currentSessionWorkloads.reduce((accumulator, workload) => {
            const summary = workload?.workloadSummary || {};
            accumulator.queued += Math.max(0, Number(summary.queued || 0));
            accumulator.running += Math.max(0, Number(summary.running || 0));
            accumulator.failed += Math.max(0, Number(summary.failed || 0));
            return accumulator;
        }, {
            queued: 0,
            running: 0,
            failed: 0,
        });

        const titles = this.currentSessionWorkloads
            .filter((workload) => {
                const summary = workload?.workloadSummary || {};
                return Number(summary.running || 0) > 0 || Number(summary.queued || 0) > 0;
            })
            .map((workload) => String(workload?.title || '').trim())
            .filter(Boolean)
            .slice(0, 2);

        return {
            running: Math.max(
                Math.max(0, Number(sessionSummary.running || 0)),
                aggregatedSummary.running,
            ),
            queued: Math.max(
                Math.max(0, Number(sessionSummary.queued || 0)),
                aggregatedSummary.queued,
            ),
            failed: Math.max(
                Math.max(0, Number(sessionSummary.failed || 0)),
                aggregatedSummary.failed,
            ),
            titles,
        };
    }

    formatBackgroundTaskCount(count, label = 'background task') {
        const normalizedCount = Math.max(0, Number(count || 0));
        return `${normalizedCount} ${label}${normalizedCount === 1 ? '' : 's'}`;
    }

    renderBackgroundWorkloadStatus() {
        if (!this.backgroundWorkloadStatus) {
            return;
        }

        if (this.backgroundWorkloadStatusHideTimer) {
            window.clearTimeout(this.backgroundWorkloadStatusHideTimer);
            this.backgroundWorkloadStatusHideTimer = null;
        }

        const sessionId = sessionManager.currentSessionId;
        if (!sessionId || !this.workloadsAvailable) {
            this.backgroundWorkloadStatus.innerHTML = '';
            this.backgroundWorkloadStatus.classList.add('hidden');
            return;
        }

        if (window.matchMedia('(max-width: 640px)').matches) {
            this.backgroundWorkloadStatus.innerHTML = '';
            this.backgroundWorkloadStatus.classList.add('hidden');
            return;
        }

        const snapshot = this.getCurrentBackgroundWorkloadSnapshot();
        if (snapshot.running < 1 && snapshot.queued < 1) {
            this.backgroundWorkloadStatus.innerHTML = '';
            this.backgroundWorkloadStatus.classList.add('hidden');
            return;
        }

        const detailParts = [];
        if (snapshot.running > 0) {
            detailParts.push(`${this.formatBackgroundTaskCount(snapshot.running)} running`);
        }
        if (snapshot.queued > 0) {
            detailParts.push(`${this.formatBackgroundTaskCount(snapshot.queued)} queued`);
        }

        const title = snapshot.running > 0
            ? 'Background work is running'
            : 'Background work is queued';
        const detail = `${detailParts.join(' and ')}. Updates will appear in this chat automatically.`;
        const titles = snapshot.titles.length > 0
            ? `Active: ${snapshot.titles.join(' • ')}`
            : '';

        this.backgroundWorkloadStatus.innerHTML = `
            <span class="background-workload-status__icon" aria-hidden="true">
                <i data-lucide="${snapshot.running > 0 ? 'loader-2' : 'clock-3'}" class="w-4 h-4"></i>
            </span>
            <div class="background-workload-status__copy">
                <span class="background-workload-status__title">${uiHelpers.escapeHtml(title)}</span>
                <span class="background-workload-status__detail">${uiHelpers.escapeHtml(detail)}</span>
            </div>
            ${titles ? `<p class="background-workload-status__titles">${uiHelpers.escapeHtml(titles)}</p>` : ''}
        `;
        this.backgroundWorkloadStatus.classList.remove('hidden');
        uiHelpers.reinitializeIcons(this.backgroundWorkloadStatus);
    }

    renderWorkloadCard(workload) {
        const runs = this.workloadRunsById.get(workload.id) || [];
        const summary = workload.workloadSummary || {};
        const runsMarkup = runs.length === 0
            ? '<div class="workload-run-empty">No runs yet.</div>'
            : runs.map((run) => `
                <div class="workload-run">
                    <span class="workload-run__status workload-run__status--${uiHelpers.escapeHtml(run.status || 'queued')}">${uiHelpers.escapeHtml(this.formatRunStatus(run.status))}</span>
                    <span class="workload-run__meta">${uiHelpers.escapeHtml(this.describeRun(run))}</span>
                </div>
            `).join('');

        return `
            <article class="workload-card" data-workload-id="${uiHelpers.escapeHtmlAttr(workload.id)}">
                <div class="workload-card__header">
                    <div>
                        <div class="workload-card__title-row">
                            <h3 class="workload-card__title">${uiHelpers.escapeHtml(workload.title || 'Untitled workload')}</h3>
                            <span class="workload-card__badge ${workload.enabled === false ? 'is-paused' : ''}">${workload.enabled === false ? 'Paused' : 'Active'}</span>
                        </div>
                        <div class="workload-card__meta">${uiHelpers.escapeHtml(this.describeTrigger(workload.trigger))}</div>
                        ${workload.callableSlug ? `<div class="workload-card__meta">Callable: <code>${uiHelpers.escapeHtml(workload.callableSlug)}</code></div>` : ''}
                    </div>
                    <div class="workload-card__actions">
                        <button class="btn-secondary px-3 py-2 rounded-lg text-sm" data-workload-action="run" data-workload-id="${uiHelpers.escapeHtmlAttr(workload.id)}">Run now</button>
                        <button class="btn-secondary px-3 py-2 rounded-lg text-sm" data-workload-action="edit" data-workload-id="${uiHelpers.escapeHtmlAttr(workload.id)}">Edit</button>
                        <button class="btn-secondary px-3 py-2 rounded-lg text-sm" data-workload-action="${workload.enabled === false ? 'resume' : 'pause'}" data-workload-id="${uiHelpers.escapeHtmlAttr(workload.id)}">${workload.enabled === false ? 'Resume' : 'Pause'}</button>
                        <button class="btn-icon danger p-2 rounded-lg" data-workload-action="delete" data-workload-id="${uiHelpers.escapeHtmlAttr(workload.id)}" aria-label="Delete workload">
                            <i data-lucide="trash-2" class="w-4 h-4" aria-hidden="true"></i>
                        </button>
                    </div>
                </div>
                <p class="workload-card__prompt">${uiHelpers.escapeHtml(this.truncateWorkloadText(workload.prompt, 220))}</p>
                <div class="workload-card__summary">
                    <span>Queued ${Number(summary.queued || 0)}</span>
                    <span>Running ${Number(summary.running || 0)}</span>
                    <span>Failed ${Number(summary.failed || 0)}</span>
                    <span>Stages ${Array.isArray(workload.stages) ? workload.stages.length : 0}</span>
                </div>
                <div class="workload-runs">${runsMarkup}</div>
            </article>
        `;
    }

    truncateWorkloadText(text, limit = 220) {
        const normalized = String(text || '').trim().replace(/\s+/g, ' ');
        if (normalized.length <= limit) {
            return normalized;
        }

        return `${normalized.slice(0, limit - 3)}...`;
    }

    shouldHideCompletedWorkload(workload = {}, runs = []) {
        if (String(workload?.trigger?.type || 'manual').trim().toLowerCase() !== 'once') {
            return false;
        }

        const summary = workload?.workloadSummary || {};
        if (Number(summary.queued || 0) > 0 || Number(summary.running || 0) > 0 || Number(summary.failed || 0) > 0) {
            return false;
        }

        if (!Array.isArray(runs) || runs.length === 0) {
            return false;
        }

        const terminalStatuses = new Set(['completed', 'cancelled']);
        const statuses = runs
            .map((run) => String(run?.status || '').trim().toLowerCase())
            .filter(Boolean);

        return statuses.length > 0 && statuses.every((status) => terminalStatuses.has(status));
    }

    describeTrigger(trigger = {}) {
        if (!trigger || trigger.type === 'manual') {
            return 'Manual trigger';
        }

        if (trigger.type === 'once') {
            return `Runs once at ${this.formatDateTime(trigger.runAt)}`;
        }

        if (trigger.type === 'cron') {
            return this.translateCronExpression(trigger.expression || '', trigger.timezone || 'UTC');
        }

        return 'Manual trigger';
    }

    describeRun(run = {}) {
        const stage = Number.isFinite(Number(run.stageIndex)) && Number(run.stageIndex) >= 0
            ? `stage ${Number(run.stageIndex) + 1}`
            : 'base run';
        const at = run.finishedAt || run.startedAt || run.scheduledFor;
        return `${stage} | ${run.reason || 'manual'} | ${this.formatDateTime(at)}`;
    }

    formatRunStatus(status = '') {
        const normalized = String(status || '').trim().toLowerCase();
        if (!normalized) {
            return 'Queued';
        }

        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }

    formatDateTime(value) {
        if (!value) {
            return 'now';
        }

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return String(value);
        }

        return date.toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });
    }

    getWorkloadPresetCatalog(timezone = 'UTC') {
        return [
            {
                id: 'daily-morning',
                expression: '0 9 * * *',
                label: `Every day at ${this.formatClock(9, 0)}`,
                description: 'Daily brief or inbox sweep.',
                timezone,
            },
            {
                id: 'weekday-morning',
                expression: '0 9 * * 1-5',
                label: `Every weekday at ${this.formatClock(9, 0)}`,
                description: 'Good for workday check-ins.',
                timezone,
            },
            {
                id: 'daily-late-night',
                expression: '5 23 * * *',
                label: `Every day at ${this.formatClock(23, 5)}`,
                description: 'Nightly wrap-up or end-of-day summary.',
                timezone,
            },
            {
                id: 'friday-wrap-up',
                expression: '0 16 * * 5',
                label: `Every Friday at ${this.formatClock(16, 0)}`,
                description: 'Weekly summary before the weekend.',
                timezone,
            },
        ];
    }

    formatClock(hour, minute) {
        const date = new Date();
        date.setHours(Number(hour) || 0, Number(minute) || 0, 0, 0);
        return date.toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
        });
    }

    translateCronExpression(expression = '', timezone = 'UTC') {
        const normalized = String(expression || '').trim();
        const parts = normalized.split(/\s+/).filter(Boolean);
        if (parts.length !== 5) {
            return normalized ? `Custom schedule (${normalized})` : 'Custom schedule';
        }

        const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
        const hourValue = Number(hour);
        const minuteValue = Number(minute);
        const hasFixedTime = Number.isInteger(hourValue) && Number.isInteger(minuteValue);
        const timeLabel = hasFixedTime ? this.formatClock(hourValue, minuteValue) : '';
        const dayNameMap = {
            0: 'Sunday',
            1: 'Monday',
            2: 'Tuesday',
            3: 'Wednesday',
            4: 'Thursday',
            5: 'Friday',
            6: 'Saturday',
            7: 'Sunday',
        };

        if (hasFixedTime && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
            return `Every day at ${timeLabel}`;
        }

        if (hasFixedTime && dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
            return `Every weekday at ${timeLabel}`;
        }

        if (hasFixedTime && dayOfMonth === '*' && month === '*' && /^\d$/.test(dayOfWeek)) {
            return `Every ${dayNameMap[Number(dayOfWeek)] || 'week'} at ${timeLabel}`;
        }

        if (hour === '*' && /^\d+$/.test(minute) && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
            return `Every hour at ${String(minute).padStart(2, '0')} minutes past`;
        }

        return `Custom cron ${normalized}${timezone ? ` (${timezone})` : ''}`;
    }

    renderWorkloadPresetTable(selectedExpression = '', timezone = 'UTC') {
        if (!this.workloadPresetGrid) {
            return;
        }

        const normalizedTimezone = String(timezone || '').trim() || 'UTC';
        const normalizedExpression = String(selectedExpression || '').trim();
        const presets = this.getWorkloadPresetCatalog(normalizedTimezone);

        this.workloadPresetGrid.innerHTML = presets.map((preset) => `
            <button
                type="button"
                class="workload-preset-card ${preset.expression === normalizedExpression ? 'is-selected' : ''}"
                data-workload-preset-expression="${uiHelpers.escapeHtmlAttr(preset.expression)}"
                data-workload-preset-label="${uiHelpers.escapeHtmlAttr(preset.label)}"
            >
                <span class="workload-preset-card__label">${uiHelpers.escapeHtml(preset.label)}</span>
                <span class="workload-preset-card__description">${uiHelpers.escapeHtml(preset.description)}</span>
            </button>
        `).join('');

        if (this.workloadPresetSummary) {
            if (!normalizedExpression) {
                this.workloadPresetSummary.textContent = '';
                this.workloadPresetSummary.classList.add('hidden');
            } else {
                this.workloadPresetSummary.textContent = this.translateCronExpression(
                    normalizedExpression,
                    normalizedTimezone,
                );
                this.workloadPresetSummary.classList.remove('hidden');
            }
        }
    }

    applyWorkloadPreset(preset = {}) {
        this.workloadTriggerType.value = 'cron';
        this.workloadCronExpression.value = String(preset.expression || '').trim();
        this.workloadTimezone.value = this.workloadTimezone.value.trim()
            || Intl.DateTimeFormat().resolvedOptions().timeZone
            || 'UTC';
        this.updateWorkloadTriggerFields();
        this.renderWorkloadPresetTable(
            this.workloadCronExpression.value,
            this.workloadTimezone.value,
        );
        this.clearWorkloadFormError();
        this.workloadCronExpression?.focus();
    }

    buildWorkloadFromScenario() {
        try {
            const scenario = this.workloadScenarioInput?.value?.trim() || '';
            if (!scenario) {
                throw new Error('Describe the task and when it should run.');
            }

            const timezone = this.workloadTimezone?.value?.trim()
                || Intl.DateTimeFormat().resolvedOptions().timeZone
                || 'UTC';
            const setup = this.parseScenarioToWorkload(scenario, timezone);

            this.workloadTitleInput.value = setup.title;
            this.workloadPromptInput.value = setup.prompt;

            this.workloadTriggerType.value = setup.trigger.type;
            this.workloadRunAt.value = setup.trigger.type === 'once'
                ? this.toDatetimeLocal(setup.trigger.runAt)
                : '';
            this.workloadCronExpression.value = setup.trigger.type === 'cron'
                ? setup.trigger.expression
                : '';
            this.workloadTimezone.value = setup.trigger.type === 'cron'
                ? setup.trigger.timezone
                : timezone;

            this.updateWorkloadTriggerFields();
            this.renderWorkloadPresetTable(
                this.workloadCronExpression.value,
                this.workloadTimezone.value,
            );
            this.clearWorkloadFormError();
            uiHelpers.showToast(
                setup.trigger.type === 'manual'
                    ? 'Task filled in. No schedule phrase detected, so it was left as manual.'
                    : 'Workload setup filled from your description',
                'success',
            );
        } catch (error) {
            this.showWorkloadFormError(error.message || 'Could not build workload setup from that description');
        }
    }

    parseScenarioToWorkload(scenario = '', timezone = 'UTC') {
        const normalizedScenario = String(scenario || '').trim();
        const lowerScenario = normalizedScenario.toLowerCase();
        const timeInfo = this.extractScenarioTime(normalizedScenario);
        const taskPrompt = this.extractTaskPromptFromScenario(normalizedScenario) || normalizedScenario;
        const title = this.deriveWorkloadTitle(taskPrompt);

        let trigger = { type: 'manual' };

        if (/(tomorrow|today|later today|once|one[- ]time)/i.test(lowerScenario)) {
            trigger = {
                type: 'once',
                runAt: this.buildOneTimeRunAt(lowerScenario, timeInfo).toISOString(),
            };
        } else if (/(every hour|hourly)/i.test(lowerScenario)) {
            trigger = {
                type: 'cron',
                expression: this.createCronExpression(timeInfo, 'hourly'),
                timezone,
            };
        } else if (/(weekday|weekdays|every workday|each workday)/i.test(lowerScenario)) {
            trigger = {
                type: 'cron',
                expression: this.createCronExpression(timeInfo, 'weekdays'),
                timezone,
            };
        } else {
            const weekdayMatch = lowerScenario.match(/\b(?:every|each)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/i);
            if (weekdayMatch) {
                trigger = {
                    type: 'cron',
                    expression: this.createCronExpression(timeInfo, weekdayMatch[1].toLowerCase()),
                    timezone,
                };
            } else if (/(daily|every day|each day|nightly|every night|every evening|every morning)/i.test(lowerScenario)) {
                trigger = {
                    type: 'cron',
                    expression: this.createCronExpression(timeInfo, 'daily'),
                    timezone,
                };
            }
        }

        return {
            title,
            prompt: taskPrompt,
            trigger,
        };
    }

    extractScenarioTime(input = '') {
        const text = String(input || '').trim();
        const twelveHourMatch = text.match(/\b(1[0-2]|0?\d)(?::([0-5]\d))?\s*(am|pm)\b/i);
        if (twelveHourMatch) {
            const rawHour = Number(twelveHourMatch[1]);
            const minute = Number(twelveHourMatch[2] || 0);
            const meridiem = twelveHourMatch[3].toLowerCase();
            let hour = rawHour % 12;
            if (meridiem === 'pm') {
                hour += 12;
            }

            return {
                hour,
                minute,
            };
        }

        const twentyFourHourMatch = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
        if (twentyFourHourMatch) {
            return {
                hour: Number(twentyFourHourMatch[1]),
                minute: Number(twentyFourHourMatch[2]),
            };
        }

        if (/\bmorning\b/i.test(text)) {
            return { hour: 9, minute: 0 };
        }
        if (/\bafternoon\b/i.test(text)) {
            return { hour: 14, minute: 0 };
        }
        if (/\bevening\b/i.test(text)) {
            return { hour: 18, minute: 0 };
        }
        if (/\bnight\b|\bnightly\b/i.test(text)) {
            return { hour: 23, minute: 0 };
        }

        return { hour: 9, minute: 0 };
    }

    buildOneTimeRunAt(lowerScenario = '', timeInfo = { hour: 9, minute: 0 }) {
        const now = new Date();
        const runAt = new Date(now);
        runAt.setSeconds(0, 0);
        runAt.setHours(timeInfo.hour, timeInfo.minute, 0, 0);

        if (/\btomorrow\b/i.test(lowerScenario)) {
            runAt.setDate(runAt.getDate() + 1);
            return runAt;
        }

        if (/\blater today\b/i.test(lowerScenario)) {
            if (runAt <= now) {
                runAt.setHours(now.getHours() + 1, 0, 0, 0);
            }
            return runAt;
        }

        if (/\btoday\b/i.test(lowerScenario)) {
            if (runAt <= now) {
                runAt.setDate(runAt.getDate() + 1);
            }
            return runAt;
        }

        if (runAt <= now) {
            runAt.setHours(now.getHours() + 1, 0, 0, 0);
        }

        return runAt;
    }

    createCronExpression(timeInfo = { hour: 9, minute: 0 }, cadence = 'daily') {
        const minute = Number(timeInfo.minute || 0);
        const hour = Number(timeInfo.hour || 0);
        const weekdayMap = {
            sunday: '0',
            monday: '1',
            tuesday: '2',
            wednesday: '3',
            thursday: '4',
            friday: '5',
            saturday: '6',
        };

        if (cadence === 'hourly') {
            return `${minute} * * * *`;
        }

        if (cadence === 'weekdays') {
            return `${minute} ${hour} * * 1-5`;
        }

        if (weekdayMap[cadence]) {
            return `${minute} ${hour} * * ${weekdayMap[cadence]}`;
        }

        return `${minute} ${hour} * * *`;
    }

    extractTaskPromptFromScenario(scenario = '') {
        const timeFragment = '(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?|morning|afternoon|evening|night)';
        const leadingPatterns = [
            new RegExp(`^(?:every hour|hourly)(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
            new RegExp(`^(?:every|each)\\s+weekdays?(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
            new RegExp(`^(?:every|each)\\s+workdays?(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
            new RegExp(`^(?:daily|nightly)(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
            new RegExp(`^(?:every|each)\\s+day(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
            new RegExp(`^(?:every|each)\\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
            new RegExp(`^(?:once|one[- ]time)(?:\\s+(?:tomorrow|today|later today))?(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
            new RegExp(`^(?:tomorrow|today|later today)(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
        ];
        const embeddedPatterns = [
            new RegExp(`\\b(?:every hour|hourly)(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
            new RegExp(`\\b(?:every|each)\\s+weekdays?(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
            new RegExp(`\\b(?:every|each)\\s+workdays?(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
            new RegExp(`\\b(?:daily|nightly)(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
            new RegExp(`\\b(?:every|each)\\s+day(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
            new RegExp(`\\b(?:every|each)\\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
            new RegExp(`\\b(?:once|one[- ]time)(?:\\s+(?:tomorrow|today|later today))?(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
            new RegExp(`\\b(?:tomorrow|today|later today)(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
        ];

        let taskPrompt = String(scenario || '').trim();
        leadingPatterns.forEach((pattern) => {
            taskPrompt = taskPrompt.replace(pattern, '');
        });
        embeddedPatterns.forEach((pattern) => {
            taskPrompt = taskPrompt.replace(pattern, '');
        });

        return taskPrompt
            .trim()
            .replace(/^[,\s-]+/, '')
            .replace(/[,\s-]+$/, '')
            .replace(/\s{2,}/g, ' ')
            || String(scenario || '').trim();
    }

    deriveWorkloadTitle(prompt = '') {
        const words = String(prompt || '')
            .trim()
            .replace(/[^\w\s-]/g, '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 5);

        if (words.length === 0) {
            return 'New workload';
        }

        return words
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    slugifyWorkloadValue(value = '') {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 64);
    }

    openWorkloadModal(existing = null) {
        if (!sessionManager.currentSessionId) {
            uiHelpers.showToast('Open a conversation first', 'info');
            return;
        }

        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        this.editingWorkload = existing;
        this.workloadModalTitle.textContent = existing ? 'Edit workload' : 'Create workload';
        this.clearWorkloadFormError();
        this.workloadScenarioInput.value = '';
        this.workloadTitleInput.value = existing?.title || '';
        this.workloadPromptInput.value = existing?.prompt || '';
        this.workloadTriggerType.value = existing?.trigger?.type || 'manual';
        this.workloadCallableSlug.value = existing?.callableSlug || '';
        this.workloadRunAt.value = existing?.trigger?.type === 'once' ? this.toDatetimeLocal(existing?.trigger?.runAt) : '';
        this.workloadCronExpression.value = existing?.trigger?.type === 'cron' ? (existing?.trigger?.expression || '') : '';
        this.workloadTimezone.value = existing?.trigger?.type === 'cron'
            ? (existing?.trigger?.timezone || timezone)
            : timezone;
        this.workloadProfile.value = existing?.policy?.executionProfile || 'default';
        this.workloadToolIds.value = Array.isArray(existing?.policy?.toolIds)
            ? existing.policy.toolIds.join(', ')
            : '';
        this.workloadMaxRounds.value = existing?.policy?.maxRounds || 3;
        this.workloadMaxToolCalls.value = existing?.policy?.maxToolCalls || 10;
        this.workloadMaxDuration.value = existing?.policy?.maxDurationMs || 120000;
        this.workloadAllowSideEffects.checked = existing?.policy?.allowSideEffects === true;
        this.workloadLongAgentEnabled.checked = existing
            ? existing?.metadata?.longAgent?.enabled === true
            : uiHelpers.isLongAgentDefaultEnabled?.() === true;
        this.workloadLongAgentScratch.value = existing?.metadata?.longAgent?.scratchFile || '.kimibuilt/long-agent-scratch.md';
        this.workloadLongAgentSteps.value = existing?.metadata?.longAgent?.maxAutoSteps || 4;
        this.workloadStagesJson.value = JSON.stringify(existing?.stages || [], null, 2);
        this.updateWorkloadTriggerFields();
        this.renderWorkloadPresetTable(
            this.workloadCronExpression.value,
            this.workloadTimezone.value,
        );
        this.workloadModal.classList.remove('hidden');
        this.workloadModal.setAttribute('aria-hidden', 'false');
        uiHelpers.trapFocus(this.workloadModal);
        this.workloadTitleInput?.focus();
    }

    closeWorkloadModal() {
        this.editingWorkload = null;
        this.clearWorkloadFormError();
        this.workloadModal?.classList.add('hidden');
        this.workloadModal?.setAttribute('aria-hidden', 'true');
    }

    updateWorkloadTriggerFields() {
        const triggerType = this.workloadTriggerType?.value || 'manual';
        this.workloadOnceRow?.classList.toggle('hidden', triggerType !== 'once');
        this.workloadCronRow?.classList.toggle('hidden', triggerType !== 'cron');
        if (triggerType === 'cron') {
            this.renderWorkloadPresetTable(
                this.workloadCronExpression?.value || '',
                this.workloadTimezone?.value || 'UTC',
            );
        } else if (this.workloadPresetSummary) {
            this.workloadPresetSummary.textContent = '';
            this.workloadPresetSummary.classList.add('hidden');
        }
        if (this.workloadTriggerHelp) {
            this.workloadTriggerHelp.textContent = this.getWorkloadTriggerHelpText(triggerType);
        }
    }

    getWorkloadTriggerHelpText(triggerType = 'manual') {
        if (triggerType === 'once') {
            return 'Use this for a one-off task you want handled later without staying in the chat.';
        }

        if (triggerType === 'cron') {
            return 'Use a recurring schedule for jobs like daily briefs, standups, or periodic checks.';
        }

        return 'Manual workloads stay idle until you trigger them.';
    }

    toDatetimeLocal(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return '';
        }

        const offsetMs = date.getTimezoneOffset() * 60 * 1000;
        return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
    }

    readWorkloadForm() {
        const triggerType = this.workloadTriggerType.value;
        const title = this.workloadTitleInput.value.trim();
        const prompt = this.workloadPromptInput.value.trim();
        const callableSlug = this.workloadCallableSlug.value.trim().toLowerCase();

        if (!title) {
            throw new Error('Give the workload a title.');
        }
        if (!prompt) {
            throw new Error('Write the task you want the agent to run.');
        }
        if (callableSlug && !/^[a-z0-9][a-z0-9-_]{1,63}$/.test(callableSlug)) {
            throw new Error('Callable slug must use lowercase letters, numbers, hyphens, or underscores.');
        }

        const payload = {
            title,
            prompt,
            callableSlug: callableSlug || null,
            trigger: { type: triggerType },
            policy: {
                executionProfile: this.workloadProfile.value,
                toolIds: this.workloadToolIds.value
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean),
                maxRounds: Number(this.workloadMaxRounds.value || 3),
                maxToolCalls: Number(this.workloadMaxToolCalls.value || 10),
                maxDurationMs: Number(this.workloadMaxDuration.value || 120000),
                allowSideEffects: this.workloadAllowSideEffects.checked,
            },
            stages: [],
        };

        if (this.workloadLongAgentEnabled?.checked) {
            const scratchFile = this.workloadLongAgentScratch?.value?.trim() || '.kimibuilt/long-agent-scratch.md';
            const maxAutoSteps = Math.max(1, Math.min(Number(this.workloadLongAgentSteps?.value || 4), 12));
            payload.mode = 'project';
            payload.metadata = {
                longAgent: {
                    enabled: true,
                    goal: prompt,
                    scratchFile,
                    maxAutoSteps,
                    reviewPolicy: 'auto',
                    compaction: {
                        enabled: true,
                        triggerCharCount: 12000,
                        retainChars: 6000,
                        codeCaptureLimit: 4,
                    },
                },
                project: {
                    title,
                    objective: prompt,
                    successDefinition: [
                        'Each stage ends with a compact scratch summary.',
                        'Evaluator events decide review or next-step continuation.',
                        'Final handoff states verification and remaining blockers.',
                    ],
                    milestones: [{
                        title: 'Execute bounded long-form agent loop',
                        objective: prompt,
                        status: 'in_progress',
                        acceptanceCriteria: [
                            'Meaningful progress is made each stage.',
                            'Scratch context is compact enough for continuation.',
                            'Review or next-step follow-up is queued automatically when appropriate.',
                        ],
                    }],
                },
            };
            payload.policy.maxRounds = Math.max(payload.policy.maxRounds || 3, 6);
            payload.policy.maxToolCalls = Math.max(payload.policy.maxToolCalls || 10, 18);
            payload.policy.maxDurationMs = Math.max(payload.policy.maxDurationMs || 120000, 300000);
        }

        if (triggerType === 'once') {
            if (!this.workloadRunAt.value) {
                throw new Error('Run time is required for one-time workloads');
            }
            payload.trigger.runAt = new Date(this.workloadRunAt.value).toISOString();
        }

        if (triggerType === 'cron') {
            payload.trigger.expression = this.workloadCronExpression.value.trim();
            payload.trigger.timezone = this.workloadTimezone.value.trim() || 'UTC';
            if (!payload.trigger.expression) {
                throw new Error('Add a cron expression for recurring workloads.');
            }
        }

        const stagesValue = this.workloadStagesJson.value.trim();
        if (stagesValue) {
            try {
                payload.stages = JSON.parse(stagesValue);
            } catch (_error) {
                throw new Error('Follow-up stages must be valid JSON.');
            }
        }

        return payload;
    }

    async saveWorkload() {
        if (this.isSavingWorkload) {
            return;
        }

        try {
            const sessionId = sessionManager.currentSessionId;
            if (!sessionId) {
                throw new Error('Open a conversation first');
            }

            this.isSavingWorkload = true;
            this.clearWorkloadFormError();
            if (this.saveWorkloadBtn) {
                this.saveWorkloadBtn.disabled = true;
                this.saveWorkloadBtn.textContent = this.editingWorkload?.id ? 'Saving...' : 'Creating...';
            }

            const payload = this.readWorkloadForm();
            if (this.editingWorkload?.id) {
                await apiClient.updateWorkload(this.editingWorkload.id, payload);
                uiHelpers.showToast('Workload updated', 'success');
            } else {
                await apiClient.createSessionWorkload(sessionId, payload);
                uiHelpers.showToast('Workload created', 'success');
            }

            this.closeWorkloadModal();
            await this.refreshSessionWorkloadState(sessionId);
        } catch (error) {
            console.error('Failed to save workload:', error);
            this.showWorkloadFormError(error.message || 'Failed to save workload');
            uiHelpers.showToast(error.message || 'Failed to save workload', 'error');
        } finally {
            this.isSavingWorkload = false;
            if (this.saveWorkloadBtn) {
                this.saveWorkloadBtn.disabled = false;
                this.saveWorkloadBtn.textContent = 'Save workload';
            }
        }
    }

    showWorkloadFormError(message) {
        if (!this.workloadFormError) {
            return;
        }

        this.workloadFormError.textContent = message;
        this.workloadFormError.classList.remove('hidden');
    }

    clearWorkloadFormError() {
        if (!this.workloadFormError) {
            return;
        }

        this.workloadFormError.textContent = '';
        this.workloadFormError.classList.add('hidden');
    }

    async handleWorkloadAction(action, workloadId) {
        const workload = this.currentSessionWorkloads.find((item) => item.id === workloadId) || null;

        try {
            switch (action) {
                case 'run':
                    await apiClient.runWorkload(workloadId);
                    uiHelpers.showToast('Workload queued', 'success');
                    break;
                case 'pause':
                    await apiClient.pauseWorkload(workloadId);
                    uiHelpers.showToast('Workload paused', 'success');
                    break;
                case 'resume':
                    await apiClient.resumeWorkload(workloadId);
                    uiHelpers.showToast('Workload resumed', 'success');
                    break;
                case 'edit':
                    this.openWorkloadModal(workload);
                    return;
                case 'delete':
                    if (!confirm('Delete this workload and cancel queued runs?')) {
                        return;
                    }
                    await apiClient.deleteWorkload(workloadId);
                    uiHelpers.showToast('Workload deleted', 'success');
                    break;
                default:
                    return;
            }

            await this.refreshSessionWorkloadState(sessionManager.currentSessionId);
        } catch (error) {
            console.error('Workload action failed:', error);
            uiHelpers.showToast(error.message || 'Workload action failed', 'error');
        }
    }

    async refreshSessionWorkloadState(sessionId) {
        if (!sessionId) {
            return;
        }

        await this.loadSessionWorkloads(sessionId, { force: true });
        await this.refreshSessionSummaries();

        if (sessionManager.currentSessionId === sessionId && !this.isSessionProcessing(sessionId)) {
            await this.loadSessionMessages(sessionId);
        }
    }

    async refreshSessionSummaries() {
        if (this.isRefreshingSessionSummaries) {
            return;
        }

        this.isRefreshingSessionSummaries = true;
        try {
            await sessionManager.loadSessions({ preserveCurrentSession: true });
        } catch (error) {
            console.warn('Failed to refresh session summaries:', error);
        } finally {
            this.isRefreshingSessionSummaries = false;
        }
    }

    async connectWorkloadSocket() {
        if (this.workloadsAvailable !== true) {
            return;
        }

        if (this.workloadSocketPaused || this.isAppBackgrounded()) {
            return;
        }

        if (this.workloadSocketConnecting) {
            return;
        }

        if (this.workloadSocket && (
            this.workloadSocket.readyState === WebSocket.OPEN
            || this.workloadSocket.readyState === WebSocket.CONNECTING
        )) {
            return;
        }

        this.workloadSocketConnecting = true;
        let wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
        try {
            wsUrl = typeof apiClient?.getAuthenticatedRealtimeSocketUrl === 'function'
                ? await apiClient.getAuthenticatedRealtimeSocketUrl('/ws')
                : typeof apiClient?.getRealtimeSocketUrl === 'function'
                    ? apiClient.getRealtimeSocketUrl('/ws')
                    : wsUrl;
        } catch (error) {
            console.warn('Failed to prepare workload socket URL:', error);
        }

        if (this.workloadSocketPaused || this.isAppBackgrounded()) {
            this.workloadSocketConnecting = false;
            return;
        }

        try {
            this.workloadSocket = new WebSocket(wsUrl);
        } catch (error) {
            this.workloadSocketConnecting = false;
            console.warn('Failed to open workload socket:', error);
            return;
        }
        this.workloadSocketConnecting = false;

        this.workloadSocket.addEventListener('open', () => {
            this.workloadSocketReconnectDelayMs = 1500;
            this.workloadSocketConsecutiveFailures = 0;
            this.subscribeToSessionUpdates(this.pendingWorkloadSessionId || sessionManager.currentSessionId);
        });
        this.workloadSocket.addEventListener('message', (event) => {
            this.handleWorkloadSocketMessage(event.data);
        });
        this.workloadSocket.addEventListener('close', (event) => {
            this.workloadSocket = null;
            this.subscribedWorkloadSessionId = null;
            clearTimeout(this.workloadSocketReconnectTimer);
            this.workloadSocketReconnectTimer = null;
            if (this.workloadSocketPaused || this.isAppBackgrounded()) {
                return;
            }

            const currentBackendSessionId = sessionManager.currentSessionId && !sessionManager.isLocalSession?.(sessionManager.currentSessionId)
                ? sessionManager.currentSessionId
                : null;
            const closeCode = Number(event?.code) || 0;
            this.workloadSocketConsecutiveFailures += 1;
            const shouldRetry = navigator.onLine !== false
                && ![4401, 4403, 1008].includes(closeCode)
                && Boolean(this.pendingWorkloadSessionId || currentBackendSessionId);

            if (!shouldRetry) {
                if ([4401, 4403, 1008].includes(closeCode)) {
                    console.warn(`Workload socket closed with auth/policy code ${closeCode}; live workload updates are disabled until the page reconnects.`);
                }
                return;
            }

            const reconnectDelay = this.workloadSocketConsecutiveFailures >= 4
                ? Math.max(this.workloadSocketCircuitDelayMs, this.workloadSocketReconnectDelayMs)
                : this.workloadSocketReconnectDelayMs;
            this.workloadSocketReconnectTimer = setTimeout(() => {
                this.connectWorkloadSocket();
            }, reconnectDelay);
            this.workloadSocketReconnectDelayMs = Math.min(
                this.workloadSocketReconnectDelayMs * 2,
                this.workloadSocketMaxReconnectDelayMs,
            );
        });
        this.workloadSocket.addEventListener('error', (error) => {
            console.warn('Workload socket error:', error);
            this.workloadSocketConnecting = false;
        });
    }

    pauseWorkloadSocket() {
        this.workloadSocketPaused = true;
        clearTimeout(this.workloadSocketReconnectTimer);
        this.workloadSocketReconnectTimer = null;
        this.subscribedWorkloadSessionId = null;

        const socket = this.workloadSocket;
        this.workloadSocket = null;
        if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
            return;
        }

        try {
            socket.close(1000, 'workspace inactive');
        } catch (_error) {
            // Ignore socket close failures while the browser is suspending an iframe.
        }
    }

    subscribeToSessionUpdates(sessionId) {
        const normalizedSessionId = sessionId && !sessionManager.isLocalSession?.(sessionId)
            ? sessionId
            : null;
        this.pendingWorkloadSessionId = normalizedSessionId;

        if (this.workloadsAvailable !== true || this.workloadSocketPaused || this.isAppBackgrounded()) {
            return;
        }

        if (!normalizedSessionId && this.subscribedWorkloadSessionId && this.workloadSocket?.readyState === WebSocket.OPEN) {
            this.workloadSocket.send(JSON.stringify({
                type: 'session_unsubscribe',
                sessionId: this.subscribedWorkloadSessionId,
                payload: { sessionId: this.subscribedWorkloadSessionId },
            }));
            this.subscribedWorkloadSessionId = null;
            return;
        }

        if (!normalizedSessionId) {
            this.subscribedWorkloadSessionId = null;
            return;
        }

        if (!this.workloadSocket || this.workloadSocket.readyState === WebSocket.CLOSED) {
            this.connectWorkloadSocket();
            return;
        }

        if (this.workloadSocket.readyState !== WebSocket.OPEN) {
            return;
        }

        if (this.subscribedWorkloadSessionId && this.subscribedWorkloadSessionId !== normalizedSessionId) {
            this.workloadSocket.send(JSON.stringify({
                type: 'session_unsubscribe',
                sessionId: this.subscribedWorkloadSessionId,
                payload: { sessionId: this.subscribedWorkloadSessionId },
            }));
        }

        if (this.subscribedWorkloadSessionId === normalizedSessionId) {
            return;
        }

        this.subscribedWorkloadSessionId = normalizedSessionId;
        this.workloadSocket.send(JSON.stringify({
            type: 'session_subscribe',
            sessionId: normalizedSessionId,
            payload: { sessionId: normalizedSessionId },
        }));
    }

    handleWorkloadSocketMessage(rawData) {
        let payload;
        try {
            payload = JSON.parse(rawData);
        } catch (_error) {
            return;
        }

        if (payload?.type === 'managed-app') {
            this.handleManagedAppEvent(payload).catch((error) => {
                console.warn('Failed to process managed app event:', error);
            });
            return;
        }

        if ([
            'workload_queued',
            'workload_started',
            'workload_completed',
            'workload_failed',
            'workload_updated',
        ].includes(payload?.type)) {
            this.handleWorkloadEvent(payload).catch((error) => {
                console.warn('Failed to process workload event:', error);
            });
        }
    }

    normalizeManagedAppPhase(phase = '') {
        return String(phase || '').trim().toLowerCase() || 'updated';
    }

    buildManagedAppProgressKey(value = {}) {
        if (typeof value === 'string') {
            const normalized = String(value || '').trim();
            return normalized ? `managed-app:${normalized}` : 'managed-app:unknown';
        }

        const appId = String(value?.app?.id || value?.metadata?.managedAppId || value?.managedAppId || '').trim();
        const appSlug = String(value?.app?.slug || value?.metadata?.managedAppSlug || value?.managedAppSlug || '').trim();
        return `managed-app:${appId || appSlug || 'unknown'}`;
    }

    getSessionActiveProject(sessionId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return null;
        }

        const session = sessionManager.sessions.find((entry) => entry.id === normalizedSessionId);
        const activeProject = session?.metadata?.activeProject;
        if (!activeProject || typeof activeProject !== 'object') {
            return null;
        }

        return String(activeProject.type || '').trim().toLowerCase() === 'managed-app'
            ? activeProject
            : null;
    }

    getSessionProjectForViewport(sessionId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return null;
        }

        const session = sessionManager.sessions.find((entry) => entry.id === normalizedSessionId);
        const activeProject = session?.metadata?.activeProject;
        if (!activeProject || typeof activeProject !== 'object') {
            return null;
        }

        const type = String(activeProject.type || '').trim().toLowerCase();
        if (type === 'managed-app') {
            return activeProject;
        }

        const hasPreviewUrl = Boolean(
            activeProject.publicUrl
            || activeProject.url
            || activeProject.publicHost
            || activeProject.sandboxUrl
            || activeProject.previewUrl
            || activeProject.artifactPreviewUrl
        );
        return hasPreviewUrl ? activeProject : null;
    }

    normalizeProjectViewportSize(size = '') {
        const normalized = String(size || '').trim().toLowerCase();
        return ['collapsed', 'compact', 'wide', 'full'].includes(normalized) ? normalized : 'wide';
    }

    normalizeProjectHost(value = '') {
        const normalized = String(value || '').trim();
        if (!normalized) {
            return '';
        }
        if (/^https?:\/\//i.test(normalized)) {
            try {
                return new URL(normalized).host;
            } catch (_error) {
                return normalized.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\/+$/, '');
            }
        }
        return normalized.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\/+$/, '');
    }

    isManagedAppPublicEndpointReady(project = {}) {
        const progress = project?.progress && typeof project.progress === 'object'
            ? project.progress
            : {};
        const projectEvidence = project?.evidence && typeof project.evidence === 'object'
            ? project.evidence
            : {};
        const evidence = progress.evidence && typeof progress.evidence === 'object'
            ? progress.evidence
            : projectEvidence;
        const requiredProof = evidence.requiredProof && typeof evidence.requiredProof === 'object'
            ? evidence.requiredProof
            : {};
        const phase = this.normalizeManagedAppPhase(project?.phase || progress?.phase || '');
        const status = this.normalizeManagedAppPhase(project?.status || '');
        const verificationStatus = String(
            project?.verificationStatus
            || progress?.verificationStatus
            || evidence?.verificationStatus
            || '',
        ).trim().toLowerCase();
        const liveDeploy = project?.liveDeploy && typeof project.liveDeploy === 'object'
            ? project.liveDeploy
            : {};

        return requiredProof.publicVerificationObserved === true
            || project.publicVerificationObserved === true
            || liveDeploy.https === true
            || ['live', 'success', 'succeeded'].includes(verificationStatus);
    }

    buildManagedAppLiveProjectUrl(project = {}) {
        const explicitLiveUrl = String(project?.livePublicUrl || project?.deployedUrl || '').trim();
        const endpointReady = this.isManagedAppPublicEndpointReady(project);
        if (endpointReady && /^https?:\/\//i.test(explicitLiveUrl)) {
            return explicitLiveUrl;
        }

        const liveHost = this.normalizeProjectHost(project?.livePublicHost || project?.deployedHost || '');
        if (endpointReady && liveHost) {
            return `https://${liveHost}`;
        }

        if (!endpointReady) {
            return '';
        }

        const publicUrl = String(project?.publicUrl || '').trim();
        if (/^https?:\/\//i.test(publicUrl)) {
            return publicUrl;
        }

        const publicHost = this.normalizeProjectHost(project?.publicHost || project?.targetPublicHost || '');
        return publicHost ? `https://${publicHost}` : '';
    }

    buildProjectViewportUrl(project = {}) {
        const projectType = String(project?.type || '').trim().toLowerCase();
        if (projectType === 'managed-app') {
            return this.buildManagedAppLiveProjectUrl(project);
        }

        const explicitUrl = String(
            project?.publicUrl
            || project?.url
            || project?.previewUrl
            || project?.sandboxUrl
            || project?.artifactPreviewUrl
            || '',
        ).trim();
        if (/^https?:\/\//i.test(explicitUrl)) {
            return explicitUrl;
        }
        if (explicitUrl.startsWith('/')) {
            return explicitUrl;
        }

        const publicHost = this.normalizeProjectHost(project?.publicHost || '');
        return publicHost ? `https://${publicHost}` : '';
    }

    buildProjectViewportUrlKey(url = '') {
        const normalized = String(url || '').trim();
        if (!normalized) {
            return '';
        }

        try {
            const parsed = new URL(normalized, window.location.href);
            parsed.hash = '';
            if (parsed.pathname !== '/') {
                parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
            }
            return parsed.toString();
        } catch (_error) {
            return normalized.replace(/#.*$/, '').replace(/\/+$/, '');
        }
    }

    resolveProjectApiUrl(urlPath = '') {
        const normalized = String(urlPath || '').trim();
        if (!normalized) {
            return '';
        }
        if (/^https?:\/\//i.test(normalized) || normalized.startsWith('blob:') || normalized.startsWith('data:')) {
            return normalized;
        }

        const relativePath = normalized.startsWith('/') ? normalized : `/${normalized}`;
        const base = window.location.protocol === 'file:'
            ? 'http://localhost:3000'
            : `${window.location.protocol}//${window.location.host}`;
        return `${base}${relativePath}`;
    }

    isProjectPreviewAuthRoute(urlPath = '') {
        try {
            const parsed = new URL(this.resolveProjectApiUrl(urlPath), window.location.href);
            return /^\/api\/(?:artifacts|sandbox-workspaces)\/[^/]+\/(?:sandbox|preview)(?:\/)?$/i.test(parsed.pathname)
                || /^\/api\/(?:artifacts|sandbox-workspaces)\/[^/]+\/(?:sandbox-access|preview-access)\//i.test(parsed.pathname);
        } catch (_error) {
            return false;
        }
    }

    async getProjectPreviewAccessToken() {
        if (typeof window.artifactManager?.getPreviewAccessToken === 'function') {
            return window.artifactManager.getPreviewAccessToken();
        }

        const now = Date.now();
        if (
            this.projectPreviewTokenCache?.token
            && Number(this.projectPreviewTokenCache.expiresAt || 0) * 1000 > now + 30000
        ) {
            return this.projectPreviewTokenCache.token;
        }

        const response = await fetch(this.resolveProjectApiUrl('/api/auth/ws-token'), {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
        });
        if (!response.ok) {
            throw new Error(`Project preview authentication failed (${response.status})`);
        }

        const data = await response.json().catch(() => ({}));
        const token = String(data?.token || '').trim();
        if (!token) {
            throw new Error('Project preview authentication did not return a token.');
        }

        this.projectPreviewTokenCache = {
            token,
            expiresAt: Number(data?.expiresAt || 0),
        };
        return token;
    }

    applyProjectPreviewAccessToken(urlPath = '', token = '') {
        if (typeof window.artifactManager?.applyPreviewAccessToken === 'function') {
            return window.artifactManager.applyPreviewAccessToken(urlPath, token);
        }

        const accessToken = String(token || '').trim();
        const absoluteUrl = this.resolveProjectApiUrl(urlPath);
        if (!accessToken) {
            return absoluteUrl;
        }

        try {
            const parsed = new URL(absoluteUrl, window.location.href);
            if (/\/api\/artifacts\/[^/]+\/sandbox(?:\/)?$/i.test(parsed.pathname)) {
                parsed.pathname = parsed.pathname.replace(/\/sandbox\/?$/i, `/sandbox-access/${encodeURIComponent(accessToken)}`);
                return parsed.toString();
            }
            if (/\/api\/artifacts\/[^/]+\/preview(?:\/)?$/i.test(parsed.pathname)) {
                parsed.pathname = parsed.pathname.replace(/\/preview\/?$/i, `/preview-access/${encodeURIComponent(accessToken)}/`);
                return parsed.toString();
            }
            if (/\/api\/sandbox-workspaces\/[^/]+\/sandbox(?:\/)?$/i.test(parsed.pathname)) {
                parsed.pathname = parsed.pathname.replace(/\/sandbox\/?$/i, `/sandbox-access/${encodeURIComponent(accessToken)}`);
                return parsed.toString();
            }
            if (/\/api\/sandbox-workspaces\/[^/]+\/preview(?:\/)?$/i.test(parsed.pathname)) {
                parsed.pathname = parsed.pathname.replace(/\/preview\/?$/i, `/preview-access/${encodeURIComponent(accessToken)}/`);
                return parsed.toString();
            }
            if ((parsed.pathname.startsWith('/api/artifacts/') || parsed.pathname.startsWith('/api/sandbox-workspaces/')) && !parsed.searchParams.has('access_token')) {
                parsed.searchParams.set('access_token', accessToken);
            }
            return parsed.toString();
        } catch (_error) {
            const separator = absoluteUrl.includes('?') ? '&' : '?';
            return `${absoluteUrl}${separator}access_token=${encodeURIComponent(accessToken)}`;
        }
    }

    async resolveProjectViewportUrl(project = {}) {
        const url = this.buildProjectViewportUrl(project);
        if (!url) {
            return '';
        }
        if (typeof window.artifactManager?.getAuthenticatedPreviewUrl === 'function' && this.isProjectPreviewAuthRoute(url)) {
            return window.artifactManager.getAuthenticatedPreviewUrl(url);
        }
        if (!this.isProjectPreviewAuthRoute(url)) {
            return this.resolveProjectApiUrl(url);
        }

        const token = await this.getProjectPreviewAccessToken();
        return this.applyProjectPreviewAccessToken(url, token);
    }

    getCurrentProjectViewportState() {
        const sessionId = String(sessionManager.currentSessionId || '').trim();
        const project = this.getSessionProjectForViewport(sessionId);
        if (!project) {
            return {
                sessionId,
                project: null,
                url: '',
                size: 'wide',
            };
        }

        return {
            sessionId,
            project,
            url: this.buildProjectViewportUrl(project),
            size: this.normalizeProjectViewportSize(project.viewportSize || project.projectViewportSize || 'wide'),
        };
    }

    renderProjectViewport() {
        if (!this.projectViewport) {
            return;
        }

        const appShell = document.getElementById('app');
        const { project, url: rawUrl, size } = this.getCurrentProjectViewportState();
        const hasProject = Boolean(project);
        const hasUrl = Boolean(rawUrl);
        const isMinimalLayout = typeof uiHelpers !== 'undefined' && typeof uiHelpers?.isMinimalistMode === 'function'
            ? uiHelpers.isMinimalistMode()
            : false;
        const isCollapsed = hasProject && size === 'collapsed';
        const isSuspended = !hasProject || isMinimalLayout || isCollapsed || !hasUrl;
        const hasVisibleViewport = hasProject && !isMinimalLayout;
        this.projectViewport.classList.toggle('hidden', !hasVisibleViewport);
        this.projectViewport.classList.toggle('is-empty', hasProject && !hasUrl);
        this.projectViewport.classList.toggle('is-collapsed', isCollapsed);
        this.projectViewport.classList.toggle('is-suspended', hasProject && isSuspended);
        this.projectViewport.classList.toggle('is-compact', hasProject && size === 'compact');
        this.projectViewport.classList.toggle('is-wide', hasProject && size === 'wide');
        this.projectViewport.classList.toggle('is-full', hasProject && size === 'full');
        this.projectViewport.setAttribute('aria-hidden', hasVisibleViewport ? 'false' : 'true');
        appShell?.classList.toggle('has-project-viewport', hasVisibleViewport);
        appShell?.classList.toggle('has-project-viewport-collapsed', hasVisibleViewport && isCollapsed);

        if (!hasProject) {
            if (this.projectViewportFrame) {
                this.projectViewportFrame.dataset.rawProjectUrl = '';
                this.projectViewportFrame.dataset.rawProjectUrlKey = '';
                this.projectViewportFrame.dataset.projectUrl = '';
                this.projectViewportFrame.dataset.suspendedProjectUrl = '';
                this.projectViewportFrame.removeAttribute('src');
            }
            this.setProjectViewportFrameState('idle');
            return;
        }

        const isManagedAppProject = String(project?.type || '').trim().toLowerCase() === 'managed-app';
        const title = String(project?.title || project?.appName || project?.appSlug || 'Live project').trim();
        const hostLabel = this.normalizeProjectHost(hasUrl
            ? (project?.livePublicHost || rawUrl || project?.publicHost || '')
            : (isManagedAppProject ? '' : (project?.publicHost || rawUrl || '')));
        if (this.projectViewportLabel) {
            this.projectViewportLabel.textContent = title;
        }
        if (this.projectViewportLink) {
            this.projectViewportLink.textContent = hostLabel || (isManagedAppProject ? 'Waiting for deployed site' : 'Waiting for public route');
            if (hasUrl) {
                this.projectViewportLink.href = this.resolveProjectApiUrl(rawUrl);
                this.projectViewportLink.removeAttribute('aria-disabled');
            } else {
                this.projectViewportLink.href = '#';
                this.projectViewportLink.setAttribute('aria-disabled', 'true');
            }
        }
        if (this.projectViewportFrame && isSuspended) {
            this.projectViewportFrame.dataset.rawProjectUrl = '';
            this.projectViewportFrame.dataset.rawProjectUrlKey = '';
            this.projectViewportFrame.dataset.suspendedProjectUrl = hasUrl ? rawUrl : '';
            this.projectViewportFrame.dataset.projectUrl = '';
            this.projectViewportFrame.removeAttribute('src');
            this.setProjectViewportFrameState(
                hasUrl ? 'suspended' : 'empty',
                !hasUrl && isManagedAppProject ? 'Waiting for deployment' : '',
                !hasUrl && isManagedAppProject
                    ? 'GitLab and k3s progress stay in the status card; the website preview appears after public verification.'
                    : '',
            );
        } else if (this.projectViewportFrame && hasUrl && this.projectViewportFrame.dataset.rawProjectUrlKey !== this.buildProjectViewportUrlKey(rawUrl)) {
            const rawUrlKey = this.buildProjectViewportUrlKey(rawUrl);
            this.projectViewportFrame.dataset.rawProjectUrl = rawUrl;
            this.projectViewportFrame.dataset.rawProjectUrlKey = rawUrlKey;
            this.projectViewportFrame.dataset.projectUrl = '';
            this.projectViewportFrame.dataset.suspendedProjectUrl = '';
            this.projectViewportFrame.removeAttribute('src');
            this.setProjectViewportFrameState('loading');
            const requestId = ++this.projectViewportRequestId;
            this.resolveProjectViewportUrl(project)
                .then((resolvedUrl) => {
                    if (requestId !== this.projectViewportRequestId || !this.projectViewportFrame) {
                        return;
                    }
                    if (!resolvedUrl) {
                        this.setProjectViewportFrameState('empty');
                        return;
                    }
                    if (this.buildProjectViewportUrlKey(this.projectViewportFrame.dataset.projectUrl || '') === this.buildProjectViewportUrlKey(resolvedUrl)) {
                        return;
                    }
                    this.projectViewportFrame.dataset.projectUrl = resolvedUrl;
                    this.projectViewportFrame.src = resolvedUrl;
                })
                .catch((error) => {
                    if (requestId !== this.projectViewportRequestId) {
                        return;
                    }
                    this.setProjectViewportFrameState(
                        'error',
                        'Project preview authentication failed.',
                        error?.message || 'Open the project in a new tab or sign in again.',
                    );
                });
        }

        this.projectViewport
            .querySelectorAll('[data-project-viewport-size]')
            .forEach((button) => {
                const isActive = button.dataset.projectViewportSize === size;
                button.classList.toggle('is-active', isActive);
                button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
                if (button.dataset.projectViewportSize === 'collapsed') {
                    button.setAttribute('aria-label', size === 'collapsed' ? 'Expand project viewport' : 'Collapse project viewport');
                    button.setAttribute('title', size === 'collapsed' ? 'Expand' : 'Collapse');
                }
            });
        uiHelpers.reinitializeIcons(this.projectViewport);
    }

    setProjectViewportFrameState(state = 'idle', label = '', detail = '') {
        if (!this.projectViewport) {
            return;
        }

        const normalized = String(state || 'idle').trim().toLowerCase();
        ['idle', 'loading', 'ready', 'error', 'empty', 'suspended'].forEach((entry) => {
            this.projectViewport.classList.toggle(`is-${entry}`, entry === normalized);
        });

        const copy = {
            loading: {
                label: 'Loading project preview',
                detail: 'Preparing authenticated access...',
            },
            error: {
                label: 'Project preview unavailable',
                detail: 'Authentication or routing blocked the embedded preview.',
            },
            empty: {
                label: 'Waiting for a project URL',
                detail: 'The build is tracked, but no public or sandbox preview URL is available yet.',
            },
            suspended: {
                label: 'Preview paused',
                detail: 'Expand the project viewport to load it.',
            },
            ready: {
                label: '',
                detail: '',
            },
            idle: {
                label: '',
                detail: '',
            },
        }[normalized] || {};

        if (this.projectViewportStateLabel) {
            this.projectViewportStateLabel.textContent = label || copy.label || '';
        }
        if (this.projectViewportStateDetail) {
            this.projectViewportStateDetail.textContent = detail || copy.detail || '';
        }
    }

    handleProjectViewportAction(action = '') {
        const normalizedAction = String(action || '').trim().toLowerCase();
        const currentUrl = this.projectViewportFrame?.dataset.projectUrl
            || this.projectViewportFrame?.dataset.suspendedProjectUrl
            || this.buildProjectViewportUrl(this.getCurrentProjectViewportState().project || {});
        if (!currentUrl) {
            this.setProjectViewportFrameState('empty');
            return;
        }

        if (normalizedAction === 'open') {
            window.open(this.resolveProjectApiUrl(currentUrl), '_blank', 'noopener');
            return;
        }

        if (normalizedAction === 'reload') {
            this.projectViewportFrame.dataset.rawProjectUrl = '';
            this.projectViewportFrame.dataset.rawProjectUrlKey = '';
            this.renderProjectViewport();
        }
    }

    async setProjectViewportSize(size = '') {
        let normalizedSize = this.normalizeProjectViewportSize(size);
        const sessionId = String(sessionManager.currentSessionId || '').trim();
        const project = this.getSessionProjectForViewport(sessionId);
        if (!sessionId || !project) {
            return;
        }
        const currentSize = this.normalizeProjectViewportSize(project.viewportSize || project.projectViewportSize || 'wide');
        if (normalizedSize === 'collapsed' && currentSize === 'collapsed') {
            const restoredSize = this.normalizeProjectViewportSize(project.previousViewportSize || project.previousProjectViewportSize || 'wide');
            normalizedSize = restoredSize === 'collapsed' ? 'wide' : restoredSize;
        }

        const activeProject = {
            ...project,
            previousViewportSize: normalizedSize === 'collapsed' ? currentSize : project.previousViewportSize,
            previousProjectViewportSize: normalizedSize === 'collapsed' ? currentSize : project.previousProjectViewportSize,
            viewportSize: normalizedSize,
            projectViewportSize: normalizedSize,
        };
        sessionManager.mergeSessionMetadataLocally(sessionId, { activeProject });
        this.renderProjectViewport();
        await sessionManager.persistSessionMetadata(sessionId, { activeProject });
    }

    getManagedAppMessageMeta(message = null) {
        const metadata = message?.metadata && typeof message.metadata === 'object'
            ? message.metadata
            : {};
        const appId = String(metadata.managedAppId || message?.managedAppId || '').trim();
        const appSlug = String(metadata.managedAppSlug || message?.managedAppSlug || '').trim();
        const publicHost = String(metadata.publicHost || message?.publicHost || '').trim();
        const phase = this.normalizeManagedAppPhase(metadata.managedAppPhase || message?.managedAppPhase || '');

        return {
            appId,
            appSlug,
            publicHost,
            phase,
            key: this.buildManagedAppProgressKey({
                managedAppId: appId,
                managedAppSlug: appSlug,
            }),
        };
    }

    getMessageSurveyDefinition(message = null) {
        const embeddedSurvey = uiHelpers.normalizeSurveyDefinition(
            message?.managedAppCheckpoint
            || message?.metadata?.managedAppCheckpoint
            || null,
        );
        if (embeddedSurvey) {
            return embeddedSurvey;
        }

        return this.extractSurveyDefinition(
            message?.displayContent ?? message?.content ?? '',
            message?.id || '',
        );
    }

    findLatestSurveyMessageEntry(sessionId = '', checkpointId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return null;
        }

        const normalizedCheckpointId = String(checkpointId || '').trim();
        const messages = sessionManager.getMessages(normalizedSessionId);

        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (message?.role !== 'assistant') {
                continue;
            }

            const survey = this.getMessageSurveyDefinition(message);
            if (!survey?.id) {
                continue;
            }
            if (normalizedCheckpointId && survey.id !== normalizedCheckpointId) {
                continue;
            }

            return { message, survey };
        }

        return null;
    }

    getManagedAppCheckpointState(sessionId = '', project = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return {
                checkpoint: null,
                surveyState: null,
                pending: false,
            };
        }

        const session = this.getSessionRecord(normalizedSessionId);
        const pendingCheckpoint = uiHelpers.normalizeSurveyDefinition(
            session?.controlState?.userCheckpoint?.pending || null,
        );
        const lastResponse = session?.controlState?.userCheckpoint?.lastResponse
            && typeof session.controlState.userCheckpoint.lastResponse === 'object'
            ? session.controlState.userCheckpoint.lastResponse
            : null;
        const preferredCheckpointId = String(
            pendingCheckpoint?.id
            || lastResponse?.checkpointId
            || '',
        ).trim();
        const matchedEntry = this.findLatestSurveyMessageEntry(normalizedSessionId, preferredCheckpointId)
            || this.findLatestSurveyMessageEntry(normalizedSessionId, '');
        const checkpoint = matchedEntry?.survey || pendingCheckpoint || null;

        if (!checkpoint?.id) {
            return {
                checkpoint: null,
                surveyState: null,
                pending: false,
            };
        }

        let surveyState = matchedEntry?.message?.surveyState?.checkpointId === checkpoint.id
            ? { ...matchedEntry.message.surveyState }
            : null;

        if (!surveyState && String(lastResponse?.checkpointId || '').trim() === checkpoint.id) {
            surveyState = {
                status: 'answered',
                checkpointId: checkpoint.id,
                summary: String(lastResponse?.summary || '').trim(),
            };
        }

        return {
            checkpoint,
            surveyState,
            pending: Boolean(pendingCheckpoint?.id && pendingCheckpoint.id === checkpoint.id),
        };
    }

    resolveSessionManagedAppIdentity(sessionId = '') {
        const activeProject = this.getSessionActiveProject(sessionId);
        const appId = String(activeProject?.appId || '').trim();
        const appSlug = String(activeProject?.appSlug || '').trim();
        if (appId || appSlug) {
            return {
                appRef: appId || appSlug,
                appId,
                appSlug,
                activeProject,
            };
        }

        const messages = sessionManager.getMessages(sessionId);
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const meta = this.getManagedAppMessageMeta(messages[index]);
            if (meta.appId || meta.appSlug) {
                return {
                    appRef: meta.appId || meta.appSlug,
                    appId: meta.appId,
                    appSlug: meta.appSlug,
                    activeProject: null,
                };
            }
        }

        return null;
    }

    async refreshManagedAppProgressForSession(sessionId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId || window.sessionManager?.isLocalSession?.(normalizedSessionId)) {
            return null;
        }

        const identity = this.resolveSessionManagedAppIdentity(normalizedSessionId);
        if (!identity?.appRef) {
            return null;
        }

        try {
            const result = await apiClient.getManagedAppProgress(identity.appRef);
            const project = result?.project;
            if (!project || typeof project !== 'object') {
                return null;
            }

            const mergedProject = {
                ...(identity.activeProject || {}),
                ...project,
                appId: String(project?.appId || identity.appId || '').trim(),
                appSlug: String(project?.appSlug || identity.appSlug || '').trim(),
                progress: this.resolveManagedAppProgressState(
                    result?.progress || project?.progress || null,
                    {
                        phase: project?.phase || project?.status || '',
                        summary: project?.summary || result?.summary || '',
                        app: {
                            id: String(project?.appId || identity.appId || '').trim(),
                            slug: String(project?.appSlug || identity.appSlug || '').trim(),
                            appName: String(project?.title || '').trim(),
                            publicHost: String(project?.publicHost || '').trim(),
                        },
                    },
                ),
            };

            sessionManager.mergeSessionMetadataLocally(normalizedSessionId, {
                activeProject: mergedProject,
                title: String(mergedProject.title || '').trim(),
            });
            return mergedProject;
        } catch (error) {
            console.warn('Failed to refresh managed app progress:', error);
            return null;
        }
    }

    buildManagedProjectSummaryMessage(sessionId = '', project = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        const appId = String(project?.appId || '').trim();
        const appSlug = String(project?.appSlug || '').trim();
        const publicHost = String(project?.publicHost || '').trim();
        const phase = this.normalizeManagedAppPhase(project?.phase || project?.status || '');
        const summary = String(project?.summary || '').trim()
            || this.buildManagedAppProgressDetail({
                phase,
                app: {
                    id: appId,
                    slug: appSlug,
                    appName: String(project?.title || '').trim(),
                    publicHost,
                },
            });
        const progressState = this.resolveManagedAppProgressState(
            project?.progress || project?.managedAppProgressState || null,
            {
                phase,
                summary,
                app: {
                    id: appId,
                    slug: appSlug,
                    appName: String(project?.title || '').trim(),
                    publicHost,
                },
            },
        );
        const checkpointState = this.getManagedAppCheckpointState(normalizedSessionId, project);

        if (!normalizedSessionId || !summary || (!appId && !appSlug)) {
            return null;
        }

        return {
            id: `managed-project:${appId || appSlug}`,
            role: 'assistant',
            content: summary,
            timestamp: String(project?.updatedAt || project?.lastActivityAt || new Date().toISOString()).trim() || new Date().toISOString(),
            clientOnly: true,
            metadata: {
                managedAppProjectSummary: true,
                managedAppId: appId,
                managedAppSlug: appSlug,
                managedAppPhase: phase,
                publicHost,
                managedAppProgressState: progressState,
                managedAppProjectKey: String(project?.key || '').trim() || this.buildManagedAppProgressKey({
                    managedAppId: appId,
                    managedAppSlug: appSlug,
                }),
                nextStep: String(project?.nextStep || '').trim(),
                openItems: Array.isArray(project?.openItems) ? project.openItems : [],
                managedAppCheckpoint: checkpointState.checkpoint,
                managedAppCheckpointPending: checkpointState.pending === true,
            },
            managedAppProgressState: progressState,
            surveyState: checkpointState.surveyState,
            managedAppCheckpoint: checkpointState.checkpoint,
        };
    }

    injectSessionProjectMessages(sessionId, messages = []) {
        let normalizedMessages = (Array.isArray(messages) ? messages : [])
            .filter((message) => message?.metadata?.managedAppProjectSummary !== true);
        const activeProject = this.getSessionActiveProject(sessionId);
        if (!activeProject) {
            return normalizedMessages;
        }

        const summaryMessage = this.buildManagedProjectSummaryMessage(sessionId, activeProject);
        if (!summaryMessage) {
            return normalizedMessages;
        }

        const activeProjectKey = String(summaryMessage?.metadata?.managedAppProjectKey || '').trim();
        const embeddedCheckpointId = String(summaryMessage?.managedAppCheckpoint?.id || '').trim();
        normalizedMessages = normalizedMessages.filter((message) => {
            if (message?.role === 'assistant' && message?.metadata?.managedAppLifecycle === true) {
                const meta = this.getManagedAppMessageMeta(message);
                return !activeProjectKey || meta.key !== activeProjectKey;
            }

            const survey = this.getMessageSurveyDefinition(message);
            if (!embeddedCheckpointId || !survey?.id) {
                return true;
            }

            return survey.id !== embeddedCheckpointId;
        });

        return [summaryMessage, ...normalizedMessages];
    }

    isManagedAppTerminalPhase(phase = '') {
        return [
            'live',
            'build_failed',
            'deploy_failed',
        ].includes(this.normalizeManagedAppPhase(phase));
    }

    buildManagedAppEventMessageId(event = {}) {
        return this.buildManagedAppProgressKey(event);
    }

    buildManagedAppProgressDetail(event = {}) {
        const phase = this.normalizeManagedAppPhase(event?.phase);
        const appName = String(event?.app?.appName || event?.app?.slug || 'Managed app').trim();
        const publicHost = String(event?.app?.publicHost || '').trim();
        const publicUrl = publicHost ? `https://${publicHost}` : '';

        switch (phase) {
            case 'created':
            case 'updated':
                return `${appName} is queued for build${publicUrl ? ` and launch at ${publicUrl}` : ''}.`;
            case 'built':
                return `${appName} finished building. Waiting for deployment to start.`;
            case 'deploying':
                return `${appName} is deploying${publicUrl ? ` to ${publicUrl}` : ''}.`;
            case 'tls_ready':
                return `${appName} has a certificate${publicUrl ? ` for ${publicUrl}` : ''}. Waiting for the public endpoint.`;
            case 'pending_https':
                return `${appName} rollout finished, but the public endpoint is still warming up.`;
            case 'live':
                return `${appName} is live${publicUrl ? ` at ${publicUrl}` : ''}.`;
            case 'build_failed':
                return `${appName} build failed.`;
            case 'deploy_failed':
                return `${appName} deployment failed.`;
            default:
                return `${appName} is updating.`;
        }
    }

    buildManagedAppProgressText(progressState = {}) {
        const steps = Array.isArray(progressState.steps) ? progressState.steps.slice(-4) : [];
        return steps.map((step) => {
            const phase = this.normalizeManagedAppPhase(step?.phase);
            let prefix = '[now]';
            if (['created', 'updated', 'built', 'live', 'tls_ready'].includes(phase)) {
                prefix = '[done]';
            } else if (phase === 'pending_https') {
                prefix = '[wait]';
            } else if (['build_failed', 'deploy_failed'].includes(phase)) {
                prefix = '[fail]';
            }

            const summary = extractChatDisplayText(step?.summary);
            return summary ? `${prefix} ${summary}` : '';
        }).filter(Boolean).join('\n');
    }

    buildManagedAppProgressState(event = {}) {
        const phase = this.normalizeManagedAppPhase(event?.phase);
        const summary = extractChatDisplayText(event?.summary, { maxLength: 180 }) || 'Managed app status updated.';
        const detail = this.buildManagedAppProgressDetail(event);
        const terminal = this.isManagedAppTerminalPhase(phase);
        const steps = [
            { id: 'prepare', title: 'Prepare app record', status: 'pending' },
            { id: 'build', title: 'Build and publish image', status: 'pending' },
            { id: 'deploy', title: 'Roll out deployment', status: 'pending' },
            { id: 'verify', title: 'Verify public endpoint', status: 'pending' },
        ];

        const mark = (stepId, status) => {
            const step = steps.find((entry) => entry.id === stepId);
            if (step) {
                step.status = status;
            }
        };

        switch (phase) {
            case 'created':
            case 'updated':
                mark('prepare', 'completed');
                mark('build', 'in_progress');
                break;
            case 'built':
                mark('prepare', 'completed');
                mark('build', 'completed');
                mark('deploy', 'pending');
                break;
            case 'deploying':
                mark('prepare', 'completed');
                mark('build', 'completed');
                mark('deploy', 'in_progress');
                break;
            case 'tls_ready':
            case 'pending_https':
                mark('prepare', 'completed');
                mark('build', 'completed');
                mark('deploy', 'completed');
                mark('verify', 'in_progress');
                break;
            case 'live':
                steps.forEach((step) => {
                    step.status = 'completed';
                });
                break;
            case 'build_failed':
                mark('prepare', 'completed');
                mark('build', 'failed');
                mark('deploy', 'skipped');
                mark('verify', 'skipped');
                break;
            case 'deploy_failed':
                mark('prepare', 'completed');
                mark('build', 'completed');
                mark('deploy', 'failed');
                mark('verify', 'skipped');
                break;
            default:
                mark('prepare', 'in_progress');
                break;
        }

        return {
            phase,
            summary,
            detail,
            estimated: false,
            live: !terminal,
            terminal,
            totalSteps: steps.length,
            completedSteps: steps.filter((step) => ['completed', 'skipped'].includes(step.status)).length,
            steps,
        };
    }

    resolveManagedAppProgressState(rawProgress = null, fallbackEvent = {}) {
        if (rawProgress && typeof rawProgress === 'object') {
            return { ...rawProgress };
        }

        return this.buildManagedAppProgressState(fallbackEvent);
    }

    buildManagedAppProgressStateFromMessage(message = null) {
        const rawProgress = message?.managedAppProgressState
            || message?.metadata?.managedAppProgressState
            || null;
        if (rawProgress && typeof rawProgress === 'object') {
            return { ...rawProgress };
        }

        const meta = this.getManagedAppMessageMeta(message);
        return this.buildManagedAppProgressState({
            phase: meta.phase,
            summary: extractChatDisplayText(message?.content),
            app: {
                id: meta.appId,
                slug: meta.appSlug,
                publicHost: meta.publicHost,
            },
        });
    }

    findManagedAppHostMessage(sessionId, progressKey = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        const normalizedKey = String(progressKey || '').trim();
        if (!normalizedSessionId || !normalizedKey) {
            return null;
        }

        const mappedMessageId = String(this.managedAppHostMessageByKey.get(normalizedKey) || '').trim();
        if (mappedMessageId) {
            const mappedMessage = this.getSessionMessage(normalizedSessionId, mappedMessageId);
            if (mappedMessage) {
                return mappedMessage;
            }
            this.managedAppHostMessageByKey.delete(normalizedKey);
        }

        const messages = sessionManager.getMessages(normalizedSessionId);
        return messages.find((message) => (
            message?.role === 'assistant'
            && message?.metadata?.managedAppHost === true
            && this.getManagedAppMessageMeta(message).key === normalizedKey
        )) || null;
    }

    findManagedAppProjectSummaryMessage(sessionId, progressKey = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        const normalizedKey = String(progressKey || '').trim();
        if (!normalizedSessionId || !normalizedKey) {
            return null;
        }

        const messages = sessionManager.getMessages(normalizedSessionId);
        return messages.find((message) => (
            message?.role === 'assistant'
            && message?.metadata?.managedAppProjectSummary === true
            && this.getManagedAppMessageMeta(message).key === normalizedKey
        )) || null;
    }

    hasManagedAppProgressSurface(sessionId, progressKey = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        const normalizedKey = String(progressKey || '').trim();
        if (!normalizedSessionId || !normalizedKey) {
            return false;
        }

        if (this.findManagedAppHostMessage(normalizedSessionId, normalizedKey)
            || this.findManagedAppProjectSummaryMessage(normalizedSessionId, normalizedKey)) {
            return true;
        }

        const activeProject = this.getSessionActiveProject(normalizedSessionId);
        if (!activeProject) {
            return false;
        }

        const activeProjectKey = String(activeProject.key || '').trim()
            || this.buildManagedAppProgressKey({
                managedAppId: activeProject.appId,
                managedAppSlug: activeProject.appSlug,
            });
        return activeProjectKey === normalizedKey;
    }

    hasManagedAppSurfaceForSession(sessionId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return false;
        }

        if (this.getSessionActiveProject(normalizedSessionId)) {
            return true;
        }

        return sessionManager.getMessages(normalizedSessionId).some((message) => (
            message?.role === 'assistant'
            && (
                message?.metadata?.managedAppLifecycle === true
                || message?.metadata?.managedAppProjectSummary === true
            )
        ));
    }

    resolveManagedAppHostMessageId(sessionId, event = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        const progressKey = this.buildManagedAppProgressKey(event);
        const currentSessionId = String(sessionManager.currentSessionId || '').trim();
        const currentStreamMessageId = String(this.currentStreamingMessageId || '').trim();

        const existingHost = this.findManagedAppHostMessage(normalizedSessionId, progressKey);
        if (existingHost?.id) {
            this.managedAppHostMessageByKey.set(progressKey, existingHost.id);
            return existingHost.id;
        }

        if (normalizedSessionId && currentSessionId === normalizedSessionId && currentStreamMessageId) {
            this.managedAppHostMessageByKey.set(progressKey, currentStreamMessageId);
            return currentStreamMessageId;
        }

        return '';
    }

    rebuildManagedAppHostMessageIndex(messages = []) {
        this.managedAppHostMessageByKey.clear();
        (Array.isArray(messages) ? messages : []).forEach((message) => {
            if (message?.role !== 'assistant' || message?.metadata?.managedAppHost !== true) {
                return;
            }

            const meta = this.getManagedAppMessageMeta(message);
            if (meta.key && message.id) {
                this.managedAppHostMessageByKey.set(meta.key, message.id);
            }
        });
    }

    normalizeManagedAppLifecycleMessages(messages = []) {
        const sourceMessages = Array.isArray(messages) ? messages : [];
        if (sourceMessages.length === 0) {
            this.rebuildManagedAppHostMessageIndex([]);
            return [];
        }

        const hostedKeys = new Set(sourceMessages
            .filter((message) => message?.role === 'assistant' && message?.metadata?.managedAppHost === true)
            .map((message) => this.getManagedAppMessageMeta(message).key)
            .filter(Boolean));
        const lifecycleGroups = new Map();

        sourceMessages.forEach((message, index) => {
            if (message?.role !== 'assistant' || message?.metadata?.managedAppLifecycle !== true) {
                return;
            }

            const meta = this.getManagedAppMessageMeta(message);
            if (!meta.key) {
                return;
            }

            const group = lifecycleGroups.get(meta.key) || {
                entries: [],
                latestIndex: index,
            };
            group.entries.push(message);
            group.latestIndex = index;
            lifecycleGroups.set(meta.key, group);
        });

        const normalizedMessages = [];
        sourceMessages.forEach((message, index) => {
            if (message?.role === 'assistant' && message?.metadata?.managedAppLifecycle === true) {
                const meta = this.getManagedAppMessageMeta(message);
                const group = lifecycleGroups.get(meta.key);
                if (!group || hostedKeys.has(meta.key) || group.latestIndex !== index) {
                    return;
                }

                const latestMessage = group.entries[group.entries.length - 1];
                const progressState = this.buildManagedAppProgressStateFromMessage(latestMessage);
                normalizedMessages.push({
                    ...latestMessage,
                    ...this.clearLegacyManagedAppReasoningDisplay(latestMessage),
                    id: meta.key,
                    content: '',
                    displayContent: '',
                    isStreaming: progressState.terminal !== true,
                    managedAppProgressState: progressState,
                    metadata: {
                        ...(latestMessage.metadata || {}),
                        managedAppProgressState: progressState,
                    },
                });
                return;
            }

            normalizedMessages.push(message);
        });

        this.rebuildManagedAppHostMessageIndex(normalizedMessages);
        return normalizedMessages;
    }

    getManagedAppProgressVisuals(phase = '') {
        const normalizedPhase = this.normalizeManagedAppPhase(phase);
        if (['build_failed', 'deploy_failed'].includes(normalizedPhase)) {
            return {
                title: 'Build status',
                icon: 'triangle-alert',
                source: 'final',
            };
        }

        if (normalizedPhase === 'live') {
            return {
                title: 'Build status',
                icon: 'badge-check',
                source: 'final',
            };
        }

        return {
            title: 'Build progress',
            icon: 'activity',
            source: 'stream',
        };
    }

    isLegacyManagedAppReasoningDisplay(message = null) {
        const title = String(message?.reasoningDisplayTitle || '').trim().toLowerCase();
        const icon = String(message?.reasoningDisplayIcon || '').trim().toLowerCase();
        const source = String(message?.reasoningDisplaySource || '').trim().toLowerCase();

        if (!title && !icon) {
            return false;
        }

        const looksLikeBuildProgress = title === 'build progress'
            || title === 'build status'
            || ['activity', 'badge-check', 'triangle-alert'].includes(icon);

        return looksLikeBuildProgress && ['stream', 'final'].includes(source);
    }

    clearLegacyManagedAppReasoningDisplay(message = null) {
        if (!this.isLegacyManagedAppReasoningDisplay(message)) {
            return {};
        }

        return {
            reasoningDisplaySource: '',
            reasoningDisplayText: '',
            reasoningDisplayFullText: '',
            reasoningDisplayTitle: '',
            reasoningDisplayIcon: '',
            reasoningDisplayAnimated: false,
        };
    }

    normalizeManagedAppProgressEventFromToolEvent(toolEvent = null, options = {}) {
        if (!toolEvent || typeof toolEvent !== 'object') {
            return null;
        }

        const toolId = String(
            toolEvent?.toolCall?.function?.name
            || toolEvent?.result?.toolId
            || toolEvent?.toolId
            || toolEvent?.toolName
            || '',
        ).trim();
        if (toolId !== 'managed-app') {
            return null;
        }

        const result = toolEvent.result && typeof toolEvent.result === 'object'
            ? toolEvent.result
            : {};
        const data = result.data && typeof result.data === 'object'
            ? result.data
            : (toolEvent.data && typeof toolEvent.data === 'object' ? toolEvent.data : {});
        const args = this.parseToolArguments(toolEvent?.toolCall?.function?.arguments || '{}');
        const project = data.project && typeof data.project === 'object' ? data.project : {};
        const rawProgress = data.progress && typeof data.progress === 'object'
            ? data.progress
            : (data.progressState && typeof data.progressState === 'object'
                ? data.progressState
                : (project.progress && typeof project.progress === 'object' ? project.progress : null));
        const progressState = rawProgress && Array.isArray(rawProgress.steps) && rawProgress.steps.length > 0
            ? rawProgress
            : null;
        const phase = this.normalizeManagedAppPhase(
            progressState?.phase
            || project.phase
            || project.status
            || data.iteration?.stage
            || data.app?.status
            || (result.success === false ? 'deploy_failed' : ''),
        );
        const summary = extractChatDisplayText(
            data.message
            || data.summary
            || project.summary
            || progressState?.summary
            || result.error
            || '',
            { maxLength: 180 },
        );
        if (!summary) {
            return null;
        }

        const fallbackRef = String(args.appRef || args.ref || args.id || args.slug || '').trim();
        const appId = String(data.app?.id || project.appId || project.managedAppId || fallbackRef || '').trim();
        const appSlug = String(data.app?.slug || project.appSlug || project.managedAppSlug || args.slug || fallbackRef || '').trim();
        const livePublicUrl = String(
            project.livePublicUrl
            || project.deployedUrl
            || data.iteration?.evidence?.livePublicUrl
            || data.iteration?.evidence?.publicUrl
            || data.publicUrl
            || data.public_url
            || '',
        ).trim();
        const livePublicHost = this.normalizeProjectHost(
            project.livePublicHost
            || project.deployedHost
            || data.iteration?.evidence?.livePublicHost
            || livePublicUrl
            || '',
        );
        const publicHost = this.normalizeProjectHost(
            data.app?.publicHost
            || project.publicHost
            || project.targetPublicHost
            || data.iteration?.evidence?.targetPublicHost
            || data.publicHost
            || '',
        );

        return {
            type: 'managed-app',
            sessionId: data.app?.sessionId || project.sessionId || options.sessionId || toolEvent.sessionId || '',
            phase,
            summary,
            timestamp: result.timestamp || toolEvent.timestamp || new Date().toISOString(),
            app: {
                ...(data.app && typeof data.app === 'object' ? data.app : {}),
                id: appId || appSlug,
                slug: appSlug || appId,
                appName: String(data.app?.appName || project.title || appSlug || appId || 'Managed app').trim(),
                sessionId: data.app?.sessionId || project.sessionId || options.sessionId || toolEvent.sessionId || '',
                publicHost,
                publicUrl: publicHost ? `https://${publicHost}` : '',
                livePublicHost,
                livePublicUrl,
            },
            buildRun: data.buildRun || null,
            progressState,
        };
    }

    applyManagedAppProgressFromToolEvent(toolEvent = null, options = {}) {
        const normalizedSessionId = String(options.sessionId || sessionManager.currentSessionId || '').trim();
        const event = this.normalizeManagedAppProgressEventFromToolEvent(toolEvent, {
            ...options,
            sessionId: normalizedSessionId,
        });
        if (!event) {
            return null;
        }

        return this.applyManagedAppProgressEvent(event.sessionId || normalizedSessionId, event);
    }

    applyManagedAppProgressFromToolEvents(toolEvents = [], options = {}) {
        if (!Array.isArray(toolEvents) || toolEvents.length === 0) {
            return 0;
        }

        return toolEvents.reduce((count, toolEvent) => (
            this.applyManagedAppProgressFromToolEvent(toolEvent, options) ? count + 1 : count
        ), 0);
    }

    applyManagedAppProgressEvent(sessionId, event = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return null;
        }

        const summary = extractChatDisplayText(event?.summary, { maxLength: 180 });
        if (!summary) {
            return null;
        }

        const progressKey = this.buildManagedAppProgressKey(event);
        const hostMessageId = this.resolveManagedAppHostMessageId(normalizedSessionId, event);
        const phase = this.normalizeManagedAppPhase(event?.phase);
        const stateKey = progressKey;
        const existingState = this.managedAppProgressByKey.get(stateKey) || {
            steps: [],
        };
        const lastStep = existingState.steps[existingState.steps.length - 1] || null;
        const nextStep = {
            phase,
            summary,
            timestamp: event?.timestamp || new Date().toISOString(),
        };
        const nextSteps = (!lastStep || lastStep.phase !== nextStep.phase || lastStep.summary !== nextStep.summary)
            ? [...existingState.steps, nextStep]
            : existingState.steps;
        const progressState = this.resolveManagedAppProgressState(
            event?.progressState || null,
            event,
        );
        const nextState = {
            ...existingState,
            appId: String(event?.app?.id || event?.app?.slug || '').trim(),
            appSlug: String(event?.app?.slug || '').trim(),
            buildRunId: String(event?.buildRun?.id || '').trim(),
            sessionId: normalizedSessionId,
            phase,
            detail: this.buildManagedAppProgressDetail(event),
            progressState,
            steps: nextSteps.slice(-6),
            terminal: this.isManagedAppTerminalPhase(phase),
        };
        this.managedAppProgressByKey.set(stateKey, nextState);

        let nextMessage = null;
        if (hostMessageId) {
            const existingMessage = this.getSessionMessage(normalizedSessionId, hostMessageId) || {};
            nextMessage = this.upsertSessionMessage(normalizedSessionId, {
                ...existingMessage,
                ...this.clearLegacyManagedAppReasoningDisplay(existingMessage),
                id: hostMessageId,
                role: 'assistant',
                content: extractChatStreamText(existingMessage.content || ''),
                displayContent: existingMessage.displayContent,
                isStreaming: nextState.terminal !== true,
                managedAppProgressState: nextState.progressState,
                timestamp: event?.timestamp || existingMessage.timestamp || new Date().toISOString(),
                metadata: {
                    ...(existingMessage.metadata || {}),
                    managedAppHost: true,
                    managedAppLifecycle: true,
                    managedAppProgressActive: nextState.terminal !== true,
                    managedAppPhase: phase,
                    managedAppId: nextState.appId,
                    managedAppSlug: nextState.appSlug,
                    buildRunId: nextState.buildRunId,
                    publicHost: String(event?.app?.publicHost || existingMessage.metadata?.publicHost || '').trim(),
                    managedAppProgressState: nextState.progressState,
                    nextStep: String(nextState.progressState?.nextStep || '').trim(),
                    openItems: Array.isArray(nextState.progressState?.openItems) ? nextState.progressState.openItems : [],
                },
            });

            if (nextMessage) {
                this.persistSessionMessageIfNeeded(normalizedSessionId, nextMessage);
                if (nextState.terminal) {
                    uiHelpers.markMessageSettled(nextMessage.id);
                }
            }
        }

        const existingProject = this.getSessionActiveProject(normalizedSessionId);
        const projectPublicHost = String(event?.app?.publicHost || existingProject?.targetPublicHost || existingProject?.publicHost || '').trim();
        const targetPublicHost = this.normalizeProjectHost(projectPublicHost);
        const targetPublicUrl = targetPublicHost ? `https://${targetPublicHost}` : '';
        const eventEvidence = event?.progressState?.evidence && typeof event.progressState.evidence === 'object'
            ? event.progressState.evidence
            : {};
        const eventRequiredProof = eventEvidence.requiredProof && typeof eventEvidence.requiredProof === 'object'
            ? eventEvidence.requiredProof
            : {};
        const verifiedEventPublicUrl = eventRequiredProof.publicVerificationObserved === true
            ? String(eventEvidence.publicUrl || '').trim()
            : '';
        const eventLivePublicUrl = String(event?.app?.livePublicUrl || '').trim();
        const eventLivePublicHost = String(event?.app?.livePublicHost || '').trim();
        const publicVerificationObserved = eventRequiredProof.publicVerificationObserved === true
            || Boolean(eventLivePublicUrl || eventLivePublicHost);
        const livePublicUrl = this.buildManagedAppLiveProjectUrl({
            ...(existingProject || {}),
            type: 'managed-app',
            phase,
            status: phase,
            publicHost: targetPublicHost,
            publicUrl: String(event?.app?.publicUrl || existingProject?.publicUrl || '').trim(),
            livePublicHost: String(eventLivePublicHost || existingProject?.livePublicHost || '').trim(),
            livePublicUrl: String(eventLivePublicUrl || verifiedEventPublicUrl || existingProject?.livePublicUrl || '').trim(),
            publicVerificationObserved,
            progress: nextState.progressState,
        });
        const livePublicHost = livePublicUrl ? this.normalizeProjectHost(livePublicUrl) : '';
        const projectState = {
            type: 'managed-app',
            key: progressKey,
            title: String(event?.app?.appName || event?.app?.slug || 'Project').trim(),
            summary,
            phase,
            status: phase,
            appId: nextState.appId,
            appSlug: nextState.appSlug,
            publicHost: targetPublicHost,
            publicUrl: livePublicUrl,
            targetPublicHost,
            targetPublicUrl,
            livePublicHost,
            livePublicUrl,
            publicVerificationObserved,
            nextStep: String(nextState.progressState?.nextStep || '').trim(),
            openItems: Array.isArray(nextState.progressState?.openItems) ? nextState.progressState.openItems : [],
            updatedAt: event?.timestamp || new Date().toISOString(),
            progress: nextState.progressState,
        };
        const projectViewportSize = this.normalizeProjectViewportSize(
            existingProject?.viewportSize
            || existingProject?.projectViewportSize
            || 'wide',
        );
        sessionManager.mergeSessionMetadataLocally(normalizedSessionId, {
            activeProject: {
                ...(existingProject || {}),
                ...projectState,
                viewportSize: projectViewportSize,
                projectViewportSize,
            },
            title: String(projectState.title || '').trim(),
        });
        if (sessionManager.currentSessionId === normalizedSessionId) {
            this.renderProjectViewport();
        }

        const projectSummaryMessage = this.buildManagedProjectSummaryMessage(normalizedSessionId, projectState);
        let renderedMessage = null;
        if (projectSummaryMessage) {
            const savedProjectSummary = this.upsertSessionMessage(normalizedSessionId, projectSummaryMessage);
            const canonicalMessage = nextMessage || savedProjectSummary || projectSummaryMessage;
            if (canonicalMessage) {
                const immediate = nextState.terminal === true
                    || !document.getElementById(String(canonicalMessage.id || '').trim());
                this.scheduleManagedAppProgressRender(normalizedSessionId, canonicalMessage, { immediate });
                renderedMessage = canonicalMessage;
            }
        } else if (nextMessage) {
            const immediate = nextState.terminal === true
                || !document.getElementById(String(nextMessage.id || '').trim());
            this.scheduleManagedAppProgressRender(normalizedSessionId, nextMessage, { immediate });
            renderedMessage = nextMessage;
        }

        return renderedMessage;
    }

    async handleManagedAppEvent(event) {
        const sessionId = event?.app?.sessionId || event?.sessionId || null;
        if (!sessionId) {
            return;
        }

        await this.refreshSessionSummaries();
        const isCurrentSession = sessionManager.currentSessionId === sessionId;
        let renderedMessage = null;

        if (isCurrentSession) {
            const progressKey = this.buildManagedAppProgressKey(event);
            const hasExistingSurface = this.hasManagedAppProgressSurface(sessionId, progressKey);
            const hasLoadedMessages = sessionManager.getMessages(sessionId).length > 0;
            if (!this.currentStreamingMessageId && !hasExistingSurface && !hasLoadedMessages) {
                const previousMessages = [...sessionManager.getMessages(sessionId)];
                await this.loadSessionMessages(sessionId, {
                    notifyNewAssistant: true,
                    previousMessages,
                });
            }
            renderedMessage = this.applyManagedAppProgressEvent(sessionId, event);
        }

        const summary = extractChatDisplayText(event?.summary, { maxLength: 180 });
        if (summary && !isCurrentSession) {
            const toastTitle = String(event?.phase || 'managed-app')
                .trim()
                .replace(/[_-]+/g, ' ');
            const toastTone = ['build_failed', 'deploy_failed'].includes(String(event?.phase || '').trim().toLowerCase())
                ? 'error'
                : 'info';
            uiHelpers.showToast(summary, toastTone, toastTitle || 'managed app');
        } else if (summary && !renderedMessage) {
            const toastTitle = String(event?.phase || 'managed-app')
                .trim()
                .replace(/[_-]+/g, ' ');
            const toastTone = ['build_failed', 'deploy_failed'].includes(String(event?.phase || '').trim().toLowerCase())
                ? 'error'
                : 'info';
            uiHelpers.showToast(summary, toastTone, toastTitle || 'managed app');
        }
    }

    async handleWorkloadEvent(event) {
        const sessionId = event?.sessionId || event?.data?.sessionId || null;
        if (!sessionId) {
            return;
        }

        await this.refreshSessionSummaries();

        if (sessionManager.currentSessionId === sessionId) {
            const previousMessages = [...sessionManager.getMessages(sessionId)];
            if (!this.isSessionProcessing(sessionId)) {
                await this.loadSessionMessages(sessionId, {
                    notifyNewAssistant: true,
                    previousMessages,
                    reconcileVisible: this.hasManagedAppSurfaceForSession(sessionId),
                });
            }
            await this.loadSessionWorkloads(sessionId, { force: true });
        }
    }

    isVoiceInputSupported() {
        return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    }

    getPreferredAudioMimeType() {
        if (typeof window.MediaRecorder?.isTypeSupported !== 'function') {
            return '';
        }

        return [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/mp4',
            'audio/ogg;codecs=opus',
            'audio/ogg',
        ].find((mimeType) => window.MediaRecorder.isTypeSupported(mimeType)) || '';
    }

    getLatestSpeakableAssistantMessage() {
        const sessionId = sessionManager.currentSessionId;
        if (!sessionId) {
            return null;
        }

        const messages = sessionManager.getMessages(sessionId);
        if (!Array.isArray(messages) || messages.length === 0) {
            return null;
        }

        return [...messages]
            .reverse()
            .find((message) => (
                message?.role === 'assistant'
                && message?.isLoading !== true
                && message?.isStreaming !== true
                && Boolean(uiHelpers.buildSpeakableMessageText(message))
            )) || null;
    }

    updateVoiceInputIndicator(text = '', mode = 'idle') {
        if (!this.voiceInputIndicator) {
            return;
        }

        const normalizedText = String(text || '').trim();
        this.voiceInputIndicator.textContent = normalizedText;
        this.voiceInputIndicator.classList.toggle('hidden', !normalizedText);
        this.voiceInputIndicator.classList.toggle('is-recording', mode === 'recording');
    }

    updateAudioControls() {
        const latestAssistantMessage = this.getLatestSpeakableAssistantMessage();
        const speakableText = latestAssistantMessage
            ? uiHelpers.buildSpeakableMessageText(latestAssistantMessage)
            : '';
        const latestMessageId = String(latestAssistantMessage?.id || '').trim();
        const ttsAvailable = uiHelpers.isTtsAvailable();
        const outputLoading = latestMessageId && uiHelpers.ttsManager?.isLoadingMessage?.(latestMessageId) === true;
        const outputPlaying = latestMessageId && uiHelpers.ttsManager?.isPlayingMessage?.(latestMessageId) === true;

        if (this.voiceOutputBtn) {
            const icon = outputLoading ? 'loader-2' : (outputPlaying ? 'square' : 'volume-2');
            const title = !ttsAvailable
                ? `${uiHelpers.getTtsFeatureLabel()} unavailable`
                : (!speakableText
                    ? 'No assistant reply is ready to read aloud yet'
                    : (outputPlaying ? 'Stop reading the latest assistant reply' : 'Read the latest assistant reply aloud'));

            this.voiceOutputBtn.disabled = !ttsAvailable || (!speakableText && !outputPlaying) || outputLoading;
            this.voiceOutputBtn.title = title;
            this.voiceOutputBtn.setAttribute('aria-label', title);
            this.voiceOutputBtn.classList.toggle('is-active', outputPlaying);
            this.voiceOutputBtn.classList.toggle('is-busy', outputLoading);
            this.voiceOutputBtn.innerHTML = `
                <i data-lucide="${icon}" class="w-4 h-4${outputLoading ? ' animate-spin' : ''}" aria-hidden="true"></i>
            `;
            uiHelpers.reinitializeIcons(this.voiceOutputBtn);
        }

        if (this.voiceInputBtn) {
            const mode = String(this.voiceInputState.mode || 'idle').trim();
            const inputSupported = this.isVoiceInputSupported();
            const inputLoading = mode === 'transcribing';
            const inputRecording = mode === 'recording';
            const title = !inputSupported
                ? 'Voice input requires microphone capture support in this browser'
                : (inputLoading
                    ? 'Transcribing your recording'
                    : (inputRecording ? 'Stop voice input' : 'Start voice input'));
            const icon = inputLoading ? 'loader-2' : (inputRecording ? 'square' : 'mic');

            this.voiceInputBtn.disabled = !inputSupported || inputLoading;
            this.voiceInputBtn.title = title;
            this.voiceInputBtn.setAttribute('aria-label', title);
            this.voiceInputBtn.classList.toggle('is-busy', inputLoading);
            this.voiceInputBtn.classList.toggle('is-recording', inputRecording);
            this.voiceInputBtn.innerHTML = `
                <i data-lucide="${icon}" class="w-4 h-4${inputLoading ? ' animate-spin' : ''}" aria-hidden="true"></i>
            `;
            uiHelpers.reinitializeIcons(this.voiceInputBtn);

            if (inputRecording) {
                this.updateVoiceInputIndicator('Listening...', 'recording');
            } else if (inputLoading) {
                this.updateVoiceInputIndicator('Transcribing...', 'transcribing');
            } else {
                this.updateVoiceInputIndicator('', 'idle');
            }
        }
    }

    async toggleLatestAssistantSpeech() {
        const latestAssistantMessage = this.getLatestSpeakableAssistantMessage();
        const speakableText = latestAssistantMessage
            ? uiHelpers.buildSpeakableMessageText(latestAssistantMessage)
            : '';

        if (!speakableText || !latestAssistantMessage?.id) {
            uiHelpers.showToast('There is no completed assistant reply to read aloud yet.', 'info', uiHelpers.getTtsFeatureLabel());
            return;
        }

        try {
            await uiHelpers.ttsManager?.toggleMessagePlayback?.({
                messageId: latestAssistantMessage.id,
                text: speakableText,
            });
        } catch (error) {
            uiHelpers.showToast(error.message || 'Failed to start voice playback.', 'error', uiHelpers.getTtsFeatureLabel());
        } finally {
            this.updateAudioControls();
        }
    }

    async toggleVoiceInput() {
        const mode = String(this.voiceInputState.mode || 'idle').trim();
        if (mode === 'recording') {
            this.stopVoiceRecording();
            return;
        }

        if (mode === 'transcribing') {
            return;
        }

        await this.startVoiceRecording();
    }

    async startVoiceRecording() {
        if (!this.isVoiceInputSupported()) {
            uiHelpers.showToast('Voice input is unavailable in this browser.', 'warning', 'Voice input');
            this.updateAudioControls();
            return;
        }

        try {
            uiHelpers.stopSpeechPlayback();
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });
            const mimeType = this.getPreferredAudioMimeType();
            const recorder = mimeType
                ? new MediaRecorder(stream, { mimeType })
                : new MediaRecorder(stream);

            this.voiceInputState = {
                mode: 'recording',
                recorder,
                stream,
                chunks: [],
            };

            recorder.addEventListener('dataavailable', (event) => {
                if (event.data && event.data.size > 0) {
                    this.voiceInputState.chunks.push(event.data);
                }
            });

            recorder.addEventListener('stop', async () => {
                const recordedChunks = Array.isArray(this.voiceInputState.chunks)
                    ? [...this.voiceInputState.chunks]
                    : [];
                const recordedMimeType = mimeType || recorder.mimeType || 'audio/webm';

                this.teardownVoiceRecordingStream();
                this.voiceInputState = {
                    mode: 'transcribing',
                    recorder: null,
                    stream: null,
                    chunks: [],
                };
                this.updateAudioControls();

                try {
                    const blob = new Blob(recordedChunks, { type: recordedMimeType });
                    if (blob.size === 0) {
                        throw new Error('No audio was captured.');
                    }

                    const extension = recordedMimeType.includes('/')
                        ? (recordedMimeType.split('/')[1].split(';')[0].trim() || 'webm')
                        : 'webm';
                    const result = await apiClient.transcribeAudio(blob, {
                        filename: `voice-note.${extension}`,
                    });
                    const transcript = String(result?.text || '').trim();

                    if (!transcript) {
                        uiHelpers.showToast('No spoken words were detected in that recording.', 'info', 'Voice input');
                    } else {
                        this.insertVoiceTranscript(transcript);
                        uiHelpers.showToast('Voice input added to the composer.', 'success', 'Voice input');
                    }
                } catch (error) {
                    uiHelpers.showToast(error.message || 'Voice transcription failed.', 'error', 'Voice input');
                } finally {
                    this.voiceInputState = {
                        mode: 'idle',
                        recorder: null,
                        stream: null,
                        chunks: [],
                    };
                    this.updateAudioControls();
                }
            });

            recorder.start(250);
            this.updateAudioControls();
        } catch (error) {
            const errorName = String(error?.name || '').trim();
            const message = errorName === 'NotAllowedError'
                ? 'Microphone access was blocked. Allow microphone access for this site and try again.'
                : (errorName === 'NotFoundError'
                    ? 'No microphone was found for voice input.'
                    : (errorName === 'NotReadableError'
                        ? 'The microphone is busy or unavailable right now.'
                        : (error?.message || 'Unable to start voice input.')));
            uiHelpers.showToast(message, 'error', 'Voice input');
            this.teardownVoiceRecordingStream();
            this.voiceInputState = {
                mode: 'idle',
                recorder: null,
                stream: null,
                chunks: [],
            };
            this.updateAudioControls();
        }
    }

    stopVoiceRecording() {
        const recorder = this.voiceInputState.recorder;
        if (!recorder || recorder.state === 'inactive') {
            return;
        }

        if (typeof recorder.requestData === 'function') {
            try {
                recorder.requestData();
            } catch (_error) {
                // Ignore flush errors when the recorder has no buffered audio yet.
            }
        }

        recorder.stop();
        this.updateAudioControls();
    }

    teardownVoiceRecordingStream() {
        const stream = this.voiceInputState.stream;
        if (!stream) {
            return;
        }

        stream.getTracks().forEach((track) => {
            try {
                track.stop();
            } catch (_error) {
                // Ignore media track cleanup errors.
            }
        });
    }

    insertVoiceTranscript(transcript = '') {
        const normalizedTranscript = String(transcript || '').trim();
        if (!normalizedTranscript || !this.messageInput) {
            return;
        }

        const currentValue = String(this.messageInput.value || '');
        const separator = currentValue.trim()
            ? (/\s$/.test(currentValue) ? '' : ' ')
            : '';
        this.messageInput.value = `${currentValue}${separator}${normalizedTranscript}`.trim();
        this.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
        this.messageInput.focus();
    }

    // ============================================
    // Message Handling
    // ============================================

    async sendMessage() {
        const content = this.messageInput.value.trim();
        
        if (!content) return;

        if (this.skillWizardState && !content.startsWith('/')) {
            this.messageInput.value = '';
            this.autoResize?.reset?.();
            this.updateSendButton();
            uiHelpers.updateCharCounter(this.messageInput, this.charCounter);
            await this.handleSkillWizardReply(content);
            return;
        }

        if (await this.tryHandleToolCommand(content)) {
            this.messageInput.value = '';
            this.autoResize?.reset?.();
            this.updateSendButton();
            uiHelpers.updateCharCounter(this.messageInput, this.charCounter);
            return;
        }
        
        // Handle slash commands
        if (content.startsWith('/')) {
            await this.executeSlashCommand(content);
            this.messageInput.value = '';
            this.autoResize?.reset?.();
            this.updateSendButton();
            uiHelpers.updateCharCounter(this.messageInput, this.charCounter);
            return;
        }

        const toolIntentOptions = this.selectedDirectTool
            ? this.buildSelectedDirectToolRequestOptions()
            : this.buildToolIntentRequestOptions();
        const routeSelectedToolAsAsync = this.shouldRouteSelectedToolMessageToAsync(content, toolIntentOptions);
        this.messageInput.value = '';
        this.autoResize?.reset?.();
        this.updateSendButton();
        uiHelpers.updateCharCounter(this.messageInput, this.charCounter);
        this.clearSelectedDirectTool({ quiet: true });

        if (routeSelectedToolAsAsync) {
            await this.sendSelectedToolMessageAsAsync(content, toolIntentOptions);
            return;
        }

        if (this.isCurrentSessionProcessing() || this.getQueuedMessageCount() >= WEB_CHAT_QUEUE_MAX_SIZE) {
            this.enqueueMessage(content, toolIntentOptions);
            return;
        }

        await this.sendPreparedMessage(content, toolIntentOptions);
    }

    async sendPreparedMessage(content, options = {}) {
        const shouldReuseUserMessage = options.reuseUserMessage === true
            && options.userMessage
            && String(options.userMessage.id || '').trim()
            && String(options.userMessage.role || '').trim() === 'user';
        const reuseAssistantMessageId = String(options.reuseAssistantMessageId || '').trim();
        const normalizedContent = String(content || '').trim();
        if (!normalizedContent) {
            return false;
        }

        uiHelpers.stopSpeechPlayback();
        void uiHelpers.ttsManager?.preparePlayback?.({ quiet: true });

        // Check if we need to create a session
        if (!sessionManager.currentSessionId) {
            await this.createNewSession();
        }

        const sessionId = sessionManager.currentSessionId;
        if (this.isSessionProcessing(sessionId)) {
            this.enqueueMessage(normalizedContent, options);
            return false;
        }
        const previousMessages = sessionManager.getMessages(sessionId).slice();
        const existingAssistantMessage = reuseAssistantMessageId
            ? this.getSessionMessage(sessionId, reuseAssistantMessageId)
            : null;
        const shouldReuseAssistantMessage = existingAssistantMessage?.role === 'assistant';
        const selectedArtifactIds = Array.from(new Set([
            ...(Array.isArray(options.artifactIds) ? options.artifactIds : []),
            ...(typeof window.fileManager?.getSelectedArtifactIds === 'function'
                ? window.fileManager.getSelectedArtifactIds()
                : []),
        ].map((artifactId) => String(artifactId || '').trim()).filter(Boolean)));
        const requestMetadata = {
            ...(options.metadata && typeof options.metadata === 'object'
                ? options.metadata
                : {}),
        };
        const inferredBuildRunBrief = shouldReuseUserMessage
            ? (options.userMessage?.metadata?.buildRunBrief || requestMetadata.buildRunBrief || null)
            : (requestMetadata.buildRunBrief || uiHelpers.inferBuildRunBrief?.(normalizedContent, {
                ...options,
                artifactIds: selectedArtifactIds,
                metadata: requestMetadata,
            }) || null);
        if (inferredBuildRunBrief && typeof inferredBuildRunBrief === 'object') {
            requestMetadata.buildRunBrief = inferredBuildRunBrief;
        }
        const selectedToolChip = this.normalizeDirectToolSelection(
            requestMetadata.selectedToolChip || requestMetadata.selectedDirectTool || null,
        );
        const userMessageMetadata = {
            ...(inferredBuildRunBrief ? { buildRunBrief: inferredBuildRunBrief } : {}),
            ...(selectedToolChip ? { selectedToolChip } : {}),
        };

        // Hide welcome message
        uiHelpers.hideWelcomeMessage();

        // Add user message
        const userMessage = shouldReuseUserMessage
            ? options.userMessage
            : {
                role: 'user',
                content: normalizedContent,
                timestamp: new Date().toISOString(),
                ...(Object.keys(userMessageMetadata).length > 0
                    ? { metadata: userMessageMetadata }
                    : {}),
            };
        const storedUserMessage = shouldReuseUserMessage
            ? {
                ...userMessage,
                content: normalizedContent,
                metadata: Object.keys(userMessageMetadata).length > 0
                    ? {
                        ...(userMessage.metadata || {}),
                        ...userMessageMetadata,
                    }
                    : userMessage.metadata,
            }
            : sessionManager.addMessage(sessionId, userMessage);

        if (!shouldReuseUserMessage) {
            const userMessageEl = uiHelpers.renderMessage(storedUserMessage);
            this.messagesContainer.appendChild(userMessageEl);
            uiHelpers.playAcknowledgementCue();
            uiHelpers.scrollToBottom();
        }

        // Show typing indicator
        this.isProcessing = true;
        this.updateSendButton();

        // Get current model
        const model = uiHelpers.getCurrentModel();
        const reasoningEffort = uiHelpers.getCurrentReasoningEffort();

        // Create placeholder for assistant response
        const assistantMessage = {
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            isStreaming: true,
            metadata: {
                foregroundRequestId: '',
                pendingForeground: true,
                isStreaming: true,
            },
            model: model // Track which model generated this response
        };

        let storedAssistantMessage = null;
        if (shouldReuseAssistantMessage) {
            this.currentStreamingMessageId = reuseAssistantMessageId;
            assistantMessage.id = reuseAssistantMessageId;
            assistantMessage.metadata.foregroundRequestId = String(
                existingAssistantMessage?.metadata?.foregroundRequestId
                || reuseAssistantMessageId
            ).trim() || reuseAssistantMessageId;

            storedAssistantMessage = this.upsertSessionMessage(sessionId, {
                ...existingAssistantMessage,
                ...assistantMessage,
                metadata: {
                    ...(existingAssistantMessage?.metadata || {}),
                    ...(assistantMessage.metadata || {}),
                },
            }) || existingAssistantMessage;
            storedAssistantMessage = this.moveSessionMessageToEnd(sessionId, reuseAssistantMessageId) || storedAssistantMessage;

            const assistantMessageEl = this.renderOrReplaceMessage(storedAssistantMessage);
            if (assistantMessageEl) {
                this.messagesContainer.appendChild(assistantMessageEl);
            }
            uiHelpers.scrollToBottom();
        } else {
            this.currentStreamingMessageId = uiHelpers.generateMessageId();
            assistantMessage.id = this.currentStreamingMessageId;
            assistantMessage.metadata.foregroundRequestId = assistantMessage.id;

            storedAssistantMessage = sessionManager.addMessage(sessionId, assistantMessage);
            const assistantMessageEl = uiHelpers.renderMessage(storedAssistantMessage, true);
            this.messagesContainer.appendChild(assistantMessageEl);
            uiHelpers.reinitializeIcons(assistantMessageEl);
            uiHelpers.scrollToBottom();
        }

        this.persistSessionMessagesIfNeeded(sessionId, [
            storedUserMessage,
            storedAssistantMessage,
        ]);
        this.beginAssistantStream({
            messageId: this.currentStreamingMessageId,
            detail: 'Gathering context and preparing the reply.',
        });
        this.trackActiveStreamRequest({
            sessionId,
            requestType: 'chat',
            previousMessages,
            userMessage: storedUserMessage,
            placeholderMessage: storedAssistantMessage,
        });
        this.beginSessionStream(sessionId, {
            activeStreamRequest: this.activeStreamRequest,
            pendingStreamResync: this.pendingStreamResync,
            currentStreamingMessageId: storedAssistantMessage.id,
            liveResponseState: { ...this.liveResponseState },
        });
        
        // Build message history for OpenAI API format
        const messages = this.buildMessageHistory(sessionId);
        
        // Create abort controller for this request
        this.currentAbortController = new AbortController();
        const streamState = this.getSessionStreamState(sessionId);
        if (streamState) {
            streamState.currentAbortController = this.currentAbortController;
        }
        
        // Send to API using OpenAI SDK
        try {
            // Update API client session ID
            apiClient.setSessionId(sessionId);
            
            let hasReceivedContent = false;
            let retryCount = 0;
            let streamFailed = false;
            let receivedTerminalChunk = false;
            let streamSessionId = sessionId;

            // Stream the chat
            for await (const chunk of apiClient.streamChat(
                messages,
                model,
                this.currentAbortController.signal,
                reasoningEffort,
                {
                    sessionId,
                    bindClientSession: false,
                    metadata: {
                        foregroundRequestId: storedAssistantMessage.id,
                        messageId: storedUserMessage.id,
                        assistantMessageId: storedAssistantMessage.id,
                        userMessageTimestamp: storedUserMessage.timestamp,
                        assistantMessageTimestamp: storedAssistantMessage.timestamp,
                        ...requestMetadata,
                    },
                    artifactIds: selectedArtifactIds,
                    ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
                    ...(options.executionProfile ? { executionProfile: options.executionProfile } : {}),
                    shouldResyncAfterDisconnect: (error, context) => this.shouldResyncAfterDisconnect(error, context),
                },
            )) {
                if (chunk.type !== 'retry') {
                    this.withSessionStreamContext(streamSessionId, () => this.markActiveStreamAccepted());
                }

                if (chunk.sessionId) {
                    this.syncBackendSession(chunk.sessionId, streamSessionId);
                    streamSessionId = chunk.sessionId;
                }

                this.withSessionStreamContext(streamSessionId, () => {
                    switch (chunk.type) {
                        case 'stream_open':
                            console.debug('[ChatApp] Gateway SSE stream opened.');
                            this.updateConnectionStatus('connected');
                            break;
                        case 'status':
                            this.handleStreamStatus(chunk);
                            break;
                        case 'progress':
                            this.handleProgress(chunk);
                            break;
                        case 'text_delta':
                            hasReceivedContent = true;
                            this.retryAttempt = 0; // Reset retry count on successful content
                            this.handleDelta(chunk.content);
                            break;
                        case 'reasoning_summary_delta':
                            this.handleReasoningSummaryDelta(chunk);
                            break;
                        case 'tool_event':
                            this.handleToolEvent(chunk);
                            break;
                        case 'done':
                            receivedTerminalChunk = true;
                            this.handleDone(chunk);
                            break;
                        case 'error':
                            receivedTerminalChunk = true;
                            streamFailed = true;
                            if (chunk.cancelled) {
                                this.handleCancelled();
                            } else {
                                // Show retry notification if retries were attempted
                                if (chunk.retriesExhausted) {
                                    uiHelpers.showToast('Failed after multiple retries. Please try again.', 'error');
                                }
                                this.handleError(chunk.error, chunk.status);
                            }
                            break;
                        case 'retry':
                            retryCount = chunk.attempt;
                            if (retryCount > 1) {
                                uiHelpers.showToast(`Retrying... (attempt ${chunk.attempt}/${chunk.maxAttempts})`, 'info');
                            }
                            break;
                        case 'resync_required':
                            receivedTerminalChunk = true;
                            streamFailed = true;
                            this.handleInterruptedStreamResync(chunk);
                            break;
                    }
                });
            }

            if (!receivedTerminalChunk && this.isSessionProcessing(streamSessionId)) {
                streamFailed = true;
                this.withSessionStreamContext(streamSessionId, () => {
                    this.handleError('The reply stream ended before completion.', 502);
                });
            }

            return !streamFailed;
        } catch (error) {
            console.error('Chat error:', error);
            this.withSessionStreamContext(this.getTrackedStreamSessionId(sessionId), () => {
                this.handleError(error.message || 'Failed to get response', error?.status);
            });
            return false;
        } finally {
            const finalState = this.streamStatesBySession.get(sessionId);
            if (finalState) {
                finalState.currentAbortController = null;
            }
            if (this.isVisibleSession(sessionId)) {
                this.currentAbortController = null;
                this.updateSendButton();
            }
        }
    }

    clearCurrentStreamingMessage() {
        const sessionId = this.getStreamingMessageSessionId();
        const streamingMessageId = this.currentStreamingMessageId;
        if (!streamingMessageId || !sessionId) {
            return false;
        }

        const removedElement = document.getElementById(streamingMessageId);
        if (removedElement) {
            removedElement.remove();
        }

        const messages = sessionManager.getMessages(sessionId);
        const messageIndex = messages.findIndex((message) => message.id === streamingMessageId);
        if (messageIndex === -1) {
            return false;
        }

        const removedMessage = messages[messageIndex];
        messages.splice(messageIndex, 1);
        sessionManager.saveToStorage();
        return removedMessage;
    }

    enqueueMessage(content, options = {}) {
        const normalizedContent = String(content || '').trim();
        if (!normalizedContent) {
            return false;
        }

        const sessionId = this.getCurrentQueueSessionId();
        if (!sessionId) {
            return false;
        }

        if (this.getQueuedMessageCount(sessionId) >= WEB_CHAT_QUEUE_MAX_SIZE) {
            uiHelpers.showToast(`You can queue up to ${WEB_CHAT_QUEUE_MAX_SIZE} messages.`, 'warning');
            return false;
        }

        this.messageQueue.push({
            content: normalizedContent,
            sessionId,
            workspaceKey: this.workspaceContext?.key || 'workspace-1',
            queuedAt: Date.now(),
            options: options && typeof options === 'object' ? options : {},
        });
        this.updateSendButton();
        uiHelpers.showToast(`Message queued (${this.getQueuedMessageCount(sessionId)}/${WEB_CHAT_QUEUE_MAX_SIZE})`, 'info');
        return true;
    }

    async processMessageQueue(options = {}) {
        const targetSessionId = String(options.sessionId || sessionManager.currentSessionId || '').trim();
        if (this.isProcessingQueue || this.messageQueue.length === 0 || !targetSessionId) {
            return;
        }

        this.isProcessingQueue = true;

        try {
            while (!this.isSessionProcessing(targetSessionId)) {
                if (!this.isVisibleSession(targetSessionId)) {
                    break;
                }

                const nextIndex = this.messageQueue.findIndex((entry) => this.isQueuedMessageForSession(entry, targetSessionId));
                if (nextIndex === -1) {
                    break;
                }

                const [next] = this.messageQueue.splice(nextIndex, 1);
                if (!next?.content) {
                    continue;
                }
                uiHelpers.showToast('Processing queued message.', 'info');
                await this.sendPreparedMessage(next.content, next.options || {});
            }
        } finally {
            this.isProcessingQueue = false;
            this.updateSendButton();
        }
    }

    async submitAgentSurvey(trigger) {
        const button = trigger?.closest?.('.agent-survey-card__submit') || trigger;
        const card = button?.closest?.('.agent-survey-card');
        if (!card) {
            return;
        }

        const messageId = String(card.dataset.messageId || '').trim();
        const surveyId = String(card.dataset.surveyId || '').trim();
        const sessionId = sessionManager.currentSessionId;
        if (this.isCurrentSessionProcessing() && !this.isMatchingPendingSurveyCheckpoint(sessionId, surveyId)) {
            return;
        }

        const surveyMessage = this.getSessionMessage(sessionId, messageId);
        const survey = this.getMessageSurveyDefinition(surveyMessage);
        if (!survey || survey.id !== surveyId) {
            uiHelpers.showToast('Unable to load that questionnaire right now.', 'error');
            return;
        }

        const currentStepIndex = uiHelpers.getSurveyCurrentStepIndex(survey, {
            currentStepIndex: Number(card.dataset.currentStepIndex || 0),
        });
        const currentStep = survey.steps[currentStepIndex];
        if (!currentStep) {
            uiHelpers.showToast('Unable to determine the current question.', 'error');
            return;
        }

        const currentStepResponse = this.collectSurveyStepResponseFromCard(card, currentStep);
        if (!uiHelpers.isSurveyStepComplete(currentStep, currentStepResponse)) {
            const prompt = ['choice', 'multi-choice'].includes(currentStep.inputType)
                ? 'Complete this choice first'
                : 'Fill in this answer first';
            uiHelpers.showToast(prompt, 'info');
            return;
        }

        const existingSurveyState = surveyMessage?.surveyState?.checkpointId === surveyId
            ? surveyMessage.surveyState
            : null;
        const stepResponses = {
            ...((existingSurveyState?.stepResponses && typeof existingSurveyState.stepResponses === 'object')
                ? existingSurveyState.stepResponses
                : {}),
            [currentStep.id]: currentStepResponse,
        };
        const isLastStep = currentStepIndex >= (survey.steps.length - 1);

        if (!isLastStep) {
            if (surveyMessage) {
                surveyMessage.surveyState = this.buildSurveyStatePayload({
                    survey,
                    checkpointId: surveyId,
                    status: 'draft',
                    currentStepIndex: currentStepIndex + 1,
                    stepResponses,
                });
                this.upsertSessionMessage(sessionId, surveyMessage);
                this.renderOrReplaceMessage(surveyMessage);
            }
            return;
        }

        const responseContent = this.buildSurveyResponseContent({
            checkpointId: surveyId,
            survey,
            stepResponses,
        });

        if (surveyMessage) {
            surveyMessage.surveyState = this.buildSurveyStatePayload({
                survey,
                checkpointId: surveyId,
                status: 'answered',
                currentStepIndex,
                stepResponses,
                summary: responseContent.replace(/^Survey response \([^)]+\):\s*/i, ''),
            });
            this.upsertSessionMessage(sessionId, surveyMessage);
            this.renderOrReplaceMessage(surveyMessage);
        }

        card.dataset.submitted = 'true';
        if (button) {
            button.disabled = true;
        }

        this.releasePendingSurveyProcessingGate(sessionId, surveyId);
        this.markLocalCheckpointAnswered(
            sessionId,
            surveyId,
            responseContent.replace(/^Survey response \([^)]+\):\s*/i, ''),
        );

        const sendSucceeded = await this.sendPreparedMessage(responseContent);
        if (!sendSucceeded) {
            if (surveyMessage) {
                surveyMessage.surveyState = this.buildSurveyStatePayload({
                    survey,
                    checkpointId: surveyId,
                    status: 'draft',
                    currentStepIndex,
                    stepResponses,
                });
                this.upsertSessionMessage(sessionId, surveyMessage);
                this.renderOrReplaceMessage(surveyMessage);
            }

            this.restoreLocalCheckpointPending(sessionId, survey);
            uiHelpers.showToast('Questionnaire response was not sent. You can try again.', 'warning');
        }
    }

    goToPreviousSurveyStep(trigger) {
        const button = trigger?.closest?.('.agent-survey-card__secondary') || trigger;
        const card = button?.closest?.('.agent-survey-card');
        if (!card) {
            return;
        }

        const messageId = String(card.dataset.messageId || '').trim();
        const surveyId = String(card.dataset.surveyId || '').trim();
        const sessionId = sessionManager.currentSessionId;
        if (this.isCurrentSessionProcessing() && !this.isMatchingPendingSurveyCheckpoint(sessionId, surveyId)) {
            return;
        }

        const surveyMessage = this.getSessionMessage(sessionId, messageId);
        const survey = this.getMessageSurveyDefinition(surveyMessage);
        if (!survey || survey.id !== surveyId) {
            return;
        }

        const currentStepIndex = uiHelpers.getSurveyCurrentStepIndex(survey, {
            currentStepIndex: Number(card.dataset.currentStepIndex || 0),
        });
        if (currentStepIndex <= 0) {
            return;
        }

        const currentStep = survey.steps[currentStepIndex];
        const existingSurveyState = surveyMessage?.surveyState?.checkpointId === surveyId
            ? surveyMessage.surveyState
            : null;
        const stepResponses = {
            ...((existingSurveyState?.stepResponses && typeof existingSurveyState.stepResponses === 'object')
                ? existingSurveyState.stepResponses
                : {}),
        };
        if (currentStep) {
            const currentStepResponse = this.collectSurveyStepResponseFromCard(card, currentStep);
            if (this.hasSurveyStepResponseData(currentStepResponse)) {
                stepResponses[currentStep.id] = currentStepResponse;
            } else {
                delete stepResponses[currentStep.id];
            }
        }

        if (surveyMessage) {
            surveyMessage.surveyState = this.buildSurveyStatePayload({
                survey,
                checkpointId: surveyId,
                status: 'draft',
                currentStepIndex: currentStepIndex - 1,
                stepResponses,
            });
            this.upsertSessionMessage(sessionId, surveyMessage);
            this.renderOrReplaceMessage(surveyMessage);
        }
    }

    async appendLocalChatMessage(role, content, extra = {}) {
        if (!sessionManager.currentSessionId) {
            await this.createNewSession();
        }

        const sessionId = sessionManager.currentSessionId;
        uiHelpers.hideWelcomeMessage();
        const message = {
            role,
            content,
            timestamp: new Date().toISOString(),
            ...extra,
        };
        const savedMessage = sessionManager.addMessage(sessionId, message);
        this.messagesContainer.appendChild(uiHelpers.renderMessage(savedMessage));
        uiHelpers.reinitializeIcons(this.messagesContainer);
        uiHelpers.scrollToBottom();
        this.updateSessionInfo();
        return savedMessage;
    }

    isSkillWizardApprovalText(content = '') {
        return /^(approve|approved|yes|y|create|save|ship it|looks good|go ahead)$/i.test(String(content || '').trim());
    }

    isSkillWizardCancelText(content = '') {
        return /^(cancel|stop|exit|quit|never mind|nevermind)$/i.test(String(content || '').trim());
    }

    formatSkillWizardDraft(draft = {}) {
        const tools = Array.isArray(draft.tools) ? draft.tools : [];
        const triggers = Array.isArray(draft.triggerPatterns) ? draft.triggerPatterns : [];
        const chain = Array.isArray(draft.chain) ? draft.chain : [];
        const lines = [
            `Name: **${draft.name || 'Untitled skill'}**`,
            draft.id ? `ID: \`${draft.id}\`` : '',
            draft.description ? `Description: ${draft.description}` : '',
            tools.length ? `Tools: ${tools.map((tool) => `\`${tool}\``).join(', ')}` : 'Tools: none selected yet',
            triggers.length ? `Triggers: ${triggers.map((trigger) => `\`${trigger}\``).join(', ')}` : '',
        ].filter(Boolean);

        if (chain.length > 0) {
            lines.push('');
            lines.push('Proposed chain:');
            chain.slice(0, 8).forEach((step, index) => {
                const label = typeof step === 'string'
                    ? step
                    : (step.step || step.instruction || step.description || JSON.stringify(step));
                const tool = typeof step === 'object' && step?.tool ? ` using \`${step.tool}\`` : '';
                lines.push(`${index + 1}. ${label}${tool}`);
            });
        }

        return lines.join('\n');
    }

    formatSkillWizardQuestions(questions = []) {
        if (!Array.isArray(questions) || questions.length === 0) {
            return '';
        }

        const lines = ['Questions to tighten the skill:'];
        questions.forEach((question, index) => {
            lines.push(`${index + 1}. ${question.question}`);
            if (Array.isArray(question.options) && question.options.length > 0) {
                question.options.forEach((option) => {
                    const description = option.description ? ` - ${option.description}` : '';
                    lines.push(`   - ${option.label}${description}`);
                });
            }
        });
        lines.push('');
        lines.push('Reply with your answers in one message, or say `cancel`.');
        return lines.join('\n');
    }

    formatSkillWizardMessage(result = {}, phase = 'questions') {
        const draft = result.draft || {};
        const sections = [
            '## Skill Creator Guide',
            result.summary || 'I drafted a skill direction from your ask and the available tools.',
            '',
            '### Current Draft',
            this.formatSkillWizardDraft(draft),
        ];

        if (phase === 'approval') {
            sections.push('');
            sections.push('### Final Check');
            sections.push('Reply `approve` to create this registered skill, or describe adjustments you want.');
            if (draft.body) {
                sections.push('');
                sections.push('```markdown');
                sections.push(draft.body);
                sections.push('```');
            }
        } else {
            sections.push('');
            sections.push('### Next');
            sections.push(this.formatSkillWizardQuestions(result.questions || []));
        }

        return sections.filter((entry) => entry !== '').join('\n\n');
    }

    async refreshSkillWizardDraft(extraAnswer = null) {
        const state = this.skillWizardState;
        if (!state) {
            return null;
        }

        const answers = [
            ...(Array.isArray(state.answers) ? state.answers : []),
            ...(extraAnswer ? [extraAnswer] : []),
        ];
        const result = await apiClient.draftSkill({
            ask: state.ask,
            answers,
            currentDraft: state.draft || null,
        });
        const questions = Array.isArray(result.questions) ? result.questions : [];
        const phase = result.readyForApproval === true || questions.length === 0
            ? 'approval'
            : 'questions';

        this.skillWizardState = {
            ...state,
            answers,
            draft: result.draft || state.draft || null,
            questions,
            phase,
            lastResult: result,
        };

        return {
            result,
            phase,
        };
    }

    async startSkillWizard(initialAsk = '') {
        const ask = String(initialAsk || '').trim();
        if (!ask) {
            await this.appendLocalChatMessage('assistant', [
                '## Skill Creator Guide',
                '',
                'Start with `/skill-wizard <what you want the skill to help with>`.',
                '',
                'Example: `/skill-wizard create a repeatable workflow for generating product images, using them in a landing page, and deploying to k3s`',
            ].join('\n'));
            return;
        }

        if (this.isSkillWizardCancelText(ask)) {
            this.skillWizardState = null;
            await this.appendLocalChatMessage('assistant', 'Skill creator guide cancelled.');
            return;
        }

        this.skillWizardState = {
            ask,
            answers: [],
            draft: null,
            questions: [],
            phase: 'starting',
            lastResult: null,
        };

        const loadingMessage = await this.appendLocalChatMessage('assistant', '## Skill Creator Guide\n\nLooking at the current tools and sketching the first skill draft...');
        try {
            const next = await this.refreshSkillWizardDraft();
            if (!next) {
                throw new Error('Skill wizard did not start.');
            }
            loadingMessage.content = this.formatSkillWizardMessage(next.result, next.phase);
            this.upsertSessionMessage(sessionManager.currentSessionId, loadingMessage);
            this.renderOrReplaceMessage(loadingMessage);
        } catch (error) {
            this.skillWizardState = null;
            loadingMessage.content = `**Skill creator error:** ${error.message}`;
            this.upsertSessionMessage(sessionManager.currentSessionId, loadingMessage);
            this.renderOrReplaceMessage(loadingMessage);
        }
    }

    async handleSkillWizardReply(content = '') {
        const answer = String(content || '').trim();
        if (!this.skillWizardState || !answer) {
            return false;
        }

        await this.appendLocalChatMessage('user', answer);

        if (this.isSkillWizardCancelText(answer)) {
            this.skillWizardState = null;
            await this.appendLocalChatMessage('assistant', 'Skill creator guide cancelled.');
            return true;
        }

        const state = this.skillWizardState;
        if (state.phase === 'approval' && this.isSkillWizardApprovalText(answer)) {
            try {
                const response = await apiClient.createSkill(state.draft || {});
                const skill = response?.data || {};
                this.skillWizardState = null;
                await this.appendLocalChatMessage('assistant', [
                    '## Skill Created',
                    '',
                    `\`${skill.id || 'skill'}\` is registered in \`${response?.meta?.root || 'data/skills'}\`.`,
                    '',
                    'It is now available to the conversation planner as compact workflow guidance.',
                ].join('\n'));
            } catch (error) {
                await this.appendLocalChatMessage('assistant', `**Skill save error:** ${error.message}\n\nDescribe an adjustment, or say \`cancel\`.`);
            }
            return true;
        }

        const questionSummary = state.phase === 'approval'
            ? 'Final adjustment request'
            : (state.questions || []).map((question, index) => `${index + 1}. ${question.question}`).join('\n');
        const loadingMessage = await this.appendLocalChatMessage('assistant', '## Skill Creator Guide\n\nUpdating the skill draft from your answer...');

        try {
            const next = await this.refreshSkillWizardDraft({
                question: questionSummary || 'Skill creator follow-up',
                answer,
                answeredAt: new Date().toISOString(),
            });
            loadingMessage.content = this.formatSkillWizardMessage(next.result, next.phase);
            this.upsertSessionMessage(sessionManager.currentSessionId, loadingMessage);
            this.renderOrReplaceMessage(loadingMessage);
        } catch (error) {
            loadingMessage.content = `**Skill creator error:** ${error.message}\n\nYou can answer again, say \`approve\`, or say \`cancel\`.`;
            this.upsertSessionMessage(sessionManager.currentSessionId, loadingMessage);
            this.renderOrReplaceMessage(loadingMessage);
        }

        return true;
    }

    async tryHandleToolCommand(content) {
        const trimmed = String(content || '').trim();
        const isListCommand = trimmed === '/tools' || trimmed.startsWith('/tools ');
        const isInvokeCommand = trimmed.startsWith('/tool ');
        const isHelpCommand = trimmed.startsWith('/tool-help ');
        const isSkillListCommand = trimmed === '/skills' || trimmed.startsWith('/skills ');
        const isSkillReadCommand = trimmed.startsWith('/skill ');
        const isSkillCreateCommand = trimmed.startsWith('/skill-create ');
        const isSkillUpdateCommand = trimmed.startsWith('/skill-update ');
        const isSkillWizardCommand = trimmed === '/skill-wizard' || trimmed.startsWith('/skill-wizard ');

        if (!isListCommand && !isInvokeCommand && !isHelpCommand && !isSkillListCommand && !isSkillReadCommand && !isSkillCreateCommand && !isSkillUpdateCommand && !isSkillWizardCommand) {
            return false;
        }

        if (!sessionManager.currentSessionId) {
            await this.createNewSession();
        }

        let sessionId = sessionManager.currentSessionId;
        uiHelpers.hideWelcomeMessage();

        const userMessage = {
            role: 'user',
            content: trimmed,
            timestamp: new Date().toISOString(),
        };
        const savedUserMessage = sessionManager.addMessage(sessionId, userMessage);
        this.messagesContainer.appendChild(uiHelpers.renderMessage(savedUserMessage));

        try {
            let assistantContent = '';
            let assistantMetadata = {};

            if (isListCommand) {
                const category = trimmed.startsWith('/tools ') ? trimmed.slice('/tools '.length).trim() : null;
                const toolResponse = await apiClient.getAvailableTools(category || null);
                assistantContent = this.formatToolsList(toolResponse, category);
            } else if (isSkillWizardCommand) {
                await this.startSkillWizard(trimmed.slice('/skill-wizard'.length).trim());
                return true;
            } else if (isSkillListCommand) {
                const search = trimmed.startsWith('/skills ') ? trimmed.slice('/skills '.length).trim() : '';
                const skillResponse = await apiClient.listSkills({ search });
                assistantContent = this.formatSkillsList(skillResponse, search);
            } else if (isSkillReadCommand) {
                const skillId = trimmed.slice('/skill '.length).trim();
                if (!skillId) {
                    throw new Error('Usage: /skill <id>');
                }
                const skill = await apiClient.getSkill(skillId);
                assistantContent = `## Skill: \`${skill.id}\`\n\n${skill.description || 'No description provided.'}\n\nTools: ${(skill.tools || []).map((tool) => `\`${tool}\``).join(', ') || 'none'}\n\nTriggers: ${(skill.triggerPatterns || []).map((trigger) => `\`${trigger}\``).join(', ') || 'none'}\n\n\`\`\`markdown\n${skill.body || ''}\n\`\`\``;
            } else if (isSkillCreateCommand || isSkillUpdateCommand) {
                const rawPayload = trimmed.slice((isSkillCreateCommand ? '/skill-create ' : '/skill-update ').length).trim();
                if (!rawPayload) {
                    throw new Error(isSkillCreateCommand
                        ? 'Usage: /skill-create {"name":"...","description":"...","body":"...","tools":["image-generate"]}'
                        : 'Usage: /skill-update <id> {"description":"...","body":"..."}');
                }

                let response;
                if (isSkillCreateCommand) {
                    response = await apiClient.createSkill(JSON.parse(rawPayload));
                } else {
                    const match = rawPayload.match(/^([^\s]+)\s+([\s\S]+)$/);
                    if (!match) {
                        throw new Error('Usage: /skill-update <id> {"description":"...","body":"..."}');
                    }
                    response = await apiClient.updateSkill(match[1], JSON.parse(match[2]));
                }
                const skill = response?.data || response?.skill || null;
                assistantContent = `## Skill Saved\n\n\`${skill?.id || 'unknown'}\` is registered in \`${response?.meta?.root || 'data/skills'}\`.`;
            } else if (isHelpCommand) {
                const toolId = trimmed.slice('/tool-help '.length).trim();
                if (!toolId) {
                    throw new Error('Usage: /tool-help <id>');
                }
                const doc = await apiClient.getToolDoc(toolId);
                assistantContent = `## Tool Help: \`${toolId}\`\n\nSupport: \`${doc?.support?.status || 'unknown'}\`\n\n${doc?.content || 'No documentation found.'}`;
            } else {
                const match = trimmed.match(/^\/tool\s+([^\s]+)(?:\s+([\s\S]+))?$/i);
                if (!match) {
                    throw new Error('Usage: /tool <id> {"key":"value"}');
                }

                const toolId = match[1];
                const rawParams = (match[2] || '').trim();
                let params = {};

                if (rawParams) {
                    params = JSON.parse(rawParams);
                }

                const invocation = await apiClient.invokeTool(toolId, params, this.buildToolInvokeRequestOptions(toolId));
                if (invocation?.sessionId) {
                    this.syncBackendSession(invocation.sessionId);
                    sessionId = sessionManager.currentSessionId || invocation.sessionId || sessionId;
                }
                const toolInfo = this.getToolDisplayInfo(toolId);
                assistantContent = this.formatToolInvocationResult(toolId, invocation?.result);
                assistantMetadata = {
                    toolResultChip: {
                        ...toolInfo,
                        status: 'completed',
                    },
                    directToolId: toolId,
                };
            }

            const assistantMessage = {
                role: 'assistant',
                content: assistantContent,
                timestamp: new Date().toISOString(),
                ...(Object.keys(assistantMetadata).length > 0
                    ? { metadata: assistantMetadata }
                    : {}),
            };
            const savedAssistantMessage = sessionManager.addMessage(sessionId, assistantMessage);
            this.messagesContainer.appendChild(uiHelpers.renderMessage(savedAssistantMessage));
            uiHelpers.reinitializeIcons(this.messagesContainer);
            uiHelpers.scrollToBottom();
            this.updateSessionInfo();
            return true;
        } catch (error) {
            const assistantMessage = {
                role: 'assistant',
                content: `**Tool error:** ${error.message}`,
                timestamp: new Date().toISOString(),
            };
            const savedAssistantMessage = sessionManager.addMessage(sessionId, assistantMessage);
            this.messagesContainer.appendChild(uiHelpers.renderMessage(savedAssistantMessage));
            uiHelpers.scrollToBottom();
            this.updateSessionInfo();
            return true;
        }
    }

    buildToolInvokeRequestOptions(toolId = '') {
        const normalizedToolId = String(toolId || '').trim();
        const selectionOptions = this.buildToolIntentRequestOptions();
        const selectionMetadata = selectionOptions.metadata && typeof selectionOptions.metadata === 'object'
            ? selectionOptions.metadata
            : {};
        const selectedPlannedTools = Array.isArray(selectionMetadata.plannedTools)
            ? selectionMetadata.plannedTools
            : [];
        const plannedTools = Array.from(new Set([
            ...selectedPlannedTools,
            ...(normalizedToolId ? [normalizedToolId] : []),
        ]));
        const remoteToolRequested = normalizedToolId && WEB_CHAT_REMOTE_TOOL_IDS.has(normalizedToolId);
        const executionProfile = selectionOptions.executionProfile
            || (remoteToolRequested ? 'remote-build' : '');

        const metadata = {
            ...selectionMetadata,
            directToolCallSource: 'web-chat-tool-command',
            ...(normalizedToolId ? { directToolId: normalizedToolId } : {}),
            ...(plannedTools.length ? { plannedTools, userSelectedToolIds: plannedTools } : {}),
            ...(normalizedToolId ? { preferredTool: normalizedToolId } : {}),
            ...(remoteToolRequested ? {
                remoteBuildAutonomyApproved: true,
                frontendRemoteBuildAutonomyApproved: true,
                remoteBuildIntent: true,
            } : {}),
        };

        return {
            ...(executionProfile ? { executionProfile } : {}),
            metadata,
        };
    }

    getToolDisplayInfo(toolId = '') {
        return this.normalizeDirectToolSelection(toolId)
            || {
                id: String(toolId || 'tool').trim() || 'tool',
                name: String(toolId || 'Tool').trim() || 'Tool',
                description: '',
                category: '',
                icon: 'wrench',
            };
    }

    extractToolInvocationText(value = null, depth = 0) {
        if (value == null || depth > 5) {
            return '';
        }

        if (typeof value === 'string') {
            return value.trim();
        }

        if (typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }

        if (Array.isArray(value)) {
            return value
                .map((entry) => this.extractToolInvocationText(entry, depth + 1))
                .filter(Boolean)
                .join('\n\n')
                .trim();
        }

        if (typeof value !== 'object') {
            return '';
        }

        const stdout = String(value.stdout || '').trim();
        const stderr = String(value.stderr || '').trim();
        if (stdout || stderr) {
            return [
                stdout,
                stderr ? `STDERR:\n${stderr}` : '',
            ].filter(Boolean).join('\n\n').trim();
        }

        for (const key of [
            'finalOutput',
            'final_output',
            'assistantText',
            'assistant_text',
            'outputText',
            'output_text',
            'artifactMessage',
            'artifact_message',
            'output',
            'message',
            'summary',
            'text',
            'content',
            'result',
            'data',
        ]) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) {
                continue;
            }
            const extracted = this.extractToolInvocationText(value[key], depth + 1);
            if (extracted) {
                return extracted;
            }
        }

        return '';
    }

    formatToolInvocationResult(toolId = '', result = null) {
        const normalizedToolId = String(toolId || '').trim();
        const unwrapped = result?.data || result?.result || result || {};

        if (normalizedToolId === 'remote-cli-agent') {
            const remoteContent = this.formatRemoteAgentResult(unwrapped);
            if (!/```json/i.test(remoteContent)) {
                return remoteContent;
            }
        }

        if (['remote-command', 'remote-workbench', 'k3s-deploy'].includes(normalizedToolId)) {
            const remoteContent = this.formatRemoteResult(unwrapped, `${this.getToolDisplayInfo(normalizedToolId).name} Result`);
            if (!/```json/i.test(remoteContent)) {
                return remoteContent;
            }
        }

        const readableText = this.extractToolInvocationText(unwrapped);
        if (readableText) {
            return readableText;
        }

        return 'Tool finished, but it did not return readable chat content.';
    }

    formatToolsList(toolResponse, category = null) {
        const tools = Array.isArray(toolResponse) ? toolResponse : (toolResponse?.tools || []);
        const runtime = toolResponse?.meta?.runtime || null;

        if (!Array.isArray(tools) || tools.length === 0) {
            return category
                ? `No frontend tools are available in category \`${category}\`.`
                : 'No frontend tools are currently available.';
        }

        const lines = ['## Available Tools', ''];
        if (runtime) {
            const gatewayScope = runtime.modelGateway?.internalCluster ? 'internal cluster' : 'external endpoint';
            lines.push(`Runtime source: \`${runtime.source || 'backend'}\``);
            lines.push(`Model gateway: \`${runtime.modelGateway?.baseURL || 'unknown'}\` (${gatewayScope})`);
            if (runtime.sshDefaults?.enabled) {
                const target = runtime.sshDefaults.host
                    ? `${runtime.sshDefaults.username || 'unknown'}@${runtime.sshDefaults.host}:${runtime.sshDefaults.port || 22}`
                    : 'not set';
                lines.push(`SSH defaults: source=${runtime.sshDefaults.source || 'unknown'}, target=${target}, configured=${runtime.sshDefaults.configured ? 'yes' : 'no'}`);
            } else {
                lines.push('SSH defaults: disabled');
            }
            lines.push('');
        }

        const remoteToolOrder = new Map([
            ['remote-cli-agent', 0],
            ['managed-app', 1],
            ['k3s-deploy', 2],
            ['remote-command', 3],
            ['remote-workbench', 4],
        ]);
        const displayTools = [...tools].sort((first, second) => {
            const firstRank = remoteToolOrder.has(first?.id) ? remoteToolOrder.get(first.id) : 50;
            const secondRank = remoteToolOrder.has(second?.id) ? remoteToolOrder.get(second.id) : 50;
            return firstRank - secondRank;
        });

        displayTools.forEach((tool) => {
            const params = Array.isArray(tool.parameters)
                ? tool.parameters.map((param) => typeof param === 'string' ? param : param.name).filter(Boolean)
                : Object.keys(tool.inputSchema?.properties || {});
            lines.push(`- \`${tool.id}\` (${tool.category})`);
            lines.push(`  ${tool.description || 'No description provided.'}`);
            if (tool.id === 'remote-cli-agent') {
                lines.push('  Preferred for remote coding, build, deploy, and verification loops. Use `/remote agent <task>` or `/remote <task>`.');
            } else if (tool.id === 'remote-workbench') {
                lines.push('  Structured low-level helper; keep normal remote build/deploy work on `remote-cli-agent`.');
            }
            if (tool.support?.status) {
                lines.push(`  Support: ${tool.support.status}`);
            }
            if (tool.runtime?.defaultTarget) {
                lines.push(`  Runtime: ${tool.runtime.defaultTarget} via ${tool.runtime.source || 'unknown'}`);
            } else if (tool.runtime && Object.prototype.hasOwnProperty.call(tool.runtime, 'configured')) {
                lines.push(`  Runtime: configured=${tool.runtime.configured ? 'yes' : 'no'}`);
            }
            const callerContract = this.formatToolCallerContract(tool.runtime?.callerContract);
            if (callerContract.length) {
                lines.push('  Use:');
                callerContract.forEach((contractLine) => {
                    lines.push(`    - ${contractLine}`);
                });
            }
            if (params.length) {
                lines.push(`  Params: ${params.join(', ')}`);
            }
        });
        lines.push('');
        lines.push('Usage: `/tool <id> {"key":"value"}`');
        lines.push('Help: `/tool-help <id>`');
        return lines.join('\n');
    }

    formatToolCallerContract(callerContract = []) {
        return (Array.isArray(callerContract) ? callerContract : [])
            .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .slice(0, 3);
    }

    formatSkillsList(skillResponse, search = '') {
        const skills = Array.isArray(skillResponse) ? skillResponse : (skillResponse?.skills || []);
        const meta = skillResponse?.meta || {};

        if (!skills.length) {
            return search
                ? `No registered skills matched \`${search}\`.`
                : 'No registered skills yet. Create one with `/skill-create {"name":"...","description":"...","body":"..."}`.';
        }

        const lines = ['## Registered Skills', ''];
        if (meta.root) {
            lines.push(`Location: \`${meta.root}\``);
            lines.push('');
        }
        skills.forEach((skill) => {
            lines.push(`- \`${skill.id}\` - ${skill.name || skill.id}`);
            if (skill.description) {
                lines.push(`  ${skill.description}`);
            }
            if (Array.isArray(skill.tools) && skill.tools.length > 0) {
                lines.push(`  Tools: ${skill.tools.map((tool) => `\`${tool}\``).join(', ')}`);
            }
        });
        lines.push('');
        lines.push('Usage: `/skill <id>`, `/skill-create {...}`, `/skill-update <id> {...}`');
        return lines.join('\n');
    }

    /**
     * Cancel the current streaming request
     */
    async cancelCurrentRequest() {
        if (this.isCancellingCurrentRequest) {
            return false;
        }

        const trackedRequest = this.pendingStreamResync || this.activeStreamRequest;
        if (!this.isProcessing && !trackedRequest) {
            return false;
        }

        this.isCancellingCurrentRequest = true;
        this.updateSendButton();

        const sessionId = String(trackedRequest?.sessionId || sessionManager.currentSessionId || '').trim();
        const requestId = String(
            trackedRequest?.requestId
            || trackedRequest?.assistantMessageId
            || this.currentStreamingMessageId
            || '',
        ).trim();
        const needsServerCancel = Boolean(
            trackedRequest?.acceptedByServer
            && sessionId
            && requestId
            && !sessionManager.isLocalSession?.(sessionId)
        );
        const hadLocalController = Boolean(this.currentAbortController);
        const serverCancelPromise = needsServerCancel
            ? apiClient.cancelForegroundTurn(sessionId, requestId)
            : Promise.resolve(null);

        if (hadLocalController) {
            this.currentAbortController.abort();
            this.currentAbortController = null;
        }

        let serverResult = null;
        try {
            serverResult = await serverCancelPromise;
        } catch (error) {
            console.warn('Failed to cancel foreground turn on the server:', error);
        }

        const serverCancelled = Boolean(serverResult?.cancelled || serverResult?.persisted);
        const serverSettledElsewhere = serverResult?.reason === 'not_found';

        if (!hadLocalController) {
            if (serverCancelled || serverSettledElsewhere || !needsServerCancel) {
                this.handleCancelled({ reason: 'user_cancelled' });
                uiHelpers.showToast('Reply stopped', 'info');
                return true;
            }

            this.isCancellingCurrentRequest = false;
            this.updateSendButton();
            uiHelpers.showToast('Could not stop the reply on the server.', 'warning');
            return false;
        }

        if (needsServerCancel && !serverCancelled && !serverSettledElsewhere) {
            uiHelpers.showToast('Stopped locally. Server cancellation could not be confirmed.', 'warning');
        } else {
            uiHelpers.showToast('Stopping reply...', 'info');
        }

        return true;
    }

    /**
     * Build message history in OpenAI format from session messages
     */
    buildMessageHistory(sessionId) {
        const messages = sessionManager.getMessages(sessionId);
        if (!messages || messages.length === 0) return [];
        
        // Convert to OpenAI format: [{role, content}, ...]
        return messages
            .filter((m) => (
                (m.role === 'user' || m.role === 'assistant')
                && !m.isStreaming
                && m.excludeFromTranscript !== true
                && m.metadata?.excludeFromTranscript !== true
                && String(m.content || '').trim()
            ))
            .map(m => ({
                role: m.role,
                content: m.content || ''
            }));
    }

    async executeSlashCommand(command) {
        const parts = command.slice(1).split(' ');
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1).join(' ');
        
        switch (cmd) {
            case 'model':
                if (args) {
                    // Try to find and select the model
                    uiHelpers.selectModel(args);
                } else {
                    uiHelpers.openModelSelector();
                }
                break;
            case 'models':
                uiHelpers.openModelSelector();
                break;
            case 'image':
                this.handleImageCommand(args);
                break;
            case 'unsplash':
                if (args) {
                    this.searchUnsplashImages(args.trim());
                } else {
                    uiHelpers.showToast('Please provide a search query. Example: /unsplash sunset', 'warning');
                }
                break;
            case 'remote':
                await this.handleRemoteCommand(args);
                break;
            case 'clear':
                this.clearCurrentSession();
                break;
            case 'new':
                await this.createNewSession();
                break;
            case 'help':
                uiHelpers.openShortcutsModal();
                break;
            default:
                uiHelpers.showToast(`Unknown command: /${cmd}. Try /help for available commands.`, 'warning');
        }
    }

    buildRemotePlanContent() {
        return [
            '## Remote CLI Plan',
            '',
            '1. `/remote agent <task>` or `/remote <task>` - hand a full coding/build/deploy loop to the backend remote CLI agent.',
            '2. `/remote async agent <task>` - queue a durable async remote job card with replayable progress.',
            '3. `/remote status` - confirm remote runner health and fallback target.',
            '4. `/remote tools` - list exact inspect/catalog commands.',
            '5. `/remote <catalog-id>` - run a catalog entry such as `baseline`, `kubectl-inspect`, `logs`, or `rollout`.',
            '6. `/remote run <command>` - execute one purposeful raw inspect or verify batch.',
            '7. Continue normal build/test failures while the next step is still on plan.',
            '8. Stop for sudo/package installs, secrets, destructive deletes, force push, repeated failures, missing credentials, or unclear recovery.',
            '',
            'Raw expert access: `/remote run hostname && whoami && uname -m`',
        ].join('\n');
    }

    buildRemoteHttpsVerifyCommand(host) {
        const normalized = String(host || '').trim() || 'demoserver2.buzz';
        if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(normalized)) {
            throw new Error('Host must be a domain, IP address, or host:port without shell characters.');
        }

        return `host=${JSON.stringify(normalized)}
getent ahosts "$host" || true
curl -fsSIL --max-time 20 "https://$host"`;
    }

    resolveRemoteCatalogEntry(catalog = [], subcommand = '') {
        const normalized = String(subcommand || '').trim().toLowerCase();
        if (!normalized) {
            return null;
        }

        return (Array.isArray(catalog) ? catalog : []).find((entry) => {
            const id = String(entry?.id || '').trim().toLowerCase();
            const label = String(entry?.label || '').trim().toLowerCase().replace(/\s+/g, '-');
            return id === normalized || label === normalized;
        }) || null;
    }

    shouldRouteRemoteSubcommandToAgent(subcommand = '', rest = '', remoteCatalog = {}) {
        const normalized = String(subcommand || '').trim().toLowerCase();
        const remaining = String(rest || '').trim();
        if (!normalized || !remaining) {
            return false;
        }

        if (['agent', 'run', 'status', 'tools', 'tool', 'plan', 'help', '?', 'verify'].includes(normalized)) {
            return false;
        }

        return Boolean(remoteCatalog?.remoteAgent || remoteCatalog?.tools?.some((tool) => tool.id === 'remote-cli-agent'));
    }

    buildRemoteAgentOptions(remoteCatalog = {}) {
        const remoteAgent = remoteCatalog.remoteAgent
            || remoteCatalog.tools?.find((tool) => tool.id === 'remote-cli-agent')
            || null;
        const selectedModel = String(uiHelpers.getCurrentModel?.() || '').trim();

        return {
            cwd: remoteAgent?.runtime?.defaultCwd || remoteCatalog.runtime?.remoteRunner?.defaultWorkspace || '',
            waitMs: 30000,
            maxTurns: 30,
            adminMode: true,
            ...(selectedModel ? { model: selectedModel } : {}),
        };
    }

    unwrapRemoteResult(invocation = {}) {
        const envelope = invocation?.result || {};
        return envelope?.data || envelope?.result || envelope;
    }

    formatRemoteStatus(remoteCatalog = {}) {
        const runtime = remoteCatalog?.runtime || {};
        const runner = runtime.remoteRunner || {};
        const ssh = runtime.sshDefaults || {};
        const deploy = runtime.deployDefaults || {};
        const remoteTool = remoteCatalog?.remoteTool || {};

        return [
            '## Remote CLI Status',
            '',
            `- Remote runner: ${runner.healthy ? 'healthy' : 'not healthy'} (enabled=${runner.enabled ? 'yes' : 'no'}, preferred=${runner.preferred ? 'yes' : 'no'})`,
            `- Remote-command: ${remoteTool?.runtime?.configured ? 'configured' : 'not configured'} via ${remoteTool?.runtime?.source || 'unknown'}`,
            `- Remote-cli-agent: ${remoteCatalog.tools?.find((tool) => tool.id === 'remote-cli-agent')?.runtime?.configured ? 'configured' : 'not configured'}`,
            `- Default target: ${remoteTool?.runtime?.defaultTarget || 'none'}`,
            `- SSH fallback: ${ssh.configured ? `${ssh.username || 'unknown'}@${ssh.host}:${ssh.port || 22}` : 'not configured'}`,
            `- Deploy defaults: namespace=${deploy.namespace || 'unset'}, deployment=${deploy.deployment || 'unset'}, domain=${deploy.publicDomain || 'unset'}`,
        ].join('\n');
    }

    formatRemoteTools(remoteCatalog = {}) {
        const catalog = Array.isArray(remoteCatalog.catalog) ? remoteCatalog.catalog : [];
        if (catalog.length === 0) {
            return [
                '## Remote CLI Tools',
                '',
                '`remote-cli-agent` is the default for coding, build, deploy, and verify loops.',
                '',
                'No exact remote command catalog is available.',
            ].join('\n');
        }

        return [
            '## Remote CLI Tools',
            '',
            '`remote-cli-agent` is the default for coding, build, deploy, and verify loops. Use `/remote agent <task>` or `/remote <task>` for that path.',
            '',
            'Exact inspect/catalog commands:',
            '',
            ...catalog.map((entry) => {
                const id = String(entry?.id || '').trim();
                const profile = String(entry?.profile || 'inspect').trim();
                const description = String(entry?.description || entry?.purpose || 'Remote command pattern.').trim();
                return `- \`${id}\` (${profile}) - ${description}`;
            }),
        ].join('\n');
    }

    formatRemoteResult(result = {}, title = 'Remote CLI Result') {
        const exitCode = Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : 'unknown';
        const stdout = String(result.stdout || result.output || '').trim();
        const stderr = String(result.stderr || '').trim();
        const metadata = [];

        metadata.push(`Exit code: \`${exitCode}\``);
        if (result.transport || result.source || result.runnerId) {
            metadata.push(`Transport: \`${result.transport || result.source || 'remote'}${result.runnerId ? `:${result.runnerId}` : ''}\``);
        }
        if (result.cwd || result.workspacePath) {
            metadata.push(`Workspace: \`${result.cwd || result.workspacePath}\``);
        }

        const sections = [
            `## ${title}`,
            '',
            ...metadata.map((line) => `- ${line}`),
        ];

        if (stdout) {
            sections.push('', '### STDOUT', '```text', stdout, '```');
        }
        if (stderr) {
            sections.push('', '### STDERR', '```text', stderr, '```');
        }
        if (!stdout && !stderr) {
            sections.push('', '```json', JSON.stringify(result, null, 2), '```');
        }

        return sections.join('\n');
    }

    formatRemoteAgentResult(result = {}) {
        const output = String(result.finalOutput || result.output || '').trim();
        const completionStatus = String(result.completionStatus || '').trim();
        const blocker = String(result.blocker || '').trim();
        const verifyCommands = Array.isArray(result.verifyCommands) ? result.verifyCommands.filter(Boolean) : [];
        const verifyResults = Array.isArray(result.verifyResults) ? result.verifyResults.filter(Boolean) : [];
        const metadata = [];
        if (completionStatus) {
            metadata.push(`Status: \`${completionStatus}\``);
        }
        if (result.targetId) {
            metadata.push(`Target: \`${result.targetId}\``);
        }
        if (result.cwd) {
            metadata.push(`Workspace: \`${result.cwd}\``);
        }
        if (result.sessionId) {
            metadata.push(`Remote session: \`${result.sessionId}\``);
        }
        if (result.remoteCodeJobId) {
            metadata.push(`Remote job: \`${result.remoteCodeJobId}\``);
        }
        if (result.mcpSessionId) {
            metadata.push(`MCP session: \`${result.mcpSessionId}\``);
        }
        if (result.model) {
            metadata.push(`Model: \`${result.model}\``);
        }
        if (result.publicUrl) {
            metadata.push(`Public URL: ${result.publicUrl}`);
        }
        if (blocker) {
            metadata.push(`Blocker: ${blocker}`);
        }

        const proofSections = [];
        if (result.whatChanged) {
            proofSections.push('', '### What Changed', '', String(result.whatChanged).trim());
        }
        if (verifyCommands.length > 0 || verifyResults.length > 0) {
            proofSections.push('', '### Verification', '');
            if (verifyCommands.length > 0) {
                proofSections.push(...verifyCommands.slice(0, 8).map((item) => `- Command: \`${item}\``));
            }
            if (verifyResults.length > 0) {
                proofSections.push(...verifyResults.slice(0, 8).map((item) => `- Result: ${item}`));
            }
        }

        return [
            '## Remote CLI Agent Result',
            '',
            ...metadata.map((line) => `- ${line}`),
            ...proofSections,
            ...(output
                ? ['', output]
            : ['', '```json', JSON.stringify(result, null, 2), '```']),
        ].join('\n');
    }

    resolveAsyncRemoteCommand(rest = '') {
        const trimmed = String(rest || '').trim();
        const [rawMode, ...remainingParts] = trimmed.split(/\s+/).filter(Boolean);
        const mode = String(rawMode || 'agent').toLowerCase();
        const remainder = remainingParts.join(' ').trim();

        if (!trimmed || ['help', 'plan', '?'].includes(mode)) {
            throw new Error('Usage: /remote async [agent|run|verify] <task or command>');
        }

        if (mode === 'run') {
            if (!remainder) {
                throw new Error('Usage: /remote async run <remote command>');
            }
            return {
                adapter: 'remote-command',
                task: remainder,
                targetKey: 'primary/main-server',
                toolParams: {
                    command: remainder,
                    profile: 'build',
                    workflowAction: 'web-chat-async-remote-run',
                    timeout: 120000,
                },
            };
        }

        if (mode === 'verify') {
            const command = this.buildRemoteHttpsVerifyCommand(remainder);
            return {
                adapter: 'remote-command',
                task: command,
                targetKey: 'primary/main-server',
                toolParams: {
                    command,
                    profile: 'inspect',
                    workflowAction: 'web-chat-async-remote-https-verify',
                    timeout: 60000,
                },
            };
        }

        const task = mode === 'agent' ? remainder : trimmed;
        if (!task) {
            throw new Error('Usage: /remote async agent <coding/build/deploy task>');
        }

        return {
            adapter: 'remote-cli-agent',
            task,
            targetKey: 'primary/main-server',
            toolParams: {
                task,
                waitMs: 120000,
                maxTurns: 30,
                adminMode: true,
                ...(String(uiHelpers.getCurrentModel?.() || '').trim()
                    ? { model: String(uiHelpers.getCurrentModel() || '').trim() }
                    : {}),
            },
        };
    }

    buildAsyncRemoteProgressState(run = null, events = []) {
        const normalizedEvents = Array.isArray(events) ? events : [];
        const latestEvent = normalizedEvents[normalizedEvents.length - 1] || {};
        const payload = latestEvent.payload && typeof latestEvent.payload === 'object' ? latestEvent.payload : {};
        const runStatus = String(latestEvent.status || run?.status || 'queued').trim().toLowerCase();
        const terminal = ['completed', 'cancelled', 'failed'].includes(runStatus);
        const failed = runStatus === 'failed' || latestEvent.type === 'tool_failed';
        const phase = failed
            ? 'failed'
            : (terminal ? runStatus : (latestEvent.type || runStatus || 'queued'));
        const detail = String(
            payload.message
            || payload.result?.error
            || run?.metadata?.toolResult?.error
            || (terminal ? 'Async remote job finished.' : 'Async remote job is running.'),
        ).trim();
        const eventTypes = new Set(normalizedEvents.map((event) => String(event?.type || '').trim()));
        const hasLease = eventTypes.has('started') || eventTypes.has('lease_recovered');
        const hasToolStarted = eventTypes.has('tool_started') || eventTypes.has('tool_message');
        const hasToolEnded = eventTypes.has('tool_completed') || eventTypes.has('tool_failed') || eventTypes.has('tool_skipped');
        const stepState = (id) => {
            if (failed) {
                if (id === 'complete') return 'failed';
                if (id === 'queued' && eventTypes.has('queued')) return 'completed';
                if (id === 'lease' && hasLease) return 'completed';
                if (id === 'safety' && eventTypes.has('safety')) return 'completed';
                if (id === 'tool' && hasToolStarted) return 'failed';
                if (id === 'checkpoint' && eventTypes.has('checkpoint')) {
                    return 'completed';
                }
            }
            if (id === 'queued') return eventTypes.has('queued') ? 'completed' : 'in_progress';
            if (id === 'lease') {
                if (hasLease) return 'completed';
                return eventTypes.has('queued') ? 'in_progress' : 'pending';
            }
            if (id === 'safety') {
                if (eventTypes.has('safety')) return 'completed';
                return eventTypes.has('started') ? 'in_progress' : 'pending';
            }
            if (id === 'tool') {
                if (hasToolEnded) return failed ? 'failed' : 'completed';
                return hasToolStarted ? 'in_progress' : 'pending';
            }
            if (id === 'checkpoint') {
                if (eventTypes.has('checkpoint')) return 'completed';
                return eventTypes.has('tool_completed') || eventTypes.has('tool_message') ? 'in_progress' : 'pending';
            }
            if (id === 'complete') {
                if (failed) return 'failed';
                if (runStatus === 'completed') return 'completed';
                if (runStatus === 'cancelled') return 'failed';
                return eventTypes.has('checkpoint') ? 'in_progress' : 'pending';
            }
            return 'pending';
        };

        return {
            phase,
            detail,
            summary: failed ? 'Async remote job needs attention.' : (terminal ? 'Async remote job finished.' : 'Async remote job is running.'),
            terminal,
            live: !terminal,
            steps: [
                { id: 'queued', title: 'Queue async job', status: stepState('queued') },
                { id: 'lease', title: 'Acquire worker lease', status: stepState('lease') },
                { id: 'safety', title: 'Check live remote permission', status: stepState('safety') },
                { id: 'tool', title: 'Run remote adapter', status: stepState('tool') },
                { id: 'checkpoint', title: 'Persist replay checkpoint', status: stepState('checkpoint') },
                { id: 'complete', title: 'Finish with durable result', status: stepState('complete') },
            ],
        };
    }

    updateAsyncRemoteJobMessage(sessionId = '', messageId = '', run = null, events = []) {
        const current = this.getSessionMessage(sessionId, messageId);
        if (!current) {
            return null;
        }

        const allEvents = [
            ...(Array.isArray(current.metadata?.asyncRuntimeEvents) ? current.metadata.asyncRuntimeEvents : []),
            ...(Array.isArray(events) ? events : []),
        ];
        const seen = new Set();
        const dedupedEvents = allEvents.filter((event) => {
            const key = event?.eventId || `${event?.cursor || ''}:${event?.type || ''}`;
            if (!key || seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
        const progressState = this.buildAsyncRemoteProgressState(run, dedupedEvents);
        const nextMessage = {
            ...current,
            content: '',
            isStreaming: progressState.terminal !== true,
            progressState,
            metadata: {
                ...(current.metadata || {}),
                asyncRuntimeRun: run || current.metadata?.asyncRuntimeRun || null,
                asyncRuntimeEvents: dedupedEvents.slice(-80),
                progressState,
                toolResultChip: {
                    id: run?.adapter || current.metadata?.asyncRuntimeRun?.adapter || 'async-runtime',
                    name: 'Async job',
                    icon: progressState.terminal ? 'check-circle-2' : 'loader',
                    status: run?.status || progressState.phase,
                },
            },
        };
        const saved = this.upsertSessionMessage(sessionId, nextMessage);
        if (saved && this.isVisibleSession(sessionId)) {
            const existingEl = document.getElementById(messageId);
            if (existingEl && typeof uiHelpers.updateMessageContent === 'function') {
                uiHelpers.updateMessageContent(messageId, saved, saved.isStreaming === true);
                uiHelpers.reinitializeIcons(existingEl);
            } else {
                this.renderOrReplaceMessage(saved);
            }
            uiHelpers.scrollToBottom();
        }
        this.persistSessionMessageIfNeeded(sessionId, saved || nextMessage);
        return saved || nextMessage;
    }

    connectAsyncRemoteJobEvents(sessionId = '', messageId = '', runId = '', after = 0) {
        const normalizedRunId = String(runId || '').trim();
        if (!normalizedRunId || typeof EventSource !== 'function') {
            return null;
        }
        const source = new EventSource(`/api/async-lab/runs/${encodeURIComponent(normalizedRunId)}/events?after=${encodeURIComponent(after)}&stream=true`);
        const handleEvent = (message) => {
            try {
                const event = JSON.parse(message.data);
                const current = this.getSessionMessage(sessionId, messageId);
                const currentRun = current?.metadata?.asyncRuntimeRun || { id: normalizedRunId };
                const nextRun = {
                    ...currentRun,
                    status: event.status || currentRun.status || 'running',
                };
                this.updateAsyncRemoteJobMessage(sessionId, messageId, nextRun, [event]);
                if (['completed', 'failed', 'cancelled'].includes(String(event.status || '').trim().toLowerCase())) {
                    source.close();
                }
            } catch (error) {
                console.warn('Failed to process async remote event:', error);
            }
        };

        WEB_CHAT_ASYNC_REMOTE_EVENT_TYPES.forEach((type) => {
            source.addEventListener(type, handleEvent);
        });
        source.onerror = () => {
            const current = this.getSessionMessage(sessionId, messageId);
            if (!current?.metadata?.asyncRuntimeRun?.id) {
                return;
            }
            void apiClient.getAsyncRun(current.metadata.asyncRuntimeRun.id, {
                after: Number(current.metadata.asyncRuntimeEvents?.at?.(-1)?.cursor || 0) || 0,
            }).then((payload) => {
                this.updateAsyncRemoteJobMessage(sessionId, messageId, payload.run, payload.events || []);
            }).catch((error) => {
                console.warn('Failed to refresh async remote job:', error);
            });
        };
        return source;
    }

    async createAsyncRemoteJobCard(resolved = {}, sessionId = sessionManager.currentSessionId) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            throw new Error('A chat session is required before queueing async remote work.');
        }
        const message = {
            id: uiHelpers.generateMessageId ? uiHelpers.generateMessageId() : `async-remote-${Date.now().toString(36)}`,
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            isStreaming: true,
            progressState: this.buildAsyncRemoteProgressState({
                adapter: resolved.adapter,
                status: 'queued',
                targetKey: resolved.targetKey,
            }, []),
            metadata: {
                asyncRuntimeJobCard: true,
                toolResultChip: {
                    id: resolved.adapter,
                    name: 'Async job',
                    icon: 'loader',
                    status: 'queueing',
                },
            },
        };
        const savedMessage = sessionManager.addMessage(normalizedSessionId, message);
        this.messagesContainer.appendChild(uiHelpers.renderMessage(savedMessage, true));
        uiHelpers.reinitializeIcons(this.messagesContainer);
        uiHelpers.scrollToBottom();
        this.persistSessionMessageIfNeeded(normalizedSessionId, savedMessage);

        const payload = await apiClient.createAsyncRun({
            task: resolved.task,
            adapter: resolved.adapter,
            targetKey: resolved.targetKey,
            liveRemote: true,
            sessionId: normalizedSessionId,
            idempotencyKey: `web-chat:${normalizedSessionId}:${savedMessage.id}`,
            metadata: {
                source: 'web-chat',
                toolParams: resolved.toolParams,
            },
        });
        const run = payload.run || null;
        const events = payload.events || [];
        this.updateAsyncRemoteJobMessage(normalizedSessionId, savedMessage.id, run, events);
        if (run?.id) {
            const lastCursor = Math.max(0, ...events.map((event) => Number(event?.cursor || 0) || 0));
            this.connectAsyncRemoteJobEvents(normalizedSessionId, savedMessage.id, run.id, lastCursor);
        }
        return true;
    }

    createAsyncRemoteJobCardFromRun(payload = {}, sessionId = sessionManager.currentSessionId) {
        const normalizedSessionId = String(sessionId || '').trim();
        const run = payload?.run || payload?.asyncRuntime?.run || null;
        if (!normalizedSessionId || !run?.id) {
            return null;
        }

        const events = Array.isArray(payload?.events)
            ? payload.events
            : (Array.isArray(payload?.asyncRuntime?.events) ? payload.asyncRuntime.events : []);
        const progressState = this.buildAsyncRemoteProgressState(run, events);
        const message = {
            id: uiHelpers.generateMessageId ? uiHelpers.generateMessageId() : `async-remote-${Date.now().toString(36)}`,
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            isStreaming: progressState.terminal !== true,
            progressState,
            metadata: {
                asyncRuntimeJobCard: true,
                asyncRuntimeRun: run,
                asyncRuntimeEvents: events.slice(-80),
                progressState,
                toolResultChip: {
                    id: run.adapter || 'async-runtime',
                    name: 'Async job',
                    icon: progressState.terminal ? 'check-circle-2' : 'loader',
                    status: run.status || progressState.phase,
                },
            },
        };
        const savedMessage = sessionManager.addMessage(normalizedSessionId, message);
        this.messagesContainer.appendChild(uiHelpers.renderMessage(savedMessage, savedMessage.isStreaming === true));
        uiHelpers.reinitializeIcons(this.messagesContainer);
        uiHelpers.scrollToBottom();
        this.persistSessionMessageIfNeeded(normalizedSessionId, savedMessage);

        const lastCursor = Math.max(0, ...events.map((event) => Number(event?.cursor || 0) || 0));
        this.connectAsyncRemoteJobEvents(normalizedSessionId, savedMessage.id, run.id, lastCursor);
        return savedMessage;
    }

    async handleAsyncRemoteCommand(rest = '') {
        const resolved = this.resolveAsyncRemoteCommand(rest);
        return this.createAsyncRemoteJobCard(resolved, sessionManager.currentSessionId);
    }

    shouldRouteSelectedToolMessageToAsync(content = '', options = {}) {
        const normalizedContent = String(content || '').trim();
        const metadata = options?.metadata && typeof options.metadata === 'object' ? options.metadata : {};
        const toolId = String(metadata.directToolId || metadata.preferredTool || '').trim();
        return Boolean(
            normalizedContent
            && toolId === 'remote-cli-agent'
            && metadata.selectedToolSource === 'web-chat-tool-chip'
            && metadata.asyncRuntimePreferred === true
        );
    }

    async sendSelectedToolMessageAsAsync(content = '', options = {}) {
        const normalizedContent = String(content || '').trim();
        if (!normalizedContent) {
            return false;
        }
        if (!sessionManager.currentSessionId) {
            await this.createNewSession();
        }

        const sessionId = sessionManager.currentSessionId;
        const metadata = options?.metadata && typeof options.metadata === 'object' ? options.metadata : {};
        const selectedToolChip = this.normalizeDirectToolSelection(
            metadata.selectedToolChip || metadata.selectedDirectTool || null,
        );
        uiHelpers.hideWelcomeMessage();
        const userMessage = {
            role: 'user',
            content: normalizedContent,
            timestamp: new Date().toISOString(),
            ...(selectedToolChip ? { metadata: { selectedToolChip } } : {}),
        };
        const savedUserMessage = sessionManager.addMessage(sessionId, userMessage);
        this.messagesContainer.appendChild(uiHelpers.renderMessage(savedUserMessage));
        uiHelpers.playAcknowledgementCue?.();
        uiHelpers.scrollToBottom();
        this.persistSessionMessageIfNeeded(sessionId, savedUserMessage);

        const resolved = this.resolveAsyncRemoteCommand(`agent ${normalizedContent}`);
        await this.createAsyncRemoteJobCard(resolved, sessionId);
        this.updateSessionInfo();
        return true;
    }

    async handleRemoteCommand(argString = '') {
        if (!sessionManager.currentSessionId) {
            await this.createNewSession();
        }

        const sessionId = sessionManager.currentSessionId;
        const trimmed = String(argString || '').trim();
        const [rawSubcommand, ...restParts] = trimmed.split(/\s+/).filter(Boolean);
        const subcommand = String(rawSubcommand || 'plan').toLowerCase();
        const rest = restParts.join(' ').trim();

        uiHelpers.hideWelcomeMessage();
        const userMessage = {
            role: 'user',
            content: `/remote${trimmed ? ` ${trimmed}` : ''}`,
            timestamp: new Date().toISOString(),
        };
        sessionManager.addMessage(sessionId, userMessage);
        this.messagesContainer.appendChild(uiHelpers.renderMessage(userMessage));
        uiHelpers.scrollToBottom();

        try {
            let assistantContent = '';

            if (subcommand === 'plan' || subcommand === 'help' || subcommand === '?') {
                assistantContent = this.buildRemotePlanContent();
            } else if (subcommand === 'async') {
                await this.handleAsyncRemoteCommand(rest);
                this.updateSessionInfo();
                return true;
            } else {
                const remoteCatalog = await apiClient.getRemoteToolCatalog();

                if (subcommand === 'status') {
                    assistantContent = this.formatRemoteStatus(remoteCatalog);
                } else if (subcommand === 'tools') {
                    assistantContent = this.formatRemoteTools(remoteCatalog);
                } else if (subcommand === 'run') {
                    if (!rest) {
                        throw new Error('Usage: /remote run <command>');
                    }
                    const invocation = await apiClient.invokeRemoteCommand(rest, {
                        profile: 'build',
                        workflowAction: 'web-chat-remote-manual-run',
                        timeout: 120000,
                    });
                    if (invocation?.sessionId) {
                        this.syncBackendSession(invocation.sessionId);
                    }
                    assistantContent = this.formatRemoteResult(this.unwrapRemoteResult(invocation));
                } else if (subcommand === 'agent') {
                    if (!rest) {
                        throw new Error('Usage: /remote agent <coding/build/deploy task>');
                    }
                    const invocation = await apiClient.invokeRemoteCliAgent(rest, this.buildRemoteAgentOptions(remoteCatalog));
                    if (invocation?.sessionId) {
                        this.syncBackendSession(invocation.sessionId);
                    }
                    assistantContent = this.formatRemoteAgentResult(this.unwrapRemoteResult(invocation));
                } else if (subcommand === 'verify') {
                    const command = this.buildRemoteHttpsVerifyCommand(rest);
                    const invocation = await apiClient.invokeRemoteCommand(command, {
                        profile: 'inspect',
                        workflowAction: 'web-chat-remote-https-verify',
                        timeout: 60000,
                    });
                    if (invocation?.sessionId) {
                        this.syncBackendSession(invocation.sessionId);
                    }
                    assistantContent = this.formatRemoteResult(this.unwrapRemoteResult(invocation), 'Remote HTTPS Verify');
                } else {
                    if (this.shouldRouteRemoteSubcommandToAgent(subcommand, rest, remoteCatalog)) {
                        const invocation = await apiClient.invokeRemoteCliAgent(trimmed, this.buildRemoteAgentOptions(remoteCatalog));
                        if (invocation?.sessionId) {
                            this.syncBackendSession(invocation.sessionId);
                        }
                        assistantContent = this.formatRemoteAgentResult(this.unwrapRemoteResult(invocation));
                    } else {
                        const catalogEntry = this.resolveRemoteCatalogEntry(remoteCatalog.catalog, subcommand);
                        if (!catalogEntry) {
                            throw new Error('Usage: /remote status | /remote tools | /remote plan | /remote <catalog-id> | /remote run <command> | /remote agent <task> | /remote verify [host]');
                        }
                        const command = String(catalogEntry.command || '').trim();
                        if (!command) {
                            throw new Error(`Remote catalog entry '${catalogEntry.id || subcommand}' has no command.`);
                        }
                        const invocation = await apiClient.invokeRemoteCommand(command, {
                            profile: catalogEntry.profile || 'inspect',
                            workflowAction: `web-chat-remote-${catalogEntry.id || subcommand}`,
                            timeout: 120000,
                        });
                        if (invocation?.sessionId) {
                            this.syncBackendSession(invocation.sessionId);
                        }
                        assistantContent = this.formatRemoteResult(
                            this.unwrapRemoteResult(invocation),
                            `Remote ${catalogEntry.label || catalogEntry.id || subcommand}`,
                        );
                    }
                }
            }

            const assistantMessage = {
                role: 'assistant',
                content: assistantContent,
                timestamp: new Date().toISOString(),
            };
            sessionManager.addMessage(sessionId, assistantMessage);
            this.messagesContainer.appendChild(uiHelpers.renderMessage(assistantMessage));
            uiHelpers.reinitializeIcons(this.messagesContainer);
            uiHelpers.scrollToBottom();
            this.updateSessionInfo();
        } catch (error) {
            const assistantMessage = {
                role: 'assistant',
                content: `**Remote CLI error:** ${error.message}`,
                timestamp: new Date().toISOString(),
            };
            sessionManager.addMessage(sessionId, assistantMessage);
            this.messagesContainer.appendChild(uiHelpers.renderMessage(assistantMessage));
            uiHelpers.scrollToBottom();
            this.updateSessionInfo();
        }
    }

    /**
     * Handle the /image command with optional --unsplash flag
     * Examples:
     *   /image a beautiful sunset - opens modal with prompt
     *   /image --unsplash sunset - searches Unsplash directly
     */
    handleImageCommand(args) {
        if (!args) {
            uiHelpers.openImageModal();
            return;
        }

        // Check for --unsplash flag
        const unsplashMatch = args.match(/^--unsplash\s+(.+)$/i);
        if (unsplashMatch) {
            const query = unsplashMatch[1].trim();
            this.searchUnsplashImages(query);
            return;
        }

        void this.generateImage({
            prompt: args,
            source: 'generate',
        });
    }

    /**
     * Search for images on Unsplash and display results
     * @param {string} query - Search query
     */
    async searchUnsplashImages(query) {
        if (!query) {
            uiHelpers.showToast('Please provide a search query', 'warning');
            return;
        }

        // Check if we need to create a session
        if (!sessionManager.currentSessionId) {
            await this.createNewSession();
        }
        
        const sessionId = sessionManager.currentSessionId;
        
        // Hide welcome message
        uiHelpers.hideWelcomeMessage();
        
        // Add user message with the search query
        const userMessage = {
            role: 'user',
            content: `/unsplash ${query}`,
            clientOnly: true,
            excludeFromTranscript: true,
            timestamp: new Date().toISOString()
        };
        
        const savedUserMessage = sessionManager.addMessage(sessionId, userMessage);
        
        const userMessageEl = uiHelpers.renderMessage(savedUserMessage);
        this.messagesContainer.appendChild(userMessageEl);
        uiHelpers.scrollToBottom();
        void sessionManager.syncMessagesToBackend(sessionId, [savedUserMessage]);
        
        // Create placeholder for search results
        const searchMessageId = uiHelpers.generateMessageId();
        this.currentImageMessageId = searchMessageId;
        
        const searchMessage = {
            id: searchMessageId,
            role: 'assistant',
            type: 'unsplash-search',
            content: `Unsplash options for "${query}"`,
            query: query,
            isLoading: true,
            loadingText: 'Searching Unsplash...',
            currentPage: 1,
            perPage: 9,
            clientOnly: true,
            excludeFromTranscript: true,
            timestamp: new Date().toISOString()
        };
        
        const savedSearchMessage = sessionManager.addMessage(sessionId, searchMessage);
        
        const searchMessageEl = uiHelpers.renderUnsplashSearchMessage(savedSearchMessage);
        this.messagesContainer.appendChild(searchMessageEl);
        uiHelpers.reinitializeIcons(searchMessageEl);
        uiHelpers.scrollToBottom();
        void sessionManager.syncMessageToBackend(sessionId, savedSearchMessage);
        
        this.isGeneratingImage = true;
        
        try {
            // Call the Unsplash search API
            const result = await apiClient.searchUnsplash(query, { page: 1, perPage: 9 });
            const totalPages = result.totalPages || result.total_pages || 1;
            const nextMessage = this.upsertSessionMessage(sessionId, {
                id: searchMessageId,
                role: 'assistant',
                type: 'unsplash-search',
                content: `Unsplash options for "${result.query || query}"`,
                query: result.query || query,
                isLoading: false,
                results: Array.isArray(result.results) ? result.results : [],
                total: result.total || 0,
                totalPages,
                currentPage: 1,
                perPage: 9,
                clientOnly: true,
                excludeFromTranscript: true,
                timestamp: new Date().toISOString()
            });

            this.renderOrReplaceMessage(nextMessage || searchMessage);
            if (nextMessage) {
                void sessionManager.syncMessageToBackend(sessionId, nextMessage);
            }
            
            uiHelpers.showToast(`Found ${(result.results || []).length} images on Unsplash`, 'success');
            
        } catch (error) {
            console.error('Unsplash search failed:', error);
            
            const failedMessage = this.upsertSessionMessage(sessionId, {
                id: searchMessageId,
                role: 'assistant',
                type: 'unsplash-search',
                content: `Unsplash options for "${query}"`,
                query,
                isLoading: false,
                currentPage: 1,
                perPage: 9,
                error: error.message || 'Failed to search Unsplash',
                clientOnly: true,
                excludeFromTranscript: true,
                timestamp: new Date().toISOString()
            });

            this.renderOrReplaceMessage(failedMessage || searchMessage);
            if (failedMessage) {
                void sessionManager.syncMessageToBackend(sessionId, failedMessage);
            }
            
            uiHelpers.showToast(error.message || 'Failed to search Unsplash', 'error');
        } finally {
            this.isGeneratingImage = false;
            this.currentImageMessageId = null;
            this.updateSessionInfo();
            uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
        }
    }

    /**
     * Select an Unsplash image and add it to the chat
     * @param {string} messageId - The message ID containing the search results
     * @param {Object} image - The selected image data
     */
    async selectUnsplashImage(messageId, imageOrIndex) {
        const sessionId = sessionManager.currentSessionId;
        if (!sessionId) return;

        const image = typeof imageOrIndex === 'number'
            ? this.getSelectionItem(messageId, imageOrIndex)
            : imageOrIndex;
        if (!image) return;
        
        // Create a new message with the selected image
        const imageMessageId = uiHelpers.generateMessageId();
        
        const imageMessage = {
            id: imageMessageId,
            role: 'assistant',
            type: 'image',
            content: image.description || image.altDescription || 'Unsplash image',
            imageUrl: image.urls.regular,
            thumbnailUrl: image.urls.small,
            prompt: image.description || image.altDescription || 'Unsplash image',
            source: 'unsplash',
            author: image.author,
            unsplashLink: image.links.html,
            clientOnly: true,
            excludeFromTranscript: true,
            timestamp: new Date().toISOString()
        };
        
        const savedImageMessage = sessionManager.addMessage(sessionId, imageMessage);
        
        const imageMessageEl = uiHelpers.renderImageMessage(savedImageMessage);
        this.messagesContainer.appendChild(imageMessageEl);
        uiHelpers.reinitializeIcons(imageMessageEl);
        uiHelpers.scrollToBottom();
        void sessionManager.syncMessagesToBackend(sessionId, [savedImageMessage]);
        
        uiHelpers.showToast('Image added to conversation', 'success');
        this.updateSessionInfo();
        uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
    }

    selectGeneratedImage(messageId, index) {
        const sessionId = sessionManager.currentSessionId;
        if (!sessionId) return;

        const message = this.getSessionMessage(sessionId, messageId);
        const image = this.getSelectionItem(messageId, index);
        if (!message || !image?.imageUrl) return;

        const sourceKind = image.source || message.sourceKind || 'generated';
        const isArtifact = sourceKind === 'artifact';

        const imageMessage = {
            id: uiHelpers.generateMessageId(),
            role: 'assistant',
            type: 'image',
            content: image.alt || image.prompt || message.prompt || (isArtifact ? 'Captured image' : 'Generated image'),
            imageUrl: image.imageUrl,
            thumbnailUrl: image.thumbnailUrl || image.imageUrl,
            prompt: image.alt || image.prompt || message.prompt || (isArtifact ? 'Captured image' : 'Generated image'),
            revisedPrompt: image.revisedPrompt || '',
            model: isArtifact ? '' : (image.model || message.model || ''),
            source: isArtifact ? 'artifact' : 'generated',
            downloadUrl: image.downloadUrl || '',
            artifactId: image.artifactId || '',
            filename: image.filename || '',
            sourceHost: image.sourceHost || message.sourceHost || '',
            clientOnly: true,
            excludeFromTranscript: true,
            timestamp: new Date().toISOString()
        };

        const savedImageMessage = sessionManager.addMessage(sessionId, imageMessage);
        this.messagesContainer.appendChild(uiHelpers.renderImageMessage(savedImageMessage));
        uiHelpers.reinitializeIcons(this.messagesContainer.lastElementChild);
        uiHelpers.scrollToBottom();
        void sessionManager.syncMessagesToBackend(sessionId, [savedImageMessage]);

        uiHelpers.showToast('Image added to conversation', 'success');
        this.updateSessionInfo();
        uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
    }

    selectAllGeneratedImages(messageId) {
        const sessionId = sessionManager.currentSessionId;
        if (!sessionId) return;

        const message = this.getSessionMessage(sessionId, messageId);
        const results = Array.isArray(message?.results) ? message.results : [];
        const nextMessages = results
            .filter((image) => image?.imageUrl)
            .map((image) => {
                const sourceKind = image.source || message.sourceKind || 'generated';
                const isArtifact = sourceKind === 'artifact';

                return {
                    id: uiHelpers.generateMessageId(),
                    role: 'assistant',
                    type: 'image',
                    content: image.alt || image.prompt || message.prompt || (isArtifact ? 'Captured image' : 'Generated image'),
                    imageUrl: image.imageUrl,
                    thumbnailUrl: image.thumbnailUrl || image.imageUrl,
                    prompt: image.alt || image.prompt || message.prompt || (isArtifact ? 'Captured image' : 'Generated image'),
                    revisedPrompt: image.revisedPrompt || '',
                    model: isArtifact ? '' : (image.model || message.model || ''),
                    source: isArtifact ? 'artifact' : 'generated',
                    downloadUrl: image.downloadUrl || '',
                    artifactId: image.artifactId || '',
                    filename: image.filename || '',
                    sourceHost: image.sourceHost || message.sourceHost || '',
                    clientOnly: true,
                    excludeFromTranscript: true,
                    timestamp: new Date().toISOString()
                };
            });

        if (nextMessages.length === 0) {
            return;
        }

        nextMessages.forEach((imageMessage) => {
            const savedImageMessage = sessionManager.addMessage(sessionId, imageMessage);
            this.messagesContainer.appendChild(uiHelpers.renderImageMessage(savedImageMessage));
            uiHelpers.reinitializeIcons(this.messagesContainer.lastElementChild);
        });

        uiHelpers.scrollToBottom();
        void sessionManager.syncMessagesToBackend(sessionId, nextMessages);
        uiHelpers.showToast(`${nextMessages.length} images added to conversation`, 'success');
        this.updateSessionInfo();
        uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
    }

    async loadUnsplashPage(messageId, page) {
        const sessionId = sessionManager.currentSessionId;
        if (!sessionId || !Number.isFinite(page) || page < 1) return;

        const currentMessage = this.getSessionMessage(sessionId, messageId);
        if (!currentMessage?.query) return;

        const perPage = currentMessage.perPage || 9;
        const totalPages = currentMessage.totalPages || 1;
        if (page > totalPages) return;

        const loadingMessage = this.upsertSessionMessage(sessionId, {
            id: messageId,
            isLoading: true,
            loadingText: `Loading page ${page}...`,
            error: null,
            currentPage: page,
            clientOnly: true,
            excludeFromTranscript: true,
            timestamp: new Date().toISOString()
        });
        this.renderOrReplaceMessage(loadingMessage || currentMessage);
        if (loadingMessage) {
            void sessionManager.syncMessageToBackend(sessionId, loadingMessage);
        }

        try {
            const result = await apiClient.searchUnsplash(currentMessage.query, {
                page,
                perPage,
                orientation: currentMessage.orientation || null,
            });

            const nextMessage = this.upsertSessionMessage(sessionId, {
                id: messageId,
                role: 'assistant',
                type: 'unsplash-search',
                content: `Unsplash options for "${result.query || currentMessage.query}"`,
                query: result.query || currentMessage.query,
                isLoading: false,
                results: Array.isArray(result.results) ? result.results : [],
                total: result.total || 0,
                totalPages: result.totalPages || result.total_pages || totalPages,
                currentPage: page,
                perPage,
                orientation: currentMessage.orientation || null,
                error: null,
                clientOnly: true,
                excludeFromTranscript: true,
                timestamp: new Date().toISOString()
            });

            this.renderOrReplaceMessage(nextMessage || currentMessage);
            if (nextMessage) {
                void sessionManager.syncMessageToBackend(sessionId, nextMessage);
            }
        } catch (error) {
            const failedMessage = this.upsertSessionMessage(sessionId, {
                id: messageId,
                isLoading: false,
                currentPage: currentMessage.currentPage || 1,
                error: error.message || 'Failed to load Unsplash results',
                clientOnly: true,
                excludeFromTranscript: true,
                timestamp: new Date().toISOString()
            });
            this.renderOrReplaceMessage(failedMessage || currentMessage);
            if (failedMessage) {
                void sessionManager.syncMessageToBackend(sessionId, failedMessage);
            }
            uiHelpers.showToast(error.message || 'Failed to load Unsplash results', 'error');
        }
    }

    useSearchResult(messageId, index) {
        const result = this.getSelectionItem(messageId, index);
        if (!result?.url) return;

        this.setInput(`Use this page as a source for the next answer:\n${result.url}`);
        uiHelpers.showToast('Page added to the input', 'success');
    }

    openSearchResult(messageId, index) {
        const result = this.getSelectionItem(messageId, index);
        if (!result?.url) return;

        window.open(result.url, '_blank', 'noopener,noreferrer');
    }

    getSessionMessage(sessionId, messageId) {
        if (!sessionId || !messageId) {
            return null;
        }

        if (typeof sessionManager.getMessage === 'function') {
            return sessionManager.getMessage(sessionId, messageId);
        }

        return sessionManager.getMessages(sessionId).find((message) => message.id === messageId) || null;
    }

    getSelectionItem(messageId, index, key = 'results') {
        if (!Number.isInteger(index)) {
            return null;
        }

        const sessionId = sessionManager.currentSessionId;
        const message = this.getSessionMessage(sessionId, messageId);
        const items = Array.isArray(message?.[key]) ? message[key] : [];
        return items[index] || null;
    }

    upsertSessionMessage(sessionId, message) {
        if (typeof sessionManager.upsertMessage === 'function') {
            return sessionManager.upsertMessage(sessionId, message);
        }

        const messages = sessionManager.getMessages(sessionId);
        const index = message?.id
            ? messages.findIndex((entry) => entry.id === message.id)
            : -1;

        if (index === -1) {
            return sessionManager.addMessage(sessionId, message);
        }

        messages[index] = {
            ...messages[index],
            ...message,
        };
        sessionManager.saveToStorage();
        return messages[index];
    }

    patchMessageAlignmentFeedback(sessionId, messageId, patch = {}) {
        const currentMessage = this.getSessionMessage(sessionId, messageId);
        if (!currentMessage || currentMessage.role !== 'assistant') {
            return null;
        }

        const nextMessage = {
            ...currentMessage,
            metadata: {
                ...(currentMessage.metadata || {}),
                alignmentFeedback: {
                    ...(currentMessage.metadata?.alignmentFeedback || {}),
                    ...(patch || {}),
                    updatedAt: patch.updatedAt || new Date().toISOString(),
                },
            },
        };
        const savedMessage = this.upsertSessionMessage(sessionId, nextMessage);
        if (savedMessage && this.isVisibleSession(sessionId)) {
            uiHelpers.updateMessageContent(messageId, savedMessage, savedMessage.isStreaming === true);
            const messageEl = document.getElementById(messageId);
            if (messageEl) {
                uiHelpers.reinitializeIcons(messageEl);
            }
        }
        return savedMessage || nextMessage;
    }

    async submitAlignmentFeedback(messageId = '', rating = '') {
        const sessionId = sessionManager.currentSessionId;
        const normalizedMessageId = String(messageId || '').trim();
        const normalizedRating = String(rating || '').trim().toLowerCase();
        if (!sessionId || !normalizedMessageId || !['up', 'down'].includes(normalizedRating)) {
            return;
        }

        const currentMessage = this.getSessionMessage(sessionId, normalizedMessageId);
        if (!currentMessage || currentMessage.role !== 'assistant') {
            uiHelpers.showToast('Could not find that assistant response', 'error');
            return;
        }
        if (['up', 'down'].includes(String(currentMessage.metadata?.alignmentFeedback?.rating || '').trim())) {
            return;
        }

        const reason = normalizedRating === 'down'
            ? this.promptForAlignmentIssue()
            : '';
        if (normalizedRating === 'down' && reason === null) {
            return;
        }

        const optimisticStatus = normalizedRating === 'up' ? 'recorded' : 'evaluating';
        this.patchMessageAlignmentFeedback(sessionId, normalizedMessageId, {
            rating: normalizedRating,
            status: optimisticStatus,
            ...(reason ? { reason } : {}),
        });
        uiHelpers.showToast(normalizedRating === 'up' ? 'Marked aligned' : 'Reviewing alignment', normalizedRating === 'up' ? 'success' : 'info');

        try {
            const response = await apiClient.submitAlignmentFeedback(sessionId, normalizedMessageId, {
                rating: normalizedRating,
                reason: reason || '',
            });
            const data = response?.data || {};
            const serverMessage = data.message && typeof data.message === 'object'
                ? data.message
                : null;

            if (serverMessage) {
                const savedMessage = this.upsertSessionMessage(sessionId, {
                    ...currentMessage,
                    ...serverMessage,
                    metadata: {
                        ...(currentMessage.metadata || {}),
                        ...(serverMessage.metadata || {}),
                    },
                });
                if (savedMessage && this.isVisibleSession(sessionId)) {
                    uiHelpers.updateMessageContent(normalizedMessageId, savedMessage, savedMessage.isStreaming === true);
                    const messageEl = document.getElementById(normalizedMessageId);
                    if (messageEl) {
                        uiHelpers.reinitializeIcons(messageEl);
                    }
                }
            } else {
                this.patchMessageAlignmentFeedback(sessionId, normalizedMessageId, {
                    rating: normalizedRating,
                    status: data.status || (normalizedRating === 'up' ? 'recorded' : 'completed'),
                    feedbackId: data.feedbackId || '',
                    evaluationId: data.feedbackId || '',
                    evaluation: data.evaluation || null,
                });
            }

            if (normalizedRating === 'up') {
                uiHelpers.showToast('Confetti yaa, alignment registered', 'success', 'Aligned');
                uiHelpers.showAlignmentConfetti?.();
            } else {
                uiHelpers.showToast('Alignment review saved', 'success');
            }
        } catch (error) {
            console.error('Alignment feedback failed:', error);
            this.patchMessageAlignmentFeedback(sessionId, normalizedMessageId, {
                rating: normalizedRating,
                status: 'failed',
            });
            uiHelpers.showToast('Alignment review failed', 'error');
        }
    }

    promptForAlignmentIssue() {
        if (typeof window === 'undefined' || typeof window.prompt !== 'function') {
            return '';
        }

        const response = window.prompt(
            'What issue should the evaluator review for alignment?',
            '',
        );
        if (response === null) {
            return null;
        }

        return String(response || '').trim().slice(0, 500);
    }

    moveSessionMessageToEnd(sessionId, messageId) {
        const normalizedSessionId = String(sessionId || '').trim();
        const normalizedMessageId = String(messageId || '').trim();
        if (!normalizedSessionId || !normalizedMessageId) {
            return null;
        }

        const messages = sessionManager.getMessages(normalizedSessionId);
        const index = messages.findIndex((entry) => entry?.id === normalizedMessageId);
        if (index < 0 || index === (messages.length - 1)) {
            return index >= 0 ? messages[index] : null;
        }

        const [message] = messages.splice(index, 1);
        messages.push(message);
        sessionManager.saveToStorage();
        return message;
    }

    persistSessionMessageIfNeeded(sessionId, message) {
        if (!sessionId || !message?.id || sessionManager.isLocalSession?.(sessionId)) {
            return;
        }

        void sessionManager.syncMessageToBackend(sessionId, message);
    }

    persistSessionMessagesIfNeeded(sessionId, messages = []) {
        if (!sessionId || sessionManager.isLocalSession?.(sessionId) || !Array.isArray(messages)) {
            return;
        }

        messages.forEach((message) => {
            this.persistSessionMessageIfNeeded(sessionId, message);
        });
    }

    renderOrReplaceMessage(message) {
        if (!message?.id) {
            return null;
        }

        const nextEl = uiHelpers.renderMessage(message);
        const existingEl = document.getElementById(message.id);

        if (existingEl) {
            existingEl.replaceWith(nextEl);
        } else {
            this.messagesContainer.appendChild(nextEl);
        }

        uiHelpers.reinitializeIcons(nextEl);
        this.updateAudioControls();
        return nextEl;
    }

    removeManagedAppProgressDuplicateElements(sessionId = '', progressKey = '', keepMessageId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        const normalizedKey = String(progressKey || '').trim();
        const keepId = String(keepMessageId || '').trim();
        if (!normalizedSessionId || !normalizedKey || !keepId) {
            return;
        }

        const messages = sessionManager.getMessages(normalizedSessionId);
        messages.forEach((message) => {
            const messageId = String(message?.id || '').trim();
            if (!messageId || messageId === keepId || message?.role !== 'assistant') {
                return;
            }

            const isManagedAppProgressCard = message?.metadata?.managedAppLifecycle === true
                || message?.metadata?.managedAppProjectSummary === true;
            if (!isManagedAppProgressCard || this.getManagedAppMessageMeta(message).key !== normalizedKey) {
                return;
            }

            const element = document.getElementById(messageId);
            if (typeof element?.remove === 'function') {
                element.remove();
            }
        });
    }

    renderManagedAppProgressMessage(sessionId = '', message = null) {
        const messageId = String(message?.id || '').trim();
        if (!messageId || !this.isVisibleSession(sessionId)) {
            return null;
        }

        const meta = this.getManagedAppMessageMeta(message);
        this.removeManagedAppProgressDuplicateElements(sessionId, meta.key, messageId);

        const existingEl = document.getElementById(messageId);
        if (existingEl && typeof uiHelpers.updateMessageContent === 'function') {
            uiHelpers.updateMessageContent(messageId, message, message.isStreaming === true);
            uiHelpers.reinitializeIcons(existingEl);
            this.updateAudioControls();
            return existingEl;
        }

        return this.renderOrReplaceMessage(message);
    }

    flushManagedAppProgressRender(messageId = '') {
        const normalizedMessageId = String(messageId || '').trim();
        if (!normalizedMessageId) {
            return false;
        }

        const entry = this.pendingManagedAppProgressRenders.get(normalizedMessageId);
        if (!entry) {
            return false;
        }

        if (entry.timer) {
            const clearTimer = typeof window?.clearTimeout === 'function'
                ? window.clearTimeout.bind(window)
                : (typeof clearTimeout === 'function' ? clearTimeout : null);
            clearTimer?.(entry.timer);
        }
        this.pendingManagedAppProgressRenders.delete(normalizedMessageId);
        return Boolean(this.renderManagedAppProgressMessage(entry.sessionId, entry.message));
    }

    scheduleManagedAppProgressRender(sessionId = '', message = null, options = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        const messageId = String(message?.id || '').trim();
        if (!normalizedSessionId || !messageId || !message || !this.isVisibleSession(normalizedSessionId)) {
            return false;
        }

        const existing = this.pendingManagedAppProgressRenders.get(messageId);
        const shouldRenderImmediately = options.immediate === true
            || message?.managedAppProgressState?.terminal === true
            || message?.metadata?.managedAppProgressState?.terminal === true
            || !document.getElementById(messageId);

        if (shouldRenderImmediately) {
            if (existing?.timer) {
                const clearTimer = typeof window?.clearTimeout === 'function'
                    ? window.clearTimeout.bind(window)
                    : (typeof clearTimeout === 'function' ? clearTimeout : null);
                clearTimer?.(existing.timer);
            }
            this.pendingManagedAppProgressRenders.delete(messageId);
            return Boolean(this.renderManagedAppProgressMessage(normalizedSessionId, message));
        }

        const scheduleTimer = typeof window?.setTimeout === 'function'
            ? window.setTimeout.bind(window)
            : (typeof setTimeout === 'function' ? setTimeout : null);
        if (!scheduleTimer) {
            return Boolean(this.renderManagedAppProgressMessage(normalizedSessionId, message));
        }

        const nextEntry = {
            sessionId: normalizedSessionId,
            message,
            timer: existing?.timer || null,
        };
        if (!nextEntry.timer) {
            nextEntry.timer = scheduleTimer(() => {
                this.flushManagedAppProgressRender(messageId);
            }, MANAGED_APP_PROGRESS_RENDER_BUFFER_MS);
        }

        this.pendingManagedAppProgressRenders.set(messageId, nextEntry);
        return true;
    }

    clearManagedAppProgressRenders() {
        const clearTimer = typeof window?.clearTimeout === 'function'
            ? window.clearTimeout.bind(window)
            : (typeof clearTimeout === 'function' ? clearTimeout : null);
        for (const entry of this.pendingManagedAppProgressRenders.values()) {
            if (entry?.timer) {
                clearTimer?.(entry.timer);
            }
        }
        this.pendingManagedAppProgressRenders.clear();
    }

    clearBufferedStreamingRenders() {
        for (const entry of this.pendingStreamingRenders.values()) {
            if (entry?.timer) {
                clearTimeout(entry.timer);
            }
        }
        this.pendingStreamingRenders.clear();
        this.clearManagedAppProgressRenders();
    }

    flushBufferedStreamingRender(messageId = '') {
        const normalizedMessageId = String(messageId || '').trim();
        if (!normalizedMessageId) {
            return false;
        }

        const entry = this.pendingStreamingRenders.get(normalizedMessageId);
        if (!entry) {
            return false;
        }

        if (entry.timer) {
            clearTimeout(entry.timer);
        }
        this.pendingStreamingRenders.delete(normalizedMessageId);
        if (!entry.message || !this.isVisibleSession(entry.sessionId)) {
            return false;
        }

        uiHelpers.updateMessageContent(normalizedMessageId, entry.message, entry.message.isStreaming === true);
        if (entry.scroll === true) {
            uiHelpers.scrollToBottom();
        }
        return true;
    }

    scheduleBufferedStreamingRender(sessionId = '', message = null, options = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        const messageId = String(message?.id || '').trim();
        if (!normalizedSessionId || !messageId || !message) {
            return false;
        }

        const existing = this.pendingStreamingRenders.get(messageId);
        const nextEntry = {
            sessionId: normalizedSessionId,
            message,
            scroll: existing?.scroll === true || options.scroll === true,
            timer: existing?.timer || null,
        };

        if (!nextEntry.timer) {
            nextEntry.timer = setTimeout(() => {
                this.flushBufferedStreamingRender(messageId);
            }, STREAM_RENDER_BUFFER_MS);
        }

        this.pendingStreamingRenders.set(messageId, nextEntry);
        return true;
    }

    parseToolArguments(rawArgs) {
        if (!rawArgs) {
            return {};
        }

        if (typeof rawArgs === 'object') {
            return rawArgs;
        }

        if (typeof rawArgs !== 'string') {
            return {};
        }

        if (typeof uiHelpers !== 'undefined' && typeof uiHelpers?.parseJsonSafely === 'function') {
            const parsed = uiHelpers.parseJsonSafely(rawArgs);
            return parsed && typeof parsed === 'object' ? parsed : {};
        }

        try {
            const parsed = JSON.parse(rawArgs);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_error) {
            return {};
        }
    }

    extractSurveyDefinition(messageContent = '', fallbackId = '') {
        return uiHelpers.extractSurveyDefinitionFromContent(messageContent, fallbackId);
    }

    parseSurveyResponseContent(messageContent = '') {
        const match = String(messageContent || '').trim().match(/^Survey response \(([^)]+)\):\s*([\s\S]+)$/i);
        if (!match) {
            return null;
        }

        return {
            checkpointId: String(match[1] || '').trim(),
            summary: String(match[2] || '').trim(),
        };
    }

    extractSurveySelectedLabels(summary = '') {
        return Array.from(String(summary || '').matchAll(/"([^"]+)"/g))
            .map((match) => String(match[1] || '').trim())
            .filter(Boolean);
    }

    extractSurveySelectedOptionIds(summary = '', surveyOptions = []) {
        const options = Array.isArray(surveyOptions) ? surveyOptions : [];
        const matches = Array.from(String(summary || '').matchAll(/"([^"]+)"(?:\s*\[([^\]]+)\])?/g));

        return Array.from(new Set(matches
            .map((match) => {
                const explicitId = String(match[2] || '').trim();
                if (explicitId) {
                    return explicitId;
                }

                const label = String(match[1] || '').trim();
                return options.find((option) => option?.label === label)?.id || '';
            })
            .filter(Boolean)));
    }

    extractSurveyNotes(summary = '') {
        const match = String(summary || '').match(/Notes:\s*([\s\S]+)$/i);
        return match?.[1] ? String(match[1]).trim() : '';
    }

    collectSurveyStepResponseFromCard(card, step = {}) {
        if (!card || !step || typeof step !== 'object') {
            return {};
        }

        const inputType = String(step.inputType || card.dataset.stepInputType || 'choice').trim();
        if (inputType === 'choice' || inputType === 'multi-choice') {
            const selectedOptions = Array.from(card.querySelectorAll('.agent-survey-option.is-selected'))
                .map((option) => ({
                    id: String(option.dataset.optionId || '').trim(),
                    label: String(option.dataset.optionLabel || '').trim(),
                }))
                .filter((option) => option.label);
            const text = String(card.querySelector('.agent-survey-card__notes')?.value || '').trim();

            return {
                selectedOptionIds: selectedOptions.map((option) => option.id),
                selectedLabels: selectedOptions.map((option) => option.label),
                text,
            };
        }

        const value = String(card.querySelector('.agent-survey-card__input')?.value || '').trim();
        return {
            value,
            text: value,
        };
    }

    hasSurveyStepResponseData(response = null) {
        if (!response || typeof response !== 'object') {
            return false;
        }

        const selectedOptionIds = Array.isArray(response.selectedOptionIds)
            ? response.selectedOptionIds.filter(Boolean)
            : [];
        const selectedLabels = Array.isArray(response.selectedLabels)
            ? response.selectedLabels.filter(Boolean)
            : [];
        const text = String(response.text || '').trim();
        const value = String(response.value || '').trim();

        return selectedOptionIds.length > 0
            || selectedLabels.length > 0
            || Boolean(text)
            || Boolean(value);
    }

    buildSurveyStatePayload({ survey = null, checkpointId = '', status = 'draft', currentStepIndex = 0, stepResponses = {}, summary = '' } = {}) {
        const steps = Array.isArray(survey?.steps) ? survey.steps : [];
        const safeStepResponses = stepResponses && typeof stepResponses === 'object'
            ? stepResponses
            : {};
        const firstStep = steps[0] || null;
        const firstStepResponse = firstStep
            ? (safeStepResponses[firstStep.id] || null)
            : null;

        return {
            status,
            checkpointId,
            currentStepIndex: Math.max(0, Number(currentStepIndex) || 0),
            stepResponses: safeStepResponses,
            ...(summary ? { summary } : {}),
            selectedOptionIds: Array.isArray(firstStepResponse?.selectedOptionIds)
                ? firstStepResponse.selectedOptionIds
                : [],
            selectedLabels: Array.isArray(firstStepResponse?.selectedLabels)
                ? firstStepResponse.selectedLabels
                : [],
            notes: String(firstStepResponse?.text || '').trim(),
        };
    }

    buildSurveyFenceContent(checkpoint = null) {
        if (!checkpoint || typeof checkpoint !== 'object') {
            return '';
        }

        try {
            return `\`\`\`survey\n${JSON.stringify(checkpoint, null, 2)}\n\`\`\``;
        } catch (_error) {
            return '';
        }
    }

    getSessionRecord(sessionId) {
        if (!sessionId) {
            return null;
        }

        return sessionManager.sessions.find((session) => session.id === sessionId) || null;
    }

    getPendingSurveyCheckpoint(sessionId = '') {
        return uiHelpers.normalizeSurveyDefinition(
            this.getSessionRecord(sessionId)?.controlState?.userCheckpoint?.pending || null,
        );
    }

    isMatchingPendingSurveyCheckpoint(sessionId = '', checkpointId = '') {
        const normalizedCheckpointId = String(checkpointId || '').trim();
        if (!normalizedCheckpointId) {
            return false;
        }

        return this.getPendingSurveyCheckpoint(sessionId)?.id === normalizedCheckpointId;
    }

    releasePendingSurveyProcessingGate(sessionId = '', checkpointId = '') {
        if (!this.isSessionProcessing(sessionId)
            || !this.isMatchingPendingSurveyCheckpoint(sessionId, checkpointId)) {
            return false;
        }

        this.finishSessionStream(sessionId);
        return true;
    }

    buildSyntheticSurveyMessageId(checkpointId = '') {
        const normalizedId = String(checkpointId || '').trim().replace(/[^a-z0-9_-]/gi, '-');
        return `synthetic-user-checkpoint-${normalizedId || 'pending'}`;
    }

    isSurveyDisplayContent(value = '') {
        return /```(?:survey|kb-survey)\s*[\s\S]*?```/i.test(String(value || ''));
    }

    normalizeToolEventName(value = '') {
        return String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    }

    getToolCallName(item = {}, fallbackName = '') {
        return String(
            item?.function?.name
            || item?.name
            || item?.toolName
            || item?.tool_name
            || fallbackName
            || '',
        ).trim();
    }

    getToolEventName(event = {}) {
        const item = event?.item || event?.toolCall || event?.tool_call || event || {};
        return this.getToolCallName(
            item,
            event?.toolName
                || event?.tool_name
                || event?.result?.toolId
                || event?.result?.tool_id
                || event?.toolCall?.function?.name
                || event?.tool_call?.function?.name
                || '',
        );
    }

    isUserCheckpointToolName(name = '') {
        return this.normalizeToolEventName(name) === 'user-checkpoint';
    }

    getToolCallBufferKey(item = {}, fallbackName = '') {
        const rawIndex = Number(item?.index);
        if (Number.isInteger(rawIndex) && rawIndex >= 0) {
            return `index:${rawIndex}`;
        }

        const explicitId = String(
            item?.id
            || item?.call_id
            || item?.callId
            || item?.tool_call_id
            || item?.toolCallId
            || '',
        ).trim();
        if (explicitId) {
            return `id:${explicitId}`;
        }

        return `tool:${this.normalizeToolEventName(this.getToolCallName(item, fallbackName) || fallbackName || 'tool')}`;
    }

    getToolCallArguments(item = {}, event = {}) {
        return item?.function?.arguments
            ?? item?.arguments
            ?? item?.args
            ?? item?.input
            ?? item?.parameters
            ?? event?.arguments
            ?? event?.args
            ?? event?.input
            ?? event?.parameters
            ?? null;
    }

    normalizeCheckpointDefinition(value = null, fallbackId = '') {
        if (typeof uiHelpers !== 'undefined' && typeof uiHelpers?.normalizeSurveyDefinition === 'function') {
            return uiHelpers.normalizeSurveyDefinition(value, fallbackId);
        }

        if (!value || typeof value !== 'object') {
            return null;
        }

        const options = Array.isArray(value.options) ? value.options : [];
        if (!String(value.question || '').trim() || options.length < 2) {
            return null;
        }

        return {
            id: String(value.id || fallbackId || `checkpoint-${Date.now().toString(36)}`).trim(),
            question: String(value.question || '').trim(),
            options,
            steps: [{
                id: String(value.id || fallbackId || 'checkpoint-step').trim(),
                question: String(value.question || '').trim(),
                inputType: value.inputType || 'choice',
                options,
            }],
            inputType: value.inputType || 'choice',
            allowMultiple: value.allowMultiple === true,
            maxSelections: Number(value.maxSelections || 1) > 0 ? Number(value.maxSelections || 1) : 1,
            allowFreeText: value.allowFreeText === true,
        };
    }

    extractCheckpointFromToolEventResult(event = {}) {
        if (event?.result?.success === false) {
            return null;
        }

        const data = event?.result?.data || {};
        const checkpoint = data.checkpoint && typeof data.checkpoint === 'object'
            ? data.checkpoint
            : (data && typeof data === 'object' ? data : null);

        return this.normalizeCheckpointDefinition(checkpoint);
    }

    extractCheckpointFromToolEventChunk(event = {}) {
        const item = event?.item || event?.toolCall || event?.tool_call || event || {};
        const bufferKey = this.getToolCallBufferKey(item, this.getToolEventName(event));
        const buffered = this.pendingCheckpointToolCallBuffers?.get(bufferKey) || null;
        const toolName = this.getToolEventName(event) || buffered?.toolName || '';

        if (!this.isUserCheckpointToolName(toolName)) {
            return null;
        }

        const resultCheckpoint = this.extractCheckpointFromToolEventResult(event);
        if (resultCheckpoint) {
            this.pendingCheckpointToolCallBuffers?.delete(bufferKey);
            return resultCheckpoint;
        }

        const rawArgs = this.getToolCallArguments(item, event);
        if (rawArgs == null || rawArgs === '') {
            this.pendingCheckpointToolCallBuffers?.set(bufferKey, {
                toolName,
                rawArguments: buffered?.rawArguments || '',
            });
            return null;
        }

        if (typeof rawArgs === 'object') {
            const checkpoint = this.normalizeCheckpointDefinition(rawArgs);
            if (checkpoint) {
                this.pendingCheckpointToolCallBuffers?.delete(bufferKey);
                return checkpoint;
            }
            return null;
        }

        const nextRawArguments = `${buffered?.rawArguments || ''}${String(rawArgs || '')}`;
        this.pendingCheckpointToolCallBuffers?.set(bufferKey, {
            toolName,
            rawArguments: nextRawArguments,
        });

        const parsedArgs = this.parseToolArguments(nextRawArguments);
        const checkpoint = this.normalizeCheckpointDefinition(parsedArgs);
        if (!checkpoint) {
            return null;
        }

        this.pendingCheckpointToolCallBuffers?.delete(bufferKey);
        return checkpoint;
    }

    assistantMentionsPendingSurvey(content = '') {
        return /\b(inline survey|survey card|questionnaire|popup question|multiple[- ]choice)\b/i.test(
            String(content || ''),
        );
    }

    extractCheckpointFromToolEvents(toolEvents = []) {
        const checkpointEvent = [...(Array.isArray(toolEvents) ? toolEvents : [])]
            .reverse()
            .find((event) => (
                this.isUserCheckpointToolName(this.getToolEventName(event))
                && event?.result?.success !== false
            ));

        if (!checkpointEvent) {
            return null;
        }

        return this.extractCheckpointFromToolEventResult(checkpointEvent)
            || this.extractCheckpointFromToolEventChunk(checkpointEvent);
    }

    updateLocalCheckpointControlState(sessionId, updater) {
        const session = this.getSessionRecord(sessionId);
        if (!session || typeof updater !== 'function') {
            return null;
        }

        const nextControlState = updater(session.controlState && typeof session.controlState === 'object'
            ? session.controlState
            : {});

        if (!nextControlState || typeof nextControlState !== 'object') {
            return null;
        }

        session.controlState = nextControlState;
        sessionManager.saveToStorage();
        return session;
    }

    syncLocalPendingCheckpointFromToolEvents(sessionId, toolEvents = []) {
        const checkpoint = this.extractCheckpointFromToolEvents(toolEvents);
        if (!sessionId || !checkpoint) {
            return;
        }

        this.updateLocalCheckpointControlState(sessionId, (currentControlState = {}) => {
            const currentUserCheckpoint = currentControlState?.userCheckpoint
                && typeof currentControlState.userCheckpoint === 'object'
                ? currentControlState.userCheckpoint
                : {};

            return {
                ...currentControlState,
                userCheckpoint: {
                    ...currentUserCheckpoint,
                    pending: checkpoint,
                },
            };
        });
    }

    showPendingCheckpointFromToolCall(sessionId, checkpoint = null, parentMessageId = '') {
        const normalizedCheckpoint = this.normalizeCheckpointDefinition(checkpoint);
        if (!sessionId || !normalizedCheckpoint?.id) {
            return false;
        }

        const existingPendingId = String(
            this.getSessionRecord(sessionId)?.controlState?.userCheckpoint?.pending?.id || '',
        ).trim();
        const wasAlreadyPending = existingPendingId === normalizedCheckpoint.id;
        this.restoreLocalCheckpointPending(sessionId, normalizedCheckpoint);
        this.updateLiveResponsePhase('checkpoint', 'Waiting for your checkpoint answer.');

        const messageId = String(parentMessageId || this.currentStreamingMessageId || '').trim();
        let savedMessage = null;
        if (messageId) {
            const currentMessage = this.getSessionMessage(sessionId, messageId);
            if (currentMessage?.role === 'assistant') {
                savedMessage = this.upsertSessionMessage(sessionId, {
                    ...currentMessage,
                    content: normalizedCheckpoint.preamble
                        || currentMessage.content
                        || 'Choose an option below and I will continue from there.',
                    displayContent: this.buildSurveyFenceContent(normalizedCheckpoint),
                    isStreaming: true,
                    progressState: null,
                    liveState: {
                        phase: 'checkpoint',
                        detail: 'Waiting for your checkpoint answer.',
                    },
                    metadata: {
                        ...(currentMessage.metadata || {}),
                        pendingUserCheckpointId: normalizedCheckpoint.id,
                    },
                });
            }
        }

        const messages = this.syncAnnotatedSurveyStates(sessionId);
        if (this.isVisibleSession(sessionId)) {
            this.renderMessages(messages);
            const focusMessage = savedMessage || messages.find((message) => (
                message?.role === 'assistant'
                && this.getMessageSurveyDefinition(message)?.id === normalizedCheckpoint.id
            ));
            if (focusMessage && !wasAlreadyPending) {
                this.presentAssistantMessage(focusMessage, [{ toolName: 'user-checkpoint' }]);
            }
            this.updateSessionInfo();
            uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
        }

        return true;
    }

    markLocalCheckpointAnswered(sessionId, checkpointId = '', summary = '') {
        const normalizedCheckpointId = String(checkpointId || '').trim();
        if (!sessionId || !normalizedCheckpointId) {
            return;
        }

        this.updateLocalCheckpointControlState(sessionId, (currentControlState = {}) => {
            const currentUserCheckpoint = currentControlState?.userCheckpoint
                && typeof currentControlState.userCheckpoint === 'object'
                ? currentControlState.userCheckpoint
                : {};
            const pendingCheckpointId = String(currentUserCheckpoint?.pending?.id || '').trim();

            if (pendingCheckpointId && pendingCheckpointId !== normalizedCheckpointId) {
                return currentControlState;
            }

            return {
                ...currentControlState,
                userCheckpoint: {
                    ...currentUserCheckpoint,
                    pending: null,
                    lastResponse: {
                        checkpointId: normalizedCheckpointId,
                        summary: String(summary || '').trim(),
                        answeredAt: new Date().toISOString(),
                    },
                },
            };
        });
    }

    restoreLocalCheckpointPending(sessionId, checkpoint = null) {
        const normalizedCheckpoint = uiHelpers.normalizeSurveyDefinition(checkpoint);
        if (!sessionId || !normalizedCheckpoint?.id) {
            return;
        }

        this.updateLocalCheckpointControlState(sessionId, (currentControlState = {}) => {
            const currentUserCheckpoint = currentControlState?.userCheckpoint
                && typeof currentControlState.userCheckpoint === 'object'
                ? currentControlState.userCheckpoint
                : {};

            return {
                ...currentControlState,
                userCheckpoint: {
                    ...currentUserCheckpoint,
                    pending: normalizedCheckpoint,
                },
            };
        });
    }

    attachPendingCheckpointDisplayContent(message = null, sessionId = '') {
        if (!message || message.role !== 'assistant') {
            return message;
        }

        const existingContent = String(message.displayContent ?? message.content ?? '');
        if (this.extractSurveyDefinition(existingContent)) {
            return message;
        }

        if (!this.assistantMentionsPendingSurvey(message.content || '')) {
            return message;
        }

        const pendingCheckpoint = uiHelpers.normalizeSurveyDefinition(
            this.getSessionRecord(sessionId)?.controlState?.userCheckpoint?.pending || null,
        );
        if (!pendingCheckpoint) {
            return message;
        }

        return {
            ...message,
            displayContent: this.buildSurveyFenceContent(pendingCheckpoint),
        };
    }

    reconcilePendingCheckpointMessages(sessionId) {
        const messages = sessionManager.getMessages(sessionId);
        const session = this.getSessionRecord(sessionId);
        const managedProjectActive = Boolean(this.getSessionActiveProject(sessionId));
        const pendingCheckpoint = this.normalizeCheckpointDefinition(
            session?.controlState?.userCheckpoint?.pending || null,
        );

        let nextMessages = Array.isArray(messages) ? [...messages] : [];
        let changed = false;

        const isSyntheticCheckpointMessage = (message) => (
            message?.clientOnly === true
            && message?.syntheticUserCheckpoint === true
        );

        const collectSurveyMatch = (message) => {
            if (message?.role !== 'assistant') {
                return null;
            }

            const survey = this.getMessageSurveyDefinition(message);
            return survey?.id
                ? { survey, synthetic: isSyntheticCheckpointMessage(message) }
                : null;
        };

        const surveyEntries = nextMessages
            .map((message, index) => ({ message, index, match: collectSurveyMatch(message) }))
            .filter((entry) => entry.match?.survey?.id);
        const realSurveyIds = new Set(
            surveyEntries
                .filter((entry) => entry.match.synthetic !== true)
                .map((entry) => entry.match.survey.id),
        );

        if (realSurveyIds.size > 0) {
            const filteredMessages = nextMessages.filter((message, index) => {
                const entry = surveyEntries.find((candidate) => candidate.index === index);
                if (!entry || entry.match.synthetic !== true) {
                    return true;
                }

                return !realSurveyIds.has(entry.match.survey.id);
            });

            if (filteredMessages.length !== nextMessages.length) {
                nextMessages = filteredMessages;
                changed = true;
            }
        }

        if (!pendingCheckpoint || managedProjectActive) {
            const filteredMessages = nextMessages.filter((message) => (
                !isSyntheticCheckpointMessage(message)
                || message?.surveyState?.status === 'answered'
            ));

            if (filteredMessages.length !== nextMessages.length) {
                nextMessages = filteredMessages;
                changed = true;
            }
        } else {
            const checkpointId = pendingCheckpoint.id;
            const syntheticMessageId = this.buildSyntheticSurveyMessageId(checkpointId);
            const staleSyntheticIndexes = new Set(
                nextMessages
                    .map((message, index) => ({ message, index }))
                    .filter(({ message }) => (
                        isSyntheticCheckpointMessage(message)
                        && String(message?.id || '').trim() !== syntheticMessageId
                        && message?.surveyState?.status !== 'answered'
                    ))
                    .map(({ index }) => index),
            );
            if (staleSyntheticIndexes.size > 0) {
                nextMessages = nextMessages.filter((_message, index) => !staleSyntheticIndexes.has(index));
                changed = true;
            }

            const matchingEntries = nextMessages
                .map((message, index) => ({ message, index, match: collectSurveyMatch(message) }))
                .filter((entry) => entry.match?.survey?.id === checkpointId);
            const realMatch = matchingEntries.find((entry) => entry.match.synthetic !== true) || null;
            const syntheticMatches = matchingEntries.filter((entry) => entry.match.synthetic === true);

            const realMatchHasSurveyDisplay = Boolean(
                realMatch && this.isSurveyDisplayContent(realMatch.message?.displayContent || ''),
            );

            if (!realMatchHasSurveyDisplay && syntheticMatches.length === 0) {
                const baseTimeSource = realMatch?.message?.timestamp
                    || nextMessages[nextMessages.length - 1]?.timestamp
                    || '';
                const baseTime = Number.isNaN(new Date(baseTimeSource).getTime())
                    ? Date.now()
                    : new Date(baseTimeSource).getTime();

                nextMessages.push({
                    id: syntheticMessageId,
                    parentMessageId: realMatch?.message?.id || '',
                    role: 'assistant',
                    content: pendingCheckpoint.preamble || 'Choose an option below and I will continue from there.',
                    displayContent: this.buildSurveyFenceContent(pendingCheckpoint),
                    clientOnly: true,
                    syntheticUserCheckpoint: true,
                    excludeFromTranscript: true,
                    timestamp: new Date(baseTime + 1).toISOString(),
                });
                changed = true;
            } else if (!realMatchHasSurveyDisplay) {
                const [primarySynthetic, ...duplicateSynthetics] = syntheticMatches;
                const expectedDisplayContent = this.buildSurveyFenceContent(pendingCheckpoint);
                const currentSynthetic = primarySynthetic.message || {};
                const needsUpdate = String(currentSynthetic.displayContent || '').trim() !== expectedDisplayContent
                    || String(currentSynthetic.parentMessageId || '').trim() !== String(realMatch?.message?.id || '').trim();

                if (needsUpdate) {
                    nextMessages[primarySynthetic.index] = {
                        ...currentSynthetic,
                        parentMessageId: realMatch?.message?.id || currentSynthetic.parentMessageId || '',
                        content: pendingCheckpoint.preamble || currentSynthetic.content || 'Choose an option below and I will continue from there.',
                        displayContent: expectedDisplayContent,
                        syntheticUserCheckpoint: true,
                    };
                    changed = true;
                }

                if (duplicateSynthetics.length > 0) {
                    const duplicateIndexes = new Set(duplicateSynthetics.map((entry) => entry.index));
                    nextMessages = nextMessages.filter((_message, index) => !duplicateIndexes.has(index));
                    changed = true;
                }
            } else if (syntheticMatches.length > 0) {
                const duplicateIndexes = new Set(syntheticMatches.map((entry) => entry.index));
                nextMessages = nextMessages.filter((_message, index) => !duplicateIndexes.has(index));
                changed = true;
            }
        }

        if (changed) {
            sessionManager.sessionMessages.set(sessionId, nextMessages);
            sessionManager.saveToStorage();
        }

        return nextMessages;
    }

    extractSurveyDisplayContentFromToolEvents(toolEvents = []) {
        const checkpointEvent = [...(Array.isArray(toolEvents) ? toolEvents : [])]
            .reverse()
            .find((event) => (
                this.isUserCheckpointToolName(this.getToolEventName(event))
                && event?.result?.success !== false
            ));

        if (!checkpointEvent) {
            return '';
        }

        const data = checkpointEvent?.result?.data || {};
        const checkpoint = data.checkpoint && typeof data.checkpoint === 'object'
            ? data.checkpoint
            : (
                data && typeof data === 'object' && Object.keys(data).length > 0
                    ? data
                    : this.extractCheckpointFromToolEventChunk(checkpointEvent)
            );
        const surveyFence = this.buildSurveyFenceContent(checkpoint);
        if (!surveyFence) {
            const message = String(data.message || '').trim();
            return /```(?:survey|kb-survey)\s*[\s\S]*?```/i.test(message) ? message : '';
        }

        return surveyFence;
    }

    attachSurveyDisplayContent(message = null, toolEvents = []) {
        if (!message || message.role !== 'assistant') {
            return message;
        }

        const existingContent = String(message.displayContent ?? message.content ?? '');
        if (/```(?:survey|kb-survey)\s*[\s\S]*?```/i.test(existingContent)) {
            return message;
        }

        const surveyDisplayContent = this.extractSurveyDisplayContentFromToolEvents(toolEvents);
        if (!surveyDisplayContent) {
            return message;
        }

        return {
            ...message,
            displayContent: surveyDisplayContent,
        };
    }

    annotateSurveyStates(messages = []) {
        const responseLookup = new Map();

        messages.forEach((message) => {
            if (message?.role !== 'user') {
                return;
            }

            const response = this.parseSurveyResponseContent(message.content || '');
            if (response?.checkpointId) {
                responseLookup.set(response.checkpointId, response);
            }
        });

        return messages.map((message) => {
            if (message?.role !== 'assistant') {
                return message;
            }

            const survey = this.getMessageSurveyDefinition(message);
            if (!survey) {
                return message;
            }

            const response = responseLookup.get(survey.id);
            if (!response) {
                return message.surveyState
                    ? { ...message, surveyState: null }
                    : message;
            }

            return {
                ...message,
                surveyState: {
                    ...(message.surveyState && typeof message.surveyState === 'object'
                        ? message.surveyState
                        : {}),
                    status: 'answered',
                    checkpointId: survey.id,
                    summary: response.summary,
                    selectedOptionIds: Array.isArray(message.surveyState?.selectedOptionIds)
                        ? message.surveyState.selectedOptionIds
                        : this.extractSurveySelectedOptionIds(response.summary, survey.options),
                    selectedLabels: Array.isArray(message.surveyState?.selectedLabels)
                        ? message.surveyState.selectedLabels
                        : this.extractSurveySelectedLabels(response.summary),
                    notes: String(message.surveyState?.notes || '').trim()
                        || this.extractSurveyNotes(response.summary),
                },
            };
        });
    }

    syncAnnotatedSurveyStates(sessionId) {
        const messages = this.reconcilePendingCheckpointMessages(sessionId);
        const annotatedMessages = this.annotateSurveyStates(messages);
        const normalizedMessages = this.injectSessionProjectMessages(
            sessionId,
            this.normalizeManagedAppLifecycleMessages(annotatedMessages),
        );
        sessionManager.sessionMessages.set(sessionId, normalizedMessages);
        sessionManager.saveToStorage();
        return normalizedMessages;
    }

    async recoverPendingSurveyFromBackend(sessionId, parentMessageId = '') {
        if (!sessionId) {
            return;
        }

        try {
            await sessionManager.loadSessions({ preserveCurrentSession: true });
            if (sessionManager.currentSessionId !== sessionId) {
                return;
            }

            const currentMessage = parentMessageId
                ? this.getSessionMessage(sessionId, parentMessageId)
                : null;
            if (currentMessage) {
                const resurfacedMessage = this.attachPendingCheckpointDisplayContent(currentMessage, sessionId);
                if (resurfacedMessage !== currentMessage) {
                    this.upsertSessionMessage(sessionId, resurfacedMessage);
                }
            }

            const messages = this.syncAnnotatedSurveyStates(sessionId);
            const projectMessage = messages.find((message) => message?.metadata?.managedAppProjectSummary === true);
            const surveyMessage = messages.find((message) => (
                message?.role === 'assistant'
                && Boolean(this.getMessageSurveyDefinition(message))
            ));
            const focusMessage = projectMessage || surveyMessage;

            if (!focusMessage) {
                return;
            }

            this.renderMessages(messages);
            this.presentAssistantMessage(focusMessage, []);
            this.updateSessionInfo();
            uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
        } catch (error) {
            console.warn('Failed to recover pending survey from backend session state:', error);
        }
    }

    hasSurveyToolEvent(toolEvents = []) {
        return (Array.isArray(toolEvents) ? toolEvents : []).some((event) => (
            this.isUserCheckpointToolName(this.getToolEventName(event))
            && event?.result?.success !== false
        ));
    }

    getAssistantCueType(message = null, toolEvents = []) {
        if (this.hasSurveyToolEvent(toolEvents)) {
            return 'survey';
        }

        const survey = this.getMessageSurveyDefinition(message);
        return survey ? 'survey' : 'response';
    }

    playCueForAssistantMessage(message = null, toolEvents = []) {
        if (!message || message.role !== 'assistant' || message.isLoading) {
            return;
        }

        uiHelpers.playAgentCue(this.getAssistantCueType(message, toolEvents));
    }

    async maybeSpeakAssistantMessage(message = null) {
        if (!message || message.role !== 'assistant' || message.isLoading || !uiHelpers.isTtsAutoPlayEnabled()) {
            return false;
        }

        const speakableText = uiHelpers.buildSpeakableMessageText(message);
        if (!speakableText) {
            return false;
        }

        const messageId = String(message.id || '').trim();
        const queueKey = messageId || `${message.timestamp || Date.now()}:${speakableText.slice(0, 96)}`;
        if (this.ttsAutoPlayQueuedIds.has(queueKey)) {
            return false;
        }

        this.ttsAutoPlayQueuedIds.add(queueKey);
        this.ttsAutoPlayQueue.push({
            key: queueKey,
            messageId,
            text: speakableText,
        });
        void this.drainTtsAutoPlayQueue();
        return true;
    }

    clearTtsAutoPlayQueue() {
        this.ttsAutoPlayQueue = [];
        this.ttsAutoPlayQueuedIds?.clear?.();
        this.ttsAutoPlayActive = false;
    }

    async drainTtsAutoPlayQueue() {
        if (this.ttsAutoPlayActive) {
            return;
        }

        this.ttsAutoPlayActive = true;
        try {
            while (this.ttsAutoPlayQueue.length > 0) {
                const nextItem = this.ttsAutoPlayQueue.shift();
                if (!nextItem) {
                    continue;
                }

                this.ttsAutoPlayQueuedIds.delete(nextItem.key);
                if (!uiHelpers.isTtsAutoPlayEnabled() || !uiHelpers.isTtsAvailable()) {
                    this.clearTtsAutoPlayQueue();
                    break;
                }

                try {
                    await uiHelpers.ttsManager?.speakMessage?.({
                        messageId: nextItem.messageId,
                        text: nextItem.text,
                    });
                } catch (error) {
                    console.warn('Voice autoplay failed:', error);
                }
            }
        } finally {
            this.ttsAutoPlayActive = false;
        }
    }

    presentAssistantMessage(message = null, toolEvents = []) {
        this.playCueForAssistantMessage(message, toolEvents);
        void this.maybeSpeakAssistantMessage(message);
    }

    playCueForNewAssistantMessages(previousMessages = [], nextMessages = []) {
        const previousCount = Array.isArray(previousMessages) ? previousMessages.length : 0;
        const addedMessages = (Array.isArray(nextMessages) ? nextMessages : []).slice(previousCount);
        const lastAssistantMessage = [...addedMessages]
            .reverse()
            .find((message) => message?.role === 'assistant' && message?.isLoading !== true);

        if (lastAssistantMessage) {
            this.presentAssistantMessage(lastAssistantMessage);
        }
    }

    buildSurveyResponseContent({ checkpointId = '', survey = null, stepResponses = {}, selectedOptions = [], notes = '' } = {}) {
        const surveySteps = Array.isArray(survey?.steps) ? survey.steps : [];
        const responseMap = stepResponses && typeof stepResponses === 'object'
            ? stepResponses
            : {};
        const stepSummaries = surveySteps
            .map((step) => uiHelpers.buildSurveyStepAnswerSummary(step, responseMap[step.id] || null))
            .filter(Boolean);
        if (stepSummaries.length > 0) {
            return `Survey response (${String(checkpointId || '').trim()}): ${stepSummaries.join(' | ')}`;
        }

        const chosen = (Array.isArray(selectedOptions) ? selectedOptions : [])
            .map((option) => {
                const label = String(option?.label || option?.id || '').trim();
                const id = String(option?.id || '').trim();
                if (!label) {
                    return '';
                }

                return id && id !== label
                    ? `"${label}" [${id}]`
                    : `"${label}"`;
            })
            .filter(Boolean)
            .join(', ');
        const noteText = String(notes || '').trim();
        const summaryParts = [
            chosen ? `chose ${chosen}` : 'answered the checkpoint',
            noteText ? `Notes: ${noteText}` : '',
        ].filter(Boolean);

        return `Survey response (${String(checkpointId || '').trim()}): ${summaryParts.join('. ')}`;
    }

    buildArtifactUrl(path, { inline = false } = {}) {
        const normalizedPath = typeof path === 'string' ? path.trim() : '';
        if (!normalizedPath) {
            return '';
        }
        if (/^data:image\//i.test(normalizedPath)) {
            return normalizedPath;
        }

        try {
            const apiBase = typeof API_BASE_URL === 'string' && API_BASE_URL
                ? API_BASE_URL.replace(/\/v1\/?$/i, '')
                : window.location.origin;
            const url = new URL(normalizedPath, apiBase);
            if (inline) {
                url.searchParams.set('inline', '1');
            }
            return url.toString();
        } catch (_error) {
            return '';
        }
    }

    extractHostLabel(value = '') {
        try {
            return new URL(String(value || '').trim()).hostname.replace(/^www\./i, '');
        } catch (_error) {
            return '';
        }
    }

    normalizeUnsplashResult(image) {
        if (!image || typeof image !== 'object') {
            return null;
        }

        const urls = image.urls || {};
        const regular = urls.regular || image.url || urls.full || urls.small || image.thumbUrl || '';
        const small = urls.small || image.thumbUrl || regular;
        if (!regular && !small) {
            return null;
        }

        const authorName = image.author?.name || image.author || '';
        const authorLink = image.author?.link || image.authorLink || '';
        const unsplashLink = image.links?.html || image.unsplashLink || '';
        const description = image.description || image.altDescription || image.alt || '';

        return {
            id: image.id || `unsplash-${Math.random().toString(36).slice(2, 10)}`,
            description,
            altDescription: description,
            urls: {
                small,
                regular,
            },
            author: {
                name: authorName,
                link: authorLink || unsplashLink,
            },
            links: {
                html: unsplashLink,
            },
        };
    }

    normalizeGeneratedImage(image, fallbackPrompt = '', fallbackModel = '') {
        if (!image || typeof image !== 'object') {
            return null;
        }

        const artifactId = image.artifactId || image.artifact_id || image.id || '';
        const fallbackDownloadPath = artifactId ? `/api/artifacts/${encodeURIComponent(artifactId)}/download` : '';
        const rawDownloadUrl = image.downloadPath
            || image.downloadUrl
            || image.download_url
            || image.absoluteUrl
            || image.inlinePath
            || image.inlineUrl
            || image.absoluteInlineUrl
            || fallbackDownloadPath
            || '';
        const rawInlineUrl = image.inlinePath
            || image.inlineUrl
            || image.absoluteInlineUrl
            || image.thumbnailUrl
            || image.thumbUrl
            || image.downloadPath
            || image.downloadUrl
            || image.download_url
            || image.absoluteUrl
            || fallbackDownloadPath
            || '';
        const downloadUrl = this.buildArtifactUrl(rawDownloadUrl);
        const inlineUrl = this.buildArtifactUrl(rawInlineUrl, { inline: true });

        const base64Image = typeof image.b64_json === 'string'
            && image.b64_json.trim()
            && !/\[truncated \d+ chars\]/.test(image.b64_json)
            ? (image.b64_json.startsWith('data:')
                ? image.b64_json
                : `data:image/png;base64,${image.b64_json}`)
            : '';
        const directUrl = this.buildArtifactUrl(
            image.url
            || image.imageUrl
            || image.image_url
            || image.thumbnailUrl
            || image.thumbUrl
            || image.inlinePath
            || image.inlineUrl
            || image.absoluteInlineUrl
            || image.absoluteUrl
            || '',
        ) || image.url || image.imageUrl || image.image_url || image.thumbnailUrl || image.thumbUrl || image.absoluteUrl || '';
        let imageUrl = inlineUrl || base64Image || directUrl;

        if (!imageUrl) {
            return null;
        }

        return {
            imageUrl,
            thumbnailUrl: this.buildArtifactUrl(image.thumbnailUrl || image.thumbUrl || '') || image.thumbnailUrl || image.thumbUrl || imageUrl,
            alt: image.alt || image.revisedPrompt || fallbackPrompt || 'Generated image',
            revisedPrompt: image.revisedPrompt || image.revised_prompt || '',
            prompt: fallbackPrompt,
            model: image.model || fallbackModel || '',
            downloadUrl: downloadUrl || directUrl || '',
            artifactId,
            filename: image.filename || '',
            source: 'generated',
        };
    }

    isGeneratedImageArtifactCandidate(artifact = null) {
        if (!artifact || typeof artifact !== 'object') {
            return false;
        }

        const mimeType = String(artifact.mimeType || artifact.mime_type || '').trim().toLowerCase();
        const format = String(artifact.format || artifact.extension || '').trim().toLowerCase();
        const filename = String(artifact.filename || artifact.name || '').trim().toLowerCase();
        const url = String(
            artifact.url
            || artifact.imageUrl
            || artifact.image_url
            || artifact.thumbnailUrl
            || artifact.thumbUrl
            || artifact.inlineUrl
            || artifact.inlinePath
            || artifact.absoluteInlineUrl
            || artifact.absoluteUrl
            || '',
        ).trim().toLowerCase();
        const imageFormats = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

        return Boolean(
            mimeType.startsWith('image/')
            || imageFormats.has(format)
            || /\.(?:png|jpe?g|gif|webp|svg)$/i.test(filename)
            || url.startsWith('data:image/')
            || typeof artifact.b64_json === 'string',
        );
    }

    buildGeneratedImageArtifactSelectionMessage(parentMessageId, artifacts = [], options = {}) {
        const normalizedParentId = String(parentMessageId || '').trim();
        const files = (Array.isArray(artifacts) ? artifacts : [])
            .filter((artifact) => this.isGeneratedImageArtifactCandidate(artifact))
            .slice(0, 4)
            .map((artifact) => this.normalizeGeneratedImage(
                artifact,
                options.prompt || '',
                options.model || '',
            ))
            .filter(Boolean);

        if (!normalizedParentId || files.length < 2) {
            return null;
        }

        const prompt = String(options.prompt || '').trim();
        return {
            id: `${normalizedParentId}-image-artifacts`,
            parentMessageId: normalizedParentId,
            role: 'assistant',
            type: 'image-selection',
            content: `Generated image options${prompt ? ` for "${prompt}"` : ''}`,
            prompt,
            model: options.model || '',
            results: files,
            sourceKind: 'generated',
            artifacts: (Array.isArray(artifacts) ? artifacts : []).filter((artifact) => artifact?.id),
            clientOnly: true,
            excludeFromTranscript: true,
            timestamp: new Date().toISOString(),
        };
    }

    appendGeneratedImageArtifactSelection(parentMessageId, artifacts = [], options = {}) {
        const sessionId = String(options.sessionId || sessionManager.currentSessionId || '').trim();
        if (!sessionId || !parentMessageId || !Array.isArray(artifacts) || artifacts.length < 2) {
            return null;
        }

        const messages = sessionManager.getMessages(sessionId);
        const alreadyHasImageSelection = messages.some((message) => (
            message?.parentMessageId === parentMessageId
            && message?.type === 'image-selection'
            && message?.sourceKind !== 'artifact'
        ));
        if (alreadyHasImageSelection) {
            return null;
        }

        const selectionMessage = this.buildGeneratedImageArtifactSelectionMessage(parentMessageId, artifacts, options);
        if (!selectionMessage) {
            return null;
        }

        const savedMessage = this.upsertSessionMessage(sessionId, selectionMessage);
        if (savedMessage && this.isVisibleSession(sessionId)) {
            this.renderOrReplaceMessage(savedMessage);
            uiHelpers.scrollToBottom(false);
        }
        return savedMessage || selectionMessage;
    }

    getImageDiagnosticSummary(response) {
        const diagnostics = response?.diagnostics?.imageGeneration || response?.imageDiagnostics || null;
        if (!diagnostics || typeof diagnostics !== 'object') {
            return '';
        }

        const counts = diagnostics.counts || {};
        const flags = diagnostics.flags || {};
        const provider = diagnostics.provider || {};
        const transport = diagnostics.transport || {};
        const artifactPersistence = diagnostics.artifactPersistence || {};
        const parts = [
            diagnostics.code || 'image_diagnostics',
            diagnostics.stage ? `stage=${diagnostics.stage}` : '',
            provider.source ? `provider=${provider.source}` : '',
            provider.status ? `providerStatus=${provider.status}` : '',
            transport.category ? `transport=${transport.category}` : '',
            artifactPersistence.primaryReason ? `artifactPersistence=${artifactPersistence.primaryReason}` : '',
            `parsed=${Number(counts.parsedImageRecords || 0)}`,
            `returned=${Number(counts.returnedImageRecords || 0)}`,
            `usable=${Number(counts.usableReturnedImageRecords || 0)}`,
            `artifacts=${Number(counts.artifacts || 0)}`,
        ].filter(Boolean);
        const usableCount = Number(counts.usableReturnedImageRecords || 0);
        const artifactCount = Number(counts.artifacts || 0);
        const likely = (flags.likelyArtifactPersistenceIssue || (usableCount > 0 && artifactCount === 0))
            ? 'Backend parsed usable image data, but no reusable artifact was persisted; inspect artifact persistence/image validation path.'
            : flags.providerSocketClosedByPeer
                ? 'Provider/router closed the socket before an HTTP response completed; inspect gateway logs, upstream connectivity, and proxy timeouts.'
                : flags.likelyFrontendReceiveOrParserIssue
                    ? 'Backend sent usable persisted image data; inspect the web chat receive/parser path.'
                    : (diagnostics.likelyCause || '');

        return `${parts.join(' | ')}${likely ? ` | ${likely}` : ''}`;
    }

    normalizeArtifactImage(image, fallbackPrompt = '', fallbackHost = '') {
        if (!image || typeof image !== 'object') {
            return null;
        }

        const downloadUrl = this.buildArtifactUrl(image.downloadPath || image.downloadUrl || '');
        const inlineUrl = this.buildArtifactUrl(
            image.inlinePath || image.downloadPath || image.downloadUrl || '',
            { inline: true },
        );

        if (!downloadUrl || !inlineUrl) {
            return null;
        }

        const sourceHost = image.sourceHost || fallbackHost || '';
        const filename = image.filename || `captured-image-${image.index || 1}`;
        const alt = filename
            .replace(/\.[a-z0-9]{2,5}$/i, '')
            .replace(/[-_]+/g, ' ')
            .trim() || fallbackPrompt || 'Captured image';

        return {
            imageUrl: inlineUrl,
            thumbnailUrl: inlineUrl,
            downloadUrl,
            artifactId: image.artifactId || '',
            filename,
            mimeType: image.mimeType || '',
            sizeBytes: image.sizeBytes || 0,
            sourceHost,
            alt,
            prompt: fallbackPrompt || `Captured image from ${sourceHost || 'scraped page'}`,
            source: 'artifact',
        };
    }

    normalizeSearchResult(result) {
        if (!result || typeof result !== 'object' || !result.url) {
            return null;
        }

        return {
            title: result.title || result.url,
            url: result.url,
            snippet: result.snippet || '',
            source: result.source || '',
            publishedAt: result.publishedAt || '',
        };
    }

    stripHtmlToText(html = '') {
        return String(html || '')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
            .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, '\'')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/\s+/g, ' ')
            .trim();
    }

    buildResearchSearchLookup(toolEvents = []) {
        const lookup = new Map();

        (Array.isArray(toolEvents) ? toolEvents : []).forEach((event) => {
            const toolId = event?.toolCall?.function?.name || event?.result?.toolId || '';
            if (toolId !== 'web-search' || event?.result?.success === false) {
                return;
            }

            const results = Array.isArray(event?.result?.data?.results)
                ? event.result.data.results
                : [];

            results.forEach((result) => {
                const normalized = this.normalizeSearchResult(result);
                if (normalized?.url && !lookup.has(normalized.url)) {
                    lookup.set(normalized.url, normalized);
                }
            });
        });

        return lookup;
    }

    normalizeResearchSourceEvent(event, searchLookup = new Map()) {
        const toolId = event?.toolCall?.function?.name || event?.result?.toolId || '';
        if ((toolId !== 'web-fetch' && toolId !== 'web-scrape') || event?.result?.success === false) {
            return null;
        }

        const args = this.parseToolArguments(event?.toolCall?.function?.arguments);
        const data = event?.result?.data || {};
        const url = data.url || args.url || '';
        if (!url) {
            return null;
        }

        const searchMeta = searchLookup.get(url) || null;
        const title = data.title || searchMeta?.title || url;
        const source = searchMeta?.source || '';
        const snippet = searchMeta?.snippet || '';
        const publishedAt = searchMeta?.publishedAt || '';
        const rawExcerpt = toolId === 'web-scrape'
            ? (data.summary || data.text || data.content || JSON.stringify(data.data || {}))
            : this.stripHtmlToText(data.body || '');
        const excerpt = String(rawExcerpt || '').replace(/\s+/g, ' ').trim().slice(0, 420);

        if (!snippet && !excerpt) {
            return null;
        }

        return {
            title,
            url,
            source,
            snippet,
            excerpt,
            publishedAt,
            toolId,
        };
    }

    appendToolSelectionMessages(parentMessageId, toolEvents = [], options = {}) {
        const sessionId = String(options.sessionId || sessionManager.currentSessionId || '').trim();
        if (!sessionId || !parentMessageId || !Array.isArray(toolEvents) || toolEvents.length === 0) {
            return;
        }

        const nextMessages = [];
        const searchLookup = this.buildResearchSearchLookup(toolEvents);
        const researchSources = [];
        const seenResearchUrls = new Set();

        toolEvents.forEach((event) => {
            const normalized = this.normalizeResearchSourceEvent(event, searchLookup);
            if (!normalized || seenResearchUrls.has(normalized.url)) {
                return;
            }

            seenResearchUrls.add(normalized.url);
            researchSources.push(normalized);
        });
        const hasVerifiedResearchSources = researchSources.length > 0;

        toolEvents.forEach((event, index) => {
            const toolId = event?.toolCall?.function?.name || event?.result?.toolId || '';
            const args = this.parseToolArguments(event?.toolCall?.function?.arguments);
            const data = event?.result?.data || {};

            if (toolId === 'image-search-unsplash') {
                const results = (Array.isArray(data.images) ? data.images : [])
                    .map((image) => this.normalizeUnsplashResult(image))
                    .filter(Boolean);

                if (results.length === 0) {
                    return;
                }

                nextMessages.push({
                    id: `${parentMessageId}-unsplash-${index}`,
                    parentMessageId,
                    role: 'assistant',
                    type: 'unsplash-search',
                    content: `Unsplash options for "${data.query || args.query || 'image search'}"`,
                    query: data.query || args.query || '',
                    results,
                    total: data.total || results.length,
                    totalPages: data.totalPages || args.totalPages || 1,
                    currentPage: args.page || 1,
                    perPage: args.perPage || results.length || 6,
                    orientation: args.orientation || null,
                    clientOnly: true,
                    excludeFromTranscript: true,
                    syncExcludedToBackend: true,
                    timestamp: new Date().toISOString(),
                });
                return;
            }

            if (toolId === 'web-search') {
                if (hasVerifiedResearchSources) {
                    return;
                }

                const results = (Array.isArray(data.results) ? data.results : [])
                    .map((result) => this.normalizeSearchResult(result))
                    .filter(Boolean);

                if (results.length === 0) {
                    return;
                }

                nextMessages.push({
                    id: `${parentMessageId}-search-${index}`,
                    parentMessageId,
                    role: 'assistant',
                    type: 'search-results',
                    content: `Candidate pages for "${data.query || args.query || 'research'}"`,
                    query: data.query || args.query || '',
                    results,
                    interactive: false,
                    total: results.length,
                    clientOnly: true,
                    excludeFromTranscript: true,
                    syncExcludedToBackend: true,
                    timestamp: new Date().toISOString(),
                });
                return;
            }

            if (toolId === 'image-generate') {
                const toolImages = Array.isArray(data.images) && data.images.length > 0
                    ? data.images
                    : (Array.isArray(data.artifacts) ? data.artifacts : []);
                const results = toolImages
                    .map((image) => this.normalizeGeneratedImage(image, data.prompt || args.prompt || '', data.model || ''))
                    .filter(Boolean);

                if (results.length === 0) {
                    return;
                }

                nextMessages.push({
                    id: `${parentMessageId}-image-${index}`,
                    parentMessageId,
                    role: 'assistant',
                    type: 'image-selection',
                    content: `Generated image options for "${data.prompt || args.prompt || 'image'}"`,
                    prompt: data.prompt || args.prompt || '',
                    model: data.model || '',
                    results,
                    clientOnly: true,
                    excludeFromTranscript: true,
                    syncExcludedToBackend: true,
                    timestamp: new Date().toISOString(),
                });
                return;
            }

            if (toolId === 'web-scrape') {
                const imageCapture = data.imageCapture && typeof data.imageCapture === 'object'
                    ? data.imageCapture
                    : (event?.result?.imageCapture && typeof event.result.imageCapture === 'object'
                        ? event.result.imageCapture
                        : null);
                if (imageCapture?.mode !== 'blind-artifacts') {
                    return;
                }

                const fallbackHost = this.extractHostLabel(data.url || args.url || '') || imageCapture.items?.[0]?.sourceHost || '';
                const results = (Array.isArray(imageCapture.items) ? imageCapture.items : [])
                    .map((image) => this.normalizeArtifactImage(image, data.title || data.url || args.url || '', fallbackHost))
                    .filter(Boolean);

                if (results.length === 0) {
                    return;
                }

                nextMessages.push({
                    id: `${parentMessageId}-artifact-${index}`,
                    parentMessageId,
                    role: 'assistant',
                    type: 'image-selection',
                    sourceKind: 'artifact',
                    content: `Captured image options from ${fallbackHost || 'the scraped page'}`,
                    prompt: data.title || data.url || args.url || '',
                    sourceHost: fallbackHost,
                    results,
                    clientOnly: true,
                    excludeFromTranscript: true,
                    syncExcludedToBackend: true,
                    timestamp: new Date().toISOString(),
                });
            }
        });

        if (researchSources.length > 0) {
            const searchEvent = [...toolEvents].reverse().find((event) => (
                (event?.toolCall?.function?.name || event?.result?.toolId || '') === 'web-search'
                && event?.result?.success !== false
            ));
            const searchArgs = this.parseToolArguments(searchEvent?.toolCall?.function?.arguments);
            const query = searchEvent?.result?.data?.query || searchArgs.query || '';

            nextMessages.push({
                id: `${parentMessageId}-research-sources`,
                parentMessageId,
                role: 'assistant',
                type: 'research-sources',
                content: `Verified source excerpts for "${query || 'research'}"`,
                query,
                results: researchSources,
                total: researchSources.length,
                clientOnly: true,
                excludeFromTranscript: true,
                syncExcludedToBackend: true,
                timestamp: new Date().toISOString(),
            });
        }

        if (nextMessages.length === 0) {
            return;
        }

        const isVisibleSession = this.isVisibleSession(sessionId);
        nextMessages.forEach((message) => {
            const savedMessage = this.upsertSessionMessage(sessionId, message);
            this.persistSessionMessageIfNeeded(sessionId, savedMessage || message);
            if (isVisibleSession) {
                this.renderOrReplaceMessage(savedMessage || message);
            }
        });

        if (isVisibleSession) {
            uiHelpers.scrollToBottom(false);
            this.updateSessionInfo();
        }
        uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
    }

    setInput(text) {
        this.messageInput.value = text;
        this.autoResize?.resize?.();
        this.updateSendButton();
        this.messageInput.focus();
    }

    syncBackendSession(sessionId, previousSessionId = sessionManager.currentSessionId) {
        if (!sessionId) {
            return;
        }

        const currentSessionId = String(previousSessionId || sessionManager.currentSessionId || '').trim();
        const didChangeSession = currentSessionId !== sessionId;
        if (currentSessionId !== sessionId) {
            sessionManager.promoteSessionId(currentSessionId, sessionId);
            this.remapSessionScopedState(currentSessionId, sessionId);
        }

        if (this.isVisibleSession(sessionId)) {
            apiClient.setSessionId(sessionId);
        }
        if (this.isVisibleSession(sessionId) && this.subscribedWorkloadSessionId !== sessionId) {
            this.subscribeToSessionUpdates(sessionId);
        }
        if (this.isVisibleSession(sessionId) && (didChangeSession || this.currentSessionWorkloads.length === 0)) {
            this.loadSessionWorkloads(sessionId);
        }
    }

    clearLiveIndicatorTimer() {
        if (!this.liveIndicatorHideTimer) {
            return;
        }

        window.clearTimeout(this.liveIndicatorHideTimer);
        this.liveIndicatorHideTimer = null;
    }

    clearAmbientReasoningTimer() {
        if (!this.ambientReasoningTimer) {
            return;
        }

        window.clearTimeout(this.ambientReasoningTimer);
        this.ambientReasoningTimer = null;
    }

    resetAmbientReasoningState() {
        this.clearAmbientReasoningTimer();
        this.ambientReasoningCycle = null;
        this.lastReasoningDeltaAt = 0;
    }

    getNextAmbientReasoningLine() {
        if (!Array.isArray(this.ambientReasoningDeck) || this.ambientReasoningDeck.length === 0) {
            this.ambientReasoningDeck = buildAmbientReasoningLines();
            this.ambientReasoningDeckIndex = 0;
        }

        if (this.ambientReasoningDeckIndex >= this.ambientReasoningDeck.length) {
            this.ambientReasoningDeck = buildAmbientReasoningLines();
            this.ambientReasoningDeckIndex = 0;
        }

        const nextLine = this.ambientReasoningDeck[this.ambientReasoningDeckIndex];
        this.ambientReasoningDeckIndex += 1;
        return String(nextLine || 'Collecting context while the answer forms.').trim();
    }

    createAmbientReasoningCycle(now = Date.now()) {
        const fullText = this.getNextAmbientReasoningLine();
        const rotateWindowMs = AMBIENT_REASONING_ROTATE_MAX_MS - AMBIENT_REASONING_ROTATE_MIN_MS;
        const rotateMs = AMBIENT_REASONING_ROTATE_MIN_MS + Math.floor(Math.random() * (rotateWindowMs + 1));
        const typeMs = Math.max(2200, Math.min(5800, fullText.length * 60));

        return {
            fullText,
            startedAt: now,
            nextChangeAt: now + rotateMs,
            typeMs,
        };
    }

    getAmbientReasoningFrame(now = Date.now()) {
        if (!this.ambientReasoningCycle || now >= this.ambientReasoningCycle.nextChangeAt) {
            this.ambientReasoningCycle = this.createAmbientReasoningCycle(now);
        }

        const elapsedMs = Math.max(0, now - this.ambientReasoningCycle.startedAt);
        const progress = Math.min(1, elapsedMs / Math.max(1, this.ambientReasoningCycle.typeMs));
        const visibleLength = Math.max(1, Math.ceil(this.ambientReasoningCycle.fullText.length * progress));

        return {
            fullText: this.ambientReasoningCycle.fullText,
            visibleText: this.ambientReasoningCycle.fullText.slice(0, visibleLength),
            isTyping: progress < 1,
            msUntilChange: Math.max(0, this.ambientReasoningCycle.nextChangeAt - now),
        };
    }

    hasRecentReasoningStream(now = Date.now()) {
        return this.lastReasoningDeltaAt > 0
            && (now - this.lastReasoningDeltaAt) < REAL_REASONING_DISPLAY_HOLD_MS;
    }

    startAmbientReasoningLoop() {
        this.clearAmbientReasoningTimer();

        const tick = () => {
            if (!this.currentStreamingMessageId || !this.isProcessing) {
                this.clearAmbientReasoningTimer();
                return;
            }

            const sessionId = this.getStreamingMessageSessionId();
            const message = this.getSessionMessage(sessionId, this.currentStreamingMessageId);
            if (!message || message.isStreaming !== true) {
                this.clearAmbientReasoningTimer();
                return;
            }

            const liveContent = extractChatDisplayText(message.displayContent ?? message.content ?? '');
            if (liveContent) {
                if (String(message.reasoningDisplaySource || '').trim() === 'generated') {
                    this.updateStreamingMessageState({
                        reasoningDisplaySource: '',
                        reasoningDisplayText: '',
                        reasoningDisplayFullText: '',
                        reasoningDisplayTitle: '',
                        reasoningDisplayIcon: '',
                        reasoningDisplayAnimated: false,
                    }, {
                        render: true,
                        scroll: false,
                    });
                }

                this.ambientReasoningTimer = window.setTimeout(tick, 1000);
                return;
            }

            const now = Date.now();
            const liveSummary = String(
                message.reasoningSummary
                || message.metadata?.reasoningSummary
                || this.liveResponseState.reasoningSummary
                || '',
            ).trim();
            const hasFreshReasoning = this.hasRecentReasoningStream(now);
            const shouldPreferRealReasoning = Boolean(liveSummary) && (
                hasFreshReasoning
                || String(message.reasoningDisplaySource || '').trim() === 'stream'
            );
            if (shouldPreferRealReasoning) {
                if (liveSummary && message.reasoningDisplaySource !== 'stream') {
                    this.updateStreamingMessageState({
                        reasoningDisplaySource: 'stream',
                        reasoningDisplayText: liveSummary,
                        reasoningDisplayFullText: liveSummary,
                        reasoningDisplayTitle: 'Reasoning summary',
                        reasoningDisplayIcon: 'brain',
                        reasoningDisplayAnimated: false,
                    }, {
                        render: true,
                        scroll: false,
                    });
                }

                this.ambientReasoningTimer = window.setTimeout(tick, 1000);
                return;
            }

            const frame = this.getAmbientReasoningFrame(now);
            const needsUpdate = message.reasoningDisplaySource !== 'generated'
                || extractChatReasoningText(message.reasoningDisplayText) !== frame.visibleText
                || extractChatReasoningText(message.reasoningDisplayFullText) !== frame.fullText
                || Boolean(message.reasoningDisplayAnimated) !== frame.isTyping;

            if (needsUpdate) {
                this.updateStreamingMessageState({
                    reasoningDisplaySource: 'generated',
                    reasoningDisplayText: frame.visibleText,
                    reasoningDisplayFullText: frame.fullText,
                    reasoningDisplayTitle: SYNTHETIC_REASONING_TITLE,
                    reasoningDisplayIcon: 'sparkles',
                    reasoningDisplayAnimated: frame.isTyping,
                }, {
                    render: true,
                    scroll: false,
                });
            }

            this.ambientReasoningTimer = window.setTimeout(
                tick,
                frame.isTyping
                    ? AMBIENT_REASONING_TYPE_TICK_MS
                    : Math.max(700, Math.min(1200, frame.msUntilChange || 900)),
            );
        };

        tick();
    }

    beginAssistantStream(options = {}) {
        const streamSessionId = this.getStreamingMessageSessionId(options.messageId);
        const shouldTouchVisibleIndicator = !streamSessionId || this.isVisibleSession(streamSessionId);

        this.clearLiveIndicatorTimer();
        if (shouldTouchVisibleIndicator) {
            this.resetAmbientReasoningState();
        }
        const initialAmbientFrame = this.getAmbientReasoningFrame(Date.now());
        this.liveResponseState = {
            phase: 'thinking',
            detail: extractChatDisplayText(options.detail || 'Gathering context and preparing the reply.', { maxLength: 180 }),
            reasoningSummary: '',
            hasRealReasoning: false,
        };
        if (shouldTouchVisibleIndicator) {
            uiHelpers.showTypingIndicator({
                phase: 'thinking',
                detail: this.liveResponseState.detail,
            });
            uiHelpers.playThinkingCue();
        }
        this.updateStreamingMessageState({
            liveState: {
                phase: 'thinking',
                detail: this.liveResponseState.detail,
            },
            progressState: null,
            reasoningSummary: '',
            reasoningDisplaySource: 'generated',
            reasoningDisplayText: initialAmbientFrame.visibleText,
            reasoningDisplayFullText: initialAmbientFrame.fullText,
            reasoningDisplayTitle: SYNTHETIC_REASONING_TITLE,
            reasoningDisplayIcon: 'sparkles',
            reasoningDisplayAnimated: initialAmbientFrame.isTyping,
            reasoningAvailable: false,
            isStreaming: true,
        }, {
            render: true,
            scroll: false,
        });
        this.startAmbientReasoningLoop();
    }

    scheduleLiveIndicatorHide(delayMs = 900) {
        this.clearLiveIndicatorTimer();
        this.liveIndicatorHideTimer = window.setTimeout(() => {
            uiHelpers.hideTypingIndicator();
            this.liveIndicatorHideTimer = null;
        }, Math.max(0, Number(delayMs) || 0));
    }

    updateLiveResponsePhase(phase = 'thinking', detail = '') {
        const normalizedPhase = extractChatDisplayText(phase, { maxLength: 80 }) || 'thinking';
        const nextDetail = extractChatDisplayText(detail, { maxLength: 220 });
        const streamSessionId = this.getStreamingMessageSessionId();
        const isVisibleStream = this.isVisibleSession(streamSessionId);
        this.liveResponseState = {
            ...this.liveResponseState,
            phase: normalizedPhase,
            detail: nextDetail || this.liveResponseState.detail || '',
        };

        if (isVisibleStream) {
            uiHelpers.showTypingIndicator({
                phase: normalizedPhase,
                detail: this.liveResponseState.detail,
            });
        }

        this.updateStreamingMessageState({
            liveState: {
                phase: normalizedPhase,
                detail: this.liveResponseState.detail,
            },
            isStreaming: normalizedPhase !== 'ready',
        }, {
            render: normalizedPhase !== 'ready',
            buffer: true,
            scroll: false,
        });
    }

    updateStreamingMessageState(patch = {}, options = {}) {
        const messageId = String(this.currentStreamingMessageId || patch?.id || '').trim();
        const sessionId = this.getStreamingMessageSessionId(messageId);
        if (!messageId || !sessionId) {
            return null;
        }

        const currentMessage = this.getSessionMessage(sessionId, messageId);
        if (!currentMessage) {
            return null;
        }

        const nextMetadata = {
            ...(currentMessage.metadata || {}),
            ...(patch.metadata || {}),
        };
        const hasPatchedReasoningSummary = Object.prototype.hasOwnProperty.call(patch, 'reasoningSummary');
        const hasPatchedReasoningAvailable = Object.prototype.hasOwnProperty.call(patch, 'reasoningAvailable');
        const nextReasoningSummary = hasPatchedReasoningSummary
            ? extractChatReasoningText(patch.reasoningSummary)
            : extractChatReasoningText(currentMessage.reasoningSummary || currentMessage.metadata?.reasoningSummary || '');
        const currentReasoningAvailable = currentMessage.reasoningAvailable === true
            || currentMessage.metadata?.reasoningAvailable === true;
        const nextReasoningAvailable = hasPatchedReasoningAvailable
            ? (patch.reasoningAvailable === true || Boolean(nextReasoningSummary))
            : (hasPatchedReasoningSummary
                ? Boolean(nextReasoningSummary)
                : (currentReasoningAvailable || Boolean(nextReasoningSummary)));

        if (nextReasoningSummary) {
            nextMetadata.reasoningSummary = nextReasoningSummary;
            nextMetadata.reasoningAvailable = true;
        } else if (hasPatchedReasoningSummary) {
            delete nextMetadata.reasoningSummary;
        }
        if (nextReasoningAvailable) {
            nextMetadata.reasoningAvailable = true;
        } else if (hasPatchedReasoningAvailable || hasPatchedReasoningSummary) {
            delete nextMetadata.reasoningAvailable;
        }

        const nextMessage = {
            ...currentMessage,
            ...patch,
            id: currentMessage.id,
            metadata: nextMetadata,
            reasoningSummary: nextReasoningSummary,
            reasoningAvailable: nextReasoningAvailable,
        };

        if (!nextMessage.liveState) {
            delete nextMessage.liveState;
        }

        const savedMessage = this.upsertSessionMessage(sessionId, nextMessage);
        if ((options.render ?? true) && savedMessage && this.isVisibleSession(sessionId)) {
            if (options.buffer === true) {
                this.scheduleBufferedStreamingRender(sessionId, savedMessage, options);
            } else {
                this.flushBufferedStreamingRender(messageId);
                uiHelpers.updateMessageContent(messageId, savedMessage, savedMessage.isStreaming === true);
            }
        }
        if (options.scroll === true && options.buffer !== true && this.isVisibleSession(sessionId)) {
            uiHelpers.scrollToBottom();
        }

        return savedMessage || nextMessage;
    }

    handleStreamStatus(chunk = {}) {
        const phase = extractChatDisplayText(chunk.phase, { maxLength: 80 }) || 'thinking';
        const detail = extractChatDisplayText(chunk.detail, { maxLength: 220 });
        this.updateLiveResponsePhase(phase, detail);
    }

    handleProgress(chunk = {}) {
        if (!this.currentStreamingMessageId) {
            return;
        }

        const progress = chunk.progress && typeof chunk.progress === 'object'
            ? chunk.progress
            : {};
        const phase = extractChatDisplayText(progress.phase || chunk.phase || '', { maxLength: 80 }) || 'thinking';
        const detail = cleanChatStatusText(progress.detail || chunk.detail || '', { maxLength: 240 });

        this.updateLiveResponsePhase(phase, detail);
        this.updateStreamingMessageState({
            progressState: {
                ...progress,
                phase,
                detail,
            },
            isStreaming: true,
        }, {
            render: true,
            buffer: true,
            scroll: false,
        });
    }

    handleReasoningSummaryDelta(chunk = {}) {
        const delta = extractChatReasoningText(chunk.content);
        const summary = extractChatReasoningText(chunk.summary);
        const currentSummary = String(this.liveResponseState.reasoningSummary || '').trim();
        const nextSummary = summary || `${currentSummary}${delta}`.trim();
        this.lastReasoningDeltaAt = Date.now();

        this.liveResponseState = {
            ...this.liveResponseState,
            reasoningSummary: nextSummary,
            hasRealReasoning: true,
        };
        this.updateLiveResponsePhase('reasoning', 'Working through the answer');
        this.updateStreamingMessageState({
            reasoningSummary: nextSummary,
            reasoningDisplaySource: 'stream',
            reasoningDisplayText: nextSummary,
            reasoningDisplayFullText: nextSummary,
            reasoningDisplayTitle: 'Reasoning',
            reasoningDisplayIcon: 'brain',
            reasoningDisplayAnimated: false,
            reasoningAvailable: true,
            isStreaming: true,
        }, {
            render: true,
            buffer: true,
            scroll: false,
        });
    }

    handleToolEvent(chunk = {}) {
        const detail = cleanChatStatusText(chunk.detail, { maxLength: 220 }) || 'Checking tool results';
        this.updateLiveResponsePhase('checking-tools', detail);

        const sessionId = this.getStreamingMessageSessionId();
        if (this.applyManagedAppProgressFromToolEvent(chunk, { sessionId })) {
            return;
        }

        const currentMessage = this.getSessionMessage(sessionId, this.currentStreamingMessageId);
        const existingProgress = currentMessage?.progressState
            || currentMessage?.metadata?.progressState
            || {};
        const toolEvent = {
            toolId: extractChatDisplayText(chunk.toolId || chunk.tool_id || chunk.toolName || chunk.tool_name || '', { maxLength: 120 }),
            toolName: extractChatDisplayText(chunk.toolName || chunk.tool_name || chunk.toolId || chunk.tool_id || '', { maxLength: 120 }),
            stage: extractChatDisplayText(chunk.stage || '', { maxLength: 80 }) || 'in_progress',
            detail,
        };
        const existingToolEvents = Array.isArray(existingProgress.toolEvents)
            ? existingProgress.toolEvents
            : [];
        this.updateStreamingMessageState({
            progressState: {
                ...existingProgress,
                phase: 'checking-tools',
                detail,
                toolEvents: [...existingToolEvents, toolEvent].slice(-6),
            },
            isStreaming: true,
        }, {
            render: true,
            buffer: true,
            scroll: false,
        });

        const checkpoint = this.extractCheckpointFromToolEventChunk(chunk);
        if (checkpoint) {
            const checkpointSessionId = sessionId || sessionManager.currentSessionId;
            this.showPendingCheckpointFromToolCall(checkpointSessionId, checkpoint, this.currentStreamingMessageId);
        }
    }

    handleDelta(content) {
        if (!this.currentStreamingMessageId) return;

        const sessionId = this.getStreamingMessageSessionId();
        const currentMessage = this.getSessionMessage(sessionId, this.currentStreamingMessageId);
        if (!currentMessage || currentMessage.role !== 'assistant') {
            return;
        }

        const reasoningPatch = ['generated', 'synthetic'].includes(String(currentMessage.reasoningDisplaySource || '').trim())
            ? {
                reasoningDisplaySource: '',
                reasoningDisplayText: '',
                reasoningDisplayFullText: '',
                reasoningDisplayTitle: '',
                reasoningDisplayIcon: '',
                reasoningDisplayAnimated: false,
            }
            : {};

        this.updateLiveResponsePhase('writing', 'Streaming the reply');
        this.updateStreamingMessageState({
            content: `${extractChatStreamText(currentMessage.content)}${extractChatStreamText(content)}`,
            ...reasoningPatch,
            isStreaming: true,
        }, {
            render: true,
            buffer: true,
            scroll: true,
        });
    }

    finalizeActiveStreamState(options = {}) {
        const {
            clearPendingResync = true,
            clearActiveStreamRequest = true,
            clearStreamingMessageId = true,
            hideTypingIndicator = false,
            scheduleIndicatorHide = false,
            resetRetryAttempt = false,
            keepSessionProcessing = false,
        } = options;
        const finalizedSessionId = String(
            (clearActiveStreamRequest ? this.activeStreamRequest?.sessionId : '')
            || this.pendingStreamResync?.sessionId
            || sessionManager.currentSessionId
            || '',
        ).trim();

        const shouldTouchVisibleIndicator = !finalizedSessionId || this.isVisibleSession(finalizedSessionId);

        if (scheduleIndicatorHide && shouldTouchVisibleIndicator) {
            this.scheduleLiveIndicatorHide();
        } else {
            if (shouldTouchVisibleIndicator) {
                this.clearLiveIndicatorTimer();
            }
            if (hideTypingIndicator && shouldTouchVisibleIndicator) {
                uiHelpers.hideTypingIndicator();
            }
        }

        if (shouldTouchVisibleIndicator) {
            this.resetAmbientReasoningState();
        }
        if (resetRetryAttempt) {
            this.retryAttempt = 0;
        }

        if (clearPendingResync) {
            this.clearPendingStreamResync();
        }
        if (clearActiveStreamRequest) {
            this.activeStreamRequest = null;
        }

        this.isProcessing = false;
        this.isCancellingCurrentRequest = false;
        if (clearStreamingMessageId) {
            this.currentStreamingMessageId = null;
        }

        this.liveResponseState = {
            phase: 'idle',
            detail: '',
            reasoningSummary: '',
            hasRealReasoning: false,
        };
        if (!keepSessionProcessing && finalizedSessionId) {
            this.processingSessions.delete(finalizedSessionId);
            this.streamStatesBySession.delete(finalizedSessionId);
            this.isProcessing = this.isCurrentSessionProcessing();
        }
        this.updateSendButton();
    }

    handleDone(chunk = {}) {
        if (!this.currentStreamingMessageId) return;

        this.flushBufferedStreamingRender(this.currentStreamingMessageId);
        this.clearAmbientReasoningTimer();
        this.clearPendingStreamResync();
        
        // Reset retry counter on success
        this.retryAttempt = 0;
        
        const trackedRequest = this.getTrackedStreamRequest();
        const sessionId = String(trackedRequest?.sessionId || sessionManager.currentSessionId || '').trim();
        if (!sessionId) {
            return;
        }
        const isVisibleSession = this.isVisibleSession(sessionId);
        const parentMessageId = this.currentStreamingMessageId;
        const previousMessages = sessionManager.getMessages(sessionId).slice();
        
        // Finalize message
        sessionManager.finalizeLastMessage(sessionId);

        let currentMessage = this.getSessionMessage(sessionId, parentMessageId);
        const streamedReasoningSummary = extractChatReasoningText(
            this.liveResponseState.reasoningSummary
            || currentMessage?.reasoningSummary
            || currentMessage?.metadata?.reasoningSummary
            || '',
        );
        if (currentMessage && chunk.assistantMetadata && typeof chunk.assistantMetadata === 'object') {
            const updatedMessage = {
                ...currentMessage,
                ...chunk.assistantMetadata,
                metadata: {
                    ...(currentMessage.metadata || {}),
                    ...chunk.assistantMetadata,
                },
            };
            if (streamedReasoningSummary && !updatedMessage.reasoningSummary) {
                updatedMessage.reasoningSummary = streamedReasoningSummary;
                updatedMessage.reasoningAvailable = true;
                updatedMessage.metadata.reasoningSummary = streamedReasoningSummary;
                updatedMessage.metadata.reasoningAvailable = true;
            }
            this.upsertSessionMessage(sessionId, updatedMessage);
            currentMessage = updatedMessage;
        } else if (currentMessage && streamedReasoningSummary) {
            const updatedMessage = {
                ...currentMessage,
                reasoningSummary: streamedReasoningSummary,
                reasoningAvailable: true,
                metadata: {
                    ...(currentMessage.metadata || {}),
                    reasoningSummary: streamedReasoningSummary,
                    reasoningAvailable: true,
                },
            };
            this.upsertSessionMessage(sessionId, updatedMessage);
            currentMessage = updatedMessage;
        }
        if (currentMessage && Array.isArray(chunk.toolEvents) && chunk.toolEvents.length > 0) {
            const updatedMessage = this.attachSurveyDisplayContent(currentMessage, chunk.toolEvents);
            if (updatedMessage !== currentMessage) {
                this.upsertSessionMessage(sessionId, updatedMessage);
                currentMessage = updatedMessage;
            }
        }

        if (Array.isArray(chunk.toolEvents) && chunk.toolEvents.length > 0) {
            this.syncLocalPendingCheckpointFromToolEvents(sessionId, chunk.toolEvents);
        }

        if (currentMessage) {
            const resurfacedMessage = this.attachPendingCheckpointDisplayContent(currentMessage, sessionId);
            if (resurfacedMessage !== currentMessage) {
                this.upsertSessionMessage(sessionId, resurfacedMessage);
                currentMessage = resurfacedMessage;
            }
        }

        if (Array.isArray(chunk.artifacts) && chunk.artifacts.length > 0) {
            try {
                chunk.artifacts
                    .filter((artifact) => artifact?.id && artifact?.downloadUrl)
                    .forEach((artifact) => {
                        window.fileManager?.addFile?.(artifact, { sessionId });
                    });
                window.artifactManager?.refresh?.();
            } catch (error) {
                console.warn('[ChatApp] Failed to add generated artifacts to file manager:', error);
            }

            const usableArtifacts = chunk.artifacts
                .filter((artifact) => artifact?.id && (artifact?.downloadUrl || artifact?.bundleDownloadUrl || artifact?.previewUrl || artifact?.sandboxUrl))
                .map((artifact) => ({
                    ...artifact,
                    downloadUrl: artifact.downloadUrl || (artifact.id ? `/api/artifacts/${encodeURIComponent(artifact.id)}/download` : ''),
                }))
                .filter((artifact) => artifact.downloadUrl);
            if (currentMessage && usableArtifacts.length > 0) {
                const existingArtifacts = [
                    ...(Array.isArray(currentMessage.artifacts) ? currentMessage.artifacts : []),
                    ...(Array.isArray(currentMessage.metadata?.artifacts) ? currentMessage.metadata.artifacts : []),
                ];
                const mergedArtifacts = [];
                const seenArtifactIds = new Set();
                [...existingArtifacts, ...usableArtifacts].forEach((artifact) => {
                    const artifactId = String(artifact?.id || '').trim();
                    if (!artifactId || seenArtifactIds.has(artifactId)) {
                        return;
                    }
                    seenArtifactIds.add(artifactId);
                    mergedArtifacts.push(artifact);
                });
                const artifactSummary = String(window.artifactManager?.buildArtifactSummary?.(mergedArtifacts) || '').trim();
                const updatedMessage = {
                    ...currentMessage,
                    artifacts: mergedArtifacts,
                    metadata: {
                        ...(currentMessage.metadata || {}),
                        artifacts: mergedArtifacts,
                    },
                };
                if (artifactSummary && !String(updatedMessage.displayContent || updatedMessage.metadata.displayContent || '').trim()) {
                    updatedMessage.displayContent = artifactSummary;
                    updatedMessage.metadata.displayContent = artifactSummary;
                }
                this.upsertSessionMessage(sessionId, updatedMessage);
                currentMessage = updatedMessage;
            }
        }

        const readyDetail = uiHelpers.isTtsAutoPlayEnabled() && uiHelpers.isTtsAvailable()
            ? 'Ready to speak'
            : 'Reply complete';
        const existingCompletionProgress = currentMessage?.progressState
            || currentMessage?.metadata?.progressState
            || null;
        const shouldPreserveCompletionProgress = existingCompletionProgress
            && typeof existingCompletionProgress === 'object'
            && !Array.isArray(existingCompletionProgress)
            && uiHelpers.isRemoteCliProgressState?.(existingCompletionProgress) === true;
        const completedProgressState = shouldPreserveCompletionProgress
            ? {
                ...existingCompletionProgress,
                phase: 'completed',
                terminal: true,
                live: false,
                detail: extractChatDisplayText(
                    existingCompletionProgress.detail
                    || existingCompletionProgress.reasoningSummary
                    || existingCompletionProgress.summary
                    || readyDetail,
                    { maxLength: 240 },
                ) || readyDetail,
            }
            : null;
        this.updateLiveResponsePhase('ready', readyDetail);
        const finalizedStreamingMessage = this.updateStreamingMessageState({
            liveState: null,
            progressState: completedProgressState,
            isStreaming: false,
            reasoningDisplaySource: streamedReasoningSummary ? 'final' : '',
            reasoningDisplayText: streamedReasoningSummary,
            reasoningDisplayFullText: streamedReasoningSummary,
            reasoningDisplayTitle: streamedReasoningSummary ? 'Reasoning' : '',
            reasoningDisplayIcon: streamedReasoningSummary ? 'brain' : '',
            reasoningDisplayAnimated: false,
        }, {
            render: false,
            scroll: false,
        });

        // Update UI
        const messages = this.syncAnnotatedSurveyStates(sessionId);
        const lastMessage = messages[messages.length - 1];

        const previousMessageIds = new Set(previousMessages.map((message) => message.id));
        const newlyInsertedMessages = messages.filter((message) => !previousMessageIds.has(message.id));
        const insertedSurveyMessage = newlyInsertedMessages.find((message) =>
            message?.syntheticUserCheckpoint === true
            || this.getMessageSurveyDefinition(message),
        );
        const hasVisibleSurveyMessage = messages.some((message) => (
            message?.role === 'assistant'
            && Boolean(this.getMessageSurveyDefinition(message))
        ));
        const persistedAssistantMessage = this.getSessionMessage(sessionId, parentMessageId)
            || finalizedStreamingMessage
            || currentMessage;

        if (insertedSurveyMessage && isVisibleSession) {
            this.renderMessages(messages);
            this.presentAssistantMessage(insertedSurveyMessage, chunk.toolEvents);
        } else if (lastMessage && isVisibleSession) {
            this.renderOrReplaceMessage(lastMessage);
            uiHelpers.markMessageSettled(lastMessage.id);
            this.presentAssistantMessage(lastMessage, chunk.toolEvents);
        }
        if (persistedAssistantMessage) {
            this.persistSessionMessageIfNeeded(sessionId, persistedAssistantMessage);
        }
        
        this.finalizeActiveStreamState({
            clearPendingResync: false,
            scheduleIndicatorHide: true,
            resetRetryAttempt: true,
        });

        if (Array.isArray(chunk.toolEvents) && chunk.toolEvents.length > 0) {
            this.applyManagedAppProgressFromToolEvents(chunk.toolEvents, { sessionId });
            this.appendToolSelectionMessages(parentMessageId, chunk.toolEvents, { sessionId });
        }

        if (Array.isArray(chunk.artifacts) && chunk.artifacts.length > 1) {
            const prompt = String(
                persistedAssistantMessage?.prompt
                || persistedAssistantMessage?.metadata?.prompt
                || '',
            ).trim();
            const model = String(
                persistedAssistantMessage?.model
                || persistedAssistantMessage?.metadata?.model
                || chunk.assistantMetadata?.model
                || '',
            ).trim();
            this.appendGeneratedImageArtifactSelection(parentMessageId, chunk.artifacts, {
                sessionId,
                prompt,
                model,
            });
        }

        if (this.hasSurveyToolEvent(chunk.toolEvents) && !hasVisibleSurveyMessage) {
            void this.recoverPendingSurveyFromBackend(sessionId, parentMessageId);
        }
        
        // Update session info (timestamp changed)
        if (isVisibleSession) {
            this.updateSessionInfo();
        }
        uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
        void this.processMessageQueue({ sessionId });
    }

    handleError(message, status = null) {
        console.error('Chat error:', message, 'status:', status);
        const trackedRequest = this.getTrackedStreamRequest();
        const sessionId = String(trackedRequest?.sessionId || sessionManager.currentSessionId || '').trim();
        const isVisibleSession = this.isVisibleSession(sessionId);
        
        // Check if this is a network/connection error that we should handle gracefully
        const normalizedMessage = String(message || '').toLowerCase();
        const isNetworkError = status == null || status === 0 || status === 408 ||
            message?.includes('fetch') || 
            normalizedMessage.includes('network') ||
            message?.includes('Failed to fetch') ||
            normalizedMessage.includes('abort') ||
            normalizedMessage.includes('timeout') ||
            normalizedMessage.includes('disconnected');

        const isServerError = typeof status === 'number' && status >= 500;
        const acceptedByServer = Boolean((this.pendingStreamResync || this.activeStreamRequest)?.acceptedByServer);

        if (isNetworkError && !isServerError && this.shouldResyncAfterDisconnect(message)) {
            this.handleInterruptedStreamResync({
                reason: 'connection_interrupted',
            });
            return;
        }

        if (isNetworkError && !isServerError && acceptedByServer) {
            this.enterBackgroundStreamMode({
                detail: this.connectionStatus === 'disconnected'
                    ? this.getBackgroundStreamDetail()
                    : String(this.liveResponseState.detail || 'Working through the answer.').trim(),
            });
            this.scheduleResumeSync('stream-resync', this.getBackgroundResyncDelayMs());
            return;
        }
        
        // For network errors, try to retry instead of immediately failing
        if (isNetworkError && !isServerError && !acceptedByServer && this.retryAttempt < this.maxRetries) {
            this.retryAttempt++;
            console.log(`[ChatApp] Retrying after network error (attempt ${this.retryAttempt}/${this.maxRetries})...`);
            
            // Show a gentle warning instead of error
            uiHelpers.showToast(
                `Connection interrupted. Retrying (${this.retryAttempt}/${this.maxRetries})...`, 
                'warning',
                'Reconnecting'
            );
            
            // Wait a bit and retry the last request
            setTimeout(() => {
                // If we have a current streaming message, keep it in "thinking" state
                if (this.currentStreamingMessageId) {
                    const el = document.getElementById(this.currentStreamingMessageId);
                    if (el) {
                        // Update the message to show we're retrying
                        const contentEl = el.querySelector('.message-content');
                        if (contentEl) {
                            contentEl.innerHTML = '<p class="text-text-secondary italic">Reconnecting...</p>';
                        }
                    }
                }
                
                // Retry the request
                this.retryLastRequest();
            }, 1000 * this.retryAttempt); // Exponential backoff
            
            return;
        }
        
        // Max retries exceeded or non-network error - show the error
        // Remove the streaming message placeholder
        if (this.currentStreamingMessageId && sessionId) {
            const el = document.getElementById(this.currentStreamingMessageId);
            if (el && isVisibleSession) {
                el.remove();
            }
            
            // Remove from session
            const messages = sessionManager.getMessages(sessionId);
            if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
                messages.pop();
                sessionManager.saveToStorage();
                const userMessage = [...messages].reverse().find((message) => message.role === 'user');
                if (userMessage) {
                    this.persistSessionMessageIfNeeded(sessionId, userMessage);
                }
            }
        }
        this.finalizeActiveStreamState({
            hideTypingIndicator: true,
            resetRetryAttempt: true,
        });
        
        // Show appropriate error message
        let errorTitle = 'Error';
        if (status === 400) errorTitle = 'Bad Request';
        else if (status === 401) errorTitle = 'Unauthorized';
        else if (status === 429) errorTitle = 'Rate Limited';
        else if (status >= 500) errorTitle = 'Server Error';
        else if (isNetworkError) errorTitle = 'Connection Failed';
        
        // Provide more helpful message for network errors
        let displayMessage = message || 'An error occurred';
        if (isNetworkError && this.retryAttempt >= this.maxRetries) {
            displayMessage = 'Unable to connect after multiple attempts. Please check your connection and try again.';
        }
        
        uiHelpers.showToast(displayMessage, 'error', errorTitle);
        void this.processMessageQueue({ sessionId });
    }
    
    retryLastRequest() {
        // This is called to retry the last message
        // For now, we'll just try to regenerate the last user message
        const sessionId = this.getTrackedStreamSessionId();
        if (!sessionId || !this.isVisibleSession(sessionId)) {
            return;
        }
        const messages = sessionManager.getMessages(sessionId);
        const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');

        if (this.currentAbortController) {
            this.currentAbortController.abort();
            this.currentAbortController = null;
        }

        this.clearCurrentStreamingMessage();
        this.finalizeActiveStreamState({
            hideTypingIndicator: true,
        });
        
        if (lastUserMessage) {
            // Retry sending
            this.sendPreparedMessage(lastUserMessage.content, {
                reuseUserMessage: true,
                userMessage: lastUserMessage,
            });
        } else {
            // Can't retry - show error
            this.handleError('Could not retry request', null);
        }
    }

    handleCancelled(options = {}) {
        const trackedRequest = this.getTrackedStreamRequest();
        const sessionId = String(trackedRequest?.sessionId || sessionManager.currentSessionId || '').trim();
        const isVisibleSession = this.isVisibleSession(sessionId);
        if (this.currentStreamingMessageId && sessionId) {
            const currentMessage = this.getSessionMessage(sessionId, this.currentStreamingMessageId);
            const currentContent = String(currentMessage?.content || '').trim();
            const hasMeaningfulContent = Boolean(currentContent) && !this.isBackgroundPlaceholderContent(currentContent);
            const stoppedMessage = this.upsertSessionMessage(sessionId, {
                ...(currentMessage || {}),
                id: this.currentStreamingMessageId,
                role: 'assistant',
                content: hasMeaningfulContent ? currentContent : 'Stopped.',
                isStreaming: false,
                cancelled: true,
                excludeFromTranscript: !hasMeaningfulContent,
                liveState: null,
                metadata: {
                    ...(currentMessage?.metadata || {}),
                    cancelled: true,
                    pendingForeground: false,
                    isStreaming: false,
                    excludeFromTranscript: !hasMeaningfulContent,
                    stopReason: String(options.reason || 'user_cancelled').trim() || 'user_cancelled',
                    liveState: null,
                },
            });

            if (stoppedMessage) {
                if (isVisibleSession) {
                    this.renderOrReplaceMessage(stoppedMessage);
                    uiHelpers.markMessageSettled(stoppedMessage.id);
                }
                this.persistSessionMessageIfNeeded(sessionId, stoppedMessage);
            }
        }
        this.finalizeActiveStreamState({
            hideTypingIndicator: true,
        });
        if (isVisibleSession) {
            this.updateSessionInfo();
        }
        uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
        void this.processMessageQueue({ sessionId });
    }

    async regenerateResponse(messageId) {
        if (this.isCurrentSessionProcessing()) {
            uiHelpers.showToast('Please wait for the current response to complete', 'warning');
            return;
        }
        
        const sessionId = sessionManager.currentSessionId;
        if (!sessionId) return;
        
        // Find the user message that preceded this assistant message
        const messages = sessionManager.getMessages(sessionId);
        const messageIndex = messages.findIndex(m => m.id === messageId);
        
        if (messageIndex <= 0) return;
        
        // Find the last user message before this assistant message
        let userMessageIndex = messageIndex - 1;
        while (userMessageIndex >= 0 && messages[userMessageIndex].role !== 'user') {
            userMessageIndex--;
        }
        
        if (userMessageIndex < 0) return;
        
        const userMessage = messages[userMessageIndex];
        const previousMessages = messages.slice();
        
        // Remove the old assistant message
        messages.splice(messageIndex, 1);
        
        // Remove from DOM
        const el = document.getElementById(messageId);
        if (el) el.remove();
        
        sessionManager.saveToStorage();
        
        // Show typing indicator
        this.isProcessing = true;
        this.updateSendButton();
        
        // Create new placeholder for assistant response
        const assistantMessage = {
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            isStreaming: true,
            metadata: {
                foregroundRequestId: '',
                pendingForeground: true,
                isStreaming: true,
            },
        };
        
        this.currentStreamingMessageId = uiHelpers.generateMessageId();
        assistantMessage.id = this.currentStreamingMessageId;
        assistantMessage.metadata.foregroundRequestId = assistantMessage.id;
        
        const storedAssistantMessage = sessionManager.addMessage(sessionId, assistantMessage);
        const assistantMessageEl = uiHelpers.renderMessage(storedAssistantMessage, true);
        this.messagesContainer.appendChild(assistantMessageEl);
        uiHelpers.reinitializeIcons(assistantMessageEl);
        uiHelpers.scrollToBottom();
        this.persistSessionMessageIfNeeded(sessionId, storedAssistantMessage);
        this.beginAssistantStream({
            messageId: this.currentStreamingMessageId,
            detail: 'Gathering context and preparing the reply.',
        });
        
        // Get current model
        const model = uiHelpers.getCurrentModel();
        const reasoningEffort = uiHelpers.getCurrentReasoningEffort();
        this.trackActiveStreamRequest({
            sessionId,
            requestType: 'regenerate',
            previousMessages,
            userMessage,
            placeholderMessage: storedAssistantMessage,
        });
        
        // Build message history and stream
        this.currentAbortController = new AbortController();
        
        try {
            apiClient.setSessionId(sessionId);
            const history = this.buildMessageHistory(sessionId);
            let receivedTerminalChunk = false;
            
            for await (const chunk of apiClient.streamChat(
                history,
                model,
                this.currentAbortController.signal,
                reasoningEffort,
                {
                    metadata: {
                        foregroundRequestId: storedAssistantMessage.id,
                        messageId: userMessage.id,
                        assistantMessageId: storedAssistantMessage.id,
                        userMessageTimestamp: userMessage.timestamp,
                        assistantMessageTimestamp: storedAssistantMessage.timestamp,
                    },
                    shouldResyncAfterDisconnect: (error, context) => this.shouldResyncAfterDisconnect(error, context),
                },
            )) {
                if (chunk.type !== 'retry') {
                    this.markActiveStreamAccepted();
                }

                if (chunk.sessionId) {
                    this.syncBackendSession(chunk.sessionId);
                }

                switch (chunk.type) {
                    case 'stream_open':
                        console.debug('[ChatApp] Gateway SSE stream opened.');
                        this.updateConnectionStatus('connected');
                        break;
                    case 'status':
                        this.handleStreamStatus(chunk);
                        break;
                    case 'progress':
                        this.handleProgress(chunk);
                        break;
                    case 'text_delta':
                        this.handleDelta(chunk.content);
                        break;
                    case 'reasoning_summary_delta':
                        this.handleReasoningSummaryDelta(chunk);
                        break;
                    case 'tool_event':
                        this.handleToolEvent(chunk);
                        break;
                    case 'done':
                        receivedTerminalChunk = true;
                        this.handleDone(chunk);
                        break;
                    case 'error':
                        receivedTerminalChunk = true;
                        if (chunk.cancelled) {
                            this.handleCancelled();
                        } else {
                            this.handleError(chunk.error, chunk.status);
                        }
                        break;
                    case 'retry':
                        if (chunk.attempt > 1) {
                            uiHelpers.showToast(`Retrying... (attempt ${chunk.attempt}/${chunk.maxAttempts})`, 'info');
                        }
                        break;
                    case 'resync_required':
                        receivedTerminalChunk = true;
                        this.handleInterruptedStreamResync(chunk);
                        break;
                }
            }

            if (!receivedTerminalChunk && this.isProcessing && this.currentStreamingMessageId === storedAssistantMessage.id) {
                this.handleError('The reply stream ended before completion.', 502);
            }
        } catch (error) {
            console.error('Regenerate error:', error);
            this.handleError(error.message || 'Failed to regenerate response', error?.status);
        } finally {
            this.currentAbortController = null;
        }
    }

    // ============================================
    // Image Generation
    // ============================================

    /**
     * Handle the image modal action button
     * Routes to either generate image or search Unsplash based on selected source
     */
    async handleImageModalAction() {
        const options = uiHelpers.getImageGenerationOptions();
        const source = uiHelpers.getImageSource();
        
        if (!options.prompt) {
            const warning = source === 'unsplash'
                ? 'Please enter a search query'
                : (source === 'podcast' ? 'Please describe the podcast topic or content request' : 'Please enter a prompt');
            uiHelpers.showToast(warning, 'warning');
            return;
        }
        
        if (source === 'unsplash') {
            uiHelpers.closeImageModal();
            await this.searchUnsplashImages(options.prompt);
        } else if (source === 'podcast') {
            await this.handlePodcastProductionAction();
        } else {
            await this.generateImage();
        }
    }

    async handlePodcastProductionAction() {
        const options = uiHelpers.getPodcastProductionOptions();
        if (!options.prompt) {
            uiHelpers.showToast('Please describe the podcast topic or content request', 'warning');
            return;
        }

        uiHelpers.closeImageModal();
        const productionType = options.metadata?.podcastOptions?.productionType === 'video-podcast'
            ? 'video podcast'
            : 'podcast';
        const prefix = /^(make|create|generate|produce)\b/i.test(options.prompt)
            ? ''
            : `Create a ${productionType} about `;
        await this.sendPreparedMessage(`${prefix}${options.prompt}`.trim(), {
            metadata: options.metadata,
        });
    }

    async generateImage(optionsOverride = null) {
        const overrideOptions = optionsOverride && typeof optionsOverride === 'object'
            ? { ...optionsOverride }
            : null;
        const preferredModelId = uiHelpers.getPreferredImageModelId();
        const preferredModel = uiHelpers.getImageModelMetadata(
            overrideOptions?.model || preferredModelId,
        );
        const options = overrideOptions
            ? {
                ...overrideOptions,
                model: overrideOptions.model || preferredModel.id || '',
                size: overrideOptions.size || preferredModel.sizes?.[0] || 'auto',
                source: overrideOptions.source || 'generate',
            }
            : uiHelpers.getImageGenerationOptions();
        
        if (!options.prompt) {
            uiHelpers.showToast('Please enter a prompt', 'warning');
            return;
        }
        
        // Check if we need to create a session
        if (!sessionManager.currentSessionId) {
            await this.createNewSession();
        }
        
        const sessionId = sessionManager.currentSessionId;
        
        // Hide welcome message
        uiHelpers.hideWelcomeMessage();
        
        // Add user message with the prompt
        const userMessage = {
            role: 'user',
            content: `/image ${options.prompt}`,
            clientOnly: true,
            excludeFromTranscript: true,
            timestamp: new Date().toISOString()
        };
        
        const savedUserMessage = sessionManager.addMessage(sessionId, userMessage);
        
        const userMessageEl = uiHelpers.renderMessage(savedUserMessage);
        this.messagesContainer.appendChild(userMessageEl);
        uiHelpers.scrollToBottom();
        void sessionManager.syncMessagesToBackend(sessionId, [savedUserMessage]);
        
        // Create placeholder for image
        const imageMessageId = uiHelpers.generateMessageId();
        this.currentImageMessageId = imageMessageId;
        
        const imageMessage = {
            id: imageMessageId,
            role: 'assistant',
            type: 'image',
            content: `Generating image for "${options.prompt}"`,
            prompt: options.prompt,
            isLoading: true,
            loadingText: 'Generating image...',
            clientOnly: true,
            excludeFromTranscript: true,
            timestamp: new Date().toISOString()
        };
        
        const savedImageMessage = sessionManager.addMessage(sessionId, imageMessage);
        
        const imageMessageEl = uiHelpers.renderImageMessage(savedImageMessage);
        this.messagesContainer.appendChild(imageMessageEl);
        uiHelpers.reinitializeIcons(imageMessageEl);
        uiHelpers.scrollToBottom();
        
        // Close modal and show generating state
        uiHelpers.closeImageModal();
        uiHelpers.setImageGenerateButtonState(true);
        this.isGeneratingImage = true;
        
        try {
            // Add sessionId to options
            options.sessionId = sessionId;
            
            // Call API
            apiClient.setSessionId(sessionId);
            const result = await apiClient.generateImage(options);

            if (Array.isArray(result.artifacts) && result.artifacts.length > 0) {
                try {
                    result.artifacts
                        .filter((artifact) => artifact?.id && artifact?.downloadUrl)
                        .forEach((artifact) => {
                            window.fileManager?.addFile?.(artifact, { sessionId });
                        });
                    window.artifactManager?.refresh?.();
                } catch (error) {
                    console.warn('[ChatApp] Failed to add generated image artifacts to file manager:', error);
                }
            }
            
            // Update the image message with the result
            const resultImages = Array.isArray(result.data) && result.data.length > 0
                ? result.data
                : (Array.isArray(result.artifacts) ? result.artifacts : []);
            const generatedImages = resultImages
                .map((image) => this.normalizeGeneratedImage(image, options.prompt, result.model || options.model || ''))
                .filter(Boolean);

            if (generatedImages.length > 1) {
                const selectionMessage = this.upsertSessionMessage(sessionId, {
                    id: imageMessageId,
                    role: 'assistant',
                    type: 'image-selection',
                    content: `Generated image options for "${options.prompt || 'image'}"`,
                    prompt: options.prompt,
                    model: result.model || options.model,
                    results: generatedImages,
                    sourceKind: 'generated',
                    isLoading: false,
                    clientOnly: true,
                    excludeFromTranscript: true,
                    timestamp: new Date().toISOString(),
                });

                this.renderOrReplaceMessage(selectionMessage || savedImageMessage);
                if (selectionMessage) {
                    void sessionManager.syncMessageToBackend(sessionId, selectionMessage);
                }
                uiHelpers.scrollToBottom();
                uiHelpers.showToast(`Generated ${generatedImages.length} image options`, 'success');
            } else if (generatedImages.length === 1) {
                const imageData = generatedImages[0];

                const nextMessage = this.upsertSessionMessage(sessionId, {
                    id: imageMessageId,
                    role: 'assistant',
                    type: 'image',
                    content: imageData.alt || imageData.prompt || options.prompt || 'Generated image',
                    imageUrl: imageData.imageUrl,
                    thumbnailUrl: imageData.thumbnailUrl || imageData.imageUrl,
                    downloadUrl: imageData.downloadUrl || '',
                    artifactId: imageData.artifactId || '',
                    filename: imageData.filename || '',
                    prompt: options.prompt,
                    revisedPrompt: imageData.revisedPrompt,
                    model: result.model || options.model,
                    generatedImages,
                    source: 'generated',
                    isLoading: false,
                    clientOnly: true,
                    excludeFromTranscript: true,
                    timestamp: new Date().toISOString(),
                });
                this.renderOrReplaceMessage(nextMessage || savedImageMessage);
                if (nextMessage) {
                    void sessionManager.syncMessageToBackend(sessionId, nextMessage);
                }

                uiHelpers.showToast('Image generated successfully', 'success');
            } else {
                const diagnosticSummary = this.getImageDiagnosticSummary(result);
                throw new Error(diagnosticSummary
                    ? `No image data received from API. ${diagnosticSummary}`
                    : 'No image data received from API');
            }
        } catch (error) {
            console.error('Image generation failed:', error);
            
            // Remove the loading message
            const el = document.getElementById(imageMessageId);
            if (el) el.remove();
            
            // Remove from session
            const messages = sessionManager.getMessages(sessionId);
            const msgIndex = messages.findIndex(m => m.id === imageMessageId);
            if (msgIndex >= 0) {
                messages.splice(msgIndex, 1);
                sessionManager.saveToStorage();
            }
            
            uiHelpers.showToast(error.message || 'Failed to generate image', 'error');
        } finally {
            this.isGeneratingImage = false;
            this.currentImageMessageId = null;
            uiHelpers.setImageGenerateButtonState(false);
            this.updateSessionInfo();
            uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
        }
    }

    // ============================================
    // Search
    // ============================================

    openSearch() {
        if (!sessionManager.currentSessionId) {
            uiHelpers.showToast('Open a conversation first', 'info');
            return;
        }
        uiHelpers.openSearch();
    }

    closeSearch() {
        uiHelpers.closeSearch();
    }

    navigateSearch(direction) {
        uiHelpers.navigateSearch(direction);
    }

    // ============================================
    // Export - Enhanced with PDF support
    // ============================================

    async exportConversation(format) {
        format = String(format || '').trim().toLowerCase();
        if (format === 'docx' || format === 'doc' || format === 'word') {
            format = 'html';
        }

        const sessionId = sessionManager.currentSessionId;
        if (!sessionId) {
            uiHelpers.showToast('No conversation to export', 'warning');
            return;
        }
        
        const messages = sessionManager.getMessages(sessionId);
        const session = sessionManager.getCurrentSession();
        
        if (messages.length === 0) {
            uiHelpers.showToast('No messages to export', 'warning');
            return;
        }
        
        // Show progress for formats that need processing
        const showProgress = format === 'pdf';
        
        try {
            const result = await window.importExportManager.exportConversation(format, messages, session);
            
            // Download the file
            if (result.blob) {
                // For blob-based exports (PDF)
                this.downloadBlob(result.blob, result.filename, result.mimeType);
            } else {
                // For text-based exports
                this.downloadFile(result.content, result.filename, result.mimeType);
            }
            
            uiHelpers.closeExportModal();
            uiHelpers.showToast(`Conversation exported as ${format.toUpperCase()}`, 'success');
        } catch (error) {
            console.error('Export failed:', error);
            uiHelpers.showToast(`Export failed: ${error.message}`, 'error');
        }
    }

    /**
     * Export all conversations
     */
    exportAllConversations() {
        const content = sessionManager.exportAll();
        const filename = uiHelpers.createUniqueFilename('all conversations', 'json', 'conversations');
        
        this.downloadFile(content, filename, 'application/json');
        uiHelpers.closeExportModal();
        uiHelpers.showToast(`All conversations exported`, 'success');
    }

    downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        this.downloadBlob(blob, filename, mimeType);
    }

    downloadBlob(blob, filename, mimeType) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = uiHelpers.sanitizeDownloadFilename(filename, 'download');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    exportAsMarkdown(messages, session) {
        const date = new Date().toLocaleString();
        let md = `# ${session?.title || 'Conversation'}\n\n`;
        md += `**Date:** ${date}  \n`;
        md += `**Messages:** ${messages.length}\n\n`;
        md += `---\n\n`;
        
        messages.forEach(msg => {
            const time = new Date(msg.timestamp).toLocaleString();
            let roleLabel;
            switch (msg.role) {
                case 'user':
                    roleLabel = '**You**';
                    break;
                case 'assistant':
                    roleLabel = msg.type === 'image' ? '**AI Image Generator**' : '**Assistant**';
                    break;
                case 'system':
                    roleLabel = '**System**';
                    break;
                default:
                    roleLabel = '**Unknown**';
            }
            md += `### ${roleLabel} *(${time})*\n\n`;
            
            if (msg.type === 'image') {
                md += `*Prompt: "${msg.prompt || ''}"*\n\n`;
                if (msg.imageUrl) {
                    md += `![Generated Image](${msg.imageUrl})\n\n`;
                }
            } else {
                md += msg.content;
            }
            md += '\n\n---\n\n';
        });
        
        return md;
    }

    exportAsJSON(messages, session) {
        const exportData = {
            session: {
                id: session?.id,
                title: session?.title,
                mode: session?.mode,
                createdAt: session?.createdAt,
                exportedAt: new Date().toISOString()
            },
            messages: messages.map(m => ({
                role: m.role,
                type: m.type,
                content: m.content,
                prompt: m.prompt,
                imageUrl: m.imageUrl,
                model: m.model,
                timestamp: m.timestamp
            }))
        };
        
        return JSON.stringify(exportData, null, 2);
    }

    exportAsText(messages, session) {
        const date = new Date().toLocaleString();
        let text = `${session?.title || 'Conversation'}\n`;
        text += `Date: ${date}\n`;
        text += `Messages: ${messages.length}\n`;
        text += `${'='.repeat(50)}\n\n`;
        
        messages.forEach(msg => {
            const time = new Date(msg.timestamp).toLocaleString();
            let roleLabel;
            switch (msg.role) {
                case 'user':
                    roleLabel = 'You';
                    break;
                case 'assistant':
                    roleLabel = msg.type === 'image' ? 'AI Image Generator' : 'Assistant';
                    break;
                case 'system':
                    roleLabel = 'System';
                    break;
                default:
                    roleLabel = 'Unknown';
            }
            text += `[${time}] ${roleLabel}:\n`;
            
            if (msg.type === 'image') {
                text += `Prompt: "${msg.prompt || ''}"\n`;
                if (msg.imageUrl) {
                    text += `Image: ${msg.imageUrl}\n`;
                }
            } else {
                text += msg.content;
            }
            text += '\n\n' + '-'.repeat(50) + '\n\n';
        });
        
        return text;
    }

    // ============================================
    // UI State
    // ============================================

    updateSessionInfo() {
        const session = sessionManager.getCurrentSession();
        if (session) {
            const messageCount = sessionManager.getMessages(session.id)?.length || 0;
            const backgroundSnapshot = this.getCurrentBackgroundWorkloadSnapshot();
            const backgroundStatus = backgroundSnapshot.running > 0
                ? ` | ${this.formatBackgroundTaskCount(backgroundSnapshot.running)} running`
                : (backgroundSnapshot.queued > 0
                    ? ` | ${this.formatBackgroundTaskCount(backgroundSnapshot.queued)} queued`
                    : '');
            const detailsStatus = this.deferredSessionDetailsSessionId === session.id
                ? ' | details loading'
                : '';
            if (uiHelpers.isMinimalistMode()) {
                this.currentSessionInfo.textContent = `${session.title || 'Conversation'} | ${messageCount} message${messageCount !== 1 ? 's' : ''}${backgroundStatus}${detailsStatus}`;
            } else {
                this.currentSessionInfo.textContent = `${sessionManager.getSessionModeLabel(session.mode)} | ${sessionManager.formatTimestamp(session.updatedAt)} | ${messageCount} message${messageCount !== 1 ? 's' : ''}${backgroundStatus}${detailsStatus}`;
            }
            return;
        }

        this.currentSessionInfo.textContent = uiHelpers.isMinimalistMode()
            ? 'Minimalist mode active'
            : 'No active session';
    }

    updateSendButton() {
        const hasContent = this.messageInput?.value?.trim()?.length > 0;
        const canQueue = this.getQueuedMessageCount() < WEB_CHAT_QUEUE_MAX_SIZE;
        const canSend = hasContent && canQueue && !this.isGeneratingImage;
        const showStopControl = this.isCurrentSessionProcessing();
        
        if (this.sendBtn) {
            this.sendBtn.disabled = showStopControl
                ? this.isCancellingCurrentRequest
                : !canSend;
            this.sendBtn.classList.toggle('is-processing', showStopControl);
            
            if (showStopControl) {
                this.sendBtn.innerHTML = `<i data-lucide="square" class="w-4 h-4" aria-hidden="true"></i>`;
                this.sendBtn.setAttribute(
                    'aria-label',
                    this.isCancellingCurrentRequest ? 'Stopping response' : 'Stop response',
                );
                this.sendBtn.setAttribute(
                    'title',
                    this.isCancellingCurrentRequest ? 'Stopping response' : 'Stop response',
                );
                uiHelpers.reinitializeIcons(this.sendBtn);
            } else {
                this.sendBtn.innerHTML = `<i data-lucide="send" class="w-5 h-5" aria-hidden="true"></i>`;
                this.sendBtn.setAttribute('aria-label', 'Send message');
                this.sendBtn.setAttribute('title', 'Send message');
                uiHelpers.reinitializeIcons(this.sendBtn);
            }
        }

        this.updateAudioControls();
    }
    
    // ============================================
    // Connection Status
    // ============================================
    
    updateConnectionStatus(status) {
        const statusEl = document.getElementById('connection-status');
        const indicator = document.getElementById('connection-indicator');
        const text = document.getElementById('connection-text');
        
        if (!statusEl || !indicator || !text) return;
        if (this.connectionStatus === status) return;

        this.connectionStatus = status;
        
        indicator.className = 'connection-indicator';
        statusEl.classList.remove('connected', 'connecting', 'disconnected');
        indicator.setAttribute('aria-hidden', 'true');

        let statusLabel = 'Connecting';
        
        switch (status) {
            case 'connected':
                statusEl.classList.add('connected');
                indicator.classList.add('connected');
                text.textContent = 'Connected';
                statusLabel = 'Connected';
                break;
            case 'disconnected':
                statusEl.classList.add('disconnected');
                indicator.classList.add('disconnected');
                text.textContent = 'Offline';
                statusLabel = 'Offline';
                break;
            case 'checking':
            default:
                statusEl.classList.add('connecting');
                indicator.classList.add('checking');
                text.textContent = 'Connecting...';
                break;
        }

        statusEl.setAttribute('aria-label', `Backend connection status: ${statusLabel}`);
        statusEl.setAttribute('title', `Backend connection status: ${statusLabel}`);
    }
    
    async checkConnection() {
        const health = await apiClient.checkHealth();
        this.updateConnectionStatus(health.connected ? 'connected' : 'disconnected');
        return health;
    }

    trackActiveStreamRequest(context = {}) {
        const sessionId = String(context.sessionId || sessionManager.currentSessionId || '').trim();
        if (!sessionId) {
            return null;
        }

        this.activeStreamRequest = {
            sessionId,
            requestType: String(context.requestType || 'chat'),
            requestId: String(
                context.requestId
                || context.placeholderMessage?.metadata?.foregroundRequestId
                || context.placeholderMessage?.id
                || '',
            ).trim(),
            startedAt: Date.now(),
            acceptedByServer: false,
            lifecycleInterrupted: false,
            interruptionReason: '',
            previousMessages: Array.isArray(context.previousMessages) ? context.previousMessages.slice() : [],
            userMessage: context.userMessage || null,
            placeholderMessage: context.placeholderMessage || null,
            assistantMessageId: String(context.placeholderMessage?.id || '').trim(),
            lastVisibleAssistantMessage: context.placeholderMessage ? {
                ...context.placeholderMessage,
                metadata: context.placeholderMessage?.metadata && typeof context.placeholderMessage.metadata === 'object'
                    ? { ...context.placeholderMessage.metadata }
                    : {},
                liveState: context.placeholderMessage?.liveState && typeof context.placeholderMessage.liveState === 'object'
                    ? { ...context.placeholderMessage.liveState }
                    : null,
            } : null,
            backgroundMode: false,
            maxResyncAttempts: 6,
            resyncAttempts: 0,
        };
        this.pendingStreamResync = null;
        return this.activeStreamRequest;
    }

    markActiveStreamAccepted() {
        const trackedRequest = this.pendingStreamResync || this.activeStreamRequest;
        if (!trackedRequest) {
            return;
        }

        trackedRequest.acceptedByServer = true;
    }

    markActiveStreamInterrupted(reason = 'connection') {
        const trackedRequest = this.pendingStreamResync || this.activeStreamRequest;
        if (!trackedRequest) {
            return;
        }

        trackedRequest.lifecycleInterrupted = true;
        trackedRequest.interruptionReason = String(reason || 'connection');
        trackedRequest.interruptedAt = Date.now();
        this.pendingStreamResync = trackedRequest;
    }

    clearPendingStreamResync() {
        if (this.resumeSyncTimer) {
            clearTimeout(this.resumeSyncTimer);
            this.resumeSyncTimer = null;
        }
        this.pendingStreamResync = null;
        this.resumeSyncInFlight = false;
    }

    shouldResyncAfterDisconnect(error = null, context = {}) {
        const trackedRequest = this.getTrackedStreamRequest();
        if (!trackedRequest) {
            return false;
        }

        const hidden = this.isAppBackgrounded(context);
        const online = context?.online !== false && (typeof navigator === 'undefined' || navigator.onLine !== false);

        if (trackedRequest.lifecycleInterrupted) {
            return true;
        }

        const normalizedMessage = String(error?.message || error || '').toLowerCase();
        const streamEndedBeforeCompletion = String(error?.code || '').toLowerCase() === 'stream_incomplete'
            || normalizedMessage.includes('stream ended before completion')
            || normalizedMessage.includes('ended before completion')
            || normalizedMessage.includes('premature');
        const transientStreamFailure = streamEndedBeforeCompletion
            || normalizedMessage.includes('network')
            || normalizedMessage.includes('fetch')
            || normalizedMessage.includes('timeout')
            || normalizedMessage.includes('disconnect')
            || normalizedMessage.includes('connection');

        if (trackedRequest.acceptedByServer && streamEndedBeforeCompletion) {
            return true;
        }

        if (trackedRequest.acceptedByServer) {
            return hidden || !online || this.pageWasHidden || this.connectionStatus === 'disconnected' || transientStreamFailure;
        }

        if (hidden) {
            return true;
        }

        if (!online) {
            return true;
        }

        return this.pageWasHidden && (
            normalizedMessage.includes('network')
            || normalizedMessage.includes('fetch')
            || normalizedMessage.includes('timeout')
            || normalizedMessage.includes('disconnect')
        );
    }

    captureTrackedAssistantSnapshot(trackedRequest = null) {
        const request = trackedRequest || this.pendingStreamResync || this.activeStreamRequest;
        if (!request) {
            return null;
        }

        const sessionId = String(request.sessionId || sessionManager.currentSessionId || '').trim();
        const messageId = String(request.assistantMessageId || this.currentStreamingMessageId || '').trim();
        if (!sessionId || !messageId) {
            return request.lastVisibleAssistantMessage || null;
        }

        const currentMessage = this.getSessionMessage(sessionId, messageId);
        if (!currentMessage) {
            return request.lastVisibleAssistantMessage || null;
        }

        request.lastVisibleAssistantMessage = {
            ...currentMessage,
            metadata: currentMessage?.metadata && typeof currentMessage.metadata === 'object'
                ? { ...currentMessage.metadata }
                : {},
            liveState: currentMessage?.liveState && typeof currentMessage.liveState === 'object'
                ? { ...currentMessage.liveState }
                : null,
        };

        return request.lastVisibleAssistantMessage;
    }

    isBackgroundPlaceholderContent(content = '') {
        const normalized = String(content || '').trim().toLowerCase();
        return normalized.startsWith('working in background');
    }

    getBackgroundStreamDetail() {
        return 'Working through the answer.';
    }

    getBackgroundResyncDelayMs(attemptCount = 0) {
        const normalizedAttempts = Math.max(0, Number(attemptCount) || 0);
        return Math.min(6000, 1400 + (normalizedAttempts * 450));
    }

    enterBackgroundStreamMode(options = {}) {
        const trackedRequest = this.pendingStreamResync || this.activeStreamRequest;
        if (!trackedRequest) {
            return null;
        }

        const sessionId = String(trackedRequest.sessionId || sessionManager.currentSessionId || '').trim();
        const messageId = String(trackedRequest.assistantMessageId || this.currentStreamingMessageId || '').trim();
        if (!sessionId || !messageId) {
            return null;
        }

        trackedRequest.backgroundMode = true;
        trackedRequest.notifiedResync = true;
        const preservedMessage = trackedRequest.lastVisibleAssistantMessage
            || this.captureTrackedAssistantSnapshot(trackedRequest)
            || trackedRequest.placeholderMessage
            || {};
        const currentMessage = this.getSessionMessage(sessionId, messageId) || {};
        let detail = String(options.detail || '').trim();
        if (!detail || /background/i.test(detail)) {
            detail = String(
                currentMessage.liveState?.detail
                || preservedMessage.liveState?.detail
                || this.liveResponseState.detail
                || ''
            ).trim();
        }
        if (!detail || /background/i.test(detail)) {
            detail = this.getBackgroundStreamDetail();
        }
        const preservedReasoningSummary = String(
            currentMessage.reasoningSummary
            || currentMessage.metadata?.reasoningSummary
            || preservedMessage.reasoningSummary
            || preservedMessage.metadata?.reasoningSummary
            || this.liveResponseState.reasoningSummary
            || ''
        ).trim();
        const shouldPreserveRealReasoning = Boolean(preservedReasoningSummary)
            && this.connectionStatus !== 'disconnected';
        let preservedContent = String(
            options.content !== undefined
                ? options.content
                : (
                    preservedMessage.content
                    || currentMessage.content
                    || trackedRequest.placeholderMessage?.content
                    || ''
                )
        );
        if (this.isBackgroundPlaceholderContent(preservedContent)) {
            preservedContent = '';
        }

        this.currentStreamingMessageId = messageId;
        this.isProcessing = true;
        this.retryAttempt = 0;
        this.clearLiveIndicatorTimer();
        this.resetAmbientReasoningState();
        const initialAmbientFrame = this.getAmbientReasoningFrame(Date.now());
        this.lastReasoningDeltaAt = shouldPreserveRealReasoning ? Date.now() : 0;
        this.liveResponseState = {
            phase: 'thinking',
            detail,
            reasoningSummary: shouldPreserveRealReasoning ? preservedReasoningSummary : '',
            hasRealReasoning: shouldPreserveRealReasoning,
        };
        uiHelpers.showTypingIndicator({
            phase: 'thinking',
            detail,
        });
        const savedMessage = this.updateStreamingMessageState({
            content: preservedContent,
            isStreaming: true,
            liveState: {
                phase: 'thinking',
                detail,
            },
            ...(shouldPreserveRealReasoning
                ? {
                    reasoningSummary: preservedReasoningSummary,
                    reasoningAvailable: true,
                    reasoningDisplaySource: 'stream',
                    reasoningDisplayText: preservedReasoningSummary,
                    reasoningDisplayFullText: preservedReasoningSummary,
                    reasoningDisplayTitle: 'Reasoning',
                    reasoningDisplayIcon: 'brain',
                    reasoningDisplayAnimated: false,
                }
                : {
                    reasoningDisplaySource: 'generated',
                    reasoningDisplayText: initialAmbientFrame.visibleText,
                    reasoningDisplayFullText: initialAmbientFrame.fullText,
                    reasoningDisplayTitle: SYNTHETIC_REASONING_TITLE,
                    reasoningDisplayIcon: 'sparkles',
                    reasoningDisplayAnimated: initialAmbientFrame.isTyping,
                }),
        }, {
            render: true,
            scroll: false,
        });
        this.startAmbientReasoningLoop();

        if (savedMessage) {
            trackedRequest.lastVisibleAssistantMessage = {
                ...savedMessage,
                metadata: savedMessage?.metadata && typeof savedMessage.metadata === 'object'
                    ? { ...savedMessage.metadata }
                    : {},
                liveState: savedMessage?.liveState && typeof savedMessage.liveState === 'object'
                    ? { ...savedMessage.liveState }
                    : null,
            };
        }

        this.updateSendButton();
        return savedMessage;
    }

    findPersistedForegroundMessage(messages = []) {
        return [...(Array.isArray(messages) ? messages : [])]
            .reverse()
            .find((message) => (
                message?.role === 'assistant'
                && message?.isStreaming === true
                && message?.metadata?.staleForeground !== true
                && (
                    message?.metadata?.pendingForeground === true
                    || Boolean(String(message?.metadata?.foregroundRequestId || '').trim())
                )
            )) || null;
    }

    resumePersistedBackgroundStream(sessionId, messages = []) {
        if (!sessionId
            || this.pendingStreamResync
            || this.activeStreamRequest
            || this.isSessionProcessing(sessionId)) {
            return false;
        }

        const persistedMessage = this.findPersistedForegroundMessage(messages);
        if (!persistedMessage) {
            return false;
        }

        const previousMessages = (Array.isArray(messages) ? messages : [])
            .filter((message) => message?.id !== persistedMessage.id);
        const trackedRequest = this.trackActiveStreamRequest({
            sessionId,
            requestType: String(persistedMessage?.metadata?.taskType || 'chat'),
            previousMessages,
            placeholderMessage: persistedMessage,
        });
        if (!trackedRequest) {
            return false;
        }

        trackedRequest.acceptedByServer = true;
        trackedRequest.backgroundMode = true;
        trackedRequest.notifiedResync = true;
        trackedRequest.lastVisibleAssistantMessage = {
            ...persistedMessage,
            metadata: persistedMessage?.metadata && typeof persistedMessage.metadata === 'object'
                ? { ...persistedMessage.metadata }
                : {},
            liveState: persistedMessage?.liveState && typeof persistedMessage.liveState === 'object'
                ? { ...persistedMessage.liveState }
                : null,
        };

        this.markActiveStreamInterrupted('persisted-background');
        this.currentStreamingMessageId = persistedMessage.id;
        this.enterBackgroundStreamMode({
            detail: String(
                persistedMessage?.liveState?.detail
                || this.getBackgroundStreamDetail()
            ).trim(),
            content: String(persistedMessage?.content || ''),
        });

        if (!this.isAppBackgrounded()) {
            this.scheduleResumeSync('stream-resync', 0);
        }

        return true;
    }

    scheduleResumeSync(reason = 'resume', delayMs = 150) {
        const now = Date.now();
        if (reason !== 'stream-resync' && reason !== 'online' && now - this.lastResumeSyncAt < 1200) {
            return;
        }

        if (this.resumeSyncTimer) {
            clearTimeout(this.resumeSyncTimer);
        }

        this.resumeSyncTimer = setTimeout(() => {
            this.runResumeSync(reason).catch((error) => {
                console.warn(`Failed to sync state after ${reason}:`, error);
            });
        }, delayMs);
    }

    async runResumeSync(reason = 'resume') {
        this.resumeSyncTimer = null;
        this.lastResumeSyncAt = Date.now();

        try {
            await this.checkConnection();
        } catch (error) {
            console.warn(`Failed to refresh connection status after ${reason}:`, error);
        }

        if (this.pendingStreamResync) {
            await this.recoverInterruptedStream();
        } else {
            await this.refreshSharedSessionState();
        }

        this.pageWasHidden = false;
    }

    async recoverInterruptedStream() {
        const trackedRequest = this.pendingStreamResync;
        if (!trackedRequest || this.resumeSyncInFlight || this.isAppBackgrounded()) {
            return;
        }

        this.resumeSyncInFlight = true;

        try {
            const sessionId = trackedRequest.sessionId || sessionManager.currentSessionId;
            if (!sessionId) {
                this.finalizeInterruptedStreamFailure();
                return;
            }

            apiClient.setSessionId(sessionId);
            await sessionManager.loadSessions({ preserveCurrentSession: true });
            await sessionManager.loadSessionMessagesFromBackend(sessionId);
            this.updateConnectionStatus('connected');

            const messages = this.syncAnnotatedSurveyStates(sessionId);
            if (this.hasRecoveredInterruptedStream(messages, trackedRequest)) {
                if (this.isVisibleSession(sessionId)) {
                    this.reconcileVisibleMessages(trackedRequest.previousMessages, messages);
                    this.playCueForNewAssistantMessages(trackedRequest.previousMessages, messages);
                    this.updateSessionInfo();
                }
                uiHelpers.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
                this.finalizeActiveStreamState({
                    hideTypingIndicator: true,
                    scheduleIndicatorHide: true,
                });
                void this.processMessageQueue({ sessionId });
                return;
            }

            trackedRequest.resyncAttempts += 1;

            if (trackedRequest.acceptedByServer) {
                this.enterBackgroundStreamMode({
                    detail: this.getBackgroundStreamDetail(),
                });
                this.updateSendButton();
                this.scheduleResumeSync(
                    'stream-resync',
                    this.getBackgroundResyncDelayMs(trackedRequest.resyncAttempts),
                );
                return;
            }

            if (trackedRequest.placeholderMessage) {
                const placeholderMessage = this.upsertSessionMessage(sessionId, {
                    ...trackedRequest.placeholderMessage,
                    content: trackedRequest.placeholderMessage.content || '',
                    isStreaming: true,
                    liveState: {
                        phase: 'thinking',
                        detail: 'Connection restored. Syncing the latest reply.',
                        reasoningSummary: '',
                    },
                });
                this.currentStreamingMessageId = placeholderMessage?.id || trackedRequest.assistantMessageId || null;
                this.renderOrReplaceMessage(placeholderMessage);
                uiHelpers.scrollToBottom(false);
            }

            this.updateLiveResponsePhase('thinking', 'Connection restored. Syncing the latest reply.');
            this.updateSendButton();

            if (trackedRequest.resyncAttempts >= trackedRequest.maxResyncAttempts) {
                this.finalizeInterruptedStreamFailure();
                return;
            }

            this.scheduleResumeSync('stream-resync', 1500);
        } finally {
            this.resumeSyncInFlight = false;
        }
    }

    hasRecoveredInterruptedStream(messages, trackedRequest) {
        if (!Array.isArray(messages) || messages.length === 0) {
            return false;
        }

        const referenceTimestamp = trackedRequest?.userMessage?.timestamp
            || trackedRequest?.placeholderMessage?.timestamp
            || new Date(trackedRequest?.startedAt || Date.now()).toISOString();
        const referenceTime = new Date(referenceTimestamp).getTime();
        const latestAssistantMessage = [...messages].reverse().find((message) => (
            message?.role === 'assistant'
            && message?.isStreaming !== true
            && Boolean(String(message?.content || message?.displayContent || '').trim())
        ));
        if (!latestAssistantMessage) {
            return false;
        }

        const latestAssistantTime = new Date(latestAssistantMessage.timestamp || 0).getTime();
        if (Number.isFinite(referenceTime) && Number.isFinite(latestAssistantTime) && latestAssistantTime >= referenceTime - 1000) {
            return true;
        }

        const trackedAssistantMessage = trackedRequest?.assistantMessageId
            ? messages.find((message) => message?.id === trackedRequest.assistantMessageId && message?.role === 'assistant')
            : null;
        if (trackedAssistantMessage) {
            if (trackedAssistantMessage.isStreaming === true) {
                return false;
            }

            return Boolean(String(trackedAssistantMessage.content || trackedAssistantMessage.displayContent || '').trim());
        }

        return messages.length > trackedRequest.previousMessages.length
            && messages[messages.length - 1]?.role === 'assistant';
    }

    finalizeInterruptedStreamFailure() {
        const trackedRequest = this.getTrackedStreamRequest();
        const maxResyncAttempts = Math.max(1, Number(trackedRequest?.maxResyncAttempts) || 6);
        const resyncAttempts = Math.max(0, Number(trackedRequest?.resyncAttempts) || 0);
        if (trackedRequest?.acceptedByServer && resyncAttempts < maxResyncAttempts) {
            this.enterBackgroundStreamMode({
                detail: this.getBackgroundStreamDetail(),
            });
            this.updateSendButton();
            this.scheduleResumeSync(
                'stream-resync',
                this.getBackgroundResyncDelayMs(trackedRequest?.resyncAttempts || 0),
            );
            return;
        }

        const sessionId = String(trackedRequest?.sessionId || sessionManager.currentSessionId || '').trim();
        const messageId = this.pendingStreamResync?.assistantMessageId || this.currentStreamingMessageId;
        if (sessionId && messageId) {
            const failedEl = document.getElementById(messageId);
            if (failedEl && this.isVisibleSession(sessionId)) {
                failedEl.remove();
            }

            const messages = sessionManager.getMessages(sessionId);
            const index = messages.findIndex((message) => message.id === messageId);
            if (index !== -1) {
                messages.splice(index, 1);
                sessionManager.saveToStorage();
            }
        }

        this.finalizeActiveStreamState({
            hideTypingIndicator: true,
        });
        const syncWarning = trackedRequest?.acceptedByServer
            ? 'The reply could not be resynced after reconnecting. You can retry or send the next message.'
            : 'Connection was restored, but the latest reply could not be synced. Retry if needed.';
        uiHelpers.showToast(syncWarning, 'warning', 'Sync incomplete');
        void this.processMessageQueue({ sessionId });
    }

    handleInterruptedStreamResync(chunk = {}) {
        const trackedRequest = this.pendingStreamResync || this.activeStreamRequest;
        if (!trackedRequest) {
            return;
        }

        this.captureTrackedAssistantSnapshot(trackedRequest);
        this.markActiveStreamInterrupted(chunk.reason || 'connection');
        this.retryAttempt = 0;
        this.currentAbortController = null;
        this.updateConnectionStatus('checking');

        if (trackedRequest.acceptedByServer) {
            this.enterBackgroundStreamMode({
                detail: this.getBackgroundStreamDetail(),
            });
            if (!this.isAppBackgrounded()) {
                this.scheduleResumeSync('stream-resync', 0);
            }
            return;
        }

        this.updateLiveResponsePhase('thinking', 'Connection changed. Syncing the latest reply.');

        if (trackedRequest.placeholderMessage) {
            this.updateStreamingMessageState({
                content: trackedRequest.placeholderMessage.content || '',
                isStreaming: true,
                liveState: {
                    phase: 'thinking',
                    detail: 'Connection changed. Syncing the latest reply.',
                    reasoningSummary: '',
                },
            }, {
                render: true,
                scroll: false,
            });
        }

        if (!trackedRequest.notifiedResync) {
            uiHelpers.showToast('Connection changed while the app was asleep. Syncing the latest reply...', 'info', 'Reconnected');
            trackedRequest.notifiedResync = true;
        }

        if (!this.isAppBackgrounded()) {
            this.scheduleResumeSync('stream-resync', 0);
        }
    }

    buildMessageRefreshSignature(messages = []) {
        return JSON.stringify((Array.isArray(messages) ? messages : []).slice(-5).map((message) => ([
            message?.id || '',
            message?.timestamp || '',
            message?.role || '',
            String(message?.content || ''),
            message?.isStreaming === true,
            String(message?.displayContent || ''),
            String(message?.reasoningSummary || message?.metadata?.reasoningSummary || ''),
        ])));
    }

    async refreshSharedSessionState(options = {}) {
        if (this.isProcessing && options.allowWhileProcessing !== true) {
            return;
        }
        if (this.sharedSessionRefreshInFlight) {
            return;
        }

        this.sharedSessionRefreshInFlight = true;
        const previousSessionId = sessionManager.currentSessionId;
        const previousMessages = previousSessionId ? sessionManager.getMessages(previousSessionId) : [];
        const previousMessageCount = previousMessages.length;
        const previousLastTimestamp = previousMessages[previousMessages.length - 1]?.timestamp || '';
        const previousSignature = this.buildMessageRefreshSignature(previousMessages);

        try {
            await sessionManager.loadSessions({ preserveCurrentSession: true });

            const currentSessionId = sessionManager.currentSessionId;
            apiClient.setSessionId(currentSessionId || null);

            if (!currentSessionId) {
                if (previousSessionId) {
                    uiHelpers.clearMessages();
                    this.subscribeToSessionUpdates(null);
                    this.currentSessionWorkloads = [];
                    this.workloadRunsById.clear();
                    this.hiddenCompletedWorkloadCount = 0;
                    this.renderWorkloadsPanel();
                    this.updateSessionInfo();
                }
                return;
            }

            if (currentSessionId !== previousSessionId) {
                await this.loadSessionMessages(currentSessionId);
                this.subscribeToSessionUpdates(currentSessionId);
                await this.loadSessionWorkloads(currentSessionId, { force: true });
                this.updateSessionInfo();
                return;
            }

            await sessionManager.loadSessionMessagesFromBackend(currentSessionId);
            const messages = this.syncAnnotatedSurveyStates(currentSessionId);
            const refreshedCount = messages.length;
            const refreshedLastTimestamp = messages[messages.length - 1]?.timestamp || '';
            const refreshedSignature = this.buildMessageRefreshSignature(messages);

            if (refreshedCount !== previousMessageCount
                || refreshedLastTimestamp !== previousLastTimestamp
                || refreshedSignature !== previousSignature) {
                this.reconcileVisibleMessages(previousMessages, messages);
                this.resumePersistedBackgroundStream(currentSessionId, messages);
                this.playCueForNewAssistantMessages(previousMessages, messages);
                this.updateSessionInfo();
            }
        } finally {
            this.sharedSessionRefreshInFlight = false;
        }
    }
    
    startHealthCheckInterval() {
        // Check every 30 seconds
        setInterval(async () => {
            if (this.isAppBackgrounded()) {
                return;
            }
            const health = await apiClient.checkHealth();
            this.updateConnectionStatus(health.connected ? 'connected' : 'disconnected');
        }, 30000);
    }

    startSharedSessionSyncInterval() {
        this.sharedSessionSyncTimer = setInterval(() => {
            if (this.isAppBackgrounded()) {
                return;
            }

            const refreshAction = this.pendingStreamResync
                ? this.recoverInterruptedStream()
                : this.refreshSharedSessionState();
            refreshAction.catch((error) => {
                console.warn('Failed to refresh shared session state:', error);
            });
        }, 15000);
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.chatApp = new ChatApp();
    window.app = window.chatApp; // Backward compatibility
});
