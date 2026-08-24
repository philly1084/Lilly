/**
 * Code CLI App
 * Terminal-style coding interface for LillyBuilt AI
 */

const WEB_CLI_LONG_AGENT_ENABLED_KEY = 'codecli-long-agent-enabled';
const WEB_CLI_TTS_MESSAGE_PREFIX = 'web-cli-tts';
const WEB_CLI_PINNED_COMMANDS_KEY = 'codecli-pinned-commands';
const WEB_CLI_DENSITY_KEY = 'codecli-density';
const WEB_CLI_CURRENT_HELP_COMMAND_IDS = new Set([
    'help',
    'clear',
    'new',
    'sessions',
    'switch',
    'delete',
    'models',
    'model',
    'tts',
    'theme',
    'density',
    'enterprise',
    'status',
    'brief',
    'next',
    'audit',
    'packet',
    'register',
    'gates',
    'ops',
    'evidence',
    'review',
    'find',
    'pins',
    'pin',
    'unpin',
    'tools',
    'tool',
    'tool-help',
    'skills',
    'skill',
    'files',
    'open',
    'download',
    'upload',
    'remote-status',
    'remote-tools',
    'remote-agent',
    'remote-run',
    'remote-verify',
    'sandbox',
    'sandbox-help',
    'build',
    'canvas',
    'long-agent',
    'workflows',
    'export',
    'history',
    'artifacts',
    'shortcuts',
    'health',
]);
const WEB_CLI_DEFAULT_THEME = 'command-center';
const WEB_CLI_SELECTED_ARTIFACT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,299}$/i;

function formatWebCliSkillTaskPrompt(skillId = '', taskPrompt = '') {
    const normalizedSkillId = String(skillId || '').trim();
    const normalizedPrompt = String(taskPrompt || '').trim();
    const skillLabel = normalizedSkillId ? `\`${normalizedSkillId}\`` : 'the selected';
    const prefix = `Use the ${skillLabel} skill for this task.`;
    const handoff = 'Read the skill instructions first, then follow its required workflow and verification steps.';
    return normalizedPrompt
        ? `${prefix}\n${handoff}\n\nTask:\n${normalizedPrompt}`
        : `${prefix}\n${handoff}\n\nTask:\nDescribe the task here.`;
}

class CodeCLIApp {
    constructor() {
        this.history = [];
        this.historyIndex = -1;
        this.currentOutput = '';
        this.isProcessing = false;
        this.currentRequestController = null;
        this.themeCatalog = window.KimiBuiltThemePresets || null;
        this.theme = this.normalizeThemeId(
            localStorage.getItem('codecli-theme')
            || localStorage.getItem(this.themeCatalog?.storageKeys?.preset || 'kimibuilt_theme_preset')
            || WEB_CLI_DEFAULT_THEME
        ) || WEB_CLI_DEFAULT_THEME;
        this.density = this.normalizeDensity(localStorage.getItem(WEB_CLI_DENSITY_KEY)) || 'comfortable';
        this.commandHistory = JSON.parse(localStorage.getItem('codecli-cmd-history') || '[]');
        this.autocompleteIndex = -1;
        this.autocompleteMatches = [];
        this.lastResponse = '';
        this.sessionStartTime = Date.now();
        this.voxel = window.VoxelPets;
        this.voxelPet = this.loadVoxelPet();
        this.voxelPetHidden = localStorage.getItem('codecli-voxel-pet-hidden') === 'true';
        this.longAgentCliEnabled = this.loadLongAgentCliEnabled();
        this.activePetAction = 'idle';
        this.lastVoxelTypingReaction = 0;
        this.lastVoxelAmbientMove = Date.now();
        this.lastVoxelRoamPlacement = 'prompt';
        this.voxelRoamHoldUntil = 0;
        this.pixelStreamBuffer = '';
        this.pixelStreamTimer = null;
        this.pixelStreamWaiters = [];
        this.voxelPersonality = this.loadVoxelPersonality();
        this.activeVoxelTool = 'chat';
        this.liveProgressState = null;
        this.liveReasoningSummary = '';
        this.liveToolEvents = [];
        this.liveProgressLastRenderAt = 0;
        this.liveProgressRenderTimer = null;
        this.installTtsStorageBridge();
        const RealtimeTtsManager = window.KimiBuiltRealtimeTtsManager || window.WebChatTtsManager;
        this.ttsManager = RealtimeTtsManager ? new RealtimeTtsManager() : null;
        this.ttsInitialized = false;
        this.ttsMessageCounter = 0;
        this.responseRegionSequence = 0;
        this.ttsMessageTextById = new Map();
        this.speechHighlightState = {
            messageId: '',
            lastSearchOffset: 0,
            lastChunkIndex: -1,
        };
        
        // Session file storage
        this.sessionFiles = [];
        this.nextFileId = 1;
        this.selectedRemoteArtifactIds = new Set();
        this.webPushInFlightArtifactIds = new Set();
        this.artifactHandoff = null;
        this.artifactHandoffPromise = null;
        
        // Command queue
        this.commandQueue = [];
        this.isProcessingQueue = false;
        
        this.commandCatalog = this.buildCommandCatalog();
        this.commands = this.commandCatalog
            .flatMap((command) => [command.command, ...(command.aliases || [])])
            .filter(Boolean);
        this.pinnedCommands = this.loadPinnedCommands();
        this.cliMenuBackStack = [];
        this.cliMenuCurrentView = null;
        this.toolCatalogById = new Map();
        this.skillCatalogById = new Map();
        
        this.init();
    }

    installTtsStorageBridge() {
        if (typeof window === 'undefined') {
            return;
        }

        const storageHost = window.sessionManager && typeof window.sessionManager === 'object'
            ? window.sessionManager
            : {};
        window.sessionManager = storageHost;

        if (typeof storageHost.safeStorageGet !== 'function') {
            storageHost.safeStorageGet = (key) => {
                try {
                    return window.localStorage.getItem(key);
                } catch (_error) {
                    return null;
                }
            };
        }

        if (typeof storageHost.safeStorageSet !== 'function') {
            storageHost.safeStorageSet = (key, value) => {
                try {
                    window.localStorage.setItem(key, value);
                    return true;
                } catch (_error) {
                    return false;
                }
            };
        }
    }
    
    init() {
        this.terminalOutput = document.getElementById('terminalOutput');
        this.commandInput = document.getElementById('commandInput');
        this.modelSelect = document.getElementById('modelSelect');
        this.themeButton = document.getElementById('themeButton');
        this.densityButton = document.getElementById('densityButton');
        this.commandDrawerToggle = document.getElementById('commandDrawerToggle');
        this.commandDrawer = document.getElementById('commandDrawer');
        this.enterpriseButton = document.getElementById('enterpriseButton');
        this.ttsToggleButton = document.getElementById('ttsToggleButton');
        this.statusDot = document.getElementById('statusDot');
        this.statusText = document.getElementById('statusText');
        this.sessionInfo = document.getElementById('sessionInfo');
        this.inputPrompt = document.querySelector('.input-prompt');
        this.autocompleteEl = document.getElementById('autocomplete');
        this.shortcutsModal = document.getElementById('shortcutsModal');
        this.cliStatus = document.getElementById('cliStatus');
        this.queueIndicator = document.getElementById('queueIndicator');
        this.commandAssist = document.getElementById('commandAssist');
        this.cancelRequestButton = document.getElementById('cancelRequestButton');
        this.shortcutsReturnFocus = null;
        // Queue elements removed - using inline status only
        this.queueSection = null;
        this.queueList = null;
        this.queueCount = null;
        this.dragEnterCounter = 0;  // For reliable drag overlay
        this.voxelDock = document.getElementById('voxelDock');
        this.voxelPetStage = document.getElementById('voxelPetStage');
        this.voxelPetName = document.getElementById('voxelPetName');
        this.voxelPetKind = document.getElementById('voxelPetKind');
        this.voxelPetMood = document.getElementById('voxelPetMood');
        this.voxelPetEnergy = document.getElementById('voxelPetEnergy');
        this.voxelPetSeed = document.getElementById('voxelPetSeed');
        this.voxelPetPrompt = document.getElementById('voxelPetPrompt');
        this.voxelPetButton = document.getElementById('voxelPetButton');
        this.voxelPetMini = document.getElementById('voxelPetMini');
        this.voxelPetStatus = document.getElementById('voxelPetStatus');
        this.voxelRoamer = document.getElementById('voxelRoamer');
        this.voxelRoamerStage = document.getElementById('voxelRoamerStage');
        this.voxelToolbelt = document.getElementById('voxelToolbelt');
        this.voxelBondStat = document.getElementById('voxelBondStat');
        this.voxelFocusStat = document.getElementById('voxelFocusStat');
        this.voxelBuildStat = document.getElementById('voxelBuildStat');
        this.voxelToolStat = document.getElementById('voxelToolStat');
        
        this.setupEventListeners();
        this.setupCommandDrawer();
        this.applyTheme(this.theme);
        this.applyDensity(this.density);
        this.initializeTts();
        this.renderVoxelPet();
        this.initMermaid();
        this.checkConnection();
        this.loadModels();
        this.printWelcome();
        this.sessionRestorePromise = this.restoreSharedSession();
        this.scheduleVoxelAmbientMove();
    }
    
    initMermaid() {
        // Initialize Mermaid with appropriate theme
        if (typeof mermaid !== 'undefined') {
            mermaid.initialize({
                startOnLoad: false,
                theme: this.theme === 'light' ? 'default' : 'dark',
                securityLevel: 'loose',
                fontFamily: 'var(--font-family)'
            });
        }
    }

    buildCommandCatalog() {
        return [
            {
                id: 'ask',
                command: 'ask',
                label: 'Ask',
                icon: '>',
                category: 'Chat',
                description: 'Start a normal Lilly request in the CLI input.',
                template: '',
                featured: true,
                requiresInput: true,
                arguments: 'plain-language request',
            },
            {
                id: 'help',
                command: '/help',
                aliases: ['/?'],
                label: 'Help',
                icon: '?',
                category: 'General',
                description: 'Show the full command guide.',
                template: '/help',
                featured: true,
            },
            {
                id: 'clear',
                command: '/clear',
                aliases: ['/cls'],
                label: 'Clear',
                icon: 'C',
                category: 'General',
                description: 'Clear the terminal transcript.',
                template: '/clear',
            },
            {
                id: 'new',
                command: '/new',
                label: 'New Chat',
                icon: '+',
                category: 'Session',
                description: 'Start a fresh isolated backend session.',
                template: '/new ',
                arguments: 'optional session name',
            },
            {
                id: 'sessions',
                command: '/sessions',
                label: 'Sessions',
                icon: 'S',
                category: 'Session',
                description: 'List isolated Voxel CLI sessions.',
                template: '/sessions',
            },
            {
                id: 'switch',
                command: '/switch',
                label: 'Switch',
                icon: 'SW',
                category: 'Session',
                description: 'Switch to a session by number, id, or prefix.',
                template: '/switch ',
                requiresInput: true,
                arguments: 'session id, prefix, or list number',
            },
            {
                id: 'delete',
                command: '/delete',
                aliases: ['/del', '/rm'],
                label: 'Delete',
                icon: 'D',
                category: 'Session',
                description: 'Delete a session by number, id, or prefix.',
                template: '/delete ',
                requiresInput: true,
                arguments: 'session id, prefix, or list number',
            },
            {
                id: 'models',
                command: '/models',
                label: 'Models',
                icon: 'M',
                category: 'AI Controls',
                description: 'List available AI models.',
                template: '/models',
            },
            {
                id: 'model',
                command: '/model',
                label: 'Set Model',
                icon: 'M+',
                category: 'AI Controls',
                description: 'Change the current AI model.',
                template: '/model ',
                featured: true,
                requiresInput: true,
                arguments: 'model id',
            },
            {
                id: 'tts',
                command: '/tts',
                aliases: ['/voice'],
                label: 'Voice',
                icon: 'VO',
                category: 'AI Controls',
                description: 'Inspect, enable, stop, or configure response read-aloud.',
                template: '/tts ',
                arguments: 'status, on, off, stop, voices, or voice id',
            },
            {
                id: 'theme',
                command: '/theme',
                label: 'Theme',
                icon: 'TH',
                category: 'General',
                description: 'Set voxel or a shared web-chat theme.',
                template: '/theme ',
                arguments: 'theme name or list',
            },
            {
                id: 'density',
                command: '/density',
                aliases: ['/compact'],
                label: 'Density',
                icon: 'DN',
                category: 'General',
                description: 'Switch between roomy and compact enterprise layouts.',
                template: '/density compact',
                arguments: 'compact or roomy',
            },
            {
                id: 'enterprise',
                command: '/enterprise',
                aliases: ['/workmode', '/professional'],
                label: 'Enterprise Mode',
                icon: 'EM',
                category: 'General',
                description: 'Apply compact, command-center defaults and hide companion UI chrome.',
                template: '/enterprise',
                featured: true,
            },
            {
                id: 'status',
                command: '/status',
                label: 'Status',
                icon: 'ST',
                category: 'System',
                description: 'Show one operational card for session, files, model, theme, and runtime state.',
                template: '/status',
                featured: true,
            },
            {
                id: 'brief',
                command: '/brief',
                aliases: ['/handoff', '/summary'],
                label: 'Brief',
                icon: 'BR',
                category: 'Session',
                description: 'Build a concise local handoff brief from transcript, files, and runtime state.',
                template: '/brief',
                featured: true,
            },
            {
                id: 'next',
                command: '/next',
                aliases: ['/next-actions', '/todo'],
                label: 'Next Actions',
                icon: 'NA',
                category: 'Session',
                description: 'Show a prioritized local action plan for the current session state.',
                template: '/next',
                featured: true,
            },
            {
                id: 'audit',
                command: '/audit',
                aliases: ['/activity', '/trail'],
                label: 'Audit Trail',
                icon: 'AT',
                category: 'Session',
                description: 'Show a local audit trail for messages, files, commands, and runtime state.',
                template: '/audit',
                featured: true,
            },
            {
                id: 'packet',
                command: '/packet',
                aliases: ['/handoff-packet', '/continue'],
                label: 'Packet',
                icon: 'PK',
                category: 'Session',
                description: 'Build one continuation packet from status, brief, audit trail, pins, and recent context.',
                template: '/packet',
                featured: true,
            },
            {
                id: 'register',
                command: '/register',
                aliases: ['/decisions', '/risks'],
                label: 'Register',
                icon: 'RG',
                category: 'Session',
                description: 'Extract a local decision, risk, and action register from the current transcript.',
                template: '/register',
                featured: true,
            },
            {
                id: 'gates',
                command: '/gates',
                aliases: ['/quality', '/readiness'],
                label: 'Quality Gates',
                icon: 'QG',
                category: 'Session',
                description: 'Show pass/warn/fail readiness gates for the current CLI session.',
                template: '/gates',
                featured: true,
            },
            {
                id: 'ops',
                command: '/ops',
                aliases: ['/dashboard', '/snapshot'],
                label: 'Ops Snapshot',
                icon: 'OS',
                category: 'Session',
                description: 'Show one operating snapshot across status, gates, register, pins, and handoff readiness.',
                template: '/ops',
                featured: true,
            },
            {
                id: 'evidence',
                command: '/evidence',
                aliases: ['/proof', '/receipts'],
                label: 'Evidence Pack',
                icon: 'EV',
                category: 'Session',
                description: 'Package session proof from status, gates, register, audit, files, and recent commands.',
                template: '/evidence',
                featured: true,
            },
            {
                id: 'review',
                command: '/review',
                aliases: ['/queue', '/triage', '/issue-queue'],
                label: 'Review Queue',
                icon: 'RQ',
                category: 'Session',
                description: 'Prioritize open risks, warnings, and next actions for fast handoff.',
                template: '/review',
                featured: true,
            },
            {
                id: 'find',
                command: '/find',
                aliases: ['/search'],
                label: 'Find',
                icon: 'FN',
                category: 'Session',
                description: 'Search the current transcript and generated session files locally.',
                template: '/find ',
                featured: true,
                requiresInput: true,
                arguments: 'query text',
            },
            {
                id: 'pins',
                command: '/pins',
                aliases: ['/pinboard'],
                label: 'Pinboard',
                icon: 'PB',
                category: 'Session',
                description: 'Open pinned commands and recent launchers for this browser.',
                template: '/pins',
                featured: true,
            },
            {
                id: 'pin',
                command: '/pin',
                label: 'Pin Command',
                icon: 'P+',
                category: 'Session',
                description: 'Add a command or prompt starter to the local pinboard.',
                template: '/pin ',
                requiresInput: true,
                arguments: 'command text',
            },
            {
                id: 'unpin',
                command: '/unpin',
                label: 'Unpin Command',
                icon: 'P-',
                category: 'Session',
                description: 'Remove a pinned command by number or exact command text.',
                template: '/unpin ',
                requiresInput: true,
                arguments: 'pin number or command text',
            },
            {
                id: 'voxel',
                command: '/voxel',
                label: 'Voxel',
                icon: 'VX',
                category: 'General',
                description: 'Switch back to the voxel CLI theme.',
                template: '/voxel',
            },
            {
                id: 'tools',
                command: '/tools',
                label: 'Tools',
                icon: 'T',
                category: 'AI Controls',
                description: 'List frontend-available backend tools.',
                template: '/tools ',
                featured: true,
                arguments: 'optional category',
            },
            {
                id: 'tool',
                command: '/tool',
                label: 'Run Tool',
                icon: 'TX',
                category: 'AI Controls',
                description: 'Invoke one tool with JSON parameters.',
                template: '/tool ',
                requiresInput: true,
                arguments: 'tool id and JSON params',
            },
            {
                id: 'tool-help',
                command: '/tool-help',
                label: 'Tool Help',
                icon: 'TD',
                category: 'AI Controls',
                description: 'Show documentation for one tool.',
                template: '/tool-help ',
                requiresInput: true,
                arguments: 'tool id',
            },
            {
                id: 'skills',
                command: '/skills',
                label: 'Skills',
                icon: 'K',
                category: 'AI Controls',
                description: 'List registered low-context skills.',
                template: '/skills ',
                featured: true,
                arguments: 'optional search',
            },
            {
                id: 'skill',
                command: '/skill',
                label: 'Skill',
                icon: 'KS',
                category: 'AI Controls',
                description: 'Show one registered skill.',
                template: '/skill ',
                requiresInput: true,
                arguments: 'skill id',
            },
            {
                id: 'skill-create',
                command: '/skill-create',
                label: 'Create Skill',
                icon: 'K+',
                category: 'AI Controls',
                description: 'Create a reusable skill chain.',
                template: '/skill-create ',
                requiresInput: true,
                arguments: 'JSON payload',
            },
            {
                id: 'skill-update',
                command: '/skill-update',
                label: 'Update Skill',
                icon: 'KU',
                category: 'AI Controls',
                description: 'Update a reusable skill chain.',
                template: '/skill-update ',
                requiresInput: true,
                arguments: 'skill id and JSON payload',
            },
            {
                id: 'files',
                command: '/files',
                aliases: ['/ls'],
                label: 'Files',
                icon: 'F',
                category: 'Files',
                description: 'List generated session files.',
                template: '/files',
                featured: true,
            },
            {
                id: 'download',
                command: '/download',
                label: 'Download',
                icon: 'DL',
                category: 'Files',
                description: 'Download a generated file by id.',
                template: '/download ',
                requiresInput: true,
                arguments: 'file id',
            },
            {
                id: 'open',
                command: '/open',
                label: 'Open Files',
                icon: 'OP',
                category: 'Files',
                description: 'Open the graphical file manager.',
                template: '/open',
            },
            {
                id: 'remote',
                command: '/remote',
                label: 'Remote',
                icon: 'R',
                category: 'Remote',
                description: 'Use remote status, tools, plan, run, agent, or verify subcommands.',
                template: '/remote ',
                arguments: 'status, tools, plan, run, agent, or verify',
            },
            {
                id: 'remote-plan',
                command: '/remote plan',
                aliases: ['/remote help'],
                label: 'Remote Plan',
                icon: 'RP',
                category: 'Remote',
                description: 'Show remote build and deploy lanes.',
                template: '/remote plan',
            },
            {
                id: 'remote-status',
                command: '/remote status',
                label: 'Remote Status',
                icon: 'RS',
                category: 'Remote',
                description: 'Check remote runner health and target details.',
                template: '/remote status',
            },
            {
                id: 'remote-tools',
                command: '/remote tools',
                label: 'Remote Tools',
                icon: 'RT',
                category: 'Remote',
                description: 'List exact remote CLI catalog commands.',
                template: '/remote tools',
            },
            {
                id: 'remote-run',
                command: '/remote run',
                label: 'Remote Run',
                icon: 'RR',
                category: 'Remote',
                description: 'Run one purposeful remote inspect or verify command.',
                template: '/remote run ',
                requiresInput: true,
                arguments: 'remote shell command',
            },
            {
                id: 'remote-agent',
                command: '/remote agent',
                label: 'Remote Agent',
                icon: 'RA',
                category: 'Remote',
                description: 'Hand a full coding, build, deploy, or verify task to the remote CLI agent.',
                template: '/remote agent ',
                featured: true,
                requiresInput: true,
                arguments: 'task for the remote CLI agent',
            },
            {
                id: 'remote-verify',
                command: '/remote verify',
                label: 'Verify URL',
                icon: 'RV',
                category: 'Remote',
                description: 'Run an HTTPS verification against a host.',
                template: '/remote verify ',
                arguments: 'optional host',
            },
            {
                id: 'sandbox',
                command: '/sandbox',
                label: 'Sandbox',
                icon: 'SB',
                category: 'Build',
                description: 'Run code or save previewable HTML/Vite-style projects.',
                template: '/sandbox ',
                featured: true,
                requiresInput: true,
                arguments: 'language plus code or project JSON',
            },
            {
                id: 'sandbox-project',
                command: '/sandbox project',
                label: 'Sandbox Project',
                icon: 'SP',
                category: 'Build',
                description: 'Save a previewable project from a JSON file bundle.',
                template: '/sandbox project ',
                requiresInput: true,
                arguments: 'project JSON',
            },
            {
                id: 'sandbox-help',
                command: '/sandbox-help',
                label: 'Sandbox Help',
                icon: 'SH',
                category: 'Build',
                description: 'Show sandbox usage and examples.',
                template: '/sandbox-help',
            },
            {
                id: 'build',
                command: '/build',
                label: 'Build Mode',
                icon: 'B',
                category: 'Build',
                description: 'Show the coding-agent build workflow.',
                template: '/build',
                featured: true,
            },
            {
                id: 'canvas',
                command: '/canvas',
                label: 'Canvas',
                icon: 'CV',
                category: 'Build',
                description: 'Generate structured Canvas content from the CLI.',
                template: '/canvas document ',
                featured: true,
                requiresInput: true,
                arguments: 'code, document, or diagram plus prompt',
            },
            {
                id: 'long-agent',
                command: '/long-agent',
                aliases: ['/long'],
                label: 'Long Agent',
                icon: 'LA',
                category: 'Build',
                description: 'Enable, disable, inspect, or queue bounded long-form work.',
                template: '/long-agent ',
                requiresInput: true,
                arguments: 'on, off, status, or goal',
            },
            {
                id: 'workflows',
                command: '/workflows',
                aliases: ['/workflow', '/playbook', '/wf'],
                label: 'Workflows',
                icon: 'WF',
                category: 'Build',
                description: 'Open reusable enterprise task starters for common CLI work.',
                template: '/workflows',
                featured: true,
                arguments: 'optional search term',
            },
            {
                id: 'image',
                command: '/image',
                label: 'Image',
                icon: 'IM',
                category: 'Media',
                description: 'Generate an image from a prompt.',
                template: '/image ',
                featured: true,
                requiresInput: true,
                arguments: 'image prompt and options',
            },
            {
                id: 'image-models',
                command: '/image-models',
                label: 'Image Models',
                icon: 'IL',
                category: 'Media',
                description: 'List available image models.',
                template: '/image-models',
            },
            {
                id: 'unsplash',
                command: '/unsplash',
                label: 'Unsplash',
                icon: 'US',
                category: 'Media',
                description: 'Search Unsplash for stock images.',
                template: '/unsplash ',
                requiresInput: true,
                arguments: 'search query',
            },
            {
                id: 'podcast',
                command: '/podcast',
                label: 'Podcast',
                icon: 'P',
                category: 'Media',
                description: 'Create a basic audio podcast.',
                template: '/podcast ',
                requiresInput: true,
                arguments: 'topic and options',
            },
            {
                id: 'video-podcast',
                command: '/video-podcast',
                label: 'Video Podcast',
                icon: 'VP',
                category: 'Media',
                description: 'Create a video podcast.',
                template: '/video-podcast ',
                requiresInput: true,
                arguments: 'topic and options',
            },
            {
                id: 'diagram',
                command: '/diagram',
                label: 'Diagram',
                icon: 'DG',
                category: 'Media',
                description: 'Generate a Mermaid diagram.',
                template: '/diagram ',
                requiresInput: true,
                arguments: 'type and prompt',
            },
            {
                id: 'upload',
                command: '/upload',
                label: 'Upload',
                icon: 'UP',
                category: 'Files',
                description: 'Upload a file for context.',
                template: '/upload',
            },
            {
                id: 'session',
                command: '/session',
                label: 'Session',
                icon: 'SI',
                category: 'Session',
                description: 'Show session info or run session subcommands.',
                template: '/session ',
                arguments: 'optional new, list, switch, delete',
            },
            {
                id: 'history',
                command: '/history',
                label: 'History',
                icon: 'H',
                category: 'Session',
                description: 'Show persisted isolated session history.',
                template: '/history',
            },
            {
                id: 'artifacts',
                command: '/artifacts',
                label: 'Artifacts',
                icon: 'A',
                category: 'Files',
                description: 'Show persisted isolated session artifacts.',
                template: '/artifacts',
            },
            {
                id: 'stats',
                command: '/stats',
                label: 'Stats',
                icon: '#',
                category: 'Session',
                description: 'Show session statistics.',
                template: '/stats',
            },
            {
                id: 'shortcuts',
                command: '/shortcuts',
                aliases: ['/keys'],
                label: 'Shortcuts',
                icon: 'KBD',
                category: 'General',
                description: 'Show keyboard shortcuts.',
                template: '/shortcuts',
            },
            {
                id: 'health',
                command: '/health',
                label: 'Health',
                icon: 'OK',
                category: 'System',
                description: 'Check API connection health.',
                template: '/health',
            },
            {
                id: 'save',
                command: '/save',
                label: 'Save',
                icon: 'SV',
                category: 'Session',
                description: 'Save the current conversation.',
                template: '/save ',
                arguments: 'optional name',
            },
            {
                id: 'load',
                command: '/load',
                label: 'Load',
                icon: 'LD',
                category: 'Session',
                description: 'Load a saved conversation.',
                template: '/load ',
                arguments: 'optional name',
            },
            {
                id: 'export',
                command: '/export',
                label: 'Export',
                icon: 'EX',
                category: 'Session',
                description: 'Export the transcript as Markdown, text, HTML, or JSON.',
                template: '/export md',
                arguments: 'md, txt, html, or json',
            },
            {
                id: 'copy',
                command: '/copy',
                label: 'Copy',
                icon: 'CP',
                category: 'General',
                description: 'Copy the last response to the clipboard.',
                template: '/copy',
            },
            {
                id: 'pet',
                command: '/pet',
                aliases: ['/spawn'],
                label: 'Pet',
                icon: 'PT',
                category: 'Voxel',
                description: 'Spawn or update the prompt companion.',
                template: '/pet ',
                requiresInput: true,
                arguments: 'prompt, random, ai, act, name, hide, or show',
            },
            {
                id: 'agent',
                command: '/agent',
                aliases: ['/voxel-agent'],
                label: 'Agent',
                icon: 'AG',
                category: 'Voxel',
                description: 'Generate an AI-backed voxel agent.',
                template: '/agent ',
                requiresInput: true,
                arguments: 'agent prompt',
            },
            {
                id: 'random-agent',
                command: '/random-agent',
                label: 'Random Agent',
                icon: 'AR',
                category: 'Voxel',
                description: 'Spawn a random 3D voxel character.',
                template: '/random-agent',
            },
            {
                id: 'creator',
                command: '/creator',
                aliases: ['/voxel-creator'],
                label: 'Creator',
                icon: 'CR',
                category: 'Voxel',
                description: 'Focus the voxel creator panel.',
                template: '/creator',
            },
            {
                id: 'buddy',
                command: '/agent-tools',
                aliases: ['/buddy', '/toolbelt'],
                label: 'Agent Tools',
                icon: 'AT',
                category: 'Agent',
                description: 'Open the agent companion panel and toolbelt.',
                template: '/agent-tools',
            },
        ];
    }

    getWorkflowLibrary() {
        return [
            {
                id: 'triage-failure',
                title: 'Triage A Failure',
                lane: 'Operate',
                description: 'Collect symptoms, recent changes, logs, and a tight next-action plan.',
                prompt: 'Triage this failure like an incident. Start by asking for missing evidence only if needed, then produce: symptoms, likely causes, evidence to gather, fastest safe fix, and verification steps.',
                tags: ['debug', 'incident', 'logs'],
            },
            {
                id: 'ship-change',
                title: 'Ship A Change',
                lane: 'Build',
                description: 'Turn a request into scoped implementation, checks, and handoff notes.',
                prompt: 'Help me ship this change end to end. Identify the smallest correct implementation plan, edit the relevant files, run focused checks, and summarize changed files plus any remaining risk.',
                tags: ['implement', 'verify', 'handoff'],
            },
            {
                id: 'remote-release',
                title: 'Remote Release Check',
                lane: 'Deploy',
                description: 'Stage a cautious remote deploy or production verification lane.',
                prompt: '/remote plan',
                tags: ['remote', 'k3s', 'deploy'],
            },
            {
                id: 'review-diff',
                title: 'Review Current Diff',
                lane: 'Review',
                description: 'Prioritize bugs, regressions, risks, and missing tests in the current worktree.',
                prompt: 'Review the current diff like a senior code reviewer. Lead with findings by severity, include file and line references, call out missing tests, and keep the summary secondary.',
                tags: ['review', 'risk', 'tests'],
            },
            {
                id: 'artifact-brief',
                title: 'Create Artifact Brief',
                lane: 'Artifacts',
                description: 'Convert a rough ask into a usable document, dashboard, or preview brief.',
                prompt: 'Create a compact artifact brief for this request. Include format, audience, purpose, required sections, data/assets needed, design constraints, acceptance checks, and the first implementation step.',
                tags: ['docs', 'dashboard', 'brief'],
            },
            {
                id: 'canvas-sync',
                title: 'Canvas Planning Hand-off',
                lane: 'Canvas',
                description: 'Prepare a structured prompt for the Canvas agent and editable object actions.',
                prompt: 'Prepare a Canvas agent hand-off. Summarize the goal, desired board objects, relationships, labels, frames, and the exact editable object actions the canvas should apply.',
                tags: ['canvas', 'diagram', 'planning'],
            },
        ];
    }

    findWorkflow(id = '') {
        const normalized = String(id || '').trim().toLowerCase();
        return this.getWorkflowLibrary().find((workflow) => workflow.id === normalized) || null;
    }

    useWorkflowButton(button = null) {
        const workflow = this.findWorkflow(button?.dataset?.workflowId || '');
        if (!workflow) {
            this.printWarning('Workflow was not found.');
            return;
        }

        this.setCommandInputValue(workflow.prompt);
        this.updateCommandAssist(this.getCommandEntry(workflow.prompt), { activated: true });
        this.printSystem(`Workflow staged: ${workflow.title}`);
    }

    renderWorkflowLauncher(query = '') {
        const normalizedQuery = String(query || '').trim().toLowerCase();
        const workflows = this.getWorkflowLibrary()
            .filter((workflow) => {
                if (!normalizedQuery) {
                    return true;
                }
                const haystack = [
                    workflow.title,
                    workflow.lane,
                    workflow.description,
                    workflow.prompt,
                    ...(workflow.tags || []),
                ].join(' ').toLowerCase();
                return haystack.includes(normalizedQuery);
            });

        const cards = workflows.map((workflow) => `
            <button
                type="button"
                class="cli-workflow-card"
                data-workflow-id="${this.escapeHtmlAttr(workflow.id)}"
                onclick="app.useWorkflowButton(this)"
                title="Stage ${this.escapeHtmlAttr(workflow.title)}"
            >
                <span class="cli-workflow-card__lane">${this.escapeHtml(workflow.lane)}</span>
                <strong>${this.escapeHtml(workflow.title)}</strong>
                <span>${this.escapeHtml(workflow.description)}</span>
                <small>${(workflow.tags || []).map((tag) => `#${this.escapeHtml(tag)}`).join(' ')}</small>
            </button>
        `).join('');

        return `
            <div class="cli-workflow-library">
                <div class="cli-workflow-library__intro">
                    <strong>Workflow Library</strong>
                    <span>Stage a reusable task prompt or command, then edit it before running.</span>
                </div>
                ${workflows.length > 0
                    ? `<div class="cli-workflow-grid">${cards}</div>`
                    : `<div class="cli-workflow-empty">No workflows matched "${this.escapeHtml(normalizedQuery)}". Try /workflows debug, deploy, review, canvas, or brief.</div>`}
            </div>
        `;
    }

    printWorkflows(args = []) {
        const query = args.join(' ').trim();
        const line = document.createElement('div');
        line.className = 'line line-output ai';
        const body = this.renderWorkflowLauncher(query);
        if (this.theme === 'voxel') {
            line.innerHTML = `
                <div class="voxel-response-head">
                    <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>Workflow Library</span>
                    <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                    <span class="voxel-response-meta">task starters</span>
                </div>
                <div class="voxel-response-body">${body}</div>
            `;
        } else {
            line.innerHTML = `
                <div class="cli-response-shell">
                    <div class="cli-response-head">
                        <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                        <span class="cli-response-title">Workflow Library</span>
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }
        this.terminalOutput.appendChild(line);
        this.finishAIContentLine(line);
        this.scrollToBottom();
    }

    getOperationalStatusData() {
        const transcriptCount = this.getTranscriptEntries?.().length || 0;
        const fileBytes = this.sessionFiles.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
        const uptimeMs = Math.max(0, Date.now() - (Number(this.sessionStartTime) || Date.now()));
        const uptimeMinutes = Math.floor(uptimeMs / 60000);
        const uptime = uptimeMinutes < 1
            ? '<1 min'
            : `${uptimeMinutes} min`;
        const ttsStatus = typeof this.getTtsStatus === 'function' ? this.getTtsStatus() : 'unavailable';

        return {
            transport: '/api/chat SSE',
            connection: this.statusText?.textContent || 'Unknown',
            session: api.sessionId || 'new',
            model: api.currentModel || 'auto',
            theme: this.getThemeLabel(this.theme),
            density: this.getDensityLabel(this.density),
            mode: this.isEnterpriseModeActive() ? 'Enterprise' : 'Custom',
            runtime: this.isProcessing ? 'busy' : 'ready',
            queue: this.commandQueue.length,
            files: this.sessionFiles.length,
            fileBytes,
            transcriptCount,
            history: this.history.length,
            uptime,
            exportFormats: 'md, txt, html, json',
            voice: ttsStatus,
        };
    }

    renderOperationalStatusCard() {
        const status = this.getOperationalStatusData();
        const healthLabel = status.connection.toLowerCase().includes('connected') ? 'online' : 'check';
        const queueLabel = status.queue > 0 ? `${status.queue} queued` : 'clear';
        const fileLabel = `${status.files} file${status.files === 1 ? '' : 's'}`;
        const bytesLabel = this.formatFileSize(status.fileBytes || 0);

        return `
            <div class="cli-status-card" aria-label="Operational status">
                <div class="cli-status-card__header">
                    <div>
                        <span class="cli-status-card__kicker">Runtime Status</span>
                        <strong>${this.escapeHtml(status.runtime === 'busy' ? 'Request in progress' : 'Ready for work')}</strong>
                    </div>
                    <span class="cli-status-card__badge ${this.escapeHtmlAttr(healthLabel)}">${this.escapeHtml(status.connection)}</span>
                </div>
                <div class="cli-status-card__grid">
                    <div><span>Session</span><strong>${this.escapeHtml(status.session)}</strong></div>
                    <div><span>Model</span><strong>${this.escapeHtml(status.model)}</strong></div>
                    <div><span>Theme</span><strong>${this.escapeHtml(status.theme)}</strong></div>
                    <div><span>Density</span><strong>${this.escapeHtml(status.density)}</strong></div>
                    <div><span>Mode</span><strong>${this.escapeHtml(status.mode)}</strong></div>
                    <div><span>Transport</span><strong>${this.escapeHtml(status.transport)}</strong></div>
                    <div><span>Transcript</span><strong>${this.escapeHtml(String(status.transcriptCount))} entries</strong></div>
                    <div><span>Files</span><strong>${this.escapeHtml(fileLabel)} - ${this.escapeHtml(bytesLabel)}</strong></div>
                    <div><span>Queue</span><strong>${this.escapeHtml(queueLabel)}</strong></div>
                    <div><span>Voice</span><strong>${this.escapeHtml(status.voice)}</strong></div>
                    <div><span>Input History</span><strong>${this.escapeHtml(String(status.history))} commands</strong></div>
                    <div><span>Open Time</span><strong>${this.escapeHtml(status.uptime)}</strong></div>
                    <div><span>Exports</span><strong>${this.escapeHtml(status.exportFormats)}</strong></div>
                    <div><span>Next</span><strong>/help - /workflows - /canvas</strong></div>
                </div>
                <div class="cli-status-card__actions">
                    <button type="button" onclick="app.useCommandSuggestion('/health', { submit: true })">Check health</button>
                    <button type="button" onclick="app.useCommandSuggestion('/sessions', { submit: true })">Sessions</button>
                    <button type="button" onclick="app.useCommandSuggestion('/files', { submit: true })">Files</button>
                    <button type="button" onclick="app.useCommandSuggestion('/export md', { submit: false })">Prep export</button>
                </div>
            </div>
        `;
    }

    printOperationalStatus() {
        const line = document.createElement('div');
        line.className = 'line line-output ai cli-status-card-line';
        const body = this.renderOperationalStatusCard();
        if (this.theme === 'voxel') {
            line.innerHTML = `
                <div class="voxel-response-head">
                    <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>Status</span>
                    <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                    <span class="voxel-response-meta">runtime</span>
                </div>
                <div class="voxel-response-body">${body}</div>
            `;
        } else {
            line.innerHTML = `
                <div class="cli-response-shell">
                    <div class="cli-response-head">
                        <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                        <span class="cli-response-title">Status</span>
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }
        this.terminalOutput.appendChild(line);
        this.finishAIContentLine(line);
        this.scrollToBottom();
    }

    buildSessionReadiness(status = this.getOperationalStatusData(), transcript = [], files = []) {
        const isConnected = String(status.connection || '').toLowerCase() === 'connected';
        const hasTranscript = transcript.length > 0;
        const hasAssistantOutput = transcript.some((entry) => entry.role === 'assistant');
        const hasFiles = files.length > 0;
        const isReady = String(status.runtime || '').toLowerCase() === 'ready';

        return [
            {
                label: 'Backend connection',
                state: isConnected ? 'ready' : 'attention',
                detail: isConnected ? 'Connected to the chat transport' : `Connection is ${status.connection || 'unknown'}`,
            },
            {
                label: 'Session context',
                state: hasTranscript ? 'ready' : 'missing',
                detail: hasTranscript ? `${transcript.length} transcript entries available` : 'Send or load a session before handoff',
            },
            {
                label: 'Assistant output',
                state: hasAssistantOutput ? 'ready' : 'missing',
                detail: hasAssistantOutput ? 'Latest response can be summarized' : 'No assistant response captured yet',
            },
            {
                label: 'Artifacts',
                state: hasFiles ? 'ready' : 'optional',
                detail: hasFiles ? `${files.length} generated file${files.length === 1 ? '' : 's'} attached` : 'No files attached to this session',
            },
            {
                label: 'Export path',
                state: hasTranscript ? 'ready' : 'attention',
                detail: hasTranscript ? 'Markdown, text, HTML, and JSON export are available' : 'Transcript export needs at least one entry',
            },
            {
                label: 'Runtime',
                state: isReady ? 'ready' : 'attention',
                detail: isReady ? 'No request is currently streaming' : 'A request is still in progress',
            },
        ];
    }

    buildSessionNextActions(status = this.getOperationalStatusData(), transcript = [], files = []) {
        const actions = [];
        const isConnected = String(status.connection || '').toLowerCase() === 'connected';
        const hasTranscript = transcript.length > 0;
        const hasAssistantOutput = transcript.some((entry) => entry.role === 'assistant');
        const hasFiles = files.length > 0;
        const isReady = String(status.runtime || '').toLowerCase() === 'ready';

        if (!isConnected) {
            actions.push({
                label: 'Check backend health',
                detail: 'Confirm the API and stream transport before continuing.',
                command: '/health',
                submit: true,
                priority: 'high',
            });
        }
        if (!hasTranscript) {
            actions.push({
                label: 'Start a session thread',
                detail: 'Send a first request or switch to a saved session.',
                command: '/sessions',
                submit: true,
                priority: 'high',
            });
        }
        if (hasTranscript && !hasAssistantOutput) {
            actions.push({
                label: 'Get an assistant response',
                detail: 'The brief needs at least one assistant pass to summarize.',
                command: '',
                submit: false,
                priority: 'high',
            });
        }
        if (hasAssistantOutput) {
            actions.push({
                label: 'Export the transcript',
                detail: 'Create a markdown handoff from the current session.',
                command: '/export md',
                submit: false,
                priority: 'medium',
            });
        }
        if (hasFiles) {
            actions.push({
                label: 'Review generated files',
                detail: `${files.length} artifact${files.length === 1 ? '' : 's'} are attached to this session.`,
                command: '/files',
                submit: true,
                priority: 'medium',
            });
        }
        if (!isReady) {
            actions.push({
                label: 'Wait for streaming to finish',
                detail: 'A request is still in progress; export after it settles.',
                command: '/status',
                submit: true,
                priority: 'medium',
            });
        }
        actions.push({
            label: 'Open workflow starters',
            detail: 'Stage a deploy, review, debug, canvas, or artifact workflow.',
            command: '/workflows',
            submit: true,
            priority: 'low',
        });
        actions.push({
            label: 'Refresh this brief',
            detail: 'Regenerate readiness and next actions after the next change.',
            command: '/brief',
            submit: true,
            priority: 'low',
        });

        return actions.slice(0, 6);
    }

    getSessionBriefData() {
        const transcript = this.getTranscriptEntries?.() || [];
        const userEntries = transcript.filter((entry) => entry.role === 'user');
        const assistantEntries = transcript.filter((entry) => entry.role === 'assistant');
        const lastUser = userEntries[userEntries.length - 1]?.text || '';
        const lastAssistant = assistantEntries[assistantEntries.length - 1]?.text || '';
        const status = this.getOperationalStatusData();
        const commandHints = [];
        if (this.sessionFiles.length > 0) {
            commandHints.push('/files');
        }
        if (transcript.length > 0) {
            commandHints.push('/export md');
        }
        commandHints.push('/workflows');

        return {
            createdAt: new Date().toISOString(),
            status,
            transcriptCount: transcript.length,
            lastUser,
            lastAssistant,
            files: this.sessionFiles.map((file) => ({
                id: file.id,
                filename: file.filename,
                type: file.type || 'file',
                size: file.size || 0,
            })),
            commands: Array.from(new Set(commandHints)),
            readiness: this.buildSessionReadiness(status, transcript, this.sessionFiles),
            nextActions: this.buildSessionNextActions(status, transcript, this.sessionFiles),
        };
    }

    buildSessionBriefText(data = this.getSessionBriefData()) {
        const lines = [
            'Lilly CLI Brief',
            `Created: ${data.createdAt}`,
            `Session: ${data.status.session}`,
            `Model: ${data.status.model}`,
            `Theme: ${data.status.theme}`,
            `Transcript entries: ${data.transcriptCount}`,
            `Files: ${data.files.length}`,
            '',
            'Latest user input:',
            data.lastUser ? data.lastUser.slice(0, 900) : 'None captured yet.',
            '',
            'Latest assistant output:',
            data.lastAssistant ? data.lastAssistant.slice(0, 1200) : 'None captured yet.',
            '',
            'Session files:',
            ...(data.files.length > 0
                ? data.files.map((file) => `- ${file.id}. ${file.filename} (${this.formatFileSize(file.size)}, ${file.type})`)
                : ['- None']),
            '',
            'Readiness:',
            ...(data.readiness || []).map((item) => `- [${item.state}] ${item.label}: ${item.detail}`),
            '',
            'Next actions:',
            ...(data.nextActions || []).map((item) => `- [${item.priority}] ${item.label}: ${item.detail}${item.command ? ` (${item.command})` : ''}`),
            '',
            'Suggested next commands:',
            ...data.commands.map((command) => `- ${command}`),
        ];
        return lines.join('\n');
    }

    renderSessionBriefCard(data = this.getSessionBriefData()) {
        const latestUser = data.lastUser
            ? data.lastUser.replace(/\s+/g, ' ').trim().slice(0, 180)
            : 'No user message captured yet.';
        const latestAssistant = data.lastAssistant
            ? data.lastAssistant.replace(/\s+/g, ' ').trim().slice(0, 220)
            : 'No assistant output captured yet.';
        const files = data.files.length > 0
            ? data.files.slice(0, 5).map((file) => `
                <li><strong>${this.escapeHtml(file.filename)}</strong><span>${this.escapeHtml(file.type)} - ${this.escapeHtml(this.formatFileSize(file.size))}</span></li>
            `).join('')
            : '<li><strong>No files yet</strong><span>Generated artifacts will appear here.</span></li>';
        const commands = data.commands.map((command) => `
            <button type="button" onclick="app.useCommandSuggestion('${this.escapeHtmlAttr(command)}', { submit: ${command === '/files'} })">${this.escapeHtml(command)}</button>
        `).join('');
        const readiness = (data.readiness || []).map((item) => `
            <div class="cli-brief-card__readiness-item ${this.escapeHtmlAttr(item.state)}">
                <strong>${this.escapeHtml(item.label)}</strong>
                <span>${this.escapeHtml(item.detail)}</span>
            </div>
        `).join('');
        const nextActions = (data.nextActions || []).map((item) => {
            const hasCommand = Boolean(item.command);
            const onclick = hasCommand
                ? ` onclick="app.useCommandSuggestion('${this.escapeHtmlAttr(item.command)}', { submit: ${item.submit ? 'true' : 'false'} })"`
                : '';
            return `
                <button type="button" class="cli-brief-card__next-action ${this.escapeHtmlAttr(item.priority)}"${onclick}${hasCommand ? '' : ' disabled'}>
                    <strong>${this.escapeHtml(item.label)}</strong>
                    <span>${this.escapeHtml(item.detail)}</span>
                </button>
            `;
        }).join('');

        return `
            <div class="cli-brief-card" aria-label="Session brief">
                <div class="cli-brief-card__header">
                    <div>
                        <span class="cli-status-card__kicker">Session Brief</span>
                        <strong>${this.escapeHtml(data.status.session === 'new' ? 'Local draft session' : data.status.session)}</strong>
                    </div>
                    <button type="button" onclick="app.copySessionBrief()">Copy brief</button>
                </div>
                <div class="cli-brief-card__grid">
                    <div><span>Runtime</span><strong>${this.escapeHtml(data.status.runtime)}</strong></div>
                    <div><span>Transcript</span><strong>${this.escapeHtml(String(data.transcriptCount))} entries</strong></div>
                    <div><span>Files</span><strong>${this.escapeHtml(String(data.files.length))}</strong></div>
                    <div><span>Exports</span><strong>${this.escapeHtml(data.status.exportFormats)}</strong></div>
                </div>
                <div class="cli-brief-card__section">
                    <span>Latest user input</span>
                    <p>${this.escapeHtml(latestUser)}</p>
                </div>
                <div class="cli-brief-card__section">
                    <span>Latest assistant output</span>
                    <p>${this.escapeHtml(latestAssistant)}</p>
                </div>
                <ul class="cli-brief-card__files">${files}</ul>
                <div class="cli-brief-card__readiness" aria-label="Session readiness checklist">${readiness}</div>
                <div class="cli-brief-card__next" aria-label="Suggested next actions">${nextActions}</div>
                <div class="cli-brief-card__actions">${commands}</div>
            </div>
        `;
    }

    renderSessionNextActionsCard(data = this.getSessionBriefData()) {
        const actions = (data.nextActions || []).map((item, index) => {
            const hasCommand = Boolean(item.command);
            const onclick = hasCommand
                ? ` onclick="app.useCommandSuggestion('${this.escapeHtmlAttr(item.command)}', { submit: ${item.submit ? 'true' : 'false'} })"`
                : '';
            return `
                <button type="button" class="cli-next-card__item ${this.escapeHtmlAttr(item.priority)}"${onclick}${hasCommand ? '' : ' disabled'}>
                    <span>${this.escapeHtml(String(index + 1).padStart(2, '0'))}</span>
                    <strong>${this.escapeHtml(item.label)}</strong>
                    <small>${this.escapeHtml(item.detail)}</small>
                </button>
            `;
        }).join('');

        return `
            <div class="cli-next-card" aria-label="Session next actions">
                <div class="cli-next-card__header">
                    <div>
                        <span class="cli-status-card__kicker">Next Actions</span>
                        <strong>${this.escapeHtml(data.status.runtime === 'busy' ? 'Finish active work first' : 'Ready to continue')}</strong>
                    </div>
                    <button type="button" onclick="app.useCommandSuggestion('/brief', { submit: true })">Open brief</button>
                </div>
                <div class="cli-next-card__list">${actions}</div>
            </div>
        `;
    }

    printSessionNextActions() {
        const data = this.getSessionBriefData();
        const line = document.createElement('div');
        line.className = 'line line-output ai cli-next-card-line';
        const body = this.renderSessionNextActionsCard(data);
        if (this.theme === 'voxel') {
            line.innerHTML = `
                <div class="voxel-response-head">
                    <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>Next Actions</span>
                    <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                    <span class="voxel-response-meta">plan</span>
                </div>
                <div class="voxel-response-body">${body}</div>
            `;
        } else {
            line.innerHTML = `
                <div class="cli-response-shell">
                    <div class="cli-response-head">
                        <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                        <span class="cli-response-title">Next Actions</span>
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }
        this.terminalOutput.appendChild(line);
        this.finishAIContentLine(line);
        this.scrollToBottom();
    }

    buildSessionAuditData() {
        const transcript = this.getTranscriptEntries?.() || [];
        const status = this.getOperationalStatusData();
        const events = [];

        events.push({
            type: 'runtime',
            label: 'Session opened',
            detail: `${status.session} - ${status.model} - ${status.theme}`,
            time: new Date(this.sessionStartTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            state: status.connection === 'Connected' ? 'ready' : 'attention',
        });

        transcript.slice(-8).forEach((entry, index) => {
            const role = entry.role === 'assistant' ? 'Assistant output' : (entry.role === 'user' ? 'User input' : entry.role);
            events.push({
                type: entry.role,
                label: role,
                detail: entry.text.replace(/\s+/g, ' ').trim().slice(0, 180),
                time: `T-${String(transcript.length - index).padStart(2, '0')}`,
                state: entry.role === 'error' ? 'error' : 'ready',
            });
        });

        this.sessionFiles.slice(-5).forEach((file) => {
            events.push({
                type: 'file',
                label: `File #${file.id}`,
                detail: `${file.filename} - ${this.formatFileSize(file.size || 0)}`,
                time: file.createdAt ? new Date(file.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'file',
                state: 'ready',
            });
        });

        this.commandHistory.slice(-5).forEach((command) => {
            events.push({
                type: 'command',
                label: 'Command history',
                detail: String(command || '').slice(0, 180),
                time: 'cmd',
                state: 'muted',
            });
        });

        return {
            createdAt: new Date().toISOString(),
            status,
            transcriptCount: transcript.length,
            fileCount: this.sessionFiles.length,
            commandCount: this.commandHistory.length,
            events: events.slice(-18).reverse(),
        };
    }

    buildSessionAuditText(data = this.buildSessionAuditData()) {
        return [
            'Lilly CLI Audit Trail',
            `Created: ${data.createdAt}`,
            `Session: ${data.status.session}`,
            `Runtime: ${data.status.runtime}`,
            `Connection: ${data.status.connection}`,
            `Messages: ${data.transcriptCount}`,
            `Files: ${data.fileCount}`,
            `Commands: ${data.commandCount}`,
            '',
            'Events:',
            ...(data.events.length > 0
                ? data.events.map((event) => `- [${event.state}] ${event.time} ${event.label}: ${event.detail}`)
                : ['- No events captured yet.']),
        ].join('\n');
    }

    renderSessionAuditCard(data = this.buildSessionAuditData()) {
        const events = data.events.length > 0
            ? data.events.map((event) => `
                <div class="cli-audit-card__event ${this.escapeHtmlAttr(event.state)}">
                    <span>${this.escapeHtml(event.time)}</span>
                    <strong>${this.escapeHtml(event.label)}</strong>
                    <small>${this.escapeHtml(event.detail)}</small>
                </div>
            `).join('')
            : '<div class="cli-audit-card__empty">No events captured yet.</div>';

        return `
            <div class="cli-audit-card" aria-label="Session audit trail">
                <div class="cli-audit-card__header">
                    <div>
                        <span class="cli-status-card__kicker">Audit Trail</span>
                        <strong>${this.escapeHtml(data.events.length > 0 ? `${data.events.length} recent events` : 'No events yet')}</strong>
                    </div>
                    <button type="button" onclick="app.copySessionAudit()">Copy audit</button>
                </div>
                <div class="cli-audit-card__metrics">
                    <div><span>Messages</span><strong>${this.escapeHtml(String(data.transcriptCount))}</strong></div>
                    <div><span>Files</span><strong>${this.escapeHtml(String(data.fileCount))}</strong></div>
                    <div><span>Commands</span><strong>${this.escapeHtml(String(data.commandCount))}</strong></div>
                    <div><span>Runtime</span><strong>${this.escapeHtml(data.status.runtime)}</strong></div>
                </div>
                <div class="cli-audit-card__timeline">${events}</div>
            </div>
        `;
    }

    printSessionAudit() {
        const data = this.buildSessionAuditData();
        this.lastSessionAuditText = this.buildSessionAuditText(data);
        const line = document.createElement('div');
        line.className = 'line line-output ai cli-audit-card-line';
        const body = this.renderSessionAuditCard(data);
        if (this.theme === 'voxel') {
            line.innerHTML = `
                <div class="voxel-response-head">
                    <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>Audit Trail</span>
                    <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                    <span class="voxel-response-meta">activity</span>
                </div>
                <div class="voxel-response-body">${body}</div>
            `;
        } else {
            line.innerHTML = `
                <div class="cli-response-shell">
                    <div class="cli-response-head">
                        <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                        <span class="cli-response-title">Audit Trail</span>
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }
        this.terminalOutput.appendChild(line);
        this.finishAIContentLine(line);
        this.scrollToBottom();
    }

    getSearchSnippet(text = '', query = '', maxLength = 180) {
        const normalizedText = String(text || '').replace(/\s+/g, ' ').trim();
        const normalizedQuery = String(query || '').trim().toLowerCase();
        if (!normalizedText) {
            return '';
        }
        const index = normalizedQuery ? normalizedText.toLowerCase().indexOf(normalizedQuery) : -1;
        if (index < 0) {
            return normalizedText.slice(0, maxLength);
        }
        const start = Math.max(0, index - Math.floor(maxLength / 3));
        const end = Math.min(normalizedText.length, start + maxLength);
        return `${start > 0 ? '...' : ''}${normalizedText.slice(start, end)}${end < normalizedText.length ? '...' : ''}`;
    }

    buildLocalSearchResults(query = '') {
        const normalizedQuery = String(query || '').trim().toLowerCase();
        const transcript = this.getTranscriptEntries?.() || [];
        const results = [];

        if (!normalizedQuery) {
            return {
                query: '',
                transcriptCount: 0,
                fileCount: 0,
                results,
            };
        }

        transcript.forEach((entry, index) => {
            const text = String(entry.text || '');
            if (!text.toLowerCase().includes(normalizedQuery)) {
                return;
            }
            results.push({
                source: 'Transcript',
                label: `${entry.role || 'entry'} #${index + 1}`,
                detail: this.getSearchSnippet(text, normalizedQuery),
                target: 'transcript',
                targetIndex: index,
                command: '/export md',
                submit: false,
            });
        });

        this.sessionFiles.forEach((file) => {
            const fileText = [
                file.filename,
                file.type,
                file.mimeType,
                file.content,
                file.downloadUrl,
                file.previewUrl,
            ].map((value) => String(value || '')).join(' ');
            if (!fileText.toLowerCase().includes(normalizedQuery)) {
                return;
            }
            results.push({
                source: 'File',
                label: `${file.filename || `File #${file.id}`} (${this.formatFileSize(file.size || 0)})`,
                detail: this.getSearchSnippet(fileText, normalizedQuery),
                target: 'file',
                targetIndex: file.id,
                command: '/files',
                submit: true,
            });
        });

        return {
            query: String(query || '').trim(),
            transcriptCount: results.filter((item) => item.source === 'Transcript').length,
            fileCount: results.filter((item) => item.source === 'File').length,
            results: results.slice(0, 20),
        };
    }

    renderFindResultsCard(data = this.buildLocalSearchResults()) {
        const resultItems = data.results.length > 0
            ? data.results.map((item) => `
                <div class="cli-find-card__item">
                    <span>${this.escapeHtml(item.source)}</span>
                    <strong>${this.escapeHtml(item.label)}</strong>
                    <small>${this.escapeHtml(item.detail)}</small>
                    <div class="cli-find-card__actions">
                        <button type="button" onclick="app.jumpToFindResult('${this.escapeHtmlAttr(item.target)}', '${this.escapeHtmlAttr(String(item.targetIndex))}')">Jump</button>
                        <button type="button" onclick="app.useCommandSuggestion('${this.escapeHtmlAttr(item.command)}', { submit: ${item.submit ? 'true' : 'false'} })">${this.escapeHtml(item.command)}</button>
                    </div>
                </div>
            `).join('')
            : `<div class="cli-find-card__empty">No local matches for "${this.escapeHtml(data.query)}". Try a shorter term or search after the next response lands.</div>`;

        return `
            <div class="cli-find-card" aria-label="Local search results">
                <div class="cli-find-card__header">
                    <div>
                        <span class="cli-status-card__kicker">Local Find</span>
                        <strong>${this.escapeHtml(data.query || 'No query')}</strong>
                    </div>
                    <button type="button" onclick="app.useCommandSuggestion('/find ', { submit: false })">New search</button>
                </div>
                <div class="cli-find-card__metrics">
                    <div><span>Results</span><strong>${this.escapeHtml(String(data.results.length))}</strong></div>
                    <div><span>Transcript</span><strong>${this.escapeHtml(String(data.transcriptCount))}</strong></div>
                    <div><span>Files</span><strong>${this.escapeHtml(String(data.fileCount))}</strong></div>
                </div>
                <div class="cli-find-card__list">${resultItems}</div>
            </div>
        `;
    }

    printFindResults(query = '') {
        const normalizedQuery = String(query || '').trim();
        if (!normalizedQuery) {
            this.printWarning('Usage: /find <query> or /search <query>');
            return;
        }

        const data = this.buildLocalSearchResults(normalizedQuery);
        const line = document.createElement('div');
        line.className = 'line line-output ai cli-find-card-line';
        const body = this.renderFindResultsCard(data);
        if (this.theme === 'voxel') {
            line.innerHTML = `
                <div class="voxel-response-head">
                    <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>Find</span>
                    <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                    <span class="voxel-response-meta">local search</span>
                </div>
                <div class="voxel-response-body">${body}</div>
            `;
        } else {
            line.innerHTML = `
                <div class="cli-response-shell">
                    <div class="cli-response-head">
                        <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                        <span class="cli-response-title">Find</span>
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }
        this.terminalOutput.appendChild(line);
        this.finishAIContentLine(line);
        this.scrollToBottom();
    }

    jumpToFindResult(target = '', targetIndex = '') {
        const normalizedTarget = String(target || '').toLowerCase();
        if (normalizedTarget === 'file') {
            const fileId = Number.parseInt(targetIndex, 10);
            const file = this.sessionFiles.find((entry) => entry.id === fileId);
            if (file) {
                this.printSystem(`Focused file #${file.id}: ${file.filename}`);
                this.openFileManager();
            } else {
                this.printWarning(`File #${targetIndex} is no longer available in this session.`);
            }
            return;
        }

        const index = Number.parseInt(targetIndex, 10);
        const nodes = Array.from(this.terminalOutput?.children || []);
        const transcriptNodes = nodes.filter((node) => {
            const text = String(node.innerText || node.textContent || '').trim();
            if (!text) {
                return false;
            }
            return node.classList?.contains('line-input')
                || node.classList?.contains('ai')
                || node.classList?.contains('error')
                || node.classList?.contains('success')
                || node.classList?.contains('system');
        });
        const node = transcriptNodes[index];
        if (!node) {
            this.printWarning('That search result is no longer visible in the transcript.');
            return;
        }

        node.classList.remove('cli-find-target-highlight');
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        window.requestAnimationFrame(() => {
            node.classList.add('cli-find-target-highlight');
            window.setTimeout(() => node.classList.remove('cli-find-target-highlight'), 2400);
        });
    }

    getDefaultPinnedCommands() {
        return ['/status', '/brief', '/find ', '/workflows', '/canvas document ', '/export md'];
    }

    normalizePinnedCommand(command = '') {
        return String(command || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    }

    loadPinnedCommands() {
        try {
            const saved = JSON.parse(localStorage.getItem(WEB_CLI_PINNED_COMMANDS_KEY) || 'null');
            if (Array.isArray(saved)) {
                const normalized = saved
                    .map((command) => this.normalizePinnedCommand(command))
                    .filter(Boolean);
                if (normalized.length > 0) {
                    return Array.from(new Set(normalized)).slice(0, 12);
                }
            }
        } catch (_error) {}
        return this.getDefaultPinnedCommands();
    }

    savePinnedCommands() {
        try {
            localStorage.setItem(WEB_CLI_PINNED_COMMANDS_KEY, JSON.stringify(this.pinnedCommands.slice(0, 12)));
        } catch (error) {
            console.warn('[WebCLI] Failed to save pinned commands:', error);
        }
    }

    getRecentCommandLaunchers(limit = 6) {
        const seen = new Set();
        return [...this.history]
            .reverse()
            .map((command) => this.normalizePinnedCommand(command))
            .filter((command) => {
                if (!command || seen.has(command)) {
                    return false;
                }
                seen.add(command);
                return true;
            })
            .slice(0, limit);
    }

    getPinnedCommandMeta(command = '') {
        const entry = this.getCommandEntry(command);
        const isExactRunnable = Boolean(entry && command.trim().toLowerCase() === String(entry.command || '').toLowerCase() && !entry.requiresInput);
        return {
            entry,
            label: entry?.label || (command.startsWith('/') ? command.split(/\s+/)[0] : 'Prompt'),
            detail: entry?.description || (command.startsWith('/') ? 'Custom CLI command' : 'Plain-language prompt starter'),
            isExactRunnable,
        };
    }

    pinCommand(command = '') {
        const normalized = this.normalizePinnedCommand(command);
        if (!normalized) {
            this.printWarning('Usage: /pin <command or prompt starter>');
            return;
        }
        this.pinnedCommands = [
            normalized,
            ...this.pinnedCommands.filter((item) => item.toLowerCase() !== normalized.toLowerCase()),
        ].slice(0, 12);
        this.savePinnedCommands();
        this.printSystem(`Pinned: ${normalized}`);
        this.printCommandPinboard();
    }

    unpinCommand(commandOrIndex = '') {
        const normalized = this.normalizePinnedCommand(commandOrIndex);
        if (!normalized) {
            this.printWarning('Usage: /unpin <number or command text>');
            return;
        }

        const numericIndex = Number.parseInt(normalized, 10);
        let removed = '';
        if (Number.isFinite(numericIndex) && String(numericIndex) === normalized && numericIndex >= 1) {
            removed = this.pinnedCommands[numericIndex - 1] || '';
            this.pinnedCommands = this.pinnedCommands.filter((_, index) => index !== numericIndex - 1);
        } else {
            const lowered = normalized.toLowerCase();
            removed = this.pinnedCommands.find((item) => item.toLowerCase() === lowered) || '';
            this.pinnedCommands = this.pinnedCommands.filter((item) => item.toLowerCase() !== lowered);
        }

        if (!removed) {
            this.printWarning(`Pinned command not found: ${normalized}`);
            return;
        }

        this.savePinnedCommands();
        this.printSystem(`Unpinned: ${removed}`);
        this.printCommandPinboard();
    }

    usePinnedCommand(index = 0, options = {}) {
        const command = this.pinnedCommands[Number(index)] || '';
        if (!command) {
            this.printWarning('Pinned command is no longer available.');
            return;
        }
        this.useCommandSuggestion(command, options);
    }

    useRecentCommand(index = 0, options = {}) {
        const command = this.getRecentCommandLaunchers()[Number(index)] || '';
        if (!command) {
            this.printWarning('Recent command is no longer available.');
            return;
        }
        this.useCommandSuggestion(command, options);
    }

    renderCommandPinboard() {
        const pins = this.pinnedCommands.length > 0
            ? this.pinnedCommands.map((command, index) => {
                const meta = this.getPinnedCommandMeta(command);
                return `
                    <div class="cli-pinboard-card__item">
                        <span>${this.escapeHtml(String(index + 1).padStart(2, '0'))}</span>
                        <div>
                            <strong>${this.escapeHtml(meta.label)}</strong>
                            <code>${this.escapeHtml(command)}</code>
                            <small>${this.escapeHtml(meta.detail)}</small>
                        </div>
                        <div class="cli-pinboard-card__actions">
                            <button type="button" onclick="app.usePinnedCommand(${index}, { submit: false })">Stage</button>
                            <button type="button" onclick="app.usePinnedCommand(${index}, { submit: ${meta.isExactRunnable ? 'true' : 'false'} })">Run</button>
                            <button type="button" onclick="app.unpinCommand('${index + 1}')">Remove</button>
                        </div>
                    </div>
                `;
            }).join('')
            : '<div class="cli-pinboard-card__empty">No pinned commands. Use /pin /status or /pin your prompt starter.</div>';

        const recentCommands = this.getRecentCommandLaunchers();
        const recents = recentCommands.length > 0
            ? recentCommands.map((command, index) => {
                const meta = this.getPinnedCommandMeta(command);
                return `
                    <button type="button" class="cli-pinboard-card__recent" onclick="app.useRecentCommand(${index}, { submit: false })">
                        <strong>${this.escapeHtml(meta.label)}</strong>
                        <span>${this.escapeHtml(command)}</span>
                    </button>
                `;
            }).join('')
            : '<div class="cli-pinboard-card__empty">Recent commands will appear after you run work in this browser.</div>';

        return `
            <div class="cli-pinboard-card" aria-label="Command pinboard">
                <div class="cli-pinboard-card__header">
                    <div>
                        <span class="cli-status-card__kicker">Command Pinboard</span>
                        <strong>${this.escapeHtml(String(this.pinnedCommands.length))} pinned launchers</strong>
                    </div>
                    <button type="button" onclick="app.useCommandSuggestion('/pin ', { submit: false })">Add pin</button>
                </div>
                <div class="cli-pinboard-card__list">${pins}</div>
                <div class="cli-pinboard-card__recent-grid">${recents}</div>
                <div class="cli-pinboard-card__footer">Use <code>/pin &lt;command&gt;</code> to add and <code>/unpin &lt;number&gt;</code> to remove.</div>
            </div>
        `;
    }

    printCommandPinboard() {
        const line = document.createElement('div');
        line.className = 'line line-output ai cli-pinboard-card-line';
        const body = this.renderCommandPinboard();
        if (this.theme === 'voxel') {
            line.innerHTML = `
                <div class="voxel-response-head">
                    <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>Pinboard</span>
                    <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                    <span class="voxel-response-meta">launchers</span>
                </div>
                <div class="voxel-response-body">${body}</div>
            `;
        } else {
            line.innerHTML = `
                <div class="cli-response-shell">
                    <div class="cli-response-head">
                        <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                        <span class="cli-response-title">Pinboard</span>
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }
        this.terminalOutput.appendChild(line);
        this.finishAIContentLine(line);
        this.scrollToBottom();
    }

    printSessionBrief() {
        const data = this.getSessionBriefData();
        this.lastSessionBriefText = this.buildSessionBriefText(data);
        const line = document.createElement('div');
        line.className = 'line line-output ai cli-brief-card-line';
        const body = this.renderSessionBriefCard(data);
        if (this.theme === 'voxel') {
            line.innerHTML = `
                <div class="voxel-response-head">
                    <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>Brief</span>
                    <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                    <span class="voxel-response-meta">handoff</span>
                </div>
                <div class="voxel-response-body">${body}</div>
            `;
        } else {
            line.innerHTML = `
                <div class="cli-response-shell">
                    <div class="cli-response-head">
                        <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                        <span class="cli-response-title">Brief</span>
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }
        this.terminalOutput.appendChild(line);
        this.finishAIContentLine(line);
        this.scrollToBottom();
    }

    async writeClipboardText(text) {
        const value = String(text == null ? '' : text);
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(value);
                return;
            } catch (_error) {
                // Clipboard access can be denied even when the API is present.
            }
        }

        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-1000px';
        textarea.style.left = '-1000px';
        document.body.appendChild(textarea);
        textarea.select();

        try {
            if (!document.execCommand || !document.execCommand('copy')) {
                throw new Error('Copy command unavailable');
            }
        } finally {
            textarea.remove();
        }
    }

    async copySessionBrief() {
        const text = this.lastSessionBriefText || this.buildSessionBriefText();
        try {
            await this.writeClipboardText(text);
            this.printSystem('Session brief copied to clipboard');
        } catch (_error) {
            this.printWarning('Clipboard unavailable. Use /export md for a saved transcript.');
        }
    }

    async copySessionAudit() {
        const text = this.lastSessionAuditText || this.buildSessionAuditText();
        try {
            await this.writeClipboardText(text);
            this.printSystem('Session audit trail copied to clipboard');
        } catch (_error) {
            this.printWarning('Clipboard unavailable. Use /export md for a saved transcript.');
        }
    }

    buildSessionPacketText() {
        const briefData = this.getSessionBriefData();
        const auditData = this.buildSessionAuditData();
        const status = this.getOperationalStatusData();
        const pins = (this.pinnedCommands || []).slice(0, 8);
        const recents = this.getRecentCommandLaunchers(8);
        return [
            'Lilly CLI Continuation Packet',
            `Created: ${new Date().toISOString()}`,
            `Session: ${status.session}`,
            `Model: ${status.model}`,
            `Runtime: ${status.runtime}`,
            `Connection: ${status.connection}`,
            `Transcript entries: ${briefData.transcriptCount}`,
            `Files: ${briefData.files.length}`,
            '',
            'Pinned commands:',
            ...(pins.length > 0 ? pins.map((command, index) => `${index + 1}. ${command}`) : ['- None']),
            '',
            'Recent commands:',
            ...(recents.length > 0 ? recents.map((command, index) => `${index + 1}. ${command}`) : ['- None']),
            '',
            '--- Session Brief ---',
            this.buildSessionBriefText(briefData),
            '',
            '--- Audit Trail ---',
            this.buildSessionAuditText(auditData),
        ].join('\n');
    }

    renderSessionPacketCard() {
        const data = this.getSessionBriefData();
        const audit = this.buildSessionAuditData();
        const readinessIssues = (data.readiness || []).filter((item) => item.state !== 'ready').length;
        const pins = (this.pinnedCommands || []).slice(0, 4);
        const recents = this.getRecentCommandLaunchers(4);
        const pinRows = pins.length > 0
            ? pins.map((command) => `<span>${this.escapeHtml(command)}</span>`).join('')
            : '<span>No pinned commands yet</span>';
        const recentRows = recents.length > 0
            ? recents.map((command) => `<span>${this.escapeHtml(command)}</span>`).join('')
            : '<span>No recent commands yet</span>';

        return `
            <div class="cli-packet-card" aria-label="Continuation packet">
                <div class="cli-packet-card__header">
                    <div>
                        <span class="cli-status-card__kicker">Continuation Packet</span>
                        <strong>${this.escapeHtml(data.status.session === 'new' ? 'Local draft session' : data.status.session)}</strong>
                    </div>
                    <div class="cli-packet-card__actions">
                        <button type="button" onclick="app.copySessionPacket()">Copy packet</button>
                        <button type="button" onclick="app.downloadSessionPacket()">Download md</button>
                    </div>
                </div>
                <div class="cli-packet-card__metrics">
                    <div><span>Runtime</span><strong>${this.escapeHtml(data.status.runtime)}</strong></div>
                    <div><span>Transcript</span><strong>${this.escapeHtml(String(data.transcriptCount))}</strong></div>
                    <div><span>Files</span><strong>${this.escapeHtml(String(data.files.length))}</strong></div>
                    <div><span>Open Issues</span><strong>${this.escapeHtml(String(readinessIssues))}</strong></div>
                    <div><span>Audit Events</span><strong>${this.escapeHtml(String(audit.events.length))}</strong></div>
                    <div><span>Pins</span><strong>${this.escapeHtml(String(this.pinnedCommands?.length || 0))}</strong></div>
                </div>
                <div class="cli-packet-card__section">
                    <strong>Latest user</strong>
                    <p>${this.escapeHtml((data.lastUser || 'None captured yet.').replace(/\s+/g, ' ').slice(0, 220))}</p>
                </div>
                <div class="cli-packet-card__lists">
                    <div><strong>Pinned launchers</strong>${pinRows}</div>
                    <div><strong>Recent commands</strong>${recentRows}</div>
                </div>
            </div>
        `;
    }

    printSessionPacket() {
        this.lastSessionPacketText = this.buildSessionPacketText();
        const line = document.createElement('div');
        line.className = 'line line-output ai cli-packet-card-line';
        const body = this.renderSessionPacketCard();
        if (this.theme === 'voxel') {
            line.innerHTML = `
                <div class="voxel-response-head">
                    <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>Packet</span>
                    <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                    <span class="voxel-response-meta">handoff</span>
                </div>
                <div class="voxel-response-body">${body}</div>
            `;
        } else {
            line.innerHTML = `
                <div class="cli-response-shell">
                    <div class="cli-response-head">
                        <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                        <span class="cli-response-title">Continuation Packet</span>
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }
        this.terminalOutput.appendChild(line);
        this.finishAIContentLine(line);
        this.scrollToBottom();
    }

    async copySessionPacket() {
        const text = this.lastSessionPacketText || this.buildSessionPacketText();
        try {
            await this.writeClipboardText(text);
            this.printSystem('Continuation packet copied to clipboard');
        } catch (_error) {
            this.printWarning('Clipboard unavailable. Use Download md instead.');
        }
    }

    downloadSessionPacket() {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.downloadFile(this.lastSessionPacketText || this.buildSessionPacketText(), `lilly-cli-packet-${stamp}.md`, 'text/markdown');
        this.printSystem('Continuation packet downloaded as Markdown');
    }

    classifyRegisterLine(text = '') {
        const normalized = String(text || '').trim();
        const lower = normalized.toLowerCase();
        if (!normalized || normalized.length < 8) {
            return null;
        }
        if (/\b(decision|decided|approved|chosen|choose|selected|agreed)\b/.test(lower)) {
            return 'decision';
        }
        if (/\b(risk|blocked|blocker|concern|issue|problem|failure|regression|missing|unsafe)\b/.test(lower)) {
            return 'risk';
        }
        if (/\b(next|todo|action|follow up|follow-up|verify|ship|fix|run|check|need to|should)\b/.test(lower)) {
            return 'action';
        }
        return null;
    }

    buildSessionRegisterData() {
        const transcript = this.getTranscriptEntries?.() || [];
        const buckets = { decision: [], risk: [], action: [] };
        const seen = new Set();
        transcript.forEach((entry, entryIndex) => {
            const lines = String(entry.text || '')
                .split(/\n|(?<=[.!?])\s+(?=[A-Z0-9/-])/)
                .map((line) => line.replace(/^[-*•\d.)\s]+/, '').replace(/\s+/g, ' ').trim())
                .filter(Boolean);
            lines.forEach((line) => {
                const type = this.classifyRegisterLine(line);
                if (!type) {
                    return;
                }
                const key = `${type}:${line.toLowerCase()}`;
                if (seen.has(key)) {
                    return;
                }
                seen.add(key);
                buckets[type].push({
                    type,
                    text: line.slice(0, 220),
                    source: `${entry.role || 'entry'} #${entryIndex + 1}`,
                });
            });
        });

        return {
            createdAt: new Date().toISOString(),
            transcriptCount: transcript.length,
            decisions: buckets.decision.slice(0, 10),
            risks: buckets.risk.slice(0, 10),
            actions: buckets.action.slice(0, 10),
        };
    }

    buildSessionRegisterText(data = this.buildSessionRegisterData()) {
        const formatItems = (items) => items.length > 0
            ? items.map((item, index) => `${index + 1}. ${item.text} (${item.source})`)
            : ['- None detected locally.'];
        return [
            'Lilly CLI Decision Register',
            `Created: ${data.createdAt}`,
            `Transcript entries: ${data.transcriptCount}`,
            '',
            'Decisions:',
            ...formatItems(data.decisions),
            '',
            'Risks:',
            ...formatItems(data.risks),
            '',
            'Actions:',
            ...formatItems(data.actions),
        ].join('\n');
    }

    renderSessionRegisterCard(data = this.buildSessionRegisterData()) {
        const renderBucket = (title, items, className) => {
            const rows = items.length > 0
                ? items.slice(0, 5).map((item) => `
                    <div class="cli-register-card__item ${this.escapeHtmlAttr(className)}">
                        <strong>${this.escapeHtml(item.source)}</strong>
                        <span>${this.escapeHtml(item.text)}</span>
                    </div>
                `).join('')
                : '<div class="cli-register-card__empty">None detected locally.</div>';
            return `<section><h4>${this.escapeHtml(title)}</h4>${rows}</section>`;
        };

        return `
            <div class="cli-register-card" aria-label="Decision register">
                <div class="cli-register-card__header">
                    <div>
                        <span class="cli-status-card__kicker">Decision Register</span>
                        <strong>${this.escapeHtml(String(data.decisions.length + data.risks.length + data.actions.length))} captured signals</strong>
                    </div>
                    <button type="button" onclick="app.copySessionRegister()">Copy register</button>
                </div>
                <div class="cli-register-card__metrics">
                    <div><span>Decisions</span><strong>${this.escapeHtml(String(data.decisions.length))}</strong></div>
                    <div><span>Risks</span><strong>${this.escapeHtml(String(data.risks.length))}</strong></div>
                    <div><span>Actions</span><strong>${this.escapeHtml(String(data.actions.length))}</strong></div>
                </div>
                <div class="cli-register-card__columns">
                    ${renderBucket('Decisions', data.decisions, 'decision')}
                    ${renderBucket('Risks', data.risks, 'risk')}
                    ${renderBucket('Actions', data.actions, 'action')}
                </div>
            </div>
        `;
    }

    printSessionRegister() {
        const data = this.buildSessionRegisterData();
        this.lastSessionRegisterText = this.buildSessionRegisterText(data);
        const line = document.createElement('div');
        line.className = 'line line-output ai cli-register-card-line';
        const body = this.renderSessionRegisterCard(data);
        if (this.theme === 'voxel') {
            line.innerHTML = `
                <div class="voxel-response-head">
                    <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>Register</span>
                    <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                    <span class="voxel-response-meta">decisions</span>
                </div>
                <div class="voxel-response-body">${body}</div>
            `;
        } else {
            line.innerHTML = `
                <div class="cli-response-shell">
                    <div class="cli-response-head">
                        <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                        <span class="cli-response-title">Decision Register</span>
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }
        this.terminalOutput.appendChild(line);
        this.finishAIContentLine(line);
        this.scrollToBottom();
    }

    async copySessionRegister() {
        const text = this.lastSessionRegisterText || this.buildSessionRegisterText();
        try {
            await this.writeClipboardText(text);
            this.printSystem('Decision register copied to clipboard');
        } catch (_error) {
            this.printWarning('Clipboard unavailable. Use /packet for a broader saved handoff.');
        }
    }

    buildSessionGateData() {
        const brief = this.getSessionBriefData();
        const register = this.buildSessionRegisterData();
        const status = this.getOperationalStatusData();
        const gates = [
            {
                label: 'Backend connection',
                state: String(status.connection || '').toLowerCase() === 'connected' ? 'pass' : 'warn',
                detail: status.connection || 'unknown',
            },
            {
                label: 'Transcript context',
                state: brief.transcriptCount > 0 ? 'pass' : 'fail',
                detail: brief.transcriptCount > 0 ? `${brief.transcriptCount} transcript entries` : 'No transcript captured',
            },
            {
                label: 'Assistant response',
                state: brief.lastAssistant ? 'pass' : 'fail',
                detail: brief.lastAssistant ? 'Latest assistant output available' : 'No assistant output yet',
            },
            {
                label: 'Runtime idle',
                state: status.runtime === 'ready' ? 'pass' : 'warn',
                detail: status.runtime === 'ready' ? 'No active stream' : 'Request still running',
            },
            {
                label: 'Decision trace',
                state: register.decisions.length > 0 ? 'pass' : 'warn',
                detail: register.decisions.length > 0 ? `${register.decisions.length} decisions detected` : 'No decision language detected',
            },
            {
                label: 'Risk visibility',
                state: register.risks.length > 0 ? 'warn' : 'pass',
                detail: register.risks.length > 0 ? `${register.risks.length} risks detected` : 'No explicit risks detected',
            },
            {
                label: 'Action path',
                state: register.actions.length > 0 || (brief.nextActions || []).length > 0 ? 'pass' : 'warn',
                detail: register.actions.length > 0 ? `${register.actions.length} local actions detected` : `${(brief.nextActions || []).length} suggested actions`,
            },
            {
                label: 'Handoff packet',
                state: brief.transcriptCount > 0 ? 'pass' : 'warn',
                detail: brief.transcriptCount > 0 ? '/packet can export continuation context' : 'Start a session before exporting packet',
            },
        ];
        const counts = gates.reduce((acc, gate) => {
            acc[gate.state] = (acc[gate.state] || 0) + 1;
            return acc;
        }, { pass: 0, warn: 0, fail: 0 });
        return {
            createdAt: new Date().toISOString(),
            status,
            gates,
            counts,
        };
    }

    buildSessionGateText(data = this.buildSessionGateData()) {
        return [
            'Lilly CLI Quality Gates',
            `Created: ${data.createdAt}`,
            `Pass: ${data.counts.pass || 0}`,
            `Warn: ${data.counts.warn || 0}`,
            `Fail: ${data.counts.fail || 0}`,
            '',
            ...data.gates.map((gate) => `- [${gate.state}] ${gate.label}: ${gate.detail}`),
        ].join('\n');
    }

    renderSessionGateCard(data = this.buildSessionGateData()) {
        const gateRows = data.gates.map((gate) => `
            <div class="cli-gates-card__item ${this.escapeHtmlAttr(gate.state)}">
                <strong>${this.escapeHtml(gate.label)}</strong>
                <span>${this.escapeHtml(gate.detail)}</span>
            </div>
        `).join('');
        const verdict = (data.counts.fail || 0) > 0
            ? 'Needs attention'
            : ((data.counts.warn || 0) > 0 ? 'Ready with warnings' : 'Ready');

        return `
            <div class="cli-gates-card" aria-label="Quality gates">
                <div class="cli-gates-card__header">
                    <div>
                        <span class="cli-status-card__kicker">Quality Gates</span>
                        <strong>${this.escapeHtml(verdict)}</strong>
                    </div>
                    <button type="button" onclick="app.copySessionGates()">Copy gates</button>
                </div>
                <div class="cli-gates-card__metrics">
                    <div><span>Pass</span><strong>${this.escapeHtml(String(data.counts.pass || 0))}</strong></div>
                    <div><span>Warn</span><strong>${this.escapeHtml(String(data.counts.warn || 0))}</strong></div>
                    <div><span>Fail</span><strong>${this.escapeHtml(String(data.counts.fail || 0))}</strong></div>
                </div>
                <div class="cli-gates-card__list">${gateRows}</div>
            </div>
        `;
    }

    printSessionGates() {
        const data = this.buildSessionGateData();
        this.lastSessionGateText = this.buildSessionGateText(data);
        const line = document.createElement('div');
        line.className = 'line line-output ai cli-gates-card-line';
        const body = this.renderSessionGateCard(data);
        if (this.theme === 'voxel') {
            line.innerHTML = `
                <div class="voxel-response-head">
                    <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>Quality Gates</span>
                    <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                    <span class="voxel-response-meta">readiness</span>
                </div>
                <div class="voxel-response-body">${body}</div>
            `;
        } else {
            line.innerHTML = `
                <div class="cli-response-shell">
                    <div class="cli-response-head">
                        <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                        <span class="cli-response-title">Quality Gates</span>
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }
        this.terminalOutput.appendChild(line);
        this.finishAIContentLine(line);
        this.scrollToBottom();
    }

    async copySessionGates() {
        const text = this.lastSessionGateText || this.buildSessionGateText();
        try {
            await this.writeClipboardText(text);
            this.printSystem('Quality gates copied to clipboard');
        } catch (_error) {
            this.printWarning('Clipboard unavailable. Use /packet for a broader saved handoff.');
        }
    }

    buildOpsSnapshotData() {
        const brief = this.getSessionBriefData();
        const audit = this.buildSessionAuditData();
        const gates = this.buildSessionGateData();
        const register = this.buildSessionRegisterData();
        const pins = (this.pinnedCommands || []).slice(0, 6);
        const recents = this.getRecentCommandLaunchers(6);
        const verdict = (gates.counts.fail || 0) > 0
            ? 'Needs attention'
            : ((gates.counts.warn || 0) > 0 ? 'Ready with warnings' : 'Ready');
        const openSignals = [
            ...(register.risks || []).map((item) => ({ type: 'Risk', text: item.text })),
            ...(brief.readiness || []).filter((item) => item.state !== 'ready').map((item) => ({ type: 'Readiness', text: item.label })),
            ...gates.gates.filter((gate) => gate.state === 'fail').map((gate) => ({ type: 'Gate', text: `${gate.label}: ${gate.detail}` })),
        ].slice(0, 5);
        return {
            createdAt: new Date().toISOString(),
            verdict,
            status: brief.status,
            brief,
            audit,
            gates,
            register,
            pins,
            recents,
            openSignals,
            nextActions: (brief.nextActions || []).slice(0, 5),
        };
    }

    buildOpsSnapshotText(data = this.buildOpsSnapshotData()) {
        const formatRows = (rows, fallback = '- None') => rows.length > 0
            ? rows.map((row, index) => `${index + 1}. ${typeof row === 'string' ? row : `${row.type}: ${row.text}`}`)
            : [fallback];
        return [
            'Lilly CLI Ops Snapshot',
            `Created: ${data.createdAt}`,
            `Verdict: ${data.verdict}`,
            `Session: ${data.status.session}`,
            `Model: ${data.status.model}`,
            `Runtime: ${data.status.runtime}`,
            `Connection: ${data.status.connection}`,
            `Transcript entries: ${data.brief.transcriptCount}`,
            `Files: ${data.brief.files.length}`,
            `Audit events: ${data.audit.events.length}`,
            `Gates: ${data.gates.counts.pass || 0} pass / ${data.gates.counts.warn || 0} warn / ${data.gates.counts.fail || 0} fail`,
            `Register: ${data.register.decisions.length} decisions / ${data.register.risks.length} risks / ${data.register.actions.length} actions`,
            `Pinned commands: ${data.pins.length}`,
            '',
            'Open signals:',
            ...formatRows(data.openSignals),
            '',
            'Next actions:',
            ...formatRows(data.nextActions),
            '',
            'Recent commands:',
            ...formatRows(data.recents),
        ].join('\n');
    }

    renderOpsSnapshotCard(data = this.buildOpsSnapshotData()) {
        const metricRows = [
            ['Runtime', data.status.runtime],
            ['Connection', data.status.connection],
            ['Transcript', String(data.brief.transcriptCount)],
            ['Files', String(data.brief.files.length)],
            ['Audit Events', String(data.audit.events.length)],
            ['Pins', String(data.pins.length)],
            ['Gates', `${data.gates.counts.pass || 0}/${data.gates.gates.length} pass`],
            ['Register', `${data.register.decisions.length}/${data.register.risks.length}/${data.register.actions.length}`],
        ].map(([label, value]) => `
            <div>
                <span>${this.escapeHtml(label)}</span>
                <strong>${this.escapeHtml(value)}</strong>
            </div>
        `).join('');
        const signalRows = data.openSignals.length > 0
            ? data.openSignals.map((signal) => `
                <div class="cli-ops-card__signal">
                    <strong>${this.escapeHtml(signal.type)}</strong>
                    <span>${this.escapeHtml(signal.text)}</span>
                </div>
            `).join('')
            : '<div class="cli-ops-card__empty">No open blockers detected locally.</div>';
        const actionRows = data.nextActions.length > 0
            ? data.nextActions.map((action) => `<span>${this.escapeHtml(action)}</span>`).join('')
            : '<span>No next action detected yet</span>';
        const commandRows = data.recents.length > 0
            ? data.recents.map((command) => `<span>${this.escapeHtml(command)}</span>`).join('')
            : '<span>No recent commands yet</span>';

        return `
            <div class="cli-ops-card" aria-label="Operations snapshot">
                <div class="cli-ops-card__header">
                    <div>
                        <span class="cli-status-card__kicker">Ops Snapshot</span>
                        <strong>${this.escapeHtml(data.verdict)}</strong>
                    </div>
                    <button type="button" onclick="app.copyOpsSnapshot()">Copy snapshot</button>
                </div>
                <div class="cli-ops-card__metrics">${metricRows}</div>
                <div class="cli-ops-card__columns">
                    <section>
                        <h4>Open Signals</h4>
                        ${signalRows}
                    </section>
                    <section>
                        <h4>Next Actions</h4>
                        <div class="cli-ops-card__action-list">${actionRows}</div>
                    </section>
                </div>
                <div class="cli-ops-card__commands">
                    <strong>Recent launchers</strong>
                    <div>${commandRows}</div>
                </div>
            </div>
        `;
    }

    printOpsSnapshot() {
        const data = this.buildOpsSnapshotData();
        this.lastOpsSnapshotText = this.buildOpsSnapshotText(data);
        const line = document.createElement('div');
        line.className = 'line line-output ai cli-ops-card-line';
        const body = this.renderOpsSnapshotCard(data);
        if (this.theme === 'voxel') {
            line.innerHTML = `
                <div class="voxel-response-head">
                    <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>Ops Snapshot</span>
                    <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                    <span class="voxel-response-meta">readiness</span>
                </div>
                <div class="voxel-response-body">${body}</div>
            `;
        } else {
            line.innerHTML = `
                <div class="cli-response-shell">
                    <div class="cli-response-head">
                        <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                        <span class="cli-response-title">Ops Snapshot</span>
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }
        this.terminalOutput.appendChild(line);
        this.finishAIContentLine(line);
        this.scrollToBottom();
    }

    async copyOpsSnapshot() {
        const text = this.lastOpsSnapshotText || this.buildOpsSnapshotText();
        try {
            await this.writeClipboardText(text);
            this.printSystem('Ops snapshot copied to clipboard');
        } catch (_error) {
            this.printWarning('Clipboard unavailable. Use /packet for a broader saved handoff.');
        }
    }

    buildEvidencePackData() {
        const ops = this.buildOpsSnapshotData();
        const audit = this.buildSessionAuditData();
        const gates = this.buildSessionGateData();
        const register = this.buildSessionRegisterData();
        const files = this.sessionFiles.slice(-8).map((file) => ({
            id: file.id,
            filename: file.filename,
            type: file.type || 'file',
            size: Number(file.size || 0),
            createdAt: file.createdAt || null,
        }));
        const evidence = [
            {
                label: 'Runtime',
                state: ops.status.runtime === 'ready' ? 'pass' : 'warn',
                detail: `${ops.status.runtime} / ${ops.status.connection}`,
            },
            {
                label: 'Transcript',
                state: ops.brief.transcriptCount > 0 ? 'pass' : 'fail',
                detail: `${ops.brief.transcriptCount} captured entries`,
            },
            {
                label: 'Quality gates',
                state: (gates.counts.fail || 0) > 0 ? 'fail' : ((gates.counts.warn || 0) > 0 ? 'warn' : 'pass'),
                detail: `${gates.counts.pass || 0} pass / ${gates.counts.warn || 0} warn / ${gates.counts.fail || 0} fail`,
            },
            {
                label: 'Decision register',
                state: register.decisions.length + register.risks.length + register.actions.length > 0 ? 'pass' : 'warn',
                detail: `${register.decisions.length} decisions / ${register.risks.length} risks / ${register.actions.length} actions`,
            },
            {
                label: 'File manifest',
                state: files.length > 0 ? 'pass' : 'warn',
                detail: `${files.length} recent file${files.length === 1 ? '' : 's'}`,
            },
            {
                label: 'Audit trail',
                state: audit.events.length > 0 ? 'pass' : 'warn',
                detail: `${audit.events.length} recent events`,
            },
        ];
        return {
            createdAt: new Date().toISOString(),
            verdict: ops.verdict,
            status: ops.status,
            ops,
            audit,
            gates,
            register,
            files,
            evidence,
            recentCommands: this.getRecentCommandLaunchers(6),
        };
    }

    buildEvidencePackText(data = this.buildEvidencePackData()) {
        const formatItems = (items, formatter, fallback = '- None') => items.length > 0
            ? items.map((item, index) => `${index + 1}. ${formatter(item)}`)
            : [fallback];
        return [
            'Lilly CLI Evidence Pack',
            `Created: ${data.createdAt}`,
            `Verdict: ${data.verdict}`,
            `Session: ${data.status.session}`,
            `Model: ${data.status.model}`,
            `Runtime: ${data.status.runtime}`,
            `Connection: ${data.status.connection}`,
            '',
            'Evidence coverage:',
            ...formatItems(data.evidence, (item) => `[${item.state}] ${item.label}: ${item.detail}`),
            '',
            'File manifest:',
            ...formatItems(data.files, (file) => `#${file.id} ${file.filename} (${file.type}, ${this.formatFileSize(file.size)})`),
            '',
            'Recent audit events:',
            ...formatItems(data.audit.events.slice(0, 8), (event) => `[${event.state}] ${event.time} ${event.label}: ${event.detail}`),
            '',
            'Gate review:',
            ...data.gates.gates.map((gate) => `- [${gate.state}] ${gate.label}: ${gate.detail}`),
            '',
            'Register summary:',
            `- Decisions: ${data.register.decisions.length}`,
            `- Risks: ${data.register.risks.length}`,
            `- Actions: ${data.register.actions.length}`,
            '',
            'Recent commands:',
            ...formatItems(data.recentCommands, (command) => command),
        ].join('\n');
    }

    renderEvidencePackCard(data = this.buildEvidencePackData()) {
        const coverageRows = data.evidence.map((item) => `
            <div class="cli-ops-card__signal ${this.escapeHtmlAttr(item.state)}">
                <strong>${this.escapeHtml(item.label)}</strong>
                <span>${this.escapeHtml(item.detail)}</span>
            </div>
        `).join('');
        const fileRows = data.files.length > 0
            ? data.files.slice(0, 5).map((file) => `
                <span>#${this.escapeHtml(String(file.id))} ${this.escapeHtml(file.filename)} - ${this.escapeHtml(this.formatFileSize(file.size))}</span>
            `).join('')
            : '<span>No session files yet</span>';
        const eventRows = data.audit.events.length > 0
            ? data.audit.events.slice(0, 5).map((event) => `
                <span>${this.escapeHtml(event.time)} ${this.escapeHtml(event.label)} - ${this.escapeHtml(event.detail)}</span>
            `).join('')
            : '<span>No audit events yet</span>';

        return `
            <div class="cli-ops-card cli-evidence-card" aria-label="Evidence pack">
                <div class="cli-ops-card__header">
                    <div>
                        <span class="cli-status-card__kicker">Evidence Pack</span>
                        <strong>${this.escapeHtml(data.verdict)}</strong>
                    </div>
                    <button type="button" onclick="app.copyEvidencePack()">Copy evidence</button>
                </div>
                <div class="cli-ops-card__metrics">
                    <div><span>Gates</span><strong>${this.escapeHtml(String(data.gates.gates.length))}</strong></div>
                    <div><span>Files</span><strong>${this.escapeHtml(String(data.files.length))}</strong></div>
                    <div><span>Events</span><strong>${this.escapeHtml(String(data.audit.events.length))}</strong></div>
                    <div><span>Register</span><strong>${this.escapeHtml(String(data.register.decisions.length + data.register.risks.length + data.register.actions.length))}</strong></div>
                </div>
                <div class="cli-ops-card__columns">
                    <section>
                        <h4>Coverage</h4>
                        ${coverageRows}
                    </section>
                    <section>
                        <h4>Manifest</h4>
                        <div class="cli-ops-card__action-list">${fileRows}</div>
                    </section>
                </div>
                <div class="cli-ops-card__commands">
                    <strong>Recent audit proof</strong>
                    <div>${eventRows}</div>
                </div>
            </div>
        `;
    }

    printEvidencePack() {
        const data = this.buildEvidencePackData();
        this.lastEvidencePackText = this.buildEvidencePackText(data);
        const line = document.createElement('div');
        line.className = 'line line-output ai cli-evidence-card-line';
        const body = this.renderEvidencePackCard(data);
        if (this.theme === 'voxel') {
            line.innerHTML = `
                <div class="voxel-response-head">
                    <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>Evidence Pack</span>
                    <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                    <span class="voxel-response-meta">proof</span>
                </div>
                <div class="voxel-response-body">${body}</div>
            `;
        } else {
            line.innerHTML = `
                <div class="cli-response-shell">
                    <div class="cli-response-head">
                        <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                        <span class="cli-response-title">Evidence Pack</span>
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }
        this.terminalOutput.appendChild(line);
            this.finishAIContentLine(line);
        this.scrollToBottom();
    }

    async copyEvidencePack() {
        const text = this.lastEvidencePackText || this.buildEvidencePackText();
        try {
            await this.writeClipboardText(text);
            this.printSystem('Evidence pack copied to clipboard');
        } catch (_error) {
            this.printWarning('Clipboard unavailable. Use /packet for a broader saved handoff.');
        }
    }

    buildReviewQueueData() {
        const ops = this.buildOpsSnapshotData();
        const gates = this.buildSessionGateData();
        const register = this.buildSessionRegisterData();
        const recents = this.getRecentCommandLaunchers(6);
        const signals = [];

        gates.gates
            .filter((gate) => gate.state === 'fail' || gate.state === 'warn')
            .forEach((gate) => {
                signals.push({
                    priority: gate.state === 'fail' ? 'high' : 'medium',
                    kind: 'Gate',
                    text: `${gate.label}: ${gate.detail}`,
                });
            });

        register.risks
            .forEach((risk) => {
                signals.push({
                    priority: 'high',
                    kind: 'Risk',
                    text: `${risk.text}`,
                });
            });

        register.actions
            .forEach((action) => {
                signals.push({
                    priority: 'medium',
                    kind: 'Action',
                    text: `${action.text}`,
                });
            });

        register.decisions
            .forEach((decision) => {
                signals.push({
                    priority: 'low',
                    kind: 'Decision',
                    text: `${decision.text}`,
                });
            });

        const orderedSignals = signals.slice(0, 12).map((item) => ({
            ...item,
            state: item.priority === 'high' ? 'fail' : (item.priority === 'medium' ? 'warn' : 'pass'),
        }));

        const counts = orderedSignals.reduce((acc, signal) => {
            acc[signal.priority] = (acc[signal.priority] || 0) + 1;
            return acc;
        }, {});
        const total = orderedSignals.length;
        const verdict = counts.high > 0
            ? 'Needs immediate attention'
            : (counts.medium > 0 ? 'Needs review' : 'Ready');

        return {
            createdAt: new Date().toISOString(),
            verdict,
            total,
            counts: {
                high: counts.high || 0,
                medium: counts.medium || 0,
                low: counts.low || 0,
            },
            signals: orderedSignals,
            recents,
            ops,
            gates,
            register,
        };
    }

    buildReviewQueueText(data = this.buildReviewQueueData()) {
        const formatItems = (items, formatter, fallback = '- None') => items.length > 0
            ? items.map((item, index) => `${index + 1}. ${formatter(item)}`)
            : [fallback];

        return [
            'Lilly CLI Review Queue',
            `Created: ${data.createdAt}`,
            `Verdict: ${data.verdict}`,
            `Session: ${data.ops.status.session}`,
            `Model: ${data.ops.status.model}`,
            `Total: ${data.total} item${data.total === 1 ? '' : 's'}`,
            `High: ${data.counts.high} / Medium: ${data.counts.medium} / Low: ${data.counts.low}`,
            '',
            'Queue:',
            ...formatItems(data.signals, (signal) => `- [${signal.priority}] ${signal.kind}: ${signal.text}`),
            '',
            'Recent commands:',
            ...formatItems(data.recents, (command) => command),
        ].join('\n');
    }

    renderReviewQueueCard(data = this.buildReviewQueueData()) {
        const signalRows = data.signals.length > 0
            ? data.signals.map((signal) => `
                <div class="cli-ops-card__signal ${this.escapeHtmlAttr(signal.state)}">
                    <strong>${this.escapeHtml(signal.kind)}</strong>
                    <span>[${this.escapeHtml(signal.priority)}] ${this.escapeHtml(signal.text)}</span>
                </div>
            `).join('')
            : '<span>No review items queued.</span>';
        const recentRows = data.recents.length > 0
            ? data.recents.map((command) => `<span>${this.escapeHtml(command)}</span>`).join('')
            : '<span>No recent commands yet</span>';

        return `
            <div class="cli-ops-card cli-review-card" aria-label="Review queue">
                <div class="cli-ops-card__header">
                    <div>
                        <span class="cli-status-card__kicker">Review Queue</span>
                        <strong>${this.escapeHtml(data.verdict)}</strong>
                    </div>
                    <button type="button" onclick="app.copyReviewQueue()">Copy review queue</button>
                </div>
                <div class="cli-ops-card__metrics">
                    <div><span>High</span><strong>${this.escapeHtml(String(data.counts.high))}</strong></div>
                    <div><span>Medium</span><strong>${this.escapeHtml(String(data.counts.medium))}</strong></div>
                    <div><span>Low</span><strong>${this.escapeHtml(String(data.counts.low))}</strong></div>
                    <div><span>Total</span><strong>${this.escapeHtml(String(data.total))}</strong></div>
                </div>
                <div class="cli-ops-card__commands">
                    <strong>Queue</strong>
                    <div>${signalRows}</div>
                </div>
                <div class="cli-ops-card__commands">
                    <strong>Recent launchers</strong>
                    <div>${recentRows}</div>
                </div>
            </div>
        `;
    }

    printReviewQueue() {
        const data = this.buildReviewQueueData();
        this.lastReviewQueueText = this.buildReviewQueueText(data);
        const line = document.createElement('div');
        line.className = 'line line-output ai cli-ops-card-line';
        const body = this.renderReviewQueueCard(data);
        if (this.theme === 'voxel') {
            line.innerHTML = `
                <div class="voxel-response-head">
                    <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>Review Queue</span>
                    <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                    <span class="voxel-response-meta">triage</span>
                </div>
                <div class="voxel-response-body">${body}</div>
            `;
        } else {
            line.innerHTML = `
                <div class="cli-response-shell">
                    <div class="cli-response-head">
                        <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                        <span class="cli-response-title">Review Queue</span>
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }
        this.terminalOutput.appendChild(line);
        this.finishAIContentLine(line);
        this.scrollToBottom();
    }

    async copyReviewQueue() {
        const text = this.lastReviewQueueText || this.buildReviewQueueText();
        try {
            await this.writeClipboardText(text);
            this.printSystem('Review queue copied to clipboard');
        } catch (_error) {
            this.printWarning('Clipboard unavailable. Use /packet for a broader saved handoff.');
        }
    }

    isCurrentHelpCommand(command = {}) {
        return WEB_CLI_CURRENT_HELP_COMMAND_IDS.has(command.id);
    }
    
    setupEventListeners() {
        // Input handling
        this.commandInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const exactCommand = this.getExactCommandEntry(this.commandInput.value);
                if (exactCommand && !exactCommand.requiresInput) {
                    this.hideAutocomplete();
                    this.sendCommand();
                } else if (this.autocompleteMatches.length > 0 && this.autocompleteIndex >= 0) {
                    this.selectAutocomplete();
                } else {
                    this.sendCommand();
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (this.autocompleteMatches.length > 0) {
                    this.navigateAutocomplete(-1);
                } else {
                    this.navigateHistory(-1);
                }
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (this.autocompleteMatches.length > 0) {
                    this.navigateAutocomplete(1);
                } else {
                    this.navigateHistory(1);
                }
            } else if (e.key === 'Tab') {
                e.preventDefault();
                this.handleTabCompletion();
            } else if (e.ctrlKey && e.key === 'l') {
                e.preventDefault();
                this.clearOutput();
            } else if (e.ctrlKey && e.key === 'c') {
                // Only intercept if no text is selected (allow normal copy)
                const selection = window.getSelection().toString();
                if (!selection) {
                    e.preventDefault();
                    this.copyLastOutput();
                }
            } else if (e.key === 'Escape') {
                if (this.isProcessing) {
                    e.preventDefault();
                    this.cancelCurrentRequest();
                }
                this.hideAutocomplete();
                this.closeCommandDrawer();
                this.closeShortcuts();
                this.closeFileManager();
                this.closeVoxelCreator();
            } else if (e.key === 'F1') {
                e.preventDefault();
                this.showShortcuts();
            } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
                e.preventDefault();
                this.openFileManager();
            }
        });
        
        // Input for autocomplete
        this.commandInput.addEventListener('input', () => {
            this.updateAutocomplete();
            this.updateCommandAssist();
            this.queueVoxelTypingReaction();
        });

        this.commandInput.addEventListener('focus', () => {
            this.updateCommandAssist();
        });

        this.shortcutsModal?.addEventListener('keydown', (e) => {
            this.handleShortcutsKeydown(e);
        });

        this.voxelDock?.addEventListener('keydown', (e) => {
            this.handleVoxelCreatorKeydown(e);
        });

        if (this.voxelPetPrompt) {
            this.voxelPetPrompt.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.generateAIVoxelPetFromInput();
                }
            });
        }
        
        // Focus input on click anywhere
        document.addEventListener('click', (e) => {
            if (!e.target.closest('button, input, textarea, select, a, [contenteditable="true"], .autocomplete, .modal, .voxel-creator-modal, .file-manager-modal, .command-drawer')) {
                this.commandInput.focus();
            }
        });
        
        // Model selection
        this.modelSelect.addEventListener('change', () => {
            const scrollState = this.captureTerminalScrollState();
            api.setModel(this.modelSelect.value);
            this.updateModelInfo();
            this.printSystem(`Model set to: ${this.modelSelect.value}`, { scrollState });
        });
        
        // File drop handling
        this.dragOverlay = document.getElementById('dragOverlay');
        this.dragEnterCounter = 0;
        
        document.addEventListener('dragenter', (e) => {
            e.preventDefault();
            this.dragEnterCounter++;
            this.setDragOverlayActive(true);
            this.roamVoxelPet('alert', 'guard', 1400);
        });
        
        document.addEventListener('dragover', (e) => {
            e.preventDefault();
        });
        
        document.addEventListener('dragleave', (e) => {
            e.preventDefault();
            this.dragEnterCounter--;
            if (this.dragEnterCounter <= 0) {
                this.dragEnterCounter = 0;
                this.setDragOverlayActive(false);
            }
        });
        
        document.addEventListener('drop', (e) => {
            e.preventDefault();
            this.dragEnterCounter = 0;
            this.setDragOverlayActive(false);
            
            const files = Array.from(e.dataTransfer.files);
            this.roamVoxelPet('alert', 'scout', 1400);
            files.forEach(file => this.handleFile(file));
        });
        
        // Cancel drag when pressing Escape
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') {
                return;
            }

            this.closeVoxelCreator();
            this.closeCommandDrawer();
            if (this.dragOverlay && this.dragOverlay.classList.contains('active')) {
                this.cancelDrag();
            }
        });
    }

    setupCommandDrawer() {
        if (!this.commandDrawerToggle || !this.commandDrawer) return;

        this.commandDrawerToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleCommandDrawer();
        });

        this.commandDrawerToggle.addEventListener('keydown', (e) => {
            this.handleCommandDrawerToggleKeydown(e);
        });

        this.commandDrawer.addEventListener('click', (e) => {
            if (e.target.closest('button, a')) {
                this.closeCommandDrawer();
            }
        });

        this.commandDrawer.addEventListener('keydown', (e) => {
            this.handleCommandDrawerKeydown(e);
        });

        document.addEventListener('click', (e) => {
            if (!this.commandDrawer.hidden && !e.target.closest('.toolbar')) {
                this.closeCommandDrawer();
            }
        });
    }

    getCommandDrawerItems() {
        if (!this.commandDrawer) return [];
        return Array.from(this.commandDrawer.querySelectorAll('button:not(:disabled), a[href]'))
            .filter((item) => this.isCommandDrawerItemVisible(item));
    }

    isCommandDrawerItemVisible(item) {
        if (!item || item.hidden || item.getAttribute('aria-hidden') === 'true') {
            return false;
        }

        if (item.style?.display === 'none' || item.style?.visibility === 'hidden') {
            return false;
        }

        if (typeof item.getClientRects === 'function' && item.getClientRects().length > 0) {
            return true;
        }

        if ('offsetParent' in item && item.offsetParent !== null) {
            return true;
        }

        if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
            return true;
        }

        const styles = window.getComputedStyle(item);
        return styles.display !== 'none' && styles.visibility !== 'hidden';
    }

    focusCommandDrawerItem(currentItem, direction) {
        const items = this.getCommandDrawerItems();
        if (items.length === 0) return;

        const currentIndex = Math.max(0, items.indexOf(currentItem));
        const nextIndex = (currentIndex + direction + items.length) % items.length;
        this.setCommandDrawerTabStop(items[nextIndex]);
    }

    setCommandDrawerTabStop(activeItem = null) {
        const items = this.getCommandDrawerItems();
        const nextItem = items.includes(activeItem) ? activeItem : items[0] || null;

        items.forEach((item) => {
            item.setAttribute('tabindex', item === nextItem ? '0' : '-1');
        });
        nextItem?.focus({ preventScroll: true });
    }

    handleCommandDrawerToggleKeydown(e) {
        const openFromStartKeys = ['ArrowDown', 'ArrowRight', 'Home'];
        const openFromEndKeys = ['ArrowUp', 'ArrowLeft', 'End'];

        if (!openFromStartKeys.includes(e.key) && !openFromEndKeys.includes(e.key)) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        this.toggleCommandDrawer(true);

        const items = this.getCommandDrawerItems();
        const targetItem = openFromEndKeys.includes(e.key) ? items[items.length - 1] : items[0];
        this.setCommandDrawerTabStop(targetItem);
    }

    handleCommandDrawerKeydown(e) {
        if (!this.commandDrawer || this.commandDrawer.hidden) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.closeCommandDrawer({ restoreFocus: true });
            return;
        }

        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
            e.preventDefault();
            this.focusCommandDrawerItem(e.target, 1);
            return;
        }

        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
            e.preventDefault();
            this.focusCommandDrawerItem(e.target, -1);
            return;
        }

        if (e.key === 'Home') {
            e.preventDefault();
            this.setCommandDrawerTabStop(this.getCommandDrawerItems()[0]);
            return;
        }

        if (e.key === 'End') {
            e.preventDefault();
            const items = this.getCommandDrawerItems();
            this.setCommandDrawerTabStop(items[items.length - 1]);
        }
    }

    toggleCommandDrawer(forceOpen = null) {
        if (!this.commandDrawer || !this.commandDrawerToggle) return;
        const shouldOpen = forceOpen === null ? this.commandDrawer.hidden : forceOpen;
        this.commandDrawer.hidden = !shouldOpen;
        this.commandDrawer.classList.toggle('is-open', shouldOpen);
        this.commandDrawerToggle.classList.toggle('is-active', shouldOpen);
        this.commandDrawerToggle.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
        const toggleLabel = shouldOpen ? 'Close command actions' : 'Open command actions';
        this.commandDrawerToggle.setAttribute('aria-label', toggleLabel);
        this.commandDrawerToggle.setAttribute('title', toggleLabel);

        if (shouldOpen) {
            this.setCommandDrawerTabStop();
        }
    }

    closeCommandDrawer(options = {}) {
        this.toggleCommandDrawer(false);
        if (options.restoreFocus) {
            this.commandDrawerToggle?.focus({ preventScroll: true });
        }
    }

    // ==================== Voxel Pet System ====================

    loadVoxelPet() {
        const generator = this.voxel;
        if (!generator) {
            return null;
        }

        try {
            const stored = localStorage.getItem('codecli-voxel-pet');
            if (stored) {
                return generator.normalize(JSON.parse(stored));
            }
        } catch (error) {
            console.warn('[CLI] Failed to load voxel pet:', error);
        }

        return typeof generator.random === 'function'
            ? generator.random()
            : generator.generate('curious neon fox with amber goggles');
    }

    saveVoxelPet() {
        if (!this.voxelPet) {
            return;
        }

        localStorage.setItem('codecli-voxel-pet', JSON.stringify(this.voxelPet));
    }

    loadVoxelPersonality() {
        const fallback = {
            turns: 0,
            bond: 18,
            curiosity: 46,
            confidence: 38,
            playfulness: 34,
            sandboxRuns: 0,
            buildRuns: 0,
            toolRuns: 0,
            lastThought: '',
        };

        try {
            const stored = JSON.parse(localStorage.getItem('codecli-voxel-personality') || 'null');
            if (!stored || typeof stored !== 'object') {
                return fallback;
            }

            return {
                ...fallback,
                ...stored,
                turns: Number.isFinite(Number(stored.turns)) ? Number(stored.turns) : fallback.turns,
                bond: this.clampPersonalityValue(stored.bond, fallback.bond),
                curiosity: this.clampPersonalityValue(stored.curiosity, fallback.curiosity),
                confidence: this.clampPersonalityValue(stored.confidence, fallback.confidence),
                playfulness: this.clampPersonalityValue(stored.playfulness, fallback.playfulness),
                sandboxRuns: Math.max(0, Number.parseInt(stored.sandboxRuns, 10) || fallback.sandboxRuns),
                buildRuns: Math.max(0, Number.parseInt(stored.buildRuns, 10) || fallback.buildRuns),
                toolRuns: Math.max(0, Number.parseInt(stored.toolRuns, 10) || fallback.toolRuns),
            };
        } catch (_error) {
            return fallback;
        }
    }

    saveVoxelPersonality() {
        localStorage.setItem('codecli-voxel-personality', JSON.stringify(this.voxelPersonality));
    }

    clampPersonalityValue(value, fallback = 0) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : fallback;
    }

    setVoxelPalette() {
        if (!this.voxelPet?.palette) {
            return;
        }

        document.body.style.setProperty('--voxel-pet-primary', this.voxelPet.palette.primary);
        document.body.style.setProperty('--voxel-pet-secondary', this.voxelPet.palette.secondary);
        document.body.style.setProperty('--voxel-pet-accent', this.voxelPet.palette.accent);
    }

    renderVoxelPet(action = this.activePetAction || 'idle') {
        if (!this.voxel || !this.voxelPet) {
            return;
        }

        const isVoxelTheme = this.theme === 'voxel';
        this.setVoxelPalette();
        if (this.voxelPetStage) {
            this.voxelPetStage.replaceChildren(this.voxel.renderElement(this.voxelPet, { action, variant: 'full' }));
        }
        if (this.voxelPetMini) {
            this.voxelPetMini.replaceChildren(this.voxel.renderElement(this.voxelPet, {
                action,
                variant: 'mini',
                decorative: true,
            }));
        }
        if (this.voxelRoamerStage) {
            this.voxelRoamerStage.replaceChildren(this.voxel.renderElement(this.voxelPet, {
                action,
                variant: 'peek',
                decorative: true,
            }));
        }

        if (this.voxelPetName) {
            this.voxelPetName.textContent = this.voxelPet.name;
        }
        if (this.voxelPetKind) {
            this.voxelPetKind.textContent = `${this.voxelPet.trait} ${this.voxelPet.species}`;
        }
        if (this.voxelPetMood) {
            this.voxelPetMood.textContent = this.voxel.MOODS[this.voxelPet.mood] || this.voxelPet.mood;
        }
        if (this.voxelPetEnergy) {
            this.voxelPetEnergy.style.setProperty('--value', `${this.voxelPet.energy}%`);
        }
        if (this.voxelPetSeed) {
            this.voxelPetSeed.textContent = `Seed: ${this.voxelPet.prompt}`;
        }
        if (this.voxelPetPrompt && !this.voxelPetPrompt.value) {
            this.voxelPetPrompt.value = this.voxelPet.prompt;
        }
        if (this.inputPrompt) {
            this.inputPrompt.textContent = this.getPromptLabel();
        }
        if (this.voxelPetStatus) {
            const mood = this.voxel.MOODS[this.voxelPet.mood] || this.voxelPet.mood;
            const bond = Math.round(this.voxelPersonality?.bond || 0);
            this.voxelPetStatus.textContent = this.voxelPetHidden
                ? 'Agent companion hidden'
                : isVoxelTheme
                    ? `${this.voxelPet.name} | ${mood} | bond ${bond}%`
                    : 'Agent companion available from the toolbar';
            this.voxelPetStatus.title = `${this.voxelPet.trait} ${this.voxelPet.species} - ${this.voxelPet.prompt} - ${this.voxelPet.energy}% energy`;
        }
        this.renderVoxelAgentStats();
        if (this.voxelPetButton) {
            this.voxelPetButton.classList.toggle('is-hidden', this.voxelPetHidden || !isVoxelTheme);
        }
        if (this.voxelRoamer) {
            this.voxelRoamer.classList.toggle('hidden', this.voxelPetHidden || !isVoxelTheme);
        }

        if (action !== 'idle') {
            window.clearTimeout(this.voxelActionTimer);
            this.voxelActionTimer = window.setTimeout(() => {
                this.activePetAction = 'idle';
                this.renderVoxelPet('idle');
            }, 900);
        }
    }

    renderVoxelAgentStats() {
        const personality = this.voxelPersonality || {};
        const focus = Math.round((
            Number(personality.curiosity || 0)
            + Number(personality.confidence || 0)
        ) / 2);

        if (this.voxelBondStat) {
            this.voxelBondStat.textContent = `${Math.round(personality.bond || 0)}%`;
        }
        if (this.voxelFocusStat) {
            this.voxelFocusStat.textContent = `${focus}%`;
        }
        if (this.voxelBuildStat) {
            this.voxelBuildStat.textContent = String(personality.buildRuns || 0);
        }
        if (this.voxelToolStat) {
            const toolRuns = Number(personality.toolRuns || 0) + Number(personality.sandboxRuns || 0);
            this.voxelToolStat.textContent = String(toolRuns);
        }
    }

    scheduleVoxelAmbientMove() {
        window.clearTimeout(this.voxelAmbientTimer);
        const delay = 4200 + Math.floor(Math.random() * 6200);
        this.voxelAmbientTimer = window.setTimeout(() => {
            if (this.theme === 'voxel' && !this.voxelPetHidden && !this.isProcessing && document.hasFocus()) {
                const actions = ['idle', 'scout', 'guard', 'sleep', 'dance'];
                const action = actions[Math.floor(Math.random() * actions.length)];
                const thought = this.getVoxelAmbientThought(action);
                if (action === 'idle') {
                    this.renderVoxelPet('idle');
                } else {
                    const placement = this.getVoxelRoamPlacement(action);
                    const duration = placement.startsWith('corner') ? 6200 : 2600;
                    this.roamVoxelPet(placement, action, duration, { thought, linger: placement.startsWith('corner') });
                }
                this.lastVoxelAmbientMove = Date.now();
            }
            this.scheduleVoxelAmbientMove();
        }, delay);
    }

    setVoxelPetHidden(hidden) {
        this.voxelPetHidden = Boolean(hidden);
        localStorage.setItem('codecli-voxel-pet-hidden', String(this.voxelPetHidden));
        if (this.voxelPetHidden) {
            this.closeVoxelCreator();
            this.clearVoxelRoamerPlacementClasses();
        }
        this.renderVoxelPet(this.voxelPetHidden ? 'idle' : 'scout');
        this.updateEnterpriseButton();
    }

    closeVoxelCreator() {
        const wasOpen = this.voxelDock && !this.voxelDock.classList.contains('hidden');
        this.voxelDock?.classList.add('hidden');
        if (wasOpen && this.voxelCreatorReturnFocus?.isConnected) {
            this.voxelCreatorReturnFocus.focus({ preventScroll: true });
        }
        this.voxelCreatorReturnFocus = null;
    }

    handleVoxelCreatorKeydown(event) {
        if (!event || this.voxelDock?.classList.contains('hidden')) {
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            this.closeVoxelCreator();
            return;
        }

        if (event.key !== 'Tab') {
            return;
        }

        const focusable = Array.from(this.voxelDock.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
        if (focusable.length === 0) {
            event.preventDefault();
            this.voxelDock.focus();
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    getVoxelRoamPlacement(action = 'scout') {
        const normalized = String(action || 'scout').toLowerCase();
        const placements = normalized === 'sleep'
            ? ['corner-bl', 'corner-br', 'prompt']
            : ['prompt', 'stream', 'edge-left', 'edge-right', 'corner-tl', 'corner-tr', 'corner-bl', 'corner-br'];
        const recent = this.lastVoxelRoamPlacement;
        const available = placements.filter((placement) => placement !== recent);
        const chosen = available[Math.floor(Math.random() * available.length)] || placements[0];
        this.lastVoxelRoamPlacement = chosen;
        return chosen;
    }

    clearVoxelRoamerPlacementClasses() {
        this.voxelRoamer?.classList.remove(
            'is-visible',
            'is-prompt',
            'is-stream',
            'is-alert',
            'is-edge-left',
            'is-edge-right',
            'is-corner-tl',
            'is-corner-tr',
            'is-corner-bl',
            'is-corner-br',
            'is-lingering',
        );
        this.voxelRoamHoldUntil = 0;
    }

    roamVoxelPet(placement = 'prompt', action = 'scout', duration = 1200, options = {}) {
        if (this.theme !== 'voxel' || this.voxelPetHidden || !this.voxelRoamer || !this.voxelRoamerStage || !this.voxel || !this.voxelPet) {
            return;
        }

        const now = Date.now();
        const isHeldInCorner = this.voxelRoamer.classList.contains('is-lingering') && now < this.voxelRoamHoldUntil;
        const isUrgent = placement === 'alert' || ['jump', 'guard'].includes(String(action || '').toLowerCase());
        if (isHeldInCorner && !options.force && !isUrgent) {
            return;
        }

        const isTravelAction = ['scout', 'guard', 'idle', 'dance'].includes(String(action || '').toLowerCase());
        const renderedAction = isTravelAction ? 'roam' : action;
        const directionYaw = /right|stream|tr|br/.test(placement) ? 18 : -18;
        const nodes = [this.voxel.renderElement(this.voxelPet, {
            action: renderedAction,
            variant: 'peek',
            decorative: true,
            yaw: directionYaw,
        })];
        const thought = String(options.thought || '').trim();
        if (thought) {
            const bubble = document.createElement('span');
            bubble.className = 'voxel-roamer-bubble';
            bubble.textContent = thought.slice(0, 48);
            nodes.push(bubble);
        }
        this.voxelRoamerStage.replaceChildren(...nodes);
        this.clearVoxelRoamerPlacementClasses();
        this.voxelRoamer.classList.remove('hidden');
        this.voxelRoamer.classList.add(`is-${placement}`, 'is-visible');
        this.voxelRoamer.classList.toggle('is-lingering', Boolean(options.linger));
        this.voxelRoamHoldUntil = options.linger ? now + Math.min(duration, 7000) : 0;

        window.clearTimeout(this.voxelRoamTimer);
        this.voxelRoamTimer = window.setTimeout(() => {
            this.clearVoxelRoamerPlacementClasses();
        }, duration);
    }

    queueVoxelTypingReaction() {
        if (this.theme !== 'voxel' || this.voxelPetHidden || !this.commandInput?.value.trim()) {
            return;
        }

        window.clearTimeout(this.voxelTypingTimer);
        this.voxelTypingTimer = window.setTimeout(() => {
            const now = Date.now();
            const typed = this.commandInput?.value.trim() || '';
            if (typed.length < 4 || now - this.lastVoxelTypingReaction < 2200) {
                return;
            }
            this.lastVoxelTypingReaction = now;
            this.renderVoxelPet('scout');
            const placement = typed.length > 42 ? 'corner-bl' : 'prompt';
            this.roamVoxelPet(placement, 'scout', placement.startsWith('corner') ? 5000 : 1900, {
                thought: this.getVoxelTypingThought(),
                linger: placement.startsWith('corner'),
            });
        }, 520);
    }

    recordVoxelInteraction(input = '', response = '') {
        if (!this.voxelPersonality || this.voxelPetHidden) {
            return;
        }

        const text = `${input} ${response}`.toLowerCase();
        const asksQuestion = input.includes('?');
        const praise = /\b(thanks|thank you|nice|great|awesome|perfect|love|cool)\b/.test(text);
        const complexWork = /\b(debug|deploy|implement|refactor|kubectl|docker|test|fix|error|commit|build)\b/.test(text);

        this.voxelPersonality = {
            ...this.voxelPersonality,
            turns: this.voxelPersonality.turns + 1,
            bond: this.clampPersonalityValue(this.voxelPersonality.bond + (praise ? 5 : 1)),
            curiosity: this.clampPersonalityValue(this.voxelPersonality.curiosity + (asksQuestion ? 3 : 1)),
            confidence: this.clampPersonalityValue(this.voxelPersonality.confidence + (complexWork ? 3 : 1)),
            playfulness: this.clampPersonalityValue(this.voxelPersonality.playfulness + (praise ? 2 : 0.5)),
        };
        this.saveVoxelPersonality();
        this.renderVoxelPet();
    }

    recordVoxelToolUse(kind = 'tool') {
        if (!this.voxelPersonality) {
            return;
        }

        const normalized = String(kind || 'tool').toLowerCase();
        const key = normalized === 'sandbox'
            ? 'sandboxRuns'
            : normalized === 'build'
                ? 'buildRuns'
                : 'toolRuns';

        this.voxelPersonality = {
            ...this.voxelPersonality,
            [key]: Number(this.voxelPersonality[key] || 0) + 1,
            bond: this.clampPersonalityValue(Number(this.voxelPersonality.bond || 0) + 1),
            curiosity: this.clampPersonalityValue(Number(this.voxelPersonality.curiosity || 0) + (normalized === 'sandbox' ? 2 : 1)),
            confidence: this.clampPersonalityValue(Number(this.voxelPersonality.confidence || 0) + (normalized === 'build' ? 3 : 2)),
        };
        this.saveVoxelPersonality();
        this.renderVoxelAgentStats();
    }

    setActiveVoxelTool(tool = 'chat') {
        this.activeVoxelTool = tool;
        if (!this.voxelToolbelt) {
            return;
        }

        const labels = {
            chat: 'Ask Lilly with agent companion',
            tools: 'List available agent tools',
            files: 'Open generated session files',
            sandbox: 'Run an agent sandbox example',
            build: 'Draft a repository build task prompt',
        };

        this.voxelToolbelt.querySelectorAll('.voxel-tool-chip').forEach((button) => {
            const isActive = button.dataset.tool === tool;
            const label = labels[button.dataset.tool] || button.textContent.trim() || 'Use agent quick tool';
            const state = isActive ? 'Currently selected.' : 'Press to select.';
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
            button.setAttribute('aria-label', `${label}. ${state}`);
            button.setAttribute('title', `${label}. ${state}`);
        });
    }

    useVoxelQuickTool(tool = 'chat') {
        const normalized = String(tool || 'chat').toLowerCase();
        this.setActiveVoxelTool(normalized);
        this.setVoxelPetHidden(false);

        const actions = {
            chat: () => {
                this.commandInput.value = '';
                this.commandInput.placeholder = 'Ask Lilly for help, open /files, or list /tools...';
                this.commandInput.focus();
                this.roamVoxelPet('prompt', 'scout', 1000, { thought: 'agent link' });
            },
            sandbox: () => {
                this.commandInput.value = '/sandbox javascript console.log("hello from the voxel sandbox")';
                this.commandInput.focus();
                this.roamVoxelPet('prompt', 'guard', 1200, { thought: 'sandbox ready' });
            },
            build: () => {
                this.printBuildDeck();
                this.commandInput.value = 'Build a small feature in this repo: ';
                this.commandInput.focus();
                this.recordVoxelToolUse('build');
                this.roamVoxelPet('stream', 'scout', 1300, { thought: 'build map open' });
            },
            tools: async () => {
                this.recordVoxelToolUse('tool');
                this.roamVoxelPet('stream', 'scout', 1200, { thought: 'tool scan' });
                await this.listTools();
            },
            files: () => {
                this.openFileManager();
                this.roamVoxelPet('prompt', 'scout', 1000, { thought: 'file crate' });
            },
        };

        const handler = actions[normalized] || actions.chat;
        handler();
    }

    getCommandEntry(value = '') {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) {
            return null;
        }

        const commandsByLength = [...this.commandCatalog].sort((a, b) => {
            const aLength = Math.max(String(a.command || '').length, ...(a.aliases || []).map((alias) => String(alias || '').length));
            const bLength = Math.max(String(b.command || '').length, ...(b.aliases || []).map((alias) => String(alias || '').length));
            return bLength - aLength;
        });

        return commandsByLength.find((entry) => {
            const candidates = [entry.command, ...(entry.aliases || [])]
                .filter(Boolean)
                .map((candidate) => String(candidate).toLowerCase());
            return candidates.some((candidate) => (
                normalized === candidate
                || normalized.startsWith(`${candidate} `)
                || (candidate === 'ask' && !normalized.startsWith('/'))
            ));
        }) || null;
    }

    getCommandMatches(input = '') {
        const rawInput = String(input || '').trimStart();
        const query = rawInput.toLowerCase();
        if (!query.startsWith('/')) {
            return [];
        }

        const searchText = query.slice(1).trim();
        const matches = this.commandCatalog
            .filter((entry) => entry.command.startsWith('/') && this.isCurrentHelpCommand(entry))
            .map((entry) => {
                const commandCandidates = [entry.command, ...(entry.aliases || [])]
                    .filter(Boolean)
                    .map((candidate) => String(candidate).toLowerCase());
                const startsWithCommand = commandCandidates.some((candidate) => candidate.startsWith(query));
                const startsWithSegment = commandCandidates.some((candidate) => {
                    if (!searchText) {
                        return false;
                    }
                    const words = candidate.replace(/^\//, '').split(/[\s/-]+/).filter(Boolean);
                    return words.some((word) => word.startsWith(searchText));
                });

                if (!startsWithCommand && !startsWithSegment) {
                    return null;
                }

                let score = 0;
                if (commandCandidates.some((candidate) => candidate === query)) score += 40;
                if (startsWithCommand) score += 30;
                if (entry.featured) score += 8;
                if (startsWithSegment) score += 4;
                return { entry, score };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score || a.entry.command.localeCompare(b.entry.command))
            .map((match) => match.entry);

        return matches.slice(0, 10);
    }

    setCommandInputValue(value = '', options = {}) {
        if (!this.commandInput) {
            return;
        }

        this.commandInput.value = value;
        this.commandInput.focus();
        const cursor = Number.isFinite(options.cursor)
            ? Math.max(0, Math.min(value.length, options.cursor))
            : value.length;
        if (typeof this.commandInput.setSelectionRange === 'function') {
            this.commandInput.setSelectionRange(cursor, cursor);
        }
    }

    activateCommandEntry(command, options = {}) {
        const entry = command || null;
        if (!entry) {
            return;
        }

        if (entry.id === 'ask') {
            this.setActiveVoxelTool('chat');
            this.setCommandInputValue('');
            this.updateCommandAssist(entry, { activated: true });
            this.hideAutocomplete();
            return;
        }

        const value = String(options.value || entry.template || `${entry.command} `);
        this.setCommandInputValue(value);
        this.hideAutocomplete();
        this.updateCommandAssist(entry, { activated: true });

        const shouldSubmit = options.submit === true && !entry.requiresInput;
        if (shouldSubmit) {
            this.sendCommand();
        }
    }

    useCommandSuggestion(command = '', options = {}) {
        const normalized = String(command || '').trim();
        if (!normalized || !this.commandInput) {
            return;
        }

        const entry = this.getCommandEntry(normalized) || {
            id: normalized,
            command: normalized,
            label: normalized,
            icon: '/',
            description: 'CLI command',
            template: normalized,
        };
        this.activateCommandEntry(entry, {
            ...options,
            value: normalized,
        });
    }

    useHelpCommandButton(button = null) {
        const rawValue = String(button?.dataset?.commandValue || '');
        if (!rawValue) {
            return;
        }

        const entry = this.getCommandEntry(rawValue) || this.commandCatalog.find((command) => command.id === button.dataset.commandId);
        this.activateCommandEntry(entry || {
            id: rawValue,
            command: rawValue,
            label: rawValue,
            description: 'CLI command',
            template: rawValue,
        }, {
            value: rawValue,
            source: 'help',
        });
        this.roamVoxelPet('prompt', 'guard', 1000, { thought: 'command staged' });
    }

    async openCliMenuButton(button = null) {
        const view = String(button?.dataset?.menuView || '').trim();
        const value = String(button?.dataset?.menuValue || '').trim();
        if (!view) {
            return;
        }
        await this.navigateCliMenu(view, value, { push: true });
    }

    async navigateCliMenu(view = 'root', value = '', options = {}) {
        const spec = {
            view: String(view || 'root'),
            value: String(value || ''),
        };

        if (options.push && this.cliMenuCurrentView) {
            const current = this.cliMenuCurrentView;
            if (current.view !== spec.view || current.value !== spec.value) {
                this.cliMenuBackStack.push(current);
            }
        }
        if (options.reset) {
            this.cliMenuBackStack = [];
        }

        this.cliMenuCurrentView = spec;

        switch (spec.view) {
            case 'root':
                this.printHelp({ resetNavigation: options.reset === true });
                break;
            case 'category':
                this.printHelpCategory(spec.value);
                break;
            case 'command':
                await this.printCommandMenuPanel(spec.value);
                break;
            case 'tools':
                await this.listTools(spec.value || null, { menu: true });
                break;
            case 'tool-help':
                await this.showToolHelp([spec.value], { menu: true });
                break;
            case 'tool-run':
                await this.printToolRunPanel(spec.value);
                break;
            case 'skills':
                await this.listSkills(spec.value, { menu: true });
                break;
            case 'skill':
                await this.showSkill([spec.value], { menu: true });
                break;
            case 'skill-use':
                await this.printSkillUsePanel(spec.value);
                break;
            default:
                this.printHelp({ resetNavigation: options.reset === true });
        }
    }

    async goBackCliMenu() {
        const previous = this.cliMenuBackStack.pop();
        if (!previous) {
            await this.navigateCliMenu('root', '', { reset: true });
            return;
        }
        await this.navigateCliMenu(previous.view, previous.value, { push: false });
    }

    async goHomeCliMenu() {
        await this.navigateCliMenu('root', '', { reset: true });
    }

    clearCliMenuPanels() {
        if (!this.terminalOutput) {
            return;
        }
        this.terminalOutput
            .querySelectorAll('.line-output.ai.cli-interactive-menu-line')
            .forEach((line) => line.remove());
    }

    renderCliMenuNavMarkup() {
        const canGoBack = this.cliMenuBackStack.length > 0;
        return `
            <div class="cli-menu-nav" aria-label="Help menu navigation">
                <button type="button" onclick="app.goBackCliMenu()"${canGoBack ? '' : ' disabled'} title="Back">Back</button>
                <button type="button" onclick="app.goHomeCliMenu()" title="Command home">Home</button>
            </div>
        `;
    }

    printCliMenuPanel(title = 'CLI Menu', body = '', options = {}) {
        this.clearCliMenuPanels();
        const line = document.createElement('div');
        line.className = 'line line-output ai cli-interactive-menu-line';
        const meta = options.meta || 'interactive menu';
        const navMarkup = this.renderCliMenuNavMarkup();
        if (this.theme === 'voxel') {
            line.innerHTML = `
                <div class="voxel-response-head">
                    <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>${this.escapeHtml(title)}</span>
                    <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                    <span class="voxel-response-meta">${this.escapeHtml(meta)}</span>
                </div>
                <div class="voxel-response-body">
                    ${navMarkup}
                    ${body}
                </div>
            `;
        } else {
            line.innerHTML = `
                <div class="cli-response-shell">
                    <div class="cli-response-head">
                        <button type="button" class="ai-response-toggle" onclick="app.toggleAIResponse(this)" title="Collapse response" aria-label="Collapse response" aria-expanded="true">v</button>
                        <span class="cli-response-title">${this.escapeHtml(title)}</span>
                    </div>
                    <div class="cli-response-body">
                        ${navMarkup}
                        ${body}
                    </div>
                </div>
            `;
        }
        this.terminalOutput.appendChild(line);
        this.finishAIContentLine(line);
        this.scrollToBottom();
        return line;
    }

    getCommandPrefix(command = {}) {
        const template = String(command.template || command.command || '').trimEnd();
        return template || String(command.command || '').trim();
    }

    getCommandMenuTarget(command = {}) {
        const id = String(command.id || '').trim();
        if (id === 'tools' || id === 'tool-help') {
            return { view: 'tools', value: '' };
        }
        if (id === 'tool') {
            return { view: 'tools', value: '' };
        }
        if (id === 'skills' || id === 'skill') {
            return { view: 'skills', value: '' };
        }
        return { view: 'command', value: id || command.command || '' };
    }

    getCommandFormPlaceholder(command = {}) {
        const id = String(command.id || '').trim();
        if (id === 'image') {
            return 'A crisp product photo of a tiny solar-powered workshop, warm natural light...';
        }
        if (id === 'remote-agent') {
            return 'Inspect and fix the production issue, then run focused verification...';
        }
        if (id === 'sandbox') {
            return 'html {"files":{"index.html":"..."}}';
        }
        if (id === 'canvas') {
            return 'document Create a release-readiness brief for...';
        }
        return command.arguments || 'details';
    }

    async printCommandMenuPanel(commandId = '') {
        const command = this.commandCatalog.find((entry) => {
            const id = String(entry.id || '');
            const commandText = String(entry.command || '').replace(/^\//, '');
            return id === commandId || entry.command === commandId || commandText === commandId;
        });

        if (!command) {
            this.printWarning(`Command not found: ${commandId}`);
            return;
        }

        const target = this.getCommandMenuTarget(command);
        if (target.view !== 'command') {
            await this.navigateCliMenu(target.view, target.value, { push: false });
            return;
        }

        const prefix = this.getCommandPrefix(command);
        const needsDetails = Boolean(command.requiresInput || command.arguments);
        const detailControl = needsDetails ? `
            <form class="cli-menu-form" data-command-prefix="${this.escapeHtmlAttr(prefix)}" onsubmit="app.runCliMenuCommandForm(this); return false;">
                <label>
                    <span>${this.escapeHtml(command.arguments || 'Details')}</span>
                    <textarea name="details" rows="3" placeholder="${this.escapeHtmlAttr(this.getCommandFormPlaceholder(command))}"></textarea>
                </label>
                <div class="cli-menu-actions">
                    <button type="submit">Run</button>
                    <button type="button" onclick="app.stageCliMenuCommandForm(this)">Stage</button>
                </div>
            </form>
        ` : `
            <div class="cli-menu-actions">
                <button type="button" onclick="app.runCliMenuCommandText('${this.escapeHtmlAttr(prefix)}')">Run ${this.escapeHtml(command.command)}</button>
                <button type="button" onclick="app.stageCliMenuCommandText('${this.escapeHtmlAttr(prefix)}')">Stage</button>
            </div>
        `;

        const body = `
            <div class="cli-menu-panel">
                <div class="cli-menu-panel__intro">
                    <span class="cli-menu-panel__icon">${this.escapeHtml(command.icon || '/')}</span>
                    <div>
                        <strong>${this.escapeHtml(command.label || command.command)}</strong>
                        <code>${this.escapeHtml(command.command)}</code>
                        <p>${this.escapeHtml(command.description || 'CLI command')}</p>
                    </div>
                </div>
                ${detailControl}
            </div>
        `;
        this.printCliMenuPanel(command.label || command.command, body, { meta: 'command runner' });
    }

    getCommandFromMenuForm(form = null) {
        const commandPrefix = String(form?.dataset?.commandPrefix || '').trimEnd();
        const details = String(form?.querySelector?.('[name="details"]')?.value || '').trim();
        if (!commandPrefix) {
            return details;
        }
        return details ? `${commandPrefix} ${details}` : commandPrefix;
    }

    runCliMenuCommandForm(form = null) {
        this.runCliMenuCommandText(this.getCommandFromMenuForm(form));
    }

    stageCliMenuCommandForm(button = null) {
        const form = button?.closest?.('form');
        this.stageCliMenuCommandText(this.getCommandFromMenuForm(form));
    }

    runCliMenuCommandText(command = '') {
        const normalized = String(command || '').trim();
        if (!normalized) {
            return;
        }
        this.clearCliMenuPanels();
        this.setCommandInputValue(normalized);
        this.sendCommand();
    }

    stageCliMenuCommandText(command = '') {
        const normalized = String(command || '').trim();
        if (!normalized) {
            return;
        }
        this.setCommandInputValue(normalized);
        this.updateCommandAssist(this.getCommandEntry(normalized), { activated: true });
        this.roamVoxelPet('prompt', 'guard', 1000, { thought: 'command staged' });
    }

    rememberToolCatalog(tools = []) {
        tools.forEach((tool) => {
            if (tool?.id) {
                this.toolCatalogById.set(tool.id, tool);
            }
        });
    }

    async getToolCatalogEntry(toolId = '') {
        const normalizedToolId = String(toolId || '').trim();
        if (!normalizedToolId) {
            return null;
        }
        if (this.toolCatalogById.has(normalizedToolId)) {
            return this.toolCatalogById.get(normalizedToolId);
        }
        const response = await api.getAvailableTools(null);
        const tools = Array.isArray(response) ? response : (response.tools || []);
        this.rememberToolCatalog(tools);
        return this.toolCatalogById.get(normalizedToolId) || null;
    }

    renderToolCategoryChips(tools = [], activeCategory = '') {
        const categories = [...new Set(tools.map((tool) => tool.category).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b));
        if (!categories.length) {
            return '';
        }
        return `
            <div class="cli-menu-chip-row" aria-label="Tool categories">
                <button type="button" class="${activeCategory ? '' : 'is-active'}" aria-pressed="${activeCategory ? 'false' : 'true'}" data-menu-view="tools" data-menu-value="" onclick="app.openCliMenuButton(this)">All</button>
                ${categories.map((category) => `
                    <button
                        type="button"
                        class="${category === activeCategory ? 'is-active' : ''}"
                        aria-pressed="${category === activeCategory ? 'true' : 'false'}"
                        data-menu-view="tools"
                        data-menu-value="${this.escapeHtmlAttr(category)}"
                        onclick="app.openCliMenuButton(this)"
                    >${this.escapeHtml(category)}</button>
                `).join('')}
            </div>
        `;
    }

    renderToolsMenu(tools = [], meta = {}, activeCategory = '') {
        const runtime = meta?.runtime || null;
        const runtimeMarkup = runtime ? `
            <div class="cli-menu-runtime">
                <span>Runtime</span>
                <strong>${this.escapeHtml(runtime.source || 'backend')}</strong>
                <span>${this.escapeHtml(runtime.modelGateway?.baseURL || 'tool gateway')}</span>
            </div>
        ` : '';
        const cards = tools.map((tool) => {
            const params = Array.isArray(tool.parameters)
                ? tool.parameters.map((param) => typeof param === 'string' ? param : param.name).filter(Boolean)
                : Object.keys(tool.inputSchema?.properties || {});
            return `
                <article class="cli-menu-card">
                    <div class="cli-menu-card__main">
                        <div class="cli-menu-card__top">
                            <code>${this.escapeHtml(tool.id || 'tool')}</code>
                            <strong>${this.escapeHtml(tool.name || tool.label || tool.id || 'Tool')}</strong>
                        </div>
                        <p>${this.escapeHtml(tool.description || 'No description provided.')}</p>
                        <div class="cli-menu-card__meta">
                            ${tool.category ? `<span>${this.escapeHtml(tool.category)}</span>` : ''}
                            ${tool.support?.status ? `<span>${this.escapeHtml(tool.support.status)}</span>` : ''}
                            ${params.length ? `<span>${this.escapeHtml(params.slice(0, 5).join(', '))}</span>` : ''}
                        </div>
                    </div>
                    <div class="cli-menu-card__actions">
                        <button type="button" data-menu-view="tool-run" data-menu-value="${this.escapeHtmlAttr(tool.id)}" onclick="app.openCliMenuButton(this)">Run</button>
                        <button type="button" data-menu-view="tool-help" data-menu-value="${this.escapeHtmlAttr(tool.id)}" onclick="app.openCliMenuButton(this)">Help</button>
                    </div>
                </article>
            `;
        }).join('');

        return `
            <div class="cli-menu-panel">
                <div class="cli-menu-panel__intro">
                    <span class="cli-menu-panel__icon">T</span>
                    <div>
                        <strong>Backend Tools</strong>
                        <p>Choose a tool, inspect its docs, or open a parameter form without retyping slash commands.</p>
                    </div>
                </div>
                ${runtimeMarkup}
                ${this.renderToolCategoryChips(tools, activeCategory)}
                <div class="cli-menu-card-list">${cards}</div>
            </div>
        `;
    }

    getToolPropertyEntries(tool = {}) {
        const properties = tool.inputSchema?.properties || {};
        const schemaEntries = Object.entries(properties);
        if (schemaEntries.length) {
            return schemaEntries.map(([name, schema]) => [name, schema || {}]);
        }

        const parameters = Array.isArray(tool.parameters) ? tool.parameters : [];
        return parameters
            .map((param) => {
                if (typeof param === 'string') {
                    return [param, { type: 'string' }];
                }
                return [param?.name, param || {}];
            })
            .filter(([name]) => Boolean(name));
    }

    normalizeToolFieldSchema(schema = {}) {
        const source = schema && typeof schema === 'object' ? schema : {};
        const typeOptions = Array.isArray(source.type)
            ? source.type
                .map((value) => String(value || '').trim().toLowerCase())
                .filter((value) => value && value !== 'null')
            : [];
        if (typeOptions.includes('string') && (typeOptions.includes('object') || typeOptions.includes('array'))) {
            return {
                ...source,
                type: typeOptions.includes('object') ? 'json-or-string' : 'array-or-string',
            };
        }
        const directType = typeOptions.length ? typeOptions[0] : source.type;
        if (directType) {
            return { ...source, type: String(directType).toLowerCase() };
        }

        const composite = ['oneOf', 'anyOf', 'allOf']
            .flatMap((key) => Array.isArray(source[key]) ? source[key] : [])
            .find((candidate) => candidate && typeof candidate === 'object' && candidate.type);
        if (composite) {
            return this.normalizeToolFieldSchema({ ...composite, ...source, type: composite.type });
        }

        if (source.properties && typeof source.properties === 'object') {
            return { ...source, type: 'object' };
        }
        if (source.items && typeof source.items === 'object') {
            return { ...source, type: 'array' };
        }
        return { ...source, type: 'string' };
    }

    renderToolField(name = '', schema = {}, required = false) {
        schema = this.normalizeToolFieldSchema(schema);
        const type = String(schema.type || 'string').toLowerCase();
        const description = schema.description || schema.title || '';
        const requiredAttr = required ? ' required' : '';
        const hasDefault = schema.default != null;
        const defaultValue = hasDefault && (
            type === 'object'
            || type === 'array'
            || (type === 'json-or-string' && schema.default && typeof schema.default === 'object')
            || (type === 'array-or-string' && Array.isArray(schema.default))
        )
            ? JSON.stringify(schema.default, null, 2)
            : (hasDefault ? String(schema.default) : '');
        const placeholder = type === 'json-or-string'
            ? 'string or JSON object'
            : (type === 'array-or-string'
                ? 'string or JSON array'
                : (name === 'prompt' ? 'Describe the result you want...' : type));
        if (Array.isArray(schema.enum) && schema.enum.length) {
            const defaultValue = schema.default != null
                ? String(schema.default)
                : (required ? String(schema.enum[0]) : '');
            const options = schema.enum.map((value) => {
                const stringValue = String(value);
                return `<option value="${this.escapeHtmlAttr(stringValue)}"${stringValue === defaultValue ? ' selected' : ''}>${this.escapeHtml(stringValue)}</option>`;
            }).join('');
            return `
                <label class="cli-menu-field">
                    <span>${this.escapeHtml(name)}${required ? ' *' : ''}</span>
                    <select data-tool-param="${this.escapeHtmlAttr(name)}" data-tool-type="${this.escapeHtmlAttr(type)}" data-tool-required="${required ? 'true' : 'false'}"${requiredAttr}>
                        ${required ? '' : '<option value="">Optional</option>'}
                        ${options}
                    </select>
                    ${description ? `<small>${this.escapeHtml(description)}</small>` : ''}
                </label>
            `;
        }
        if (type === 'object' || type === 'array' || type === 'json-or-string' || type === 'array-or-string') {
            const jsonPlaceholder = type === 'array' || type === 'array-or-string' ? '["value"]' : (type === 'json-or-string' ? 'string or {"key":"value"}' : '{"key":"value"}');
            return `
                <label class="cli-menu-field">
                    <span>${this.escapeHtml(name)}${required ? ' *' : ''}</span>
                    <textarea rows="4" data-tool-param="${this.escapeHtmlAttr(name)}" data-tool-type="${this.escapeHtmlAttr(type)}" data-tool-required="${required ? 'true' : 'false'}" placeholder="${this.escapeHtmlAttr(jsonPlaceholder)}"${requiredAttr}>${hasDefault ? this.escapeHtml(defaultValue) : ''}</textarea>
                    ${description ? `<small>${this.escapeHtml(description)}</small>` : ''}
                </label>
            `;
        }
        if (type === 'boolean') {
            const checkedAttr = schema.default === true ? ' checked' : '';
            return `
                <label class="cli-menu-field cli-menu-field--checkbox">
                    <input type="checkbox" data-tool-param="${this.escapeHtmlAttr(name)}" data-tool-type="${this.escapeHtmlAttr(type)}" data-tool-required="${required ? 'true' : 'false'}"${checkedAttr}>
                    <span>${this.escapeHtml(name)}${required ? ' *' : ''}</span>
                </label>
            `;
        }
        const tag = /prompt|content|body|command|query|text|task/i.test(name) ? 'textarea' : 'input';
        const integerStepAttr = type === 'integer' ? ' step="1"' : '';
        const control = tag === 'textarea'
            ? `<textarea rows="3" data-tool-param="${this.escapeHtmlAttr(name)}" data-tool-type="${this.escapeHtmlAttr(type)}" data-tool-required="${required ? 'true' : 'false'}" placeholder="${this.escapeHtmlAttr(placeholder)}"${requiredAttr}>${hasDefault ? this.escapeHtml(defaultValue) : ''}</textarea>`
            : `<input type="${type === 'number' || type === 'integer' ? 'number' : 'text'}" data-tool-param="${this.escapeHtmlAttr(name)}" data-tool-type="${this.escapeHtmlAttr(type)}" data-tool-required="${required ? 'true' : 'false'}" placeholder="${this.escapeHtmlAttr(placeholder)}"${integerStepAttr}${hasDefault ? ` value="${this.escapeHtmlAttr(defaultValue)}"` : ''}${requiredAttr}>`;
        return `
            <label class="cli-menu-field">
                <span>${this.escapeHtml(name)}${required ? ' *' : ''}</span>
                ${control}
                ${description ? `<small>${this.escapeHtml(description)}</small>` : ''}
            </label>
        `;
    }

    async printToolRunPanel(toolId = '') {
        const tool = await this.getToolCatalogEntry(toolId);
        if (!tool) {
            this.printWarning(`Tool not found: ${toolId}`);
            return;
        }

        const required = new Set(tool.inputSchema?.required || []);
        const fields = this.getToolPropertyEntries(tool);
        const fieldMarkup = fields.length
            ? fields.map(([name, schema]) => this.renderToolField(name, schema, required.has(name))).join('')
            : `
                <label class="cli-menu-field">
                    <span>JSON parameters</span>
                    <textarea rows="5" name="jsonParams" placeholder='{"query":"..."}'></textarea>
                    <small>This tool did not publish a parameter schema.</small>
                </label>
            `;
        const body = `
            <div class="cli-menu-panel">
                <div class="cli-menu-panel__intro">
                    <span class="cli-menu-panel__icon">TX</span>
                    <div>
                        <strong>${this.escapeHtml(tool.name || tool.id)}</strong>
                        <code>${this.escapeHtml(tool.id)}</code>
                        <p>${this.escapeHtml(tool.description || 'Run this backend tool.')}</p>
                    </div>
                </div>
                <form class="cli-menu-form" data-tool-id="${this.escapeHtmlAttr(tool.id)}" onsubmit="app.runToolMenuForm(this); return false;">
                    ${fieldMarkup}
                    <div class="cli-menu-actions">
                        <button type="submit">Run Tool</button>
                        <button type="button" onclick="app.stageToolMenuForm(this)">Stage /tool</button>
                    </div>
                </form>
            </div>
        `;
        this.printCliMenuPanel(`Run Tool: ${tool.id}`, body, { meta: 'tool runner' });
    }

    collectToolMenuFormParams(form = null) {
        const jsonParams = form?.querySelector?.('[name="jsonParams"]');
        if (jsonParams) {
            const rawJson = String(jsonParams.value || '').trim();
            return rawJson ? JSON.parse(rawJson) : {};
        }

        const params = {};
        form?.querySelectorAll?.('[data-tool-param]').forEach((field) => {
            const name = field.dataset.toolParam;
            const type = String(field.dataset.toolType || 'string').toLowerCase();
            const isRequired = field.dataset.toolRequired === 'true';
            if (field.type === 'checkbox' && !field.checked && !isRequired) {
                return;
            }
            let value = field.type === 'checkbox' ? field.checked : String(field.value || '').trim();
            if (value === '' && field.type !== 'checkbox') {
                return;
            }
            if (type === 'number' || type === 'integer') {
                value = Number(value);
                if (!Number.isFinite(value)) {
                    throw new Error(`${name} must be a valid number`);
                }
                if (type === 'integer' && !Number.isInteger(value)) {
                    throw new Error(`${name} must be an integer`);
                }
            } else if (type === 'object' || type === 'array') {
                value = JSON.parse(value);
                if (type === 'array' && !Array.isArray(value)) {
                    throw new Error(`${name} must be a JSON array`);
                }
                if (type === 'object' && (!value || Array.isArray(value) || typeof value !== 'object')) {
                    throw new Error(`${name} must be a JSON object`);
                }
            } else if (type === 'json-or-string' || type === 'array-or-string') {
                if (/^[\[{]/.test(value)) {
                    value = JSON.parse(value);
                    if (type === 'json-or-string' && (!value || Array.isArray(value) || typeof value !== 'object')) {
                        throw new Error(`${name} must be plain text or a JSON object`);
                    }
                    if (type === 'array-or-string' && !Array.isArray(value)) {
                        throw new Error(`${name} must be plain text or a JSON array`);
                    }
                }
            }
            params[name] = value;
        });
        return params;
    }

    async runToolMenuForm(form = null) {
        const toolId = String(form?.dataset?.toolId || '').trim();
        if (!toolId) {
            return;
        }
        let params = {};
        try {
            params = this.collectToolMenuFormParams(form);
        } catch (error) {
            this.printError(`Invalid tool parameters: ${error.message}`);
            return;
        }
        this.clearCliMenuPanels();
        await this.invokeToolCommand([toolId, JSON.stringify(params)]);
    }

    stageToolMenuForm(button = null) {
        const form = button?.closest?.('form');
        const toolId = String(form?.dataset?.toolId || '').trim();
        if (!toolId) {
            return;
        }
        try {
            const params = this.collectToolMenuFormParams(form);
            this.stageCliMenuCommandText(`/tool ${toolId} ${JSON.stringify(params)}`);
        } catch (error) {
            this.printError(`Invalid tool parameters: ${error.message}`);
        }
    }

    rememberSkillCatalog(skills = []) {
        skills.forEach((skill) => {
            if (skill?.id) {
                this.skillCatalogById.set(skill.id, skill);
            }
        });
    }

    async getSkillCatalogEntry(skillId = '') {
        const normalizedSkillId = String(skillId || '').trim();
        if (!normalizedSkillId) {
            return null;
        }
        if (this.skillCatalogById.has(normalizedSkillId)) {
            return this.skillCatalogById.get(normalizedSkillId);
        }
        const response = await api.listSkills({ search: normalizedSkillId });
        const skills = Array.isArray(response) ? response : (response.skills || []);
        this.rememberSkillCatalog(skills);
        return this.skillCatalogById.get(normalizedSkillId) || skills.find((skill) => skill.id === normalizedSkillId) || null;
    }

    renderSkillsMenu(skills = [], meta = {}, search = '') {
        const cards = skills.map((skill) => `
            <article class="cli-menu-card">
                <div class="cli-menu-card__main">
                    <div class="cli-menu-card__top">
                        <code>${this.escapeHtml(skill.id || 'skill')}</code>
                        <strong>${this.escapeHtml(skill.name || skill.id || 'Skill')}</strong>
                    </div>
                    <p>${this.escapeHtml(skill.description || 'No description provided.')}</p>
                    <div class="cli-menu-card__meta">
                        ${Array.isArray(skill.tools) && skill.tools.length ? `<span>tools: ${this.escapeHtml(skill.tools.slice(0, 4).join(', '))}</span>` : ''}
                    </div>
                </div>
                <div class="cli-menu-card__actions">
                    <button type="button" data-menu-view="skill-use" data-menu-value="${this.escapeHtmlAttr(skill.id)}" onclick="app.openCliMenuButton(this)">Use</button>
                    <button type="button" data-menu-view="skill" data-menu-value="${this.escapeHtmlAttr(skill.id)}" onclick="app.openCliMenuButton(this)">Open</button>
                </div>
            </article>
        `).join('');
        return `
            <div class="cli-menu-panel">
                <div class="cli-menu-panel__intro">
                    <span class="cli-menu-panel__icon">K</span>
                    <div>
                        <strong>Registered Skills</strong>
                        <p>Open a skill, or choose Use to fill a task prompt beside the selected skill.</p>
                    </div>
                </div>
                <form class="cli-menu-search" onsubmit="app.searchSkillsMenu(this); return false;">
                    <input name="search" value="${this.escapeHtmlAttr(search)}" placeholder="Search skills">
                    <button type="submit">Search</button>
                </form>
                ${meta.root ? `<div class="cli-menu-runtime"><span>Location</span><strong>${this.escapeHtml(meta.root)}</strong></div>` : ''}
                <div class="cli-menu-card-list">${cards}</div>
            </div>
        `;
    }

    async searchSkillsMenu(form = null) {
        const query = String(form?.querySelector?.('[name="search"]')?.value || '').trim();
        await this.navigateCliMenu('skills', query, { push: true });
    }

    async printSkillUsePanel(skillId = '') {
        const skill = await this.getSkillCatalogEntry(skillId);
        if (!skill) {
            this.printWarning(`Skill not found: ${skillId}`);
            return;
        }
        const body = `
            <div class="cli-menu-panel">
                <div class="cli-menu-panel__intro">
                    <span class="cli-menu-panel__icon">KS</span>
                    <div>
                        <strong>${this.escapeHtml(skill.name || skill.id)}</strong>
                        <code>${this.escapeHtml(skill.id)}</code>
                        <p>${this.escapeHtml(skill.description || 'Use this skill with a task prompt.')}</p>
                    </div>
                </div>
                <form class="cli-menu-form" data-skill-id="${this.escapeHtmlAttr(skill.id)}" onsubmit="app.runSkillPromptForm(this); return false;">
                    <label>
                        <span>Task prompt</span>
                        <textarea name="prompt" rows="4" placeholder="Describe what you want this skill to do..."></textarea>
                    </label>
                    <div class="cli-menu-actions">
                        <button type="submit">Run Prompt</button>
                        <button type="button" onclick="app.stageSkillPromptForm(this)">Stage Prompt</button>
                        <button type="button" onclick="app.stageCliMenuCommandText('/skill ${this.escapeHtmlAttr(skill.id)}')">Stage /skill</button>
                    </div>
                </form>
            </div>
        `;
        this.printCliMenuPanel(`Use Skill: ${skill.id}`, body, { meta: 'skill prompt' });
    }

    getSkillPromptFromForm(form = null) {
        const skillId = String(form?.dataset?.skillId || '').trim();
        const prompt = String(form?.querySelector?.('[name="prompt"]')?.value || '').trim();
        return formatWebCliSkillTaskPrompt(skillId, prompt);
    }

    runSkillPromptForm(form = null) {
        const taskPrompt = String(form?.querySelector?.('[name="prompt"]')?.value || '').trim();
        const prompt = this.getSkillPromptFromForm(form).trim();
        if (taskPrompt) {
            this.clearCliMenuPanels();
            this.setCommandInputValue(prompt);
            this.sendCommand();
            return;
        }
        this.stageCliMenuCommandText(prompt);
    }

    stageSkillPromptForm(button = null) {
        this.stageCliMenuCommandText(this.getSkillPromptFromForm(button?.closest?.('form')));
    }

    updateCommandAssist(command = null, options = {}) {
        if (!this.commandAssist) {
            return;
        }

        const input = String(this.commandInput?.value || '');
        const entry = command || this.getCommandEntry(input);
        this.commandAssist.classList.remove('is-waiting', 'is-ready', 'is-error');

        if (!entry) {
            if (input.startsWith('/')) {
                this.commandAssist.textContent = 'No exact command yet. Keep typing, press Tab, or choose from autocomplete.';
                this.commandAssist.classList.add('is-error');
            } else {
                this.commandAssist.textContent = 'Type /help for the command menu, or / for autocomplete.';
                this.commandAssist.classList.add('is-ready');
            }
            return;
        }

        const commandLabel = entry.command === 'ask' ? 'message' : entry.command;
        if (entry.requiresInput || (options.activated && entry.arguments)) {
            this.commandAssist.textContent = `${commandLabel}: add ${entry.arguments || 'details'} and press Enter.`;
            this.commandAssist.classList.add('is-waiting');
            return;
        }

        if (entry.arguments) {
            this.commandAssist.textContent = `${commandLabel}: ${entry.description} Add ${entry.arguments} or press Enter.`;
        } else {
            this.commandAssist.textContent = `${commandLabel}: ${entry.description} Press Enter to run.`;
        }
        this.commandAssist.classList.add('is-ready');
    }

    getVoxelTypingThought() {
        const name = this.voxelPet?.name?.split('-')[0] || 'Vox';
        const thoughts = [
            `${name} is listening`,
            'mapping that',
            'tiny gears on',
            'scanning...',
        ];
        return thoughts[Math.floor(Math.random() * thoughts.length)];
    }

    getVoxelAmbientThought(action = 'idle') {
        const name = this.voxelPet?.name?.split('-')[0] || 'Vox';
        const personality = this.voxelPersonality || {};
        const curious = Number(personality.curiosity || 0) > 58;
        const bonded = Number(personality.bond || 0) > 48;
        const confident = Number(personality.confidence || 0) > 54;
        const playful = Number(personality.playfulness || 0) > 52;

        const pool = [
            bonded ? `${name} is comfy here` : `${name} checks in`,
            curious ? 'what is that signal?' : 'keeping watch',
            confident ? 'systems feel steady' : 'calibrating...',
            playful || action === 'dance' ? 'little victory hop' : 'quiet cube thoughts',
        ];

        const thought = pool[Math.floor(Math.random() * pool.length)];
        this.voxelPersonality = {
            ...this.voxelPersonality,
            lastThought: thought,
        };
        this.saveVoxelPersonality();
        return thought;
    }

    shouldAttachVoxelPersona(input = '') {
        if (this.theme !== 'voxel' || this.voxelPetHidden || !this.voxelPet) {
            return false;
        }

        const text = String(input || '').toLowerCase();
        if (!text || text.startsWith('/')) {
            return false;
        }

        const hardWork = /\b(kubectl|docker|git|npm|node|test|build|deploy|commit|push|fix|debug|implement|refactor|make|create|generate|write|update|change|add|remove|design|code|page|site|html|css|javascript|file|spec|report|research|analyze|security|prod|production|tls|secret|api key)\b/.test(text);
        if (hardWork) {
            return false;
        }

        const casual = /\b(hello|hi|hey|thanks|thank you|what do you think|ideas|brainstorm|explain|why|how would|should we|help me think)\b/.test(text);
        return casual || (text.length < 90 && Math.random() < 0.35);
    }

    buildVoxelChatOptions(input = '') {
        if (!this.shouldAttachVoxelPersona(input)) {
            return {};
        }

        const pet = this.voxel.normalize(this.voxelPet);
        const mood = this.voxel.MOODS[pet.mood] || pet.mood;
        const personality = this.voxelPersonality || {};
        const systemContent = [
            'You are answering inside Lilly Voxel CLI with a visible voxel companion profile.',
            `Current companion name: ${pet.name}. Use this exact current name if the persona naturally refers to itself.`,
            `Profile: ${pet.trait} ${pet.species}, mood ${mood}, energy ${pet.energy}%, palette ${pet.palette?.name || 'custom'}, seed "${pet.prompt}".`,
            `Long-running personality: bond ${Math.round(personality.bond || 0)}%, curiosity ${Math.round(personality.curiosity || 0)}%, confidence ${Math.round(personality.confidence || 0)}%, playfulness ${Math.round(personality.playfulness || 0)}%, shared turns ${Math.round(personality.turns || 0)}.`,
            'For casual, reflective, brainstorming, or conversational replies only, lightly let the answer feel like it comes through this companion. Keep it subtle: at most one small emotional beat or one mention of the companion name.',
            'Do not apply the voxel persona to CLI agent work, tool results, code, commands, deployment steps, test output, file edits, exact specs, or safety-critical guidance. In those cases, answer normally and professionally.',
        ].join('\n');

        return {
            systemMessages: [{ role: 'system', content: systemContent }],
            metadata: {
                voxelPersona: {
                    enabled: true,
                    name: pet.name,
                    mood,
                    trait: pet.trait,
                    species: pet.species,
                },
            },
        };
    }

    pulseVoxelStreaming() {
        const now = Date.now();
        if (this.voxelPetHidden || now - (this.lastVoxelStreamPulse || 0) < 650) {
            return;
        }

        this.lastVoxelStreamPulse = now;
        const placements = ['stream', 'edge-right', 'corner-tr', 'corner-br'];
        const placement = placements[Math.floor((now / 650) % placements.length)];
        this.roamVoxelPet(placement, 'scout', placement.startsWith('corner') ? 5200 : 2200, {
            thought: Math.random() < 0.28 ? 'pixeling...' : '',
            linger: placement.startsWith('corner'),
        });
    }

    generateVoxelPet(prompt) {
        if (!this.voxel) {
            return;
        }

        const seed = String(prompt || this.voxelPetPrompt?.value || '').trim();
        if (!seed) {
            this.printWarning('Usage: /pet <prompt>');
            return;
        }

        this.voxelPet = this.voxel.generate(seed);
        this.voxelPetHidden = false;
        localStorage.setItem('codecli-voxel-pet-hidden', 'false');
        if (this.voxelPetPrompt) {
            this.voxelPetPrompt.value = seed;
        }
        this.activePetAction = 'jump';
        this.saveVoxelPet();
        this.renderVoxelPet('jump');
        this.roamVoxelPet('prompt', 'jump', 1200);
        this.printPetCard('spawned');
    }

    generateVoxelPetFromInput() {
        this.generateVoxelPet(this.voxelPetPrompt?.value || '');
    }

    focusVoxelCreator(options = {}) {
        if (this.voxelDock?.classList.contains('hidden')) {
            const activeElement = document.activeElement;
            this.voxelCreatorReturnFocus = activeElement
                && activeElement !== document.body
                && typeof activeElement.focus === 'function'
                ? activeElement
                : null;
        }
        this.setVoxelPetHidden(false);
        this.voxelDock?.classList.remove('hidden');
        this.renderVoxelPet('scout');
        this.roamVoxelPet('prompt', 'scout', 900);
        window.setTimeout(() => {
            this.voxelPetPrompt?.focus();
            this.voxelPetPrompt?.select();
        }, 0);

        if (!options.silent) {
            this.printSystem('Agent companion opened. Use Chat, Tools, or Files, or type an agent idea and press Enter for fill.');
        }
    }

    generateRandomVoxelPet(options = {}) {
        if (!this.voxel) {
            return;
        }

        this.voxelPet = typeof this.voxel.random === 'function'
            ? this.voxel.random()
            : this.voxel.generate(`random voxel companion ${Date.now()}`);
        this.voxelPetHidden = false;
        localStorage.setItem('codecli-voxel-pet-hidden', 'false');
        if (this.voxelPetPrompt) {
            this.voxelPetPrompt.value = this.voxelPet.prompt;
        }
        this.activePetAction = 'dance';
        this.saveVoxelPet();
        this.renderVoxelPet('dance');
        this.roamVoxelPet('prompt', 'dance', 1300);

        if (!options.silent) {
            this.printPetCard('randomized');
        }
    }

    async generateAIVoxelPetFromInput() {
        await this.generateAIVoxelAgent(this.voxelPetPrompt?.value || 'random helpful voxel terminal agent');
    }

    buildVoxelAgentPrompt(prompt) {
        const promptJson = JSON.stringify(prompt);
        return `Create one compact 3D voxel terminal companion for this user prompt: ${promptJson}.

Return JSON only. No markdown, no prose.
Use this exact shape:
{
  "name": "short agent name",
  "species": "fox|cat|dog|dragon|owl|bot|rabbit|panda|lizard|turtle",
  "trait": "scout|builder|guardian|spark|mapper|scribe|tinker|pilot|forager|warden",
  "palette": {
    "name": "two word palette name",
    "primary": "#49d3a7",
    "secondary": "#f4c95d",
    "accent": "#ff6f91"
  },
  "ears": "point|round|antenna|crest",
  "tail": "stub|curl|saber|spark",
  "eyes": "round|bright|sleepy|scan",
  "mood": "ready|curious|thinking|proud|sleepy|alert|playful",
  "energy": 82,
  "prompt": ${promptJson}
}`;
    }

    extractJsonObject(text = '') {
        const cleaned = String(text || '')
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .trim();

        try {
            return JSON.parse(cleaned);
        } catch (_error) {
            const start = cleaned.indexOf('{');
            const end = cleaned.lastIndexOf('}');
            if (start >= 0 && end > start) {
                return JSON.parse(cleaned.slice(start, end + 1));
            }
            throw new Error('AI did not return a JSON object');
        }
    }

    async generateAIVoxelAgent(prompt) {
        if (!this.voxel) {
            return;
        }

        if (this.isProcessing) {
            this.printWarning('Already processing. Please wait...');
            return;
        }

        const seed = String(prompt || this.voxelPetPrompt?.value || 'random helpful voxel terminal agent').trim()
            || 'random helpful voxel terminal agent';
        this.isProcessing = true;
        this.setStatus('thinking');
        this.reactVoxelPet(seed, 'think');
        this.printSystem(`Asking AI for voxel agent spec: ${seed}`);

        try {
            const response = await api.sendMessage(this.buildVoxelAgentPrompt(seed));
            const spec = this.extractJsonObject(response.content || '');
            this.voxelPet = typeof this.voxel.fromSpec === 'function'
                ? this.voxel.fromSpec(spec, seed)
                : this.voxel.generate(seed);
            this.voxelPetHidden = false;
            localStorage.setItem('codecli-voxel-pet-hidden', 'false');
            if (this.voxelPetPrompt) {
                this.voxelPetPrompt.value = this.voxelPet.prompt;
            }
            this.activePetAction = 'jump';
            this.saveVoxelPet();
            this.renderVoxelPet('jump');
            this.roamVoxelPet('prompt', 'jump', 1200);
            this.printPetCard('AI-filled');
            this.setStatus('ready');
        } catch (error) {
            this.printError(`Agent companion failed: ${error.message}`);
            this.handlePetAction('guard', { silent: true });
            this.setStatus('error');
        } finally {
            this.isProcessing = false;
            this.processQueue();
        }
    }

    async handlePetCommand(args = []) {
        const subcommand = String(args[0] || '').toLowerCase();
        const rest = args.slice(1).join(' ').trim();

        if (!subcommand) {
            this.printPetCard();
            return;
        }

        if (['new', 'make', 'generate', 'spawn'].includes(subcommand)) {
            this.generateVoxelPet(rest);
            return;
        }

        if (subcommand === 'random') {
            this.generateRandomVoxelPet();
            return;
        }

        if (['ai', 'agent', 'fill', 'design'].includes(subcommand)) {
            await this.generateAIVoxelAgent(rest || this.voxelPetPrompt?.value || 'random helpful voxel terminal agent');
            return;
        }

        if (subcommand === 'act') {
            this.handlePetAction(rest || 'jump');
            return;
        }

        if (subcommand === 'name') {
            if (!rest) {
                this.printWarning('Usage: /pet name <name>');
                return;
            }
            this.voxelPet = { ...this.voxelPet, name: rest.slice(0, 28) };
            this.saveVoxelPet();
            this.renderVoxelPet('scout');
            this.printPetCard('renamed');
            return;
        }

        if (subcommand === 'hide') {
            this.setVoxelPetHidden(true);
            this.printSystem('Voxel companion hidden. Use /pet show to restore it.');
            return;
        }

        if (subcommand === 'show') {
            this.setVoxelPetHidden(false);
            this.focusVoxelCreator({ silent: true });
            this.renderVoxelPet('jump');
            this.printPetCard();
            return;
        }

        if (subcommand === 'help') {
            this.printAI(`## Voxel Pet Commands

  /pet <prompt>          Spawn a prompt-generated voxel pet
  /pet random            Spawn a random voxel character
  /pet ai <prompt>       Ask AI for a voxel agent spec
  /pet act <action>      Run jump, dance, scout, guard, or sleep
  /pet name <name>       Rename the active pet
  /pet show              Open the pet creator
  /pet hide              Hide the prompt companion
  /agent <prompt>        Same AI-backed voxel agent generator

The pet reacts to prompts while chat responses stream.`);
            return;
        }

        this.generateVoxelPet(args.join(' '));
    }

    handlePetAction(action = 'ready', options = {}) {
        if (!this.voxel || !this.voxelPet) {
            return;
        }

        const normalizedAction = String(action || 'ready').trim().toLowerCase();
        this.voxelPet = this.voxel.mutate(this.voxelPet, normalizedAction);
        this.activePetAction = normalizedAction === 'nap' ? 'sleep' : normalizedAction;
        this.saveVoxelPet();
        this.renderVoxelPet(this.activePetAction);
        this.roamVoxelPet('prompt', this.activePetAction, 1100);

        if (!options.silent) {
            this.printSystem(`${this.voxelPet.name} ${this.voxelPet.lastAction}.`);
        }
    }

    reactVoxelPet(input = '', fallbackAction = 'ready') {
        if (!this.voxel || !this.voxelPet) {
            return;
        }

        this.voxelPet = fallbackAction && fallbackAction !== 'auto'
            ? this.voxel.mutate(this.voxelPet, fallbackAction)
            : this.voxel.reactToText(this.voxelPet, input);
        const moodAction = {
            sleepy: 'sleep',
            playful: 'dance',
            thinking: 'scout',
            proud: 'jump',
            alert: 'guard',
            curious: 'scout',
        };
        this.activePetAction = moodAction[this.voxelPet.mood] || 'idle';
        this.saveVoxelPet();
        this.renderVoxelPet(this.activePetAction);
        this.roamVoxelPet(this.activePetAction === 'jump' ? 'prompt' : 'stream', this.activePetAction, 1200);
    }

    printPetCard(eventLabel = 'status') {
        if (!this.voxelPet) {
            return;
        }

        const mood = this.voxel?.MOODS?.[this.voxelPet.mood] || this.voxelPet.mood;
        this.printAI(`## ${this.voxelPet.name}

${this.voxelPet.trait} ${this.voxelPet.species} | ${this.voxelPet.palette.name} | ${eventLabel}

- Mood: ${mood}
- Energy: ${this.voxelPet.energy}%
- Seed: ${this.voxelPet.prompt}
- Last action: ${this.voxelPet.lastAction || 'ready'}`);
    }
    
    // ==================== Command Processing ====================
    
    async sendCommand() {
        const input = this.commandInput.value.trim();
        if (!input) return;
        this.commandInput.value = '';
        this.hideAutocomplete();

        if (this.sessionRestorePromise) {
            await this.sessionRestorePromise;
        }
        
        // Add to history
        this.history.push(input);
        this.historyIndex = this.history.length;
        this.saveCommandHistory();
        
        // Print input
        this.printInput(input);
        this.roamVoxelPet(input.startsWith('/') ? 'edge-left' : 'prompt', input.startsWith('/') ? 'guard' : 'scout', 1800, {
            thought: input.startsWith('/') ? 'command seen' : 'on it',
        });
        
        // If currently processing, queue the command
        if (this.isProcessing) {
            this.commandQueue.push(input);
            this.updateQueueDisplay();
            this.printSystem(`Queued: ${input.substring(0, 50)}${input.length > 50 ? '...' : ''}`);
            return;
        }
        
        // Process immediately
        await this.processCommandItem(input);
    }
    
    async processCommandItem(input) {
        // Process command
        if (input.startsWith('/')) {
            await this.processCommand(input);
        } else {
            await this.processQuery(input);
        }
        
        // Process next queued command if any
        this.processQueue();
    }
    
    async processQueue() {
        if (this.isProcessingQueue || this.commandQueue.length === 0) return;
        
        this.isProcessingQueue = true;
        
        while (this.commandQueue.length > 0 && !this.isProcessing) {
            const nextCommand = this.commandQueue.shift();
            this.updateQueueDisplay();
            this.printSystem(`Running queued: ${nextCommand.substring(0, 50)}${nextCommand.length > 50 ? '...' : ''}`);
            await this.processCommandItem(nextCommand);
        }
        
        this.isProcessingQueue = false;
    }
    
    updateQueueDisplay() {
        const count = this.commandQueue.length;
        
        // Update indicator only (side panel removed)
        if (this.queueIndicator) {
            this.queueIndicator.textContent = count;
            const queueLabel = count === 1 ? '1 command queued' : `${count} commands queued`;
            this.queueIndicator.setAttribute('aria-label', queueLabel);
            this.queueIndicator.setAttribute('title', queueLabel);
            this.queueIndicator.classList.toggle('hidden', count === 0);
        }
    }
    
    async processCommand(input) {
        const parts = input.slice(1).split(' ');
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        
        switch (cmd) {
            case 'help':
            case '?':
                this.printHelp();
                break;
            case 'clear':
            case 'cls':
                this.clearOutput();
                break;
            case 'new':
                await this.startNewSession(args.join(' '));
                break;
            case 'sessions':
                await this.listSessions();
                break;
            case 'switch':
                await this.switchSession(args[0]);
                break;
            case 'delete':
            case 'del':
            case 'rm':
                await this.deleteSession(args[0]);
                break;
            case 'models':
                await this.listModels();
                break;
            case 'model':
                if (args[0]) {
                    api.setModel(args[0]);
                    // Reload models to update dropdown then sync selection
                    await this.loadModels();
                    this.updateModelInfo();
                    this.printSystem(`Model set to: ${args[0]}`);
                } else {
                    this.printSystem(`Current model: ${api.currentModel || 'default'}`);
                }
                break;
            case 'tts':
                await this.handleTtsCommand(args);
                break;
            case 'voice':
                await this.handleVoiceCommand(args);
                break;
            case 'theme':
                if (args[0]) {
                    const themeArg = String(args[0] || '').toLowerCase();
                    if (['list', 'themes', 'help'].includes(themeArg)) {
                        this.printThemeList();
                    } else {
                        this.setTheme(args[0]);
                    }
                } else {
                    this.cycleTheme();
                }
                break;
            case 'density':
            case 'compact':
                if (args[0]) {
                    this.setDensity(args[0]);
                } else {
                    this.cycleDensity();
                }
                break;
            case 'enterprise':
            case 'workmode':
            case 'professional':
                this.applyEnterpriseMode();
                this.printOperationalStatus();
                break;
            case 'status':
                this.printOperationalStatus();
                break;
            case 'brief':
            case 'handoff':
            case 'summary':
                this.printSessionBrief();
                break;
            case 'next':
            case 'next-actions':
            case 'todo':
                this.printSessionNextActions();
                break;
            case 'audit':
            case 'activity':
            case 'trail':
                this.printSessionAudit();
                break;
            case 'packet':
            case 'handoff-packet':
            case 'continue':
                this.printSessionPacket();
                break;
            case 'register':
            case 'decisions':
            case 'risks':
                this.printSessionRegister();
                break;
            case 'gates':
            case 'quality':
            case 'readiness':
                this.printSessionGates();
                break;
            case 'ops':
            case 'dashboard':
            case 'snapshot':
                this.printOpsSnapshot();
                break;
            case 'evidence':
            case 'proof':
            case 'receipts':
                this.printEvidencePack();
                break;
            case 'review':
            case 'queue':
            case 'triage':
            case 'issue-queue':
                this.printReviewQueue();
                break;
            case 'find':
            case 'search':
                this.printFindResults(args.join(' '));
                break;
            case 'pins':
            case 'pinboard':
                this.printCommandPinboard();
                break;
            case 'pin':
                this.pinCommand(args.join(' '));
                break;
            case 'unpin':
                this.unpinCommand(args.join(' '));
                break;
            case 'voxel':
                this.setTheme('voxel');
                this.printPetCard();
                break;
            case 'buddy':
            case 'toolbelt':
            case 'agent-tools':
                this.focusVoxelCreator();
                this.printToolbeltCard();
                break;
            case 'build':
                this.printBuildDeck();
                this.recordVoxelToolUse('build');
                break;
            case 'canvas':
                await this.handleCanvasCommand(args);
                break;
            case 'long':
            case 'long-agent':
                await this.createLongAgentWorkload(args);
                break;
            case 'workflow':
            case 'workflows':
            case 'playbook':
            case 'wf':
                this.printWorkflows(args);
                break;
            case 'remote':
                await this.handleRemoteCommand(args);
                break;
            case 'sandbox':
                await this.invokeSandboxCommand(args);
                break;
            case 'sandbox-help':
                this.printSandboxHelp();
                break;
            case 'creator':
            case 'voxel-creator':
                this.focusVoxelCreator();
                break;
            case 'pet':
            case 'spawn':
                await this.handlePetCommand(args);
                break;
            case 'agent':
            case 'voxel-agent':
                await this.generateAIVoxelAgent(args.join(' '));
                break;
            case 'random-agent':
                this.generateRandomVoxelPet();
                break;
            case 'export':
                await this.exportSession(args[0] || 'md');
                break;
            case 'save':
                this.saveConversation(args[0] || 'session');
                break;
            case 'load':
                this.loadConversation(args[0] || 'session');
                break;
            case 'copy':
                this.copyLastOutput();
                break;
            case 'image':
                await this.generateImage(args.join(' '));
                break;
            case 'image-models':
                await this.listImageModels();
                break;
            case 'unsplash':
                await this.searchUnsplash(args.join(' '));
                break;
            case 'podcast':
                await this.runPodcastCommand(args.join(' '), false);
                break;
            case 'video-podcast':
                await this.runPodcastCommand(args.join(' '), true);
                break;
            case 'diagram':
                if (!args[0] || args[0] === 'help' || args[0] === '?') {
                    this.printDiagramHelp();
                } else {
                    await this.generateDiagram(args[0], args.slice(1).join(' '));
                }
                break;
            case 'upload':
                this.triggerFileUpload();
                break;
            case 'session':
                await this.handleSessionCommand(args);
                break;
            case 'history':
                await this.showSessionHistory();
                break;
            case 'artifacts':
                await this.showSessionArtifacts();
                break;
            case 'stats':
                this.printStats();
                break;
            case 'shortcuts':
            case 'keys':
                this.showShortcuts();
                break;
            case 'health':
                await this.checkHealth();
                break;
            case 'tools':
                await this.listTools(args[0] || null);
                break;
            case 'tool':
                await this.invokeToolCommand(args);
                break;
            case 'tool-help':
                await this.showToolHelp(args);
                break;
            case 'skills':
                await this.listSkills(args.join(' ').trim());
                break;
            case 'skill':
                await this.showSkill(args);
                break;
            case 'skill-create':
                await this.createSkillCommand(args);
                break;
            case 'skill-update':
                await this.updateSkillCommand(args);
                break;
            case 'files':
            case 'ls':
                await this.listFiles();
                break;
            case 'download':
                if (args[0]) {
                    await this.downloadFileById(args[0]);
                } else {
                    this.printError('Usage: /download <file-id>  (use /files to see IDs)');
                }
                break;
            case 'open':
                this.openFileManager();
                break;
            default:
                this.printError(`Unknown command: /${cmd}. Type /help for available commands.`);
        }
    }
    
    async processQuery(input, options = {}) {
        if (this.isProcessing) {
            this.printWarning('Already processing. Please wait...');
            return;
        }
        
        this.isProcessing = true;
        const requestController = new AbortController();
        this.currentRequestController = requestController;
        this.setRequestCancellationState(true);
        
        // Update status
        this.setStatus('thinking');
        this.reactVoxelPet(input, 'think');
        
        try {
            const chatOptions = {
                ...this.buildVoxelChatOptions(input),
                ...(options || {}),
                signal: requestController.signal,
                metadata: {
                    ...(this.buildVoxelChatOptions(input)?.metadata || {}),
                    ...(options?.metadata || {}),
                },
            };
            
            const response = await api.sendMessage(input, (chunk) => {
                // Stream progress
                if (chunk.type === 'delta') {
                    this.pulseVoxelStreaming();
                    this.appendToCurrentOutput(chunk.content);
                } else if (chunk.type === 'progress') {
                    this.updateLiveProgressCardFromChunk(chunk);
                } else if (chunk.type === 'reasoning_summary_delta') {
                    const summary = String(chunk.summary || chunk.content || '').replace(/\s+/g, ' ').trim();
                    if (summary) {
                        this.updateLiveReasoningSummary(summary);
                    }
                } else if (chunk.type === 'tool_event') {
                    this.recordVoxelToolUse('tool');
                    this.updateLiveToolEvent(chunk);
                }
            }, null, chatOptions);
            
            const reasoningSummary = String(
                response.assistantMetadata?.reasoningSummary
                || response.assistantMetadata?.reasoning_summary
                || '',
            ).replace(/\s+/g, ' ').trim();
            if (reasoningSummary) {
                this.updateLiveReasoningSummary(reasoningSummary);
            }

            // Finalize streaming output after the pixel reveal buffer catches up.
            const finalResponseLine = await this.finalizeStreamingOutput(response.content || 'No response');
            await this.attachLatestAlignmentTargetToLastAIResponse(response);
            this.finalizeLiveProgressCard();
            void this.maybeAutoPlayResponseSpeech(finalResponseLine);
            const addedArtifactFiles = this.syncArtifactsToSessionFiles([
                ...(Array.isArray(response.artifacts) ? response.artifacts : []),
                ...this.collectArtifactsFromValue(response.toolEvents || []),
            ]);
            if (addedArtifactFiles.length > 0) {
                this.printSystem(`Added ${addedArtifactFiles.length} artifact file(s) to /files.`);
            }

            // Update status and session info
            this.setStatus('ready');
            this.reactVoxelPet(input, 'proud');
            this.roamVoxelPet('corner-br', 'jump', 5200, { thought: 'done', linger: true });
            this.updateSessionInfo();
            
            // Add to conversation
            this.lastResponse = response.content;
            this.recordVoxelInteraction(input, response.content || '');
            
        } catch (error) {
            if (error.cancelled || requestController.signal.aborted) {
                if (this.liveProgressState) {
                    this.finalizeLiveProgressCard({ phase: 'cancelled', detail: 'Request cancelled by user.' });
                }
                this.printSystem('Request cancelled.');
                this.setStatus('ready');
                this.reactVoxelPet(input, 'idle');
                return;
            }
            if (this.liveProgressState) {
                this.finalizeLiveProgressCard({ phase: 'blocked', detail: error.message });
            }
            this.printError(`Request failed: ${error.message}`);
            this.handlePetAction('guard', { silent: true });
            this.setStatus('error');
        } finally {
            if (this.currentRequestController === requestController) {
                this.currentRequestController = null;
                this.setRequestCancellationState(false);
            }
            this.isProcessing = false;
            this.currentOutput = '';
            this.finalizeProgressLine();
            // Process any queued commands
            this.processQueue();
        }
    }

    setRequestCancellationState(active) {
        if (!this.cancelRequestButton) {
            return;
        }

        this.cancelRequestButton.hidden = !active;
        this.cancelRequestButton.disabled = false;
        this.cancelRequestButton.textContent = 'Stop';
        this.cancelRequestButton.setAttribute('aria-label', 'Stop current AI request');
    }

    cancelCurrentRequest() {
        const controller = this.currentRequestController;
        if (!controller || controller.signal.aborted) {
            return false;
        }

        controller.abort();
        if (this.cancelRequestButton) {
            this.cancelRequestButton.disabled = true;
            this.cancelRequestButton.textContent = 'Stopping...';
            this.cancelRequestButton.setAttribute('aria-label', 'Stopping current AI request');
        }
        return true;
    }

    parsePodcastCliOptions(input = '') {
        const tokens = String(input || '').split(/\s+/).filter(Boolean);
        const flags = {
            music: false,
            audio: false,
            intro: false,
            outro: false,
            unsplash: false,
            aspect: '16:9',
            systemPrompt: '',
            directContentRequest: '',
        };
        const topic = [];

        for (let index = 0; index < tokens.length; index += 1) {
            const token = tokens[index];
            if (token === '--music' || token === '-m') {
                flags.music = true;
            } else if (token === '--audio' || token === '-a') {
                flags.audio = true;
            } else if (token === '--intro') {
                flags.intro = true;
            } else if (token === '--outro') {
                flags.outro = true;
            } else if (token === '--unsplash') {
                flags.unsplash = true;
            } else if (token === '--aspect') {
                flags.aspect = tokens[index + 1] || flags.aspect;
                index += 1;
            } else if (token === '--system') {
                flags.systemPrompt = tokens[index + 1] || '';
                index += 1;
            } else if (token === '--brief') {
                flags.directContentRequest = tokens[index + 1] || '';
                index += 1;
            } else {
                topic.push(token);
            }
        }

        return {
            topic: topic.join(' ').trim(),
            flags,
        };
    }

    async runPodcastCommand(input = '', includeVideo = false) {
        const parsed = this.parsePodcastCliOptions(input);
        if (!parsed.topic) {
            this.printError(`Usage: /${includeVideo ? 'video-podcast' : 'podcast'} <topic> [--music] [--audio] [--system "extra prompt"]`);
            return;
        }

        const includeMusicBed = parsed.flags.music === true || parsed.flags.audio === true;
        const includeIntro = parsed.flags.intro === true || parsed.flags.audio === true;
        const includeOutro = parsed.flags.outro === true || parsed.flags.audio === true;
        const productionType = includeVideo ? 'video-podcast' : 'podcast';
        const message = `Create a ${includeVideo ? 'video podcast' : 'podcast'} about ${parsed.topic}`;

        await this.processQueryWithOptions(message, {
            metadata: {
                podcastOptions: {
                    enabled: true,
                    productionType,
                    includeVideo,
                    voiceOnlyAudio: !(includeMusicBed || includeIntro || includeOutro),
                    includeMusicBed,
                    includeIntro,
                    includeOutro,
                    videoAspectRatio: parsed.flags.aspect || '16:9',
                    videoRenderMode: includeVideo ? 'storyboard' : undefined,
                    videoImageMode: parsed.flags.unsplash ? 'unsplash' : 'generated',
                    videoGenerateImages: includeVideo && !parsed.flags.unsplash,
                    directContentRequest: parsed.flags.directContentRequest,
                    systemPrompt: parsed.flags.systemPrompt,
                },
            },
        });
    }

    async processQueryWithOptions(input, options = {}) {
        const merged = {
            ...this.buildVoxelChatOptions(input),
            ...(options || {}),
            metadata: {
                ...(this.buildVoxelChatOptions(input)?.metadata || {}),
                ...(options?.metadata || {}),
            },
        };
        return this.processQuery(input, merged);
    }

    getCanvasFileInfo(canvasType = 'document', response = {}) {
        const metadata = response?.metadata && typeof response.metadata === 'object' ? response.metadata : {};
        const rawName = String(metadata.filename || metadata.title || `canvas-${canvasType}-${Date.now()}`).trim();
        const safeBase = rawName
            .replace(/\.[a-z0-9]+$/i, '')
            .replace(/[^a-z0-9._-]+/gi, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 72) || `canvas-${canvasType}`;
        const extension = String(metadata.extension || '').replace(/^\./, '').trim().toLowerCase()
            || (canvasType === 'code' ? 'txt' : (canvasType === 'diagram' ? 'mmd' : 'md'));
        const mimeType = canvasType === 'code'
            ? 'text/plain'
            : (canvasType === 'diagram' ? 'text/plain' : 'text/markdown');
        return {
            filename: `${safeBase}.${extension}`,
            mimeType,
        };
    }

    getCanvasResponseContent(response = {}) {
        const value = response?.content ?? response?.result ?? response?.text ?? response?.markdown ?? '';
        if (typeof value === 'string') {
            return value.trim();
        }
        if (value == null) {
            return '';
        }
        try {
            return JSON.stringify(value, null, 2);
        } catch (_error) {
            return String(value);
        }
    }

    async handleCanvasCommand(args = []) {
        const firstArg = String(args[0] || '').trim().toLowerCase();
        if (!firstArg || ['help', '?'].includes(firstArg)) {
            this.printAI(`## Canvas CLI

Generate structured Canvas content from the Web CLI and save it into session files.

- \`/canvas document <prompt>\`
- \`/canvas code <prompt>\`
- \`/canvas diagram <prompt>\`
- Add \`--from-last\` to include the last assistant response as existing content.

Generated content is added to \`/files\` for download or reuse.`);
            return;
        }

        const validTypes = new Set(['document', 'doc', 'markdown', 'code', 'diagram']);
        const hasExplicitType = validTypes.has(firstArg);
        const canvasType = hasExplicitType
            ? (['doc', 'markdown'].includes(firstArg) ? 'document' : firstArg)
            : 'document';
        const promptArgs = hasExplicitType ? args.slice(1) : args;
        const fromLastIndex = promptArgs.findIndex((part) => String(part || '').trim() === '--from-last');
        const includeLastResponse = fromLastIndex >= 0;
        if (includeLastResponse) {
            promptArgs.splice(fromLastIndex, 1);
        }

        const message = promptArgs.join(' ').trim();
        if (!message) {
            this.printError('Usage: /canvas <document|code|diagram> <prompt> [--from-last]');
            return;
        }

        const existingContent = includeLastResponse ? String(this.lastResponse || '').trim() : '';
        this.setStatus('thinking');
        this.printSystem(`Generating ${canvasType} canvas content...`);

        try {
            const response = await api.sendCanvasRequest(message, canvasType, existingContent);
            const content = this.getCanvasResponseContent(response);
            if (!content) {
                this.printWarning('Canvas returned no content.');
                return;
            }

            const fileInfo = this.getCanvasFileInfo(canvasType, response);
            const file = this.addSessionFile(fileInfo.filename, content, fileInfo.mimeType, 'canvas', {
                canvasType,
                size: new Blob([content]).size,
            });
            this.updateSessionInfo();

            const suggestions = Array.isArray(response?.suggestions) && response.suggestions.length > 0
                ? `\n\nSuggestions:\n${response.suggestions.slice(0, 4).map((item) => `- ${String(item || '').trim()}`).join('\n')}`
                : '';
            const preview = content.length > 900 ? `${content.slice(0, 900).trim()}\n...` : content;
            this.printAI(`## Canvas ${canvasType} generated

Saved to \`/files\` as **${file.filename}** (file ${file.id}).

\`\`\`${canvasType === 'diagram' ? 'mermaid' : ''}
${preview.replace(/```/g, '\\`\\`\\`')}
\`\`\`${suggestions}`);
            this.printSystem(`Use /download ${file.id} to save ${file.filename}.`);
        } catch (error) {
            this.printError(`Canvas generation failed: ${error.message}`);
        } finally {
            this.setStatus('ready');
        }
    }
    
    // ==================== Simple Status & Queue ====================
    
    setStatus(state) {
        // state: 'ready', 'thinking', 'error'
        if (!this.cliStatus) return;
        
        this.cliStatus.className = `cli-status ${state}`;
        
        switch(state) {
            case 'thinking':
                this.cliStatus.textContent = 'Thinking...';
                break;
            case 'error':
                this.cliStatus.textContent = 'Error';
                setTimeout(() => this.setStatus('ready'), 3000);
                break;
            case 'ready':
            default:
                this.cliStatus.textContent = 'Ready';
                break;
        }
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // ==================== Session Info ====================

    readArtifactLineageFromLocation(search = window.location?.search || '') {
        const params = new window.URLSearchParams(String(search || '').replace(/^\?/, ''));
        const artifactId = String(params.get('artifactId') || '').trim();
        const sourceArtifactId = String(params.get('sourceArtifactId') || artifactId).trim();
        const parentArtifactId = String(params.get('parentArtifactId') || artifactId).trim();
        const missionId = String(params.get('missionId') || '').trim();
        const revision = Number(params.get('revision'));
        if (!artifactId && !sourceArtifactId && !parentArtifactId && !missionId) {
            return null;
        }
        return {
            artifactId: artifactId || null,
            sourceArtifactId: sourceArtifactId || null,
            parentArtifactId: parentArtifactId || null,
            missionId: missionId || null,
            revision: Number.isInteger(revision) && revision > 0 ? revision : null,
        };
    }

    updateArtifactHandoffLocation(handoff = null) {
        if (!handoff?.artifact?.id || !window.history?.replaceState || !window.location?.href) {
            return;
        }
        try {
            const nextUrl = new window.URL(window.location.href);
            nextUrl.searchParams.set('artifactId', handoff.artifact.id);
            nextUrl.searchParams.set('sourceArtifactId', handoff.sourceArtifactId);
            nextUrl.searchParams.set('parentArtifactId', handoff.artifact.id);
            nextUrl.searchParams.set('revision', String(handoff.artifact.revision || 1));
            window.history.replaceState(
                window.history.state,
                '',
                `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
            );
        } catch (_error) {
            // The destination session and stored artifact remain authoritative.
        }
    }

    async ensureArtifactLineageAttached(lineage = null) {
        const requestedLineage = lineage || this.readArtifactLineageFromLocation();
        const sourceArtifactId = String(
            requestedLineage?.sourceArtifactId
            || requestedLineage?.artifactId
            || this.artifactHandoff?.sourceArtifactId
            || '',
        ).trim();
        if (!sourceArtifactId) {
            return this.artifactHandoff;
        }
        if (this.artifactHandoff?.sourceArtifactId === sourceArtifactId) {
            return this.artifactHandoff;
        }
        if (this.artifactHandoffPromise) {
            return this.artifactHandoffPromise;
        }

        const createClient = window.KimiBuiltRemoteArtifactWorkflow?.createArtifactHandoffClient;
        if (typeof createClient !== 'function') {
            throw new Error('The artifact handoff client is unavailable.');
        }

        const targetSessionId = await api.ensureSession({
            title: 'Codex and Kimi artifact handoff',
            metadata: {
                artifactHandoff: true,
                sourceArtifactId,
            },
        });
        if (!targetSessionId) {
            throw new Error('Web CLI could not resolve an isolated destination session.');
        }
        this.updateSessionInfo();

        const handoffClient = createClient({
            baseUrl: window.location?.origin || '',
            getSessionId: () => api.sessionId,
            setSessionId: (sessionId) => api.setSessionId(sessionId),
        });
        this.artifactHandoffPromise = handoffClient.attachArtifact(sourceArtifactId, {
            targetSessionId,
            mode: 'chat',
            taskType: 'chat',
            clientSurface: 'web-cli',
        }).then((handoff) => {
            api.setSessionId(handoff.targetSessionId);
            const attachedLineage = {
                ...(requestedLineage || {}),
                schemaVersion: 'ArtifactLineage/v1',
                sourceArtifactId: handoff.sourceArtifactId,
                artifactId: handoff.artifact.id,
                parentArtifactId: handoff.artifact.id,
                revision: Number(handoff.artifact.revision || 1),
                sourceSurface: 'web-cli',
            };
            this.artifactHandoff = {
                ...handoff,
                lineage: attachedLineage,
            };
            this.syncArtifactsToSessionFiles([handoff.artifact], 'artifact-handoff');
            if (!(this.selectedRemoteArtifactIds instanceof Set)) {
                this.selectedRemoteArtifactIds = new Set();
            }
            this.selectedRemoteArtifactIds.add(handoff.artifact.id);
            this.updateArtifactHandoffLocation(handoff);
            this.updateSessionInfo();
            const filename = String(handoff.artifact.filename || 'Source artifact').trim();
            this.printSystem(
                `${filename} is attached as exact agent context and selected for the next Codex/Kimi remote agent run.`,
            );
            return this.artifactHandoff;
        }).finally(() => {
            this.artifactHandoffPromise = null;
        });
        return this.artifactHandoffPromise;
    }
    
    printStats() {
        const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
        this.printSystem(`
Session Statistics:
  Duration: ${elapsed}s
  Model: ${api.currentModel || 'default'}
  Session: ${api.sessionId || 'none'}
        `.trim());
    }

    async restoreSharedSession() {
        const requestedLineage = this.readArtifactLineageFromLocation();
        try {
            const data = await api.getSessionState();
            const sessions = Array.isArray(data.sessions) ? data.sessions : [];
            const storedSessionId = String(api.sessionId || '').trim();
            const activeSessionId = String(
                data.activeSessionId
                || (storedSessionId && sessions.some((session) => session.id === storedSessionId) ? storedSessionId : '')
                || sessions[0]?.id
                || '',
            ).trim();

            if (!activeSessionId) {
                if (storedSessionId) {
                    api.setSessionId(null);
                }
                this.updateSessionInfo();
            } else {
                api.setSessionId(activeSessionId);
                this.updateSessionInfo();
                await this.renderPersistedSessionHistory(activeSessionId, {
                    clear: false,
                    intro: `Connected to isolated session ${activeSessionId.slice(0, 8)}...`,
                });
            }
        } catch (error) {
            console.warn('Failed to restore isolated session:', error);
        }

        if (requestedLineage?.sourceArtifactId || requestedLineage?.artifactId) {
            try {
                await this.ensureArtifactLineageAttached(requestedLineage);
            } catch (error) {
                console.warn('Failed to attach routed artifact:', error);
                this.printError(`Artifact handoff failed: ${error.message}`);
            }
        }
    }

    updateSessionInfo() {
        if (!this.sessionInfo) {
            return;
        }

        if (!api.sessionId) {
            this.sessionInfo.textContent = 'Session: new';
            this.sessionInfo.title = 'A new isolated session will be created on the next request.';
            return;
        }

        const shortId = api.sessionId.slice(0, 8);
        this.sessionInfo.textContent = `Session: ${shortId}...`;
        this.sessionInfo.title = `Full session ID: ${api.sessionId}`;
    }

    getPromptLabel() {
        if (this.theme === 'voxel' && this.voxelPet?.name) {
            return `[${this.voxelPet.name.split('-')[0]}]`;
        }

        return '>';
    }

    initializeTts() {
        if (!this.ttsManager || this.ttsInitialized) {
            this.updateTtsControls();
            return;
        }

        this.ttsInitialized = true;
        this.ttsManager.addEventListener('statechange', () => this.updateTtsControls());
        this.ttsManager.addEventListener('configchange', () => this.updateTtsControls());
        this.ttsManager.addEventListener('chunkstart', (event) => this.handleTtsChunkStart(event));
        this.ttsManager.addEventListener('chunkend', (event) => this.handleTtsChunkEnd(event));
        this.ttsManager.addEventListener('playbackstop', () => {
            this.clearSpeechHighlights();
            this.clearTtsActiveLines();
            this.updateTtsControls();
        });

        void this.ttsManager.ensureConfigLoaded({ quiet: true })
            .catch((error) => {
                console.warn('[WebCLI] TTS unavailable:', error);
            })
            .finally(() => this.updateTtsControls());
    }

    isTtsAvailable() {
        return this.ttsManager?.isAvailable?.() === true;
    }

    getTtsStatus() {
        return this.ttsManager?.getStatus?.() || (this.isTtsAvailable() ? 'ready' : 'unavailable');
    }

    getTtsDiagnostics() {
        return this.ttsManager?.getDiagnostics?.() || {
            status: 'unavailable',
            message: 'Voice playback is unavailable.',
        };
    }

    getTtsFeatureLabel() {
        return this.ttsManager?.getProviderLabel?.() || 'Voice';
    }

    getTtsVoiceLabel() {
        return this.ttsManager?.getVoiceLabel?.() || 'Voice';
    }

    getTtsVoices() {
        return this.ttsManager?.getVoices?.() || [];
    }

    createTtsMessageId() {
        this.ttsMessageCounter += 1;
        return `${WEB_CLI_TTS_MESSAGE_PREFIX}:${Date.now()}:${this.ttsMessageCounter}`;
    }

    registerTtsMessageText(text = '', messageId = '') {
        const normalizedText = String(text || '').trim();
        if (!normalizedText) {
            return '';
        }

        const normalizedMessageId = String(messageId || '').trim() || this.createTtsMessageId();
        this.ttsMessageTextById.set(normalizedMessageId, normalizedText);
        while (this.ttsMessageTextById.size > 160) {
            const oldestKey = this.ttsMessageTextById.keys().next().value;
            this.ttsMessageTextById.delete(oldestKey);
        }
        return normalizedMessageId;
    }

    getTtsTextForMessage(messageId = '', line = null) {
        const normalizedMessageId = String(messageId || '').trim();
        if (normalizedMessageId && this.ttsMessageTextById.has(normalizedMessageId)) {
            return this.ttsMessageTextById.get(normalizedMessageId);
        }

        return String(
            line?.querySelector?.('.markdown-content')?.innerText
            || line?.querySelector?.('.cli-response-body, .voxel-response-body')?.innerText
            || '',
        ).trim();
    }

    getTtsControlState(messageId = '') {
        const normalizedMessageId = String(messageId || '').trim();
        const text = this.getTtsTextForMessage(normalizedMessageId);
        const loading = this.ttsManager?.isLoadingMessage?.(normalizedMessageId) === true;
        const playing = this.ttsManager?.isPlayingMessage?.(normalizedMessageId) === true;
        const available = this.isTtsAvailable();
        const featureLabel = this.getTtsFeatureLabel();
        const diagnostics = this.getTtsDiagnostics();
        const disabled = !this.ttsManager || !text || !available || loading;
        const title = !text
            ? 'No readable text in this response'
            : (!available
                ? `${featureLabel} unavailable: ${String(diagnostics.message || 'Voice playback is unavailable.').trim()}`
                : (playing ? 'Stop voice playback' : `Read response aloud with ${this.getTtsVoiceLabel()}`));

        return {
            available,
            disabled,
            loading,
            playing,
            label: loading ? '...' : (playing ? 'Stop' : 'Read'),
            title,
        };
    }

    buildTtsActionMarkup(text = '', options = {}) {
        if (options.streaming === true || !String(text || '').trim()) {
            return '';
        }

        const messageId = this.registerTtsMessageText(text, options.ttsMessageId);
        if (!messageId) {
            return '';
        }

        const state = this.getTtsControlState(messageId);
        return `
            <button
                type="button"
                class="cli-tts-btn${state.playing ? ' is-active' : ''}${state.loading ? ' is-loading' : ''}"
                data-cli-tts-message-id="${this.escapeHtmlAttr(messageId)}"
                onclick="app.toggleResponseSpeech(this)"
                title="${this.escapeHtmlAttr(state.title)}"
                aria-label="${this.escapeHtmlAttr(state.title)}"
                ${state.disabled ? 'disabled' : ''}
            >${this.escapeHtml(state.label)}</button>
        `;
    }

    updateTtsControls(container = document) {
        if (this.ttsToggleButton) {
            const available = this.isTtsAvailable();
            const enabled = this.ttsManager?.isAutoPlayEnabled?.() === true;
            const diagnostics = this.getTtsDiagnostics();
            const label = this.ttsToggleButton.querySelector('span');
            this.ttsToggleButton.disabled = !this.ttsManager || !available;
            this.ttsToggleButton.classList.toggle('is-active', available && enabled);
            this.ttsToggleButton.setAttribute('aria-pressed', available && enabled ? 'true' : 'false');
            this.ttsToggleButton.title = available
                ? (enabled ? 'Read replies aloud: On' : 'Read replies aloud: Off')
                : String(diagnostics.message || 'Voice playback is unavailable.');
            this.ttsToggleButton.setAttribute('aria-label', this.ttsToggleButton.title);
            if (label) {
                label.textContent = enabled ? 'Voice On' : 'Voice';
            }
        }

        if (!container?.querySelectorAll) {
            return;
        }

        container.querySelectorAll('.cli-tts-btn[data-cli-tts-message-id]').forEach((button) => {
            const messageId = String(button.dataset.cliTtsMessageId || '').trim();
            const state = this.getTtsControlState(messageId);
            button.disabled = state.disabled;
            button.textContent = state.label;
            button.title = state.title;
            button.setAttribute('aria-label', state.title);
            button.classList.toggle('is-active', state.playing);
            button.classList.toggle('is-loading', state.loading);
        });
    }

    setTtsActiveLine(messageId = '', active = true) {
        const normalizedMessageId = String(messageId || '').trim();
        if (!normalizedMessageId || !this.terminalOutput?.querySelectorAll) {
            return;
        }

        const escapeSelectorValue = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(normalizedMessageId)
            : normalizedMessageId.replace(/["\\]/g, '\\$&');
        this.terminalOutput
            .querySelectorAll(`.cli-tts-btn[data-cli-tts-message-id="${escapeSelectorValue}"]`)
            .forEach((button) => {
                const line = button.closest('.line-output.ai');
                if (line) {
                    line.classList.toggle('is-voice-playing', active);
                }
            });
    }

    clearTtsActiveLines() {
        this.terminalOutput
            ?.querySelectorAll?.('.line-output.ai.is-voice-playing')
            .forEach((line) => line.classList.remove('is-voice-playing'));
    }

    normalizeSpeechHighlightText(text = '') {
        const comparable = {
            text: '',
            positions: [],
        };
        this.appendComparableSpeechText(String(text || ''), comparable);
        this.trimComparableSpeechOutput(comparable);
        return comparable.text;
    }

    trimComparableSpeechOutput(output) {
        while (output.text.endsWith(' ')) {
            output.text = output.text.slice(0, -1);
            output.positions.pop();
        }
    }

    trimSpeechUrlToken(value = '') {
        const token = String(value || '');
        const trailing = token.match(/[),.;:!?]+$/)?.[0] || '';
        return trailing ? token.slice(0, -trailing.length) : token;
    }

    normalizeSpeechUrlToken(url = '') {
        const body = this.trimSpeechUrlToken(url);
        if (!body) {
            return '';
        }

        const parseTarget = /^https?:\/\//i.test(body) ? body : `https://${body.replace(/^www\./i, '')}`;
        let host = '';
        let path = '';

        try {
            const parsed = new URL(parseTarget);
            host = String(parsed.hostname || '').replace(/^www\./i, '');
            path = String(parsed.pathname || '').replace(/\/+$/g, '');
        } catch (_error) {
            const withoutProtocol = body.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
            const [rawHost, ...rest] = withoutProtocol.split('/');
            host = rawHost;
            path = rest.length ? `/${rest.join('/')}` : '';
        }

        const hostSpeech = host
            .split('.')
            .map((part) => part.replace(/[-_]+/g, ' ').trim())
            .filter(Boolean)
            .join(' dot ');
        const decodeUrlPart = (part = '') => {
            try {
                return decodeURIComponent(part);
            } catch (_error) {
                return part;
            }
        };
        const pathSpeech = path
            ? path
                .split('/')
                .map((part) => decodeUrlPart(part).replace(/[-_]+/g, ' ').replace(/[?#].*$/g, '').trim())
                .filter(Boolean)
                .map((part) => `slash ${part}`)
                .join(' ')
            : '';

        return [hostSpeech, pathSpeech].filter(Boolean).join(' ').trim() || body;
    }

    appendComparableSpeechChar(output, char = '', position = null) {
        const normalized = String(char || '').toLowerCase();
        if (/^[a-z0-9]$/.test(normalized)) {
            output.text += normalized;
            output.positions.push(position);
            return;
        }

        if (output.text && !output.text.endsWith(' ')) {
            output.text += ' ';
            output.positions.push(position);
        }
    }

    appendComparableSpeechBoundary(output, position = null) {
        if (output.text && !output.text.endsWith(' ')) {
            output.text += ' ';
            output.positions.push(position);
        }
    }

    isComparableSpeechContentChar(char = '') {
        return /^[a-z0-9]$/.test(String(char || ''));
    }

    findComparableSpeechContentIndex(textMap = {}, startIndex = 0, endIndex = 0, direction = 1) {
        const text = String(textMap.text || '');
        const positions = Array.isArray(textMap.positions) ? textMap.positions : [];
        if (!text || positions.length === 0) {
            return -1;
        }

        const step = direction < 0 ? -1 : 1;
        const min = Math.max(0, Math.min(Number(startIndex) || 0, Number(endIndex) || 0));
        const max = Math.min(text.length - 1, Math.max(Number(startIndex) || 0, Number(endIndex) || 0));
        let index = step < 0 ? max : min;
        while (index >= min && index <= max) {
            if (this.isComparableSpeechContentChar(text[index]) && positions[index]?.node) {
                return index;
            }
            index += step;
        }
        return -1;
    }

    createSpeechRangeFromComparableIndexes(textMap = {}, startIndex = 0, endIndex = 0) {
        const start = textMap.positions?.[startIndex];
        const end = textMap.positions?.[endIndex];
        if (!start?.node || !end?.node) {
            return null;
        }

        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset + 1);
        return range;
    }

    appendComparablePlainText(text = '', output, node = null, baseOffset = 0) {
        String(text || '').split('').forEach((char, index) => {
            this.appendComparableSpeechChar(output, char, node ? { node, offset: baseOffset + index } : null);
        });
    }

    appendComparableUrlText(text = '', output, node = null, baseOffset = 0, sourceLength = 0) {
        const speechText = this.normalizeSpeechUrlToken(text);
        const comparableLength = Math.max(1, speechText.length);
        const normalizedSourceLength = Math.max(1, Number(sourceLength) || String(text || '').length || 1);

        speechText.split('').forEach((char, index) => {
            const sourceOffset = baseOffset + Math.min(
                normalizedSourceLength - 1,
                Math.floor((index / comparableLength) * normalizedSourceLength),
            );
            this.appendComparableSpeechChar(output, char, node ? { node, offset: sourceOffset } : null);
        });
    }

    appendComparableSpeechText(text = '', output, node = null, baseOffset = 0) {
        const value = String(text || '');
        const tokenPattern = /\b(?:https?:\/\/|www\.)[^\s<>)\]]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|ai|dev|app|edu|gov|ca|co|us|uk|help|buzz|cloud|site|online|xyz|info|biz)(?:\/[^\s<>)\]]*)?/gi;
        let cursor = 0;
        let match = tokenPattern.exec(value);

        while (match) {
            if (match.index > cursor) {
                this.appendComparablePlainText(value.slice(cursor, match.index), output, node, baseOffset + cursor);
            }

            const rawToken = match[0] || '';
            const token = this.trimSpeechUrlToken(rawToken);
            this.appendComparableUrlText(token, output, node, baseOffset + match.index, token.length);
            cursor = match.index + rawToken.length;
            match = tokenPattern.exec(value);
        }

        if (cursor < value.length) {
            this.appendComparablePlainText(value.slice(cursor), output, node, baseOffset + cursor);
        }
    }

    getTtsLineByMessageId(messageId = '') {
        const normalizedMessageId = String(messageId || '').trim();
        if (!normalizedMessageId || !this.terminalOutput?.querySelectorAll) {
            return null;
        }

        const escapeSelectorValue = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(normalizedMessageId)
            : normalizedMessageId.replace(/["\\]/g, '\\$&');
        return this.terminalOutput
            .querySelector(`.cli-tts-btn[data-cli-tts-message-id="${escapeSelectorValue}"]`)
            ?.closest?.('.line-output.ai') || null;
    }

    clearSpeechHighlights(messageId = '', options = {}) {
        const line = messageId ? this.getTtsLineByMessageId(messageId) : null;
        const root = line || this.terminalOutput || document;
        if (!root?.querySelectorAll) {
            return;
        }

        root.querySelectorAll('.tts-reading-highlight').forEach((highlight) => {
            const parent = highlight.parentNode;
            if (!parent) {
                return;
            }
            const children = Array.from(highlight.childNodes);
            children.forEach((child) => parent.insertBefore(child, highlight));
            parent.removeChild(highlight);
            parent.normalize?.();
        });

        if (options.preserveState !== true) {
            this.speechHighlightState = {
                messageId: '',
                lastSearchOffset: 0,
                lastChunkIndex: -1,
            };
        }
    }

    shouldSkipSpeechHighlightNode(node = null) {
        const parentElement = node?.parentElement || null;
        if (!parentElement) {
            return true;
        }

        return Boolean(parentElement.closest(
            'pre, code, kbd, samp, script, style, textarea, input, button, svg, .cli-response-head, .voxel-response-head, .cli-response-tools, .tts-reading-highlight',
        ));
    }

    getSpeechHighlightSectionElement(node = null) {
        const parentElement = node?.parentElement || null;
        if (!parentElement) {
            return null;
        }

        return parentElement.closest(
            'li, p, blockquote, h1, h2, h3, h4, h5, h6, td, th, caption, figcaption, section, article',
        ) || parentElement.closest('div');
    }

    buildSpeechHighlightTextMap(root = null) {
        if (!root || !document?.createTreeWalker || typeof NodeFilter === 'undefined') {
            return {
                text: '',
                positions: [],
            };
        }

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => (
                this.shouldSkipSpeechHighlightNode(node) || !String(node.nodeValue || '').trim()
                    ? NodeFilter.FILTER_REJECT
                    : NodeFilter.FILTER_ACCEPT
            ),
        });
        const output = {
            text: '',
            positions: [],
            sections: [],
        };
        let lastSectionElement = null;

        while (walker.nextNode()) {
            const node = walker.currentNode;
            const sectionElement = this.getSpeechHighlightSectionElement(node);
            if (lastSectionElement && sectionElement !== lastSectionElement) {
                this.appendComparableSpeechBoundary(output, { node, offset: 0 });
                const previousSection = output.sections[output.sections.length - 1];
                if (previousSection && typeof previousSection.endIndex !== 'number') {
                    previousSection.endIndex = Math.max(previousSection.startIndex, output.text.length - 1);
                }
            }

            if (sectionElement !== lastSectionElement) {
                output.sections.push({
                    element: sectionElement,
                    startIndex: output.text.length,
                });
                lastSectionElement = sectionElement;
            }
            this.appendComparableSpeechText(String(node.nodeValue || ''), output, node, 0);
        }
        this.trimComparableSpeechOutput(output);
        const finalSection = output.sections[output.sections.length - 1];
        if (finalSection && typeof finalSection.endIndex !== 'number') {
            finalSection.endIndex = Math.max(finalSection.startIndex, output.text.length);
        }

        return {
            text: output.text,
            positions: output.positions,
            sections: output.sections,
        };
    }

    findSpeechHighlightRange(root = null, chunkText = '', options = {}) {
        const normalizedChunk = this.normalizeSpeechHighlightText(chunkText).toLowerCase();
        if (!root || !normalizedChunk) {
            return null;
        }

        const textMap = this.buildSpeechHighlightTextMap(root);
        if (!textMap.text || textMap.positions.length === 0) {
            return null;
        }

        const preferredStartIndex = Math.max(0, Number(options.startIndex) || 0);
        const chunkIndex = Number(options.chunkIndex);
        const searchStartIndex = Math.max(0, preferredStartIndex - 12);
        const candidates = [
            normalizedChunk,
            normalizedChunk.length > 96 ? normalizedChunk.slice(0, 96).trim() : '',
            normalizedChunk.split(' ').slice(0, 10).join(' '),
        ]
            .map((candidate) => candidate.trim())
            .filter((candidate, index, list) => (
                candidate.length >= 3 && list.indexOf(candidate) === index
            ));

        for (const candidate of candidates) {
            let matchIndex = textMap.text.indexOf(candidate, searchStartIndex);
            if (matchIndex < 0 && preferredStartIndex > 0 && chunkIndex === 0) {
                matchIndex = textMap.text.indexOf(candidate);
            }
            if (matchIndex < 0) {
                continue;
            }

            const rawEndIndex = Math.min(textMap.positions.length - 1, matchIndex + candidate.length - 1);
            const startIndex = this.findComparableSpeechContentIndex(textMap, matchIndex, rawEndIndex, 1);
            const endIndex = this.findComparableSpeechContentIndex(textMap, rawEndIndex, matchIndex, -1);
            if (startIndex < 0 || endIndex < startIndex) {
                continue;
            }

            const range = this.createSpeechRangeFromComparableIndexes(textMap, startIndex, endIndex);
            if (!range) {
                continue;
            }
            return {
                range,
                endIndex: endIndex + 1,
            };
        }

        return null;
    }

    findSpeechSectionRangeByIndex(root = null, chunkIndex = -1) {
        if (!root || !Number.isFinite(Number(chunkIndex)) || Number(chunkIndex) < 0) {
            return null;
        }

        const textMap = this.buildSpeechHighlightTextMap(root);
        if (!textMap.text || textMap.positions.length === 0) {
            return null;
        }

        const sections = Array.isArray(textMap.sections)
            ? textMap.sections.filter((section) => Number(section?.endIndex) > Number(section?.startIndex))
            : [];
        const section = sections[Math.min(sections.length - 1, Number(chunkIndex))];
        if (!section) {
            return null;
        }

        const rawStartIndex = Math.max(0, Number(section.startIndex) || 0);
        const rawEndIndex = Math.min(
            textMap.positions.length - 1,
            Math.max(rawStartIndex, Number(section.endIndex) - 1),
        );
        const startIndex = this.findComparableSpeechContentIndex(textMap, rawStartIndex, rawEndIndex, 1);
        const endIndex = this.findComparableSpeechContentIndex(textMap, rawEndIndex, rawStartIndex, -1);
        if (startIndex < 0 || endIndex < startIndex) {
            return null;
        }

        const range = this.createSpeechRangeFromComparableIndexes(textMap, startIndex, endIndex);
        if (!range) {
            return null;
        }
        return {
            range,
            endIndex: endIndex + 1,
        };
    }

    highlightSpeechChunk(messageId = '', chunkText = '', options = {}) {
        const normalizedMessageId = String(messageId || '').trim();
        if (!normalizedMessageId || normalizedMessageId.startsWith('tts-preview:')) {
            return false;
        }

        const line = this.getTtsLineByMessageId(normalizedMessageId);
        const textRoot = line?.querySelector?.('.cli-response-body, .voxel-response-body');
        if (!textRoot) {
            return false;
        }

        const chunkIndex = Number(options.chunkIndex);
        if (
            this.speechHighlightState.messageId !== normalizedMessageId
            || chunkIndex === 0
            || chunkIndex <= this.speechHighlightState.lastChunkIndex
        ) {
            this.speechHighlightState = {
                messageId: normalizedMessageId,
                lastSearchOffset: 0,
                lastChunkIndex: -1,
            };
        }

        this.clearSpeechHighlights('', { preserveState: true });
        const match = this.findSpeechHighlightRange(textRoot, chunkText, {
            startIndex: this.speechHighlightState.lastSearchOffset,
            chunkIndex,
        }) || this.findSpeechSectionRangeByIndex(textRoot, chunkIndex);
        if (!match?.range) {
            return false;
        }

        const highlight = document.createElement('span');
        highlight.className = 'tts-reading-highlight';
        highlight.dataset.ttsReading = 'true';
        try {
            const contents = match.range.extractContents();
            highlight.appendChild(contents);
            match.range.insertNode(highlight);
            this.speechHighlightState = {
                messageId: normalizedMessageId,
                lastSearchOffset: Math.max(this.speechHighlightState.lastSearchOffset, Number(match.endIndex) || 0),
                lastChunkIndex: Number.isFinite(chunkIndex) ? chunkIndex : this.speechHighlightState.lastChunkIndex,
            };
            highlight.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
            return true;
        } catch (error) {
            console.warn('[WebCLI] Failed to highlight spoken text:', error);
            this.clearSpeechHighlights();
            return false;
        }
    }

    handleTtsChunkStart(event = {}) {
        const messageId = String(event.detail?.messageId || '').trim();
        this.highlightSpeechChunk(messageId, event.detail?.chunkText || '', {
            chunkIndex: event.detail?.chunkIndex,
        });
        this.clearTtsActiveLines();
        this.setTtsActiveLine(messageId, true);
        this.updateTtsControls();
    }

    handleTtsChunkEnd(event = {}) {
        const messageId = String(event.detail?.messageId || '').trim();
        const chunkIndex = Number(event.detail?.chunkIndex);
        const chunkCount = Number(event.detail?.chunkCount);
        if (Number.isFinite(chunkIndex) && Number.isFinite(chunkCount) && chunkIndex >= chunkCount - 1) {
            this.setTtsActiveLine(messageId, false);
            setTimeout(() => this.clearSpeechHighlights(messageId), 120);
        }
        this.updateTtsControls();
    }

    async ensureTtsConfig() {
        if (!this.ttsManager) {
            return false;
        }

        try {
            await this.ttsManager.ensureConfigLoaded({ quiet: true });
        } catch (error) {
            console.warn('[WebCLI] Failed to load TTS config:', error);
        }

        this.updateTtsControls();
        return this.isTtsAvailable();
    }

    async toggleResponseSpeech(button = null) {
        const line = button?.closest?.('.line-output.ai') || null;
        const messageId = String(button?.dataset?.cliTtsMessageId || '').trim();
        const text = this.getTtsTextForMessage(messageId, line);
        if (!messageId || !text) {
            this.printWarning('There is no readable text in this response.');
            return;
        }

        const available = this.isTtsAvailable() || await this.ensureTtsConfig();
        if (!available) {
            const diagnostics = this.getTtsDiagnostics();
            this.printWarning(String(diagnostics.message || 'Voice playback is unavailable.'));
            return;
        }

        try {
            await this.ttsManager.toggleMessagePlayback({
                messageId,
                text,
            });
        } catch (error) {
            this.printWarning(error.message || 'Failed to generate voice playback.');
        } finally {
            this.updateTtsControls();
        }
    }

    async maybeAutoPlayResponseSpeech(line = null) {
        if (!line || this.ttsManager?.isAutoPlayEnabled?.() !== true) {
            return;
        }

        const button = line.querySelector?.('.cli-tts-btn[data-cli-tts-message-id]');
        const messageId = String(button?.dataset?.cliTtsMessageId || '').trim();
        const text = this.getTtsTextForMessage(messageId, line);
        if (!messageId || !text) {
            return;
        }

        const available = this.isTtsAvailable() || await this.ensureTtsConfig();
        if (!available) {
            return;
        }

        try {
            await this.ttsManager.speakMessage({
                messageId,
                text,
            });
        } catch (error) {
            console.warn('[WebCLI] TTS autoplay failed:', error);
        } finally {
            this.updateTtsControls();
        }
    }

    async toggleTtsAutoPlayFromToolbar() {
        await this.handleTtsCommand(['toggle']);
    }

    async handleTtsCommand(args = []) {
        const subcommand = String(args[0] || 'status').trim().toLowerCase();
        if (!this.ttsManager) {
            this.printWarning('Voice playback is not loaded in this browser.');
            return;
        }

        if (['on', 'enable', 'enabled', 'autoplay'].includes(subcommand)) {
            const available = this.isTtsAvailable() || await this.ensureTtsConfig();
            if (!available) {
                this.printWarning(String(this.getTtsDiagnostics().message || 'Voice playback is unavailable.'));
                return;
            }
            this.ttsManager.setAutoPlayEnabled(true);
            this.updateTtsControls();
            this.printSuccess(`Read replies aloud is on with ${this.getTtsVoiceLabel()}.`);
            return;
        }

        if (['off', 'disable', 'disabled'].includes(subcommand)) {
            this.ttsManager.setAutoPlayEnabled(false);
            this.ttsManager.stop?.();
            this.updateTtsControls();
            this.printSystem('Read replies aloud is off.');
            return;
        }

        if (subcommand === 'toggle') {
            const nextValue = this.ttsManager.isAutoPlayEnabled?.() !== true;
            await this.handleTtsCommand([nextValue ? 'on' : 'off']);
            return;
        }

        if (['stop', 'pause', 'quiet'].includes(subcommand)) {
            this.ttsManager.stop?.();
            this.clearTtsActiveLines();
            this.updateTtsControls();
            this.printSystem('Voice playback stopped.');
            return;
        }

        if (['voices', 'list'].includes(subcommand)) {
            await this.printTtsVoices();
            return;
        }

        if (subcommand === 'voice') {
            await this.handleVoiceCommand(args.slice(1));
            return;
        }

        if (!['status', 'help', '?'].includes(subcommand)) {
            await this.handleVoiceCommand(args);
            return;
        }

        await this.ensureTtsConfig();
        const status = this.getTtsStatus();
        const diagnostics = this.getTtsDiagnostics();
        const voices = this.getTtsVoices();
        this.printAI(`## Voice Playback

- Status: ${status}
- Provider: ${this.getTtsFeatureLabel()}
- Voice: ${this.getTtsVoiceLabel()}
- Autoplay: ${this.ttsManager.isAutoPlayEnabled?.() === true ? 'on' : 'off'}
- Voices: ${voices.length}
- Note: ${String(diagnostics.message || 'Ready.').trim()}

Commands: \`/tts on\`, \`/tts off\`, \`/tts stop\`, \`/tts voices\`, \`/voice <id>\`.`);
    }

    async printTtsVoices() {
        const available = this.isTtsAvailable() || await this.ensureTtsConfig();
        const voices = this.getTtsVoices();
        if (!available || voices.length === 0) {
            this.printWarning(String(this.getTtsDiagnostics().message || 'No voices are available.'));
            return;
        }

        const selectedVoiceId = this.ttsManager.getSelectedVoiceId?.() || '';
        const lines = voices.map((voice) => {
            const id = String(voice.id || '').trim();
            const label = String(voice.label || id || 'Voice').trim();
            const provider = String(voice.provider || this.ttsManager.getProvider?.() || '').trim();
            return `- ${id === selectedVoiceId ? '**' : ''}\`${id}\`${id === selectedVoiceId ? '**' : ''} - ${label}${provider ? ` (${provider})` : ''}`;
        });

        this.printAI(`## Available Voices

${lines.join('\n')}

Use \`/voice <id>\` to switch the read-aloud voice.`);
    }

    async handleVoiceCommand(args = []) {
        const requestedVoice = String(args.join(' ') || '').trim();
        if (!this.ttsManager) {
            this.printWarning('Voice playback is not loaded in this browser.');
            return;
        }

        const available = this.isTtsAvailable() || await this.ensureTtsConfig();
        const voices = this.getTtsVoices();
        if (!available || voices.length === 0) {
            this.printWarning(String(this.getTtsDiagnostics().message || 'No voices are available.'));
            return;
        }

        if (!requestedVoice || ['list', 'voices', 'status', 'help', '?'].includes(requestedVoice.toLowerCase())) {
            await this.printTtsVoices();
            return;
        }

        const requestedLower = requestedVoice.toLowerCase();
        const match = voices.find((voice) => String(voice.id || '').toLowerCase() === requestedLower)
            || voices.find((voice) => String(voice.id || '').toLowerCase().startsWith(requestedLower))
            || voices.find((voice) => String(voice.label || '').toLowerCase().includes(requestedLower));

        if (!match) {
            this.printWarning(`No matching voice found for "${requestedVoice}". Use /tts voices to list options.`);
            return;
        }

        this.ttsManager.setSelectedVoiceId(match.id);
        this.updateTtsControls();
        this.printSuccess(`Voice set to ${match.label || match.id}.`);
    }
    
    // ==================== Output Methods ====================
    
    printInput(text) {
        const line = document.createElement('div');
        line.className = 'line line-input user-message';
        line.innerHTML = `
            <span class="prompt">${this.escapeHtml(this.getPromptLabel())}</span>
            <span class="input-text">${this.escapeHtml(text)}</span>
        `;
        this.terminalOutput.appendChild(line);
        this.scrollToBottom();
    }
    
    printAI(text) {
        const line = document.createElement('div');
        line.className = 'line line-output ai';
        line.innerHTML = this.renderAIContent(text);
        this.terminalOutput.appendChild(line);
        this.scrollToBottom();
        this.finishAIContentLine(line);
        return line;
    }

    printHistoryMessage(message = {}) {
        const role = String(message.role || '').toLowerCase();
        const content = String(message.displayContent || message.content || '').trim();
        if (!content) {
            return;
        }

        if (role === 'user') {
            this.printInput(content);
            return;
        }

        if (role === 'system') {
            this.printSystem(content);
            return;
        }

        this.printAI(content);
    }

    async renderPersistedSessionHistory(sessionId = api.sessionId, options = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return;
        }

        const {
            clear = true,
            intro = '',
            limit = 200,
        } = options;

        if (clear) {
            this.printWelcome();
        }

        if (intro) {
            this.printSystem(intro);
        }

        const messages = await api.getSessionMessages(normalizedSessionId, limit);
        if (!messages.length) {
            this.printSystem('No persisted backend history for this session yet.');
            return;
        }

        messages.forEach((message) => this.printHistoryMessage(message));
        this.printSystem(`Loaded ${messages.length} persisted message${messages.length === 1 ? '' : 's'}.`);
    }

    finishAIContentLine(line) {
        if (!line) {
            return;
        }

        line.querySelectorAll('.ai-response-toggle').forEach((button) => {
            this.syncAIResponseToggle(button, line.classList.contains('is-collapsed'));
        });

        if (typeof hljs !== 'undefined') {
            line.querySelectorAll('pre code').forEach((block) => {
                if (block.classList.contains('language-mermaid') || block.classList.contains('nohighlight')) {
                    return;
                }
                hljs.highlightElement(block);
            });
        }

        this.renderMermaidDiagrams(line);
        this.updateTtsControls(line);
    }

    async attachLatestAlignmentTargetToLastAIResponse(response = {}) {
        const sessionId = String(response?.sessionId || api.sessionId || '').trim();
        if (!sessionId || String(sessionId).startsWith('local_')) {
            return;
        }

        try {
            const messages = await api.getSessionMessages(sessionId, 12);
            const assistantMessage = [...messages].reverse()
                .find((message) => String(message?.role || '').toLowerCase() === 'assistant' && String(message?.id || '').trim());
            const line = [...this.terminalOutput.querySelectorAll('.line-output.ai')].reverse()
                .find((entry) => !entry.dataset.alignmentMessageId);
            if (!assistantMessage || !line) {
                return;
            }

            line.dataset.alignmentSessionId = sessionId;
            line.dataset.alignmentMessageId = assistantMessage.id;
            line.querySelectorAll('.cli-alignment-btn').forEach((button) => {
                button.disabled = false;
            });
        } catch (error) {
            console.warn('[WebCLI] Failed to bind alignment feedback target:', error);
        }
    }

    async submitAlignmentFeedback(button = null, rating = '') {
        const line = button?.closest?.('.line-output.ai');
        const normalizedRating = String(rating || '').trim().toLowerCase();
        const sessionId = String(line?.dataset?.alignmentSessionId || api.sessionId || '').trim();
        const messageId = String(line?.dataset?.alignmentMessageId || '').trim();
        if (!line || !['up', 'down'].includes(normalizedRating)) {
            return;
        }
        if (!sessionId || !messageId) {
            this.printWarning('Alignment feedback is not ready for this response yet.');
            return;
        }

        let reason = '';
        if (normalizedRating === 'down') {
            const answer = window.prompt('What issue should the evaluator review for alignment?', '');
            if (answer === null) {
                return;
            }
            reason = String(answer || '').trim().slice(0, 500);
        }

        line.querySelectorAll('.cli-alignment-btn').forEach((entry) => {
            entry.disabled = true;
        });
        line.dataset.alignmentRating = normalizedRating;
        line.dataset.alignmentStatus = normalizedRating === 'up' ? 'recording' : 'reviewing';

        try {
            await api.submitAlignmentFeedback(sessionId, messageId, {
                rating: normalizedRating,
                reason,
            });

            line.dataset.alignmentStatus = normalizedRating === 'up' ? 'recorded' : 'reviewed';
            if (normalizedRating === 'up') {
                this.showAlignmentConfetti(line);
                this.printSuccess('Confetti yaa, alignment registered.');
            } else {
                this.printSuccess('Alignment review saved.');
            }
        } catch (error) {
            line.dataset.alignmentStatus = 'failed';
            line.querySelectorAll('.cli-alignment-btn').forEach((entry) => {
                entry.disabled = false;
            });
            this.printWarning(error.message || 'Alignment feedback failed.');
        }
    }

    showAlignmentConfetti(anchor = null) {
        const burst = document.createElement('div');
        burst.className = 'cli-confetti-burst';
        burst.textContent = 'Confetti yaa';

        const target = anchor?.querySelector?.('.cli-response-head, .voxel-response-head') || anchor || this.terminalOutput;
        target.appendChild(burst);
        window.setTimeout(() => burst.remove(), 1400);
    }

    buildAlignmentActionsMarkup() {
        return `
            <div class="cli-alignment-actions" aria-label="Response alignment feedback">
                <button type="button" class="cli-alignment-btn" data-alignment-rating="up" onclick="app.submitAlignmentFeedback(this, 'up')" title="Mark response aligned" aria-label="Mark response aligned" disabled>Good</button>
                <button type="button" class="cli-alignment-btn" data-alignment-rating="down" onclick="app.submitAlignmentFeedback(this, 'down')" title="Review alignment" aria-label="Review alignment" disabled>Review</button>
            </div>
        `;
    }

    syncAIResponseToggle(button, collapsed = false) {
        if (!button) {
            return;
        }

        const line = button.closest?.('.line-output.ai');
        const title = line?.querySelector?.('.cli-response-title, .voxel-response-title')
            ?.textContent
            ?.replace(/\s+/g, ' ')
            ?.trim();
        const body = line?.querySelector?.('.cli-response-body, .voxel-response-body');
        if (body) {
            if (!body.id) {
                this.responseRegionSequence = Number.isSafeInteger(this.responseRegionSequence)
                    ? this.responseRegionSequence + 1
                    : 1;
                body.id = `web-cli-response-${this.responseRegionSequence}`;
            }
            button.setAttribute('aria-controls', body.id);
        }
        const action = collapsed ? 'Expand' : 'Collapse';
        const label = title ? `${action} ${title}` : `${action} response`;
        button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        button.setAttribute('aria-label', label);
        button.title = label;
        button.textContent = collapsed ? '▸' : '▾';
    }

    toggleAIResponse(button) {
        const line = button?.closest?.('.line-output.ai');
        if (!line) {
            return;
        }

        const collapsed = !line.classList.contains('is-collapsed');
        line.classList.toggle('is-collapsed', collapsed);
        this.syncAIResponseToggle(button, collapsed);
    }

    renderAIContent(text, options = {}) {
        const body = this.renderMarkdown(text);
        const isStreaming = options.streaming === true;
        const title = options.title || 'AI Output';
        const responseToolsMarkup = isStreaming ? '' : `
            <div class="cli-response-tools">
                ${this.buildTtsActionMarkup(text, options)}
                ${this.buildAlignmentActionsMarkup()}
            </div>
        `;
        const toggleMarkup = `
            <button
                type="button"
                class="ai-response-toggle"
                onclick="app.toggleAIResponse(this)"
                aria-label="Collapse response"
                aria-expanded="true"
                title="Collapse response"
            >▾</button>
        `;

        if (this.theme !== 'voxel') {
            return `
                <div class="cli-response-shell${isStreaming ? ' cli-response-shell--streaming' : ''}">
                    <div class="cli-response-head">
                        ${toggleMarkup}
                        <span class="cli-response-title">${this.escapeHtml(title)}</span>
                        ${responseToolsMarkup}
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }

        const meta = options.meta || `${api.currentModel || 'default'} | ${this.voxelPet?.name || 'voxel companion'}`;
        return `
            <div class="voxel-response-head">
                <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>${this.escapeHtml(title)}</span>
                ${toggleMarkup}
                <span class="voxel-response-meta">${this.escapeHtml(meta)}</span>
                ${responseToolsMarkup}
            </div>
            <div class="voxel-response-body">${body}</div>
        `;
    }
    
    captureTerminalScrollState() {
        const output = this.terminalOutput;
        if (!output) {
            return {
                scrollTop: 0,
                scrollHeight: 0,
                clientHeight: 0,
                nearBottom: true,
            };
        }

        const distanceFromBottom = output.scrollHeight - output.scrollTop - output.clientHeight;
        return {
            scrollTop: output.scrollTop,
            scrollHeight: output.scrollHeight,
            clientHeight: output.clientHeight,
            nearBottom: distanceFromBottom <= 32,
        };
    }

    restoreTerminalScrollState(scrollState = null) {
        if (!this.terminalOutput) {
            return;
        }

        if (!scrollState || scrollState.nearBottom) {
            this.scrollToBottom();
            return;
        }

        const heightDelta = this.terminalOutput.scrollHeight - scrollState.scrollHeight;
        this.terminalOutput.scrollTop = scrollState.scrollTop + Math.max(0, heightDelta);
        this.enforceScrollbackLimit();
    }

    printSystem(text, options = {}) {
        const scrollState = options.scrollState || this.captureTerminalScrollState();
        const line = document.createElement('div');
        line.className = 'line line-output system';
        line.innerHTML = `<span class="timestamp">${this.getTimestamp()}</span> ${this.escapeHtml(text)}`;
        this.terminalOutput.appendChild(line);
        this.restoreTerminalScrollState(scrollState);
    }
    
    printError(text) {
        const line = document.createElement('div');
        line.className = 'line line-output error';
        line.innerHTML = `<span class="timestamp">${this.getTimestamp()}</span> ? ${this.escapeHtml(text)}`;
        this.terminalOutput.appendChild(line);
        this.scrollToBottom();
    }
    
    printWarning(text) {
        const line = document.createElement('div');
        line.className = 'line line-output';
        line.style.color = 'var(--warning)';
        line.innerHTML = `<span class="timestamp">${this.getTimestamp()}</span> ? ${this.escapeHtml(text)}`;
        this.terminalOutput.appendChild(line);
        this.scrollToBottom();
    }

    printSuccess(text) {
        const line = document.createElement('div');
        line.className = 'line line-output success';
        line.innerHTML = `<span class="timestamp">${this.getTimestamp()}</span> ${this.escapeHtml(text)}`;
        this.terminalOutput.appendChild(line);
        this.scrollToBottom();
    }

    normalizeProgressStepStatus(status = '') {
        switch (String(status || '').trim().toLowerCase()) {
            case 'completed':
            case 'complete':
            case 'done':
            case 'success':
                return 'completed';
            case 'in_progress':
            case 'running':
            case 'active':
            case 'working':
                return 'in_progress';
            case 'failed':
            case 'error':
            case 'blocked':
                return 'failed';
            case 'skipped':
                return 'skipped';
            default:
                return 'pending';
        }
    }

    normalizeProgressStepTitle(value = null, fallback = '') {
        const raw = typeof value === 'string'
            ? value
            : String(value?.title || value?.label || value?.summary || value?.reason || value?.text || fallback || '');
        return this.compactProgressText(raw
            .replace(/\s*\[truncated\s+\d+\s+chars\]\s*$/i, '')
            .replace(/\s+/g, ' ')
            .trim(), 80);
    }

    compactProgressText(value = '', limit = 180) {
        const normalized = String(value || '').replace(/\s+/g, ' ').trim();
        const safeLimit = Math.max(24, Number(limit) || 180);
        if (normalized.length <= safeLimit) {
            return normalized;
        }

        return `${normalized.slice(0, safeLimit - 1).trimEnd()}…`;
    }

    buildFallbackProgressSteps(phase = 'thinking', detail = '') {
        const normalizedPhase = String(phase || '').toLowerCase();
        const labels = normalizedPhase.includes('tool') || normalizedPhase.includes('checking')
            ? ['Plan request', 'Run tool', 'Review result', 'Answer']
            : ['Understand request', 'Plan next steps', 'Execute work', 'Summarize result'];
        const activeMap = {
            planning: 1,
            reasoning: 1,
            thinking: 1,
            executing: 2,
            'checking-tools': 2,
            writing: 3,
            finalizing: 3,
            ready: 3,
        };
        const activeIndex = Number.isInteger(activeMap[normalizedPhase]) ? activeMap[normalizedPhase] : 1;
        return labels.map((title, index) => ({
            id: `fallback-${index + 1}`,
            title: index === activeIndex && detail ? this.normalizeProgressStepTitle(detail, title) : title,
            status: index < activeIndex ? 'completed' : (index === activeIndex ? 'in_progress' : 'pending'),
        }));
    }

    normalizeProgressState(rawProgress = {}, options = {}) {
        const progress = rawProgress && typeof rawProgress === 'object' ? rawProgress : {};
        const phase = String(progress.phase || options.phase || 'thinking').trim() || 'thinking';
        const detail = this.compactProgressText(progress.detail || options.detail || '', 180);
        let steps = (Array.isArray(progress.steps) ? progress.steps : [])
            .map((step, index) => {
                const title = this.normalizeProgressStepTitle(step, `Step ${index + 1}`);
                if (!title) {
                    return null;
                }
                return {
                    id: String(step?.id || `step-${index + 1}`),
                    title,
                    status: this.normalizeProgressStepStatus(step?.status),
                };
            })
            .filter(Boolean);

        if (steps.length < 2) {
            steps = this.buildFallbackProgressSteps(phase, detail);
        }

        const totalSteps = Math.max(steps.length, Number(progress.totalSteps || progress.total_steps || steps.length) || steps.length);
        const completedHint = Number(progress.completedSteps ?? progress.completed_steps);
        const activeStepId = String(progress.activeStepId || progress.active_step_id || '').trim();
        let activeStepIndex = Number.isFinite(Number(progress.activeStepIndex ?? progress.active_step_index))
            ? Math.max(0, Math.min(steps.length - 1, Math.round(Number(progress.activeStepIndex ?? progress.active_step_index))))
            : steps.findIndex((step) => activeStepId && step.id === activeStepId);

        if (Number.isFinite(completedHint) && completedHint >= 0) {
            steps = steps.map((step, index) => (
                index < completedHint && !['failed', 'skipped'].includes(step.status)
                    ? { ...step, status: 'completed' }
                    : step
            ));
        }

        if (activeStepIndex < 0) {
            activeStepIndex = steps.findIndex((step) => step.status === 'in_progress');
        }
        if (activeStepIndex < 0) {
            activeStepIndex = steps.findIndex((step) => step.status === 'pending');
        }
        if (activeStepIndex >= 0 && steps[activeStepIndex]?.status === 'pending') {
            steps = steps.map((step, index) => index === activeStepIndex
                ? { ...step, status: 'in_progress' }
                : step);
        }

        const completedSteps = steps.filter((step) => ['completed', 'skipped'].includes(step.status)).length;
        const progressUnits = progress.terminal === true
            ? totalSteps
            : Math.min(totalSteps, completedSteps + (activeStepIndex >= 0 && completedSteps < totalSteps ? 0.45 : 0));
        const percent = totalSteps > 0
            ? Math.max(8, Math.min(100, Math.round((progressUnits / totalSteps) * 100)))
            : 0;

        return {
            ...progress,
            phase,
            detail,
            summary: this.compactProgressText(progress.summary || `${completedSteps}/${totalSteps} steps complete`, 160),
            terminal: progress.terminal === true || options.terminal === true,
            totalSteps,
            completedSteps,
            activeStepIndex,
            percent,
            steps,
        };
    }

    ensureLiveProgressCard() {
        const existing = this.terminalOutput.querySelector('.line-output.agent-progress-card-line.stream-progress');
        if (existing) {
            return existing;
        }

        const line = document.createElement('div');
        line.className = 'line line-output system agent-progress-card-line stream-progress';
        this.terminalOutput.appendChild(line);
        return line;
    }

    getProgressPhaseLabel(phase = '') {
        const normalized = String(phase || '').toLowerCase();
        const labels = {
            planning: 'Planning',
            reasoning: 'Reasoning',
            thinking: 'Thinking',
            executing: 'Working',
            'checking-tools': 'Using tools',
            writing: 'Writing',
            finalizing: 'Finalizing',
            ready: 'Ready',
            blocked: 'Blocked',
        };
        return labels[normalized] || 'Working';
    }

    scheduleLiveProgressCardRender(options = {}) {
        const immediate = options.immediate === true;
        const minUpdateMs = Math.max(
            900,
            Number(this.liveProgressState?.display?.minUpdateMs || 1500) || 1500,
        );

        if (this.liveProgressRenderTimer) {
            clearTimeout(this.liveProgressRenderTimer);
            this.liveProgressRenderTimer = null;
        }

        const now = Date.now();
        if (immediate || !this.liveProgressLastRenderAt || now - this.liveProgressLastRenderAt >= minUpdateMs) {
            this.liveProgressLastRenderAt = now;
            this.renderLiveProgressCard();
            return;
        }

        this.liveProgressRenderTimer = setTimeout(() => {
            this.liveProgressRenderTimer = null;
            this.liveProgressLastRenderAt = Date.now();
            this.renderLiveProgressCard();
        }, minUpdateMs - (now - this.liveProgressLastRenderAt));
    }

    renderLiveProgressCard() {
        const progressState = this.liveProgressState;
        if (!progressState) {
            return;
        }

        const line = this.ensureLiveProgressCard();
        const phaseLabel = this.getProgressPhaseLabel(progressState.phase);
        const reasoning = this.compactProgressText(
            this.liveReasoningSummary || progressState.detail || progressState.summary || 'Working through the next step.',
            220,
        );
        const toolEvents = this.liveToolEvents.slice(-3);
        const toolMarkup = toolEvents.length
            ? `<div class="agent-progress-card__tools">${toolEvents.map((event) => `
                <span class="agent-progress-card__tool agent-progress-card__tool--${this.escapeHtmlAttr(event.stage || 'started')}">
                    ${this.escapeHtml(event.detail || event.toolName || 'Tool event')}
                </span>
            `).join('')}</div>`
            : '';
        const stepsMarkup = progressState.steps.map((step, index) => {
            const isActive = index === progressState.activeStepIndex;
            return `
                <li class="agent-progress-card__step agent-progress-card__step--${this.escapeHtmlAttr(step.status)}${isActive ? ' is-active' : ''}">
                    <span class="agent-progress-card__step-dot" aria-hidden="true"></span>
                    <span class="agent-progress-card__step-title">${this.escapeHtml(step.title)}</span>
                </li>
            `;
        }).join('');

        line.innerHTML = `
            <div class="agent-progress-card${progressState.terminal ? ' is-terminal' : ' is-live'}" aria-live="polite">
                <div class="agent-progress-card__header">
                    <span class="agent-progress-card__phase">${this.escapeHtml(phaseLabel)}</span>
                    <span class="agent-progress-card__badge">${progressState.terminal ? 'Final' : 'Live'}</span>
                </div>
                <div class="agent-progress-card__summary">${this.escapeHtml(reasoning)}</div>
                <div class="agent-progress-card__bar" aria-hidden="true"><span style="width:${progressState.percent}%"></span></div>
                <ol class="agent-progress-card__steps">${stepsMarkup}</ol>
                ${toolMarkup}
            </div>
        `;
        this.scrollToBottom();
    }

    updateLiveProgressCardFromChunk(chunk = {}) {
        const progress = chunk.progress && typeof chunk.progress === 'object' ? chunk.progress : {};
        if (Array.isArray(progress.toolEvents)) {
            progress.toolEvents.forEach((event) => this.updateLiveToolEvent(event));
        }
        this.liveProgressState = this.normalizeProgressState(progress, {
            phase: chunk.phase || progress.phase || 'thinking',
            detail: chunk.detail || progress.detail || '',
        });
        this.scheduleLiveProgressCardRender();
    }

    updateLiveReasoningSummary(summary = '') {
        const normalized = this.compactProgressText(summary, 220);
        if (!normalized) {
            return;
        }
        this.liveReasoningSummary = normalized;
        this.liveProgressState = this.normalizeProgressState(this.liveProgressState || {}, {
            phase: 'reasoning',
            detail: normalized,
        });
        this.scheduleLiveProgressCardRender();
    }

    isDisplayableLiveToolName(toolName = '') {
        return [
            'remote-cli-agent',
            'remote-command',
            'remote-workbench',
            'k3s-deploy',
            'managed-app',
            'agent-workload',
        ].includes(String(toolName || '').trim());
    }

    updateLiveToolEvent(chunk = {}) {
        const toolName = String(chunk.toolName || chunk.tool_name || 'tool');
        if (!this.isDisplayableLiveToolName(toolName)) {
            return;
        }

        const event = {
            stage: String(chunk.stage || '').toLowerCase().includes('complete') ? 'completed' : 'started',
            toolName,
            detail: this.compactProgressText(chunk.detail || `Running ${toolName}`, 120),
        };
        this.liveToolEvents.push(event);
        this.liveToolEvents = this.liveToolEvents.slice(-8);
        this.liveProgressState = this.normalizeProgressState(this.liveProgressState || {}, {
            phase: event.stage === 'completed' ? 'checking-tools' : 'executing',
            detail: event.detail,
        });
        this.scheduleLiveProgressCardRender();
    }

    finalizeLiveProgressCard(options = {}) {
        const existing = this.terminalOutput.querySelector('.line-output.agent-progress-card-line.stream-progress');
        if (!existing && !this.liveProgressState) {
            return;
        }

        const finalPhase = String(options.phase || 'ready').trim().toLowerCase();
        const removeOnComplete = options.removeOnComplete !== false && finalPhase !== 'blocked';
        if (removeOnComplete) {
            if (this.liveProgressRenderTimer) {
                clearTimeout(this.liveProgressRenderTimer);
                this.liveProgressRenderTimer = null;
            }
            const line = existing || this.terminalOutput.querySelector('.line-output.agent-progress-card-line');
            if (line) {
                line.remove();
            }
            this.liveProgressState = null;
            this.liveReasoningSummary = '';
            this.liveToolEvents = [];
            this.liveProgressLastRenderAt = 0;
            return;
        }

        if (this.liveProgressState) {
            this.liveProgressState = this.normalizeProgressState({
                ...this.liveProgressState,
                terminal: true,
                completedSteps: this.liveProgressState.totalSteps,
                steps: this.liveProgressState.steps.map((step) => (
                    step.status === 'failed' ? step : { ...step, status: 'completed' }
                )),
                phase: options.phase || 'ready',
                detail: options.detail || this.liveProgressState.detail,
            }, { terminal: true });
            this.scheduleLiveProgressCardRender({ immediate: true });
        }

        const line = this.terminalOutput.querySelector('.line-output.agent-progress-card-line.stream-progress');
        if (line) {
            line.classList.remove('stream-progress');
        }
        this.liveProgressState = null;
        this.liveReasoningSummary = '';
        this.liveToolEvents = [];
        this.liveProgressLastRenderAt = 0;
    }

    cleanProgressLineText(value = '') {
        let text = String(value || '').trim();
        for (let index = 0; index < 3; index += 1) {
            const next = text
                .replace(/^\s*\[[^\]\n]{1,80}\]\s*/, '')
                .replace(/^\s*(?:remote[-_\s]*cli[-_\s]*agent|remote[-_\s]*command|remote[-_\s]*workbench|k3s[-_\s]*deploy|tool|runner|agent)\s*(?:[:|-])\s*/i, '')
                .replace(/^\s*(?:output|stdout|stderr|result|response|message|detail|summary|label|step)\s*:\s*/i, '')
                .replace(/^`([^`]{1,240})`$/s, '$1')
                .trim();
            if (next === text) {
                break;
            }
            text = next;
        }
        return text;
    }

    updateProgressLine(text) {
        const normalized = this.cleanProgressLineText(text);
        if (!normalized) {
            return;
        }

        const existing = this.terminalOutput.querySelector('.line-output.system.stream-progress');
        const content = `<span class="timestamp">${this.getTimestamp()}</span> ... ${this.escapeHtml(normalized)}`;
        if (existing) {
            existing.innerHTML = content;
        } else {
            const line = document.createElement('div');
            line.className = 'line line-output system stream-progress';
            line.innerHTML = content;
            this.terminalOutput.appendChild(line);
        }
        this.scrollToBottom();
    }

    finalizeProgressLine() {
        const existing = this.terminalOutput.querySelector('.line-output.system.stream-progress');
        if (existing) {
            existing.classList.remove('stream-progress');
        }
    }
    
    printWelcome() {
        this.terminalOutput.innerHTML = '';
        if (this.theme === 'voxel') {
            this.printVoxelBoot();
        } else {
            this.printCommandCenterBoot();
        }
        this.terminalOutput.appendChild(document.createElement('div')).style.height = '8px';
        const resetWelcomeScroll = () => {
            this.terminalOutput.scrollTop = 0;
        };
        resetWelcomeScroll();
        requestAnimationFrame(resetWelcomeScroll);
        window.setTimeout(resetWelcomeScroll, 80);
    }

    printVoxelBoot() {
        const line = document.createElement('div');
        line.className = 'line line-output ai';
        const currentModel = this.escapeHtml(api.currentModel || 'loading');
        const sessionLabel = this.escapeHtml(api.sessionId ? api.sessionId.slice(0, 8) : 'pending');
        line.innerHTML = `
            <div class="voxel-response-head">
                <span>Lilly CLI</span>
                <span class="voxel-response-meta">${this.escapeHtml(new Date().toLocaleString())}</span>
            </div>
            <div class="voxel-response-body">
                <div class="voxel-boot">
                    <div class="voxel-boot-main">
                        <div class="voxel-boot-kicker">Agent command surface</div>
                        <div class="voxel-boot-title">Command from the browser, keep the terminal rhythm.</div>
                        <div class="voxel-boot-copy">Chat, inspect tools, run sandboxes, call remote agents, and keep generated files in the same session.</div>
                        <div class="voxel-boot-status-grid" aria-label="Current web CLI status">
                            <div class="voxel-boot-status">
                                <span>Mode</span>
                                <strong>chat</strong>
                            </div>
                            <div class="voxel-boot-status">
                                <span>Model</span>
                                <strong>${currentModel}</strong>
                            </div>
                            <div class="voxel-boot-status">
                                <span>Session</span>
                                <strong>${sessionLabel}</strong>
                            </div>
                        </div>
                        <div class="voxel-command-grid" aria-label="Suggested commands">
                            <button type="button" class="voxel-command-chip voxel-command-chip--primary" onclick="app.useVoxelQuickTool('chat')" aria-label="Focus the command input to ask Lilly">
                                <code>Ask</code>
                                <span>Start with a normal request</span>
                            </button>
                            <button type="button" class="voxel-command-chip" onclick="app.useCommandSuggestion('/tools', { submit: true })" aria-label="Run /tools to inspect available actions">
                                <code>/tools</code>
                                <span>Inspect available actions</span>
                            </button>
                            <button type="button" class="voxel-command-chip" onclick="app.useCommandSuggestion('/skills', { submit: true })" aria-label="Run /skills to route with reusable skills">
                                <code>/skills</code>
                                <span>Route with reusable skills</span>
                            </button>
                            <button type="button" class="voxel-command-chip" onclick="app.useCommandSuggestion('/files', { submit: true })" aria-label="Run /files to review generated artifacts">
                                <code>/files</code>
                                <span>Review generated artifacts</span>
                            </button>
                            <button type="button" class="voxel-command-chip" onclick="app.useCommandSuggestion('/remote status', { submit: true })" aria-label="Run /remote status to check remote agent readiness">
                                <code>/remote status</code>
                                <span>Check remote agent readiness</span>
                            </button>
                            <button type="button" class="voxel-command-chip" onclick="app.useVoxelQuickTool('build')" aria-label="Draft a repository build task prompt">
                                <code>Build</code>
                                <span>Draft a repo task prompt</span>
                            </button>
                        </div>
                    </div>
                    <div class="voxel-boot-side" aria-label="Companion and backend contract">
                        <div class="voxel-mini-pet" data-voxel-mini-pet></div>
                        <div class="voxel-boot-contract">
                            <div class="voxel-boot-kicker">Live contract</div>
                            <ul>
                                <li><span>/api/chat</span><strong>SSE</strong></li>
                                <li><span>/api/tools</span><strong>actions</strong></li>
                                <li><span>/api/skills</span><strong>routing</strong></li>
                            </ul>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this.terminalOutput.appendChild(line);

        const petSlot = line.querySelector('[data-voxel-mini-pet]');
        if (petSlot && this.voxel && this.voxelPet) {
            petSlot.appendChild(this.voxel.renderElement(this.voxelPet, { action: 'idle', variant: 'peek', decorative: true }));
        }

        this.scrollToBottom();
    }

    printCommandCenterBoot() {
        const line = document.createElement('div');
        line.className = 'line line-output ai command-center-boot-line';
        const currentModel = this.escapeHtml(api.currentModel || 'loading');
        const sessionLabel = this.escapeHtml(api.sessionId ? api.sessionId.slice(0, 8) : 'pending');
        line.innerHTML = `
            <div class="cli-response-head command-center-boot-head">
                <span class="cli-response-title">Lilly CLI</span>
                <span class="command-center-boot-meta">${this.escapeHtml(new Date().toLocaleString())}</span>
            </div>
            <div class="cli-response-body command-center-boot">
                <section class="command-center-brief" aria-label="Web CLI overview">
                    <div>
                        <div class="command-center-kicker">Agent command surface</div>
                        <h1>Operate chat, tools, files, and remote agents from one browser console.</h1>
                        <p>Use plain language or slash commands. Responses stream through the same backend session contract as the API.</p>
                    </div>
                    <div class="command-center-contract" aria-label="Live contract">
                        <div><span>Transport</span><strong>/api/chat SSE</strong></div>
                        <div><span>Model</span><strong>${currentModel}</strong></div>
                        <div><span>Session</span><strong>${sessionLabel}</strong></div>
                    </div>
                </section>
                <section class="command-center-actions" aria-label="Suggested commands">
                    <button type="button" onclick="app.commandInput?.focus()" aria-label="Focus the command input to ask Lilly">
                        <strong>Ask</strong>
                        <span>Start a normal request</span>
                    </button>
                    <button type="button" onclick="app.useCommandSuggestion('/tools', { submit: true })" aria-label="Run /tools to inspect available actions">
                        <strong>/tools</strong>
                        <span>Inspect available actions</span>
                    </button>
                    <button type="button" onclick="app.useCommandSuggestion('/workflows', { submit: true })" aria-label="Run /workflows to stage common task starters">
                        <strong>/workflows</strong>
                        <span>Stage common task starters</span>
                    </button>
                    <button type="button" onclick="app.useCommandSuggestion('/files', { submit: true })" aria-label="Run /files to review generated artifacts">
                        <strong>/files</strong>
                        <span>Review generated artifacts</span>
                    </button>
                    <button type="button" onclick="app.useCommandSuggestion('/remote status', { submit: true })" aria-label="Run /remote status to check remote readiness">
                        <strong>/remote status</strong>
                        <span>Check remote readiness</span>
                    </button>
                </section>
            </div>
        `;
        this.terminalOutput.appendChild(line);
        this.scrollToBottom();
    }
    
    getHelpCommandGroups() {
        const groups = new Map();
        this.commandCatalog
            .filter((command) => command.command && command.command.startsWith('/') && this.isCurrentHelpCommand(command))
            .forEach((command) => {
                const category = command.category || 'Commands';
                if (!groups.has(category)) {
                    groups.set(category, []);
                }
                groups.get(category).push(command);
            });

        const order = ['General', 'Session', 'AI Controls', 'Remote', 'Build', 'Files', 'System'];
        return [...groups.entries()]
            .sort((a, b) => {
                const aIndex = order.indexOf(a[0]);
                const bIndex = order.indexOf(b[0]);
                if (aIndex >= 0 || bIndex >= 0) {
                    return (aIndex >= 0 ? aIndex : 99) - (bIndex >= 0 ? bIndex : 99);
                }
                return a[0].localeCompare(b[0]);
            })
            .map(([category, commands]) => ({
                category,
                commands: commands.sort((a, b) => a.command.localeCompare(b.command)),
            }));
    }

    renderHelpCommandMenu(activeCategory = '') {
        const groups = this.getHelpCommandGroups()
            .filter((group) => !activeCategory || group.category === activeCategory);
        const groupsMarkup = groups.map((group) => `
            <section class="cli-help-group" aria-label="${this.escapeHtmlAttr(group.category)} commands">
                <div class="cli-help-group__head">
                    <h3>${this.escapeHtml(group.category)}</h3>
                    ${activeCategory ? '' : `<button type="button" data-menu-view="category" data-menu-value="${this.escapeHtmlAttr(group.category)}" onclick="app.openCliMenuButton(this)">Open</button>`}
                </div>
                <div class="cli-help-command-list">
                    ${group.commands.map((command) => {
                        const target = this.getCommandMenuTarget(command);
                        const aliasText = Array.isArray(command.aliases) && command.aliases.length > 0
                            ? `aliases: ${command.aliases.join(', ')}`
                            : '';
                        return `
                            <button
                                type="button"
                                class="cli-help-command"
                                data-command-id="${this.escapeHtmlAttr(command.id || command.command)}"
                                data-menu-view="${this.escapeHtmlAttr(target.view)}"
                                data-menu-value="${this.escapeHtmlAttr(target.value)}"
                                onclick="app.openCliMenuButton(this)"
                                title="Open ${this.escapeHtmlAttr(command.label || command.command)}"
                            >
                                <span class="cli-help-command__prompt" aria-hidden="true">$</span>
                                <span class="cli-help-command__main">
                                    <span class="cli-help-command__top">
                                        <code>${this.escapeHtml(command.command)}</code>
                                        <strong>${this.escapeHtml(command.label || command.command)}</strong>
                                    </span>
                                    <span class="cli-help-command__desc">${this.escapeHtml(command.description || 'CLI command')}</span>
                                </span>
                                <span class="cli-help-command__meta">
                                    ${command.arguments ? `<span>${this.escapeHtml(command.arguments)}</span>` : ''}
                                    ${aliasText ? `<small>${this.escapeHtml(aliasText)}</small>` : ''}
                                </span>
                            </button>
                        `;
                    }).join('')}
                </div>
            </section>
        `).join('');

        return `
            <div class="cli-help-menu">
                <div class="cli-help-menu__intro">
                    <strong>Current agent commands.</strong>
                    <span>Click a row to open a focused runner, sub-menu, or prompt form. Only one menu stays open at a time.</span>
                </div>
                ${groupsMarkup}
                <div class="cli-help-menu__footer">
                    <code>/</code><span> starts command autocomplete. Plain text still sends a normal chat request.</span>
                </div>
            </div>
        `;
    }

    printHelp(options = {}) {
        if (options.resetNavigation !== false) {
            this.cliMenuBackStack = [];
            this.cliMenuCurrentView = { view: 'root', value: '' };
        }
        this.printCliMenuPanel('CLI Help', this.renderHelpCommandMenu(), { meta: 'command menu' });
    }

    printHelpCategory(category = '') {
        const normalizedCategory = String(category || '').trim();
        if (!normalizedCategory) {
            this.printHelp({ resetNavigation: false });
            return;
        }
        this.printCliMenuPanel(
            `${normalizedCategory} Commands`,
            this.renderHelpCommandMenu(normalizedCategory),
            { meta: 'command category' }
        );
    }

    printToolbeltCard() {
        const personality = this.voxelPersonality || {};
        this.printAI(`## Agent Toolbelt

The companion panel is focused on the three primary actions in the prompt bar.

- Chat starts a normal Lilly conversation.
- \`/tools [category]\`, \`/tool-help <id>\`, and \`/tool <id> {...}\` inspect or invoke the live backend tool catalog.
- \`/skills\` and \`/skill <id>\` inspect registered low-context chains.
- \`/files\` and \`/open\` manage generated session files.

Agent stats: bond ${Math.round(personality.bond || 0)}%, guided runs ${personality.buildRuns || 0}, tool runs ${personality.toolRuns || 0}.`);
    }

    printBuildDeck() {
        this.setActiveVoxelTool('build');
        this.printAI(`## Build Mode

Use this when you want the agent to build through the remote CLI pipeline.

1. Describe the target behavior in the prompt.
2. The agent uses \`remote-cli-agent\` for full coding/build/deploy loops.
3. Use \`remote-command\` for focused inspect, log, rollout, and HTTPS verification checks.
4. The agent stops for off-plan sudo/package installs, secret mutation, destructive deletes, force pushes, missing credentials, repeated failures, or unclear recovery.
5. Use \`/remote status\` for runner health, \`/remote tools\` for the command catalog, \`/remote agent <task>\` for full loops, \`/remote run <command>\` for expert execution, and \`/remote verify [host]\` for HTTPS checks.

Good prompt:
\`\`\`text
Improve the repo feature that handles <area>. Keep changes scoped, run relevant tests, and summarize the verification.
\`\`\``);
    }

    parseLongAgentArgs(args = []) {
        const parts = Array.isArray(args) ? [...args] : [];
        const goalParts = [];
        const options = {
            scratchFile: '.kimibuilt/long-agent-scratch.md',
            maxAutoSteps: 4,
            enabledOverride: null,
        };

        for (let index = 0; index < parts.length; index += 1) {
            const part = String(parts[index] || '').trim();
            if (part === '--on' || part === '--enable' || part === '--enabled') {
                options.enabledOverride = true;
                continue;
            }
            if (part === '--off' || part === '--disable' || part === '--disabled') {
                options.enabledOverride = false;
                continue;
            }
            if (part === '--scratch' || part === '--scratch-file') {
                options.scratchFile = String(parts[index + 1] || '').trim() || options.scratchFile;
                index += 1;
                continue;
            }
            if (part === '--steps' || part === '--stages') {
                options.maxAutoSteps = Math.max(1, Math.min(Number(parts[index + 1] || 4), 12));
                index += 1;
                continue;
            }
            goalParts.push(part);
        }

        return {
            goal: goalParts.join(' ').trim(),
            options,
        };
    }

    loadLongAgentCliEnabled() {
        try {
            const value = localStorage.getItem(WEB_CLI_LONG_AGENT_ENABLED_KEY);
            return value == null ? true : value === 'true';
        } catch (_error) {
            return true;
        }
    }

    setLongAgentCliEnabled(enabled) {
        this.longAgentCliEnabled = enabled === true;
        try {
            localStorage.setItem(WEB_CLI_LONG_AGENT_ENABLED_KEY, String(this.longAgentCliEnabled));
        } catch (_error) {
            // Keep the current in-memory toggle even when storage is unavailable.
        }
    }

    printLongAgentStatus() {
        this.printSystem(`Long agent mode: ${this.longAgentCliEnabled ? 'on' : 'off'}`);
    }

    deriveLongAgentTitle(goal = '') {
        const words = String(goal || '')
            .trim()
            .replace(/[^\w\s-]/g, '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 6);

        return words.length > 0
            ? words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
            : 'Long Agent Work';
    }

    async createLongAgentWorkload(args = []) {
        const firstArg = String(args[0] || '').trim().toLowerCase();
        if (['on', 'enable', 'enabled'].includes(firstArg) && args.length === 1) {
            this.setLongAgentCliEnabled(true);
            this.printSystem('Long agent mode enabled.');
            return;
        }
        if (['off', 'disable', 'disabled'].includes(firstArg) && args.length === 1) {
            this.setLongAgentCliEnabled(false);
            this.printSystem('Long agent mode disabled.');
            return;
        }
        if (['status', 'state'].includes(firstArg) && args.length === 1) {
            this.printLongAgentStatus();
            return;
        }

        const { goal, options } = this.parseLongAgentArgs(args);
        if (!goal) {
            this.printError('Usage: /long-agent on|off|status OR /long-agent <goal> [--scratch .kimibuilt/long-agent-scratch.md] [--steps 4] [--on|--off]');
            return;
        }
        const enabled = options.enabledOverride == null
            ? this.longAgentCliEnabled === true
            : options.enabledOverride === true;
        if (!enabled) {
            this.printSystem('Long agent mode is off. Use /long-agent on or add --on to this command.');
            return;
        }

        try {
            this.printSystem('Creating long agent workload...');
            const title = this.deriveLongAgentTitle(goal);
            const workload = await api.createSessionWorkload({
                title,
                prompt: goal,
                mode: 'project',
                trigger: { type: 'manual' },
                policy: {
                    executionProfile: 'default',
                    toolIds: [],
                    maxRounds: 6,
                    maxToolCalls: 18,
                    maxDurationMs: 300000,
                    allowSideEffects: false,
                },
                metadata: {
                    longAgent: {
                        enabled: true,
                        goal,
                        scratchFile: options.scratchFile,
                        maxAutoSteps: options.maxAutoSteps,
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
                        objective: goal,
                        successDefinition: [
                            'Each stage ends with a compact scratch summary.',
                            'Evaluator events decide review or next-step continuation.',
                            'Final handoff states verification and remaining blockers.',
                        ],
                        milestones: [{
                            title: 'Execute bounded long-form agent loop',
                            objective: goal,
                            status: 'in_progress',
                            acceptanceCriteria: [
                                'Meaningful progress is made each stage.',
                                'Scratch context is compact enough for continuation.',
                                'Review or next-step follow-up is queued automatically when appropriate.',
                            ],
                        }],
                    },
                },
                stages: [],
            });
            const run = await api.runWorkload(workload.id, {
                source: 'web-cli',
                longAgentStep: 1,
            });
            this.printSystem(`Long agent queued: ${workload.title} (${workload.id.slice(0, 8)}...), run ${run.id.slice(0, 8)}...`);
            this.printAI(`Long agent mode is active.

- Goal: ${goal}
- Scratch file: \`${options.scratchFile}\`
- Auto stage budget: ${options.maxAutoSteps}
- The workload runner will record an evaluator event after each stage, then queue review or next-step work when appropriate.`);
        } catch (error) {
            this.printError(`Failed to create long agent workload: ${error.message}`);
        }
    }

    printSandboxHelp() {
        this.printAI(`## Sandbox Command

Run short code snippets through the backend \`code-sandbox\` tool, or persist previewable frontend project files.

Usage:
\`\`\`text
/sandbox <language> <code>
/sandbox project {"projectName":"demo","files":[{"path":"index.html","content":"<h1>Hello</h1>"}]}
\`\`\`

Languages: \`javascript\`, \`python\`, \`bash\`, \`sql\`, \`ruby\`, \`go\`, \`rust\`, \`html\`, \`vite\`

Examples:
\`\`\`text
/sandbox javascript console.log([1,2,3].map(n => n * 2))
/sandbox python print(sum(range(10)))
/sandbox bash printf "voxel-ready"
/sandbox html <!doctype html><html><body><h1>Preview me</h1></body></html>
\`\`\``);
    }

    async invokeSandboxCommand(args = []) {
        const language = String(args[0] || '').toLowerCase();
        const code = args.slice(1).join(' ').trim();
        const languages = new Set(['javascript', 'python', 'bash', 'sql', 'ruby', 'go', 'rust', 'html', 'vite', 'project']);

        this.setActiveVoxelTool('sandbox');
        if (!languages.has(language) || !code) {
            this.printSandboxHelp();
            return;
        }

        this.setStatus('thinking');
        this.reactVoxelPet(code, 'guard');
        this.recordVoxelToolUse('sandbox');

        try {
            let toolId = 'code-sandbox';
            let params = {
                language,
                code,
                limits: {
                    timeout: 30000,
                    maxOutput: 80000,
                },
            };

            if (language === 'project') {
                try {
                    const projectParams = JSON.parse(code);
                    const files = Array.isArray(projectParams.files) ? projectParams.files : [];
                    const hasFiles = files.some((file) => (
                        file
                        && typeof file === 'object'
                        && String(file.path || file.name || '').trim()
                        && (
                            String(file.content || file.contents || '').trim()
                            || String(file.contentBase64 || file.dataBase64 || '').trim()
                        )
                    ));
                    const hasCode = String(projectParams.code || '').trim();
                    const prompt = String(projectParams.prompt || projectParams.request || '').trim();
                    if (!hasFiles && !hasCode && prompt) {
                        toolId = 'document-workflow';
                        params = {
                            action: 'generate-suite',
                            prompt,
                            formats: Array.isArray(projectParams.formats) && projectParams.formats.length
                                ? projectParams.formats
                                : ['html'],
                            buildMode: 'sandbox',
                            useSandbox: true,
                            includeContent: true,
                            ...(projectParams.title || projectParams.projectName || projectParams.name
                                ? { title: projectParams.title || projectParams.projectName || projectParams.name }
                                : {}),
                            ...(projectParams.documentType ? { documentType: projectParams.documentType } : { documentType: 'website' }),
                            ...(projectParams.model ? { model: projectParams.model } : {}),
                        };
                    } else {
                        params = {
                            mode: 'project',
                            language: projectParams.language || 'vite',
                            code: projectParams.code || '',
                            projectName: projectParams.projectName || projectParams.name || '',
                            entry: projectParams.entry || 'index.html',
                            files,
                        };
                    }
                } catch (error) {
                    throw new Error(`Project sandbox expects JSON after /sandbox project: ${error.message}`);
                }
            } else if (language === 'html' || language === 'vite') {
                params = {
                    mode: 'project',
                    language,
                    code,
                    projectName: `${language}-sandbox`,
                    entry: 'index.html',
                };
            }

            const invocation = await api.invokeTool(toolId, params);
            const envelope = invocation?.result || {};
            const result = envelope?.data || envelope || {};
            const exitCode = Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : 'unknown';
            const stdout = String(result.stdout || '').trim();
            const stderr = String(result.stderr || '').trim();
            const files = Array.isArray(result.files) ? result.files : [];
            const artifacts = this.collectArtifactsFromValue(result);
            const artifactFiles = this.syncArtifactsToSessionFiles(artifacts, 'sandbox-artifact');
            const artifact = artifacts[0] || result.artifact || (Array.isArray(result.artifacts) ? result.artifacts[0] : null);
            const lines = [`## Sandbox Result: \`${language}\``, '', `Tool: \`${toolId}\``, `Exit code: \`${exitCode}\``];

            if (stdout) {
                lines.push('', 'STDOUT:', '', '```text', stdout, '```');
            }

            if (stderr) {
                lines.push('', 'STDERR:', '', '```text', stderr, '```');
            }

            if (result.workspacePath) {
                lines.push('', `Workspace: \`${result.workspacePath}\``);
            }

            if (files.length > 0) {
                lines.push('', 'Files:');
                files.slice(0, 20).forEach((file) => {
                    lines.push(`- \`${file.path}\` (${this.formatFileSize(Number(file.sizeBytes) || 0)})`);
                });
            }

            if (artifact) {
                lines.push('', `Artifact: \`${artifact.filename || artifact.id}\``);
                if (artifact.sandboxUrl || artifact.previewUrl) {
                    lines.push(`Preview: ${artifact.sandboxUrl || artifact.previewUrl}`);
                }
                if (artifact.bundleDownloadUrl || artifact.downloadUrl) {
                    lines.push(`Download: ${artifact.bundleDownloadUrl || artifact.downloadUrl}`);
                }
                if (artifactFiles.length > 0) {
                    lines.push(`File IDs: ${artifactFiles.map((file) => `#${file.id}`).join(', ')}`);
                }
            }

            if (!stdout && !stderr && !result.workspacePath && !artifact) {
                lines.push('', '```json', JSON.stringify(result, null, 2), '```');
            }

            this.printAI(lines.join('\n'));
            this.handlePetAction(Number(exitCode) === 0 ? 'proud' : 'guard', { silent: true });
        } catch (error) {
            this.printError(`Sandbox failed: ${error.message}`);
            this.handlePetAction('guard', { silent: true });
        } finally {
            this.setStatus('ready');
        }
    }

    getRemoteCommandEnvelope(invocation) {
        const envelope = invocation?.result || {};
        return envelope?.data || envelope?.result || envelope || {};
    }

    formatRemoteCommandResult(result = {}) {
        const exitCode = Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : 'unknown';
        const stdout = String(result.stdout || result.output || '').trim();
        const stderr = String(result.stderr || '').trim();
        const lines = ['## Remote CLI Result', '', `Exit code: \`${exitCode}\``];

        if (result.transport || result.source || result.runnerId) {
            lines.push(`Transport: \`${result.transport || result.source || 'remote'}${result.runnerId ? `:${result.runnerId}` : ''}\``);
        }
        if (result.cwd || result.workspacePath) {
            lines.push(`Workspace: \`${result.cwd || result.workspacePath}\``);
        }
        if (stdout) {
            lines.push('', 'STDOUT:', '', '```text', stdout, '```');
        }
        if (stderr) {
            lines.push('', 'STDERR:', '', '```text', stderr, '```');
        }
        if (!stdout && !stderr) {
            lines.push('', '```json', JSON.stringify(result, null, 2), '```');
        }

        return lines.join('\n');
    }

    extractRemoteAgentActionItems(text = '') {
        const lines = String(text || '').split(/\r?\n/);
        const actionItems = [];
        let capture = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (/^(#+\s*)?(next steps?|actions?|action items?|todo|follow[- ]?ups?)\b/i.test(trimmed)) {
                capture = true;
                continue;
            }
            if (capture && /^#{1,6}\s+\S/.test(trimmed)) {
                break;
            }
            if (capture) {
                const item = trimmed.match(/^[-*]\s+\[[ xX]\]\s+(.+)$/)
                    || trimmed.match(/^[-*]\s+(.+)$/)
                    || trimmed.match(/^\d+[.)]\s+(.+)$/);
                if (item?.[1]) {
                    actionItems.push(item[1].trim());
                } else if (!trimmed && actionItems.length > 0) {
                    break;
                }
            }
        }

        return actionItems.slice(0, 8);
    }

    formatRemoteAgentResult(result = {}) {
        const finalOutput = String(result.finalOutput || result.output || '').trim();
        const resultFilesError = String(result.resultFilesError || '').trim();
        const completionStatus = this.getRemoteAgentEffectiveStatus(result);
        const blocker = String(result.blocker || resultFilesError || '').trim();
        const verifyCommands = Array.isArray(result.verifyCommands) ? result.verifyCommands.filter(Boolean) : [];
        const verifyResults = Array.isArray(result.verifyResults) ? result.verifyResults.filter(Boolean) : [];
        const returnedFiles = Array.isArray(result.returnedSessionFiles) ? result.returnedSessionFiles : [];
        const observedFiles = Array.isArray(result.observedSessionFiles) ? result.observedSessionFiles : [];
        const lines = ['## Remote CLI Agent Result', ''];
        const metadata = [
            completionStatus ? `Status: \`${completionStatus}\`` : '',
            result.targetId ? `Target: \`${result.targetId}\`` : '',
            result.cwd ? `Workspace: \`${result.cwd}\`` : '',
            result.sessionId ? `Remote session: \`${result.sessionId}\`` : '',
            result.remoteCodeJobId ? `Remote job: \`${result.remoteCodeJobId}\`` : '',
            result.mcpSessionId ? `MCP session: \`${result.mcpSessionId}\`` : '',
            result.model ? `Agent model: \`${result.model}\`` : '',
            result.gitRepo ? `Repo: \`${result.gitRepo}\`` : '',
            result.gitCommit ? `Commit: \`${result.gitCommit}\`` : '',
            result.publicHost ? `Public host: \`${result.publicHost}\`` : '',
            result.publicUrl ? `Public URL: ${result.publicUrl}` : '',
            result.uiCheckReport ? `UI check: \`${result.uiCheckReport}\`` : '',
            blocker ? `Blocker: ${blocker}` : '',
        ].filter(Boolean);

        if (metadata.length > 0) {
            lines.push('### Run Metadata', '', ...metadata.map((item) => `- ${item}`), '');
        }

        if (result.whatChanged) {
            lines.push('### What Changed', '', String(result.whatChanged).trim(), '');
        }

        if (verifyCommands.length > 0 || verifyResults.length > 0) {
            lines.push('### Verification', '');
            if (verifyCommands.length > 0) {
                lines.push(...verifyCommands.slice(0, 8).map((item) => `- Command: \`${item}\``));
            }
            if (verifyResults.length > 0) {
                lines.push(...verifyResults.slice(0, 8).map((item) => `- Result: ${item}`));
            }
            lines.push('');
        }

        const actionItems = this.extractRemoteAgentActionItems(finalOutput);
        if (actionItems.length > 0) {
            lines.push('### Action Items', '', ...actionItems.map((item) => `- ${item}`), '');
        }

        if (Array.isArray(result.uiScreenshots) && result.uiScreenshots.length > 0) {
            lines.push('### Screenshots', '', ...result.uiScreenshots.slice(0, 6).map((item) => `- \`${item}\``), '');
        }

        if (returnedFiles.length > 0) {
            lines.push('### Returned Files', '');
            returnedFiles.slice(0, 12).forEach((file) => {
                const artifactId = String(file?.artifactId || '').trim();
                const localId = String(file?.id || '').trim();
                const label = String(file?.filename || artifactId || `file-${localId}`).trim();
                lines.push(`- ${label}${localId ? ` (file #${localId})` : ''}${artifactId ? ` — artifact \`${artifactId}\`` : ''}`);
            });
            lines.push('', 'Use `/open` to preview, select, download, or push eligible site artifacts.', '');
        }

        if (observedFiles.length > 0) {
            lines.push('### New Session Files Observed', '');
            observedFiles.slice(0, 12).forEach((file) => {
                const artifactId = String(file?.artifactId || '').trim();
                const localId = String(file?.id || '').trim();
                const label = String(file?.filename || artifactId || `file-${localId}`).trim();
                lines.push(`- ${label}${localId ? ` (file #${localId})` : ''}${artifactId ? ` — artifact \`${artifactId}\`` : ''}`);
            });
            lines.push('', 'These files appeared during the run, but the agent did not return IDs that prove they belong to this result.', '');
        }

        lines.push('### Agent Report', '', finalOutput || 'Remote CLI agent completed.');
        return lines.join('\n');
    }

    getRemoteAgentEffectiveStatus(result = {}) {
        const effectiveStatus = String(result.effectiveStatus || '').trim();
        const completionStatus = String(result.completionStatus || result.status || '').trim();
        const resultFilesError = String(result.resultFilesError || '').trim();
        if (resultFilesError && (!effectiveStatus || ['complete', 'completed', 'success', 'succeeded'].includes(effectiveStatus.toLowerCase()))) {
            return 'blocked';
        }
        if (effectiveStatus) {
            return effectiveStatus;
        }
        if (resultFilesError && (!completionStatus || ['complete', 'completed', 'success', 'succeeded'].includes(completionStatus.toLowerCase()))) {
            return 'blocked';
        }
        return completionStatus;
    }

    async loadRemoteToolCatalog() {
        const response = await api.getAvailableTools('ssh', {
            executionProfile: 'remote-build',
        });
        const tools = response?.tools || [];
        const remoteTool = tools.find((tool) => tool.id === 'remote-command')
            || tools.find((tool) => Array.isArray(tool.runtime?.commandCatalog));
        return {
            tools,
            runtime: response?.meta?.runtime || null,
            remoteTool,
            catalog: remoteTool?.runtime?.commandCatalog || [],
        };
    }

    printRemotePlan() {
        this.printAI(`## Remote CLI Plan

1. \`/remote status\` - confirm remote runner health and fallback target.
2. \`/remote tools\` - choose a live catalog command such as baseline, repo-map, changed-files, targeted-grep, build, focused-test, buildkit, kubectl-inspect, logs, rollout, deploy-verify, or ui-visual-check.
3. \`/remote agent <task>\` - hand a full coding/build/deploy loop to the backend remote CLI agent.
4. \`/remote run <command>\` - execute one purposeful expert inspect, fix, or verify batch.
5. \`/remote verify [host]\` - run the standard DNS and HTTPS availability check.

Raw expert access remains available:
\`\`\`text
/tool remote-command {"command":"hostname && whoami && uname -m","profile":"inspect"}
\`\`\``);
    }

    async handleRemoteCommand(args = []) {
        const subcommand = String(args[0] || 'plan').toLowerCase();
        const rest = args.slice(1).join(' ').trim();

        this.setActiveVoxelTool('tools');

        if (subcommand === 'plan' || subcommand === 'help' || subcommand === '?') {
            this.printRemotePlan();
            return;
        }

        if (subcommand === 'status') {
            this.setStatus('thinking');
            try {
                const { runtime, remoteTool, tools } = await this.loadRemoteToolCatalog();
                const runner = runtime?.remoteRunner || {};
                const ssh = runtime?.sshDefaults || {};
                const deploy = runtime?.deployDefaults || {};
                const lines = ['## Remote CLI Status', ''];
                lines.push(`Remote runner: \`${runner.healthy ? 'healthy' : 'not healthy'}\` (enabled=${runner.enabled ? 'yes' : 'no'}, preferred=${runner.preferred ? 'yes' : 'no'})`);
                lines.push(`Remote-command: \`${remoteTool?.runtime?.configured ? 'configured' : 'not configured'}\` via \`${remoteTool?.runtime?.source || 'unknown'}\``);
                lines.push(`Remote-cli-agent: \`${tools.find((tool) => tool.id === 'remote-cli-agent')?.runtime?.configured ? 'configured' : 'not configured'}\``);
                lines.push(`Default target: \`${remoteTool?.runtime?.defaultTarget || 'none'}\``);
                lines.push(`SSH fallback: \`${ssh.configured ? `${ssh.username || 'unknown'}@${ssh.host}:${ssh.port || 22}` : 'not configured'}\``);
                lines.push(`Deploy defaults: namespace=\`${deploy.namespace || 'unset'}\`, deployment=\`${deploy.deployment || 'unset'}\`, domain=\`${deploy.publicDomain || 'unset'}\``);
                if (Array.isArray(runner.runners) && runner.runners.length) {
                    lines.push('', 'Runners:');
                    runner.runners.slice(0, 8).forEach((item) => {
                        lines.push(`- \`${item.runnerId || item.id || 'runner'}\` healthy=${item.healthy ? 'yes' : 'no'} host=${item.hostname || item.host || 'unknown'}`);
                    });
                }
                this.printAI(lines.join('\n'));
            } catch (error) {
                this.printError(`Remote status failed: ${error.message}`);
            } finally {
                this.setStatus('ready');
            }
            return;
        }

        if (subcommand === 'tools') {
            this.setStatus('thinking');
            try {
                const { catalog } = await this.loadRemoteToolCatalog();
                if (!catalog.length) {
                    this.printSystem('No remote CLI command catalog is available.');
                    return;
                }
                const lines = ['## Remote CLI Tools', ''];
                catalog.forEach((entry) => {
                    lines.push(`- \`${entry.id}\` (${entry.profile || 'inspect'}): ${entry.description || entry.purpose || 'Remote command pattern.'}`);
                    if (entry.command) {
                        lines.push(`  \`${entry.command}\``);
                    }
                });
                this.printAI(lines.join('\n'));
            } catch (error) {
                this.printError(`Remote tools failed: ${error.message}`);
            } finally {
                this.setStatus('ready');
            }
            return;
        }

        if (subcommand === 'run') {
            if (!rest) {
                this.printError('Usage: /remote run <command>');
                return;
            }
            this.setStatus('thinking');
            this.recordVoxelToolUse('tool');
            try {
                const invocation = await api.invokeTool('remote-command', {
                    command: rest,
                    profile: 'build',
                    workflowAction: 'remote-cli-manual-run',
                    timeout: 120000,
                });
                this.printAI(this.formatRemoteCommandResult(this.getRemoteCommandEnvelope(invocation)));
            } catch (error) {
                this.printError(`Remote run failed: ${error.message}`);
            } finally {
                this.setStatus('ready');
            }
            return;
        }

        if (subcommand === 'agent') {
            if (!rest) {
                this.printError('Usage: /remote agent <coding/build/deploy task>');
                return;
            }
            this.setStatus('thinking');
            this.recordVoxelToolUse('tool');
            try {
                this.liveProgressState = this.normalizeProgressState({
                    phase: 'planning',
                    detail: 'Preparing the remote CLI agent and target workspace.',
                    steps: [
                        { id: 'catalog', title: 'Load remote runner catalog', status: 'in_progress' },
                        { id: 'launch', title: 'Launch remote CLI agent', status: 'pending' },
                        { id: 'run', title: 'Run remote coding loop', status: 'pending' },
                        { id: 'report', title: 'Format result and action items', status: 'pending' },
                    ],
                });
                this.renderLiveProgressCard();
                const { runtime, tools } = await this.loadRemoteToolCatalog();
                const remoteAgent = tools.find((tool) => tool.id === 'remote-cli-agent') || null;
                this.liveProgressState = this.normalizeProgressState({
                    ...this.liveProgressState,
                    phase: 'executing',
                    detail: 'Remote CLI agent is running. This can include repo edits, deploy checks, and verification.',
                    steps: [
                        { id: 'catalog', title: 'Load remote runner catalog', status: 'completed' },
                        { id: 'launch', title: 'Launch remote CLI agent', status: 'completed' },
                        { id: 'run', title: 'Run remote coding loop', status: 'in_progress' },
                        { id: 'report', title: 'Format result and action items', status: 'pending' },
                    ],
                });
                this.renderLiveProgressCard();
                let preRunArtifactBaselineReady = true;
                try {
                    await this.syncStoredSessionArtifacts({ throwOnError: true });
                } catch (error) {
                    preRunArtifactBaselineReady = false;
                    console.warn('[CLI] Could not establish the pre-run artifact baseline:', error);
                }
                const preRunArtifactIds = new Set(
                    this.sessionFiles
                        .map((file) => String(file?.artifactId || '').trim())
                        .filter(Boolean),
                );
                const selectedArtifactIds = this.getSelectedRemoteArtifactIds();
                const invocation = await api.invokeRemoteCliAgent(rest, {
                    cwd: remoteAgent?.runtime?.defaultCwd || runtime?.remoteRunner?.defaultWorkspace || '',
                    waitMs: 30000,
                    maxTurns: 30,
                    adminMode: true,
                    collectResultFiles: true,
                    artifactIds: selectedArtifactIds,
                    ...(this.artifactHandoff?.lineage ? {
                        metadata: {
                            artifactLineage: this.artifactHandoff.lineage,
                            source: 'web-cli-artifact-handoff',
                        },
                    } : {}),
                    ...(api.currentModel && api.currentModel !== 'auto' ? { model: api.currentModel } : {}),
                });
                const rawResult = invocation?.result?.data || invocation?.result?.result || invocation?.result || {};
                const result = window.KimiBuiltRemoteArtifactWorkflow?.normalizeRemoteAgentResult
                    ? window.KimiBuiltRemoteArtifactWorkflow.normalizeRemoteAgentResult(rawResult)
                    : rawResult;
                const collectedArtifacts = window.KimiBuiltRemoteArtifactWorkflow?.collectRemoteAgentArtifacts
                    ? window.KimiBuiltRemoteArtifactWorkflow.collectRemoteAgentArtifacts(result)
                    : this.collectArtifactsFromValue({
                        artifacts: result.artifacts,
                        resultFiles: result.resultFiles,
                        siteBundleArtifact: result.siteBundleArtifact,
                    });
                const directArtifacts = Array.isArray(collectedArtifacts)
                    ? collectedArtifacts
                    : [
                        ...(Array.isArray(collectedArtifacts?.artifacts) ? collectedArtifacts.artifacts : []),
                        ...(collectedArtifacts?.siteBundle ? [collectedArtifacts.siteBundle] : []),
                    ];
                const storedFiles = await this.syncStoredSessionArtifacts();
                const directFiles = this.syncArtifactsToSessionFiles(directArtifacts, 'remote-agent-result');
                const returnedArtifactIds = new Set([
                    ...(Array.isArray(result.artifactIds) ? result.artifactIds : []),
                    result.siteBundleArtifactId,
                    ...directArtifacts.map((artifact) => artifact?.id || artifact?.artifactId),
                ].map((artifactId) => String(artifactId || '').trim()).filter(Boolean));
                const matchedFiles = this.sessionFiles.filter((file) => returnedArtifactIds.has(String(file.artifactId || '').trim()));
                const postRunFiles = [...storedFiles, ...directFiles].filter((file, index, files) => {
                    const artifactId = String(file?.artifactId || '').trim();
                    return artifactId
                        && !preRunArtifactIds.has(artifactId)
                        && files.findIndex((candidate) => String(candidate?.artifactId || '').trim() === artifactId) === index;
                });
                result.returnedSessionFiles = returnedArtifactIds.size > 0 ? matchedFiles : [];
                result.observedSessionFiles = returnedArtifactIds.size === 0 && preRunArtifactBaselineReady
                    ? postRunFiles
                    : [];
                this.liveProgressState = this.normalizeProgressState({
                    ...this.liveProgressState,
                    phase: 'finalizing',
                    detail: 'Remote CLI agent returned a report. Extracting metadata and next actions.',
                    steps: [
                        { id: 'catalog', title: 'Load remote runner catalog', status: 'completed' },
                        { id: 'launch', title: 'Launch remote CLI agent', status: 'completed' },
                        { id: 'run', title: 'Run remote coding loop', status: 'completed' },
                        { id: 'report', title: 'Format result and action items', status: 'in_progress' },
                    ],
                });
                this.renderLiveProgressCard();
                const finalStatus = this.getRemoteAgentEffectiveStatus(result).toLowerCase();
                const resultFilesError = String(result.resultFilesError || '').trim();
                const blocked = finalStatus === 'blocked' || Boolean(resultFilesError);
                this.finalizeLiveProgressCard({
                    phase: blocked ? 'blocked' : 'ready',
                    detail: result.blocker || resultFilesError
                        ? `Remote CLI agent blocked: ${result.blocker || resultFilesError}`
                        : (['complete', 'completed', 'success', 'succeeded'].includes(finalStatus)
                            ? 'Remote CLI agent completed with verification.'
                            : 'Remote CLI agent returned a report.'),
                });
                this.printAI(this.formatRemoteAgentResult(result));
            } catch (error) {
                this.liveProgressState = this.normalizeProgressState({
                    ...(this.liveProgressState || {}),
                    phase: 'blocked',
                    detail: error.message,
                    steps: (this.liveProgressState?.steps || []).map((step) => (
                        step.status === 'in_progress' ? { ...step, status: 'failed' } : step
                    )),
                });
                this.renderLiveProgressCard();
                this.finalizeLiveProgressCard({ phase: 'blocked', detail: error.message });
                this.printError(`Remote agent failed: ${error.message}`);
            } finally {
                this.setStatus('ready');
            }
            return;
        }

        if (subcommand === 'verify') {
            const host = rest || 'demoserver2.buzz';
            if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(host)) {
                this.printError('Host must be a domain, IP address, or host:port without shell characters.');
                return;
            }
            const command = `host=${JSON.stringify(host)}\ngetent ahosts "$host" || true\ncurl -fsSIL --max-time 20 "https://$host"`;
            this.setStatus('thinking');
            this.recordVoxelToolUse('tool');
            try {
                const invocation = await api.invokeTool('remote-command', {
                    command,
                    profile: 'inspect',
                    workflowAction: 'remote-cli-https-verify',
                    timeout: 60000,
                });
                this.printAI(this.formatRemoteCommandResult(this.getRemoteCommandEnvelope(invocation)));
            } catch (error) {
                this.printError(`Remote verify failed: ${error.message}`);
            } finally {
                this.setStatus('ready');
            }
            return;
        }

        this.printError('Usage: /remote status | /remote tools | /remote plan | /remote run <command> | /remote agent <task> | /remote verify [host]');
    }

    async listTools(category = null, options = {}) {
        this.setActiveVoxelTool('tools');
        if (!options.menu) {
            this.cliMenuBackStack = [];
            this.cliMenuCurrentView = { view: 'tools', value: category || '' };
        }
        try {
            const toolResponse = await api.getAvailableTools(category);
            const tools = Array.isArray(toolResponse) ? toolResponse : (toolResponse.tools || []);
            if (!tools.length) {
                this.printSystem(category ? `No tools available in category "${category}".` : 'No tools are currently available.');
                return;
            }

            this.rememberToolCatalog(tools);
            this.printCliMenuPanel(
                category ? `Tools: ${category}` : 'Available Tools',
                this.renderToolsMenu(tools, toolResponse?.meta || {}, category || ''),
                { meta: 'tool catalog' }
            );
        } catch (error) {
            this.printError(`Failed to load tools: ${error.message}`);
        }
    }

    async showToolHelp(args, options = {}) {
        const [toolId] = args;
        if (!toolId) {
            this.printError('Usage: /tool-help <id>');
            return;
        }

        this.setActiveVoxelTool('tools');
        if (!options.menu) {
            this.cliMenuBackStack = [];
            this.cliMenuCurrentView = { view: 'tool-help', value: toolId };
        }
        this.setStatus('thinking');
        try {
            const doc = await api.getToolDoc(toolId);
            const tool = await this.getToolCatalogEntry(toolId).catch(() => null);
            const body = `
                <div class="cli-menu-panel">
                    <div class="cli-menu-panel__intro">
                        <span class="cli-menu-panel__icon">TD</span>
                        <div>
                            <strong>${this.escapeHtml(tool?.name || toolId)}</strong>
                            <code>${this.escapeHtml(toolId)}</code>
                            <p>${this.escapeHtml(tool?.description || 'Tool documentation and invocation guidance.')}</p>
                        </div>
                    </div>
                    <div class="cli-menu-runtime">
                        <span>Support</span>
                        <strong>${this.escapeHtml(doc?.support?.status || tool?.support?.status || 'unknown')}</strong>
                    </div>
                    <div class="cli-menu-doc">${this.renderMarkdown(doc?.content || 'No documentation found.')}</div>
                    <div class="cli-menu-actions">
                        <button type="button" data-menu-view="tool-run" data-menu-value="${this.escapeHtmlAttr(toolId)}" onclick="app.openCliMenuButton(this)">Run Tool</button>
                        <button type="button" onclick="app.stageCliMenuCommandText('/tool-help ${this.escapeHtmlAttr(toolId)}')">Stage /tool-help</button>
                    </div>
                </div>
            `;
            this.printCliMenuPanel(`Tool Help: ${toolId}`, body, { meta: 'tool docs' });
        } catch (error) {
            this.printError(`Tool help failed: ${error.message}`);
        } finally {
            this.setStatus('ready');
        }
    }

    async listSkills(search = '', options = {}) {
        this.setActiveVoxelTool('tools');
        if (!options.menu) {
            this.cliMenuBackStack = [];
            this.cliMenuCurrentView = { view: 'skills', value: search || '' };
        }
        try {
            const response = await api.listSkills({ search });
            const skills = Array.isArray(response) ? response : (response.skills || []);
            const meta = response?.meta || {};

            if (!skills.length) {
                this.printSystem(search ? `No skills matched "${search}".` : 'No registered skills yet.');
                return;
            }

            this.rememberSkillCatalog(skills);
            this.printCliMenuPanel(
                search ? `Skills: ${search}` : 'Registered Skills',
                this.renderSkillsMenu(skills, meta, search),
                { meta: 'skill catalog' }
            );
        } catch (error) {
            this.printError(`Failed to load skills: ${error.message}`);
        }
    }

    async showSkill(args, options = {}) {
        const [skillId] = args;
        if (!skillId) {
            this.printError('Usage: /skill <id>');
            return;
        }

        this.setActiveVoxelTool('tools');
        if (!options.menu) {
            this.cliMenuBackStack = [];
            this.cliMenuCurrentView = { view: 'skill', value: skillId };
        }
        this.setStatus('thinking');
        try {
            const skill = await api.getSkill(skillId);
            this.rememberSkillCatalog([skill]);
            const body = `
                <div class="cli-menu-panel">
                    <div class="cli-menu-panel__intro">
                        <span class="cli-menu-panel__icon">KS</span>
                        <div>
                            <strong>${this.escapeHtml(skill.name || skill.id)}</strong>
                            <code>${this.escapeHtml(skill.id)}</code>
                            <p>${this.escapeHtml(skill.description || 'No description provided.')}</p>
                        </div>
                    </div>
                    <div class="cli-menu-card__meta cli-menu-card__meta--wrap">
                        ${(skill.tools || []).map((tool) => `<span>tool: ${this.escapeHtml(tool)}</span>`).join('') || '<span>tools: none</span>'}
                        ${(skill.triggerPatterns || []).map((trigger) => `<span>trigger: ${this.escapeHtml(trigger)}</span>`).join('') || ''}
                    </div>
                    <div class="cli-menu-doc">
                        <pre><code>${this.escapeHtml(skill.body || '')}</code></pre>
                    </div>
                    <div class="cli-menu-actions">
                        <button type="button" data-menu-view="skill-use" data-menu-value="${this.escapeHtmlAttr(skill.id)}" onclick="app.openCliMenuButton(this)">Use Skill</button>
                        <button type="button" onclick="app.stageCliMenuCommandText('/skill ${this.escapeHtmlAttr(skill.id)}')">Stage /skill</button>
                    </div>
                </div>
            `;
            this.printCliMenuPanel(`Skill: ${skill.id}`, body, { meta: 'skill detail' });
        } catch (error) {
            this.printError(`Skill read failed: ${error.message}`);
        } finally {
            this.setStatus('ready');
        }
    }

    async createSkillCommand(args) {
        const rawPayload = args.join(' ').trim();
        if (!rawPayload) {
            this.printError('Usage: /skill-create {"name":"...","description":"...","body":"...","tools":["image-generate"]}');
            return;
        }

        try {
            const response = await api.createSkill(JSON.parse(rawPayload));
            const skill = response?.data || {};
            this.printAI(`## Skill Saved\n\n\`${skill.id || 'unknown'}\` is registered in \`${response?.meta?.root || 'data/skills'}\`.`);
        } catch (error) {
            this.printError(`Skill create failed: ${error.message}`);
        }
    }

    async updateSkillCommand(args) {
        const [skillId, ...payloadParts] = args;
        if (!skillId || payloadParts.length === 0) {
            this.printError('Usage: /skill-update <id> {"description":"...","body":"..."}');
            return;
        }

        try {
            const response = await api.updateSkill(skillId, JSON.parse(payloadParts.join(' ')));
            const skill = response?.data || {};
            this.printAI(`## Skill Updated\n\n\`${skill.id || skillId}\` is registered in \`${response?.meta?.root || 'data/skills'}\`.`);
        } catch (error) {
            this.printError(`Skill update failed: ${error.message}`);
        }
    }

    async invokeToolCommand(args) {
        const [toolId, ...paramParts] = args;
        if (!toolId) {
            this.printError('Usage: /tool <id> {"key":"value"}');
            return;
        }

        const rawParams = paramParts.join(' ').trim();
        let params = {};

        if (rawParams) {
            try {
                params = JSON.parse(rawParams);
            } catch (error) {
                this.printError(`Invalid JSON params: ${error.message}`);
                return;
            }
        }

        this.setActiveVoxelTool('tools');
        this.setStatus('thinking');
        this.recordVoxelToolUse('tool');
        try {
            const invocation = await api.invokeTool(toolId, params);
            const artifactFiles = this.syncArtifactsToSessionFiles(
                this.collectArtifactsFromValue(invocation?.result),
                'tool-artifact'
            );
            const serialized = JSON.stringify(invocation?.result, null, 2);
            const artifactNote = artifactFiles.length > 0
                ? `\n\nAdded artifact file(s): ${artifactFiles.map((file) => `#${file.id}`).join(', ')}. Use /files to manage.`
                : '';
            this.printAI(`## Tool Result: \`${toolId}\`\n\n\`\`\`json\n${serialized}\n\`\`\`${artifactNote}`);
        } catch (error) {
            this.printError(`Tool failed: ${error.message}`);
        } finally {
            this.setStatus('ready');
        }
    }
    
    printDiagramHelp() {
        this.printAI(`
## Diagram Command

Generate Mermaid diagrams using the AI or templates.

**Usage:**
  /diagram <type> [description]

**Diagram Types:**
  flowchart   - Flowchart diagram (default)
  sequence    - Sequence diagram
  class       - Class diagram
  er          - Entity relationship diagram
  mindmap     - Mind map
  gantt       - Gantt chart
  pie         - Pie chart
  state       - State diagram
  gitgraph    - Git graph

**Examples:**
  /diagram flowchart login process
  /diagram sequence user authentication
  /diagram class user management system
  /diagram mindmap project planning

The AI will generate appropriate Mermaid syntax. If AI is unavailable, a template will be used.
        `.trim());
    }

    sanitizeMermaidCode(text, type = '') {
        let source = String(text || '')
            .replace(/\r\n?/g, '\n')
            .trim();

        if (!source) {
            return '';
        }

        source = source.replace(/^```mermaid\s*/i, '');
        source = source.replace(/^```\s*/i, '');
        source = source.replace(/```\s*$/i, '');

        const normalizedType = String(type || '').toLowerCase();
        const whitespaceSensitive = normalizedType === 'mindmap';

        if (!source.includes('\n') && !whitespaceSensitive && /\s{2,}/.test(source)) {
            source = source
                .split(/\s{2,}/)
                .map((line) => line.trim())
                .filter(Boolean)
                .join('\n');
        }

        source = source
            .replace(/^(flowchart|graph)\s+([A-Za-z]{2})\s+(?=\S)/i, '$1 $2\n')
            .replace(/^(sequenceDiagram|classDiagram|erDiagram|stateDiagram(?:-v2)?|gitGraph|journey|timeline)\s+(?=\S)/i, '$1\n');

        if (!whitespaceSensitive) {
            source = source.replace(
                /\s+(?=(?:style|classDef|class|linkStyle|click|subgraph|end|section|participant|actor|note|title|accTitle|accDescr)\b)/g,
                '\n',
            );
        }

        return source
            .split('\n')
            .flatMap((line) => (
                !whitespaceSensitive && /\s{2,}/.test(line) && !/^\s/.test(line)
                    ? line.split(/\s{2,}/)
                    : [line]
            ))
            .map((line) => line.trimEnd())
            .filter((line, index, lines) => line.trim() || (index > 0 && lines[index - 1].trim()))
            .join('\n')
            .trim();
    }

    async validateMermaidCode(source) {
        if (typeof mermaid === 'undefined' || typeof mermaid.parse !== 'function') {
            return true;
        }

        try {
            await mermaid.parse(source);
            return true;
        } catch (error) {
            console.warn('[CLI] Mermaid validation failed:', error);
            return false;
        }
    }
    
    // ==================== Helper Methods ====================
    
    renderMarkdown(text) {
        const codeBlocks = [];
        let source = window.LillyModelOutputParser?.normalizeModelOutputMarkdown
            ? window.LillyModelOutputParser.normalizeModelOutputMarkdown(text)
            : String(text || '');
        if (window.LillyModelOutputParser?.normalizePresentationMarkupMarkdown) {
            source = window.LillyModelOutputParser.normalizePresentationMarkupMarkdown(source);
        }
        source = String(source || '').replace(/\r\n?/g, '\n');
        
        // Code blocks (including mermaid)
        source = source.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (match, lang, code) => {
            const language = String(lang || 'text').trim().split(/\s+/)[0] || 'text';
            const trimmedCode = language === 'mermaid'
                ? this.sanitizeMermaidCode(code)
                : code.trim();
            const escapedCode = this.escapeHtml(trimmedCode);
            const flaggedToolPayload = this.detectToolPayloadBlock(language, trimmedCode);
            if (flaggedToolPayload) {
                codeBlocks.push(this.renderFlaggedToolPayloadBlock(flaggedToolPayload, language, trimmedCode));
                return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
            }
            
            // Special handling for mermaid diagrams
            if (language === 'mermaid') {
                const filenameBase = `diagram-${Date.now()}`;
                codeBlocks.push(`
                    <div class="diagram-block">
                        <div class="code-block mermaid-code">
                            <div class="code-header">
                                <span>mermaid</span>
                                <div class="code-actions">
                                    <button class="code-action-btn" onclick="app.copyCode(this)" aria-label="Copy code">Copy</button>
                                    <button class="code-action-btn" onclick="app.downloadMermaidSourceFromButton(this)" data-code="${this.escapeHtmlAttr(trimmedCode)}" data-filename="${filenameBase}.mmd" aria-label="Download Mermaid source">.mmd</button>
                                    <button class="code-action-btn" onclick="app.downloadMermaidPdfFromButton(this)" data-code="${this.escapeHtmlAttr(trimmedCode)}" data-filename="${filenameBase}.pdf" aria-label="Download Mermaid PDF">PDF</button>
                                </div>
                            </div>
                            <pre><code class="language-mermaid nohighlight">${escapedCode}</code></pre>
                        </div>
                        <div class="diagram-preview">
                            <div class="mermaid-render-surface" data-mermaid-source="${this.escapeHtmlAttr(trimmedCode)}" data-mermaid-filename="${filenameBase}">
                                <div class="text-sm" style="color: var(--text-secondary);">Rendering diagram...</div>
                            </div>
                        </div>
                    </div>
                `);
                return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
            }
            
            codeBlocks.push(`
                <div class="code-block">
                    <div class="code-header">
                        <span>${language}</span>
                        <div class="code-actions">
                            <button class="code-action-btn" onclick="app.copyCode(this)" aria-label="Copy code">Copy</button>
                        </div>
                    </div>
                    <pre><code class="language-${language}">${escapedCode}</code></pre>
                </div>
            `);
            return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
        });

        let html = this.renderMarkdownBlocks(source);
        html = html.replace(/__CODE_BLOCK_(\d+)__/g, (match, index) => codeBlocks[Number(index)] || match);
        
        return `<div class="markdown-content">${html}</div>`;
    }

    detectToolPayloadBlock(language = '', code = '') {
        const normalizedLanguage = String(language || '').trim().toLowerCase();
        if (!['json', 'javascript', 'js', 'text', ''].includes(normalizedLanguage)) {
            return null;
        }

        if (window.LillyModelOutputParser?.detectToolPayload) {
            return window.LillyModelOutputParser.detectToolPayload(code);
        }

        try {
            const payload = JSON.parse(String(code || '').trim());
            const command = String(payload?.command || payload?.params?.command || '').trim();
            const toolId = String(payload?.tool || payload?.toolId || payload?.name || '').trim().toLowerCase().replace(/_/g, '-');
            const hasRemoteTarget = Boolean(payload?.host || payload?.hostname || payload?.username || payload?.port);
            if (command && (toolId === 'remote-command' || hasRemoteTarget)) {
                return {
                    toolId: toolId || 'remote-command',
                    command,
                    host: String(payload.host || payload.hostname || '').trim(),
                    username: String(payload.username || '').trim(),
                    port: payload.port || null,
                    payload,
                };
            }
        } catch (_error) {
            return null;
        }

        return null;
    }

    renderFlaggedToolPayloadBlock(payload = {}, language = 'json', code = '') {
        const toolId = String(payload.toolId || 'remote-command').trim() || 'remote-command';
        const host = [payload.username, payload.host].filter(Boolean).join('@');
        const target = [host || payload.host || '', payload.port ? `:${payload.port}` : ''].join('').trim();
        const command = String(payload.command || '').trim();
        const preview = command.length > 220 ? `${command.slice(0, 217)}...` : command;
        const meta = [
            `tool=${toolId}`,
            target ? `target=${target}` : '',
        ].filter(Boolean).join(' | ');
        const displayLanguage = String(language || 'json').trim() || 'json';

        return `
            <details class="tool-payload-flag">
                <summary>
                    <span class="tool-payload-flag__badge">Flagged</span>
                    <span class="tool-payload-flag__title">Remote command payload appeared in assistant text</span>
                    <span class="tool-payload-flag__meta">${this.escapeHtml(meta)}</span>
                </summary>
                <div class="tool-payload-flag__body">
                    ${preview ? `<div class="tool-payload-flag__command"><code class="inline-code">${this.escapeHtml(preview)}</code></div>` : ''}
                    <div class="code-block">
                        <div class="code-header">
                            <span>${this.escapeHtml(displayLanguage)}</span>
                            <div class="code-actions">
                                <button class="code-action-btn" onclick="app.copyCode(this)" aria-label="Copy code">Copy</button>
                            </div>
                        </div>
                        <pre><code class="language-${this.escapeHtmlAttr(displayLanguage)}">${this.escapeHtml(code)}</code></pre>
                    </div>
                </div>
            </details>
        `;
    }

    renderMarkdownBlocks(source) {
        const lines = String(source || '').split('\n');
        const blocks = [];
        let i = 0;

        const isSpecialBlock = (line) => (
            /^(#{1,6})\s+/.test(line)
            || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
            || /^\s*[-*+]\s+/.test(line)
            || /^\s*\d+[.)]\s+/.test(line)
            || /^\|.+\|$/.test(line)
            || /^>\s?/.test(line)
            || /^__CODE_BLOCK_\d+__$/.test(line.trim())
        );

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();

            if (!trimmed) {
                i += 1;
                continue;
            }

            if (/^__CODE_BLOCK_\d+__$/.test(trimmed)) {
                blocks.push(trimmed);
                i += 1;
                continue;
            }

            const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
            if (heading) {
                const level = Math.min(6, heading[1].length);
                blocks.push(`<h${level}>${this.renderInlineMarkdown(heading[2])}</h${level}>`);
                i += 1;
                continue;
            }

            if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
                blocks.push('<hr>');
                i += 1;
                continue;
            }

            if (/^\|.+\|$/.test(trimmed) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
                const headerCells = this.parseMarkdownTableRow(trimmed);
                i += 2;
                const rows = [];
                while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
                    rows.push(this.parseMarkdownTableRow(lines[i].trim()));
                    i += 1;
                }
                blocks.push(`
                    <table>
                        <thead><tr>${headerCells.map((cell) => `<th>${this.renderInlineMarkdown(cell)}</th>`).join('')}</tr></thead>
                        <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${this.renderInlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
                    </table>
                `);
                continue;
            }

            if (/^\s*[-*+]\s+/.test(line)) {
                const items = [];
                while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
                    items.push(lines[i].replace(/^\s*[-*+]\s+/, '').trim());
                    i += 1;
                }
                blocks.push(`<ul>${items.map((item) => `<li>${this.renderInlineMarkdown(item)}</li>`).join('')}</ul>`);
                continue;
            }

            if (/^\s*\d+[.)]\s+/.test(line)) {
                const items = [];
                while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
                    items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '').trim());
                    i += 1;
                }
                blocks.push(`<ol>${items.map((item) => `<li>${this.renderInlineMarkdown(item)}</li>`).join('')}</ol>`);
                continue;
            }

            if (/^>\s?/.test(line)) {
                const quoteLines = [];
                while (i < lines.length && /^>\s?/.test(lines[i])) {
                    quoteLines.push(lines[i].replace(/^>\s?/, '').trim());
                    i += 1;
                }
                const callout = quoteLines[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|SUCCESS|DANGER|INFO)\]\s*(.*)$/i);
                if (callout) {
                    const tone = String(callout[1] || 'note').toLowerCase();
                    const title = String(callout[2] || this.getPresentationCalloutLabel(tone)).trim();
                    const body = quoteLines.slice(1).filter(Boolean);
                    blocks.push(`
                        <div class="kb-callout kb-callout--${tone}">
                            <div class="kb-callout__title">${this.renderInlineMarkdown(title)}</div>
                            ${body.length > 0 ? `<div class="kb-callout__body">${body.map((item) => this.renderInlineMarkdown(item)).join('<br>')}</div>` : ''}
                        </div>
                    `);
                    continue;
                }
                blocks.push(`<blockquote>${quoteLines.map((item) => this.renderInlineMarkdown(item)).join('<br>')}</blockquote>`);
                continue;
            }

            const paragraphLines = [trimmed];
            i += 1;
            while (i < lines.length && lines[i].trim() && !isSpecialBlock(lines[i].trim())) {
                paragraphLines.push(lines[i].trim());
                i += 1;
            }
            blocks.push(`<p>${this.renderInlineMarkdown(paragraphLines.join(' '))}</p>`);
        }

        return blocks.join('');
    }

    parseMarkdownTableRow(line) {
        return String(line || '')
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((cell) => cell.trim());
    }

    getPresentationCalloutLabel(tone = '') {
        return ({
            note: 'Note',
            tip: 'Tip',
            important: 'Important',
            warning: 'Warning',
            success: 'Success',
            danger: 'Danger',
            info: 'Info',
        })[String(tone || '').toLowerCase()] || 'Note';
    }

    renderInlineMarkdown(text) {
        const inlineCodes = [];
        let html = String(text || '').replace(/`([^`]+)`/g, (match, code) => {
            inlineCodes.push(`<code class="inline-code">${this.escapeHtml(code)}</code>`);
            return `__INLINE_CODE_${inlineCodes.length - 1}__`;
        });

        html = this.escapeHtml(html);
        html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        html = html.replace(/&lt;mark class=&quot;kb-highlight&quot;&gt;([\s\S]*?)&lt;\/mark&gt;/g, '<mark class="kb-highlight">$1</mark>');
        html = html.replace(/&lt;span class=&quot;kb-tone kb-tone--(accent|success|warning|danger|info|muted)&quot;&gt;([\s\S]*?)&lt;\/span&gt;/g, '<span class="kb-tone kb-tone--$1">$2</span>');
        html = html.replace(/__INLINE_CODE_(\d+)__/g, (match, index) => inlineCodes[Number(index)] || match);

        return html;
    }
    
    /**
     * Render Mermaid diagrams after content is added to DOM
     */
    renderMermaidDiagrams(element) {
        if (typeof mermaid !== 'undefined') {
            try {
                const nodes = Array.from(element?.querySelectorAll?.('.mermaid-render-surface') || document.querySelectorAll('.mermaid-render-surface'));
                nodes.forEach(async (node) => {
                    const source = this.sanitizeMermaidCode(node.dataset.mermaidSource || '');
                    if (!source || node.dataset.renderedSource === source) {
                        return;
                    }

                    try {
                        const result = await mermaid.render(
                            `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                            source,
                        );
                        node.innerHTML = result.svg;
                        node.dataset.renderedSource = source;
                        if (typeof result.bindFunctions === 'function') {
                            result.bindFunctions(node);
                        }
                    } catch (error) {
                        node.innerHTML = `
                            <div class="text-sm" style="color: var(--error); margin-bottom: 8px;">Mermaid render failed: ${this.escapeHtml(error.message)}</div>
                            <pre><code>${this.escapeHtml(source)}</code></pre>
                        `;
                        delete node.dataset.renderedSource;
                    }
                });
            } catch (err) {
                console.warn('[CLI] Mermaid rendering failed:', err);
            }
        }
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    escapeHtmlAttr(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    getMermaidFilename(baseName = 'diagram', extension = 'mmd') {
        return `${String(baseName || 'diagram').replace(/\.[a-z0-9]+$/i, '')}.${extension}`;
    }

    downloadMermaidSourceFromButton(button) {
        const source = this.sanitizeMermaidCode(button?.dataset?.code || '');
        if (!source) {
            this.printWarning('No Mermaid source available to download.');
            return;
        }

        this.downloadFile(source, this.getMermaidFilename(button?.dataset?.filename || 'diagram', 'mmd'), 'text/plain');
    }

    async svgMarkupToImage(svgMarkup) {
        const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
        const svgUrl = URL.createObjectURL(svgBlob);

        try {
            const image = await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('Failed to load Mermaid SVG'));
                img.src = svgUrl;
            });
            return image;
        } finally {
            URL.revokeObjectURL(svgUrl);
        }
    }

    async createMermaidPdfBlob(source) {
        if (!window.PDFLib?.PDFDocument) {
            throw new Error('PDF library is not loaded');
        }
        if (typeof mermaid === 'undefined') {
            throw new Error('Mermaid is not loaded');
        }

        const result = await mermaid.render(
            `mermaid-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            source,
        );
        const image = await this.svgMarkupToImage(result.svg);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(image.naturalWidth || image.width || 1200));
        canvas.height = Math.max(1, Math.ceil(image.naturalHeight || image.height || 800));

        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

        const pngDataUrl = canvas.toDataURL('image/png');
        const pngBytes = await fetch(pngDataUrl).then((response) => response.arrayBuffer());

        const pdfDoc = await window.PDFLib.PDFDocument.create();
        const pngImage = await pdfDoc.embedPng(pngBytes);
        const margin = 36;
        const pageWidth = Math.max(612, canvas.width + margin * 2);
        const pageHeight = Math.max(792, canvas.height + margin * 2);
        const page = pdfDoc.addPage([pageWidth, pageHeight]);
        const scale = Math.min(
            (pageWidth - margin * 2) / pngImage.width,
            (pageHeight - margin * 2) / pngImage.height,
            1,
        );

        page.drawImage(pngImage, {
            x: (pageWidth - (pngImage.width * scale)) / 2,
            y: (pageHeight - (pngImage.height * scale)) / 2,
            width: pngImage.width * scale,
            height: pngImage.height * scale,
        });

        const pdfBytes = await pdfDoc.save({
            updateFieldAppearances: false,
            useObjectStreams: false,
        });

        return new Blob([pdfBytes], { type: 'application/pdf' });
    }

    async downloadMermaidPdfFromButton(button) {
        const source = this.sanitizeMermaidCode(button?.dataset?.code || '');
        if (!source) {
            this.printWarning('No Mermaid source available to export.');
            return;
        }

        try {
            const pdfBlob = await this.createMermaidPdfBlob(source);
            this.downloadFile(pdfBlob, this.getMermaidFilename(button?.dataset?.filename || 'diagram', 'pdf'), 'application/pdf');
            this.printSystem('Mermaid PDF downloaded.');
        } catch (error) {
            console.error('[CLI] Mermaid PDF export failed:', error);
            this.printError(`Failed to export Mermaid PDF: ${error.message}`);
        }
    }
    
    getTimestamp() {
        const now = new Date();
        return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    }
    
    scrollToBottom() {
        this.terminalOutput.scrollTop = this.terminalOutput.scrollHeight;
        this.enforceScrollbackLimit();
    }
    
    enforceScrollbackLimit(maxLines = 1000) {
        const lines = this.terminalOutput.querySelectorAll('.line, .imported-file');
        if (lines.length > maxLines) {
            const toRemove = lines.length - maxLines;
            for (let i = 0; i < toRemove; i++) {
                lines[i].remove();
            }
        }
    }
    
    // ==================== API Methods ====================
    
    async checkConnection() {
        try {
            this.statusDot.className = 'status-dot connecting';
            this.statusText.textContent = 'Connecting...';
            
            const health = await api.healthCheck();
            
            if (health.connected) {
                this.statusDot.className = 'status-dot online';
                this.statusText.textContent = 'Connected';
            } else {
                this.statusDot.className = 'status-dot offline';
                this.statusText.textContent = 'Disconnected';
                this.roamVoxelPet('alert', 'guard', 1200);
            }
        } catch (error) {
            this.statusDot.className = 'status-dot offline';
            this.statusText.textContent = 'Offline';
            this.roamVoxelPet('alert', 'guard', 1200);
        }
    }
    
    async checkHealth() {
        this.setStatus('thinking');
        try {
            const health = await api.healthCheck();
            this.printSystem(`Health Check:
  Status: ${health.connected ? '? Connected' : '? Disconnected'}
  Version: ${health.version || 'unknown'}
  Models: ${health.models || 'unknown'}
            `.trim());
            this.setStatus('ready');
        } catch (error) {
            this.printError(`Health check failed: ${error.message}`);
            this.setStatus('error');
        }
    }
    
    async loadModels() {
        try {
            const models = await api.getModels();
            if (models.length === 0) {
                throw new Error('No models returned');
            }
            const selectableModels = models.some((model) => model.id === 'auto')
                ? models
                : [{ id: 'auto' }, ...models];
            this.modelSelect.innerHTML = selectableModels.map(m =>
                `<option value="${m.id}" ${m.id === api.currentModel ? 'selected' : ''}>${m.id}</option>`
            ).join('');
            this.updateModelInfo();
        } catch (error) {
            this.modelSelect.innerHTML = '<option value="auto">auto</option>';
            api.setModel('auto');
            this.updateModelInfo();
        }
    }
    
    async listModels() {
        try {
            const models = await api.getModels();
            this.printAI(`## Available Models\n\n${models.map(m => '  - ' + m.id).join('\n')}`);
        } catch (error) {
            this.printError('Failed to load models');
        }
    }
    async listImageModels() {
        try {
            const models = await api.getImageModels();
            if (!Array.isArray(models) || models.length === 0) {
                this.printError('No image models available');
                return;
            }

            this.printAI(`## Available Image Models\n\n${models.map((model) => {
                const details = [];
                if (Array.isArray(model.sizes) && model.sizes.length > 0) {
                    details.push(`sizes: ${model.sizes.join(', ')}`);
                }
                if (Array.isArray(model.qualities) && model.qualities.length > 0) {
                    details.push(`qualities: ${model.qualities.join(', ')}`);
                }
                if (Array.isArray(model.styles) && model.styles.length > 0) {
                    details.push(`styles: ${model.styles.join(', ')}`);
                }
                const suffix = details.length > 0 ? ` (${details.join(' | ')})` : '';
                return `  - ${model.name || model.id || 'Backend default'}${suffix}`;
            }).join('\n')}`);
        } catch (error) {
            this.printError(`Failed to load image models: ${error.message}`);
        }
    }

    
    updateModelInfo() {
        const model = api.currentModel || 'auto';
        
        // Update the select dropdown to match current model
        if (this.modelSelect) {
            // Check if the model exists in the dropdown
            const options = Array.from(this.modelSelect.options);
            const modelExists = options.some(opt => opt.value === model);
            
            if (modelExists) {
                this.modelSelect.value = model;
            } else if (options.length > 0 && options[0].value !== 'Loading models...') {
                // If model not in list, add it as a temporary option
                const tempOption = document.createElement('option');
                tempOption.value = model;
                tempOption.textContent = model;
                this.modelSelect.insertBefore(tempOption, this.modelSelect.firstChild);
                this.modelSelect.value = model;
            }

            this.modelSelect.setAttribute('aria-label', `Choose AI model. Current model: ${model}`);
            this.modelSelect.title = `Choose AI model. Current model: ${model}`;
        }
        
        // Update header model display
        const headerModel = document.getElementById('headerModelDisplay');
        if (headerModel) {
            headerModel.textContent = model;
            headerModel.title = `Current model: ${model}`;
        }
    }
    
    // ==================== File Handling ====================
    
    triggerFileUpload() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt,.md,.json,.js,.ts,.py,.html,.css,.sql,.docx,.pdf';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) this.handleFile(file);
        };
        input.click();
    }
    
    async handleFile(file) {
        this.setStatus('thinking');
        
        try {
            const content = await api.uploadFile(file);
            this.printSystem(`File uploaded: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
            this.printAI(`File content from "${file.name}":\n\n\`\`\`\n${content.substring(0, 2000)}${content.length > 2000 ? '\n... (truncated)' : ''}\n\`\`\``);
            this.setStatus('ready');
        } catch (error) {
            this.printError(`Failed to process file: ${error.message}`);
            this.setStatus('error');
        }
    }
    
    // ==================== Image Generation ====================

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
                    ? 'Backend sent usable persisted image data; inspect the web CLI receive/parser path.'
                    : (diagnostics.likelyCause || '');

        return `${parts.join(' | ')}${likely ? ` | ${likely}` : ''}`;
    }

    printImageDiagnosticError(message, response) {
        const summary = this.getImageDiagnosticSummary(response);
        this.printError(summary ? `${message}\n${summary}` : message);
    }
    
    async generateImage(input) {
        if (!input) {
            this.printError('Please provide a prompt. Usage: /image <prompt> [--model gpt-image-2] [--size auto] [--quality auto]');
            return;
        }
        
        // Parse options from input
        const { prompt, options } = this.parseImageArgs(input);
        
        if (!prompt) {
            this.printError('Please provide a prompt. Usage: /image <prompt> [--model gpt-image-2] [--size auto] [--quality auto]');
            return;
        }
        
        this.isProcessing = true;
        const requestController = new AbortController();
        this.currentRequestController = requestController;
        this.setRequestCancellationState(true);
        this.setStatus('thinking');
        this.printSystem(`Generating image with ${options.model || 'gpt-image-2'}...`);
        
        try {
            const response = await api.generateImage(prompt, {
                ...options,
                signal: requestController.signal,
            });
            
            const generatedImages = Array.isArray(response.data) ? response.data : [];

            if (generatedImages.length > 0) {
                const timestamp = Date.now();
                const fileIds = generatedImages
                    .map((image, index) => {
                        const imageUrl = image.b64_json
                            ? `data:image/png;base64,${image.b64_json}`
                            : image.url || null;
                        if (!imageUrl) {
                            return null;
                        }

                        return this.addSessionFile(
                            `image-${timestamp}-${index + 1}.png`,
                            imageUrl,
                            'image/png',
                            'image'
                        );
                    })
                    .filter((file) => file && file.id)
                    .map((file) => file.id)
                    .filter((fileId) => fileId !== null);

                if (fileIds.length === 0) {
                    this.printImageDiagnosticError('No usable image data received from API', response);
                    this.setStatus('error');
                    return;
                }

                this.printSystem('Image generated with ' + (response.model || options.model || 'gpt-image-2') + ' (' + (response.size || options.size || 'auto') + ')');
                this.printSystem('Saved ' + fileIds.length + ' image file(s): #' + fileIds.join(', #') + '. Use /download <id> or /open.');
            } else {
                this.printImageDiagnosticError('No image data received from API', response);
            }
            
            this.setStatus('ready');
        } catch (error) {
            if (error?.name === 'AbortError' || requestController.signal.aborted) {
                this.printSystem('Image generation cancelled.');
                this.setStatus('ready');
                return;
            }
            this.printError(`Image generation failed: ${error.message}`);
            this.setStatus('error');
        } finally {
            if (this.currentRequestController === requestController) {
                this.currentRequestController = null;
                this.setRequestCancellationState(false);
            }
            this.isProcessing = false;
        }
    }
    
    /**
     * Parse image command arguments
     * Supports: --model, --size, --quality, --style, --format, --compression, --background, --moderation
     */
    parseImageArgs(input) {
        const options = {
            model: null,
            size: 'auto',
            quality: null,
            style: null,
            output_format: null,
            output_compression: null,
            background: null,
            moderation: null
        };
        
        let prompt = input;
        
        // Parse --model
        const modelMatch = input.match(/--model\s+(\S+)/);
        if (modelMatch) {
            options.model = modelMatch[1];
            prompt = prompt.replace(modelMatch[0], '').trim();
        }
        
        // Parse --size
        const sizeMatch = input.match(/--size\s+(\S+)/);
        if (sizeMatch) {
            options.size = sizeMatch[1];
            prompt = prompt.replace(sizeMatch[0], '').trim();
        }
        
        // Parse --quality
        const qualityMatch = input.match(/--quality\s+(\S+)/);
        if (qualityMatch) {
            options.quality = qualityMatch[1];
            prompt = prompt.replace(qualityMatch[0], '').trim();
        }
        
        // Parse --style
        const styleMatch = input.match(/--style\s+(\S+)/);
        if (styleMatch) {
            options.style = styleMatch[1];
            prompt = prompt.replace(styleMatch[0], '').trim();
        }

        const formatMatch = input.match(/--(?:output-)?format\s+(\S+)/);
        if (formatMatch) {
            options.output_format = formatMatch[1];
            prompt = prompt.replace(formatMatch[0], '').trim();
        }

        const compressionMatch = input.match(/--compression\s+(\S+)/);
        if (compressionMatch) {
            options.output_compression = Number(compressionMatch[1]);
            prompt = prompt.replace(compressionMatch[0], '').trim();
        }

        const backgroundMatch = input.match(/--background\s+(\S+)/);
        if (backgroundMatch) {
            options.background = backgroundMatch[1];
            prompt = prompt.replace(backgroundMatch[0], '').trim();
        }

        const moderationMatch = input.match(/--moderation\s+(\S+)/);
        if (moderationMatch) {
            options.moderation = moderationMatch[1];
            prompt = prompt.replace(moderationMatch[0], '').trim();
        }
        
        return { prompt: prompt.trim(), options };
    }
    
    /**
     * Search Unsplash for stock images
     */
    async searchUnsplash(query) {
        if (!query) {
            this.printError('Please provide a search query. Usage: /unsplash <query> [--orientation landscape|portrait|squarish]');
            return;
        }
        
        // Parse options
        let searchQuery = query;
        let orientation = null;
        
        const orientationMatch = query.match(/--orientation\s+(landscape|portrait|squarish)/);
        if (orientationMatch) {
            orientation = orientationMatch[1];
            searchQuery = searchQuery.replace(orientationMatch[0], '').trim();
        }
        
        if (!searchQuery) {
            this.printError('Please provide a search query. Usage: /unsplash <query> [--orientation landscape|portrait|squarish]');
            return;
        }
        
        this.isProcessing = true;
        this.setStatus('thinking');
        this.printSystem(`Searching Unsplash for "${searchQuery}"...`);
        
        try {
            const response = await api.searchUnsplash(searchQuery, { orientation });
            
            if (response.results && response.results.length > 0) {
                this.displayUnsplashResults(response.results, searchQuery, response.total);
            } else {
                this.printWarning(`No images found for "${searchQuery}"`);
            }
            
            this.setStatus('ready');
        } catch (error) {
            this.printError(`Unsplash search failed: ${error.message}`);
            this.setStatus('error');
        } finally {
            this.isProcessing = false;
        }
    }
    
    /**
     * Display Unsplash search results
     */
    displayUnsplashResults(results, query, total) {
        let output = `## Unsplash Results for "${this.escapeHtml(query)}"\n\n`;
        output += `Found ${total} images. Showing top ${results.length}:\n\n`;
        
        results.forEach((image, index) => {
            const num = index + 1;
            const author = image.author ? image.author.name : 'Unknown';
            const dimensions = `${image.width}x${image.height}`;
            
            output += `${num}. **${this.escapeHtml(image.altDescription || image.description || 'Untitled')}**\n`;
            output += `   Size: ${dimensions} | Likes: ${image.likes} | By: ${this.escapeHtml(author)}\n`;
            output += `   [View on Unsplash](${image.links.html})\n\n`;
            
            // Add small thumbnail preview
            output += `   <img src="${image.urls.small}" alt="${this.escapeHtml(image.altDescription || '')}" style="max-width: 300px; border-radius: 4px; margin: 5px 0;" />\n\n`;
        });
        
        output += `---\n`;
        output += `To download, click the image or visit the Unsplash link.\n`;
        output += `Images are licensed under the [Unsplash License](https://unsplash.com/license).`;
        
        this.printAI(output);
    }
    
    /**
     * Generate a Mermaid diagram file
     */
    async generateDiagram(type = 'flowchart', description = '') {
        this.isProcessing = true;
        this.setStatus('thinking');
        
        try {
            // Try to get AI-generated diagram code
            const diagramPrompt = `Create a ${type} diagram for: ${description || 'a simple process'}
            
Return ONLY Mermaid v10.9.5 compatible syntax code.
Use newline-separated statements.
Do not wrap the answer in markdown code fences.
Do not put the entire diagram on one line.`;
            
            const response = await api.sendMessage(diagramPrompt);
            let diagramCode = this.sanitizeMermaidCode(response.content || '', type);
            
            // If no valid code returned, use template
            if (!diagramCode || diagramCode.length < 10) {
                diagramCode = this.getMermaidTemplate(type, description);
            }

            const isValid = await this.validateMermaidCode(diagramCode);
            if (!isValid) {
                this.printWarning('AI-generated Mermaid was invalid for v10.9.5. Using a safe template instead.');
                diagramCode = this.getMermaidTemplate(type, description);
            }
            
            // Create and download file
            const baseName = `diagram-${type}-${Date.now()}`;
            const filename = `${baseName}.mmd`;
            this.downloadFile(diagramCode, filename, 'text/plain');
            const pdfFilename = `${baseName}.pdf`;
            let pdfBlob = null;
            try {
                pdfBlob = await this.createMermaidPdfBlob(diagramCode);
                this.downloadFile(pdfBlob, pdfFilename, 'application/pdf');
            } catch (pdfError) {
                console.error('[CLI] Mermaid PDF export failed:', pdfError);
                this.printWarning(`Mermaid PDF export failed: ${pdfError.message}`);
            }
            
            // Add to session files
            const file = this.addSessionFile(filename, diagramCode, 'text/plain', 'diagram');
            const pdfFile = pdfBlob
                ? this.addSessionFile(pdfFilename, pdfBlob, 'application/pdf', 'diagram')
                : null;
            
            // Show preview in terminal
            this.printAI(`## Generated ${type} diagram

\`\`\`mermaid
${diagramCode}
\`\`\`

**Downloaded:** ${filename}
${pdfFile ? `**Downloaded:** ${pdfFilename}\n` : ''}**File IDs:** #${file.id}${pdfFile ? `, #${pdfFile.id}` : ''} (use /files to manage)`);
            
            this.setStatus('ready');
        } catch (error) {
            // Fallback: generate template
            const diagramCode = this.getMermaidTemplate(type, description);
            const baseName = `diagram-${type}-${Date.now()}`;
            const filename = `${baseName}.mmd`;
            this.downloadFile(diagramCode, filename, 'text/plain');
            let pdfBlob = null;
            let pdfFilename = `${baseName}.pdf`;
            try {
                pdfBlob = await this.createMermaidPdfBlob(diagramCode);
                this.downloadFile(pdfBlob, pdfFilename, 'application/pdf');
            } catch (pdfError) {
                console.error('[CLI] Mermaid PDF fallback export failed:', pdfError);
            }
            
            // Add to session files
            const file = this.addSessionFile(filename, diagramCode, 'text/plain', 'diagram');
            const pdfFile = pdfBlob
                ? this.addSessionFile(pdfFilename, pdfBlob, 'application/pdf', 'diagram')
                : null;
            
            this.printAI(`## Generated ${type} diagram (template)

\`\`\`mermaid
${diagramCode}
\`\`\`

**Downloaded:** ${filename}
${pdfFile ? `**Downloaded:** ${pdfFilename}\n` : ''}**File IDs:** #${file.id}${pdfFile ? `, #${pdfFile.id}` : ''} (use /files to manage)`);
            
            this.setStatus('ready');
        } finally {
            this.isProcessing = false;
        }
    }
    
    /**
     * Get Mermaid template
     */
    getMermaidTemplate(type, description) {
        const desc = description || 'Process';
        const templates = {
            flowchart: `graph TD
    A[Start] --> B{${desc}?}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
    C --> E[Result]
    D --> E
    E --> F[End]`,
            sequence: `sequenceDiagram
    participant U as User
    participant S as System
    participant D as Database
    
    U->>S: ${desc}
    S->>D: Query data
    D-->>S: Return results
    S-->>U: Display response`,
            class: `classDiagram
    class User {
        +String name
        +String email
        +login()
        +logout()
    }
    class System {
        +process()
    }
    User --> System : uses
    note for User "${desc}"`,
            er: `erDiagram
    USER ||--o{ ORDER : places
    USER {
        string name
        string email
    }
    ORDER {
        int id
        date created
    }`,
            mindmap: `mindmap
  root((${desc}))
    Planning
      Research
      Design
    Execution
      Development
      Testing
    Delivery`,
            gantt: `gantt
    title ${desc} Timeline
    dateFormat  YYYY-MM-DD
    section Phase 1
    Planning           :done, p1, 2024-01-01, 7d
    Design             :active, p2, after p1, 7d
    section Phase 2
    Development        :p3, after p2, 14d
    Testing            :p4, after p3, 7d`,
            pie: `pie title ${desc}
    "Category A" : 40
    "Category B" : 30
    "Category C" : 20
    "Category D" : 10`,
            state: `stateDiagram-v2
    [*] --> Idle
    Idle --> Processing : ${desc}
    Processing --> Success : valid
    Processing --> Error : invalid
    Success --> [*]
    Error --> Idle : retry`,
            gitgraph: `gitGraph
    commit id: "Initial"
    branch feature
    checkout feature
    commit id: "Add feature"
    checkout main
    merge feature id: "Merge ${desc}"
    commit id: "Release"`
        };
        
        return templates[type] || templates.flowchart;
    }
    
    /**
     * Download file helper
     */
    downloadFile(content, filename, mimeType) {
        const a = document.createElement('a');
        let url = null;

        if (typeof content === 'string' && /^(data:|blob:|https?:|\/)/i.test(content)) {
            url = content;
        } else {
            const blob = new Blob([content], { type: mimeType });
            url = URL.createObjectURL(blob);
        }

        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        if (url.startsWith('blob:')) {
            URL.revokeObjectURL(url);
        }
    }
    
    // ==================== Session Management ====================

    resetLocalSessionState() {
        this.history = [];
        this.historyIndex = -1;
        this.lastResponse = '';
        this.currentOutput = '';
        this.sessionStartTime = Date.now();
        this.sessionFiles = [];
        this.nextFileId = 1;
        this.selectedRemoteArtifactIds = new Set();
    }

    getSessionDisplayName(session = null) {
        return String(
            session?.metadata?.title
            || session?.metadata?.label
            || session?.metadata?.name
            || session?.id
            || 'Untitled session',
        ).trim();
    }

    async handleSessionCommand(args = []) {
        const subcommand = String(args[0] || '').trim().toLowerCase();
        const rest = args.slice(1).join(' ').trim();

        if (!subcommand) {
            await this.printSessionInfo();
            return;
        }

        if (['new', 'create', 'start'].includes(subcommand)) {
            await this.startNewSession(rest);
            return;
        }

        if (['list', 'ls', 'sessions'].includes(subcommand)) {
            await this.listSessions();
            return;
        }

        if (['switch', 'use', 'open'].includes(subcommand)) {
            await this.switchSession(args[1]);
            return;
        }

        if (['delete', 'del', 'rm'].includes(subcommand)) {
            await this.deleteSession(args[1]);
            return;
        }

        this.printError('Usage: /session, /session new [name], /session list, /session switch <id>, or /session delete <id>');
    }

    async startNewSession(name = '', options = {}) {
        try {
            const sessionName = String(name || '').trim();
            const session = await api.createSession({
                title: sessionName || `Voxel CLI ${new Date().toLocaleString()}`,
            });
            this.resetLocalSessionState();
            this.updateSessionInfo();
            if (options.clear === true) {
                this.printWelcome();
            }
            this.printSystem(`Started isolated session ${session.id.slice(0, 8)}...${sessionName ? ` (${sessionName})` : ''}`);
        } catch (error) {
            this.printError(`Failed to start new session: ${error.message}`);
        }
    }

    async listSessions() {
        try {
            const data = await api.getSessionState();
            const sessions = Array.isArray(data.sessions) ? data.sessions : [];

            if (!sessions.length) {
                this.printSystem('No Voxel CLI sessions found. Use /new to start one.');
                return;
            }

            const activeSessionId = api.sessionId || data.activeSessionId || null;
            const lines = ['## Voxel CLI Sessions', ''];
            sessions.forEach((session, index) => {
                const marker = session.id === activeSessionId ? '*' : ' ';
                const title = this.getSessionDisplayName(session);
                const updatedAt = session.updatedAt ? new Date(session.updatedAt).toLocaleString() : 'unknown time';
                const count = Number(session.messageCount || 0);
                lines.push(`${marker} ${index + 1}. ${title}`);
                lines.push(`   ${session.id} | ${count} messages | ${updatedAt}`);
                lines.push('');
            });
            lines.push('Use `/switch <number-or-id>` to activate a session.');
            this.printAI(lines.join('\n'));
        } catch (error) {
            this.printError(`Failed to list sessions: ${error.message}`);
        }
    }

    async switchSession(sessionRef = '') {
        const ref = String(sessionRef || '').trim();
        if (!ref) {
            this.printError('Usage: /switch <number-or-session-id>');
            return;
        }

        try {
            const data = await api.getSessionState();
            const sessions = Array.isArray(data.sessions) ? data.sessions : [];
            const numericIndex = Number(ref);
            const session = Number.isInteger(numericIndex) && numericIndex >= 1
                ? sessions[numericIndex - 1]
                : sessions.find((candidate) => candidate.id === ref || candidate.id.startsWith(ref));

            if (!session) {
                this.printError(`Session not found: ${ref}`);
                return;
            }

            await api.setActiveSession(session.id);
            this.resetLocalSessionState();
            this.updateSessionInfo();
            await this.renderPersistedSessionHistory(session.id, {
                clear: true,
                intro: `Switched to isolated session ${session.id.slice(0, 8)}... (${this.getSessionDisplayName(session)})`,
            });
        } catch (error) {
            this.printError(`Failed to switch session: ${error.message}`);
        }
    }

    async deleteSession(sessionRef = '') {
        const ref = String(sessionRef || '').trim();
        if (!ref) {
            this.printError('Usage: /delete <number-or-session-id>');
            return;
        }

        try {
            const data = await api.getSessionState();
            const sessions = Array.isArray(data.sessions) ? data.sessions : [];
            const numericIndex = Number(ref);
            const session = Number.isInteger(numericIndex) && numericIndex >= 1
                ? sessions[numericIndex - 1]
                : sessions.find((candidate) => candidate.id === ref || candidate.id.startsWith(ref));

            if (!session) {
                this.printError(`Session not found: ${ref}`);
                return;
            }

            const previousActiveSessionId = api.sessionId || data.activeSessionId || null;
            await api.deleteSession(session.id);
            this.printSystem(`Deleted isolated session ${session.id.slice(0, 8)}... (${this.getSessionDisplayName(session)})`);

            const wasActive = session.id === previousActiveSessionId;
            if (!wasActive) {
                return;
            }

            const remaining = sessions.filter((candidate) => candidate.id !== session.id);
            if (remaining[0]) {
                await api.setActiveSession(remaining[0].id);
                this.resetLocalSessionState();
                this.updateSessionInfo();
                await this.renderPersistedSessionHistory(remaining[0].id, {
                    clear: true,
                    intro: `Selected isolated session ${remaining[0].id.slice(0, 8)}... (${this.getSessionDisplayName(remaining[0])})`,
                });
                return;
            }

            api.clearSession();
            this.resetLocalSessionState();
            this.updateSessionInfo();
            this.printWelcome();
            this.printSystem('No Voxel CLI sessions remain. Use /new to start one.');
        } catch (error) {
            this.printError(`Failed to delete session: ${error.message}`);
        }
    }
    
    async printSessionInfo() {
        const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const queueSize = this.commandQueue.length;
        let historyCount = 0;
        let artifactCount = 0;

        if (api.sessionId) {
            try {
                const [messages, artifacts] = await Promise.all([
                    api.getSessionMessages(api.sessionId, 200),
                    api.getSessionArtifacts(api.sessionId),
                ]);
                historyCount = messages.length;
                artifactCount = artifacts.length;
            } catch (error) {
                console.warn('Failed to load session details:', error);
            }
        }

        this.printSystem(`Session Info:
  Isolated Session: ${api.sessionId || 'new on next request'}
  Duration: ${minutes}m ${seconds}s
  Backend History: ${historyCount}
  Backend Artifacts: ${artifactCount}
  Files: ${this.sessionFiles.length}
  Queue: ${queueSize}
  Commands: ${this.commandHistory.length}`);
    }

    async showSessionHistory() {
        if (!api.sessionId) {
            this.printSystem('No isolated session is active yet. Use /new or send a message to create one.');
            return;
        }

        try {
            const messages = await api.getSessionMessages(api.sessionId, 40);
            if (!messages.length) {
                this.printSystem('No persisted backend history for this session yet.');
                return;
            }

            const lines = ['## Isolated Session History', ''];
            messages.forEach((message, index) => {
                const role = String(message.role || 'unknown').toUpperCase();
                const timestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : 'unknown time';
                const content = String(message.content || '').trim() || '[empty]';
                lines.push(`${index + 1}. ${role} | ${timestamp}`);
                lines.push(content);
                lines.push('');
            });
            this.printAI(lines.join('\n'));
        } catch (error) {
            this.printError(`Failed to load session history: ${error.message}`);
        }
    }

    async showSessionArtifacts() {
        if (!api.sessionId) {
            this.printSystem('No isolated session is active yet. Use /new or send a message to create one.');
            return;
        }

        try {
            const artifacts = await api.getSessionArtifacts(api.sessionId);
            this.syncArtifactsToSessionFiles(artifacts);
            if (!artifacts.length) {
                this.printSystem('No persisted artifacts for this session yet.');
                return;
            }

            const lines = ['## Isolated Session Artifacts', ''];
            artifacts.forEach((artifact, index) => {
                const filename = artifact.filename || artifact.id || `artifact-${index + 1}`;
                const format = String(artifact.format || 'file').toUpperCase();
                const size = Number.isFinite(Number(artifact.sizeBytes))
                    ? this.formatFileSize(Number(artifact.sizeBytes))
                    : 'unknown size';
                const createdAt = artifact.createdAt ? new Date(artifact.createdAt).toLocaleString() : 'unknown time';
                lines.push(`${index + 1}. ${filename}`);
                lines.push(`   ${format} | ${size} | ${createdAt}`);
                if (artifact.downloadUrl) {
                    lines.push(`   Download: ${artifact.downloadUrl}`);
                }
                lines.push('');
            });
            this.printAI(lines.join('\n'));
        } catch (error) {
            this.printError(`Failed to load session artifacts: ${error.message}`);
        }
    }
    saveConversation(name) {
        const data = {
            history: this.history,
            timestamp: Date.now(),
            model: api.currentModel,
        };
        localStorage.setItem(`codecli_conv_${name}`, JSON.stringify(data));
        this.printSystem(`Conversation saved as "${name}"`);
    }
    loadConversation(name) {
        const data = localStorage.getItem(`codecli_conv_${name}`);
        if (data) {
            const parsed = JSON.parse(data);
            this.history = parsed.history || [];
            this.printSystem(`Conversation "${name}" loaded (${this.history.length} messages)`);
        } else {
            this.printError(`Conversation "${name}" not found`);
        }
    }
    
    getTranscriptEntries() {
        const nodes = Array.from(this.terminalOutput?.children || []);
        return nodes
            .map((node) => {
                const text = String(node.innerText || node.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
                if (!text) {
                    return null;
                }
                let role = 'system';
                if (node.classList?.contains('line-input')) {
                    role = 'user';
                } else if (node.classList?.contains('ai')) {
                    role = 'assistant';
                } else if (node.classList?.contains('error')) {
                    role = 'error';
                } else if (node.classList?.contains('success')) {
                    role = 'success';
                }
                return {
                    role,
                    text,
                };
            })
            .filter(Boolean);
    }

    async getTranscriptExportData() {
        let source = 'terminal-dom';
        let messages = [];
        if (api.sessionId) {
            try {
                const backendMessages = await api.getSessionMessages(api.sessionId, 200);
                if (Array.isArray(backendMessages) && backendMessages.length > 0) {
                    messages = backendMessages
                        .map((message) => ({
                            role: String(message.role || 'unknown').toLowerCase(),
                            content: String(message.displayContent || message.content || '').trim(),
                            timestamp: message.timestamp || message.createdAt || null,
                        }))
                        .filter((message) => message.content);
                    if (messages.length > 0) {
                        source = 'backend-messages';
                    }
                }
            } catch (error) {
                console.warn('[WebCLI] Falling back to DOM transcript export:', error);
            }
        }

        if (messages.length === 0) {
            messages = this.getTranscriptEntries().map((entry) => ({
                role: entry.role,
                content: entry.text,
                timestamp: null,
            }));
        }

        return {
            app: 'Lilly CLI',
            exportedAt: new Date().toISOString(),
            sessionId: api.sessionId || null,
            model: api.currentModel || null,
            theme: this.theme,
            source,
            commandHistory: [...this.history],
            sessionFiles: this.sessionFiles.map((file) => ({
                id: file.id,
                filename: file.filename,
                type: file.type,
                mimeType: file.mimeType,
                size: file.size,
                createdAt: file.createdAt,
                artifactId: file.artifactId || null,
                downloadUrl: file.downloadUrl || null,
            })),
            messages,
        };
    }

    buildTranscriptMarkdown(data) {
        const lines = [
            '# Lilly CLI Transcript',
            '',
            `- Exported: ${data.exportedAt}`,
            `- Session: ${data.sessionId || 'new'}`,
            `- Model: ${data.model || 'default'}`,
            `- Source: ${data.source || 'terminal-dom'}`,
            `- Files: ${data.sessionFiles.length}`,
            '',
            '---',
            '',
        ];

        data.messages.forEach((entry, index) => {
            const title = entry.role.charAt(0).toUpperCase() + entry.role.slice(1);
            const timestamp = entry.timestamp ? ` | ${entry.timestamp}` : '';
            lines.push(`## ${index + 1}. ${title}${timestamp}`, '', entry.content, '');
        });

        if (data.sessionFiles.length > 0) {
            lines.push('---', '', '## Session Files', '');
            data.sessionFiles.forEach((file) => {
                lines.push(`- ${file.id}. ${file.filename} (${this.formatFileSize(file.size || 0)}, ${file.type || 'file'})`);
            });
        }

        return lines.join('\n');
    }

    buildTranscriptText(data) {
        const header = [
            'Lilly CLI Transcript',
            `Exported: ${data.exportedAt}`,
            `Session: ${data.sessionId || 'new'}`,
            `Model: ${data.model || 'default'}`,
            `Source: ${data.source || 'terminal-dom'}`,
            `Files: ${data.sessionFiles.length}`,
            ''.padEnd(40, '='),
            '',
        ];
        const body = data.messages.flatMap((entry, index) => [
            `${index + 1}. ${entry.role.toUpperCase()}${entry.timestamp ? ` | ${entry.timestamp}` : ''}`,
            entry.content,
            ''.padEnd(40, '-'),
        ]);
        return [...header, ...body].join('\n');
    }

    buildTranscriptHtml(data) {
        const transcript = data.messages.map((entry, index) => `
            <section class="entry entry-${this.escapeHtmlAttr(entry.role)}">
                <h2>${index + 1}. ${this.escapeHtml(entry.role.charAt(0).toUpperCase() + entry.role.slice(1))}</h2>
                ${entry.timestamp ? `<div class="timestamp">${this.escapeHtml(entry.timestamp)}</div>` : ''}
                <pre>${this.escapeHtml(entry.content)}</pre>
            </section>
        `).join('\n');
        const files = data.sessionFiles.map((file) => `
            <li>${this.escapeHtml(String(file.id))}. ${this.escapeHtml(file.filename)} <span>${this.escapeHtml(this.formatFileSize(file.size || 0))}</span></li>
        `).join('\n');
        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lilly CLI Transcript</title>
  <style>
    :root { color-scheme: light dark; --text: #111827; --muted: #667085; --surface: #ffffff; --panel: #f8fafc; --border: #d9e1ea; --accent: #0f766e; }
    body { margin: 0; padding: 32px; color: var(--text); background: var(--panel); font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
    main { max-width: 980px; margin: 0 auto; }
    header, .entry, .files { margin-bottom: 16px; padding: 18px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
    h1, h2 { margin: 0 0 10px; }
    h1 { font-size: 22px; }
    h2 { font-size: 15px; color: var(--accent); }
    .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 18px; color: var(--muted); }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
    li span { color: var(--muted); }
    @media (prefers-color-scheme: dark) { :root { --text: #edf2f7; --muted: #aab8c7; --surface: #151c23; --panel: #0f141a; --border: #334155; --accent: #5fb3a9; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Lilly CLI Transcript</h1>
      <div class="meta">
        <div>Exported: ${this.escapeHtml(data.exportedAt)}</div>
        <div>Session: ${this.escapeHtml(data.sessionId || 'new')}</div>
        <div>Model: ${this.escapeHtml(data.model || 'default')}</div>
        <div>Source: ${this.escapeHtml(data.source || 'terminal-dom')}</div>
        <div>Files: ${this.escapeHtml(String(data.sessionFiles.length))}</div>
      </div>
    </header>
    ${transcript}
    ${data.sessionFiles.length > 0 ? `<section class="files"><h2>Session Files</h2><ul>${files}</ul></section>` : ''}
  </main>
</body>
</html>`;
    }

    async exportSession(format = 'md') {
        const normalizedFormat = String(format || 'md').trim().toLowerCase();
        if (['help', '?', 'list'].includes(normalizedFormat)) {
            this.printAI('## Export Session\n\nUse `/export md`, `/export txt`, `/export html`, or `/export json`. The toolbar Export button uses Markdown by default.');
            return;
        }

        const data = await this.getTranscriptExportData();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const formats = {
            md: {
                content: this.buildTranscriptMarkdown(data),
                filename: `lilly-cli-${stamp}.md`,
                mimeType: 'text/markdown',
            },
            markdown: {
                content: this.buildTranscriptMarkdown(data),
                filename: `lilly-cli-${stamp}.md`,
                mimeType: 'text/markdown',
            },
            txt: {
                content: this.buildTranscriptText(data),
                filename: `lilly-cli-${stamp}.txt`,
                mimeType: 'text/plain',
            },
            text: {
                content: this.buildTranscriptText(data),
                filename: `lilly-cli-${stamp}.txt`,
                mimeType: 'text/plain',
            },
            html: {
                content: this.buildTranscriptHtml(data),
                filename: `lilly-cli-${stamp}.html`,
                mimeType: 'text/html',
            },
            json: {
                content: JSON.stringify(data, null, 2),
                filename: `lilly-cli-${stamp}.json`,
                mimeType: 'application/json',
            },
        };

        const output = formats[normalizedFormat];
        if (!output) {
            this.printError('Unsupported export format. Use /export md, /export txt, /export html, or /export json.');
            return;
        }

        this.downloadFile(output.content, output.filename, output.mimeType);
        this.printSystem(`Transcript exported as ${output.filename}`);
    }
    
    // ==================== File Management ====================
    
    /**
     * Add a file to the session
     */
    addSessionFile(filename, content, mimeType, type = 'generated', metadata = {}) {
        const file = {
            id: this.nextFileId++,
            filename,
            content,
            mimeType,
            type,
            size: Number.isFinite(Number(metadata.size))
                ? Number(metadata.size)
                : new Blob([content || '']).size,
            createdAt: metadata.createdAt || new Date().toISOString(),
            artifactId: metadata.artifactId || null,
            downloadUrl: metadata.downloadUrl || null,
            previewUrl: metadata.previewUrl || null,
            bundleDownloadUrl: metadata.bundleDownloadUrl || null,
            artifact: metadata.artifact && typeof metadata.artifact === 'object'
                ? { ...metadata.artifact }
                : null,
        };
        this.sessionFiles.push(file);
        return file;
    }

    collectArtifactsFromValue(value, depth = 0) {
        if (depth > 5 || value == null) {
            return [];
        }

        if (Array.isArray(value)) {
            return value.flatMap((entry) => this.collectArtifactsFromValue(entry, depth + 1));
        }

        if (typeof value !== 'object') {
            return [];
        }

        const artifacts = [];
        const normalized = this.normalizeArtifactFileSource(value);
        if (normalized) {
            artifacts.push(normalized);
        }

        [
            'artifact',
            'artifacts',
            'document',
            'documents',
            'generatedArtifact',
            'generatedArtifacts',
            'resultFiles',
            'siteBundleArtifact',
            'video',
            'videoArtifact',
            'data',
            'result',
        ].forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                artifacts.push(...this.collectArtifactsFromValue(value[key], depth + 1));
            }
        });

        return artifacts;
    }

    normalizeArtifactFileSource(artifact = null) {
        if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
            return null;
        }

        const sharedNormalized = window.KimiBuiltRemoteArtifactWorkflow?.normalizeArtifact?.(artifact);
        if (sharedNormalized) {
            artifact = {
                ...artifact,
                ...sharedNormalized,
            };
        }

        const rawId = String(artifact.id || artifact.artifactId || artifact.artifact_id || artifact.documentId || '').trim();
        const id = WEB_CLI_SELECTED_ARTIFACT_ID_PATTERN.test(rawId) ? rawId : '';
        const filename = String(artifact.filename || artifact.name || '').trim();
        const downloadUrl = String(artifact.bundleDownloadUrl || artifact.bundle_download_url || artifact.downloadUrl || artifact.download_url || artifact.inlinePath || '').trim();
        const previewUrl = String(artifact.previewUrl || artifact.preview_url || artifact.sandboxUrl || '').trim();
        const artifactLike = Boolean(
            filename
            || downloadUrl
            || previewUrl
            || artifact.artifactId
            || artifact.artifact_id
            || artifact.documentId
            || artifact.document_id
            || artifact.format
            || artifact.extension
            || artifact.mimeType
            || artifact.mime_type
        );

        if (!artifactLike || (!id && !downloadUrl && !previewUrl)) {
            return null;
        }

        const extension = String(artifact.extension || artifact.format || '').trim().replace(/^\./, '');
        const fallbackDownloadUrl = id ? `/api/artifacts/${encodeURIComponent(id)}/download` : '';
        return {
            ...artifact,
            id,
            filename: filename || (id ? `${id}${extension ? `.${extension}` : ''}` : 'artifact'),
            mimeType: String(artifact.mimeType || artifact.mime_type || 'application/octet-stream').trim(),
            sizeBytes: Number.isFinite(Number(artifact.sizeBytes || artifact.size))
                ? Number(artifact.sizeBytes || artifact.size)
                : 0,
            downloadUrl: downloadUrl || previewUrl || fallbackDownloadUrl,
            previewUrl,
            bundleDownloadUrl: String(artifact.bundleDownloadUrl || artifact.bundle_download_url || '').trim(),
        };
    }

    syncArtifactsToSessionFiles(artifacts = [], type = 'artifact') {
        const added = [];
        const seenInBatch = new Set();

        (Array.isArray(artifacts) ? artifacts : [artifacts]).forEach((artifact) => {
            const normalized = this.normalizeArtifactFileSource(artifact);
            if (!normalized) {
                return;
            }

            const identity = normalized.id
                || normalized.downloadUrl
                || normalized.bundleDownloadUrl
                || normalized.previewUrl
                || normalized.filename;
            if (!identity || seenInBatch.has(identity)) {
                return;
            }
            seenInBatch.add(identity);

            const existing = this.sessionFiles.find((file) => (
                (normalized.id && file.artifactId === normalized.id)
                || (normalized.downloadUrl && (file.downloadUrl === normalized.downloadUrl || file.content === normalized.downloadUrl))
                || (normalized.bundleDownloadUrl && file.bundleDownloadUrl === normalized.bundleDownloadUrl)
            ));
            if (existing) {
                existing.filename = normalized.filename || existing.filename;
                existing.mimeType = normalized.mimeType || existing.mimeType;
                existing.size = normalized.sizeBytes || existing.size;
                existing.downloadUrl = normalized.downloadUrl || existing.downloadUrl;
                existing.previewUrl = normalized.previewUrl || existing.previewUrl;
                existing.bundleDownloadUrl = normalized.bundleDownloadUrl || existing.bundleDownloadUrl;
                existing.content = normalized.bundleDownloadUrl || normalized.downloadUrl || normalized.previewUrl || existing.content;
                existing.artifact = {
                    ...(existing.artifact || {}),
                    ...normalized,
                };
                return;
            }

            const content = normalized.bundleDownloadUrl || normalized.downloadUrl || normalized.previewUrl || '';
            const file = this.addSessionFile(
                normalized.filename,
                content,
                normalized.mimeType,
                type,
                {
                    size: normalized.sizeBytes,
                    createdAt: normalized.createdAt,
                    artifactId: normalized.id,
                    downloadUrl: normalized.downloadUrl,
                    previewUrl: normalized.previewUrl,
                    bundleDownloadUrl: normalized.bundleDownloadUrl,
                    artifact: normalized,
                }
            );
            added.push(file);
        });

        return added;
    }

    async syncStoredSessionArtifacts({ throwOnError = false } = {}) {
        if (!api.sessionId) {
            return [];
        }

        try {
            const artifacts = await api.getSessionArtifacts(api.sessionId);
            return this.syncArtifactsToSessionFiles(artifacts);
        } catch (error) {
            console.warn('[CLI] Failed to sync stored artifacts into session files:', error);
            if (throwOnError) {
                throw error;
            }
            return [];
        }
    }

    getSelectedRemoteArtifactIds() {
        const availableIds = new Set(
            this.sessionFiles
                .map((file) => String(file?.artifactId || '').trim())
                .filter(Boolean),
        );
        return Array.from(this.selectedRemoteArtifactIds || [])
            .map((artifactId) => String(artifactId || '').trim())
            .filter((artifactId, index, values) => (
                artifactId
                && availableIds.has(artifactId)
                && values.indexOf(artifactId) === index
            ));
    }

    toggleRemoteArtifact(fileId) {
        const normalizedFileId = Number.parseInt(fileId, 10);
        const file = this.sessionFiles.find((entry) => entry.id === normalizedFileId);
        const artifactId = String(file?.artifactId || '').trim();
        if (!artifactId) {
            this.printError('Only persisted session artifacts can be sent to a remote agent.');
            return false;
        }

        if (!(this.selectedRemoteArtifactIds instanceof Set)) {
            this.selectedRemoteArtifactIds = new Set();
        }
        if (this.selectedRemoteArtifactIds.has(artifactId)) {
            this.selectedRemoteArtifactIds.delete(artifactId);
        } else {
            this.selectedRemoteArtifactIds.add(artifactId);
        }
        if (document.getElementById('file-manager-modal')) {
            this.renderFileManager({
                focusSelector: `.file-use-btn[data-file-id="${normalizedFileId}"]`,
            });
        }
        return this.selectedRemoteArtifactIds.has(artifactId);
    }

    prepareRemoteAgentFromSelection() {
        const selectedCount = this.getSelectedRemoteArtifactIds().length;
        if (selectedCount === 0) {
            this.printError('Select at least one persisted artifact with "Use with Agent" first.');
            return;
        }
        this.closeFileManager();
        this.commandInput.value = '/remote agent ';
        this.commandInput.focus();
        this.printSystem(`${selectedCount} artifact${selectedCount === 1 ? '' : 's'} attached to the next remote agent run.`);
    }

    isManagedAppCandidate(file = null) {
        if (!file?.artifactId) {
            return false;
        }
        const artifact = file.artifact || {};
        const metadata = artifact.metadata && typeof artifact.metadata === 'object' ? artifact.metadata : {};
        const format = String(artifact.format || artifact.extension || file.filename?.split('.').pop() || '').toLowerCase();
        const mimeType = String(artifact.mimeType || file.mimeType || '').toLowerCase();
        return Boolean(
            metadata.siteBundle
            || metadata.bundle
            || artifact.preview?.type === 'site'
            || format === 'html'
            || mimeType.includes('text/html')
        );
    }

    promptForManagedAppHost(file = null) {
        const helpers = window.KimiBuiltRemoteArtifactWorkflow || {};
        const artifact = file?.artifact || file || {};
        const suggested = typeof helpers.getSuggestedDnsLabel === 'function'
            ? helpers.getSuggestedDnsLabel(artifact)
            : String(file?.filename || 'site').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'site';
        const entered = window.prompt(
            `Choose a public DNS name. Enter a subdomain like "${suggested}" or a full host.`,
            suggested,
        );
        if (entered === null) {
            return null;
        }
        if (typeof helpers.resolveRequestedPublicHost === 'function') {
            return helpers.resolveRequestedPublicHost(entered, helpers.DEFAULT_PUBLIC_WEB_DOMAIN || 'demoserver2.buzz');
        }
        const dnsName = String(entered || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
        return dnsName ? { dnsName, publicHost: `${dnsName}.demoserver2.buzz`, slug: dnsName } : null;
    }

    async pushArtifactToWeb(fileId) {
        const normalizedFileId = Number.parseInt(fileId, 10);
        const file = this.sessionFiles.find((entry) => entry.id === normalizedFileId);
        if (!this.isManagedAppCandidate(file)) {
            this.printError('Only a persisted HTML or site-bundle artifact can be pushed to the web.');
            return null;
        }
        const artifactId = String(file.artifactId || '').trim();
        if (!(this.webPushInFlightArtifactIds instanceof Set)) {
            this.webPushInFlightArtifactIds = new Set();
        }
        if (this.webPushInFlightArtifactIds.has(artifactId)) {
            this.printSystem(`Push to Web is already running for ${file.filename}.`);
            return null;
        }
        this.webPushInFlightArtifactIds.add(artifactId);
        this.setWebPushButtonBusy(normalizedFileId, true);

        try {
            this.printSystem(`Checking final deploy bytes for ${file.filename}...`);
            const preflight = await api.preflightManagedAppArtifact(file.artifactId);
            const blocker = Array.isArray(preflight?.blockers) ? preflight.blockers[0] : null;
            if (preflight?.pushToWebEligible !== true) {
                const message = blocker?.message || 'This artifact is not eligible for Push to Web yet.';
                throw new Error(blocker?.remediation ? `${message} Next: ${blocker.remediation}` : message);
            }
            const expectedSourceSha256 = String(preflight.sha256 || '').trim().toLowerCase();
            if (!/^[a-f0-9]{64}$/.test(expectedSourceSha256)) {
                throw new Error('Website preflight did not return a valid final-byte fingerprint.');
            }
            const requestedHost = this.promptForManagedAppHost(file);
            if (!requestedHost) {
                this.printSystem('Push to Web cancelled before deployment.');
                return null;
            }

            const result = await api.deployManagedAppArtifact(file.artifactId, {
                requestedAction: 'deploy',
                deployRequested: true,
                dnsName: requestedHost.dnsName,
                publicBaseDomain: window.KimiBuiltRemoteArtifactWorkflow?.DEFAULT_PUBLIC_WEB_DOMAIN || 'demoserver2.buzz',
                publicHost: requestedHost.publicHost,
                slug: requestedHost.slug,
                expectedSourceSha256,
                metadata: {
                    requestedPublicHost: requestedHost.publicHost,
                    acmeRequestHost: requestedHost.publicHost,
                },
            });
            const publicHost = result?.publicHost || result?.app?.publicHost || requestedHost.publicHost;
            this.printSystem(`Queued ${file.filename} for https://${publicHost}.`);
            this.closeFileManager();
            return result;
        } catch (error) {
            const sourceChanged = [
                'ARTIFACT_MANAGED_APP_SOURCE_CHANGED',
                'ARTIFACT_MANAGED_APP_SOURCE_HASH_MISMATCH',
            ].includes(error?.code) || error?.status === 412;
            this.printError(sourceChanged
                ? 'The website source changed after preflight. Review it and run Push to Web again.'
                : `Push to Web failed: ${error.message}`);
            return null;
        } finally {
            this.webPushInFlightArtifactIds.delete(artifactId);
            this.setWebPushButtonBusy(normalizedFileId, false);
        }
    }

    setWebPushButtonBusy(fileId, busy) {
        const button = document.querySelector(`.file-push-btn[data-file-id="${Number.parseInt(fileId, 10)}"]`);
        if (!button) {
            return;
        }
        button.disabled = busy === true;
        button.setAttribute('aria-busy', busy === true ? 'true' : 'false');
        button.textContent = busy === true ? 'Pushing...' : 'Push to Web';
    }
    
    /**
     * List all session files
     */
    async listFiles() {
        await this.syncStoredSessionArtifacts();

        if (this.sessionFiles.length === 0) {
            this.printSystem('No files in this session. Generate files with /diagram, /image, or AI file generation.');
            return;
        }
        
        const lines = ['## Session Files', ''];
        lines.push('ID  | Name                          | Type       | Size   | Created');
        lines.push('----|-------------------------------|------------|--------|----------------');
        
        this.sessionFiles.forEach(file => {
            const id = String(file.id).padStart(3);
            const name = file.filename.substring(0, 30).padEnd(30);
            const type = file.type.padEnd(10);
            const size = this.formatFileSize(file.size).padEnd(6);
            const time = new Date(file.createdAt).toLocaleTimeString();
            lines.push(`${id} | ${name} | ${type} | ${size} | ${time}`);
        });
        
        lines.push('');
        lines.push('Commands: /download <id> | /open (GUI) | Click file in output');
        
        this.printAI(lines.join('\n'));
    }
    
    /**
     * Download a file by ID
     */
    async downloadFileById(id) {
        const fileId = parseInt(id, 10);
        const file = this.sessionFiles.find(f => f.id === fileId);
        
        if (!file) {
            this.printError(`File #${id} not found. Use /files to see available files.`);
            return;
        }
        
        this.downloadFile(file.content, file.filename, file.mimeType);
        this.printSystem(`Downloaded: ${file.filename}`);
    }
    
    /**
     * Format file size
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
    
    /**
     * Open file manager modal
     */
    openFileManager() {
        const activeElement = document.activeElement;
        this.fileManagerReturnFocus = activeElement && activeElement !== document.body && typeof activeElement.focus === 'function'
            ? activeElement
            : null;
        return this.syncStoredSessionArtifacts().then(() => this.renderFileManager()).catch(() => this.renderFileManager());
    }

    renderFileManager({ focusSelector = '' } = {}) {
        // Remove existing modal
        const existing = document.getElementById('file-manager-modal');
        if (existing) existing.remove();

        const fileCount = this.sessionFiles.length;
        const hasFiles = fileCount > 0;
        const downloadAllLabel = hasFiles
            ? `Download all ${fileCount} session ${fileCount === 1 ? 'file' : 'files'}`
            : 'No session files to download';
        const selectedCount = this.getSelectedRemoteArtifactIds().length;
        const buildSelectedLabel = selectedCount > 0
            ? `Build with remote agent using ${selectedCount} selected ${selectedCount === 1 ? 'artifact' : 'artifacts'}`
            : 'Select persisted artifacts to build with a remote agent';
        
        const modal = document.createElement('div');
        modal.id = 'file-manager-modal';
        modal.className = 'file-manager-modal';
        modal.innerHTML = `
            <div class="file-manager-overlay" onclick="app.closeFileManager()" aria-hidden="true"></div>
            <div class="file-manager-content" role="dialog" aria-modal="true" aria-labelledby="file-manager-title" aria-describedby="file-manager-description">
                <div class="file-manager-header">
                    <h3 id="file-manager-title">Session Files (${fileCount})</h3>
                    <button class="file-manager-close" type="button" onclick="app.closeFileManager()" aria-label="Close file manager">&times;</button>
                </div>
                <p id="file-manager-description" class="file-manager-description">
                    Select persisted artifacts for Codex or Kimi; download files; or push an eligible website after preflight.
                </p>
                <div class="file-manager-body">
                    ${!hasFiles ?
                        '<div class="file-manager-empty">No files yet. Generate files with /diagram, /image, or ask the AI.</div>' :
                        this.sessionFiles.map(f => {
                            const fileId = this.escapeHtmlAttr(String(f.id));
                            const filename = this.escapeHtml(f.filename);
                            const filenameAttr = this.escapeHtmlAttr(f.filename);
                            const fileType = this.escapeHtml(f.type);
                            const fileSize = this.escapeHtml(this.formatFileSize(f.size));
                            const artifactId = String(f.artifactId || '').trim();
                            const artifactIdAttr = this.escapeHtmlAttr(artifactId);
                            const selected = artifactId && this.selectedRemoteArtifactIds?.has(artifactId);
                            const canPush = this.isManagedAppCandidate(f);
                            const pushBusy = canPush && this.webPushInFlightArtifactIds?.has(artifactId);
                            return `
                            <article class="file-item${selected ? ' is-selected' : ''}"${artifactId ? ` data-artifact-id="${artifactIdAttr}"` : ''}>
                                <span class="file-icon" aria-hidden="true">${this.getFileIcon(f.filename)}</span>
                                <span class="file-item-copy">
                                    <span class="file-name">${filename}</span>
                                    <span class="file-meta">${fileSize} | ${fileType}${artifactId ? ` | artifact ${this.escapeHtml(artifactId)}` : ' | local file'}</span>
                                </span>
                                <span class="file-item-actions">
                                    ${artifactId ? `<button class="file-use-btn" data-file-id="${fileId}" type="button" onclick="app.toggleRemoteArtifact('${fileId}')" aria-pressed="${selected ? 'true' : 'false'}" aria-label="${selected ? 'Remove' : 'Use'} ${filenameAttr} ${selected ? 'from' : 'with'} the remote agent">${selected ? 'Selected' : 'Use with Agent'}</button>` : ''}
                                    ${canPush ? `<button class="file-push-btn" data-file-id="${fileId}" type="button" onclick="app.pushArtifactToWeb('${fileId}')" aria-label="Push ${filenameAttr} to the web" aria-busy="${pushBusy ? 'true' : 'false'}" ${pushBusy ? 'disabled' : ''}>${pushBusy ? 'Pushing...' : 'Push to Web'}</button>` : ''}
                                    <button class="file-download-btn" type="button" onclick="app.downloadFileById('${fileId}')" aria-label="Download ${filenameAttr}">Download</button>
                                </span>
                            </article>
                        `;
                        }).join('')
                    }
                </div>
                <div class="file-manager-footer">
                    <button class="btn" type="button" onclick="app.closeFileManager()">Close</button>
                    <button class="btn" type="button" onclick="app.downloadAllFiles()" aria-label="${downloadAllLabel}" ${hasFiles ? '' : 'disabled'}>Download All</button>
                    <button class="btn btn-primary" type="button" onclick="app.prepareRemoteAgentFromSelection()" aria-label="${buildSelectedLabel}" ${selectedCount > 0 ? '' : 'disabled'}>Build Selected (${selectedCount})</button>
                </div>
            </div>
        `;
        modal.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                this.closeFileManager();
                return;
            }
            if (event.key === 'Tab') {
                const focusable = Array.from(modal.querySelectorAll(
                    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
                ));
                if (focusable.length === 0) {
                    event.preventDefault();
                    return;
                }
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        });
        
        document.body.appendChild(modal);
        const requestedFocus = focusSelector ? modal.querySelector(focusSelector) : null;
        (requestedFocus || modal.querySelector('.file-manager-close'))?.focus();
    }

    /**
     * Close file manager modal
     */
    closeFileManager() {
        const modal = document.getElementById('file-manager-modal');
        if (modal) modal.remove();
        if (this.fileManagerReturnFocus && document.contains(this.fileManagerReturnFocus)) {
            this.fileManagerReturnFocus.focus();
        }
        this.fileManagerReturnFocus = null;
    }
    
    setDragOverlayActive(isActive) {
        if (!this.dragOverlay) {
            return;
        }

        const active = Boolean(isActive);
        this.dragOverlay.hidden = !active;
        this.dragOverlay.classList.toggle('active', active);
    }

    cancelDrag() {
        this.dragEnterCounter = 0;
        this.setDragOverlayActive(false);
    }
    
    /**
     * Get icon for file type
     */
    getFileIcon(filename) {
        const ext = filename.split('.').pop()?.toLowerCase();
        const icons = {
            mmd: 'MMD', png: 'IMG', jpg: 'IMG', jpeg: 'IMG', gif: 'IMG', svg: 'IMG',
            pdf: 'PDF', docx: 'DOC', doc: 'DOC', txt: 'TXT', md: 'MD',
            js: 'CODE', ts: 'CODE', py: 'CODE', html: 'CODE', css: 'CODE',
            json: 'DATA', xml: 'DATA', csv: 'DATA', xlsx: 'DATA',
            zip: 'ZIP', gz: 'ZIP',
        };
        return icons[ext] || 'FILE';
    }
    
    /**
     * Download all files as ZIP (simplified - downloads individually)
     */
    downloadAllFiles() {
        if (this.sessionFiles.length === 0) return;
        
        this.printSystem(`Downloading ${this.sessionFiles.length} files...`);
        this.sessionFiles.forEach((file, i) => {
            setTimeout(() => {
                this.downloadFile(file.content, file.filename, file.mimeType);
            }, i * 200);
        });
        this.closeFileManager();
    }
    
    // ==================== UI Methods ====================
    
    clearOutput() {
        this.terminalOutput.innerHTML = '';
        this.printWelcome();
    }

    getThemePresets() {
        return Array.isArray(this.themeCatalog?.presets) ? this.themeCatalog.presets : [];
    }

    getThemePreset(theme) {
        const normalized = String(theme || '').trim().toLowerCase();
        if (!normalized) {
            return null;
        }

        if (typeof this.themeCatalog?.getById === 'function') {
            return this.themeCatalog.getById(normalized);
        }

        return this.getThemePresets().find((preset) => preset.id === normalized) || null;
    }

    getDefaultSharedThemeId(mode = 'dark') {
        const normalizedMode = String(mode || '').trim().toLowerCase() === 'light' ? 'light' : 'dark';
        if (typeof this.themeCatalog?.getDefaultId === 'function') {
            return this.themeCatalog.getDefaultId(normalizedMode);
        }

        return this.themeCatalog?.defaults?.[normalizedMode] || (normalizedMode === 'light' ? 'paper' : 'obsidian');
    }

    normalizeThemeId(theme) {
        const normalized = String(theme || '').trim().toLowerCase();
        if (!normalized) {
            return '';
        }

        if (normalized === 'voxel') {
            return 'voxel';
        }

        const presets = this.getThemePresets();
        if (presets.length > 0) {
            if (normalized === 'dark' || normalized === 'light') {
                return this.getDefaultSharedThemeId(normalized);
            }

            return this.getThemePreset(normalized) ? normalized : '';
        }

        return ['dark', 'light'].includes(normalized) ? normalized : '';
    }

    getThemeCycleIds() {
        const presetIds = this.getThemePresets().map((preset) => preset.id);
        return presetIds.length > 0 ? [...presetIds, 'voxel'] : [WEB_CLI_DEFAULT_THEME, 'dark', 'light', 'voxel'];
    }

    getThemeLabel(theme = this.theme) {
        if (theme === 'voxel') {
            return 'Voxel';
        }

        const preset = this.getThemePreset(theme);
        if (preset) {
            return preset.name;
        }

        return theme === 'light' ? 'Light' : 'Dark';
    }

    getThemeOptionSummary() {
        const presets = this.getThemePresets();
        if (!presets.length) {
            return 'voxel, dark, or light';
        }

        return ['voxel', ...presets.map((preset) => preset.id)].join(', ');
    }

    printThemeList() {
        const presets = this.getThemePresets();
        if (!presets.length) {
            this.printAI('## Themes\n\n- `voxel`\n- `dark`\n- `light`');
            return;
        }

        const grouped = presets.reduce((groups, preset) => {
            const group = preset.group || 'core';
            if (!groups[group]) {
                groups[group] = [];
            }
            groups[group].push(preset);
            return groups;
        }, {});

        const labels = this.themeCatalog?.groupLabels || {};
        const lines = ['## Themes'];
        Object.keys(grouped).forEach((group) => {
            lines.push('', `### ${labels[group] || group}`);
            grouped[group].forEach((preset) => {
                const marker = preset.id === this.theme ? ' (current)' : '';
                lines.push(`- \`${preset.id}\` - ${preset.name}, ${preset.mode}${marker}`);
            });
        });
        lines.push('', '### Companion theme', '- `voxel` - Voxel CLI companion theme');

        this.printAI(lines.join('\n'));
    }
    
    cycleTheme() {
        const themes = this.getThemeCycleIds();
        const currentIndex = themes.indexOf(this.theme);
        const nextTheme = themes[(currentIndex + 1) % themes.length] || themes[0];
        this.setTheme(nextTheme, { silent: true });
        this.printSystem(`Theme: ${this.getThemeLabel(this.theme)}`);
    }

    normalizeDensity(value = '') {
        const normalized = String(value || '').trim().toLowerCase();
        if (['compact', 'dense', 'operator'].includes(normalized)) {
            return 'compact';
        }
        if (['comfortable', 'comfort', 'default', 'roomy'].includes(normalized)) {
            return 'comfortable';
        }
        return '';
    }

    getDensityLabel(value = this.density) {
        return value === 'compact' ? 'Compact' : 'Roomy';
    }

    applyDensity(value = this.density) {
        const density = this.normalizeDensity(value) || 'comfortable';
        this.density = density;
        document.body.setAttribute('data-density', density);
        localStorage.setItem(WEB_CLI_DENSITY_KEY, density);
        this.updateDensityButton();
        this.updateEnterpriseButton();
    }

    setDensity(value = '', options = {}) {
        const density = this.normalizeDensity(value);
        if (!density) {
            this.printError('Unknown density. Use /density compact or /density roomy.');
            return;
        }
        this.applyDensity(density);
        if (!options.silent) {
            this.printSystem(`Density: ${this.getDensityLabel(this.density)}`);
        }
    }

    cycleDensity(options = {}) {
        const nextDensity = this.density === 'compact' ? 'comfortable' : 'compact';
        this.applyDensity(nextDensity);
        if (!options.silent) {
            this.printSystem(`Density: ${this.getDensityLabel(this.density)}`);
        }
    }

    isEnterpriseModeActive() {
        return this.theme === WEB_CLI_DEFAULT_THEME
            && this.density === 'compact'
            && this.voxelPetHidden;
    }

    applyEnterpriseMode(options = {}) {
        this.setTheme(WEB_CLI_DEFAULT_THEME, { silent: true });
        this.applyDensity('compact');
        this.setVoxelPetHidden(true);
        this.updateEnterpriseButton();
        if (!options.silent) {
            this.printSystem('Enterprise Mode enabled: command-center theme, compact density, companion chrome hidden');
        }
    }

    setTheme(theme, options = {}) {
        const normalizedTheme = this.normalizeThemeId(theme);
        if (!normalizedTheme) {
            this.printError(`Unknown theme: ${theme}. Use ${this.getThemeOptionSummary()}.`);
            return;
        }

        this.theme = normalizedTheme;
        this.applyTheme(this.theme);
        this.persistThemePreference(this.theme);
        this.renderVoxelPet();
        if (!options.silent) {
            this.printSystem(`Theme: ${this.getThemeLabel(this.theme)}`);
        }
    }
    
    applyTheme(theme) {
        const normalizedTheme = this.normalizeThemeId(theme) || WEB_CLI_DEFAULT_THEME;
        const preset = this.getThemePreset(normalizedTheme);
        if (normalizedTheme === 'voxel') {
            document.body.setAttribute('data-theme', 'voxel');
            document.body.removeAttribute('data-chat-theme');
            this.clearSharedThemeProperties();
        } else {
            const mode = preset?.mode === 'light' || normalizedTheme === 'light' ? 'light' : 'dark';
            document.body.setAttribute('data-theme', mode);
            if (preset) {
                document.body.setAttribute('data-chat-theme', preset.id);
                this.applySharedThemeProperties(preset);
            } else {
                document.body.removeAttribute('data-chat-theme');
                this.clearSharedThemeProperties();
            }
        }
        this.updateThemeButton();
        this.updateEnterpriseButton();
        
        // Update mermaid theme
        if (typeof mermaid !== 'undefined') {
            mermaid.initialize({
                startOnLoad: false,
                theme: document.body.getAttribute('data-theme') === 'light' ? 'default' : 'dark',
                securityLevel: 'loose',
                fontFamily: 'var(--font-family)'
            });
        }
    }

    persistThemePreference(theme) {
        localStorage.setItem('codecli-theme', theme);
        const preset = this.getThemePreset(theme);
        if (!preset) {
            return;
        }

        const storageKeys = this.themeCatalog?.storageKeys || {
            preset: 'kimibuilt_theme_preset',
            mode: 'kimibuilt_theme',
        };
        localStorage.setItem(storageKeys.preset, preset.id);
        localStorage.setItem(storageKeys.mode, preset.mode);
    }

    applySharedThemeProperties(preset) {
        const mode = preset?.mode === 'light' ? 'light' : 'dark';
        const preview = preset?.preview || {};
        const palette = mode === 'light'
            ? {
                bgPrimary: '#f8fafc',
                bgSecondary: '#ffffff',
                bgTertiary: '#eef2f7',
                bgHover: '#e2e8f0',
                border: 'rgba(15, 23, 42, 0.14)',
                textPrimary: '#172033',
                textSecondary: '#475569',
                textMuted: '#64748b',
                overlay: 'rgba(15, 23, 42, 0.28)',
                panelShadow: '0 18px 44px rgba(15, 23, 42, 0.14)',
                controlShadow: '0 10px 24px rgba(15, 23, 42, 0.08)',
            }
            : {
                bgPrimary: '#0d1117',
                bgSecondary: '#161b22',
                bgTertiary: '#21262d',
                bgHover: '#30363d',
                border: 'rgba(148, 163, 184, 0.16)',
                textPrimary: '#e5edf5',
                textSecondary: '#a7b4c4',
                textMuted: '#95a4b5',
                overlay: 'rgba(2, 6, 12, 0.72)',
                panelShadow: '0 20px 54px rgba(0, 0, 0, 0.34)',
                controlShadow: '0 10px 24px rgba(0, 0, 0, 0.18)',
            };

        const accent = preview.accent || (mode === 'light' ? '#2563eb' : '#58a6ff');
        const properties = {
            '--bg-primary': palette.bgPrimary,
            '--bg-secondary': palette.bgSecondary,
            '--bg-tertiary': palette.bgTertiary,
            '--bg-hover': palette.bgHover,
            '--border-color': palette.border,
            '--text-primary': palette.textPrimary,
            '--text-secondary': palette.textSecondary,
            '--text-muted': palette.textMuted,
            '--accent': accent,
            '--accent-hover': accent,
            '--success': mode === 'light' ? '#15803d' : '#238636',
            '--success-bright': mode === 'light' ? '#16a34a' : '#3fb950',
            '--warning': mode === 'light' ? '#a16207' : '#d29922',
            '--error': mode === 'light' ? '#dc2626' : '#f85149',
            '--info': accent,
            '--cli-theme-page-background': preview.background || palette.bgPrimary,
            '--cli-theme-panel-background': preview.surface || palette.bgSecondary,
            '--cli-theme-output-background': preview.assistantBubble || palette.bgSecondary,
            '--cli-theme-user-background': mode === 'light'
                ? palette.bgTertiary
                : (preview.userBubble || accent),
            '--cli-theme-overlay-background': palette.overlay,
            '--cli-theme-panel-shadow': palette.panelShadow,
            '--cli-theme-control-shadow': palette.controlShadow,
            '--cli-theme-accent-ring': mode === 'light' ? 'rgba(37, 99, 235, 0.18)' : 'rgba(88, 166, 255, 0.2)',
        };

        Object.entries(properties).forEach(([name, value]) => {
            document.body.style.setProperty(name, value);
        });
    }

    clearSharedThemeProperties() {
        [
            '--bg-primary',
            '--bg-secondary',
            '--bg-tertiary',
            '--bg-hover',
            '--border-color',
            '--text-primary',
            '--text-secondary',
            '--text-muted',
            '--accent',
            '--accent-hover',
            '--success',
            '--success-bright',
            '--warning',
            '--error',
            '--info',
            '--cli-theme-page-background',
            '--cli-theme-panel-background',
            '--cli-theme-output-background',
            '--cli-theme-user-background',
            '--cli-theme-overlay-background',
            '--cli-theme-panel-shadow',
            '--cli-theme-control-shadow',
            '--cli-theme-accent-ring',
        ].forEach((property) => document.body.style.removeProperty(property));
    }

    updateThemeButton() {
        if (!this.themeButton) {
            return;
        }

        const label = this.getThemeLabel(this.theme);
        this.themeButton.title = `Theme: ${label}`;
        this.themeButton.setAttribute('aria-label', `Cycle theme. Current theme: ${label}`);
        const textNode = this.themeButton.querySelector('span');
        if (textNode) {
            textNode.textContent = label;
        }
    }

    updateDensityButton() {
        if (!this.densityButton) {
            return;
        }
        const label = this.getDensityLabel(this.density);
        this.densityButton.title = `Density: ${label}`;
        this.densityButton.setAttribute('aria-label', `Cycle layout density. Current density: ${label}`);
        const textNode = this.densityButton.querySelector('span');
        if (textNode) {
            textNode.textContent = label;
        }
        this.densityButton.classList.toggle('is-active', this.density === 'compact');
    }

    updateEnterpriseButton() {
        if (!this.enterpriseButton) {
            return;
        }
        const active = this.isEnterpriseModeActive();
        this.enterpriseButton.classList.toggle('is-active', active);
        this.enterpriseButton.setAttribute('aria-pressed', String(active));
        this.enterpriseButton.title = active ? 'Enterprise Mode active' : 'Enable Enterprise Mode';
        this.enterpriseButton.setAttribute('aria-label', active ? 'Enterprise Mode active' : 'Enable Enterprise Mode');
    }
    
    async copyLastOutput() {
        if (this.lastResponse) {
            try {
                await this.writeClipboardText(this.lastResponse);
                this.printSystem('Last response copied to clipboard');
            } catch (_error) {
                this.printWarning('Clipboard unavailable. Use /export md for a saved transcript.');
            }
        } else {
            this.printWarning('No response to copy');
        }
    }
    
    async copyCode(btn) {
        const code = btn.closest('.code-block').querySelector('code').textContent;
        try {
            await this.writeClipboardText(code);
            const originalText = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(() => btn.textContent = originalText, 2000);
        } catch (_error) {
            this.printWarning('Clipboard unavailable. Select and copy the code manually.');
        }
    }
    
    showShortcuts() {
        const activeElement = document.activeElement;
        this.shortcutsReturnFocus = activeElement && activeElement !== document.body && typeof activeElement.focus === 'function'
            ? activeElement
            : null;

        document.getElementById('shortcutsContent').innerHTML = `
            <div class="cli-shortcuts-list">
                <div class="cli-shortcuts-row">
                    <span>Send message</span>
                    <code class="inline-code">Enter</code>
                </div>
                <div class="cli-shortcuts-row">
                    <span>Command history</span>
                    <code class="inline-code">Up / Down</code>
                </div>
                <div class="cli-shortcuts-row">
                    <span>Autocomplete</span>
                    <code class="inline-code">Tab</code>
                </div>
                <div class="cli-shortcuts-row">
                    <span>Clear screen</span>
                    <code class="inline-code">Ctrl + L</code>
                </div>
                <div class="cli-shortcuts-row">
                    <span>Copy last response</span>
                    <code class="inline-code">Ctrl + C</code>
                </div>
                <div class="cli-shortcuts-row">
                    <span>Show help</span>
                    <code class="inline-code">F1</code>
                </div>
                <div class="cli-shortcuts-row">
                    <span>File manager</span>
                    <code class="inline-code">Ctrl + Shift + F</code>
                </div>
                <div class="cli-shortcuts-row cli-shortcuts-row--last">
                    <span>Close/cancel</span>
                    <code class="inline-code">Esc</code>
                </div>
            </div>
        `;
        this.shortcutsModal.setAttribute('aria-hidden', 'false');
        this.shortcutsModal.classList.add('active');
        this.shortcutsModal.querySelector('.modal-close')?.focus();
    }
    
    closeShortcuts() {
        if (!this.shortcutsModal.classList.contains('active')) {
            return;
        }

        this.shortcutsModal.classList.remove('active');
        this.shortcutsModal.setAttribute('aria-hidden', 'true');
        if (this.shortcutsReturnFocus && typeof this.shortcutsReturnFocus.focus === 'function') {
            this.shortcutsReturnFocus.focus({ preventScroll: true });
        }
        this.shortcutsReturnFocus = null;
    }

    handleShortcutsKeydown(e) {
        if (e.key !== 'Escape') {
            return;
        }

        e.preventDefault();
        this.closeShortcuts();
    }
    
    // ==================== Autocomplete ====================
    
    updateAutocomplete() {
        const input = this.commandInput.value;
        if (!input.startsWith('/')) {
            this.hideAutocomplete();
            return;
        }
        
        const matches = this.getCommandMatches(input);
        const exactMatch = this.getExactCommandEntry(input);
        if (matches.length === 0 || (exactMatch && !exactMatch.requiresInput)) {
            this.hideAutocomplete();
            return;
        }
        
        this.autocompleteMatches = matches;
        this.autocompleteIndex = 0;
        
        this.autocompleteEl.innerHTML = matches.map((match, i) => `
            <button
                type="button"
                id="autocomplete-option-${i}"
                class="autocomplete-item ${i === 0 ? 'selected' : ''}"
                data-index="${i}"
                role="option"
                aria-selected="${i === 0 ? 'true' : 'false'}"
            >
                <span class="autocomplete-main">
                    <span class="autocomplete-title">
                        <code>${this.escapeHtml(match.command)}</code>
                        <strong>${this.escapeHtml(match.label || match.command)}</strong>
                    </span>
                    <span class="autocomplete-description">${this.escapeHtml(match.description || 'CLI command')}</span>
                </span>
                ${match.arguments ? `<span class="autocomplete-args">${this.escapeHtml(match.arguments)}</span>` : ''}
            </button>
        `).join('');
        
        this.autocompleteEl.classList.remove('hidden');
        this.commandInput.setAttribute('aria-expanded', 'true');
        this.commandInput.setAttribute('aria-activedescendant', 'autocomplete-option-0');
        
        // Click handlers
        this.autocompleteEl.querySelectorAll('.autocomplete-item').forEach(item => {
            item.addEventListener('click', () => {
                const match = this.autocompleteMatches[Number(item.dataset.index)];
                this.activateCommandEntry(match, { source: 'autocomplete' });
            });
        });
    }

    getExactCommandEntry(input = '') {
        const normalized = String(input || '').trim().toLowerCase();
        if (!normalized) {
            return null;
        }

        return this.commandCatalog.find((command) => [command.command, ...(command.aliases || [])]
            .filter(Boolean)
            .some((candidate) => String(candidate).trim().toLowerCase() === normalized)) || null;
    }
    
    navigateAutocomplete(direction) {
        if (this.autocompleteMatches.length === 0) return;
        
        this.autocompleteIndex += direction;
        if (this.autocompleteIndex < 0) {
            this.autocompleteIndex = this.autocompleteMatches.length - 1;
        } else if (this.autocompleteIndex >= this.autocompleteMatches.length) {
            this.autocompleteIndex = 0;
        }
        
        this.autocompleteEl.querySelectorAll('.autocomplete-item').forEach((item, i) => {
            const isSelected = i === this.autocompleteIndex;
            item.classList.toggle('selected', isSelected);
            item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
            if (isSelected) {
                this.commandInput.setAttribute('aria-activedescendant', item.id);
            }
            if (isSelected && typeof item.scrollIntoView === 'function') {
                item.scrollIntoView({ block: 'nearest' });
            }
        });
    }
    
    selectAutocomplete() {
        if (this.autocompleteIndex >= 0) {
            this.activateCommandEntry(this.autocompleteMatches[this.autocompleteIndex], { source: 'keyboard' });
        }
    }
    
    hideAutocomplete() {
        this.autocompleteEl.classList.add('hidden');
        this.commandInput.setAttribute('aria-expanded', 'false');
        this.commandInput.removeAttribute('aria-activedescendant');
        this.autocompleteMatches = [];
        this.autocompleteIndex = -1;
    }
    
    handleTabCompletion() {
        const input = this.commandInput.value;
        if (input.startsWith('/')) {
            const matches = this.getCommandMatches(input);
            if (matches.length === 1) {
                this.activateCommandEntry(matches[0], { source: 'tab' });
            } else if (matches.length > 0) {
                this.printSystem('Commands: ' + matches.map((match) => match.command).join(', '));
            }
        }
    }
    
    // ==================== History ====================
    
    navigateHistory(direction) {
        if (this.history.length === 0) return;
        
        this.historyIndex += direction;
        if (this.historyIndex < 0) {
            this.historyIndex = 0;
        } else if (this.historyIndex >= this.history.length) {
            this.historyIndex = this.history.length;
            this.commandInput.value = '';
            return;
        }
        
        this.commandInput.value = this.history[this.historyIndex];
    }
    
    saveCommandHistory() {
        localStorage.setItem('codecli-cmd-history', JSON.stringify(this.history.slice(-100)));
    }
    
    // ==================== Streaming Helpers ====================
    
    getStreamingLine() {
        const lines = this.terminalOutput.querySelectorAll('.line-output.ai');
        const lastLine = lines[lines.length - 1] || null;
        return lastLine?.classList.contains('streaming') ? lastLine : null;
    }

    ensureStreamingLine() {
        const existing = this.getStreamingLine();
        if (existing) {
            return existing;
        }

        const line = document.createElement('div');
        line.className = 'line line-output ai streaming pixel-streaming';
        line.innerHTML = this.renderAIContent('', {
            title: 'Streaming',
            meta: `${api.currentModel || 'default'} | ${this.voxelPet?.name || 'voxel companion'}`,
            streaming: true,
        });
        this.terminalOutput.appendChild(line);
        return line;
    }

    updateStreamingLine(text, options = {}) {
        const line = this.ensureStreamingLine();
        line.innerHTML = this.renderAIContent(text, {
            title: options.title || 'Streaming',
            meta: `${api.currentModel || 'default'} | ${this.voxelPet?.name || 'voxel companion'}`,
            streaming: true,
        });
        this.scrollToBottom();
        return line;
    }

    getPixelStreamStep() {
        const backlog = this.pixelStreamBuffer.length;
        if (backlog > 2400) return 18;
        if (backlog > 900) return 10;
        if (backlog > 240) return 6;
        return 2;
    }

    startPixelStreamDrain() {
        if (this.pixelStreamTimer) {
            return;
        }

        const tick = () => {
            if (!this.pixelStreamBuffer) {
                this.pixelStreamTimer = null;
                const waiters = this.pixelStreamWaiters.splice(0);
                waiters.forEach((resolve) => resolve());
                return;
            }

            const step = this.getPixelStreamStep();
            const next = this.pixelStreamBuffer.slice(0, step);
            this.pixelStreamBuffer = this.pixelStreamBuffer.slice(step);
            this.currentOutput += next;
            this.updateStreamingLine(this.currentOutput);

            if (!this.voxelPetHidden && this.currentOutput.length % 96 < step) {
                this.roamVoxelPet(this.getVoxelRoamPlacement('scout'), 'scout', 2800);
            }

            const delay = this.pixelStreamBuffer.length > 900 ? 12 : 28;
            this.pixelStreamTimer = window.setTimeout(tick, delay);
        };

        this.pixelStreamTimer = window.setTimeout(tick, 18);
    }

    waitForPixelStreamDrain() {
        if (!this.pixelStreamBuffer && !this.pixelStreamTimer) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            this.pixelStreamWaiters.push(resolve);
        });
    }

    appendToCurrentOutput(text) {
        const chunk = String(text || '');
        if (!chunk) {
            return;
        }

        if (this.theme === 'voxel') {
            this.ensureStreamingLine();
            this.pixelStreamBuffer += chunk;
            this.startPixelStreamDrain();
            return;
        }

        // For streaming responses - update the last AI output line
        const lines = this.terminalOutput.querySelectorAll('.line-output.ai');
        const lastLine = lines[lines.length - 1];
        if (lastLine && lastLine.classList.contains('streaming')) {
            lastLine.innerHTML = this.renderAIContent(this.currentOutput + chunk, {
                title: 'Streaming',
                meta: `${api.currentModel || 'default'} | ${this.voxelPet?.name || 'voxel companion'}`,
                streaming: true,
            });
            this.currentOutput += chunk;
            if (typeof hljs !== 'undefined') {
                lastLine.querySelectorAll('pre code').forEach((block) => {
                    if (block.classList.contains('language-mermaid') || block.classList.contains('nohighlight')) {
                        return;
                    }
                    hljs.highlightElement(block);
                });
            }
        } else {
            this.currentOutput = chunk;
            const line = document.createElement('div');
            line.className = 'line line-output ai streaming';
            line.innerHTML = this.renderAIContent(chunk, {
                title: 'Streaming',
                meta: `${api.currentModel || 'default'} | ${this.voxelPet?.name || 'voxel companion'}`,
                streaming: true,
            });
            this.terminalOutput.appendChild(line);
        }
        this.scrollToBottom();
    }
    
    /**
     * Trigger mermaid rendering (useful for re-rendering after streaming)
     */
    refreshMermaidDiagrams() {
        this.renderMermaidDiagrams(this.terminalOutput);
    }
    
    /**
     * Remove streaming line before printing final response
     */
    async finalizeStreamingOutput(finalText = '') {
        const expected = String(finalText || '');
        if (this.theme === 'voxel') {
            const pending = this.currentOutput + this.pixelStreamBuffer;
            if (expected && expected !== pending) {
                if (expected.startsWith(pending)) {
                    this.pixelStreamBuffer += expected.slice(pending.length);
                } else {
                    this.currentOutput = '';
                    this.pixelStreamBuffer = expected;
                }
            } else if (expected && !pending) {
                this.pixelStreamBuffer = expected;
            }

            if (this.pixelStreamBuffer) {
                this.ensureStreamingLine();
                this.startPixelStreamDrain();
                await this.waitForPixelStreamDrain();
            }

            const streamingLine = this.getStreamingLine();
            if (streamingLine) {
                streamingLine.classList.remove('streaming', 'pixel-streaming');
                streamingLine.innerHTML = this.renderAIContent(expected || this.currentOutput);
                this.finishAIContentLine(streamingLine);
                this.scrollToBottom();
                return streamingLine;
            }

            if (expected) {
                return this.printAI(expected);
            }
            return null;
        }

        const streamingLine = this.terminalOutput.querySelector('.line-output.ai.streaming');
        if (streamingLine) {
            streamingLine.classList.remove('streaming');
            streamingLine.innerHTML = this.renderAIContent(expected || this.currentOutput);
            this.finishAIContentLine(streamingLine);
            this.scrollToBottom();
            return streamingLine;
        }

        if (expected) {
            return this.printAI(expected);
        }

        return null;
    }
}

const app = new CodeCLIApp();
window.app = app;
