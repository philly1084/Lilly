/**
 * UI Helpers for LillyBuilt AI Chat
 * Handles rendering, markdown parsing, code highlighting, and UI utilities
 */

const webChatGatewayHelpers = window.KimiBuiltGatewaySSE || {};
const WEB_CHAT_DEFAULT_MODEL = webChatGatewayHelpers.DEFAULT_CODEX_MODEL_ID || 'auto';
const WEB_CHAT_LEGACY_DEFAULT_MODELS = new Set(['gpt-5.4-mini', 'gpt-4o', 'openrouter/auto']);
const webChatFilterChatModels = webChatGatewayHelpers.filterChatModels || ((models = []) => (
    Array.isArray(models) ? models.filter((model) => Boolean(String(model?.id || '').trim())) : []
));
const webChatIsChatModel = webChatGatewayHelpers.isChatModel || ((modelOrId = '') => {
    const id = typeof modelOrId === 'object'
        ? String(modelOrId?.id || '').trim()
        : String(modelOrId || '').trim();
    return Boolean(id) && !/(embed|image|gpt-image|dall-e|dalle|imagen|flux|diffusion|tts|speech|audio|transcribe|whisper|realtime|moderation)/i.test(id);
});
const WEB_CHAT_SHARED_THEMES = window.KimiBuiltThemePresets || {};
const WEB_CHAT_THEME_PRESET_STORAGE_KEY = WEB_CHAT_SHARED_THEMES.storageKeys?.preset || 'kimibuilt_theme_preset';
const WEB_CHAT_THEME_MODE_STORAGE_KEY = WEB_CHAT_SHARED_THEMES.storageKeys?.mode || 'kimibuilt_theme';
const WEB_CHAT_LONG_AGENT_DEFAULT_KEY = 'kimibuilt_long_agent_default_enabled';
const WEB_CHAT_SYNTHETIC_REASONING_TITLE = 'Live reasoning (day dreaming answers)';
const WEB_CHAT_ESTIMATED_REASONING_STEPS = Object.freeze([
    'Tune into the ask',
    'Find the clean route',
    'Fit the useful pieces',
    'Check the edges',
    'Bring the answer home',
]);
const WEB_CHAT_MAX_PROGRESS_DISPLAY_STEPS = 12;
const WEB_CHAT_THEME_DEFAULTS = WEB_CHAT_SHARED_THEMES.defaults || Object.freeze({
    dark: 'obsidian',
    light: 'paper',
});
const WEB_CHAT_THEME_GROUP_LABELS = WEB_CHAT_SHARED_THEMES.groupLabels || Object.freeze({
    core: 'Core themes',
    experimental: 'Experimental textures',
});
const WEB_CHAT_THEME_PRESETS = WEB_CHAT_SHARED_THEMES.presets || Object.freeze([
    {
        id: 'obsidian',
        name: 'Obsidian',
        mode: 'dark',
        description: 'Deep graphite glass with cool blue bloom and ember edge light.',
        metaColor: '#0a1018',
        preview: {
            background: 'radial-gradient(circle at 18% 18%, rgba(88, 166, 255, 0.28), transparent 36%), radial-gradient(circle at 82% 14%, rgba(255, 138, 91, 0.18), transparent 24%), linear-gradient(180deg, #060b12 0%, #0a1018 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.02)), rgba(16, 23, 34, 0.82)',
            userBubble: 'linear-gradient(135deg, #4f8df6, #3d8dff)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.015)), rgba(18, 27, 41, 0.92)',
            accent: '#58a6ff',
        },
    },
    {
        id: 'aurora',
        name: 'Aurora',
        mode: 'dark',
        description: 'Indigo and teal haze with a cooler glass treatment.',
        metaColor: '#0b1120',
        preview: {
            background: 'radial-gradient(circle at 12% 12%, rgba(99, 102, 241, 0.34), transparent 34%), radial-gradient(circle at 78% 16%, rgba(45, 212, 191, 0.22), transparent 26%), radial-gradient(circle at 52% 100%, rgba(125, 211, 252, 0.18), transparent 30%), linear-gradient(180deg, #070d1a 0%, #0d1324 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.08), rgba(190, 242, 255, 0.02)), rgba(18, 24, 43, 0.84)',
            userBubble: 'linear-gradient(135deg, #5b8cff, #2dd4bf)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(192, 132, 252, 0.02)), rgba(20, 28, 51, 0.9)',
            accent: '#7dd3fc',
        },
    },
    {
        id: 'nebula',
        name: 'Nebula',
        mode: 'dark',
        description: 'Violet night canvas with stardust glow and glassy magenta rims.',
        metaColor: '#120f1f',
        preview: {
            background: 'radial-gradient(circle at 14% 14%, rgba(192, 132, 252, 0.32), transparent 30%), radial-gradient(circle at 84% 18%, rgba(125, 211, 252, 0.2), transparent 26%), repeating-radial-gradient(circle at center, rgba(250, 204, 21, 0.12) 0 1px, transparent 1px 16px), linear-gradient(180deg, #090611 0%, #160f22 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(192, 132, 252, 0.015)), rgba(22, 18, 35, 0.86)',
            userBubble: 'linear-gradient(135deg, #a78bfa, #7dd3fc)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(167, 139, 250, 0.02)), rgba(24, 16, 39, 0.92)',
            accent: '#c084fc',
        },
    },
    {
        id: 'forest-glow',
        name: 'Forest Glow',
        mode: 'dark',
        description: 'Green-black glass with moss highlights and a wet-neon drift.',
        metaColor: '#0f1915',
        preview: {
            background: 'radial-gradient(circle at 16% 16%, rgba(74, 222, 128, 0.22), transparent 34%), radial-gradient(circle at 82% 18%, rgba(45, 212, 191, 0.2), transparent 26%), repeating-linear-gradient(45deg, rgba(16, 185, 129, 0.08) 0 2px, transparent 2px 14px), linear-gradient(180deg, #08110d 0%, #101f19 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(16, 185, 129, 0.015)), rgba(16, 31, 24, 0.86)',
            userBubble: 'linear-gradient(135deg, #4ade80, #2dd4bf)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(16, 185, 129, 0.02)), rgba(16, 35, 26, 0.92)',
            accent: '#4ade80',
        },
    },
    {
        id: 'harbor',
        name: 'Harbor',
        mode: 'dark',
        description: 'A navy harbor grid with cyan highlights and tidal depth.',
        metaColor: '#08131f',
        preview: {
            background: 'radial-gradient(circle at 20% 18%, rgba(56, 189, 248, 0.22), transparent 30%), repeating-linear-gradient(135deg, rgba(56, 189, 248, 0.08) 0 2px, transparent 2px 16px), linear-gradient(180deg, #07111b 0%, #0b1724 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(125, 211, 252, 0.015)), rgba(11, 24, 37, 0.86)',
            userBubble: 'linear-gradient(135deg, #38bdf8, #0ea5e9)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(14, 165, 233, 0.015)), rgba(16, 31, 46, 0.9)',
            accent: '#38bdf8',
        },
    },
    {
        id: 'ember',
        name: 'Ember',
        mode: 'dark',
        description: 'Charcoal surfaces warmed by copper glow and subtle woven texture.',
        metaColor: '#140d0b',
        preview: {
            background: 'radial-gradient(circle at 18% 18%, rgba(251, 146, 60, 0.22), transparent 30%), repeating-linear-gradient(45deg, rgba(251, 146, 60, 0.06) 0 2px, transparent 2px 14px), linear-gradient(180deg, #100909 0%, #18100f 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(251, 146, 60, 0.02)), rgba(27, 18, 16, 0.86)',
            userBubble: 'linear-gradient(135deg, #fb923c, #ea580c)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(251, 146, 60, 0.015)), rgba(31, 21, 19, 0.92)',
            accent: '#fb923c',
        },
    },
    {
        id: 'paper',
        name: 'Paper',
        mode: 'light',
        description: 'Stone paper wash with cool blue accents and gentle grain.',
        metaColor: '#f4f7fb',
        preview: {
            background: 'radial-gradient(circle at 12% 14%, rgba(61, 141, 255, 0.14), transparent 30%), radial-gradient(circle at 82% 16%, rgba(234, 106, 59, 0.08), transparent 22%), repeating-linear-gradient(0deg, rgba(148, 163, 184, 0.06) 0 1px, transparent 1px 14px), linear-gradient(180deg, #f8fafc 0%, #eef3f8 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(247, 250, 253, 0.92)), rgba(255, 255, 255, 0.94)',
            userBubble: 'linear-gradient(135deg, #3d8dff, #2e78e5)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 251, 255, 0.96)), rgba(255, 255, 255, 0.96)',
            accent: '#3d8dff',
        },
    },
    {
        id: 'frost',
        name: 'Frost',
        mode: 'light',
        description: 'Icy glass and pale blue bloom for a calm winter glow.',
        metaColor: '#eff6ff',
        preview: {
            background: 'radial-gradient(circle at 12% 16%, rgba(56, 189, 248, 0.2), transparent 30%), radial-gradient(circle at 82% 16%, rgba(167, 139, 250, 0.12), transparent 24%), repeating-linear-gradient(45deg, rgba(148, 163, 184, 0.08) 0 1px, transparent 1px 14px), linear-gradient(180deg, #f8fdff 0%, #f0f6ff 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.97), rgba(240, 249, 255, 0.94)), rgba(255, 255, 255, 0.94)',
            userBubble: 'linear-gradient(135deg, #0ea5e9, #2563eb)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(248, 252, 255, 0.96)), rgba(248, 252, 255, 0.96)',
            accent: '#0ea5e9',
        },
    },
    {
        id: 'linen',
        name: 'Linen',
        mode: 'light',
        description: 'Warm paper texture with soft cream, walnut, and graphite accents.',
        metaColor: '#f3eee4',
        preview: {
            background: 'radial-gradient(circle at 16% 14%, rgba(252, 211, 77, 0.18), transparent 30%), radial-gradient(circle at 82% 14%, rgba(148, 163, 184, 0.14), transparent 22%), radial-gradient(circle, rgba(120, 113, 108, 0.12) 1px, transparent 1px), linear-gradient(180deg, #f8f3ea 0%, #f1eadf 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 252, 246, 0.98), rgba(247, 238, 229, 0.94)), rgba(250, 244, 236, 0.94)',
            userBubble: 'linear-gradient(135deg, #3f4e5f, #1f2937)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(247, 238, 229, 0.97)), rgba(252, 246, 238, 0.96)',
            accent: '#3f4e5f',
        },
    },
    {
        id: 'daybreak',
        name: 'Daybreak',
        mode: 'light',
        description: 'Warm morning light with fine dotted texture and brighter blue detail.',
        metaColor: '#f6efe7',
        preview: {
            background: 'radial-gradient(circle at 16% 12%, rgba(250, 204, 21, 0.18), transparent 28%), radial-gradient(circle at 82% 12%, rgba(96, 165, 250, 0.16), transparent 24%), radial-gradient(circle, rgba(251, 146, 60, 0.08) 1px, transparent 1px), linear-gradient(180deg, #fbf4ec 0%, #f4ede5 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 252, 247, 0.98), rgba(250, 245, 238, 0.94)), rgba(255, 250, 244, 0.94)',
            userBubble: 'linear-gradient(135deg, #2f7bf6, #2563eb)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(255, 248, 242, 0.96)), rgba(255, 248, 242, 0.96)',
            accent: '#2f7bf6',
        },
    },
    {
        id: 'astral',
        name: 'Astral',
        mode: 'dark',
        description: 'Neon-blue constellation fields with deep violet gradients and subtle star points.',
        metaColor: '#0b1020',
        preview: {
            background: 'radial-gradient(circle at 18% 14%, rgba(99, 102, 241, 0.28), transparent 30%), radial-gradient(circle at 82% 16%, rgba(34, 211, 238, 0.2), transparent 24%), radial-gradient(circle at 50% 50%, rgba(236, 72, 153, 0.09) 1px, transparent 1px), linear-gradient(180deg, #070a16 0%, #10122a 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(236, 72, 153, 0.015)), rgba(22, 24, 50, 0.86)',
            userBubble: 'linear-gradient(135deg, #a78bfa, #22d3ee)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(167, 139, 250, 0.014)), rgba(22, 24, 48, 0.92)',
            accent: '#a78bfa',
        },
    },
    {
        id: 'circuit',
        name: 'Circuit',
        mode: 'dark',
        description: 'Graph-grid blueprints with electric cyan highlights and dense micro-lines.',
        metaColor: '#09111b',
        preview: {
            background: 'radial-gradient(circle at 16% 16%, rgba(96, 165, 250, 0.24), transparent 28%), repeating-linear-gradient(90deg, rgba(56, 189, 248, 0.08) 0 1px, transparent 1px 20px), repeating-linear-gradient(0deg, rgba(125, 211, 252, 0.06) 0 1px, transparent 1px 16px), linear-gradient(180deg, #080f18 0%, #0d1524 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(59, 130, 246, 0.02)), rgba(16, 26, 41, 0.86)',
            userBubble: 'linear-gradient(135deg, #60a5fa, #38bdf8)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(56, 189, 248, 0.015)), rgba(16, 28, 45, 0.92)',
            accent: '#60a5fa',
        },
    },
    {
        id: 'almond',
        name: 'Almond',
        mode: 'light',
        description: 'Soft almond paper with warm beige grain and subtle olive accents.',
        metaColor: '#f7efe4',
        preview: {
            background: 'radial-gradient(circle at 14% 14%, rgba(253, 230, 138, 0.2), transparent 30%), radial-gradient(circle at 82% 14%, rgba(148, 163, 184, 0.1), transparent 22%), repeating-linear-gradient(0deg, rgba(120, 113, 108, 0.05) 0 1px, transparent 1px 14px), linear-gradient(180deg, #f8f0e4 0%, #f2e9dc 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(246, 236, 224, 0.94)), rgba(252, 246, 236, 0.94)',
            userBubble: 'linear-gradient(135deg, #4b5563, #334155)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(246, 236, 224, 0.97)), rgba(252, 247, 239, 0.96)',
            accent: '#4b5563',
        },
    },
    {
        id: 'glacier',
        name: 'Glacier',
        mode: 'light',
        description: 'Clean glacier light with blue-white wash and quiet steel lines.',
        metaColor: '#eef6ff',
        preview: {
            background: 'radial-gradient(circle at 16% 12%, rgba(125, 211, 252, 0.16), transparent 28%), radial-gradient(circle at 84% 16%, rgba(191, 219, 254, 0.15), transparent 24%), repeating-linear-gradient(135deg, rgba(148, 163, 184, 0.07) 0 1px, transparent 1px 16px), linear-gradient(180deg, #f8fdff 0%, #edf6ff 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(247, 250, 255, 0.94)), rgba(255, 255, 255, 0.94)',
            userBubble: 'linear-gradient(135deg, #2563eb, #0ea5e9)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(247, 250, 255, 0.96)), rgba(247, 250, 255, 0.96)',
            accent: '#2563eb',
        },
    },
    {
        id: 'mosaic',
        name: 'Mosaic',
        mode: 'dark',
        description: 'Dense paper-like tessellation with jewel-toned edges and warm highlights.',
        metaColor: '#0d0f1e',
        preview: {
            background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.22) 0%, rgba(59, 130, 246, 0.18) 35%, rgba(139, 92, 246, 0.14) 100%), repeating-linear-gradient(45deg, rgba(236, 72, 153, 0.12) 0 2px, transparent 2px 14px), radial-gradient(circle at 72% 16%, rgba(250, 204, 21, 0.1), transparent 22%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(56, 189, 248, 0.015)), rgba(20, 20, 40, 0.86)',
            userBubble: 'linear-gradient(135deg, #7dd3fc, #a78bfa)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(236, 72, 153, 0.01)), rgba(28, 21, 46, 0.92)',
            accent: '#38bdf8',
        },
    },
    {
        id: 'inkwash',
        name: 'Inkwash',
        mode: 'dark',
        description: 'Painted ink washes with random pools of violet and cobalt.',
        metaColor: '#10121d',
        preview: {
            background: 'radial-gradient(circle at 20% 20%, rgba(15, 23, 42, 0.18), transparent 30%), radial-gradient(circle at 80% 14%, rgba(168, 85, 247, 0.22), transparent 24%), repeating-linear-gradient(135deg, rgba(148, 163, 184, 0.08) 0 1px, transparent 1px 20px), linear-gradient(180deg, #090b16 0%, #10121d 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(168, 85, 247, 0.015)), rgba(18, 20, 34, 0.86)',
            userBubble: 'linear-gradient(135deg, #a78bfa, #6366f1)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(99, 102, 241, 0.012)), rgba(24, 27, 49, 0.92)',
            accent: '#a78bfa',
        },
    },
    {
        id: 'topographic',
        name: 'Topographic',
        mode: 'dark',
        description: 'Undulating contour bands like layered topo maps in moody cyan.',
        metaColor: '#091019',
        preview: {
            background: 'radial-gradient(circle at 24% 18%, rgba(45, 212, 191, 0.25), transparent 28%), repeating-radial-gradient(circle at center, rgba(14, 165, 233, 0.08) 0 1px, transparent 1px 22px), repeating-linear-gradient(120deg, rgba(14, 165, 233, 0.06) 0 1px, transparent 1px 12px), linear-gradient(180deg, #070d15 0%, #0a1622 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(14, 165, 233, 0.012)), rgba(16, 27, 40, 0.86)',
            userBubble: 'linear-gradient(135deg, #67e8f9, #22d3ee)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(14, 165, 233, 0.01)), rgba(16, 30, 45, 0.9)',
            accent: '#67e8f9',
        },
    },
    {
        id: 'lattice',
        name: 'Lattice',
        mode: 'dark',
        description: 'Fine wireframe lattice with smoky shadows and electric edges.',
        metaColor: '#0c1724',
        preview: {
            background: 'radial-gradient(circle at 18% 16%, rgba(56, 189, 248, 0.24), transparent 30%), repeating-linear-gradient(60deg, rgba(59, 130, 246, 0.06) 0 1px, transparent 1px 12px), repeating-linear-gradient(150deg, rgba(45, 212, 191, 0.06) 0 1px, transparent 1px 12px), linear-gradient(180deg, #080f18 0%, #0f1f33 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(59, 130, 246, 0.012)), rgba(17, 28, 44, 0.86)',
            userBubble: 'linear-gradient(135deg, #60a5fa, #22d3ee)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(56, 189, 248, 0.01)), rgba(17, 30, 47, 0.9)',
            accent: '#60a5fa',
        },
    },
    {
        id: 'chalk',
        name: 'Chalk',
        mode: 'light',
        description: 'Hand-drawn chalk texture with soft gray dust and slate strokes.',
        metaColor: '#f4f6fb',
        preview: {
            background: 'linear-gradient(120deg, rgba(148, 163, 184, 0.08), rgba(226, 232, 240, 0.12)), repeating-linear-gradient(0deg, rgba(226, 232, 240, 0.08) 0 1px, transparent 1px 10px), repeating-linear-gradient(90deg, rgba(203, 213, 225, 0.08) 0 1px, transparent 1px 12px), linear-gradient(180deg, #f8fafc 0%, #eef2f8 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(249, 251, 253, 0.94)), rgba(248, 252, 255, 0.94)',
            userBubble: 'linear-gradient(135deg, #64748b, #475569)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(247, 250, 252, 0.97)), rgba(244, 248, 252, 0.96)',
            accent: '#64748b',
        },
    },
    {
        id: 'origami',
        name: 'Origami',
        mode: 'light',
        description: 'Folded-page geometry with pastel planes and gentle paper shadows.',
        metaColor: '#f9f6ef',
        preview: {
            background: 'linear-gradient(135deg, rgba(209, 213, 219, 0.35), rgba(241, 245, 249, 0.9)), repeating-linear-gradient(45deg, rgba(148, 163, 184, 0.12) 0 2px, transparent 2px 22px), linear-gradient(180deg, #f9fafc 0%, #f1f5f9 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(249, 250, 252, 0.94)), rgba(251, 253, 255, 0.94)',
            userBubble: 'linear-gradient(135deg, #64748b, #334155)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(249, 251, 253, 0.96)), rgba(251, 253, 255, 0.96)',
            accent: '#64748b',
        },
    },
    {
        id: 'sun-kiss',
        name: 'Sun Kiss',
        mode: 'light',
        description: 'Warm sunlight wash with paper grain and amber grainy streaks.',
        metaColor: '#f6efe7',
        preview: {
            background: 'radial-gradient(circle at 18% 14%, rgba(251, 191, 36, 0.22), transparent 30%), radial-gradient(circle at 82% 14%, rgba(251, 146, 60, 0.12), transparent 22%), repeating-linear-gradient(0deg, rgba(180, 83, 9, 0.06) 0 1px, transparent 1px 14px), linear-gradient(180deg, #fdf8f0 0%, #f4ebe0 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(252, 244, 235, 0.94)), rgba(252, 245, 237, 0.94)',
            userBubble: 'linear-gradient(135deg, #f59e0b, #ea580c)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(251, 246, 239, 0.96)), rgba(253, 246, 236, 0.96)',
            accent: '#f59e0b',
        },
    },
    {
        id: 'marble-veil',
        name: 'Marble Veil',
        mode: 'light',
        description: 'Soft marble veining with cool veils and brushed contrast.',
        metaColor: '#edf2f7',
        preview: {
            background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(226, 232, 240, 0.95)), radial-gradient(circle at 78% 18%, rgba(56, 189, 248, 0.1), transparent 28%), repeating-linear-gradient(35deg, rgba(203, 213, 225, 0.09) 0 2px, transparent 2px 16px), linear-gradient(180deg, #f8fafc 0%, #e5eaf2 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(237, 242, 247, 0.94)), rgba(245, 248, 251, 0.94)',
            userBubble: 'linear-gradient(135deg, #64748b, #334155)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(236, 240, 246, 0.96)), rgba(243, 247, 251, 0.96)',
            accent: '#64748b',
        },
    },
    {
        id: 'signal-grid',
        name: 'Signal Grid',
        mode: 'dark',
        description: 'Retro signal grid and luminous cyan streaking with deep glass.',
        metaColor: '#0b1421',
        preview: {
            background: 'radial-gradient(circle at 14% 14%, rgba(103, 232, 249, 0.28), transparent 28%), repeating-linear-gradient(90deg, rgba(56, 189, 248, 0.14) 0 1px, transparent 1px 22px), repeating-linear-gradient(0deg, rgba(14, 165, 233, 0.1) 0 1px, transparent 1px 24px), linear-gradient(180deg, #060d18 0%, #101e34 100%), radial-gradient(circle at 84% 18%, rgba(250, 204, 21, 0.09), transparent 26%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(6, 182, 212, 0.015)), rgba(18, 30, 50, 0.86)',
            userBubble: 'linear-gradient(135deg, #38bdf8, #22d3ee)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(14, 165, 233, 0.012)), rgba(20, 34, 57, 0.92)',
            accent: '#38bdf8',
        },
    },
    {
        id: 'storm-lattice',
        name: 'Storm Lattice',
        mode: 'dark',
        description: 'Tight geometric lattice with slate fog and electric edges.',
        metaColor: '#09111d',
        preview: {
            background: 'radial-gradient(circle at 20% 18%, rgba(148, 163, 184, 0.22), transparent 30%), repeating-linear-gradient(45deg, rgba(148, 163, 184, 0.08) 0 1px, transparent 1px 14px), repeating-linear-gradient(135deg, rgba(56, 189, 248, 0.08) 0 1px, transparent 1px 20px), linear-gradient(180deg, #080f1a 0%, #0d1d30 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(56, 189, 248, 0.012)), rgba(16, 30, 49, 0.86)',
            userBubble: 'linear-gradient(135deg, #93c5fd, #0ea5e9)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(59, 130, 246, 0.012)), rgba(17, 29, 49, 0.92)',
            accent: '#93c5fd',
        },
    },
    {
        id: 'ember-ash',
        name: 'Ember Ash',
        mode: 'dark',
        description: 'Smoked ember wash with charcoal grain and muted copper glints.',
        metaColor: '#160f14',
        preview: {
            background: 'radial-gradient(circle at 18% 16%, rgba(251, 146, 60, 0.22), transparent 30%), repeating-linear-gradient(120deg, rgba(120, 53, 15, 0.08) 0 1px, transparent 1px 16px), repeating-linear-gradient(60deg, rgba(68, 64, 60, 0.1) 0 1px, transparent 1px 18px), linear-gradient(180deg, #12070f 0%, #1e1114 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(251, 146, 60, 0.012)), rgba(28, 17, 18, 0.86)',
            userBubble: 'linear-gradient(135deg, #fb923c, #f97316)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(251, 146, 60, 0.01)), rgba(33, 20, 22, 0.92)',
            accent: '#fb923c',
        },
    },
    {
        id: 'stone-veil',
        name: 'Stone Veil',
        mode: 'dark',
        description: 'Polished concrete wall with subtle grit and low-contrast depth.',
        metaColor: '#121c27',
        preview: {
            background: 'radial-gradient(circle at 16% 16%, rgba(148, 163, 184, 0.18), transparent 30%), repeating-radial-gradient(circle at center, rgba(148, 163, 184, 0.08) 0 1px, transparent 1px 10px), linear-gradient(180deg, #0d1726 0%, #172338 100%), repeating-linear-gradient(0deg, rgba(226, 232, 240, 0.06) 0 1px, transparent 1px 16px)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(148, 163, 184, 0.01)), rgba(22, 34, 53, 0.86)',
            userBubble: 'linear-gradient(135deg, #93c5fd, #60a5fa)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(148, 163, 184, 0.008)), rgba(25, 37, 58, 0.92)',
            accent: '#93c5fd',
        },
    },
    {
        id: 'paper-dust',
        name: 'Paper Dust',
        mode: 'light',
        description: 'Earth-toned paper fibers with muted dust and warm cream bloom.',
        metaColor: '#f6efe6',
        preview: {
            background: 'radial-gradient(circle at 18% 12%, rgba(250, 204, 21, 0.14), transparent 30%), radial-gradient(circle at 82% 18%, rgba(120, 113, 108, 0.1), transparent 22%), repeating-linear-gradient(0deg, rgba(120, 113, 108, 0.08) 0 1px, transparent 1px 12px), linear-gradient(180deg, #f9f3eb 0%, #f0e7dd 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(250, 244, 236, 0.94)), rgba(247, 242, 235, 0.94)',
            userBubble: 'linear-gradient(135deg, #92400e, #b45309)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(250, 244, 236, 0.97)), rgba(252, 246, 238, 0.96)',
            accent: '#92400e',
        },
    },
    {
        id: 'linen-gold',
        name: 'Linen Gold',
        mode: 'light',
        description: 'Subtle linen weave with linen-gold stripes and antique softness.',
        metaColor: '#f5efe4',
        preview: {
            background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.12), rgba(253, 186, 116, 0.08)), repeating-linear-gradient(45deg, rgba(120, 113, 108, 0.08) 0 2px, transparent 2px 16px), repeating-linear-gradient(135deg, rgba(250, 204, 21, 0.07) 0 1px, transparent 1px 20px), linear-gradient(180deg, #f8f3ea 0%, #efe3d7 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 240, 231, 0.94)), rgba(246, 238, 226, 0.94)',
            userBubble: 'linear-gradient(135deg, #d97706, #b45309)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(246, 238, 230, 0.97)), rgba(248, 241, 230, 0.96)',
            accent: '#d97706',
        },
    },
    {
        id: 'aqua-plate',
        name: 'Aqua Plate',
        mode: 'light',
        description: 'Glazed tile wall with cool aqua ripples and thin graphite seams.',
        metaColor: '#edf4fb',
        preview: {
            background: 'radial-gradient(circle at 16% 14%, rgba(56, 189, 248, 0.2), transparent 30%), radial-gradient(circle at 84% 16%, rgba(14, 165, 233, 0.1), transparent 24%), repeating-linear-gradient(120deg, rgba(15, 118, 110, 0.08) 0 2px, transparent 2px 18px), linear-gradient(180deg, #f0f8ff 0%, #e7f1f9 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(236, 246, 255, 0.94)), rgba(240, 248, 255, 0.94)',
            userBubble: 'linear-gradient(135deg, #0ea5e9, #06b6d4)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(235, 245, 255, 0.97)), rgba(238, 246, 252, 0.96)',
            accent: '#0ea5e9',
        },
    },
    {
        id: 'brickpaper',
        name: 'Brickpaper',
        mode: 'light',
        description: 'Soft brick-like grout rhythm with cream washes and chalk strokes.',
        metaColor: '#f8f4ee',
        preview: {
            background: 'linear-gradient(180deg, #fcfbfa 0%, #f2ece2 100%), repeating-linear-gradient(45deg, rgba(120, 113, 108, 0.09) 0 1px, transparent 1px 14px), repeating-linear-gradient(0deg, rgba(148, 163, 184, 0.06) 0 1px, transparent 1px 12px), radial-gradient(circle at 72% 18%, rgba(217, 119, 6, 0.12), transparent 26%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(252, 248, 243, 0.94)), rgba(250, 245, 239, 0.94)',
            userBubble: 'linear-gradient(135deg, #b45309, #92400e)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(246, 239, 228, 0.97)), rgba(250, 244, 236, 0.96)',
            accent: '#b45309',
        },
    },
    {
        id: 'woodland-map',
        name: 'Woodland Map',
        mode: 'dark',
        group: 'experimental',
        description: 'Layered woodgrain, moss contour lines, and brass map markings.',
        metaColor: '#162018',
        preview: {
            background: 'linear-gradient(120deg, rgba(84, 56, 31, 0.5), rgba(31, 64, 45, 0.54)), repeating-radial-gradient(ellipse at 30% 20%, rgba(218, 165, 88, 0.14) 0 1px, transparent 1px 12px), repeating-linear-gradient(28deg, rgba(132, 204, 22, 0.08) 0 1px, transparent 1px 18px), linear-gradient(180deg, #12180f 0%, #203018 100%)',
            surface: 'linear-gradient(180deg, rgba(254, 243, 199, 0.08), rgba(45, 80, 44, 0.04)), rgba(29, 42, 27, 0.88)',
            userBubble: 'linear-gradient(135deg, #9a6b38, #537a3a)',
            assistantBubble: 'linear-gradient(180deg, rgba(254, 243, 199, 0.07), rgba(21, 128, 61, 0.02)), rgba(35, 44, 29, 0.92)',
            accent: '#d6a75c',
        },
    },
    {
        id: 'cedar-fog',
        name: 'Cedar Fog',
        mode: 'dark',
        group: 'experimental',
        description: 'Red cedar undertones, blue-green mist, and soft sawdust texture.',
        metaColor: '#231713',
        preview: {
            background: 'radial-gradient(circle at 18% 14%, rgba(251, 146, 60, 0.2), transparent 28%), radial-gradient(circle at 76% 18%, rgba(45, 212, 191, 0.18), transparent 25%), repeating-linear-gradient(92deg, rgba(180, 83, 9, 0.11) 0 2px, transparent 2px 16px), linear-gradient(180deg, #1b1110 0%, #26342d 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 237, 213, 0.07), rgba(20, 184, 166, 0.025)), rgba(43, 32, 27, 0.88)',
            userBubble: 'linear-gradient(135deg, #c46a32, #2f8f83)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 237, 213, 0.07), rgba(20, 184, 166, 0.02)), rgba(43, 34, 30, 0.92)',
            accent: '#e08a4f',
        },
    },
    {
        id: 'walnut-studio',
        name: 'Walnut Studio',
        mode: 'dark',
        group: 'experimental',
        description: 'Dark walnut panels, plum shadows, and muted studio-green values.',
        metaColor: '#1b1412',
        preview: {
            background: 'linear-gradient(135deg, rgba(68, 44, 30, 0.72), rgba(49, 46, 72, 0.42), rgba(36, 64, 51, 0.46)), repeating-linear-gradient(0deg, rgba(245, 158, 11, 0.08) 0 1px, transparent 1px 11px), repeating-linear-gradient(90deg, rgba(88, 28, 135, 0.1) 0 1px, transparent 1px 24px)',
            surface: 'linear-gradient(180deg, rgba(250, 204, 21, 0.06), rgba(88, 28, 135, 0.025)), rgba(38, 30, 29, 0.9)',
            userBubble: 'linear-gradient(135deg, #8b5e34, #58508d)',
            assistantBubble: 'linear-gradient(180deg, rgba(250, 204, 21, 0.055), rgba(21, 128, 61, 0.018)), rgba(42, 32, 31, 0.92)',
            accent: '#b8874a',
        },
    },
    {
        id: 'moss-copper',
        name: 'Moss Copper',
        mode: 'dark',
        group: 'experimental',
        description: 'Oxidized copper, mossy shadow, and brushed metal crosshatch.',
        metaColor: '#0f1e1a',
        preview: {
            background: 'radial-gradient(circle at 18% 18%, rgba(34, 197, 94, 0.2), transparent 30%), radial-gradient(circle at 78% 16%, rgba(217, 119, 6, 0.2), transparent 24%), repeating-linear-gradient(45deg, rgba(20, 184, 166, 0.09) 0 1px, transparent 1px 14px), repeating-linear-gradient(135deg, rgba(217, 119, 6, 0.08) 0 1px, transparent 1px 19px), linear-gradient(180deg, #0d1713 0%, #1c2f27 100%)',
            surface: 'linear-gradient(180deg, rgba(251, 191, 36, 0.06), rgba(20, 184, 166, 0.025)), rgba(19, 42, 34, 0.88)',
            userBubble: 'linear-gradient(135deg, #b56b2a, #2f9f72)',
            assistantBubble: 'linear-gradient(180deg, rgba(251, 191, 36, 0.055), rgba(20, 184, 166, 0.02)), rgba(21, 42, 34, 0.92)',
            accent: '#c47a35',
        },
    },
    {
        id: 'river-clay',
        name: 'River Clay',
        mode: 'light',
        group: 'experimental',
        description: 'Clay banks, river-blue glaze, and sandy sediment layers.',
        metaColor: '#efe5d2',
        preview: {
            background: 'radial-gradient(circle at 16% 14%, rgba(14, 165, 233, 0.18), transparent 30%), radial-gradient(circle at 82% 18%, rgba(194, 65, 12, 0.16), transparent 24%), repeating-linear-gradient(0deg, rgba(120, 113, 108, 0.09) 0 2px, transparent 2px 18px), linear-gradient(180deg, #f4ecdc 0%, #d9e6e2 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 252, 246, 0.98), rgba(224, 238, 235, 0.94)), rgba(241, 234, 221, 0.94)',
            userBubble: 'linear-gradient(135deg, #0e7490, #c15c30)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(235, 229, 216, 0.97)), rgba(247, 241, 230, 0.96)',
            accent: '#0e7490',
        },
    },
    {
        id: 'terrazzo-night',
        name: 'Terrazzo Night',
        mode: 'dark',
        group: 'experimental',
        description: 'Chunky terrazzo flecks over midnight plaster and coral glass.',
        metaColor: '#151621',
        preview: {
            background: 'radial-gradient(circle at 18% 18%, rgba(244, 114, 182, 0.18), transparent 28%), radial-gradient(circle at 72% 20%, rgba(45, 212, 191, 0.16), transparent 24%), radial-gradient(circle, rgba(251, 191, 36, 0.16) 1px, transparent 2px), radial-gradient(circle, rgba(125, 211, 252, 0.12) 1px, transparent 2px), linear-gradient(180deg, #11131d 0%, #202032 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(244, 114, 182, 0.018)), rgba(30, 31, 49, 0.9)',
            userBubble: 'linear-gradient(135deg, #f472b6, #2dd4bf)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 255, 0.055), rgba(251, 191, 36, 0.012)), rgba(31, 32, 51, 0.92)',
            accent: '#f472b6',
        },
    },
    {
        id: 'corkboard',
        name: 'Corkboard',
        mode: 'light',
        group: 'experimental',
        description: 'Pinned cork texture, navy ink, and muted red paper tabs.',
        metaColor: '#e9d8b6',
        preview: {
            background: 'radial-gradient(circle, rgba(120, 53, 15, 0.16) 1px, transparent 1px), radial-gradient(circle at 82% 18%, rgba(30, 64, 175, 0.12), transparent 24%), repeating-linear-gradient(35deg, rgba(180, 83, 9, 0.08) 0 1px, transparent 1px 12px), linear-gradient(180deg, #efdcb9 0%, #dbc393 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 248, 235, 0.98), rgba(232, 211, 174, 0.94)), rgba(239, 220, 184, 0.94)',
            userBubble: 'linear-gradient(135deg, #1d4ed8, #b45309)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 252, 244, 0.99), rgba(236, 219, 188, 0.96)), rgba(246, 231, 202, 0.96)',
            accent: '#1d4ed8',
        },
    },
    {
        id: 'patina-lab',
        name: 'Patina Lab',
        mode: 'dark',
        group: 'experimental',
        description: 'Blue-green patina, aged brass, and cloudy lab-glass texture.',
        metaColor: '#0c2426',
        preview: {
            background: 'radial-gradient(circle at 16% 15%, rgba(20, 184, 166, 0.3), transparent 30%), radial-gradient(circle at 78% 16%, rgba(250, 204, 21, 0.16), transparent 24%), repeating-linear-gradient(115deg, rgba(45, 212, 191, 0.08) 0 2px, transparent 2px 18px), linear-gradient(180deg, #092022 0%, #17383a 100%)',
            surface: 'linear-gradient(180deg, rgba(240, 253, 250, 0.06), rgba(250, 204, 21, 0.018)), rgba(16, 48, 50, 0.88)',
            userBubble: 'linear-gradient(135deg, #14b8a6, #d6a23a)',
            assistantBubble: 'linear-gradient(180deg, rgba(240, 253, 250, 0.055), rgba(250, 204, 21, 0.014)), rgba(17, 51, 52, 0.92)',
            accent: '#5eead4',
        },
    },
    {
        id: 'denim-sand',
        name: 'Denim Sand',
        mode: 'light',
        group: 'experimental',
        description: 'Washed denim threads over sand, slate ink, and coral stitches.',
        metaColor: '#e6dfcf',
        preview: {
            background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.18), rgba(251, 146, 60, 0.13)), repeating-linear-gradient(90deg, rgba(30, 64, 175, 0.08) 0 1px, transparent 1px 10px), repeating-linear-gradient(0deg, rgba(180, 83, 9, 0.06) 0 1px, transparent 1px 14px), linear-gradient(180deg, #ece6d8 0%, #d8dfdf 100%)',
            surface: 'linear-gradient(180deg, rgba(255, 255, 250, 0.98), rgba(226, 226, 215, 0.94)), rgba(239, 233, 220, 0.94)',
            userBubble: 'linear-gradient(135deg, #2563eb, #ea6f46)',
            assistantBubble: 'linear-gradient(180deg, rgba(255, 255, 250, 0.99), rgba(230, 226, 214, 0.97)), rgba(245, 239, 226, 0.96)',
            accent: '#2563eb',
        },
    },
    {
        id: 'mineral-rust',
        name: 'Mineral Rust',
        mode: 'dark',
        group: 'experimental',
        description: 'Iron oxide, teal mineral veins, and rough basalt shadows.',
        metaColor: '#171411',
        preview: {
            background: 'radial-gradient(circle at 18% 16%, rgba(194, 65, 12, 0.24), transparent 30%), radial-gradient(circle at 78% 18%, rgba(20, 184, 166, 0.18), transparent 24%), repeating-linear-gradient(32deg, rgba(245, 158, 11, 0.08) 0 1px, transparent 1px 14px), repeating-linear-gradient(132deg, rgba(45, 212, 191, 0.07) 0 1px, transparent 1px 20px), linear-gradient(180deg, #11100e 0%, #2b221d 100%)',
            surface: 'linear-gradient(180deg, rgba(251, 191, 36, 0.055), rgba(20, 184, 166, 0.018)), rgba(40, 31, 27, 0.9)',
            userBubble: 'linear-gradient(135deg, #c2410c, #0f766e)',
            assistantBubble: 'linear-gradient(180deg, rgba(251, 191, 36, 0.05), rgba(20, 184, 166, 0.014)), rgba(43, 33, 29, 0.92)',
            accent: '#d97706',
        },
    },
]); 
const WEB_CHAT_THEME_PRESET_MAP = WEB_CHAT_SHARED_THEMES.map || new Map(WEB_CHAT_THEME_PRESETS.map((preset) => [preset.id, preset]));

function webChatSelectPreferredModel(models = [], preferredModel = '') {
    const availableModels = webChatFilterChatModels(models);
    const preferredId = String(preferredModel || '').trim();
    if (preferredId === WEB_CHAT_DEFAULT_MODEL) {
        return WEB_CHAT_DEFAULT_MODEL;
    }
    if (preferredId && webChatIsChatModel(preferredId) && availableModels.some((model) => String(model?.id || '').trim() === preferredId)) {
        return preferredId;
    }

    if (availableModels.some((model) => String(model?.id || '').trim() === WEB_CHAT_DEFAULT_MODEL)) {
        return WEB_CHAT_DEFAULT_MODEL;
    }

    return String(availableModels[0]?.id || WEB_CHAT_DEFAULT_MODEL).trim() || WEB_CHAT_DEFAULT_MODEL;
}

class UIHelpers {
    constructor() {
        this.storageAvailable = this.checkStorageAvailability();
        this.htmlPreviewPageLoadedAt = Date.now();
        this.htmlPreviewAutostartWindowMs = 90000;
        this.messageContainer = document.getElementById('messages-container');
        this.sessionsList = document.getElementById('sessions-list');
        this.searchResults = [];
        this.currentSearchIndex = -1;
        this.expandedReasoningMessageIds = new Set();
        this.renamingSessionId = null;
        this.pendingSessionRenameTitle = '';
        this.setupMarked();
        this.ensureAssistantModelControls();
        this.setupEventListeners();
        
        // Image generation state
        this.imageGenerationState = {
            quality: null,
            style: null,
            source: 'generate' // 'generate' or 'unsplash'
        };
        this.imageGenerationControlsBound = false;
        
        // Model selector state
        this.availableModels = [];
        this.availableImageModels = [];
        const savedModel = window.sessionManager?.safeStorageGet?.('kimibuilt_default_model');
        const savedReasoningEffort = window.sessionManager?.safeStorageGet?.('kimibuilt_reasoning_effort');
        const savedRemoteAutonomy = window.sessionManager?.safeStorageGet?.('kimibuilt_remote_build_autonomy');
        const savedLongAgentDefault = this.storageGet(WEB_CHAT_LONG_AGENT_DEFAULT_KEY);
        this.currentThemePresetId = WEB_CHAT_THEME_DEFAULTS.dark;
        this.currentModel = this.normalizeDefaultModelPreference(savedModel);
        this.currentReasoningEffort = this.normalizeReasoningEffort(savedReasoningEffort);
        this.remoteBuildAutonomyApproved = this.parseRemoteBuildAutonomyPreference(savedRemoteAutonomy);
        this.longAgentDefaultEnabled = savedLongAgentDefault === 'true';
        this.soundManager = window.WebChatSoundManager
            ? new window.WebChatSoundManager()
            : null;
        this.ttsManager = window.WebChatTtsManager
            ? new window.WebChatTtsManager()
            : null;
        this.speechHighlightState = {
            messageId: '',
            lastSearchOffset: 0,
            lastChunkIndex: -1,
        };
        this.updateModelUI();
        this.updateReasoningUI();
        this.updateRemoteBuildAutonomyUI();
        this.updateLongAgentDefaultUI();
        this.updateSoundCuesUI();
        this.updateMenuSoundsUI();
        this.populateSoundProfileOptions();
        this.updateSoundProfileUI();
        this.updateSoundVolumeUI();
        this.updateTtsUI();
        this.ttsManager?.addEventListener('configchange', () => {
            this.updateTtsUI();
            this.updateTtsPreviewButtons();
            this.updateMessageSpeechButtons();
        });
        this.ttsManager?.addEventListener('statechange', (event) => {
            this.updateTtsUI();
            this.updateTtsPreviewButtons();
            this.updateMessageSpeechButtons();
            if (!event?.detail?.currentMessageId) {
                this.clearSpeechHighlights();
            }
        });
        this.ttsManager?.addEventListener('chunkstart', (event) => this.handleTtsChunkStart(event));
        this.ttsManager?.addEventListener('chunkend', (event) => this.handleTtsChunkEnd(event));
        this.ttsManager?.addEventListener('playbackstop', () => this.clearSpeechHighlights());
        void this.initializeTts();
        
        // Track last focused element for focus management
        this.lastFocusedElement = null;
        this.lastSoundCueWarningAt = 0;
        this.soundCueWarningCooldownMs = 12000;
        
        // Command palette navigation state
        this.commandPaletteState = {
            selectedIndex: 0,
            items: []
        };

        this.layoutPreferenceKey = 'webchat_layout_mode';
        this.layoutMode = 'full';

        this.renderThemeGallery();
        
        // Setup draft saving
        this.setupDraftSaving();
        
        // Restore draft on load
        this.restoreDraft();
        
        // Setup code block scroll indicators
        this.setupCodeBlockScrollIndicators();

        this.initializeMermaidTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    }

    getGenericFilenameWords() {
        return new Set([
            'a', 'an', 'all', 'artifact', 'assistant', 'chat', 'conversation', 'copy',
            'default', 'diagram', 'document', 'download', 'export', 'file', 'final',
            'generated', 'generic', 'image', 'lillybuilt', 'latest', 'mermaid', 'new',
            'notes', 'output', 'page', 'pdf', 'report', 'response', 'result', 'session',
            'temp', 'test', 'text', 'tmp', 'untitled', 'web',
        ]);
    }

    getReservedFilenameBases() {
        return new Set([
            'con', 'prn', 'aux', 'nul',
            'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
            'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
        ]);
    }

    getPleasantFilenameParts() {
        return {
            adjectives: [
                'amber', 'autumn', 'bright', 'calm', 'clear', 'cobalt', 'crisp', 'dawn',
                'ember', 'gentle', 'golden', 'lively', 'lunar', 'maple', 'mellow', 'misty',
                'noble', 'orchid', 'quiet', 'silver', 'solar', 'steady', 'velvet', 'warm'
            ],
            nouns: [
                'atlas', 'bloom', 'bridge', 'canvas', 'compass', 'draft', 'field', 'garden',
                'harbor', 'horizon', 'journal', 'lantern', 'meadow', 'notebook', 'outline',
                'palette', 'path', 'pocket', 'report', 'sketch', 'story', 'studio', 'summit', 'trail'
            ],
        };
    }

    checkStorageAvailability() {
        if (typeof window.__webChatStorageAvailable === 'boolean') {
            return window.__webChatStorageAvailable === true;
        }

        if (window.sessionManager?.storageAvailable != null) {
            return window.sessionManager.storageAvailable === true;
        }

        return false;
    }

    ensureAssistantModelControls() {
        if (document.getElementById('assistant-model-select')) {
            return;
        }

        const settings = document.querySelector('.model-selector-settings');
        if (!settings) {
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'model-selector-setting';
        wrapper.innerHTML = `
            <label for="assistant-model-select" class="model-selector-setting__label">AI model</label>
            <select id="assistant-model-select" class="reasoning-select reasoning-select--panel assistant-model-select" title="AI model" aria-label="AI model">
                <option value="${this.escapeHtmlAttr(WEB_CHAT_DEFAULT_MODEL)}">${this.escapeHtml(this.getModelDisplayName({ id: WEB_CHAT_DEFAULT_MODEL }))}</option>
            </select>
            <p class="model-selector-setting__hint">Choose the model for the next messages in this chat.</p>
        `;

        settings.insertBefore(wrapper, settings.firstElementChild || null);
    }

    storageGet(key) {
        if (window.sessionManager?.safeStorageGet) {
            return window.sessionManager.safeStorageGet(key);
        }
        this.storageAvailable = false;
        return null;
    }

    storageSet(key, value) {
        if (window.sessionManager?.safeStorageSet) {
            return window.sessionManager.safeStorageSet(key, value);
        }
        this.storageAvailable = false;
        return false;
    }

    storageRemove(key) {
        if (window.sessionManager?.safeStorageRemove) {
            return window.sessionManager.safeStorageRemove(key);
        }
        this.storageAvailable = false;
        return false;
    }

    getSystemPreferredThemeMode() {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    getDefaultThemePresetId(mode = 'dark') {
        return WEB_CHAT_THEME_DEFAULTS[mode] || WEB_CHAT_THEME_DEFAULTS.dark;
    }

    getSavedThemePresetId() {
        const presetId = String(this.storageGet(WEB_CHAT_THEME_PRESET_STORAGE_KEY) || '').trim().toLowerCase();
        return WEB_CHAT_THEME_PRESET_MAP.has(presetId) ? presetId : '';
    }

    mapLegacyThemeToPreset(mode = '') {
        return String(mode || '').trim().toLowerCase() === 'light'
            ? WEB_CHAT_THEME_DEFAULTS.light
            : WEB_CHAT_THEME_DEFAULTS.dark;
    }

    getThemePresetById(presetId = '') {
        return WEB_CHAT_THEME_PRESET_MAP.get(String(presetId || '').trim().toLowerCase())
            || WEB_CHAT_THEME_PRESET_MAP.get(this.getDefaultThemePresetId(this.getSystemPreferredThemeMode()));
    }

    getCurrentThemePreset() {
        return this.getThemePresetById(this.currentThemePresetId);
    }

    getThemePreviewStyle(preview = {}) {
        return [
            `--theme-preview-background: ${preview.background || 'transparent'}`,
            `--theme-preview-surface: ${preview.surface || 'transparent'}`,
            `--theme-preview-user-bubble: ${preview.userBubble || 'transparent'}`,
            `--theme-preview-assistant-bubble: ${preview.assistantBubble || 'transparent'}`,
            `--theme-preview-accent: ${preview.accent || '#58a6ff'}`,
        ].join('; ');
    }

    renderThemeGallery() {
        const container = document.getElementById('theme-gallery-grid');
        if (!container) {
            return;
        }

        const currentPreset = this.getCurrentThemePreset();
        const renderThemeCard = (preset) => {
            const isActive = preset.id === currentPreset.id;
            const previewStyle = this.escapeHtmlAttr(this.getThemePreviewStyle(preset.preview));
            const title = this.escapeHtml(preset.name);
            const description = this.escapeHtml(preset.description);
            const modeLabel = preset.group === 'experimental'
                ? 'Experimental'
                : (preset.mode === 'light' ? 'Light' : 'Dark');
            return `
                <button
                    type="button"
                    class="theme-card ${preset.group === 'experimental' ? 'theme-card--experimental' : ''} ${isActive ? 'is-active' : ''}"
                    data-theme-preset="${this.escapeHtmlAttr(preset.id)}"
                    role="option"
                    aria-selected="${isActive ? 'true' : 'false'}"
                    title="${title}"
                >
                    <span class="theme-card__preview" style="${previewStyle}">
                        <span class="theme-card__preview-shell"></span>
                        <span class="theme-card__preview-assistant"></span>
                        <span class="theme-card__preview-user"></span>
                    </span>
                    <span class="theme-card__body">
                        <span class="theme-card__title-row">
                            <span class="theme-card__title">${title}</span>
                            <span class="theme-card__mode">${modeLabel}</span>
                        </span>
                        <span class="theme-card__description">${description}</span>
                    </span>
                    <span class="theme-card__check" aria-hidden="true">
                        <i data-lucide="check" class="w-4 h-4"></i>
                    </span>
                </button>
            `;
        };

        const groupedPresets = WEB_CHAT_THEME_PRESETS.reduce((groups, preset) => {
            const group = preset.group || 'core';
            if (!groups[group]) {
                groups[group] = [];
            }
            groups[group].push(preset);
            return groups;
        }, {});

        const groupOrder = ['core', 'experimental'];
        container.innerHTML = groupOrder
            .filter((group) => Array.isArray(groupedPresets[group]) && groupedPresets[group].length > 0)
            .map((group) => {
                const groupLabel = WEB_CHAT_THEME_GROUP_LABELS[group] || group;
                return `
                <section class="theme-gallery-section theme-gallery-section--${this.escapeHtmlAttr(group)}" role="group" aria-label="${this.escapeHtmlAttr(groupLabel)}">
                    <div class="theme-gallery-section__header">
                        <h3 class="theme-gallery-section__title">${this.escapeHtml(groupLabel)}</h3>
                    </div>
                    <div class="theme-gallery-section__grid">
                        ${groupedPresets[group].map(renderThemeCard).join('')}
                    </div>
                </section>
            `;
            }).join('');

        this.reinitializeIcons(container);
    }

    initializeMermaidTheme(mode = 'dark') {
        if (typeof mermaid === 'undefined') {
            return;
        }

        mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'loose',
            theme: mode === 'light' ? 'default' : 'dark',
        });
    }

    refreshMermaidTheme(mode = 'dark') {
        this.initializeMermaidTheme(mode);
        document.querySelectorAll('.mermaid-render-surface').forEach((target) => {
            delete target.dataset.mermaidRenderedSource;
        });
        void this.renderMermaidDiagrams(document);
    }

    generatePleasantFilenameBase() {
        const { adjectives, nouns } = this.getPleasantFilenameParts();
        const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
        const noun = nouns[Math.floor(Math.random() * nouns.length)];
        return `${adjective}-${noun}`;
    }

    slugifyFilenameBase(value, fallback = 'artifact') {
        const clean = String(value || fallback)
            .toLowerCase()
            .replace(/\.[a-z0-9]+$/i, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return clean || fallback;
    }

    createFriendlyFilenameBase(value, fallback = 'artifact') {
        const slug = this.slugifyFilenameBase(value, fallback);
        const tokens = slug.split('-').filter(Boolean);
        if (tokens.length === 0) {
            return this.generatePleasantFilenameBase();
        }

        const genericWords = this.getGenericFilenameWords();
        const meaningfulTokens = tokens.filter((token) => !genericWords.has(token));
        if (meaningfulTokens.length === 0) {
            return this.generatePleasantFilenameBase();
        }

        const candidate = meaningfulTokens.slice(0, 6).join('-') || this.generatePleasantFilenameBase();
        return this.getReservedFilenameBases().has(candidate) ? this.generatePleasantFilenameBase() : candidate;
    }

    sanitizeDownloadFilename(filename, fallbackBase = 'download', fallbackExtension = '') {
        const raw = String(filename || '').trim();
        const extensionMatch = raw.match(/(\.[a-z0-9]{1,10})$/i);
        const extension = extensionMatch ? extensionMatch[1].toLowerCase() : (fallbackExtension ? `.${String(fallbackExtension).replace(/^\./, '')}` : '');
        const base = raw.replace(/\.[a-z0-9]{1,10}$/i, '');
        const safeBase = this.createFriendlyFilenameBase(base || fallbackBase, fallbackBase);
        const truncatedBase = safeBase.slice(0, 80).replace(/-+$/g, '') || this.createFriendlyFilenameBase(fallbackBase, fallbackBase);
        return `${truncatedBase}${extension}`;
    }

    createShortUniqueSuffix(length = 6) {
        const random = Math.random().toString(36).slice(2);
        return (random || Date.now().toString(36)).slice(0, Math.max(4, length));
    }

    createUniqueFilename(value, extension = '', fallback = 'artifact') {
        const safeExtension = extension ? `.${String(extension).replace(/^\./, '').toLowerCase()}` : '';
        const safeBase = this.createFriendlyFilenameBase(value || fallback, fallback);
        return this.sanitizeDownloadFilename(`${safeBase}-${this.createShortUniqueSuffix()}${safeExtension}`, fallback, extension);
    }

    createFriendlyFilenameBaseFromMermaid(source, fallback = 'diagram') {
        const text = this.normalizeMermaidSource(source || '');
        const labelMatches = Array.from(text.matchAll(/\[(.*?)\]|\((.*?)\)|"(.*?)"/g))
            .map((match) => match[1] || match[2] || match[3] || '')
            .map((label) => label.trim())
            .filter(Boolean);

        if (labelMatches.length > 0) {
            return this.createFriendlyFilenameBase(labelMatches[0], fallback);
        }

        const words = text
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(Boolean)
            .filter((word) => !new Set([
                'flowchart', 'graph', 'sequence', 'sequencediagram', 'classdiagram', 'erdiagram',
                'statediagram', 'gantt', 'pie', 'mindmap', 'gitgraph', 'td', 'lr', 'tb', 'bt',
                'subgraph', 'end', 'style', 'classdef', 'click', 'section', 'participant', 'actor',
                'note', 'title'
            ]).has(word));

        if (words.length > 0) {
            return this.createFriendlyFilenameBase(words.slice(0, 4).join(' '), fallback);
        }

        return this.generatePleasantFilenameBase();
    }

    createFriendlyFilenameBaseFromHtml(source, fallback = 'preview') {
        const text = String(source || '').trim();
        if (!text) {
            return this.createFriendlyFilenameBase(fallback, fallback);
        }

        const titleMatch = text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
        const headingMatch = text.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
        const candidate = (titleMatch?.[1] || headingMatch?.[1] || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (candidate) {
            return this.createFriendlyFilenameBase(candidate, fallback);
        }

        return this.createUniqueFilename(fallback, 'html', fallback).replace(/\.html$/i, '');
    }

    // ============================================
    // Markdown Setup
    // ============================================

    setupMarked() {
        marked.setOptions({
            breaks: true,
            gfm: true,
            headerIds: false,
            mangle: false,
            sanitize: false // We use DOMPurify instead
        });

        // Custom renderer for code blocks
        const renderer = new marked.Renderer();

        const normalizeMarkedText = (value) => {
            if (typeof value === 'string') return value;
            if (value && typeof value === 'object') {
                if (typeof value.text === 'string') return value.text;
                if (typeof value.raw === 'string') return value.raw;
            }
            return value == null ? '' : String(value);
        };

        const normalizeMarkedLang = (value, fallback = 'text') => {
            if (typeof value === 'string') return value || fallback;
            if (value && typeof value === 'object') {
                if (typeof value.lang === 'string') return value.lang || fallback;
                if (typeof value.language === 'string') return value.language || fallback;
            }
            return fallback;
        };

        const normalizeMarkedLinkArgs = (href, title, text) => {
            if (href && typeof href === 'object' && !Array.isArray(href)) {
                return {
                    href: typeof href.href === 'string' ? href.href : '',
                    title: typeof href.title === 'string' ? href.title : title,
                    text: typeof href.text === 'string'
                        ? href.text
                        : (typeof href.raw === 'string' ? href.raw : text),
                };
            }

            return {
                href: typeof href === 'string' ? href : '',
                title,
                text,
            };
        };

        const deriveLinkLabel = (href, title, text) => {
            const normalizedText = normalizeMarkedText(text).trim();
            const plainText = normalizedText.replace(/<[^>]*>/g, '').trim();
            if (plainText && plainText.toLowerCase() !== 'undefined') {
                return this.escapeHtml(normalizedText);
            }

            const normalizedTitle = normalizeMarkedText(title).trim();
            if (normalizedTitle && normalizedTitle.toLowerCase() !== 'undefined') {
                return this.escapeHtml(normalizedTitle);
            }

            try {
                const url = new URL(String(href || ''), window.location.origin);
                const host = url.hostname.replace(/^www\./i, '');
                const path = url.pathname && url.pathname !== '/' ? url.pathname : '';
                return this.escapeHtml(`${host}${path}`);
            } catch (_error) {
                return this.escapeHtml(normalizedText || normalizedTitle || String(href || 'link'));
            }
        };
        
        renderer.code = (code, language) => {
            const normalizedCode = normalizeMarkedText(code);
            const declaredLang = normalizeMarkedLang(language);
            const declaredNormalizedLang = declaredLang.toLowerCase();
            const lang = this.inferCodeBlockLanguage(normalizedCode, declaredLang);
            const normalizedLang = lang.toLowerCase();

            if (this.isPlainTextCodeLanguage(normalizedLang)) {
                return this.renderPlainTextFence(normalizedCode);
            }

            if (normalizedLang === 'mermaid') {
                const mermaidSource = this.normalizeMermaidSource(normalizedCode);
                const escapedCode = this.escapeHtml(mermaidSource);
                const escapedAttrCode = this.escapeHtmlAttr(mermaidSource);
                const filenameBase = this.createFriendlyFilenameBaseFromMermaid(mermaidSource, 'diagram');

                return `
                    <div class="code-block mermaid-code-block">
                        <div class="code-header">
                            <span class="code-language">mermaid</span>
                            <div class="code-actions">
                                <button class="code-copy-btn" onclick="uiHelpers.copyCode(this)" data-code="${escapedAttrCode}" aria-label="Copy Mermaid code">
                                    <i data-lucide="copy" class="w-3.5 h-3.5" aria-hidden="true"></i>
                                    <span>Copy</span>
                                </button>
                                <button class="code-copy-btn" onclick="uiHelpers.downloadMermaidSource(this)" data-code="${escapedAttrCode}" data-filename="${filenameBase}.mmd" aria-label="Download Mermaid source">
                                    <i data-lucide="file-code" class="w-3.5 h-3.5" aria-hidden="true"></i>
                                    <span>.mmd</span>
                                </button>
                                <button class="code-copy-btn" onclick="uiHelpers.downloadMermaidPdf(this)" data-code="${escapedAttrCode}" data-filename="${filenameBase}.pdf" aria-label="Download Mermaid PDF">
                                    <i data-lucide="download" class="w-3.5 h-3.5" aria-hidden="true"></i>
                                    <span>PDF</span>
                                </button>
                            </div>
                        </div>
                        <pre class="mermaid-source-block"><code class="language-mermaid no-highlight">${escapedCode}</code></pre>
                        <div class="mermaid-visual-wrapper">
                            <div class="mermaid-render-surface" data-mermaid-source="${escapedAttrCode}" data-mermaid-filename="${filenameBase}">
                                <div class="mermaid-placeholder">Rendering diagram...</div>
                            </div>
                        </div>
                    </div>
                `;
            }

            if (normalizedLang === 'html') {
                let htmlSource = normalizedCode.trim();
                let leadIn = '';
                if (this.isPlainTextCodeLanguage(declaredNormalizedLang)
                    && !this.looksLikeStandaloneHtmlDocument(htmlSource)
                    && !this.looksLikePreviewableHtmlFragment(htmlSource)) {
                    const embedded = this.extractEmbeddedStandaloneHtmlDocument(htmlSource)
                        || this.extractEmbeddedHtmlPreviewFragment(htmlSource);
                    if (embedded?.html) {
                        htmlSource = embedded.html;
                        leadIn = embedded.prefix || '';
                    }
                }
                const escapedCode = this.escapeHtml(htmlSource);
                const filenameBase = this.createFriendlyFilenameBaseFromHtml(htmlSource, 'preview');
                const leadInHtml = leadIn ? `<p>${this.escapeHtml(leadIn)}</p>` : '';

                return `${leadInHtml}
                    <div class="code-block html-code-block">
                        <div class="code-header">
                            <span class="code-language">html</span>
                            <div class="code-actions">
                                <button class="code-copy-btn" onclick="uiHelpers.copyInlineHtml(this)" aria-label="Copy HTML code">
                                    <i data-lucide="copy" class="w-3.5 h-3.5" aria-hidden="true"></i>
                                    <span>Copy</span>
                                </button>
                                <button class="code-copy-btn" onclick="uiHelpers.downloadInlineHtml(this)" data-filename="${filenameBase}.html" aria-label="Download HTML preview">
                                    <i data-lucide="download" class="w-3.5 h-3.5" aria-hidden="true"></i>
                                    <span>HTML</span>
                                </button>
                            </div>
                        </div>
                        <textarea class="html-preview-source" aria-hidden="true" style="display:none">${escapedCode}</textarea>
                        <div class="html-preview-wrapper">
                            <div class="html-preview-toolbar">
                                <span class="html-preview-label">Live preview</span>
                                <div class="html-preview-controls">
                                    <button type="button" class="html-preview-control" data-html-preview-action="start" onclick="uiHelpers.startInlineHtmlPreview(this)" aria-label="Start HTML preview">
                                        <i data-lucide="play" class="w-3.5 h-3.5" aria-hidden="true"></i>
                                        <span>Start</span>
                                    </button>
                                    <button type="button" class="html-preview-control" data-html-preview-action="stop" onclick="uiHelpers.stopInlineHtmlPreview(this)" aria-label="Stop HTML preview" disabled>
                                        <i data-lucide="square" class="w-3.5 h-3.5" aria-hidden="true"></i>
                                        <span>Stop</span>
                                    </button>
                                </div>
                            </div>
                            <div class="html-preview-surface">
                                <div class="html-preview-placeholder">Preview stopped. Start it when you want to run this HTML.</div>
                            </div>
                        </div>
                    </div>
                `;
            }

            const escapedCode = this.escapeHtml(normalizedCode);
            const prismLang = this.getPrismLanguage(lang);
            const lineCount = normalizedCode.split('\n').length;
            const isPlainTextCode = this.isPlainTextCodeLanguage(normalizedLang);
            
            // Generate line numbers for code blocks with more than 3 lines
            let lineNumbersHtml = '';
            if (!isPlainTextCode && lineCount > 3) {
                lineNumbersHtml = `<div class="line-numbers-rows">${
                    Array(lineCount).fill(0).map((_, i) => `<span></span>`).join('')
                }</div>`;
            }
            
            return `
                <div class="code-block${isPlainTextCode ? ' text-code-block' : ''}${!isPlainTextCode && lineCount > 3 ? ' line-numbers' : ''}">
                    <div class="code-header">
                        <span class="code-language">${this.escapeHtml(lang)}</span>
                        <div class="code-actions">
                            <button class="code-copy-btn" onclick="uiHelpers.copyCode(this)" data-code="${this.escapeHtmlAttr(normalizedCode)}" aria-label="Copy code to clipboard">
                                <i data-lucide="copy" class="w-3.5 h-3.5" aria-hidden="true"></i>
                                <span>Copy</span>
                            </button>
                        </div>
                    </div>
                    ${lineNumbersHtml}
                    <pre class="language-${this.escapeHtmlAttr(prismLang)}"><code class="language-${this.escapeHtmlAttr(prismLang)}">${escapedCode}</code></pre>
                </div>
            `;
        };

        renderer.codespan = (code) => {
            return `<code>${this.escapeHtml(normalizeMarkedText(code))}</code>`;
        };

        renderer.link = (href, title, text) => {
            const normalizedLink = normalizeMarkedLinkArgs(href, title, text);
            const safeHref = this.escapeHtmlAttr(normalizedLink.href || '#');
            const normalizedTitle = normalizeMarkedText(normalizedLink.title).trim();
            const titleAttr = normalizedTitle ? ` title="${this.escapeHtmlAttr(normalizedTitle)}"` : '';
            return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noopener noreferrer nofollow">${deriveLinkLabel(
                normalizedLink.href,
                normalizedLink.title,
                normalizedLink.text,
            )}</a>`;
        };

        renderer.checkbox = (checked) => {
            return `<input type="checkbox" ${checked ? 'checked' : ''} disabled> `;
        };

        marked.use({ renderer });
    }

    getPrismLanguage(lang) {
        const languageMap = {
            'js': 'javascript',
            'ts': 'typescript',
            'py': 'python',
            'sh': 'bash',
            'shell': 'bash',
            'zsh': 'bash',
            'bash': 'bash',
            'yml': 'yaml',
            'yaml': 'yaml',
            'json': 'json',
            'html': 'markup',
            'xml': 'markup',
            'svg': 'markup',
            'jsx': 'jsx',
            'tsx': 'tsx',
            'rs': 'rust',
            'rust': 'rust',
            'go': 'go',
            'golang': 'go',
            'java': 'java',
            'c': 'c',
            'cpp': 'cpp',
            'c++': 'cpp',
            'cs': 'csharp',
            'csharp': 'csharp',
            'rb': 'ruby',
            'ruby': 'ruby',
            'php': 'php',
            'docker': 'docker',
            'dockerfile': 'docker',
            'md': 'markdown',
            'markdown': 'markdown',
            'sql': 'sql',
            'psql': 'sql',
            'mysql': 'sql',
            'postgres': 'sql'
        };
        return languageMap[lang?.toLowerCase()] || lang || 'text';
    }

    isPlainTextCodeLanguage(lang = '') {
        const normalized = String(lang || '')
            .trim()
            .toLowerCase();
        return !normalized || ['text', 'txt', 'plain', 'plaintext', 'none'].includes(normalized);
    }

    renderPlainTextFence(code = '') {
        const escapedCode = this.escapeHtml(String(code || '').trim());
        if (!escapedCode) {
            return '';
        }

        return `<div class="plain-text-fence">${escapedCode}</div>`;
    }

    inferCodeBlockLanguage(code = '', declaredLang = 'text') {
        const normalizedLang = String(declaredLang || 'text').trim().toLowerCase();
        if (!this.isPlainTextCodeLanguage(normalizedLang)) {
            return declaredLang || 'text';
        }

        const source = String(code || '').trim();
        if (!source) {
            return 'text';
        }

        if (this.looksLikeStandaloneHtmlDocument(source)
            || this.looksLikePreviewableHtmlFragment(source)
            || this.extractEmbeddedStandaloneHtmlDocument(source)
            || this.extractEmbeddedHtmlPreviewFragment(source)) {
            return 'html';
        }

        if (/^[\[{][\s\S]*[\]}]$/.test(source)) {
            try {
                JSON.parse(source);
                return 'json';
            } catch (_error) {
                return declaredLang || 'text';
            }
        }

        return declaredLang || 'text';
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
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

    handleImageLoadError(imageEl) {
        if (!imageEl) {
            return;
        }

        const fallbackSrc = String(imageEl.dataset?.fallbackSrc || '').trim();
        const currentSrc = String(imageEl.currentSrc || imageEl.src || '').trim();
        if (fallbackSrc && imageEl.dataset.fallbackTried !== 'true' && fallbackSrc !== currentSrc) {
            imageEl.dataset.fallbackTried = 'true';
            imageEl.src = fallbackSrc;
            return;
        }

        imageEl.classList.add('is-image-load-failed');
        const container = imageEl.closest?.('.image-container, .image-selection-item, .unsplash-result-item, .artifact-image-preview');
        if (container) {
            container.classList.add('is-image-load-failed');
            if (!container.dataset.imageErrorLabel) {
                container.dataset.imageErrorLabel = imageEl.alt || 'Image could not be loaded';
            }
        }
    }

    escapeRegExp(text) {
        return String(text == null ? '' : text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    clipDisplayTextAtBoundary(text = '', maxLength = 0, options = {}) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        const limit = Number.isFinite(Number(maxLength)) && Number(maxLength) > 0
            ? Number(maxLength)
            : 0;
        if (!limit || normalized.length <= limit) {
            return normalized;
        }

        const clipped = normalized.slice(0, limit).trimEnd();
        if (!clipped) {
            return normalized.slice(0, limit).trim();
        }

        if (options.preferSentenceBoundary === true) {
            const minSentenceLength = Math.min(
                Math.max(18, Math.floor(limit * 0.22)),
                Math.max(1, limit - 1),
            );
            const sentencePattern = /[.!?](?=\s|$)/g;
            let bestSentenceEnd = -1;
            let match;
            while ((match = sentencePattern.exec(clipped)) !== null) {
                const sentenceEnd = match.index + 1;
                if (sentenceEnd >= minSentenceLength) {
                    bestSentenceEnd = sentenceEnd;
                }
            }

            if (bestSentenceEnd > 0) {
                return clipped.slice(0, bestSentenceEnd).trim();
            }
        }

        const minBreakLength = Math.min(
            Math.max(24, Math.floor(limit * 0.68)),
            Math.max(1, limit - 1),
        );
        let bestBreak = -1;
        for (const pattern of [/\s/g, /[,;:](?=\s|$)/g, /[-](?=\s|$)/g]) {
            let match;
            while ((match = pattern.exec(clipped)) !== null) {
                if (match.index >= minBreakLength) {
                    bestBreak = Math.max(bestBreak, match.index);
                }
            }
        }

        const readableClip = bestBreak > 0
            ? clipped.slice(0, bestBreak)
            : clipped;
        return readableClip.replace(/[\s,;:.-]+$/g, '').trim()
            || normalized.slice(0, limit).trim();
    }

    extractDisplayText(value = null, options = {}, seen = null) {
        const separator = options.separator == null ? ' ' : String(options.separator);
        const maxLength = Number.isFinite(Number(options.maxLength)) && Number(options.maxLength) > 0
            ? Number(options.maxLength)
            : 0;
        const visited = seen || new WeakSet();
        let normalized = '';

        if (typeof value === 'string') {
            normalized = value.replace(/\s+/g, ' ').trim();
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            normalized = String(value);
        } else if (Array.isArray(value)) {
            normalized = value
                .map((entry) => this.extractDisplayText(entry, { ...options, maxLength: 0 }, visited))
                .filter(Boolean)
                .join(separator)
                .replace(/\s+/g, ' ')
                .trim();
        } else if (value && typeof value === 'object') {
            if (visited.has(value)) {
                return '';
            }
            visited.add(value);

            const directKeys = [
                'label',
                'title',
                'name',
                'summary',
                'summaryText',
                'summary_text',
                'detail',
                'details',
                'description',
                'message',
                'text',
                'content',
                'value',
                'reason',
                'status',
                'output_text',
                'outputText',
                'result',
                'response',
            ];
            for (const key of directKeys) {
                if (!Object.prototype.hasOwnProperty.call(value, key)) {
                    continue;
                }
                const extracted = this.extractDisplayText(value[key], { ...options, maxLength: 0 }, visited);
                if (extracted) {
                    normalized = extracted;
                    break;
                }
            }

            if (!normalized) {
                const nestedKeys = ['data', 'payload', 'item'];
                for (const key of nestedKeys) {
                    const extracted = this.extractDisplayText(value[key], { ...options, maxLength: 0 }, visited);
                    if (extracted) {
                        normalized = extracted;
                        break;
                    }
                }
            }

            if (!normalized) {
                try {
                    const serialized = JSON.stringify(value);
                    normalized = serialized && serialized !== '{}' ? serialized : '';
                } catch (_error) {
                    normalized = '';
                }
            }
        }

        if (!normalized) {
            return '';
        }

        const collapsed = normalized.replace(/\s+/g, ' ').trim();
        if (!maxLength || collapsed.length <= maxLength) {
            return collapsed;
        }

        const suffix = options.truncationSuffix == null
            ? '...'
            : String(options.truncationSuffix);
        const clipLength = Math.max(1, maxLength - suffix.length);
        const clipped = this.clipDisplayTextAtBoundary(collapsed, clipLength, options);
        return `${clipped}${suffix}`;
    }

    extractMessageContentText(value = null) {
        if (typeof value === 'string') {
            return value.trim();
        }
        if (Array.isArray(value)) {
            return value
                .map((entry) => this.extractMessageContentText(entry))
                .filter(Boolean)
                .join('\n')
                .trim();
        }

        return this.extractDisplayText(value);
    }

    truncatePreviewText(text, maxLength = 180) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized) {
            return '';
        }

        if (normalized.length <= maxLength) {
            return normalized;
        }

        return `${normalized.slice(0, maxLength).replace(/[\s,;:.!?-]+$/g, '')}…`;
    }

    // ============================================
    // Message Rendering
    // ============================================

    normalizeJsonLikeText(value = '') {
        return String(value || '')
            .replace(/^\uFEFF/, '')
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/[\u2018\u2019]/g, '\'')
            .replace(/\u00A0/g, ' ')
            .trim();
    }

    unwrapJsonLikeCodeFence(value = '') {
        const normalized = this.normalizeJsonLikeText(value);
        const match = normalized.match(/^```(?:json|survey|kb-survey)?\s*([\s\S]*?)\s*```$/i);
        return match ? match[1].trim() : normalized;
    }

    extractJsonLikeSegment(value = '') {
        const source = this.unwrapJsonLikeCodeFence(value);
        const objectStart = source.indexOf('{');
        const arrayStart = source.indexOf('[');
        const starts = [objectStart, arrayStart].filter((index) => index >= 0);

        if (starts.length === 0) {
            return source;
        }

        const start = Math.min(...starts);
        if (objectStart < 0 && arrayStart >= 0) {
            const prefix = source.slice(0, arrayStart).trim();
            if (/[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(prefix)) {
                return source;
            }
        }

        const stack = [];
        let quote = null;
        let escaped = false;

        for (let index = start; index < source.length; index += 1) {
            const char = source[index];

            if (quote) {
                if (escaped) {
                    escaped = false;
                    continue;
                }

                if (char === '\\') {
                    escaped = true;
                    continue;
                }

                if (char === quote) {
                    quote = null;
                }

                continue;
            }

            if (char === '"' || char === '\'') {
                quote = char;
                continue;
            }

            if (char === '{' || char === '[') {
                stack.push(char);
                continue;
            }

            if (char === '}' || char === ']') {
                const expectedOpening = char === '}' ? '{' : '[';
                if (stack[stack.length - 1] === expectedOpening) {
                    stack.pop();
                }

                if (stack.length === 0) {
                    return source.slice(start, index + 1).trim();
                }
            }
        }

        return source.slice(start).trim();
    }

    repairJsonLikeString(value = '') {
        const wrapped = this.wrapBareJsonLikeObject(String(value || '')
            .split('\n')
            .map((line) => line.replace(/^\s*\/\/.*$/g, ''))
            .join('\n'));

        return wrapped
            .replace(/(^|[{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(\s*:)/gm, '$1"$2"$3')
            .replace(/(^|[{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/gm, '$1"$2"$3')
            .replace(/([:\[,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, prefix, entry) => `${prefix}"${String(entry || '').replace(/\\'/g, '\'').replace(/"/g, '\\"')}"`)
            .replace(/\bNone\b/g, 'null')
            .replace(/\bTrue\b/g, 'true')
            .replace(/\bFalse\b/g, 'false')
            .replace(/\bundefined\b/g, 'null')
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/;\s*$/g, '')
            .trim();
    }

    wrapBareJsonLikeObject(value = '') {
        const trimmed = String(value || '').trim();
        if (!trimmed || /^[{\[]/.test(trimmed)) {
            return trimmed;
        }

        return /^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(trimmed)
            ? `{${trimmed}}`
            : trimmed;
    }

    parseJsonSafely(value = '') {
        const tryParse = (candidate) => {
            if (!candidate) {
                return null;
            }

            try {
                return JSON.parse(candidate);
            } catch (_error) {
                return null;
            }
        };

        const direct = tryParse(this.unwrapJsonLikeCodeFence(value));
        if (direct !== null) {
            return direct;
        }

        const extracted = this.extractJsonLikeSegment(value);
        const extractedParsed = tryParse(extracted);
        if (extractedParsed !== null) {
            return extractedParsed;
        }

        const repaired = this.repairJsonLikeString(extracted);
        return tryParse(repaired) || tryParse(this.wrapBareJsonLikeObject(repaired));
    }

    normalizeSurveyOption(option = {}, index = 0) {
        if (!option || typeof option !== 'object') {
            return null;
        }

        const label = String(option.label || option.title || option.text || `Option ${index + 1}`).trim();
        if (!label) {
            return null;
        }

        const id = String(option.id || option.value || label)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || `option-${index + 1}`;
        const description = String(option.description || option.details || option.hint || '').trim();

        return {
            id,
            label,
            ...(description ? { description } : {}),
        };
    }

    resolveSurveyAllowFreeText(value = null) {
        if (!value || typeof value !== 'object') {
            return true;
        }

        if (value.allowFreeText === false || value.allowText === false) {
            return false;
        }

        if (value.allowFreeText === true || value.allowText === true) {
            return true;
        }

        return true;
    }

    normalizeSurveyInputType(value = '', { hasOptions = false, allowMultiple = false } = {}) {
        const normalized = String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[_\s]+/g, '-');

        if (['multi-choice', 'multiple-choice', 'multi', 'multiple', 'multi-select', 'multiselect', 'multiple-select', 'checkbox', 'checkboxes'].includes(normalized)) {
            return 'multi-choice';
        }

        if (['choice', 'single-choice', 'select', 'radio', 'options'].includes(normalized)) {
            return 'choice';
        }

        if (['text', 'textarea', 'open-ended', 'open', 'free-text'].includes(normalized)) {
            return 'text';
        }

        if (['date', 'day'].includes(normalized)) {
            return 'date';
        }

        if (['time', 'clock'].includes(normalized)) {
            return 'time';
        }

        if (['datetime', 'date-time', 'datetime-local', 'timestamp', 'schedule'].includes(normalized)) {
            return 'datetime';
        }

        if (hasOptions) {
            return allowMultiple ? 'multi-choice' : 'choice';
        }

        return 'text';
    }

    normalizeSurveyStep(step = {}, index = 0) {
        if (!step || typeof step !== 'object') {
            return null;
        }

        const question = String(step.question || step.prompt || step.ask || step.label || '').trim();
        if (!question) {
            return null;
        }

        const options = (Array.isArray(step.options)
            ? step.options
            : (Array.isArray(step.choices) ? step.choices : []))
            .map((option, optionIndex) => this.normalizeSurveyOption(option, optionIndex))
            .filter(Boolean)
            .slice(0, 5);
        const allowMultiple = step.allowMultiple === true || step.multiple === true;
        const inputType = this.normalizeSurveyInputType(step.inputType || step.fieldType || step.type || step.kind || '', {
            hasOptions: options.length > 0,
            allowMultiple,
        });
        const isChoiceInput = inputType === 'choice' || inputType === 'multi-choice';
        const allowFreeText = isChoiceInput ? this.resolveSurveyAllowFreeText(step) : false;

        if (isChoiceInput && options.length < 2 && !(options.length === 1 && allowFreeText)) {
            return null;
        }

        const title = String(step.title || '').trim();
        const placeholder = String(step.placeholder || step.inputPlaceholder || step.freeTextPlaceholder || '').trim();

        return {
            id: String(step.id || `step-${index + 1}`).trim(),
            ...(title ? { title } : {}),
            question,
            inputType,
            required: step.required !== false,
            ...(placeholder ? { placeholder } : {}),
            ...(isChoiceInput
                ? {
                    options,
                    allowMultiple: inputType === 'multi-choice',
                    maxSelections: inputType === 'multi-choice'
                        ? Math.min(options.length, Math.max(1, Number(step.maxSelections) || Math.min(2, options.length)))
                        : 1,
                    allowFreeText,
                    ...(allowFreeText
                        ? {
                            freeTextLabel: String(step.freeTextLabel || step.freeTextPrompt || 'Add your own input (optional)').trim() || 'Add your own input (optional)',
                        }
                        : {}),
                }
                : {}),
        };
    }

    normalizeSurveySteps(value = null) {
        if (!value || typeof value !== 'object') {
            return [];
        }

        const rawSteps = Array.isArray(value.steps)
            ? value.steps
            : (Array.isArray(value.questions)
                ? value.questions
                : (Array.isArray(value.fields) ? value.fields : []));
        const legacyStep = this.normalizeSurveyStep({
            ...value,
            options: value.options || value.choices,
        }, 0);
        const normalizedRawSteps = rawSteps.length > 0
            ? rawSteps
                .map((step, index) => this.normalizeSurveyStep(step, index))
                .filter(Boolean)
                .slice(0, 6)
            : [];

        return normalizedRawSteps.length > 0
            ? normalizedRawSteps
            : (legacyStep ? [legacyStep] : []);
    }

    buildLegacySurveyFields(steps = []) {
        const firstStep = Array.isArray(steps) ? steps[0] : null;
        if (!firstStep) {
            return {};
        }

        return {
            question: firstStep.question,
            options: Array.isArray(firstStep.options) ? firstStep.options : [],
            allowMultiple: firstStep.allowMultiple === true,
            maxSelections: Number(firstStep.maxSelections || 1) > 0 ? Number(firstStep.maxSelections || 1) : 1,
            allowFreeText: firstStep.allowFreeText === true,
            ...(firstStep.allowFreeText ? { freeTextLabel: firstStep.freeTextLabel || 'Add your own input (optional)' } : {}),
            inputType: firstStep.inputType || 'choice',
            ...(firstStep.placeholder ? { placeholder: firstStep.placeholder } : {}),
        };
    }

    normalizeSurveyDefinition(value = null, fallbackId = '') {
        if (!value || typeof value !== 'object') {
            return null;
        }

        const steps = this.normalizeSurveySteps(value);
        if (steps.length === 0) {
            return null;
        }

        return {
            id: String(value.id || fallbackId || `survey-${Date.now().toString(36)}`).trim(),
            title: String(value.title || 'Choose a direction').trim() || 'Choose a direction',
            whyThisMatters: String(value.whyThisMatters || value.context || value.rationale || '').trim(),
            preamble: String(value.preamble || value.message || '').trim(),
            steps,
            ...this.buildLegacySurveyFields(steps),
        };
    }

    cleanPlainSurveyText(value = '') {
        return String(value || '')
            .replace(/^#+\s*/, '')
            .replace(/^>\s*/, '')
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/__(.*?)__/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .trim();
    }

    normalizePlainSurveySource(value = '') {
        return String(value || '')
            .replace(/\r\n/g, '\n')
            .replace(/\s+(Question\s+\d+\s*:)/gi, '\n$1')
            .replace(/\s+([A-E](?:[.)]|:)\s+)/g, '\n$1')
            .replace(/\s+(Reply\s+(?:with|like)\b[\s\S]*$)/i, '\n$1')
            .replace(/\s+(If you(?:[’']|â€™)d like\b[\s\S]*$)/i, '\n$1')
            .trim();
    }

    stripSurveyQuestionPrefix(value = '') {
        return this.cleanPlainSurveyText(value)
            .replace(/^question\s+\d+\s*:\s*/i, '')
            .trim();
    }

    hasPlainSurveyChoiceIntent(lines = [], question = '') {
        const focus = [
            ...lines.slice(-3),
            question,
        ].join(' ');

        return /\b(choose|select|pick|prefer|decision|direction|option|path|approach|which|what should|where should|how should|should i|do you want|would you like)\b/i.test(focus);
    }

    isPlainSurveyCompletionReport(source = '', question = '') {
        const normalizedQuestion = this.cleanPlainSurveyText(question)
            .replace(/[:\s]+$/, '')
            .toLowerCase();
        if (/^(?:what\s+i\s+completed|what\s+was\s+completed|completed|what\s+changed|changes\s+made|verification|verified|result|results|summary|status|what\s+i\s+checked|checks\s+run|next\s+steps?)$/.test(normalizedQuestion)) {
            return true;
        }

        const normalizedSource = this.cleanPlainSurveyText(source)
            .replace(/\s+/g, ' ')
            .toLowerCase();
        return /^(?:yes|done|fixed|completed|verified|deployed|updated|i\s+(?:pushed|updated|fixed|verified|deployed|completed|reused|kept|added|changed))\b/.test(normalizedSource)
            && /\b(?:what\s+i\s+completed|what\s+changed|verification|verified|result|summary|status|checks\s+run)\s*:/.test(normalizedSource);
    }

    isSurveyWrapperLine(value = '') {
        const normalized = this.cleanPlainSurveyText(value).toLowerCase();
        if (!normalized) {
            return true;
        }

        return /^(yes|yeah|yep|sure|ok|okay|absolutely|certainly|of course|no problem)[.!]?$/.test(normalized)
            || /^reply (?:with|like)\b/.test(normalized)
            || /^if you'd like\b/.test(normalized)
            || /\bone question at a time\b/.test(normalized);
    }

    normalizePlainSurveyOption(line = '', index = 0) {
        const match = String(line || '').match(/^(?:[-*•]\s+|(?:option\s+)?(?:\d+|[A-Ea-e])[.):]\s+)(.+)$/);
        if (!match?.[1]) {
            return null;
        }

        const raw = this.cleanPlainSurveyText(match[1]);
        if (!raw) {
            return null;
        }

        const splitMatch = raw.match(/^(.+?)(?:\s*:\s+|\s+[—-]\s+)(.+)$/);
        const label = this.cleanPlainSurveyText(splitMatch?.[1] || raw);
        const description = this.cleanPlainSurveyText(splitMatch?.[2] || '');

        return this.normalizeSurveyOption({
            id: `option-${index + 1}`,
            label,
            ...(description ? { description } : {}),
        }, index);
    }

    isPlainSurveyStatusOption(option = {}) {
        const label = this.cleanPlainSurveyText(option?.label || '').replace(/\s+/g, ' ').toLowerCase();
        const description = this.cleanPlainSurveyText(option?.description || '').replace(/\s+/g, ' ').toLowerCase();
        const combined = [label, description].filter(Boolean).join(' ');
        if (!combined) {
            return false;
        }

        if (/^(namespace|deployment|ingress|source file|git status|workspace|git repo|git commit|public host|public url|verify commands|verify results|what changed|blocker|status|verification|live result|current state)$/.test(label)) {
            return true;
        }

        return /\b(?:what_changed|verify_commands|verify_results|public_url|remote_cli_session_id|git_commit|deployment|blocker)=/.test(combined)
            || /\b(?:deployment|pod|pods|service|ingress|namespace|configmap)\b[\s\S]{0,80}\b(?:present|ready|running|currently|available|1\/1|2\/2)\b/.test(combined)
            || /\bpoints to\b[\s\S]{0,80}\bports?\b/.test(combined)
            || /\bsource file\b|\b\/(?:opt|srv|app|var|etc)\//.test(combined)
            || /\bgit status\b|\bmodified from earlier work\b|\bbackup html files?\b/.test(combined)
            || /\b(?:verified|deployed|restarted|rolled out|rollout|kubectl|configmap)\b[\s\S]{0,100}\b(?:public|deployment|ingress|pod|service|namespace|route|tls|https)\b/.test(combined);
    }

    extractPlainSurveyDefinition(content = '', fallbackId = '') {
        const source = this.normalizePlainSurveySource(content);
        if (!source || /```(?:survey|kb-survey)/i.test(source)) {
            return null;
        }

        const rawLines = source.split('\n');
        if (source.length > 2000 || rawLines.length > 30) {
            return null;
        }

        let bestRun = [];
        let currentRun = [];

        rawLines.forEach((line, index) => {
            const option = this.normalizePlainSurveyOption(line.trim(), currentRun.length);
            if (option) {
                currentRun.push({ index, option });
                return;
            }

            if (currentRun.length >= 2 && bestRun.length === 0) {
                bestRun = [...currentRun];
            }
            currentRun = [];
        });

        if (bestRun.length === 0 && currentRun.length >= 2) {
            bestRun = [...currentRun];
        }

        if (bestRun.length < 2 || bestRun.length > 5) {
            return null;
        }

        const statusOptionCount = bestRun.filter((entry) => this.isPlainSurveyStatusOption(entry.option)).length;
        if (statusOptionCount >= 2 || statusOptionCount === bestRun.length) {
            return null;
        }

        const preLines = rawLines
            .slice(0, bestRun[0].index)
            .map((line) => this.cleanPlainSurveyText(line))
            .filter(Boolean);
        if (preLines.length === 0) {
            return null;
        }

        const meaningfulPreLines = preLines.filter((line) => !this.isSurveyWrapperLine(line));
        const questionLine = meaningfulPreLines[meaningfulPreLines.length - 1] || preLines[preLines.length - 1];
        const question = this.stripSurveyQuestionPrefix(String(questionLine || '').replace(/[:\s]+$/, ''));
        const promptContext = preLines.join(' ');
        if (!question) {
            return null;
        }

        if (this.isPlainSurveyCompletionReport(source, question)) {
            return null;
        }

        const looksLikeChoicePrompt = this.hasPlainSurveyChoiceIntent(meaningfulPreLines, question)
            || (
                /\?$/.test(question)
                && /\b(choose|select|pick|prefer|which|what should|where should|how should|should i|do you want|would you like)\b/i.test(promptContext)
            );
        if (!looksLikeChoicePrompt) {
            return null;
        }

        const contextCandidates = meaningfulPreLines.slice(0, -1);
        const titleCandidate = contextCandidates.length > 0
            ? this.cleanPlainSurveyText(contextCandidates[0].replace(/[:\s]+$/, ''))
            : '';
        const title = titleCandidate && titleCandidate !== question && titleCandidate.length <= 72
            ? titleCandidate
            : 'Choose a direction';
        const contextLines = title === titleCandidate
            ? contextCandidates.slice(1)
            : contextCandidates;

        return this.normalizeSurveyDefinition({
            id: String(fallbackId || `survey-${Date.now().toString(36)}`).trim(),
            title,
            question,
            whyThisMatters: contextLines.join(' ').trim(),
            options: bestRun.map((entry) => entry.option),
        });
    }

    extractSurveyDefinitionFromContent(content = '', fallbackId = '') {
        const source = String(content || '');
        const fencedMatch = source.match(/```(?:survey|kb-survey)\s*([\s\S]*?)```/i);
        if (fencedMatch?.[1]) {
            const parsed = this.parseJsonSafely(fencedMatch[1]);
            const normalized = this.normalizeSurveyDefinition(parsed, fallbackId);
            if (normalized) {
                return normalized;
            }
        }

        const parsed = this.parseJsonSafely(source);
        if (parsed) {
            const normalized = this.normalizeSurveyDefinition(parsed, fallbackId);
            if (normalized) {
                return normalized;
            }
        }

        return this.extractPlainSurveyDefinition(source, fallbackId);
    }

    buildSurveyAnsweredSummary(surveyState = {}, survey = null) {
        const explicitSummary = String(surveyState.summary || '').trim();
        if (explicitSummary) {
            return explicitSummary;
        }

        const stepResponses = surveyState?.stepResponses && typeof surveyState.stepResponses === 'object'
            ? surveyState.stepResponses
            : {};
        const stepSummaries = (Array.isArray(survey?.steps) ? survey.steps : [])
            .map((step) => this.buildSurveyStepAnswerSummary(step, stepResponses?.[step.id] || null))
            .filter(Boolean);
        if (stepSummaries.length > 0) {
            return stepSummaries.join(' | ');
        }

        const selectedLabels = Array.isArray(surveyState.selectedLabels)
            ? surveyState.selectedLabels.filter(Boolean)
            : [];
        const notes = String(surveyState.notes || '').trim();
        const parts = [];

        if (selectedLabels.length > 0) {
            parts.push(`Answered with ${selectedLabels.join(', ')}`);
        }

        if (notes) {
            parts.push(`Note: ${notes}`);
        }

        return parts.join('. ');
    }

    getSurveyCustomOption() {
        return {
            id: 'custom-input',
            label: 'Other',
            description: 'Type your own answer below.',
        };
    }

    buildRenderedSurveyOptions(step = {}) {
        const options = Array.isArray(step.options)
            ? step.options.map((option) => ({ ...option }))
            : [];
        if (!step.allowFreeText) {
            return options;
        }

        const customOption = this.getSurveyCustomOption();
        const hasExistingCustomOption = options.some((option) => (
            String(option?.id || '').trim() === customOption.id
            || String(option?.label || '').trim().toLowerCase() === customOption.label.toLowerCase()
        ));

        if (!hasExistingCustomOption) {
            options.push(customOption);
        }

        return options;
    }

    getSurveyStepAnswer(surveyState = {}, stepId = '') {
        if (!stepId) {
            return null;
        }

        return surveyState?.stepResponses && typeof surveyState.stepResponses === 'object'
            ? (surveyState.stepResponses[stepId] || null)
            : null;
    }

    getSurveyCurrentStepIndex(survey = {}, surveyState = {}) {
        const steps = Array.isArray(survey?.steps) ? survey.steps : [];
        if (steps.length === 0) {
            return 0;
        }

        const requestedIndex = Number(surveyState?.currentStepIndex || 0);
        if (!Number.isFinite(requestedIndex)) {
            return 0;
        }

        return Math.max(0, Math.min(steps.length - 1, Math.round(requestedIndex)));
    }

    buildSurveyStepAnswerSummary(step = {}, response = null) {
        if (!step || !response || typeof response !== 'object') {
            return '';
        }

        const selectedLabels = Array.isArray(response.selectedLabels)
            ? response.selectedLabels.filter(Boolean)
            : [];
        const text = String(response.text || response.value || '').trim();
        const answer = selectedLabels.length > 0
            ? [selectedLabels.join(', '), text].filter(Boolean).join(' | ')
            : text;

        if (!answer) {
            return '';
        }

        return `${String(step.question || 'Answer').trim()}: ${answer}`;
    }

    isSurveyStepComplete(step = {}, answer = null) {
        if (!step || typeof step !== 'object') {
            return false;
        }

        const inputType = String(step.inputType || 'choice').trim();
        const required = step.required !== false;
        const response = answer && typeof answer === 'object' ? answer : {};

        if (inputType === 'choice' || inputType === 'multi-choice') {
            const selectedOptionIds = Array.isArray(response.selectedOptionIds)
                ? response.selectedOptionIds.filter(Boolean)
                : [];
            const selectedLabels = Array.isArray(response.selectedLabels)
                ? response.selectedLabels.filter(Boolean)
                : [];
            const notes = String(response.text || '').trim();
            const selectedCount = Math.max(selectedOptionIds.length, selectedLabels.length);
            const customSelected = selectedOptionIds.includes(this.getSurveyCustomOption().id)
                || selectedLabels.includes(this.getSurveyCustomOption().label);

            if (!required && selectedCount === 0 && !notes) {
                return true;
            }

            if (selectedCount === 0) {
                return false;
            }

            return !(customSelected && selectedCount === 1 && !notes);
        }

        const value = String(response.value || response.text || '').trim();
        return required ? Boolean(value) : true;
    }

    updateSurveySubmitState(card) {
        if (!card) {
            return;
        }

        const submitButton = card.querySelector('.agent-survey-card__submit');
        const inputType = String(card.dataset.stepInputType || 'choice').trim();
        const required = card.dataset.stepRequired !== 'false';
        let canSubmit = false;

        if (inputType === 'choice' || inputType === 'multi-choice') {
            const allOptions = Array.from(card.querySelectorAll('.agent-survey-option'));
            const selectedOptions = allOptions.filter((entry) => entry.classList.contains('is-selected'));
            const notes = String(card.querySelector('.agent-survey-card__notes')?.value || '').trim();
            const customOptionId = this.getSurveyCustomOption().id;
            const customSelected = selectedOptions.some((entry) => String(entry.dataset.optionId || '').trim() === customOptionId);
            const hasSelection = selectedOptions.length > 0;
            const customNeedsNotes = customSelected && selectedOptions.length === 1 && !notes;
            canSubmit = required ? (hasSelection && !customNeedsNotes) : (!customNeedsNotes);
        } else {
            const value = String(card.querySelector('.agent-survey-card__input')?.value || '').trim();
            canSubmit = required ? Boolean(value) : true;
        }

        if (submitButton) {
            submitButton.disabled = !canSubmit;
        }
    }

    renderSurveyStepInput(step = {}, stepAnswer = {}, isAnswered = false) {
        const inputType = String(step.inputType || 'choice').trim();

        if (inputType === 'choice' || inputType === 'multi-choice') {
            const selectedOptionIds = new Set(Array.isArray(stepAnswer?.selectedOptionIds) ? stepAnswer.selectedOptionIds : []);
            const renderedOptions = this.buildRenderedSurveyOptions(step);
            const optionRole = inputType === 'multi-choice' ? 'checkbox' : 'radio';
            const optionsHtml = renderedOptions.map((option) => {
                const selected = selectedOptionIds.has(option.id);
                return [
                    `<button type="button" class="agent-survey-option ${selected ? 'is-selected' : ''}"`,
                    ` data-option-id="${this.escapeHtmlAttr(option.id)}"`,
                    ` data-option-label="${this.escapeHtmlAttr(option.label)}"`,
                    ` role="${optionRole}"`,
                    ' tabindex="0"',
                    isAnswered ? ' disabled' : '',
                    ` aria-checked="${selected ? 'true' : 'false'}">`,
                    '<span class="agent-survey-option__marker" aria-hidden="true"></span>',
                    `<span class="agent-survey-option__title">${this.escapeHtml(option.label)}</span>`,
                    option.description ? `<span class="agent-survey-option__description">${this.escapeHtml(option.description)}</span>` : '',
                    '</button>',
                ].join('');
            }).join('');

            return [
                `<div class="agent-survey-card__options" role="${inputType === 'multi-choice' ? 'group' : 'radiogroup'}">${optionsHtml}</div>`,
                step.allowFreeText
                    ? [
                        '<label class="agent-survey-card__notes-label">',
                        `<span>${this.escapeHtml(step.freeTextLabel || 'Add your own input (optional)')}</span>`,
                        `<textarea class="agent-survey-card__notes" rows="3" maxlength="500" placeholder="Type your own answer or extra context for the agent" oninput="uiHelpers.syncSurveyFreeText(this)" ${isAnswered ? 'disabled' : ''}>${this.escapeHtml(stepAnswer?.text || '')}</textarea>`,
                        '</label>',
                    ].join('')
                    : '',
            ].filter(Boolean).join('');
        }

        const inputTypeMap = {
            text: 'text',
            date: 'date',
            time: 'time',
            datetime: 'datetime-local',
        };
        const htmlInputType = inputTypeMap[inputType] || 'text';
        const value = String(stepAnswer?.value || stepAnswer?.text || '').trim();
        const placeholder = String(step.placeholder || (inputType === 'text'
            ? 'Type your answer for the agent'
            : '')).trim();

        if (inputType === 'text') {
            return [
                '<label class="agent-survey-card__input-label">',
                `<span>${this.escapeHtml(placeholder || 'Your answer')}</span>`,
                `<textarea class="agent-survey-card__input agent-survey-card__input--text" rows="4" maxlength="800" placeholder="${this.escapeHtmlAttr(placeholder || 'Type your answer for the agent')}" oninput="uiHelpers.syncSurveyInputValue(this)" ${isAnswered ? 'disabled' : ''}>${this.escapeHtml(value)}</textarea>`,
                '</label>',
            ].join('');
        }

        return [
            '<label class="agent-survey-card__input-label">',
            `<span>${this.escapeHtml(placeholder || 'Your answer')}</span>`,
            `<input class="agent-survey-card__input" type="${this.escapeHtmlAttr(htmlInputType)}" value="${this.escapeHtmlAttr(value)}" oninput="uiHelpers.syncSurveyInputValue(this)" ${isAnswered ? 'disabled' : ''}>`,
            '</label>',
        ].join('');
    }

    renderSurveyBlock(survey = null, message = {}) {
        if (!survey) {
            return '';
        }

        const messageId = String(message.id || '').trim();
        const surveyState = message?.surveyState?.checkpointId === survey.id
            ? message.surveyState
            : null;
        const isAnswered = surveyState?.status === 'answered';
        const answeredSummary = isAnswered
            ? this.buildSurveyAnsweredSummary(surveyState, survey)
            : '';
        const steps = Array.isArray(survey.steps) ? survey.steps : [];
        const currentStepIndex = isAnswered ? 0 : this.getSurveyCurrentStepIndex(survey, surveyState);
        const currentStep = steps[currentStepIndex] || steps[0] || null;
        const surveyTitle = String(survey.title || 'Choose a direction').trim() || 'Choose a direction';
        const currentQuestion = String(currentStep?.question || survey.question || '').trim();
        const showQuestion = !isAnswered
            && currentQuestion
            && currentQuestion.toLowerCase() !== surveyTitle.toLowerCase();
        const stepAnswer = currentStep
            ? this.getSurveyStepAnswer(surveyState, currentStep.id)
            : null;
        const isLastStep = currentStepIndex >= Math.max(0, steps.length - 1);
        const selectionHint = !currentStep
            ? ''
            : (currentStep.inputType === 'multi-choice'
                ? `Choose up to ${currentStep.maxSelections}`
                : (currentStep.inputType === 'choice'
                    ? 'Choose one option'
                    : (currentStep.inputType === 'text'
                        ? 'Type your answer'
                        : `Pick a ${currentStep.inputType === 'datetime' ? 'date and time' : currentStep.inputType}`)));
        const progressLabel = isAnswered
            ? (steps.length > 1 ? `Completed ${steps.length} steps` : 'Answered')
            : (steps.length > 1
                ? `Step ${currentStepIndex + 1} of ${steps.length}`
                : selectionHint);
        const stepInputHtml = (!isAnswered && currentStep)
            ? this.renderSurveyStepInput(currentStep, stepAnswer, false)
            : '';
        const canSubmitCurrentStep = currentStep
            ? this.isSurveyStepComplete(currentStep, stepAnswer)
            : false;
        const submitLabel = isLastStep
            ? 'Continue with these answers'
            : 'Next question';
        const preamble = String(survey.preamble || '').trim();
        const compactAnswered = isAnswered;

        if (compactAnswered) {
            return [
                '<div class="agent-survey-card agent-survey-card--compact is-answered"',
                ` data-message-id="${this.escapeHtmlAttr(messageId)}"`,
                ` data-survey-id="${this.escapeHtmlAttr(survey.id)}"`,
                '>',
                '<div class="agent-survey-card__eyebrow">Decision checkpoint</div>',
                '<div class="agent-survey-card__title-row">',
                `<h4 class="agent-survey-card__title">${this.escapeHtml(surveyTitle)}</h4>`,
                '<span class="agent-survey-card__meta">Answered</span>',
                '</div>',
                preamble ? `<p class="agent-survey-card__preamble">${this.escapeHtml(preamble)}</p>` : '',
                '<div class="agent-survey-card__footer">',
                '<div class="agent-survey-card__answered">',
                '<span class="agent-survey-card__answered-badge">Answered</span>',
                `<span class="agent-survey-card__answered-text">${this.escapeHtml(answeredSummary || 'Response sent back to the agent.')}</span>`,
                '</div>',
                '</div>',
                '</div>',
            ].filter(Boolean).join('');
        }

        return [
            `<div class="agent-survey-card ${isAnswered ? 'is-answered' : ''}"`,
            ` data-message-id="${this.escapeHtmlAttr(messageId)}"`,
            ` data-survey-id="${this.escapeHtmlAttr(survey.id)}"`,
            ` data-current-step-index="${String(currentStepIndex)}"`,
            ` data-step-id="${this.escapeHtmlAttr(currentStep?.id || '')}"`,
            ` data-step-input-type="${this.escapeHtmlAttr(currentStep?.inputType || 'choice')}"`,
            ` data-step-required="${currentStep?.required === false ? 'false' : 'true'}"`,
            ` data-step-allow-multiple="${currentStep?.allowMultiple === true ? 'true' : 'false'}"`,
            ` data-step-max-selections="${String(currentStep?.maxSelections || 1)}"`,
            ` data-submitted="${isAnswered ? 'true' : 'false'}">`,
            '<div class="agent-survey-card__eyebrow">Decision checkpoint</div>',
            '<div class="agent-survey-card__title-row">',
            `<h4 class="agent-survey-card__title">${this.escapeHtml(surveyTitle)}</h4>`,
            `<span class="agent-survey-card__meta">${this.escapeHtml(progressLabel)}</span>`,
            '</div>',
            steps.length > 1
                ? [
                    '<div class="agent-survey-card__progress">',
                    `<span class="agent-survey-card__progress-text">${this.escapeHtml(progressLabel)}</span>`,
                    `<div class="agent-survey-card__progress-bar"><span style="width:${isAnswered ? 100 : Math.max(8, ((currentStepIndex + 1) / steps.length) * 100)}%"></span></div>`,
                    '</div>',
                ].join('')
                : '',
            preamble ? `<p class="agent-survey-card__preamble">${this.escapeHtml(preamble)}</p>` : '',
            (!isAnswered && currentStep?.title) ? `<p class="agent-survey-card__step-title">${this.escapeHtml(currentStep.title)}</p>` : '',
            showQuestion ? `<p class="agent-survey-card__question">${this.escapeHtml(currentQuestion)}</p>` : '',
            survey.whyThisMatters ? `<p class="agent-survey-card__context">${this.escapeHtml(survey.whyThisMatters)}</p>` : '',
            stepInputHtml,
            '<div class="agent-survey-card__footer">',
            isAnswered
                ? [
                    '<div class="agent-survey-card__answered">',
                    '<span class="agent-survey-card__answered-badge">Answered</span>',
                    `<span class="agent-survey-card__answered-text">${this.escapeHtml(answeredSummary || 'Response sent back to the agent.')}</span>`,
                    '</div>',
                ].join('')
                : [
                    '<div class="agent-survey-card__actions">',
                    currentStepIndex > 0
                        ? '<button type="button" class="agent-survey-card__secondary">Back</button>'
                        : '',
                    `<button type="button" class="agent-survey-card__submit" ${canSubmitCurrentStep ? '' : 'disabled'}>${this.escapeHtml(submitLabel)}</button>`,
                    '<span class="agent-survey-card__hint">The agent will continue once you answer.</span>',
                    '</div>',
                ].join(''),
            '</div>',
            '</div>',
        ].filter(Boolean).join('');
    }

    syncSurveyInputValue(input) {
        const surveyInput = input?.closest?.('.agent-survey-card__input') || input;
        const card = surveyInput?.closest?.('.agent-survey-card');
        if (!card) {
            return;
        }

        this.updateSurveySubmitState(card);
    }

    buildSurveyRenderPlan(content = '', message = {}) {
        const source = String(content || '');
        if (!/```(?:survey|kb-survey)/i.test(source)) {
            const inferredSurvey = this.extractSurveyDefinitionFromContent(source, message?.id || '');
            if (inferredSurvey) {
                const token = `KB_SURVEY_TOKEN_${String(message?.id || 'message').replace(/[^a-z0-9_-]/gi, '_')}_0`;
                return {
                    markdown: token,
                    surveys: [{
                        token,
                        html: this.renderSurveyBlock(inferredSurvey, message),
                    }],
                };
            }

            return {
                markdown: source,
                surveys: [],
            };
        }

        let surveyIndex = 0;
        const surveys = [];
        const markdown = source.replace(/```(?:survey|kb-survey)\s*([\s\S]*?)```/gi, (match) => {
            const survey = this.extractSurveyDefinitionFromContent(match, message?.id || '');
            if (!survey) {
                return match;
            }

            const token = `KB_SURVEY_TOKEN_${String(message?.id || 'message').replace(/[^a-z0-9_-]/gi, '_')}_${surveyIndex}`;
            surveyIndex += 1;
            surveys.push({
                token,
                html: this.renderSurveyBlock(survey, message),
            });
            return `\n\n${token}\n\n`;
        });

        return {
            markdown,
            surveys,
        };
    }

    replaceSurveyRenderTokens(html = '', surveys = []) {
        let rendered = String(html || '');

        (Array.isArray(surveys) ? surveys : []).forEach((survey) => {
            const token = String(survey?.token || '').trim();
            const surveyHtml = String(survey?.html || '').trim();
            if (!token || !surveyHtml) {
                return;
            }

            const escapedToken = this.escapeRegExp(token);
            rendered = rendered
                .replace(new RegExp(`<p>\\s*${escapedToken}\\s*</p>`, 'g'), surveyHtml)
                .replace(new RegExp(escapedToken, 'g'), surveyHtml);
        });

        return rendered;
    }

    sanitizeAssistantHtml(html = '') {
        return DOMPurify.sanitize(html, {
            ALLOWED_TAGS: [
                'p', 'br', 'strong', 'em', 'u', 's', 'del', 'ins', 'mark',
                'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                'ul', 'ol', 'li',
                'blockquote', 'hr',
                'code', 'pre',
                'a', 'img',
                'table', 'thead', 'tbody', 'tr', 'th', 'td',
                'div', 'span', 'button', 'i',
                'input', 'textarea', 'label'
            ],
            ALLOWED_ATTR: [
                'href', 'title', 'target', 'rel', 'src', 'alt',
                'class', 'data-code', 'onclick', 'type', 'checked', 'disabled',
                'aria-label', 'aria-hidden', 'aria-checked',
                'data-filename', 'data-mermaid-source', 'data-mermaid-filename', 'data-lucide',
                'data-html-preview',
                'data-message-id', 'data-survey-id', 'data-allow-multiple', 'data-max-selections',
                'data-step-id', 'data-step-input-type', 'data-step-required', 'data-step-allow-multiple', 'data-step-max-selections',
                'data-current-step-index', 'data-option-id', 'data-option-label', 'data-submitted',
                'placeholder', 'rows', 'maxlength', 'role', 'tabindex', 'value', 'style'
            ],
            ALLOW_DATA_ATTR: false,
        });
    }

    enhancePresentationCallouts(html = '') {
        const calloutLabels = {
            note: 'Note',
            tip: 'Tip',
            important: 'Important',
            warning: 'Warning',
            success: 'Success',
            danger: 'Danger',
            info: 'Info',
        };

        return String(html || '').replace(
            /<blockquote>\s*<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|SUCCESS|DANGER|INFO)\](?:\s+([^<\n]*?))?\s*(?:<br\s*\/?>|\n)([\s\S]*?)<\/p>\s*<\/blockquote>/gi,
            (_match, type, title, body) => {
                const tone = String(type || '').toLowerCase();
                const label = calloutLabels[tone] || 'Note';
                const normalizedTitle = String(title || '').trim();
                const bodyHtml = String(body || '').trim();
                return `
                    <div class="kb-callout kb-callout--${tone}">
                        <div class="kb-callout__title">${this.escapeHtml(normalizedTitle || label)}</div>
                        ${bodyHtml ? `<div class="kb-callout__body">${bodyHtml}</div>` : ''}
                    </div>
                `;
            },
        );
    }

    normalizeHumanReadableMarkdownSegment(source = '') {
        let text = String(source || '').replace(/\r\n?/g, '\n');
        if (!text.trim()) {
            return text;
        }

        const sectionLabels = [
            'Short answer',
            'Summary',
            'Recommendation',
            'Result',
            'Why it works',
            'Why it matters',
            'What changed',
            'Details',
            'Plan',
            'Steps',
            'Ingredients',
            'Preparation',
            'Serving Suggestions',
            'Variations',
            'Next step',
            'Next steps',
            'Caveat',
            'Note',
            'Verification',
        ];
        const labelPattern = new RegExp(`([^\\n])\\s+(?=(${sectionLabels.map((label) => this.escapeRegExp(label)).join('|')}):\\s)`, 'gi');

        text = text
            .replace(/\u2022/g, '-')
            .replace(/(^|\s)(\d{1,2})\)\s/g, '$1$2. ')
            .replace(labelPattern, '$1\n\n');

        const hasMarkdownStructure = /(^|\n)\s*(#{1,6}\s|[-*]\s|\d+\.\s|>|```|\|.+\|)/m.test(text);
        const paragraphs = text.split(/\n{2,}/);
        if (hasMarkdownStructure || paragraphs.length > 1 || text.trim().length < 520) {
            return text.trim();
        }

        const sentences = text.trim().split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
        const rebuilt = [];
        let paragraph = '';
        sentences.forEach((sentence) => {
            const candidate = paragraph ? `${paragraph} ${sentence}` : sentence;
            if (candidate.length > 420 && paragraph) {
                rebuilt.push(paragraph);
                paragraph = sentence;
            } else {
                paragraph = candidate;
            }
        });
        if (paragraph) {
            rebuilt.push(paragraph);
        }

        return (rebuilt.length > 1 ? rebuilt.join('\n\n') : text).trim();
    }

    normalizeStructuredAssistantMarkdown(source = '') {
        if (window.KimiBuiltModelOutputParser?.normalizeStructuredMarkdown) {
            return window.KimiBuiltModelOutputParser.normalizeStructuredMarkdown(source);
        }

        return String(source || '')
            .split(/(```[\s\S]*?```)/g)
            .map((segment) => {
                if (/^```[\s\S]*```$/.test(segment)) {
                    return segment;
                }

                return this.restoreFlattenedMarkdownBlocks(
                    this.normalizeHumanReadableMarkdownSegment(segment),
                );
            })
            .join('');
    }

    looksLikeStandaloneHtmlDocument(source = '') {
        const normalized = String(source || '').trim();
        if (!normalized || /^```/i.test(normalized)) {
            return false;
        }

        return /^(?:<!doctype html\b|<html\b|<head\b|<body\b)/i.test(normalized)
            && /<\/(?:html|body)>/i.test(normalized);
    }

    looksLikePreviewableHtmlFragment(source = '') {
        const normalized = String(source || '').trim();
        if (!normalized || /^```/i.test(normalized) || this.looksLikeStandaloneHtmlDocument(normalized)) {
            return false;
        }

        const totalTagCount = (normalized.match(/<[^>]+>/g) || []).length;
        const layoutTagCount = (normalized.match(/<\/?(?:div|main|section|article|header|footer|nav|aside|table|form|button|canvas)\b/gi) || []).length;
        const hasClosedLayout = /<\/(?:div|main|section|article|header|footer|nav|aside|table|form|button|canvas)>/i.test(normalized);
        const hasStyle = /<style\b[^>]*>[\s\S]*<\/style>/i.test(normalized);
        const hasScript = /<script\b[^>]*>[\s\S]*<\/script>/i.test(normalized);

        return normalized.length >= 280
            && totalTagCount >= 8
            && hasClosedLayout
            && (hasStyle || hasScript || layoutTagCount >= 6);
    }

    stripHtmlLeadIn(prefix = '') {
        return String(prefix || '')
            .replace(/```html\s*$/i, '')
            .replace(/\b(?:here(?:'s| is)?|below is|this is)\s+the\s+(?:full\s+)?html\s+(?:source|code)\s*(?:for|of)?\s*$/i, '')
            .replace(/\b(?:full\s+)?html\s+(?:source|code|document|preview)\s*:?\s*$/i, '')
            .replace(/\b(?:inline\s+html|raw\s+html|html)\s*:?\s*$/i, '')
            .replace(/\b[a-z0-9._-]+\.html\s*$/i, '')
            .trim();
    }

    extractEmbeddedStandaloneHtmlDocument(source = '') {
        const raw = String(source || '');
        if (!raw.trim() || /^```/i.test(raw.trim())) {
            return null;
        }

        const starts = [
            /<!doctype html\b/i,
            /<html\b/i,
            /<head\b/i,
            /<body\b/i,
        ]
            .map((pattern) => {
                const match = pattern.exec(raw);
                return Number.isInteger(match?.index) ? match.index : -1;
            })
            .filter((index) => index >= 0);

        if (starts.length === 0) {
            return null;
        }

        const startIndex = Math.min(...starts);
        const prefix = raw.slice(0, startIndex);
        const tail = raw.slice(startIndex).trim();
        if (!this.looksLikeStandaloneHtmlDocument(tail)) {
            return null;
        }

        const normalizedPrefix = this.stripHtmlLeadIn(prefix);

        return {
            prefix: normalizedPrefix,
            html: tail,
        };
    }

    extractEmbeddedHtmlPreviewFragment(source = '') {
        const raw = String(source || '');
        if (!raw.trim() || /^```/i.test(raw.trim())) {
            return null;
        }

        const starts = [
            /<!doctype html\b/i,
            /<html\b/i,
            /<head\b/i,
            /<body\b/i,
            /<title\b/i,
            /<style\b/i,
            /<(?:main|section|div|article|header|nav|aside|table|form|canvas)\b/i,
        ]
            .map((pattern) => {
                const match = pattern.exec(raw);
                return Number.isInteger(match?.index) ? match.index : -1;
            })
            .filter((index) => index >= 0);

        if (starts.length === 0) {
            return null;
        }

        const startIndex = Math.min(...starts);
        const prefix = raw.slice(0, startIndex);
        const tail = raw.slice(startIndex).trim();
        if (!this.looksLikeStandaloneHtmlDocument(tail) && !this.looksLikePreviewableHtmlFragment(tail)) {
            return null;
        }

        const normalizedPrefix = this.stripHtmlLeadIn(prefix);

        return {
            prefix: normalizedPrefix,
            html: tail,
        };
    }

    normalizeInlineHtmlAssistantMarkdown(source = '') {
        const normalized = String(source || '').trim();
        if (this.looksLikeStandaloneHtmlDocument(normalized)) {
            return `\`\`\`html\n${normalized}\n\`\`\``;
        }

        if (this.looksLikePreviewableHtmlFragment(normalized)) {
            return `\`\`\`html\n${normalized}\n\`\`\``;
        }

        const embedded = this.extractEmbeddedStandaloneHtmlDocument(normalized);
        if (embedded?.html) {
            return [
                embedded.prefix,
                `\`\`\`html\n${embedded.html}\n\`\`\``,
            ].filter(Boolean).join('\n\n');
        }

        const fragment = this.extractEmbeddedHtmlPreviewFragment(normalized);
        if (!fragment?.html) {
            return normalized;
        }

        return [
            fragment.prefix,
            `\`\`\`html\n${fragment.html}\n\`\`\``,
        ].filter(Boolean).join('\n\n');
    }

    restoreFlattenedMarkdownBlocks(source = '') {
        let text = String(source || '').replace(/\r\n?/g, '\n');
        if (!text.trim()) {
            return text;
        }

        const wrappedQuoteMatch = text.match(/^"([\s\S]*)"$/);
        if (wrappedQuoteMatch && /(?:#{2,6}\s|\d+\.\s|[*-]\s)/.test(wrappedQuoteMatch[1])) {
            text = wrappedQuoteMatch[1];
        }

        text = this.restoreFlattenedMarkdownTables(text);

        if (!/[^\n]\s+(?:#{2,6}\s|\d+\.\s|[*-]\s)/.test(text)) {
            return text.trim();
        }

        return text
            .replace(/([.!?:])(?=#{2,6}\s)/g, '$1\n\n')
            .replace(/([.!?:])(?=\d+\.\s)/g, '$1\n')
            .replace(/([.!?:])(?=[*-]\s)/g, '$1\n')
            .replace(/([^\n])\s+(?=#{2,6}\s)/g, '$1\n\n')
            .replace(/([^\n])\s+(?=\d+\.\s)/g, '$1\n')
            .replace(/([^\n])\s+(?=[*-]\s)/g, '$1\n')
            .replace(/([^\n])\s+(?=(?:Style|Overview|Summary|Recommendation|Next Step|Next Steps):)/g, '$1\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    restoreFlattenedMarkdownTables(source = '') {
        let text = String(source || '').replace(/\r\n?/g, '\n');
        if (!text.trim() || !/\|/.test(text)) {
            return text;
        }

        const tableSectionLabels = [
            'Summary',
            'Result',
            'Results',
            'Ingredients',
            'Preparation',
            'Variations',
            'Equipment',
            'Nutrition',
            'Shopping List',
            'Troubleshooting',
            'Timeline',
            'Schedule',
            'Checklist',
            'Options',
            'Comparison',
        ];
        const headingSectionLabels = [
            'Why it works',
            'Serving Suggestions',
            'Tips',
            'Notes',
        ];
        const tableLabelPattern = tableSectionLabels.map((label) => this.escapeRegExp(label)).join('|');
        const headingLabelPattern = headingSectionLabels.map((label) => this.escapeRegExp(label)).join('|');

        text = text
            .replace(new RegExp(`(^|\\n)(${tableLabelPattern})[^\\S\\n]+\\|`, 'gi'), '$1### $2\n\n|')
            .replace(new RegExp(`([^\\n])[^\\S\\n]+(${tableLabelPattern})[^\\S\\n]+\\|`, 'gi'), '$1\n\n### $2\n\n|')
            .replace(new RegExp(`(^|\\n)(${headingLabelPattern})(?=\\s|$)`, 'gi'), '$1### $2')
            .replace(new RegExp(`([^\\n])[^\\S\\n]+(${headingLabelPattern})(?=\\s|$)`, 'gi'), '$1\n\n### $2\n')
            .replace(/([^\n])[^\S\n]+---[^\S\n]*/g, '$1\n\n---\n\n')
            .replace(/\|\s+(?=\|)/g, '|\n')
            .replace(/(^|\n)(\|[^\n]*\|)\s+(?=\|?\s*:?-{3,}:?\s*\|)/g, '$1$2\n')
            .replace(/(^|\n)(\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?)\s+(?=\|)/g, '$1$2\n')
            .replace(/(^|\n)(\|[^\n]*\|)\s+(?=>\s)/g, '$1$2\n\n')
            .replace(/(^|\n)(\|[^\n]*\|)\s+(?=---(?:\s|$))/g, '$1$2\n\n')
            .replace(/(^|\n)#{1,6}\s*\n+(?=#{1,6}\s+)/g, '$1')
            .replace(/\n{3,}/g, '\n\n');

        return this.normalizeMultilineTableCells(text);
    }

    normalizeMultilineTableCells(source = '') {
        const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
        const normalizedLines = [];
        let tableColumnCount = 0;
        let pendingRow = '';

        const countPipeColumns = (line = '') => {
            const trimmed = String(line || '').trim();
            if (!trimmed.startsWith('|') || !trimmed.includes('|')) {
                return 0;
            }

            return trimmed
                .replace(/^\|/, '')
                .replace(/\|$/, '')
                .split('|').length;
        };

        const isSeparatorRow = (line = '') => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
        const flushPendingRow = () => {
            if (pendingRow) {
                normalizedLines.push(pendingRow);
                pendingRow = '';
            }
        };

        lines.forEach((line) => {
            const trimmed = line.trim();
            if (isSeparatorRow(trimmed)) {
                flushPendingRow();
                tableColumnCount = countPipeColumns(trimmed);
                normalizedLines.push(line);
                return;
            }

            const isTableLine = trimmed.startsWith('|') && trimmed.includes('|');
            if (!isTableLine) {
                if (pendingRow && tableColumnCount > 0 && trimmed && !/^#{1,6}\s|^---$|^>/.test(trimmed)) {
                    pendingRow += `<br>${this.escapeHtml(trimmed)}`;
                    return;
                }

                flushPendingRow();
                if (!trimmed) {
                    tableColumnCount = 0;
                }
                normalizedLines.push(line);
                return;
            }

            if (tableColumnCount > 0 && countPipeColumns(trimmed) < tableColumnCount && pendingRow) {
                pendingRow += `<br>${this.escapeHtml(trimmed.replace(/^\|?\s*/, '').replace(/\|?\s*$/, ''))}`;
                return;
            }

            flushPendingRow();
            pendingRow = line;
        });

        flushPendingRow();
        return normalizedLines.join('\n');
    }

    looksLikeAgentBrief(markdown = '', message = {}) {
        const normalized = String(markdown || '').trim();
        if (normalized.length < 180) {
            return false;
        }

        const hasStructure = /(^|\n)#{2,6}\s/m.test(normalized)
            || /(^|\n)\d+\.\s/m.test(normalized)
            || /(^|\n)[*-]\s/m.test(normalized);
        if (!hasStructure) {
            return false;
        }

        if (message?.agentExecutor === true || message?.metadata?.agentExecutor === true) {
            return true;
        }

        return /based on your survey response|here['’]s what i(?: have|'ve) prepared|would you like|this (?:diagram|wireframe|plan|architecture)/i.test(normalized);
    }

    buildAgentBriefSections(markdown = '') {
        const normalized = String(markdown || '').trim();
        const headingMatch = normalized.match(/^#{2,6}\s+(.+)$/m);
        let intro = '';
        let title = '';
        let bodyMarkdown = normalized;
        let footer = '';

        if (headingMatch) {
            title = String(headingMatch[1] || '').trim();
            intro = normalized.slice(0, headingMatch.index).trim();
            bodyMarkdown = normalized.slice(headingMatch.index + headingMatch[0].length).trim();
        } else {
            const sections = normalized.split(/\n{2,}/).filter(Boolean);
            if (sections.length > 1) {
                intro = sections[0].trim();
                bodyMarkdown = sections.slice(1).join('\n\n').trim();
            }
        }

        const footerMatch = bodyMarkdown.match(/\n\n([^#\n][\s\S]*\?)$/);
        if (footerMatch && footerMatch[1].length <= 320) {
            footer = footerMatch[1].trim();
            bodyMarkdown = bodyMarkdown.slice(0, footerMatch.index).trim();
        }

        return {
            title,
            intro,
            bodyMarkdown: bodyMarkdown || normalized,
            footer,
        };
    }

    getLivePhaseMeta(phase = 'thinking') {
        switch (String(phase || '').trim().toLowerCase()) {
            case 'planning':
                return {
                    phase: 'planning',
                    label: 'Planning',
                    text: 'Planning the work',
                    detail: 'Estimating the steps and ordering the work.',
                    icon: 'list-todo',
                };
            case 'executing':
                return {
                    phase: 'executing',
                    label: 'Working',
                    text: 'Working through the steps',
                    detail: 'Executing the planned steps and updating progress.',
                    icon: 'hammer',
                };
            case 'reasoning':
                return {
                    phase: 'reasoning',
                    label: 'Reasoning',
                    text: 'Reasoning in progress',
                    detail: 'Working through the answer before drafting it.',
                    icon: 'brain',
                };
            case 'checking-tools':
                return {
                    phase: 'checking-tools',
                    label: 'Checking tools',
                    text: 'Checking tools',
                    detail: 'Reviewing tool results and pulling in context.',
                    icon: 'wrench',
                };
            case 'finalizing':
                return {
                    phase: 'finalizing',
                    label: 'Finalizing',
                    text: 'Finalizing the reply',
                    detail: 'Turning the completed work into the final response.',
                    icon: 'sparkles',
                };
            case 'blocked':
                return {
                    phase: 'blocked',
                    label: 'Blocked',
                    text: 'Work is blocked',
                    detail: 'A blocking issue needs attention before the task can continue.',
                    icon: 'triangle-alert',
                };
            case 'writing':
                return {
                    phase: 'writing',
                    label: 'Writing',
                    text: 'Writing the reply',
                    detail: 'Streaming the response into the thread.',
                    icon: 'pen-line',
                };
            case 'ready':
                return {
                    phase: 'ready',
                    label: 'Ready',
                    text: 'Reply ready',
                    detail: 'The answer is complete.',
                    icon: 'check',
                };
            default:
                return {
                    phase: 'thinking',
                    label: 'Thinking',
                    text: 'Assistant is thinking',
                    detail: 'Gathering context and preparing the reply.',
                    icon: 'sparkles',
                };
        }
    }

    buildAssistantAvatarMarkup(message = null, isStreaming = false) {
        return `<div class="message-avatar assistant" aria-hidden="true"><i data-lucide="bot" class="w-4 h-4"></i></div>`;
    }

    extractReasoningText(value = null) {
        if (typeof value === 'string') {
            return String(value || '').trim();
        }

        if (Array.isArray(value)) {
            return value
                .map((entry) => this.extractReasoningText(entry))
                .filter(Boolean)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
        }

        if (!value || typeof value !== 'object') {
            return '';
        }

        const leafCandidates = [
            value.text,
            value.output_text,
            value.outputText,
            value.summary_text,
            value.summaryText,
            value.value,
        ];
        for (const candidate of leafCandidates) {
            if (typeof candidate === 'string' && candidate.trim()) {
                return candidate.trim();
            }
        }

        if (value.type === 'reasoning') {
            return this.extractReasoningText(
                value.summary
                || value.summary_text
                || value.reasoning_content
                || value.reasoning
                || value.text
                || value.content
                || value.output_text
                || value.value
                || '',
            );
        }

        const directCandidates = [
            value.reasoningSummary,
            value.reasoning_summary,
            value.reasoning,
            value.reasoning_text,
            value.reasoningText,
            value.reasoning_content,
            value.reasoningContent,
            value.reasoning_details,
            value.reasoningDetails,
            value.summary,
            value.summaryText,
            value.summary_text,
            value.message,
            value.content,
        ];
        for (const candidate of directCandidates) {
            const normalized = this.extractReasoningText(candidate);
            if (normalized) {
                return normalized;
            }
        }

        return this.extractDisplayText(value);
    }

    getMessageReasoningSummary(message = null) {
        return this.extractReasoningText(
            message?.reasoningSummary
            || message?.metadata?.reasoningSummary
            || message?.reasoning
            || message?.reasoning_text
            || message?.reasoning_content
            || message?.reasoning_details
            || message?.assistantMetadata?.reasoningSummary
            || message?.assistantMetadata?.reasoning
            || message?.assistant_metadata?.reasoningSummary
            || message?.assistant_metadata?.reasoning
            || '',
        );
    }

    getMessageReasoningDisplayState(message = null, isStreaming = false) {
        const summary = this.getMessageReasoningSummary(message);
        const displaySource = String(message?.reasoningDisplaySource || '').trim();
        const displayText = this.extractReasoningText(message?.reasoningDisplayText);
        const displayFullText = this.extractReasoningText(message?.reasoningDisplayFullText);
        const displayTitle = this.extractDisplayText(message?.reasoningDisplayTitle);
        const displayIcon = this.extractDisplayText(message?.reasoningDisplayIcon);
        const displayAnimated = message?.reasoningDisplayAnimated === true;
        const hasManagedAppProgress = Boolean(
            message?.managedAppProgressState
            || message?.metadata?.managedAppProgressState,
        );
        const isLegacyManagedAppDisplay = hasManagedAppProgress && (
            ['Build progress', 'Build status'].includes(displayTitle)
            || ['activity', 'badge-check', 'triangle-alert'].includes(displayIcon)
        );
        const visibleAssistantContent = this.extractMessageContentText(message?.displayContent ?? message?.content ?? '');
        const hasSurveyDisplay = Boolean(this.extractSurveyDefinitionFromContent(visibleAssistantContent, message?.id || ''));

        if (isLegacyManagedAppDisplay) {
            return null;
        }

        if (displaySource === 'generated' && (hasManagedAppProgress || hasSurveyDisplay)) {
            return null;
        }

        if (displayText && (displaySource === 'stream' || displaySource === 'final' || displaySource === 'generated')) {
            const fullText = displayFullText || summary || displayText;
            const isGenerated = displaySource === 'generated';
            return {
                source: isGenerated ? 'generated' : 'reasoning',
                title: isGenerated
                    ? WEB_CHAT_SYNTHETIC_REASONING_TITLE
                    : (displayTitle || 'Reasoning'),
                icon: displayIcon || (isGenerated ? 'sparkles' : 'brain'),
                previewText: isGenerated
                    ? displayText
                    : this.buildReasoningSummaryPreview(displayText, isStreaming ? 168 : 132),
                bodyText: fullText,
                animated: displayAnimated,
                live: isStreaming,
            };
        }

        if (summary) {
            return {
                source: 'reasoning',
                title: 'Reasoning',
                icon: 'brain',
                previewText: this.buildReasoningSummaryPreview(summary, isStreaming ? 168 : 132),
                bodyText: summary,
                animated: false,
                live: isStreaming,
            };
        }

        return null;
    }

    hasMessageReasoning(message = null, isStreaming = false) {
        return Boolean(this.getMessageReasoningDisplayState(message, isStreaming));
    }

    normalizeAssistantProgressStepStatus(status = '') {
        switch (String(status || '').trim().toLowerCase()) {
            case 'completed':
            case 'done':
                return 'completed';
            case 'in_progress':
            case 'running':
            case 'active':
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

    normalizeAssistantProgressStepTitle(value = null, fallback = '') {
        const rawTitle = this.extractDisplayText(value);
        const cleanedTitle = rawTitle
            .replace(/\s*\[truncated\s+\d+\s+chars\]\s*$/i, '')
            .trim();
        return this.extractDisplayText(cleanedTitle || rawTitle || fallback, {
            maxLength: 180,
            preferSentenceBoundary: true,
            truncationSuffix: '',
        });
    }

    isGenericAssistantProgressStepTitle(value = '') {
        const title = this.extractDisplayText(value).trim();
        return /^(?:milestone|step|task)\s+\d+$/i.test(title)
            || /^progress[-_\s]*step[-_\s]*\d+$/i.test(title)
            || /^project[-_\s]*step[-_\s]*\d+$/i.test(title)
            || /^workflow[-_\s]*step[-_\s]*\d+$/i.test(title);
    }

    getEstimatedReasoningStepTitle(index = 0) {
        const labels = WEB_CHAT_ESTIMATED_REASONING_STEPS;
        return labels[index % labels.length] || `Step ${index + 1}`;
    }

    getAssistantProgressState(message = null) {
        const rawProgress = message?.progressState
            || message?.metadata?.progressState
            || null;
        if (!rawProgress || typeof rawProgress !== 'object') {
            return null;
        }

        let steps = (Array.isArray(rawProgress.steps) ? rawProgress.steps : [])
            .map((step, index) => {
                const title = this.normalizeAssistantProgressStepTitle(
                    step?.title
                    || step?.label
                    || step?.summary
                    || step?.reason
                    || step?.text
                    || step,
                    `Step ${index + 1}`,
                );
                if (!title) {
                    return null;
                }
                const shouldUseEstimatedTitle = rawProgress.estimated !== false
                    && this.isGenericAssistantProgressStepTitle(title);

                return {
                    id: this.extractDisplayText(step?.id, { maxLength: 80 }) || `progress-step-${index + 1}`,
                    title: shouldUseEstimatedTitle ? this.getEstimatedReasoningStepTitle(index) : title,
                    status: this.normalizeAssistantProgressStepStatus(step?.status),
                };
            })
            .filter(Boolean);
        const requestedTotalSteps = Number.isFinite(Number(rawProgress.totalSteps)) && Number(rawProgress.totalSteps) > 0
            ? Math.max(steps.length, Math.round(Number(rawProgress.totalSteps)))
            : steps.length;
        const displayStepCount = Math.max(
            steps.length,
            Math.min(requestedTotalSteps, WEB_CHAT_MAX_PROGRESS_DISPLAY_STEPS),
        );
        while (steps.length < displayStepCount) {
            const index = steps.length;
            steps.push({
                id: `progress-step-${index + 1}`,
                title: rawProgress.estimated !== false
                    ? this.getEstimatedReasoningStepTitle(index)
                    : `Step ${index + 1}`,
                status: 'pending',
            });
        }
        if (steps.length < 2) {
            return null;
        }

        const totalSteps = requestedTotalSteps > 0
            ? Math.max(steps.length, requestedTotalSteps)
            : steps.length;
        const completedHint = Number.isFinite(Number(rawProgress.completedSteps)) && Number(rawProgress.completedSteps) >= 0
            ? Math.min(totalSteps, Math.round(Number(rawProgress.completedSteps)))
            : -1;
        const activeStepId = this.extractDisplayText(rawProgress.activeStepId, { maxLength: 80 });
        const activeStepIndexValue = Math.round(Number(rawProgress.activeStepIndex));
        const activeIndexHint = Number.isFinite(Number(rawProgress.activeStepIndex)) && Number(rawProgress.activeStepIndex) >= 0
            ? Math.min(steps.length - 1, activeStepIndexValue)
            : steps.findIndex((step) => activeStepId && step.id === activeStepId);
        steps = steps.map((step, index) => {
            if (completedHint >= 0 && index < completedHint && !['failed', 'skipped'].includes(step.status)) {
                return { ...step, status: 'completed' };
            }

            if (activeIndexHint === index && step.status === 'pending') {
                return { ...step, status: 'in_progress' };
            }

            return step;
        });
        let completedSteps = steps.filter((step) => ['completed', 'skipped'].includes(step.status)).length;
        if (completedHint > completedSteps) {
            completedSteps = completedHint;
        }
        let activeStepIndex = steps.findIndex((step) => step.status === 'in_progress');
        if (activeStepIndex < 0 && completedSteps < totalSteps) {
            activeStepIndex = steps.findIndex((step, index) => step.status === 'pending' && index >= completedSteps);
            if (activeStepIndex < 0) {
                activeStepIndex = steps.findIndex((step) => step.status === 'pending');
            }
        }
        if (activeStepIndex >= 0 && steps[activeStepIndex]?.status === 'pending') {
            steps = steps.map((step, index) => index === activeStepIndex
                ? { ...step, status: 'in_progress' }
                : step);
        }
        const toolEventDetails = (Array.isArray(rawProgress.toolEvents) ? rawProgress.toolEvents : [])
            .map((event) => this.extractDisplayText(
                event?.detail
                || event?.message
                || event?.summary
                || event?.text,
                { maxLength: 240 },
            ))
            .filter(Boolean);
        const latestToolEventDetail = toolEventDetails[toolEventDetails.length - 1] || '';
        const progressReasoningSummary = this.extractDisplayText(
            rawProgress.reasoningSummary
            || rawProgress.reasoning_summary
            || rawProgress.reasoning
            || rawProgress.message,
            { maxLength: 240 },
        );
        const detail = this.extractDisplayText(rawProgress.detail, { maxLength: 240 })
            || progressReasoningSummary
            || latestToolEventDetail;
        const phase = this.extractDisplayText(rawProgress.phase, { maxLength: 80 }).toLowerCase() || 'thinking';
        const estimated = rawProgress.estimated !== false;
        const summary = this.extractDisplayText(rawProgress.summary, { maxLength: 160 })
            || this.extractDisplayText(progressReasoningSummary, { maxLength: 160 })
            || this.extractDisplayText(latestToolEventDetail, { maxLength: 160 })
            || `${completedSteps}/${totalSteps} steps complete`;
        const progressUnits = Math.min(totalSteps, completedSteps + (activeStepIndex >= 0 && completedSteps < totalSteps ? 0.45 : 0));
        const percent = totalSteps > 0
            ? Math.max(8, Math.min(100, Math.round((progressUnits / totalSteps) * 100)))
            : 0;

        return {
            phase,
            detail,
            estimated,
            summary,
            totalSteps,
            completedSteps,
            activeStepIndex,
            percent,
            steps,
        };
    }

    getManagedAppProgressState(message = null) {
        const rawProgress = message?.managedAppProgressState
            || message?.metadata?.managedAppProgressState
            || null;
        if (!rawProgress || typeof rawProgress !== 'object') {
            return null;
        }

        const steps = (Array.isArray(rawProgress.steps) ? rawProgress.steps : [])
            .map((step, index) => {
                const title = this.normalizeAssistantProgressStepTitle(
                    step?.title
                    || step?.label
                    || step?.summary
                    || step?.reason
                    || step?.text
                    || step,
                    `Step ${index + 1}`,
                );
                if (!title) {
                    return null;
                }

                return {
                    id: this.extractDisplayText(step?.id, { maxLength: 80 }) || `managed-app-step-${index + 1}`,
                    title,
                    status: this.normalizeAssistantProgressStepStatus(step?.status),
                };
            })
            .filter(Boolean);
        if (steps.length === 0) {
            return null;
        }

        const totalSteps = Number.isFinite(Number(rawProgress.totalSteps)) && Number(rawProgress.totalSteps) > 0
            ? Number(rawProgress.totalSteps)
            : steps.length;
        const completedSteps = steps.filter((step) => ['completed', 'skipped'].includes(step.status)).length;
        const resolvedSteps = steps.filter((step) => ['completed', 'failed', 'skipped'].includes(step.status)).length;
        let activeStepIndex = steps.findIndex((step) => step.status === 'in_progress');
        if (activeStepIndex < 0 && resolvedSteps < totalSteps) {
            activeStepIndex = steps.findIndex((step) => step.status === 'pending');
        }

        const phase = this.extractDisplayText(rawProgress.phase, { maxLength: 80 }).toLowerCase() || 'updated';
        const phaseLabel = this.extractDisplayText(rawProgress.phaseLabel, { maxLength: 120 });
        const summary = this.extractDisplayText(rawProgress.summary, { maxLength: 180 }) || 'Managed app status updated.';
        const detail = this.extractDisplayText(rawProgress.detail, { maxLength: 240 });
        const nextStep = this.extractDisplayText(rawProgress.nextStep, { maxLength: 180 });
        const expectedHost = this.extractDisplayText(rawProgress.expectedHost, { maxLength: 120 });
        const ingressStatus = this.extractDisplayText(rawProgress.ingressStatus, { maxLength: 120 });
        const tlsStatus = this.extractDisplayText(rawProgress.tlsStatus, { maxLength: 120 });
        const httpsStatus = this.extractDisplayText(rawProgress.httpsStatus, { maxLength: 120 });
        const appProbeStatus = this.extractDisplayText(rawProgress.appProbeStatus, { maxLength: 120 });
        const evidenceSource = rawProgress.evidence && typeof rawProgress.evidence === 'object'
            ? rawProgress.evidence
            : {};
        const requiredProof = evidenceSource.requiredProof && typeof evidenceSource.requiredProof === 'object'
            ? evidenceSource.requiredProof
            : {};
        const evidence = {
            repository: this.extractDisplayText(evidenceSource.repository, { maxLength: 120 }),
            repoUrl: this.extractDisplayText(evidenceSource.repoUrl, { maxLength: 220 }),
            commitSha: this.extractDisplayText(evidenceSource.commitSha, { maxLength: 48 }),
            pipelineUrl: this.extractDisplayText(evidenceSource.pipelineUrl, { maxLength: 220 }),
            pipelineStatus: this.extractDisplayText(evidenceSource.pipelineStatus, { maxLength: 80 }),
            imageTag: this.extractDisplayText(evidenceSource.imageTag, { maxLength: 80 }),
            deployStatus: this.extractDisplayText(evidenceSource.deployStatus, { maxLength: 80 }),
            verificationStatus: this.extractDisplayText(evidenceSource.verificationStatus, { maxLength: 80 }),
            publicUrl: this.extractDisplayText(evidenceSource.publicUrl, { maxLength: 220 }),
            verifiedAt: this.extractDisplayText(evidenceSource.verifiedAt, { maxLength: 80 }),
            requiredProof: {
                sourceChanged: requiredProof.sourceChanged === true,
                gitlabPipelineObserved: requiredProof.gitlabPipelineObserved === true,
                imageAvailable: requiredProof.imageAvailable === true,
                deploymentObserved: requiredProof.deploymentObserved === true,
                publicVerificationObserved: requiredProof.publicVerificationObserved === true,
            },
        };
        const nextActions = (Array.isArray(rawProgress.nextActions) ? rawProgress.nextActions : [])
            .map((item) => this.extractDisplayText(item, { maxLength: 40 }))
            .filter(Boolean)
            .slice(0, 4);
        const openItems = (Array.isArray(rawProgress.openItems) ? rawProgress.openItems : [])
            .map((item) => this.extractDisplayText(item, { maxLength: 160 }))
            .filter(Boolean)
            .slice(0, 3);
        const terminal = rawProgress.terminal === true;
        const live = rawProgress.live !== false && terminal !== true;
        const progressUnits = terminal
            ? totalSteps
            : Math.min(totalSteps, completedSteps + (activeStepIndex >= 0 ? 0.45 : 0));
        const percent = totalSteps > 0
            ? Math.max(8, Math.min(100, Math.round((progressUnits / totalSteps) * 100)))
            : 0;

        return {
            phase,
            phaseLabel,
            summary,
            detail,
            nextStep,
            expectedHost,
            ingressStatus,
            tlsStatus,
            httpsStatus,
            appProbeStatus,
            evidence,
            nextActions,
            openItems,
            terminal,
            live,
            totalSteps,
            completedSteps,
            activeStepIndex,
            percent,
            steps,
        };
    }

    getManagedAppCheckpoint(message = null) {
        return this.normalizeSurveyDefinition(
            message?.managedAppCheckpoint
            || message?.metadata?.managedAppCheckpoint
            || null,
        );
    }

    buildProgressTrackerMarkup(message = null, isStreaming = false) {
        const progressState = this.getAssistantProgressState(message);
        if (!progressState) {
            return '';
        }

        const reasoningState = this.getMessageReasoningDisplayState(message, isStreaming);
        const phaseMeta = this.getLivePhaseMeta(progressState.phase || message?.liveState?.phase || 'thinking');
        const reasoningText = this.extractDisplayText(
            reasoningState?.bodyText
            || reasoningState?.previewText
            || progressState.detail
            || message?.liveState?.detail
            || phaseMeta.detail
            || 'Working through the next step.',
            { maxLength: isStreaming ? 260 : 180 },
        );
        const reasoningIcon = reasoningState?.icon || phaseMeta.icon || 'brain';
        const reasoningAnimated = reasoningState?.animated === true && isStreaming;
        const reasoningEyebrow = reasoningState?.source === 'generated'
            ? WEB_CHAT_SYNTHETIC_REASONING_TITLE
            : 'Live reasoning';
        const stepsHtml = progressState.steps.map((step, index) => {
            const isActive = index === progressState.activeStepIndex;
            const stateLabel = ({
                completed: 'Done',
                in_progress: 'Working',
                failed: 'Failed',
                skipped: 'Skipped',
                pending: 'Pending',
            })[step.status] || 'Pending';

            return `
                <li class="assistant-progress-card__step assistant-progress-card__step--${step.status}${isActive ? ' is-active' : ''}">
                    <span class="assistant-progress-card__step-dot" aria-hidden="true"></span>
                    <span class="assistant-progress-card__step-title">${this.escapeHtml(step.title)}</span>
                    <span class="assistant-progress-card__step-state sr-only">${this.escapeHtml(stateLabel)}</span>
                </li>
            `;
        }).join('');

        return `
            <div class="assistant-progress-card assistant-progress-card--reasoning${isStreaming ? ' is-live' : ''}">
                <div class="assistant-progress-card__surface" aria-live="polite">
                    <div class="assistant-progress-card__reasoning">
                        <span class="assistant-progress-card__reasoning-icon" aria-hidden="true">
                            <i data-lucide="${this.escapeHtmlAttr(reasoningIcon)}" class="w-3.5 h-3.5"></i>
                        </span>
                        <span class="assistant-progress-card__copy">
                            <span class="assistant-progress-card__eyebrow">${this.escapeHtml(reasoningEyebrow)}</span>
                            <span class="assistant-progress-card__summary">${this.escapeHtml(reasoningText)}${reasoningAnimated ? '<span class="streaming-cursor" aria-hidden="true"></span>' : ''}</span>
                        </span>
                    </div>
                    <ol class="assistant-progress-card__steps">${stepsHtml}</ol>
                </div>
            </div>
        `;
    }

    buildManagedAppProgressMarkup(message = null, isStreaming = false) {
        const progressState = this.getManagedAppProgressState(message);
        if (!progressState) {
            return '';
        }

        const isProjectSummary = message?.metadata?.managedAppProjectSummary === true
            || message?.managedAppProjectSummary === true;
        const checkpoint = this.getManagedAppCheckpoint(message);
        const checkpointState = message?.surveyState?.checkpointId === checkpoint?.id
            ? message.surveyState
            : null;
        const checkpointPending = checkpoint && checkpointState?.status !== 'answered';
        const lastSuccessfulStep = [...progressState.steps]
            .reverse()
            .find((step) => step.status === 'completed')
            || null;
        const liveBadge = progressState.terminal
            ? '<span class="assistant-progress-card__badge">Final</span>'
            : '<span class="assistant-progress-card__badge assistant-progress-card__badge--live"><span class="assistant-progress-card__pulse" aria-hidden="true"></span>Live</span>';
        const phaseMarkup = progressState.phaseLabel
            ? `<div class="assistant-progress-card__status-line"><span class="assistant-progress-card__status-label">Stage</span><span class="assistant-progress-card__status-value">${this.escapeHtml(progressState.phaseLabel)}</span></div>`
            : '';
        const lastSuccessfulMarkup = lastSuccessfulStep
            ? `<div class="assistant-progress-card__status-line"><span class="assistant-progress-card__status-label">Last Done</span><span class="assistant-progress-card__status-value">${this.escapeHtml(lastSuccessfulStep.title)}</span></div>`
            : '';
        const expectedHostMarkup = progressState.expectedHost
            ? `<div class="assistant-progress-card__status-line"><span class="assistant-progress-card__status-label">Host</span><span class="assistant-progress-card__status-value">${this.escapeHtml(progressState.expectedHost)}</span></div>`
            : '';
        const ingressStatusMarkup = progressState.ingressStatus
            ? `<div class="assistant-progress-card__status-line"><span class="assistant-progress-card__status-label">Ingress</span><span class="assistant-progress-card__status-value">${this.escapeHtml(progressState.ingressStatus)}</span></div>`
            : '';
        const tlsStatusMarkup = progressState.tlsStatus
            ? `<div class="assistant-progress-card__status-line"><span class="assistant-progress-card__status-label">TLS</span><span class="assistant-progress-card__status-value">${this.escapeHtml(progressState.tlsStatus)}</span></div>`
            : '';
        const httpsStatusMarkup = progressState.httpsStatus
            ? `<div class="assistant-progress-card__status-line"><span class="assistant-progress-card__status-label">HTTPS</span><span class="assistant-progress-card__status-value">${this.escapeHtml(progressState.httpsStatus)}</span></div>`
            : '';
        const appProbeStatusMarkup = progressState.appProbeStatus
            ? `<div class="assistant-progress-card__status-line"><span class="assistant-progress-card__status-label">App Probe</span><span class="assistant-progress-card__status-value">${this.escapeHtml(progressState.appProbeStatus)}</span></div>`
            : '';
        const evidenceRows = [
            ['Repo', progressState.evidence?.repository, progressState.evidence?.repoUrl],
            ['Commit', progressState.evidence?.commitSha, ''],
            ['Pipeline', progressState.evidence?.pipelineStatus || progressState.evidence?.pipelineUrl, progressState.evidence?.pipelineUrl],
            ['Image', progressState.evidence?.imageTag, ''],
            ['Deploy', progressState.evidence?.deployStatus, ''],
            ['Verify', progressState.evidence?.verificationStatus || progressState.evidence?.verifiedAt, progressState.evidence?.publicUrl],
        ].filter(([, value]) => value);
        const proof = progressState.evidence?.requiredProof || {};
        const proofLabels = [
            ['Source', proof.sourceChanged],
            ['GitLab', proof.gitlabPipelineObserved],
            ['Image', proof.imageAvailable],
            ['Deploy', proof.deploymentObserved],
            ['Public', proof.publicVerificationObserved],
        ];
        const evidenceMarkup = evidenceRows.length > 0
            ? `
                <details class="assistant-progress-card__evidence">
                    <summary>Evidence</summary>
                    <div class="assistant-progress-card__evidence-grid">
                        ${evidenceRows.map(([label, value, href]) => {
                            const safeValue = this.escapeHtml(value);
                            const valueMarkup = href && /^https?:\/\//i.test(href)
                                ? `<a href="${this.escapeHtmlAttr(href)}" target="_blank" rel="noopener noreferrer">${safeValue}</a>`
                                : safeValue;
                            return `<div><span>${this.escapeHtml(label)}</span><strong>${valueMarkup}</strong></div>`;
                        }).join('')}
                    </div>
                    <div class="assistant-progress-card__proof">
                        ${proofLabels.map(([label, ok]) => `<span class="${ok ? 'is-ok' : 'is-missing'}">${this.escapeHtml(label)}</span>`).join('')}
                    </div>
                </details>
            `
            : '';
        const nextActionsMarkup = progressState.nextActions?.length
            ? `<div class="assistant-progress-card__status-line"><span class="assistant-progress-card__status-label">Actions</span><span class="assistant-progress-card__status-value">${this.escapeHtml(progressState.nextActions.join(', '))}</span></div>`
            : '';
        const nextStepText = String(
            progressState.nextStep
            || message?.metadata?.nextStep
            || ''
        ).trim();
        const nextStepMarkup = nextStepText && !checkpointPending
            ? `<div class="assistant-progress-card__status-line"><span class="assistant-progress-card__status-label">Next</span><span class="assistant-progress-card__status-value">${this.escapeHtml(nextStepText)}</span></div>`
            : '';
        const pauseSummary = checkpointPending
            ? String(checkpoint?.preamble || '').trim()
            : '';
        const pausedMarkup = pauseSummary
            ? `<div class="assistant-progress-card__status-line"><span class="assistant-progress-card__status-label">Paused</span><span class="assistant-progress-card__status-value">${this.escapeHtml(pauseSummary)}</span></div>`
            : '';
        const resumeText = checkpointPending
            ? String(nextStepText || checkpoint?.question || '').trim()
            : '';
        const resumeMarkup = resumeText
            ? `<div class="assistant-progress-card__status-line"><span class="assistant-progress-card__status-label">Resume</span><span class="assistant-progress-card__status-value">${this.escapeHtml(resumeText)}</span></div>`
            : '';
        const openItems = Array.isArray(progressState.openItems)
            ? progressState.openItems.filter(Boolean).slice(0, 3)
            : [];
        const openItemsMarkup = openItems.length > 0
            ? `
                <div class="assistant-progress-card__open-items">
                    <div class="assistant-progress-card__status-label">Open Items</div>
                    <ul class="assistant-progress-card__open-list">
                        ${openItems.map((item) => `<li>${this.escapeHtml(item)}</li>`).join('')}
                    </ul>
                </div>
            `
            : '';
        const checkpointMarkup = checkpoint
            ? `
                <div class="assistant-progress-card__checkpoint">
                    ${this.renderSurveyBlock(checkpoint, {
                        ...message,
                        surveyState: checkpointState,
                    })}
                </div>
            `
            : '';
        const noteText = progressState.terminal
            ? (['build_failed', 'deploy_failed'].includes(progressState.phase)
                ? 'The managed app flow stopped before the site was fully live.'
                : 'The managed app flow finished with the latest deployment state.')
            : (isProjectSummary
                ? (checkpointPending
                    ? 'This project stays attached to this chat. Answer the checkpoint here to keep the same deployment flow moving.'
                    : 'This project stays attached to this chat and will keep this status as the current source of truth.')
                : 'Live deployment updates replace the previous build status in this bubble.');
        const stepsHtml = progressState.steps.map((step, index) => {
            const isActive = index === progressState.activeStepIndex;
            const stateLabel = ({
                completed: 'Done',
                in_progress: 'Working',
                failed: 'Failed',
                skipped: 'Skipped',
                pending: 'Pending',
            })[step.status] || 'Pending';

            return `
                <li class="assistant-progress-card__step assistant-progress-card__step--${step.status}${isActive ? ' is-active' : ''}">
                    <span class="assistant-progress-card__step-dot" aria-hidden="true"></span>
                    <span class="assistant-progress-card__step-title">${this.escapeHtml(step.title)}</span>
                    <span class="assistant-progress-card__step-state">${this.escapeHtml(stateLabel)}</span>
                </li>
            `;
        }).join('');

        return `
            <div class="assistant-progress-card assistant-progress-card--managed-app${progressState.live || isStreaming ? ' is-live' : ''}">
                <div class="assistant-progress-card__surface" aria-live="polite">
                    <div class="assistant-progress-card__header">
                        <div class="assistant-progress-card__copy">
                            <span class="assistant-progress-card__eyebrow">${isProjectSummary ? 'Project Status' : (progressState.terminal ? 'Build Status' : 'Build Progress')}</span>
                            <span class="assistant-progress-card__summary">${this.escapeHtml(progressState.summary)}</span>
                        </div>
                        ${liveBadge}
                    </div>
                    ${progressState.detail ? `<div class="assistant-progress-card__detail">${this.escapeHtml(progressState.detail)}</div>` : ''}
                    ${phaseMarkup}
                    ${lastSuccessfulMarkup}
                    ${expectedHostMarkup}
                    ${ingressStatusMarkup}
                    ${tlsStatusMarkup}
                    ${httpsStatusMarkup}
                    ${appProbeStatusMarkup}
                    ${nextActionsMarkup}
                    ${pausedMarkup}
                    ${resumeMarkup}
                    ${nextStepMarkup}
                    <div class="assistant-progress-card__bar" aria-hidden="true">
                        <span style="width:${progressState.percent}%"></span>
                    </div>
                    <ol class="assistant-progress-card__steps">${stepsHtml}</ol>
                    ${evidenceMarkup}
                    ${openItemsMarkup}
                    ${checkpointMarkup}
                    <div class="assistant-progress-card__note">${this.escapeHtml(noteText)}</div>
                </div>
            </div>
        `;
    }

    buildReasoningSummaryPreview(summary = '', maxLength = 140) {
        const normalized = this.extractDisplayText(summary).replace(/\s+/g, ' ').trim();
        if (!normalized) {
            return 'Reasoning data is available for this reply.';
        }

        if (normalized.length <= maxLength) {
            return normalized;
        }

        return `${normalized.slice(0, Math.max(32, maxLength - 1)).trimEnd()}…`;
    }

    buildReasoningRibbonMarkup(message = null, isStreaming = false) {
        const reasoningState = this.getMessageReasoningDisplayState(message, isStreaming);
        if (!reasoningState) {
            return '';
        }
        const previewHtml = `${this.escapeHtml(reasoningState.previewText || 'Reasoning data is available for this reply.')}${reasoningState.animated ? '<span class="streaming-cursor" aria-hidden="true"></span>' : ''}`;

        return `
            <div class="assistant-reasoning-ribbon${isStreaming ? ' is-live' : ''}${reasoningState.source === 'generated' ? ' is-synthetic' : ''}">
                <div class="assistant-reasoning-ribbon__surface" aria-live="polite">
                    <span class="assistant-reasoning-ribbon__main">
                        <span class="assistant-reasoning-ribbon__icon" aria-hidden="true">
                            <i data-lucide="${reasoningState.icon}" class="w-3.5 h-3.5"></i>
                        </span>
                        <span class="assistant-reasoning-ribbon__copy">
                            <span class="assistant-reasoning-ribbon__title">${this.escapeHtml(reasoningState.title)}</span>
                            <span class="assistant-reasoning-ribbon__preview${reasoningState.source === 'generated' ? ' assistant-reasoning-ribbon__preview--synthetic' : ''}">${previewHtml}</span>
                        </span>
                    </span>
                    <span class="assistant-reasoning-ribbon__meta">
                        <span class="assistant-reasoning-ribbon__badge${reasoningState.live ? ' assistant-reasoning-ribbon__badge--live' : ''}">
                            ${reasoningState.live ? '<span class="assistant-reasoning-ribbon__pulse" aria-hidden="true"></span>Live' : 'History'}
                        </span>
                    </span>
                </div>
            </div>
        `;
    }

    buildStreamingPlaceholderMarkup(message = null) {
        const meta = this.getLivePhaseMeta(message?.liveState?.phase || 'thinking');
        const detail = this.extractDisplayText(message?.liveState?.detail || meta.detail || '', { maxLength: 180 });

        return `
            <div class="assistant-stream-placeholder" aria-live="polite">
                <div class="assistant-stream-placeholder__header">
                    <span class="assistant-stream-placeholder__phase">
                        <span class="assistant-stream-placeholder__phase-icon" aria-hidden="true">
                            <i data-lucide="${meta.icon}" class="w-3.5 h-3.5"></i>
                        </span>
                        <span>${this.escapeHtml(meta.label)}</span>
                    </span>
                    ${detail ? `<span class="assistant-stream-placeholder__detail">${this.escapeHtml(detail)}</span>` : ''}
                </div>
                <div class="assistant-stream-placeholder__lines" aria-hidden="true">
                    <span class="assistant-stream-placeholder__line assistant-stream-placeholder__line--lg"></span>
                    <span class="assistant-stream-placeholder__line assistant-stream-placeholder__line--md"></span>
                    <span class="assistant-stream-placeholder__line assistant-stream-placeholder__line--sm"></span>
                </div>
            </div>
        `;
    }

    buildAssistantRenderPlan(messageOrContent, isStreaming = false) {
        const message = messageOrContent && typeof messageOrContent === 'object'
            ? messageOrContent
            : { content: messageOrContent };
        const effectiveStreaming = isStreaming === true || message?.isStreaming === true;
        const content = this.resolveAssistantVisibleContent(message);
        const managedAppProgress = this.buildManagedAppProgressMarkup(message, effectiveStreaming);
        const progressTracker = this.buildProgressTrackerMarkup(message, effectiveStreaming);
        const reasoningRibbon = progressTracker
            ? ''
            : this.buildReasoningRibbonMarkup(message, effectiveStreaming);
        const isManagedAppProjectSummary = message?.metadata?.managedAppProjectSummary === true
            || message?.managedAppProjectSummary === true;
        const shouldShowStreamingPlaceholder = effectiveStreaming
            && !managedAppProgress
            && !progressTracker
            && !reasoningRibbon;
        if (isManagedAppProjectSummary && managedAppProgress) {
            return {
                html: `${managedAppProgress}${progressTracker}${reasoningRibbon}`,
                variant: 'default',
            };
        }
        if (!content) {
            return {
                html: `${managedAppProgress}${progressTracker}${reasoningRibbon || (shouldShowStreamingPlaceholder ? this.buildStreamingPlaceholderMarkup(message) : '')}`,
                variant: 'default',
            };
        }

        const modelNormalizedContent = window.KimiBuiltModelOutputParser?.normalizeModelOutputMarkdown
            ? window.KimiBuiltModelOutputParser.normalizeModelOutputMarkdown(content, { model: message?.model || '' })
            : content;
        const surveyRenderPlan = this.buildSurveyRenderPlan(modelNormalizedContent, message);
        const baseNormalizedMarkdown = this.normalizeInlineHtmlAssistantMarkdown(
            this.normalizeStructuredAssistantMarkdown(surveyRenderPlan.markdown),
        );
        const normalizedMarkdown = window.KimiBuiltModelOutputParser?.normalizePresentationMarkupMarkdown
            ? window.KimiBuiltModelOutputParser.normalizePresentationMarkupMarkdown(baseNormalizedMarkdown)
            : baseNormalizedMarkdown;

        if (this.looksLikeAgentBrief(normalizedMarkdown, message)) {
            const sections = this.buildAgentBriefSections(normalizedMarkdown);
            const introHtml = sections.intro
                ? this.sanitizeAssistantHtml(marked.parse(sections.intro))
                : '';
            const bodyHtml = this.enhancePresentationCallouts(this.sanitizeAssistantHtml(marked.parse(sections.bodyMarkdown)));
            const footerHtml = sections.footer
                ? `<div class="agent-brief-card__footer">
                        <div class="agent-brief-card__hint">Next move</div>
                        <div class="agent-brief-card__next">${this.escapeHtml(sections.footer)}</div>
                    </div>`
                : '';
            let html = `
                <div class="agent-brief-card">
                    <div class="agent-brief-card__eyebrow">${message?.agentExecutor === true || message?.metadata?.agentExecutor === true ? 'Agent Result' : 'Structured Reply'}</div>
                    ${sections.title ? `
                    <div class="agent-brief-card__title-row">
                        <h3 class="agent-brief-card__title">${this.escapeHtml(sections.title)}</h3>
                        ${(message?.agentExecutor === true || message?.metadata?.agentExecutor === true)
                            ? '<span class="agent-brief-card__badge">Autonomous</span>'
                            : ''}
                    </div>
                    ` : ''}
                    ${introHtml ? `<div class="agent-brief-card__intro">${introHtml}</div>` : ''}
                    <div class="agent-brief-card__body">${bodyHtml}</div>
                    ${footerHtml}
                </div>
            `;

            if (effectiveStreaming) {
                html += '<span class="streaming-cursor" aria-hidden="true"></span>';
            }

            return {
                html: `${managedAppProgress}${progressTracker}${reasoningRibbon}${html}`,
                variant: 'agent-brief',
            };
        }

        let html = this.enhancePresentationCallouts(this.sanitizeAssistantHtml(marked.parse(normalizedMarkdown)));
        html = this.replaceSurveyRenderTokens(html, surveyRenderPlan.surveys);

        if (effectiveStreaming) {
            html += '<span class="streaming-cursor" aria-hidden="true"></span>';
        }

        return {
            html: `${managedAppProgress}${progressTracker}${reasoningRibbon}${html}`,
            variant: 'default',
        };
    }

    renderMessage(message, isStreaming = false) {
        if (message.type === 'unsplash-search') {
            return this.renderUnsplashSearchMessage(message);
        }

        if (message.type === 'search-results') {
            return this.renderSearchResultsMessage(message);
        }

        if (message.type === 'research-sources') {
            return this.renderResearchSourcesMessage(message);
        }

        if (message.type === 'image-selection') {
            return this.renderImageSelectionMessage(message);
        }

        if (message.type === 'artifact-gallery') {
            return this.renderArtifactGalleryMessage(message);
        }

        // Handle image messages
        if (message.type === 'image' || message.imageUrl) {
            return this.renderImageMessage(message);
        }
        
        const isUser = message.role === 'user';
        const effectiveStreaming = !isUser && (isStreaming === true || message?.isStreaming === true);
        const messageId = message.id || this.generateMessageId();
        
        const messageEl = document.createElement('div');
        messageEl.className = `message ${isUser ? 'user' : 'assistant'}`;
        messageEl.id = messageId;
        messageEl.dataset.messageId = messageId;
        if (message.timestamp) {
            messageEl.dataset.messageTimestamp = String(message.timestamp);
        }
        
        // Add ARIA attributes for accessibility
        messageEl.setAttribute('role', 'article');
        messageEl.setAttribute('aria-label', `${isUser ? 'Your message' : 'Assistant response'}`);

        const avatar = isUser
            ? `<div class="message-avatar user" aria-hidden="true"><i data-lucide="user" class="w-4 h-4"></i></div>`
            : this.buildAssistantAvatarMarkup(message, effectiveStreaming);

        const renderedContent = isUser ? 
            message.content :
            this.resolveAssistantVisibleContent(message);

        const inlineArtifacts = message.type !== 'artifact-gallery' && Array.isArray(message.artifacts)
            ? message.artifacts.filter((artifact) => artifact?.id && artifact?.downloadUrl)
            : [];
        const inlineArtifactMarkup = inlineArtifacts.length > 0
            ? `
                <div class="message-generated-artifacts">
                    <div class="message-selection-panel">
                        <div class="selection-panel-info">
                            <div class="icon" aria-hidden="true">
                                <i data-lucide="files" class="w-3.5 h-3.5"></i>
                            </div>
                            <span class="text">${isUser ? 'Files attached' : 'Files ready'}</span>
                            <span class="meta">${inlineArtifacts.length} item${inlineArtifacts.length === 1 ? '' : 's'}</span>
                        </div>
                        ${window.artifactManager?.buildGalleryMarkup?.(inlineArtifacts) || ''}
                    </div>
                </div>
            `
            : '';
        const assistantRenderPlan = isUser
            ? null
            : this.buildAssistantRenderPlan(message, effectiveStreaming);
        const content = isUser ? 
            this.renderUserMessage(renderedContent, message) :
            assistantRenderPlan.html;
        const messageTextClass = isUser
            ? ''
            : `markdown-content${assistantRenderPlan?.variant === 'agent-brief' ? ' message-text--agent-brief' : ''}`;

        if (assistantRenderPlan?.variant === 'agent-brief') {
            messageEl.classList.add('message--agent-brief');
        }

        messageEl.classList.toggle('message--streaming', effectiveStreaming);
        messageEl.classList.toggle('message--has-reasoning', !isUser && this.hasMessageReasoning(message, effectiveStreaming));
        if (!isUser) {
            if (message?.liveState?.phase) {
                messageEl.dataset.livePhase = String(message.liveState.phase).trim();
            } else {
                delete messageEl.dataset.livePhase;
            }
        }

        const time = this.formatTime(message.timestamp);
        const fullTimestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : '';

        messageEl.innerHTML = `
            ${!isUser ? avatar : ''}
            <div class="message-content">
                <div class="message-header">
                    <span class="message-author">${isUser ? 'You' : 'Assistant'}</span>
                    <span class="message-time" title="${fullTimestamp}">${time}</span>
                    <div class="message-actions">
                        <button class="message-action-btn" onclick="uiHelpers.copyMessage('${messageId}')" title="Copy message" aria-label="Copy message to clipboard">
                            <i data-lucide="copy" class="w-4 h-4" aria-hidden="true"></i>
                        </button>
                        ${!isUser ? `
                        ${this.buildMessageSpeechButtonMarkup(messageId, message)}
                        ${this.buildAlignmentFeedbackButtonsMarkup(messageId, message)}
                        <button class="message-action-btn" onclick="uiHelpers.regenerateMessage('${messageId}')" title="Regenerate response" aria-label="Regenerate response">
                            <i data-lucide="refresh-cw" class="w-4 h-4" aria-hidden="true"></i>
                        </button>
                        ` : ''}
                    </div>
                </div>
                <div class="message-text ${messageTextClass}">
                    ${content}
                </div>
                ${inlineArtifactMarkup}
            </div>
            ${isUser ? avatar : ''}
        `;

        if (!isUser) {
            this.highlightCodeBlocks(messageEl);
            this.renderHtmlPreviews(messageEl);
            this.renderMermaidDiagrams(messageEl);
        }

        return messageEl;
    }

    renderUserMessage(content, message = {}) {
        const bodyHtml = this.escapeHtml(content);
        const brief = this.normalizeBuildRunBrief(message?.metadata?.buildRunBrief);
        return brief ? `${bodyHtml}${this.buildUserBuildBriefMarkup(brief)}` : bodyHtml;
    }

    normalizeBuildRunBrief(value = null) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return null;
        }

        const summary = this.clipDisplayTextAtBoundary(value.summary || value.goal || '', 96);
        const lane = this.clipDisplayTextAtBoundary(value.lane || '', 48);
        const output = this.clipDisplayTextAtBoundary(value.output || value.outputType || '', 48);
        const source = this.clipDisplayTextAtBoundary(value.source || value.sources || '', 64);
        const checks = Array.isArray(value.checks)
            ? value.checks
                .map((check) => this.clipDisplayTextAtBoundary(check, 42))
                .filter(Boolean)
                .slice(0, 3)
            : [];

        if (!summary && !lane && !output && checks.length === 0) {
            return null;
        }

        return {
            version: 1,
            summary,
            lane: lane || 'Create/build',
            output: output || 'Working artifact',
            source,
            checks,
        };
    }

    inferBuildRunBrief(content = '', options = {}) {
        const text = String(content || '').replace(/\s+/g, ' ').trim();
        if (!text || text.startsWith('/')) {
            return null;
        }

        const normalized = text.toLowerCase();
        const hasAction = /\b(create|make|generate|build|draft|design|implement|improve|update|fix|deploy|publish|launch|export|render|convert|rebuild|polish|prototype)\b/.test(normalized);
        const hasTarget = /\b(artifact|file|document|doc|pdf|report|brief|deck|slides?|pptx|spreadsheet|xlsx|csv|markdown|html|website|webpage|web page|site|frontend|front-end|ui|dashboard|app|application|component|sandbox|preview|game|browser game|web game|image|picture|photo|video|podcast|audio|skill|plugin|workflow|remote|server|gitlab|pipeline|k3s|kubernetes|cluster|ingress|live|hosted)\b/.test(normalized);
        const artifactIds = Array.isArray(options.artifactIds)
            ? options.artifactIds.map((id) => String(id || '').trim()).filter(Boolean)
            : [];
        const hasExistingSourceCue = /\b(previous|earlier|prior|old|older|existing|uploaded|attached|generated|saved|that file|that artifact|same file|last one|last version)\b/.test(normalized);
        const outputFormat = String(options.outputFormat || options.metadata?.outputFormat || '').trim().toLowerCase();

        if (!hasAction || (!hasTarget && !hasExistingSourceCue && artifactIds.length === 0 && !outputFormat)) {
            return null;
        }

        let lane = 'Create/build';
        if (/\b(remote|server|gitlab|pipeline|k3s|kubernetes|cluster|ingress|live|hosted|production|deploy|publish|launch)\b/.test(normalized)) {
            lane = 'Remote build/deploy';
        } else if (hasExistingSourceCue || artifactIds.length > 0) {
            lane = 'Improve existing artifact';
        } else if (/\b(pdf|document|doc|report|brief|deck|slides?|pptx|spreadsheet|xlsx|csv|markdown|export)\b/.test(normalized) || ['pdf', 'pptx', 'xlsx', 'markdown'].includes(outputFormat)) {
            lane = 'Document/export';
        } else if (/\b(website|webpage|web page|site|frontend|front-end|ui|dashboard|app|component|sandbox|preview|game|browser game|web game|html)\b/.test(normalized) || outputFormat === 'html') {
            lane = 'Sandbox/front-end build';
        } else if (/\b(image|picture|photo|video|podcast|audio)\b/.test(normalized)) {
            lane = 'Media creation';
        } else if (/\b(skill|plugin|workflow)\b/.test(normalized)) {
            lane = 'Skill/workflow';
        }

        let output = 'Working artifact';
        if (lane === 'Remote build/deploy') {
            output = 'Live route or deployment proof';
        } else if (lane === 'Improve existing artifact') {
            output = 'Updated artifact';
        } else if (lane === 'Document/export') {
            output = outputFormat ? outputFormat.toUpperCase() : 'Exportable document';
        } else if (lane === 'Sandbox/front-end build') {
            output = 'Previewable sandbox';
        } else if (lane === 'Media creation') {
            output = 'Generated media artifact';
        } else if (lane === 'Skill/workflow') {
            output = 'Reusable skill/workflow';
        }

        const checks = [];
        if (lane === 'Sandbox/front-end build') {
            checks.push('Preview opens', 'No layout overflow', 'Artifact links persist');
        } else if (lane === 'Remote build/deploy') {
            checks.push('Rollout proof', 'Public route check', 'UI smoke pass');
        } else if (lane === 'Document/export') {
            checks.push('Readable export', 'Page/render check', 'Artifact links persist');
        } else if (lane === 'Improve existing artifact') {
            checks.push('Source reused', 'Updated output saved', 'Preview/link preserved');
        } else {
            checks.push('Artifact saved', 'Result is inspectable');
        }

        return {
            version: 1,
            summary: this.clipDisplayTextAtBoundary(text, 96),
            lane,
            output,
            source: artifactIds.length > 0 ? `${artifactIds.length} selected artifact${artifactIds.length === 1 ? '' : 's'}` : '',
            checks,
        };
    }

    buildUserBuildBriefMarkup(brief = {}) {
        const checks = Array.isArray(brief.checks) ? brief.checks.filter(Boolean).slice(0, 3) : [];
        return `
            <div class="user-build-brief" aria-label="Build request summary">
                <div class="user-build-brief__header">
                    <i data-lucide="route" class="w-3.5 h-3.5" aria-hidden="true"></i>
                    <span>Build brief</span>
                </div>
                ${brief.summary ? `<div class="user-build-brief__summary">${this.escapeHtml(brief.summary)}</div>` : ''}
                <div class="user-build-brief__meta">
                    <span><strong>Lane</strong>${this.escapeHtml(brief.lane)}</span>
                    <span><strong>Output</strong>${this.escapeHtml(brief.output)}</span>
                    ${brief.source ? `<span><strong>Source</strong>${this.escapeHtml(brief.source)}</span>` : ''}
                </div>
                ${checks.length > 0 ? `
                    <div class="user-build-brief__checks">
                        ${checks.map((check) => `<span>${this.escapeHtml(check)}</span>`).join('')}
                    </div>
                ` : ''}
            </div>
        `;
    }

    renderAssistantMessage(messageOrContent, isStreaming = false) {
        return this.buildAssistantRenderPlan(messageOrContent, isStreaming).html;
    }

    toggleReasoningSummary(messageId = '') {
        const normalizedMessageId = String(messageId || '').trim();
        if (!normalizedMessageId) {
            return;
        }

        if (this.expandedReasoningMessageIds.has(normalizedMessageId)) {
            this.expandedReasoningMessageIds.delete(normalizedMessageId);
        } else {
            this.expandedReasoningMessageIds.add(normalizedMessageId);
        }

        const sessionId = window.sessionManager?.currentSessionId || null;
        const message = typeof window.sessionManager?.getMessage === 'function'
            ? window.sessionManager.getMessage(sessionId, normalizedMessageId)
            : window.sessionManager?.getMessages?.(sessionId)?.find((entry) => entry.id === normalizedMessageId);
        const existing = document.getElementById(normalizedMessageId);
        if (!message || !existing) {
            return;
        }

        const nextMessageEl = this.renderMessage(message, message.isStreaming === true);
        existing.replaceWith(nextMessageEl);
        this.reinitializeIcons(nextMessageEl);
    }

    toggleSurveyOption(button) {
        const optionButton = button?.closest?.('.agent-survey-option');
        const card = optionButton?.closest?.('.agent-survey-card');
        if (!optionButton || !card || card.dataset.submitted === 'true') {
            return;
        }

        const allOptions = Array.from(card.querySelectorAll('.agent-survey-option'));
        const allowMultiple = card.dataset.stepAllowMultiple === 'true';
        const maxSelections = Math.max(1, Number(card.dataset.stepMaxSelections) || 1);
        const isSelected = optionButton.classList.contains('is-selected');

        if (!allowMultiple) {
            allOptions.forEach((entry) => {
                entry.classList.remove('is-selected');
                entry.setAttribute('aria-checked', 'false');
            });
            optionButton.classList.add('is-selected');
            optionButton.setAttribute('aria-checked', 'true');
        } else {
            if (!isSelected) {
                const selectedCount = allOptions.filter((entry) => entry.classList.contains('is-selected')).length;
                if (selectedCount >= maxSelections) {
                    this.showToast(`Choose up to ${maxSelections} option${maxSelections === 1 ? '' : 's'}`, 'info');
                    return;
                }
            }

            optionButton.classList.toggle('is-selected', !isSelected);
            optionButton.setAttribute('aria-checked', isSelected ? 'false' : 'true');
        }

        const customOptionId = this.getSurveyCustomOption().id;
        if (String(optionButton.dataset.optionId || '').trim() === customOptionId) {
            card.querySelector('.agent-survey-card__notes')?.focus();
        }

        this.updateSurveySubmitState(card);
        this.playMenuCue('menu-select');
    }

    syncSurveyFreeText(input) {
        const notesField = input?.closest?.('.agent-survey-card__notes') || input;
        const card = notesField?.closest?.('.agent-survey-card');
        if (!notesField || !card || card.dataset.submitted === 'true') {
            return;
        }

        const customOptionId = this.getSurveyCustomOption().id;
        const customOption = card.querySelector(`.agent-survey-option[data-option-id="${customOptionId}"]`);
        if (!customOption) {
            this.updateSurveySubmitState(card);
            return;
        }

        const notes = String(notesField.value || '').trim();
        const hasAnySelection = Array.from(card.querySelectorAll('.agent-survey-option'))
            .some((entry) => entry.classList.contains('is-selected'));

        if (notes && !hasAnySelection) {
            customOption.classList.add('is-selected');
            customOption.setAttribute('aria-checked', 'true');
        }

        this.updateSurveySubmitState(card);
    }

    renderImageMessage(message) {
        const messageId = message.id || this.generateMessageId();
        const time = this.formatTime(message.timestamp);
        const fullTimestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : '';
        
        const isLoading = message.isLoading;
        const imageUrl = message.imageUrl;
        const revisedPrompt = message.revisedPrompt;
        const prompt = message.prompt;
        const source = message.source || 'generated';
        const isUnsplash = source === 'unsplash';
        const isArtifact = source === 'artifact';
        const downloadableUrl = message.downloadUrl || imageUrl;
        const shareableUrl = message.downloadUrl || imageUrl;
        const fallbackImageUrl = downloadableUrl && downloadableUrl !== imageUrl ? downloadableUrl : '';
        const downloadFilename = this.sanitizeDownloadFilename(
            message.filename || prompt || 'generated-image.png',
            'generated-image',
            'png',
        );
        
        const messageEl = document.createElement('div');
        messageEl.className = 'message assistant';
        messageEl.id = messageId;
        messageEl.dataset.messageId = messageId;
        messageEl.setAttribute('role', 'article');
        messageEl.setAttribute('aria-label', isUnsplash ? 'Unsplash image' : (isArtifact ? 'Captured image' : 'Generated image'));
        
        // Build attribution for Unsplash images
        let attributionHtml = '';
        if (isUnsplash && message.author) {
            attributionHtml = `
                <div class="image-attribution">
                    Photo by <a href="${message.author.link}?utm_source=lillybuilt&utm_medium=referral" target="_blank" rel="noopener">${this.escapeHtml(message.author.name)}</a> on 
                    <a href="${message.unsplashLink}?utm_source=lillybuilt&utm_medium=referral" target="_blank" rel="noopener">Unsplash</a>
                </div>
            `;
        }
        
        const imageHtml = isLoading ? `
            <div class="image-container loading" aria-busy="true" aria-label="Generating image">
                <div class="image-loading-indicator">
                    <div class="spinner" role="progressbar" aria-valuemin="0" aria-valuemax="100"></div>
                    <span class="text">${message.loadingText || 'Generating image...'}</span>
                </div>
            </div>
        ` : `
            <div class="image-container">
                <img src="${this.escapeHtmlAttr(imageUrl)}" alt="${this.escapeHtmlAttr(prompt || 'Image')}" 
                     ${fallbackImageUrl ? `data-fallback-src="${this.escapeHtmlAttr(fallbackImageUrl)}"` : ''}
                     onclick="uiHelpers.openImageLightbox('${this.escapeHtmlAttr(imageUrl)}')" 
                     onload="uiHelpers.scrollToBottom()"
                     onerror="uiHelpers.handleImageLoadError(this)"
                     referrerpolicy="no-referrer"
                     loading="lazy">
            </div>
            ${attributionHtml}
            ${revisedPrompt ? `
                <div class="image-revised-prompt">
                    <div class="label">Revised Prompt</div>
                    <div>${this.escapeHtml(revisedPrompt)}</div>
                </div>
            ` : ''}
            <div class="image-actions">
                <button class="image-action-btn" onclick="uiHelpers.downloadImage('${this.escapeHtmlAttr(downloadableUrl)}', '${this.escapeHtmlAttr(downloadFilename)}')" aria-label="Download image">
                    <i data-lucide="download" class="w-4 h-4" aria-hidden="true"></i>
                    <span>Download</span>
                </button>
                <button class="image-action-btn" onclick="uiHelpers.copyImageUrl('${this.escapeHtmlAttr(shareableUrl)}')" aria-label="Copy image URL">
                    <i data-lucide="link" class="w-4 h-4" aria-hidden="true"></i>
                    <span>Copy URL</span>
                </button>
                ${isUnsplash ? `
                <button class="image-action-btn" onclick="window.open('${message.unsplashLink}?utm_source=lillybuilt&utm_medium=referral', '_blank')" aria-label="View on Unsplash">
                    <i data-lucide="external-link" class="w-4 h-4" aria-hidden="true"></i>
                    <span>View on Unsplash</span>
                </button>
                ` : ''}
            </div>
        `;
        
        const sourceIcon = isUnsplash ? 'camera' : (isArtifact ? 'scan-search' : 'sparkles');
        const sourceText = isUnsplash ? 'Unsplash' : (isArtifact ? (message.sourceHost || 'Artifact capture') : (message.model || 'Generated'));
        const sourceLabel = isUnsplash ? 'Stock Photo' : (isArtifact ? 'Captured Image' : 'Generated Image');
        const authorLabel = isUnsplash ? 'Unsplash' : (isArtifact ? 'Captured Image' : 'AI Image Generator');
        
        messageEl.innerHTML = `
            <div class="message-avatar assistant" aria-hidden="true">
                <i data-lucide="${isUnsplash ? 'camera' : (isArtifact ? 'images' : 'image')}" class="w-4 h-4"></i>
            </div>
            <div class="message-content">
                <div class="message-header">
                    <span class="message-author">${authorLabel}</span>
                    <span class="message-time" title="${fullTimestamp}">${time}</span>
                    <div class="message-actions">
                        ${!isLoading ? `
                        <button class="message-action-btn" onclick="uiHelpers.copyMessage('${messageId}')" title="Copy prompt" aria-label="Copy prompt">
                            <i data-lucide="copy" class="w-4 h-4" aria-hidden="true"></i>
                        </button>
                        ` : ''}
                    </div>
                </div>
                <div class="message-image">
                    <div class="image-generation-info">
                        <div class="icon" aria-hidden="true">
                            <i data-lucide="${sourceIcon}" class="w-3.5 h-3.5"></i>
                        </div>
                        <span class="text">${sourceLabel}</span>
                        <span class="meta">${sourceText}</span>
                    </div>
                    ${prompt ? `<p class="text-sm text-text-secondary mb-3">"${this.escapeHtml(prompt)}"</p>` : ''}
                    ${imageHtml}
                </div>
            </div>
        `;
        
        return messageEl;
    }

    /**
     * Render an Unsplash search results message
     * @param {Object} message - The search message data
     * @returns {HTMLElement} - The rendered message element
     */
    renderUnsplashSearchMessage(message) {
        const messageId = message.id || this.generateMessageId();
        const time = this.formatTime(message.timestamp);
        const fullTimestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : '';
        
        const isLoading = message.isLoading;
        const query = message.query;
        const results = message.results || [];
        const total = message.total || 0;
        const currentPage = Math.max(1, Number(message.currentPage) || 1);
        const totalPages = Math.max(1, Number(message.totalPages) || 1);
        const error = message.error;
        
        const messageEl = document.createElement('div');
        messageEl.className = 'message assistant';
        messageEl.id = messageId;
        messageEl.dataset.messageId = messageId;
        messageEl.setAttribute('role', 'article');
        messageEl.setAttribute('aria-label', 'Unsplash search results');
        
        let contentHtml = '';
        
        if (isLoading) {
            contentHtml = `
                <div class="unsplash-search-loading" aria-busy="true">
                    <div class="spinner" role="progressbar" aria-valuemin="0" aria-valuemax="100"></div>
                    <span class="text">${message.loadingText || 'Searching Unsplash...'}</span>
                </div>
            `;
        } else if (error) {
            contentHtml = `
                <div class="unsplash-search-error">
                    <i data-lucide="alert-circle" class="w-5 h-5" aria-hidden="true"></i>
                    <span>${this.escapeHtml(error)}</span>
                </div>
            `;
        } else if (results.length > 0) {
            contentHtml = `
                <div class="unsplash-search-results">
                    <div class="unsplash-results-header">
                        <span class="unsplash-results-count">${results.length} of ${total} results</span>
                        <span class="unsplash-results-hint">Click an image to add it to the conversation</span>
                    </div>
                    <div class="unsplash-results-grid">
                        ${results.map((image, index) => `
                            <button type="button"
                                 class="unsplash-result-item"
                                 onclick="app.selectUnsplashImage('${messageId}', ${index})"
                                 aria-label="${this.escapeHtmlAttr(`Select image by ${image.author ? image.author.name : 'Unknown'}`)}"
                                 title="${this.escapeHtmlAttr(`Photo by ${image.author ? image.author.name : 'Unknown'} - Click to select`)}">
                                <img src="${this.escapeHtmlAttr(image.urls.small)}"
                                     alt="${this.escapeHtmlAttr(image.altDescription || image.description || 'Unsplash image')}" 
                                     onerror="uiHelpers.handleImageLoadError(this)"
                                     referrerpolicy="no-referrer"
                                     loading="lazy">
                                <div class="unsplash-result-overlay">
                                    <span class="unsplash-result-author">${image.author ? this.escapeHtml(image.author.name) : 'Unknown'}</span>
                                </div>
                            </button>
                        `).join('')}
                    </div>
                    ${totalPages > 1 ? `
                    <div class="selection-pagination">
                        <button type="button"
                            class="selection-action-btn"
                            onclick="app.loadUnsplashPage('${messageId}', ${currentPage - 1})"
                            ${currentPage <= 1 ? 'disabled' : ''}>
                            Previous
                        </button>
                        <span class="selection-pagination-label">Page ${currentPage} of ${totalPages}</span>
                        <button type="button"
                            class="selection-action-btn"
                            onclick="app.loadUnsplashPage('${messageId}', ${currentPage + 1})"
                            ${currentPage >= totalPages ? 'disabled' : ''}>
                            Next
                        </button>
                    </div>
                    ` : ''}
                </div>
            `;
        } else {
            contentHtml = `
                <div class="unsplash-search-empty">
                    <i data-lucide="search-x" class="w-8 h-8" aria-hidden="true"></i>
                    <p>No images found for "${this.escapeHtml(query)}"</p>
                </div>
            `;
        }
        
        messageEl.innerHTML = `
            <div class="message-avatar assistant" aria-hidden="true">
                <i data-lucide="search" class="w-4 h-4"></i>
            </div>
            <div class="message-content">
                <div class="message-header">
                    <span class="message-author">Unsplash Search</span>
                    <span class="message-time" title="${fullTimestamp}">${time}</span>
                </div>
                <div class="message-unsplash-search">
                    <div class="unsplash-search-info">
                        <div class="icon" aria-hidden="true">
                            <i data-lucide="camera" class="w-3.5 h-3.5"></i>
                        </div>
                        <span class="text">Stock Photos</span>
                    </div>
                    ${query ? `<p class="unsplash-search-query">"${this.escapeHtml(query)}"</p>` : ''}
                    ${contentHtml}
                </div>
            </div>
        `;
        
        return messageEl;
    }

    formatToolResultDate(value) {
        if (!value) {
            return '';
        }

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return '';
        }

        return date.toLocaleDateString();
    }

    buildResearchDropdownSummary({ icon = 'book-open', title = 'Research', meta = '', expandedLabel = 'source cards' } = {}) {
        const safeTitle = this.escapeHtml(title);
        const safeMeta = this.escapeHtml(meta);
        const safeExpandedLabel = this.escapeHtml(expandedLabel);

        return `
            <summary class="research-dropdown__summary">
                <span class="research-dropdown__summary-main">
                    <span class="research-dropdown__icon" aria-hidden="true">
                        <i data-lucide="${this.escapeHtmlAttr(icon)}" class="w-3.5 h-3.5"></i>
                    </span>
                    <span class="research-dropdown__copy">
                        <span class="research-dropdown__eyebrow">Research</span>
                        <span class="research-dropdown__title">${safeTitle}</span>
                        <span class="research-dropdown__hint">
                            <span class="research-dropdown__hint-collapsed">Click to expand ${safeExpandedLabel}</span>
                            <span class="research-dropdown__hint-expanded">Click this header again to shrink it back</span>
                        </span>
                    </span>
                </span>
                ${safeMeta ? `<span class="research-dropdown__meta">${safeMeta}</span>` : ''}
                <span class="research-dropdown__chevron" aria-hidden="true">
                    <i data-lucide="chevron-down" class="w-4 h-4"></i>
                </span>
            </summary>
        `;
    }

    renderSearchResultsMessage(message) {
        const messageId = message.id || this.generateMessageId();
        const time = this.formatTime(message.timestamp);
        const fullTimestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : '';
        const query = message.query || '';
        const results = Array.isArray(message.results) ? message.results : [];
        const interactive = message.interactive === true;

        const messageEl = document.createElement('div');
        messageEl.className = 'message assistant';
        messageEl.id = messageId;
        messageEl.dataset.messageId = messageId;
        messageEl.setAttribute('role', 'article');
        messageEl.setAttribute('aria-label', 'Candidate source pages');

        const contentHtml = results.length > 0
            ? `
                <div class="search-results-list">
                    ${results.map((result, index) => `
                        <div class="search-result-card">
                            <div class="search-result-topline">
                                <div class="search-result-title">${this.escapeHtml(result.title || result.url)}</div>
                                <div class="search-result-meta">
                                    ${result.source ? `<span>${this.escapeHtml(result.source)}</span>` : ''}
                                    ${this.formatToolResultDate(result.publishedAt) ? `<span>${this.escapeHtml(this.formatToolResultDate(result.publishedAt))}</span>` : ''}
                                </div>
                            </div>
                            <a class="search-result-url" href="${this.escapeHtmlAttr(result.url)}" target="_blank" rel="noopener noreferrer nofollow" title="${this.escapeHtmlAttr(result.url)}">${this.escapeHtml(this.truncatePreviewText(result.url, 88))}</a>
                            ${result.snippet ? `<p class="search-result-snippet">${this.escapeHtml(this.truncatePreviewText(result.snippet, 150))}</p>` : ''}
                            <div class="search-result-actions">
                                ${interactive ? `
                                <button type="button" class="selection-action-btn primary" onclick="app.useSearchResult('${messageId}', ${index})">
                                    Use This Page
                                </button>
                                ` : ''}
                                <button type="button" class="selection-action-btn" onclick="app.openSearchResult('${messageId}', ${index})">
                                    Open
                                </button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `
            : `
                <div class="unsplash-search-empty">
                    <i data-lucide="search-x" class="w-8 h-8" aria-hidden="true"></i>
                    <p>No candidate pages were returned.</p>
                </div>
            `;

        messageEl.innerHTML = `
            <div class="message-avatar assistant" aria-hidden="true">
                <i data-lucide="globe" class="w-4 h-4"></i>
            </div>
            <div class="message-content">
                <div class="message-header">
                    <span class="message-author">Research</span>
                    <span class="message-time" title="${fullTimestamp}">${time}</span>
                </div>
                <div class="message-selection-panel">
                    <details class="research-dropdown">
                        ${this.buildResearchDropdownSummary({
                            icon: 'globe',
                            title: `Research for: ${query || 'candidate pages'}`,
                            meta: `${results.length} ${results.length === 1 ? 'result' : 'results'}`,
                            expandedLabel: interactive ? 'page choices' : 'candidate pages',
                        })}
                        <div class="research-dropdown__body">
                            ${query ? `<p class="selection-panel-query">"${this.escapeHtml(query)}"</p>` : ''}
                            ${contentHtml}
                        </div>
                    </details>
                </div>
            </div>
        `;

        return messageEl;
    }

    renderResearchSourcesMessage(message) {
        const messageId = message.id || this.generateMessageId();
        const time = this.formatTime(message.timestamp);
        const fullTimestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : '';
        const query = message.query || '';
        const results = Array.isArray(message.results) ? message.results : [];

        const messageEl = document.createElement('div');
        messageEl.className = 'message assistant';
        messageEl.id = messageId;
        messageEl.dataset.messageId = messageId;
        messageEl.setAttribute('role', 'article');
        messageEl.setAttribute('aria-label', 'Verified source excerpts');

        const contentHtml = results.length > 0
            ? `
                <div class="search-results-list">
                    ${results.map((result) => `
                        <div class="search-result-card research-source-card">
                            <div class="search-result-topline">
                                <div class="search-result-title">${this.escapeHtml(result.title || result.url)}</div>
                                <div class="search-result-meta">
                                    ${result.source ? `<span>${this.escapeHtml(result.source)}</span>` : ''}
                                    ${this.formatToolResultDate(result.publishedAt) ? `<span>${this.escapeHtml(this.formatToolResultDate(result.publishedAt))}</span>` : ''}
                                    ${result.toolId ? `<span class="research-source-label">${this.escapeHtml(result.toolId)}</span>` : ''}
                                </div>
                            </div>
                            <a class="search-result-url" href="${this.escapeHtmlAttr(result.url)}" target="_blank" rel="noopener noreferrer nofollow" title="${this.escapeHtmlAttr(result.url)}">${this.escapeHtml(this.truncatePreviewText(result.url, 88))}</a>
                            ${result.snippet ? `<p class="search-result-snippet">${this.escapeHtml(this.truncatePreviewText(result.snippet, 140))}</p>` : ''}
                            ${result.excerpt ? `<div class="research-source-excerpt">${this.escapeHtml(this.truncatePreviewText(result.excerpt, 220))}</div>` : ''}
                            <div class="search-result-actions">
                                <button type="button" class="selection-action-btn" onclick="window.open('${this.escapeHtmlAttr(result.url)}', '_blank', 'noopener')">
                                    Open Source
                                </button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `
            : `
                <div class="unsplash-search-empty">
                    <i data-lucide="search-x" class="w-8 h-8" aria-hidden="true"></i>
                    <p>No verified source excerpts were returned.</p>
                </div>
            `;

        messageEl.innerHTML = `
            <div class="message-avatar assistant" aria-hidden="true">
                <i data-lucide="book-open" class="w-4 h-4"></i>
            </div>
            <div class="message-content">
                <div class="message-header">
                    <span class="message-author">Research</span>
                    <span class="message-time" title="${fullTimestamp}">${time}</span>
                </div>
                <div class="message-selection-panel">
                    <details class="research-dropdown">
                        ${this.buildResearchDropdownSummary({
                            icon: 'book-open',
                            title: `Research for: ${query || 'verified sources'}`,
                            meta: `${results.length} ${results.length === 1 ? 'source' : 'sources'}`,
                            expandedLabel: 'verified source cards',
                        })}
                        <div class="research-dropdown__body">
                            ${query ? `<p class="selection-panel-query">"${this.escapeHtml(query)}"</p>` : ''}
                            ${contentHtml}
                        </div>
                    </details>
                </div>
            </div>
        `;

        return messageEl;
    }

    renderImageSelectionMessage(message) {
        const messageId = message.id || this.generateMessageId();
        const time = this.formatTime(message.timestamp);
        const fullTimestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : '';
        const prompt = message.prompt || '';
        const results = Array.isArray(message.results) ? message.results : [];
        const model = message.model || '';
        const sourceKind = message.sourceKind || 'generated';
        const isArtifact = sourceKind === 'artifact';
        const sourceHost = message.sourceHost || '';

        const messageEl = document.createElement('div');
        messageEl.className = 'message assistant';
        messageEl.id = messageId;
        messageEl.dataset.messageId = messageId;
        messageEl.setAttribute('role', 'article');
        messageEl.setAttribute('aria-label', isArtifact ? 'Captured image choices' : 'Generated image choices');

        const contentHtml = results.length > 0
            ? `
                <div class="image-selection-grid">
                    ${results.map((image, index) => {
                        const imageSrc = image.thumbnailUrl || image.imageUrl || '';
                        const fallbackSrc = [image.imageUrl, image.downloadUrl]
                            .find((candidate) => candidate && candidate !== imageSrc) || '';
                        return `
                        <button type="button"
                            class="image-selection-item"
                            onclick="app.selectGeneratedImage('${messageId}', ${index})"
                            aria-label="Add image ${index + 1} to the conversation">
                            <img src="${this.escapeHtmlAttr(imageSrc)}"
                                ${fallbackSrc ? `data-fallback-src="${this.escapeHtmlAttr(fallbackSrc)}"` : ''}
                                alt="${this.escapeHtmlAttr(image.alt || prompt || (isArtifact ? 'Captured image' : 'Generated image'))}"
                                onerror="uiHelpers.handleImageLoadError(this)"
                                referrerpolicy="no-referrer"
                                loading="lazy">
                            ${image.filename || image.sourceHost ? `
                            <div class="image-selection-meta">
                                <span class="image-selection-caption">${this.escapeHtml(image.filename || image.alt || `Image ${index + 1}`)}</span>
                                ${image.sourceHost ? `<span class="image-selection-host">${this.escapeHtml(image.sourceHost)}</span>` : ''}
                            </div>
                            ` : ''}
                            <span class="image-selection-overlay">Add To Chat</span>
                        </button>
                    `;
                    }).join('')}
                </div>
            `
            : `
                <div class="unsplash-search-empty">
                    <i data-lucide="image-off" class="w-8 h-8" aria-hidden="true"></i>
                    <p>No ${isArtifact ? 'captured' : 'generated'} image options were returned.</p>
                </div>
            `;

        messageEl.innerHTML = `
            <div class="message-avatar assistant" aria-hidden="true">
                <i data-lucide="${isArtifact ? 'images' : 'image-plus'}" class="w-4 h-4"></i>
            </div>
            <div class="message-content">
                <div class="message-header">
                    <span class="message-author">${isArtifact ? 'Captured Images' : 'Image Options'}</span>
                    <span class="message-time" title="${fullTimestamp}">${time}</span>
                </div>
                <div class="message-selection-panel">
                    <div class="selection-panel-info">
                        <div class="icon ${isArtifact ? '' : 'accent-purple'}" aria-hidden="true">
                            <i data-lucide="${isArtifact ? 'scan-search' : 'sparkles'}" class="w-3.5 h-3.5"></i>
                        </div>
                        <span class="text">${isArtifact ? 'Choose a captured image' : 'Choose an image'}</span>
                        <span class="meta">${isArtifact ? (sourceHost || `${results.length} options`) : (model || `${results.length} options`)}</span>
                    </div>
                    ${prompt ? `<p class="selection-panel-query">"${this.escapeHtml(prompt)}"</p>` : ''}
                    ${results.length > 1 ? `
                        <div class="selection-panel-actions">
                            <button type="button" class="selection-action-btn" onclick="app.selectAllGeneratedImages('${messageId}')">
                                Add All To Chat
                            </button>
                        </div>
                    ` : ''}
                    ${contentHtml}
                </div>
            </div>
        `;

        return messageEl;
    }

    renderArtifactGalleryMessage(message) {
        const messageId = message.id || this.generateMessageId();
        const time = this.formatTime(message.timestamp);
        const fullTimestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : '';
        const artifacts = Array.isArray(message.artifacts) ? message.artifacts : [];
        const galleryMarkup = window.artifactManager?.buildGalleryMarkup?.(artifacts) || '';

        const messageEl = document.createElement('div');
        messageEl.className = 'message assistant';
        messageEl.id = messageId;
        messageEl.dataset.messageId = messageId;
        messageEl.setAttribute('role', 'article');
        messageEl.setAttribute('aria-label', 'Generated files');

        messageEl.innerHTML = `
            <div class="message-avatar assistant" aria-hidden="true">
                <i data-lucide="files" class="w-4 h-4"></i>
            </div>
            <div class="message-content">
                <div class="message-header">
                    <span class="message-author">Generated Files</span>
                    <span class="message-time" title="${fullTimestamp}">${time}</span>
                </div>
                <div class="message-selection-panel">
                    <div class="selection-panel-info">
                        <div class="icon" aria-hidden="true">
                            <i data-lucide="files" class="w-3.5 h-3.5"></i>
                        </div>
                        <span class="text">Files ready</span>
                        <span class="meta">${artifacts.length} item${artifacts.length === 1 ? '' : 's'}</span>
                    </div>
                    ${galleryMarkup || `
                        <div class="unsplash-search-empty">
                            <i data-lucide="file-x" class="w-8 h-8" aria-hidden="true"></i>
                            <p>No generated files are available.</p>
                        </div>
                    `}
                </div>
            </div>
        `;

        if (messageEl.querySelector('.artifact-generated-card')) {
            this.renderMermaidDiagrams(messageEl);
        }

        return messageEl;
    }

    /**
     * Update an Unsplash search message with results or error
     * @param {string} messageId - The message ID to update
     * @param {Object} data - The update data
     */
    updateUnsplashSearchMessage(messageId, data) {
        const messageEl = document.getElementById(messageId);
        if (!messageEl) return false;
        
        // Create new message element with the updated data
        const newMessage = {
            id: messageId,
            role: 'assistant',
            type: 'unsplash-search',
            content: data.content,
            query: data.query,
            isLoading: Boolean(data.isLoading),
            loadingText: data.loadingText,
            results: data.results,
            total: data.total,
            totalPages: data.totalPages,
            currentPage: data.currentPage,
            perPage: data.perPage,
            orientation: data.orientation,
            error: data.error,
            timestamp: data.timestamp || new Date().toISOString()
        };
        
        const newEl = this.renderUnsplashSearchMessage(newMessage);
        messageEl.replaceWith(newEl);
        this.reinitializeIcons(newEl);
        this.scrollToBottom();
        
        return true;
    }

    /**
     * Escape HTML for safe use in JSON
     * @param {Object} obj - Object to escape
     * @returns {Object} - Escaped object
     */
    escapeHtmlForJSON(obj) {
        if (typeof obj === 'string') {
            return this.escapeHtml(obj);
        }
        if (Array.isArray(obj)) {
            return obj.map(item => this.escapeHtmlForJSON(item));
        }
        if (obj && typeof obj === 'object') {
            const escaped = {};
            for (const [key, value] of Object.entries(obj)) {
                escaped[key] = this.escapeHtmlForJSON(value);
            }
            return escaped;
        }
        return obj;
    }

    updateImageMessage(messageId, imageData) {
        const messageEl = document.getElementById(messageId);
        if (!messageEl) return false;

        const base64Image = typeof imageData.b64_json === 'string' && imageData.b64_json.trim()
            ? (imageData.b64_json.startsWith('data:')
                ? imageData.b64_json
                : `data:image/png;base64,${imageData.b64_json}`)
            : '';
        const imageUrl = imageData.inlineUrl || base64Image || imageData.url || imageData.downloadUrl;
        
        // Create new message element with the image data
        const newMessage = {
            id: messageId,
            role: 'assistant',
            type: 'image',
            imageUrl,
            thumbnailUrl: imageData.thumbnailUrl || imageUrl,
            downloadUrl: imageData.downloadUrl || '',
            artifactId: imageData.artifactId || '',
            filename: imageData.filename || '',
            prompt: imageData.prompt,
            revisedPrompt: imageData.revised_prompt,
            model: imageData.model,
            source: imageData.source || 'generated',
            timestamp: new Date().toISOString()
        };
        
        const newEl = this.renderImageMessage(newMessage);
        messageEl.replaceWith(newEl);
        this.reinitializeIcons(newEl);
        this.scrollToBottom();
        
        return true;
    }

    updateMessageContent(messageId, content, isStreaming = false) {
        const messageEl = document.getElementById(messageId);
        if (!messageEl) return false;

        const textEl = messageEl.querySelector('.message-text');
        if (!textEl) return false;

        const isUser = messageEl.classList.contains('user');
        const nextMessage = content && typeof content === 'object'
            ? { ...content, id: messageId }
            : { id: messageId, content };
        const effectiveStreaming = isStreaming === true || nextMessage?.isStreaming === true;
        
        if (isUser) {
            textEl.textContent = String(nextMessage.content || '');
        } else {
            const renderPlan = this.buildAssistantRenderPlan(nextMessage, effectiveStreaming);
            messageEl.classList.toggle('message--agent-brief', renderPlan.variant === 'agent-brief');
            textEl.classList.toggle('message-text--agent-brief', renderPlan.variant === 'agent-brief');
            textEl.innerHTML = renderPlan.html;
            this.highlightCodeBlocks(textEl);
            this.renderHtmlPreviews(textEl);
            this.renderMermaidDiagrams(textEl);
            this.reinitializeIcons(textEl);
        }

        messageEl.classList.toggle('message--streaming', !isUser && effectiveStreaming);
        messageEl.classList.toggle('message--has-reasoning', !isUser && this.hasMessageReasoning(nextMessage, effectiveStreaming));
        if (!isUser) {
            if (nextMessage?.liveState?.phase) {
                messageEl.dataset.livePhase = String(nextMessage.liveState.phase).trim();
            } else {
                delete messageEl.dataset.livePhase;
            }
        }

        return true;
    }

    markMessageSettled(messageId = '') {
        const messageEl = document.getElementById(messageId);
        if (!messageEl) {
            return;
        }

        messageEl.classList.remove('message--settled');
        void messageEl.offsetWidth;
        messageEl.classList.add('message--settled');

        window.setTimeout(() => {
            messageEl.classList.remove('message--settled');
        }, 1200);
    }

    appendToMessage(messageId, content) {
        const messageEl = document.getElementById(messageId);
        if (!messageEl) return false;

        const textEl = messageEl.querySelector('.message-text');
        if (!textEl) return false;

        // Get current content (excluding cursor)
        let currentHtml = textEl.innerHTML;
        currentHtml = currentHtml.replace(/<span class="streaming-cursor"><\/span>/g, '');

        // Extract text content
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = currentHtml;
        let currentText = tempDiv.textContent || '';

        // Append new content
        const newText = currentText + content;
        
        // Re-render as markdown
        const renderPlan = this.buildAssistantRenderPlan({ id: messageId, content: newText }, true);
        messageEl.classList.toggle('message--agent-brief', renderPlan.variant === 'agent-brief');
        textEl.classList.toggle('message-text--agent-brief', renderPlan.variant === 'agent-brief');
        textEl.innerHTML = renderPlan.html;
        this.highlightCodeBlocks(textEl);
        this.renderHtmlPreviews(textEl);
        this.renderMermaidDiagrams(textEl);
        this.reinitializeIcons(textEl);

        return true;
    }

    async copyMessage(messageId) {
        const messageEl = document.getElementById(messageId);
        if (!messageEl) return;

        const textEl = messageEl.querySelector('.message-text');
        if (!textEl) return;

        const text = textEl.textContent || '';
        
        try {
            await navigator.clipboard.writeText(text.trim());
            this.showToast('Message copied to clipboard', 'success');
        } catch (err) {
            console.error('Failed to copy message:', err);
            this.showToast('Failed to copy message', 'error');
        }
    }

    regenerateMessage(messageId) {
        // Dispatch custom event for the app to handle
        window.dispatchEvent(new CustomEvent('regenerateMessage', { detail: { messageId } }));
    }

    submitAlignmentFeedback(messageId, rating) {
        window.dispatchEvent(new CustomEvent('submitAlignmentFeedback', {
            detail: { messageId, rating },
        }));
    }

    // ============================================
    // Static ID Generator
    // ============================================

    static generateMessageId() {
        return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    generateMessageId() {
        return UIHelpers.generateMessageId();
    }

    // ============================================
    // Image Handling
    // ============================================

    openImageLightbox(imageUrl) {
        const lightbox = document.getElementById('image-lightbox');
        const img = document.getElementById('lightbox-image');
        img.src = imageUrl;
        img.alt = 'Generated image preview';
        lightbox.classList.remove('hidden');
        lightbox.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        
        // Save last focused element
        this.lastFocusedElement = document.activeElement;
        
        // Focus trap for accessibility
        const closeBtn = lightbox.querySelector('.image-lightbox-close');
        if (closeBtn) closeBtn.focus();
    }

    closeImageLightbox() {
        const lightbox = document.getElementById('image-lightbox');
        const img = document.getElementById('lightbox-image');
        lightbox.classList.add('hidden');
        lightbox.setAttribute('aria-hidden', 'true');
        img.src = '';
        img.alt = '';
        document.body.style.overflow = '';
        
        // Return focus to trigger button
        if (this.lastFocusedElement) {
            this.lastFocusedElement.focus();
            this.lastFocusedElement = null;
        }
    }

    downloadLightboxImage() {
        const img = document.getElementById('lightbox-image');
        if (img.src) {
            this.downloadImage(img.src, 'generated-image.png');
        }
    }

    downloadImage(imageUrl, filename) {
        const a = document.createElement('a');
        a.href = imageUrl;
        a.download = filename;
        a.setAttribute('aria-label', `Download ${filename}`);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    async copyImageUrl(imageUrl) {
        try {
            await navigator.clipboard.writeText(imageUrl);
            this.showToast('Image URL copied to clipboard', 'success');
        } catch (err) {
            console.error('Failed to copy image URL:', err);
            this.showToast('Failed to copy image URL', 'error');
        }
    }

    // ============================================
    // Image Generation Modal
    // ============================================

    openImageModal() {
        const modal = document.getElementById('image-modal');
        this.closeThemeGallery({ silent: true });
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
        
        // Save last focused element
        this.lastFocusedElement = document.activeElement;
        
        // Focus the prompt input
        setTimeout(() => {
            const input = document.getElementById('image-prompt-input');
            if (input) input.focus();
        }, 100);

        const modelSelect = document.getElementById('image-model-select');
        const preferredModelId = this.getPreferredImageModelId();
        if (modelSelect && preferredModelId) {
            modelSelect.value = preferredModelId;
        }
        this.setImageSource('generate');
        
        this.loadImageModels();

        // Setup toggle buttons
        this.setupImageGenerationToggles();
        
        // Trap focus for accessibility
        this.trapFocus(modal);
    }

    openPodcastModal() {
        this.openImageModal();
        this.setImageSource('podcast');
    }

    getImageModelPreferenceRank(model = {}) {
        const normalizedId = String(model?.id || '').trim().toLowerCase();
        const preferredOrder = [
            'gpt-image-2',
            'gpt-image-1.5',
            'gpt-image-1',
            'gpt-image-1-mini',
            'dall-e-3',
            'dall-e-2',
        ];
        const preferredIndex = preferredOrder.indexOf(normalizedId);
        if (preferredIndex !== -1) {
            return preferredIndex;
        }

        if (/^(gpt-image|dall-e-)/i.test(normalizedId)) {
            return preferredOrder.length;
        }

        return preferredOrder.length + 100;
    }

    sortImageModelsForDisplay(models = []) {
        const list = Array.isArray(models) ? [...models] : [];
        return list.sort((left, right) => {
            const rankDelta = this.getImageModelPreferenceRank(left) - this.getImageModelPreferenceRank(right);
            if (rankDelta !== 0) {
                return rankDelta;
            }

            return String(left?.name || left?.id || '').localeCompare(String(right?.name || right?.id || ''));
        });
    }

    getPreferredImageModelId(models = this.availableImageModels) {
        const list = this.sortImageModelsForDisplay(models);
        return list[0]?.id || '';
    }

    getImageModelMetadata(modelId = '') {
        const normalizedId = String(modelId || '').trim();
        if (!normalizedId) {
            return this.availableImageModels[0] || {};
        }

        return this.availableImageModels.find((entry) => entry.id === normalizedId) || {};
    }

    formatImageOptionLabel(value = '', type = 'generic') {
        const normalized = String(value || '').trim();
        if (!normalized) {
            return 'Backend default';
        }

        if (normalized === 'auto') {
            return 'Auto';
        }

        if (type === 'size') {
            const sizeMatch = normalized.match(/^(\d+)x(\d+)$/);
            if (sizeMatch) {
                const width = Number(sizeMatch[1]);
                const height = Number(sizeMatch[2]);
                const aspectLabel = width === height
                    ? 'Square'
                    : (width > height ? 'Landscape' : 'Portrait');
                return `${normalized} (${aspectLabel})`;
            }
        }

        if (normalized === 'hd') {
            return 'HD';
        }

        return normalized
            .split('-')
            .map((part) => part ? part[0].toUpperCase() + part.slice(1) : '')
            .join(' ');
    }

    renderImageOptionButtons(containerId, optionClassName, values = [], selectedValue = '', valueKey = 'value') {
        const container = document.getElementById(containerId);
        if (!container) {
            return;
        }

        container.innerHTML = values
            .map((value) => {
                const normalizedValue = String(value || '').trim();
                const isSelected = normalizedValue === String(selectedValue || '').trim();
                const labelType = valueKey === 'size' ? 'size' : 'generic';
                return `
                    <button
                        type="button"
                        class="${optionClassName} ${isSelected ? 'active' : ''} flex-1 py-2 px-3 rounded-lg border border-border bg-bg-tertiary text-sm font-medium transition-all"
                        data-${valueKey}="${normalizedValue}"
                        role="radio"
                        aria-checked="${isSelected ? 'true' : 'false'}"
                    >
                        ${this.formatImageOptionLabel(normalizedValue, labelType)}
                    </button>
                `;
            })
            .join('');
    }
    async loadImageModels() {
        try {
            const models = await apiClient.getImageModelsFromAPI();
            this.availableImageModels = this.sortImageModelsForDisplay(models);

            const modelSelect = document.getElementById('image-model-select');
            if (modelSelect && this.availableImageModels.length > 0) {
                const currentValue = modelSelect.value;
                const currentModel = this.availableImageModels.find((model) => model.id === currentValue) || { id: currentValue };
                const preferredModelId = this.getPreferredImageModelId(this.availableImageModels);
                const preferredModel = this.availableImageModels.find((model) => model.id === preferredModelId) || { id: preferredModelId };
                modelSelect.innerHTML = this.availableImageModels
                    .map((model) => `<option value="${model.id}">${model.name || model.id || 'Gateway Default'}</option>` )
                    .join('');

                if (!this.availableImageModels.find((model) => model.id === currentValue)
                    || this.getImageModelPreferenceRank(currentModel) > this.getImageModelPreferenceRank(preferredModel)) {
                    modelSelect.value = preferredModelId;
                } else {
                    modelSelect.value = currentValue;
                }

                this.updateImageOptionsForModel(modelSelect.value);
            }
        } catch (error) {
            console.error('Failed to load image models:', error);
            this.availableImageModels = [];
        }
    }
    closeImageModal() {
        const modal = document.getElementById('image-modal');
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
        
        // Return focus to trigger button
        if (this.lastFocusedElement) {
            this.lastFocusedElement.focus();
            this.lastFocusedElement = null;
        }
        
        // Reset form
        const promptInput = document.getElementById('image-prompt-input');
        const modelSelect = document.getElementById('image-model-select');
        const sizeSelect = document.getElementById('image-size-select');
        const countSelect = document.getElementById('image-count-select');
        const directRequestInput = document.getElementById('podcast-direct-request-input');
        const systemPromptInput = document.getElementById('podcast-system-prompt-input');
        
        if (promptInput) promptInput.value = '';
        if (modelSelect) modelSelect.value = this.getPreferredImageModelId();
        if (sizeSelect) sizeSelect.value = '';
        if (countSelect) countSelect.value = '1';
        if (directRequestInput) directRequestInput.value = '';
        if (systemPromptInput) systemPromptInput.value = '';
        
        this.imageGenerationState.quality = null;
        this.imageGenerationState.style = null;
        this.imageGenerationState.source = 'generate';
        if (modelSelect) {
            this.updateImageOptionsForModel(modelSelect.value);
        }
        this.updateToggleButtons();
        this.setImageSource('generate');
    }

    /**
     * Set the image source (generate or unsplash)
     * @param {string} source - 'generate' or 'unsplash'
     */
    setImageSource(source) {
        this.imageGenerationState.source = source;
        
        // Update button states
        document.querySelectorAll('.image-source-btn').forEach(btn => {
            const isActive = btn.dataset.source === source;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-checked', isActive);
        });
        
        // Show/hide appropriate options
        const aiOptions = document.getElementById('ai-generation-options');
        const unsplashOptions = document.getElementById('unsplash-options');
        const podcastOptions = document.getElementById('podcast-options');
        const promptLabel = document.getElementById('image-prompt-label');
        const actionText = document.getElementById('image-action-text');
        const actionIcon = document.querySelector('#image-generate-btn i');
        
        if (source === 'generate') {
            aiOptions?.classList.remove('hidden');
            unsplashOptions?.classList.add('hidden');
            podcastOptions?.classList.add('hidden');
            if (promptLabel) promptLabel.textContent = 'Describe the image you want to generate...';
            if (actionText) actionText.textContent = 'Generate Image';
            if (actionIcon) actionIcon.setAttribute('data-lucide', 'wand-2');
        } else if (source === 'unsplash') {
            aiOptions?.classList.add('hidden');
            unsplashOptions?.classList.remove('hidden');
            podcastOptions?.classList.add('hidden');
            if (promptLabel) promptLabel.textContent = 'What are you looking for?';
            if (actionText) actionText.textContent = 'Search Unsplash';
            if (actionIcon) actionIcon.setAttribute('data-lucide', 'search');
        } else {
            aiOptions?.classList.add('hidden');
            unsplashOptions?.classList.add('hidden');
            podcastOptions?.classList.remove('hidden');
            if (promptLabel) promptLabel.textContent = 'What should the podcast be about?';
            if (actionText) actionText.textContent = 'Create Podcast';
            if (actionIcon) actionIcon.setAttribute('data-lucide', 'audio-lines');
        }
        
        // Re-initialize icons
        this.reinitializeIcons();
    }

    setupImageGenerationToggles() {
        const modelSelect = document.getElementById('image-model-select');
        if (this.imageGenerationControlsBound !== true) {
            const qualityOptions = document.getElementById('image-quality-options');
            if (qualityOptions) {
                qualityOptions.addEventListener('click', (event) => {
                    const button = event.target.closest('.quality-btn');
                    if (!button) {
                        return;
                    }

                    this.imageGenerationState.quality = button.dataset.quality || null;
                    this.updateToggleButtons();
                });
            }

            const styleOptions = document.getElementById('image-style-options');
            if (styleOptions) {
                styleOptions.addEventListener('click', (event) => {
                    const button = event.target.closest('.style-btn');
                    if (!button) {
                        return;
                    }

                    this.imageGenerationState.style = button.dataset.style || null;
                    this.updateToggleButtons();
                });
            }

            if (modelSelect) {
                modelSelect.addEventListener('change', (event) => {
                    this.updateImageOptionsForModel(event.target.value);
                });
            }

            this.imageGenerationControlsBound = true;
        }
        
        this.updateToggleButtons();
        if (modelSelect) {
            this.updateImageOptionsForModel(modelSelect.value);
        }
    }

    updateToggleButtons() {
        document.querySelectorAll('.quality-btn').forEach(btn => {
            const isActive = btn.dataset.quality === this.imageGenerationState.quality;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
        });
        document.querySelectorAll('.style-btn').forEach(btn => {
            const isActive = btn.dataset.style === this.imageGenerationState.style;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
        });
    }

    updateImageOptionsForModel(model) {
        const sizeSelect = document.getElementById('image-size-select');
        const qualityContainer = document.getElementById('image-quality-container');
        const styleContainer = document.getElementById('image-style-container');
        
        if (!sizeSelect) return;

        const selectedModel = this.getImageModelMetadata(model);
        const sizes = Array.isArray(selectedModel.sizes) && selectedModel.sizes.length > 0
            ? selectedModel.sizes
            : ['auto', '1024x1024', '1536x1024', '1024x1536'];
        const qualities = Array.isArray(selectedModel.qualities) ? selectedModel.qualities : [];
        const styles = Array.isArray(selectedModel.styles) ? selectedModel.styles : [];
        const supportsQuality = qualities.length > 0;
        const supportsStyle = styles.length > 0;

        sizeSelect.innerHTML = sizes
            .map((size) => `<option value="${size}">${this.formatImageOptionLabel(size, 'size')}</option>`)
            .join('');

        if (!sizes.includes(sizeSelect.value)) {
            sizeSelect.value = sizes[0];
        }

        if (supportsQuality) {
            const preferredQuality = qualities.includes('auto') ? 'auto' : qualities[0];
            if (!qualities.includes(this.imageGenerationState.quality)) {
                this.imageGenerationState.quality = preferredQuality;
            }
            this.renderImageOptionButtons('image-quality-options', 'quality-btn', qualities, this.imageGenerationState.quality, 'quality');
        } else {
            this.imageGenerationState.quality = null;
            this.renderImageOptionButtons('image-quality-options', 'quality-btn', [], '', 'quality');
        }

        if (supportsStyle) {
            if (!styles.includes(this.imageGenerationState.style)) {
                this.imageGenerationState.style = styles[0];
            }
            this.renderImageOptionButtons('image-style-options', 'style-btn', styles, this.imageGenerationState.style, 'style');
        } else {
            this.imageGenerationState.style = null;
            this.renderImageOptionButtons('image-style-options', 'style-btn', [], '', 'style');
        }

        if (qualityContainer) qualityContainer.style.display = supportsQuality ? 'block' : 'none';
        if (styleContainer) styleContainer.style.display = supportsStyle ? 'block' : 'none';
        this.updateToggleButtons();
    }

    getImageGenerationOptions() {
        const modelSelect = document.getElementById('image-model-select');
        const promptInput = document.getElementById('image-prompt-input');
        const sizeSelect = document.getElementById('image-size-select');
        const countSelect = document.getElementById('image-count-select');
        const requestedCount = Math.min(Math.max(Number(countSelect?.value) || 1, 1), 5);
        
        const selectedModel = this.availableImageModels.find((entry) => entry.id === modelSelect?.value)
            || this.availableImageModels.find((entry) => entry.id === this.getPreferredImageModelId())
            || this.availableImageModels[0]
            || {};
        const model = modelSelect?.value || selectedModel.id || '';
        const options = {
            prompt: promptInput?.value?.trim() || '',
            model: model,
            size: sizeSelect?.value || selectedModel.sizes?.[0] || 'auto',
            n: requestedCount,
            batchMode: requestedCount > 1 ? 'auto' : undefined,
            source: this.imageGenerationState.source
        };
        
        if (Array.isArray(selectedModel.qualities) && selectedModel.qualities.includes(this.imageGenerationState.quality)) {
            options.quality = this.imageGenerationState.quality;
        }
        if (Array.isArray(selectedModel.styles) && selectedModel.styles.includes(this.imageGenerationState.style)) {
            options.style = this.imageGenerationState.style;
        }
        
        return options;
    }

    getPodcastProductionOptions() {
        const promptInput = document.getElementById('image-prompt-input');
        const outputSelect = document.getElementById('podcast-output-select');
        const aspectSelect = document.getElementById('podcast-aspect-select');
        const musicToggle = document.getElementById('podcast-music-toggle');
        const introToggle = document.getElementById('podcast-intro-toggle');
        const outroToggle = document.getElementById('podcast-outro-toggle');
        const unsplashToggle = document.getElementById('podcast-unsplash-toggle');
        const directRequestInput = document.getElementById('podcast-direct-request-input');
        const systemPromptInput = document.getElementById('podcast-system-prompt-input');
        const productionType = String(outputSelect?.value || 'podcast').trim();
        const includeVideo = productionType === 'video-podcast';
        const includeMusicBed = musicToggle?.checked === true;
        const includeIntro = introToggle?.checked === true;
        const includeOutro = outroToggle?.checked === true;

        return {
            prompt: promptInput?.value?.trim() || '',
            metadata: {
                podcastOptions: {
                    enabled: true,
                    productionType,
                    includeVideo,
                    voiceOnlyAudio: !(includeMusicBed || includeIntro || includeOutro),
                    includeMusicBed,
                    includeIntro,
                    includeOutro,
                    cycleHostVoices: false,
                    allowVoiceFallback: false,
                    videoAspectRatio: aspectSelect?.value || '16:9',
                    videoRenderMode: includeVideo ? 'storyboard' : undefined,
                    videoImageMode: unsplashToggle?.checked === true ? 'unsplash' : 'generated',
                    videoGenerateImages: includeVideo && unsplashToggle?.checked !== true,
                    directContentRequest: directRequestInput?.value?.trim() || '',
                    systemPrompt: systemPromptInput?.value?.trim() || '',
                },
            },
        };
    }

    /**
     * Get the current image source
     * @returns {string} - 'generate' or 'unsplash'
     */
    getImageSource() {
        return this.imageGenerationState.source;
    }

    setImageGenerateButtonState(isGenerating) {
        const btn = document.getElementById('image-generate-btn');
        if (!btn) return;
        
        if (isGenerating) {
            btn.disabled = true;
            btn.classList.add('generating');
            btn.setAttribute('aria-busy', 'true');
            btn.innerHTML = `
                <div class="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" aria-hidden="true"></div>
                <span>Generating...</span>
            `;
        } else {
            btn.disabled = false;
            btn.classList.remove('generating');
            btn.setAttribute('aria-busy', 'false');
            btn.innerHTML = `
                <i data-lucide="wand-2" class="w-5 h-5" aria-hidden="true"></i>
                <span>Generate Image</span>
            `;
            this.reinitializeIcons(btn);
        }
    }

    // ============================================
    // Model Selector
    // ============================================

    async loadModels() {
        const modelBtn = document.getElementById('model-selector-btn');
        
        try {
            // Add loading state
            if (modelBtn) modelBtn.classList.add('loading');
            
            const response = await apiClient.getModels(true);
            const models = Array.isArray(response?.data) ? response.data : [];
            const chatModels = typeof apiClient.filterChatModels === 'function'
                ? apiClient.filterChatModels(models)
                : models;
            this.availableModels = chatModels.some((model) => model?.id === WEB_CHAT_DEFAULT_MODEL)
                ? chatModels
                : [{ id: WEB_CHAT_DEFAULT_MODEL, owned_by: 'router' }, ...chatModels];
            const preferredModel = webChatSelectPreferredModel(this.availableModels, this.currentModel);
            if (preferredModel !== this.currentModel) {
                this.currentModel = preferredModel;
                window.sessionManager?.safeStorageSet?.('kimibuilt_default_model', preferredModel);
                this.updateModelUI();
            }
            
            // Remove loading state
            if (modelBtn) modelBtn.classList.remove('loading');

            this.updateAssistantModelSelect();
            
            return this.availableModels;
        } catch (error) {
            console.error('Failed to load models:', error);
            
            // Remove loading state
            if (modelBtn) modelBtn.classList.remove('loading');

            this.updateAssistantModelSelect();
            
            return [];
        }
    }

    toggleModelSelector() {
        const dropdown = document.getElementById('model-selector-dropdown');
        if (dropdown.classList.contains('hidden')) {
            this.openModelSelector();
        } else {
            this.closeModelSelector();
        }
    }
    
    updateModelSelectorAria(expanded) {
        const btn = document.getElementById('model-selector-btn');
        if (btn) {
            btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        }
    }

    async openModelSelector() {
        const dropdown = document.getElementById('model-selector-dropdown');
        if (!dropdown) {
            return;
        }

        this.closeSearch({ silent: true });
        this.closeThemeGallery({ silent: true });
        this.closeSidebar();
        this.closeMobileActionSheet({ silent: true });
        dropdown.classList.remove('hidden');
        dropdown.setAttribute('aria-hidden', 'false');
        this.playMenuCue('menu-open');
        
        // Update ARIA
        this.updateModelSelectorAria(true);
        
        // Save last focused element
        this.lastFocusedElement = document.activeElement;
        
        // Load models if not already loaded
        if (this.availableModels.length === 0) {
            await this.loadModels();
        }
        
        this.updateAssistantModelSelect();
        this.renderModelList();
        
        // Trap focus
        this.trapFocus(dropdown);
    }

    closeModelSelector(options = {}) {
        const dropdown = document.getElementById('model-selector-dropdown');
        if (!dropdown) {
            return;
        }
        dropdown.classList.add('hidden');
        dropdown.setAttribute('aria-hidden', 'true');

        if (options?.silent !== true) {
            this.playMenuCue('menu-close');
        }
        
        // Update ARIA
        this.updateModelSelectorAria(false);
        
        // Return focus to trigger button
        if (this.lastFocusedElement) {
            this.lastFocusedElement.focus();
            this.lastFocusedElement = null;
        }
    }

    renderModelList() {
        const listContainer = document.getElementById('model-list');
        if (!listContainer) {
            return;
        }

        this.updateAssistantModelSelect();
        
        if (this.availableModels.length === 0) {
            listContainer.innerHTML = `
                <div class="empty-state py-4">
                    <p class="text-sm text-text-secondary">No models available</p>
                </div>
            `;
            return;
        }
        
        // Group models by provider
        const grouped = this.groupModelsByProvider(this.availableModels);
        
        listContainer.innerHTML = Object.entries(grouped).map(([provider, models]) => `
            <div class="model-group">
                <div class="model-group-title">${provider}</div>
                ${models.map(model => this.renderModelItem(model)).join('')}
            </div>
        `).join('');
        
        // Attach click handlers
        listContainer.querySelectorAll('.model-item').forEach(item => {
            item.addEventListener('click', () => {
                const modelId = item.dataset.modelId;
                this.selectModel(modelId);
            });
        });
        
        this.reinitializeIcons(listContainer);
    }

    renderModelItem(model) {
        const isActive = model.id === this.currentModel;
        const provider = this.getModelProvider(model);
        const displayName = this.getModelDisplayName(model);
        const description = this.getModelDescription(model);
        
        return `
            <div class="model-item ${isActive ? 'active' : ''}" data-model-id="${model.id}" role="option" aria-selected="${isActive}">
                <div class="model-item-icon ${provider}">
                    <i data-lucide="cpu" class="w-4 h-4" aria-hidden="true"></i>
                </div>
                <div class="model-item-info">
                    <div class="model-item-name">${displayName}</div>
                    <div class="model-item-desc">${description}</div>
                </div>
                <div class="model-item-check" aria-hidden="true">
                    <i data-lucide="check" class="w-4 h-4"></i>
                </div>
            </div>
        `;
    }

    groupModelsByProvider(models) {
        const grouped = {};
        
        models.forEach(model => {
            const provider = this.getModelProviderName(model);
            if (!grouped[provider]) {
                grouped[provider] = [];
            }
            grouped[provider].push(model);
        });
        
        return grouped;
    }

    getModelProvider(model) {
        const id = model.id.toLowerCase();
        if (id.includes('claude')) return 'anthropic';
        if (id.includes('gpt') || id.includes('dall')) return 'openai';
        if (id.includes('gemini') || id.includes('palm')) return 'google';
        if (id.includes('llama') || id.includes('meta')) return 'meta';
        return '';
    }

    getModelProviderName(model) {
        const provider = this.getModelProvider(model);
        const names = {
            'anthropic': 'Anthropic',
            'openai': 'OpenAI',
            'google': 'Google',
            'meta': 'Meta'
        };
        return names[provider] || 'Other';
    }

    getModelDisplayName(model) {
        // Convert model ID to readable name
        const id = model.id;
        const names = {
            'auto': 'Auto',
            'gpt-5.4-mini': 'GPT-5.4 Mini',
            'gpt-5.4': 'GPT-5.4',
            'gpt-5.3-instant': 'GPT-5.3 Instant',
            'gpt-5.3': 'GPT-5.3',
            'gpt-5-codex': 'GPT-5 Codex',
            'codex-mini-latest': 'Codex Mini Latest',
            'gpt-4o': 'GPT-4o',
            'gpt-4o-mini': 'GPT-4o Mini',
            'gpt-4-turbo': 'GPT-4 Turbo',
            'gpt-4': 'GPT-4',
            'gpt-3.5-turbo': 'GPT-3.5 Turbo',
            'claude-3-opus': 'Claude 3 Opus',
            'claude-3-sonnet': 'Claude 3 Sonnet',
            'claude-3-haiku': 'Claude 3 Haiku',
            'claude-3-5-sonnet': 'Claude 3.5 Sonnet',
            'claude-3.5-sonnet-latest': 'Claude 3.5 Sonnet Latest'
        };
        return names[id] || id;
    }

    getModelDescription(model) {
        const descriptions = {
            'auto': 'Let the internal model router choose',
            'gpt-5.4-mini': 'Recommended Codex-backed streaming model',
            'gpt-5.4': 'High-capability Codex-backed model',
            'gpt-5.3-instant': 'Fast Codex-backed model',
            'gpt-5.3': 'Balanced Codex-backed model',
            'gpt-5-codex': 'Codex-focused model',
            'codex-mini-latest': 'Compact Codex model',
            'gpt-4o': 'Most capable multimodal model',
            'gpt-4o-mini': 'Fast and affordable',
            'gpt-4-turbo': 'Advanced reasoning',
            'claude-3-opus': 'Powerful reasoning',
            'claude-3-sonnet': 'Balanced performance',
            'claude-3-haiku': 'Fast and efficient',
            'claude-3-5-sonnet': 'Latest and most capable'
        };
        return descriptions[model.id] || model.owned_by || 'AI Model';
    }

    getSelectableModels() {
        const models = Array.isArray(this.availableModels) ? [...this.availableModels] : [];
        if (!models.some((model) => model?.id === WEB_CHAT_DEFAULT_MODEL)) {
            models.unshift({ id: WEB_CHAT_DEFAULT_MODEL, owned_by: 'router' });
        }
        if (this.currentModel && !models.some((model) => model?.id === this.currentModel)) {
            models.unshift({ id: this.currentModel, owned_by: '' });
        }
        return models;
    }

    updateAssistantModelSelect() {
        const select = document.getElementById('assistant-model-select');
        if (!select) {
            return;
        }

        const models = this.getSelectableModels();
        if (models.length === 0) {
            select.innerHTML = `<option value="${this.escapeHtmlAttr(this.currentModel)}">${this.escapeHtml(this.getModelDisplayName({ id: this.currentModel }))}</option>`;
            select.value = this.currentModel;
            return;
        }

        select.innerHTML = models.map((model) => {
            const provider = this.getModelProviderName(model);
            const displayName = this.getModelDisplayName(model);
            const optionLabel = provider && provider !== 'Other'
                ? `${displayName} | ${provider}`
                : displayName;
            return `<option value="${this.escapeHtmlAttr(model.id)}">${this.escapeHtml(optionLabel)}</option>`;
        }).join('');
        select.value = this.currentModel;
    }

    toggleModelListVisibility(forceExpanded = null) {
        const toggle = document.getElementById('model-list-toggle');
        const list = document.getElementById('model-list');
        if (!toggle || !list) {
            return;
        }

        const shouldExpand = forceExpanded == null
            ? list.classList.contains('hidden')
            : forceExpanded === true;

        list.classList.toggle('hidden', !shouldExpand);
        toggle.setAttribute('aria-expanded', shouldExpand ? 'true' : 'false');
    }

    selectModel(modelId, options = {}) {
        this.currentModel = modelId;
        window.sessionManager?.safeStorageSet?.('kimibuilt_default_model', modelId);
        this.updateModelUI();
        this.updateAssistantModelSelect();

        if (options?.closeModal !== false) {
            this.closeModelSelector({ silent: true });
        }
        if (options?.playCue !== false) {
            this.playMenuCue('menu-select');
        }
        if (options?.showToast !== false) {
            this.showToast(`Model changed to ${this.getModelDisplayName({ id: modelId })}`, 'success');
        }
        
        // Dispatch event for app to know model changed
        window.dispatchEvent(new CustomEvent('modelChanged', { detail: { modelId } }));
    }

    updateModelUI() {
        const label = document.getElementById('current-model-label');
        const inputLabel = document.getElementById('input-model-label');
        const displayName = this.getModelDisplayName({ id: this.currentModel });
        
        if (label) label.textContent = displayName;
        if (inputLabel) inputLabel.textContent = displayName;
        this.updateAssistantModelSelect();
        this.updateMobileActionSheetUI();
    }

    normalizeDefaultModelPreference(modelId = '') {
        const normalized = String(modelId || '').trim();
        if (!normalized || WEB_CHAT_LEGACY_DEFAULT_MODELS.has(normalized)) {
            return WEB_CHAT_DEFAULT_MODEL;
        }
        return normalized;
    }

    normalizeReasoningEffort(value) {
        const normalized = String(value || '').trim().toLowerCase();
        return ['low', 'medium', 'high', 'xhigh'].includes(normalized) ? normalized : '';
    }

    getReasoningDisplayLabel(value = this.currentReasoningEffort) {
        const normalized = this.normalizeReasoningEffort(value);
        const labels = {
            '': 'Reasoning: Default',
            low: 'Reasoning: Low',
            medium: 'Reasoning: Medium',
            high: 'Reasoning: High',
            xhigh: 'Reasoning: XHigh',
        };
        return labels[normalized] || labels[''];
    }

    updateReasoningUI() {
        const select = document.getElementById('reasoning-effort-select');
        const inputLabel = document.getElementById('input-reasoning-label');
        const normalized = this.normalizeReasoningEffort(this.currentReasoningEffort);
        const displayLabel = this.getReasoningDisplayLabel(normalized);

        if (select) {
            select.value = normalized;
        }
        if (inputLabel) {
            inputLabel.textContent = displayLabel;
        }
    }

    getCurrentReasoningEffort() {
        return this.normalizeReasoningEffort(this.currentReasoningEffort);
    }

    isRemoteBuildAutonomyApproved() {
        return this.remoteBuildAutonomyApproved === true;
    }

    parseRemoteBuildAutonomyPreference(value) {
        const normalized = String(value ?? '').trim().toLowerCase();
        if (!normalized) {
            return true;
        }

        if (['0', 'false', 'no', 'off'].includes(normalized)) {
            return false;
        }

        return ['1', 'true', 'yes', 'on'].includes(normalized);
    }

    parseBooleanPreference(value, fallback = false) {
        const normalized = String(value ?? '').trim().toLowerCase();
        if (!normalized) {
            return fallback;
        }

        if (['1', 'true', 'yes', 'on'].includes(normalized)) {
            return true;
        }

        if (['0', 'false', 'no', 'off'].includes(normalized)) {
            return false;
        }

        return fallback;
    }

    rehydrateStoredPreferences(options = {}) {
        const appInstance = options.appInstance || window.chatApp || null;

        const savedModel = this.normalizeDefaultModelPreference(this.storageGet('kimibuilt_default_model'));
        const savedReasoningEffort = this.normalizeReasoningEffort(this.storageGet('kimibuilt_reasoning_effort'));
        const savedRemoteAutonomy = this.parseRemoteBuildAutonomyPreference(this.storageGet('kimibuilt_remote_build_autonomy'));
        const savedLongAgentDefault = this.parseBooleanPreference(this.storageGet(WEB_CHAT_LONG_AGENT_DEFAULT_KEY), false);

        this.currentModel = savedModel;
        this.currentReasoningEffort = savedReasoningEffort;
        this.remoteBuildAutonomyApproved = savedRemoteAutonomy;
        this.longAgentDefaultEnabled = savedLongAgentDefault;
        this.updateModelUI();
        this.updateReasoningUI();
        this.updateRemoteBuildAutonomyUI();
        this.updateLongAgentDefaultUI();

        this.soundManager?.refreshFromStorage?.();
        this.updateSoundCuesUI();
        this.updateMenuSoundsUI();
        this.populateSoundProfileOptions();
        this.updateSoundProfileUI();
        this.updateSoundVolumeUI();

        this.ttsManager?.refreshFromStorage?.();
        this.updateTtsUI();
        this.updateTtsPreviewButtons();
        this.updateMessageSpeechButtons();

        window.sidebarResizer?.reloadFromStorage?.();
        this.restoreInputAreaState();
        this.updateMinimalistToggleUI();
        appInstance?.updateSessionInfo?.();
    }

    setCurrentReasoningEffort(value) {
        this.currentReasoningEffort = this.normalizeReasoningEffort(value);
        if (this.currentReasoningEffort) {
            window.sessionManager?.safeStorageSet?.('kimibuilt_reasoning_effort', this.currentReasoningEffort);
        } else {
            window.sessionManager?.safeStorageRemove?.('kimibuilt_reasoning_effort');
        }
        this.updateReasoningUI();
        this.playMenuCue('menu-select');
        window.dispatchEvent(new CustomEvent('reasoningChanged', {
            detail: { reasoningEffort: this.currentReasoningEffort || null }
        }));
    }

    updateRemoteBuildAutonomyUI() {
        const button = document.getElementById('remote-autonomy-btn');
        const label = document.getElementById('remote-autonomy-label');
        if (!button) {
            return;
        }

        const enabled = this.isRemoteBuildAutonomyApproved();
        button.classList.toggle('is-active', enabled);
        button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        button.title = enabled
            ? 'Remote server autonomy: On'
            : 'Remote server autonomy: Off';
        if (label) {
            label.textContent = enabled
                ? 'Automatic remote steps: On'
                : 'Automatic remote steps: Off';
        }
    }

    setRemoteBuildAutonomyApproved(value) {
        this.remoteBuildAutonomyApproved = value === true;
        if (this.remoteBuildAutonomyApproved) {
            window.sessionManager?.safeStorageSet?.('kimibuilt_remote_build_autonomy', 'true');
        } else {
            window.sessionManager?.safeStorageSet?.('kimibuilt_remote_build_autonomy', 'false');
        }
        this.updateRemoteBuildAutonomyUI();
        window.dispatchEvent(new CustomEvent('remoteBuildAutonomyChanged', {
            detail: { approved: this.remoteBuildAutonomyApproved }
        }));
    }

    toggleRemoteBuildAutonomy() {
        this.setRemoteBuildAutonomyApproved(!this.isRemoteBuildAutonomyApproved());
        this.playMenuCue('menu-select');
    }

    isLongAgentDefaultEnabled() {
        return this.longAgentDefaultEnabled === true;
    }

    setLongAgentDefaultEnabled(value) {
        this.longAgentDefaultEnabled = value === true;
        this.storageSet(WEB_CHAT_LONG_AGENT_DEFAULT_KEY, this.longAgentDefaultEnabled ? 'true' : 'false');
        this.updateLongAgentDefaultUI();
        this.showToast(
            this.longAgentDefaultEnabled ? 'Long agent default enabled' : 'Long agent default disabled',
            'success',
        );
        window.dispatchEvent(new CustomEvent('longAgentDefaultChanged', {
            detail: { enabled: this.longAgentDefaultEnabled },
        }));
    }

    toggleLongAgentDefault() {
        this.setLongAgentDefaultEnabled(!this.isLongAgentDefaultEnabled());
        this.playMenuCue('menu-select');
    }

    updateLongAgentDefaultUI() {
        const button = document.getElementById('long-agent-default-btn');
        const label = document.getElementById('long-agent-default-label');
        if (!button) {
            return;
        }

        const enabled = this.isLongAgentDefaultEnabled();
        button.classList.toggle('is-active', enabled);
        button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        button.title = enabled
            ? 'Disable long agent mode by default for new workloads'
            : 'Enable long agent mode by default for new workloads';
        if (label) {
            label.textContent = enabled ? 'Long agent: On' : 'Long agent: Off';
        }
    }

    isSoundCuesEnabled() {
        return this.soundManager?.isEnabled?.() === true;
    }

    isMenuSoundsEnabled() {
        return this.soundManager?.isMenuEnabled?.() === true;
    }

    getAvailableSoundProfiles() {
        return this.soundManager?.getSoundProfiles?.() || [];
    }

    getCurrentSoundProfileId() {
        return this.soundManager?.getSoundProfileId?.() || 'orbit';
    }

    getCurrentSoundVolume() {
        return this.soundManager?.getVolume?.() ?? 0.68;
    }

    populateSoundProfileOptions() {
        const select = document.getElementById('sound-profile-select');
        if (!select) {
            return;
        }

        const profiles = this.getAvailableSoundProfiles();
        if (!profiles.length) {
            return;
        }

        select.innerHTML = profiles
            .map((profile) => `<option value="${profile.id}">${profile.label}</option>`)
            .join('');
    }

    updateSoundProfileUI() {
        this.populateSoundProfileOptions();

        const select = document.getElementById('sound-profile-select');
        const hint = document.getElementById('sound-profile-hint');
        const currentProfileId = this.getCurrentSoundProfileId();
        const profile = this.getAvailableSoundProfiles()
            .find((entry) => entry.id === currentProfileId);

        if (select) {
            select.value = currentProfileId;
        }

        if (hint && profile) {
            hint.textContent = `${profile.description} Includes Ack, Reply, and Checkpoint variations.`;
        }
    }

    updateSoundVolumeUI() {
        const range = document.getElementById('sound-volume-range');
        const value = document.getElementById('sound-volume-value');
        const percent = Math.round(this.getCurrentSoundVolume() * 100);

        if (range) {
            range.value = String(percent);
        }

        if (value) {
            value.textContent = `${percent}%`;
        }
    }

    updateSoundCuesUI() {
        const button = document.getElementById('sound-cues-btn');
        const label = document.getElementById('sound-cues-label');
        const enabled = this.isSoundCuesEnabled();

        if (!button) {
            return;
        }

        button.classList.toggle('is-active', enabled);
        button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        button.title = enabled
            ? 'Robot sound cues: On'
            : 'Robot sound cues: Off';
        if (label) {
            label.textContent = enabled
                ? 'Cute robot cues: On'
                : 'Cute robot cues: Off';
        }
    }

    updateMenuSoundsUI() {
        const button = document.getElementById('menu-sounds-btn');
        const label = document.getElementById('menu-sounds-label');
        const enabled = this.isMenuSoundsEnabled();

        if (!button) {
            return;
        }

        button.classList.toggle('is-active', enabled);
        button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        button.title = enabled
            ? 'Menu motion sounds: On'
            : 'Menu motion sounds: Off';
        if (label) {
            label.textContent = enabled
                ? 'Menu sounds: On'
                : 'Menu sounds: Off';
        }
    }

    getSoundCueGroup(kind = '') {
        const normalizedKind = String(kind || '').trim().toLowerCase();
        if (normalizedKind.startsWith('menu-')) {
            return 'menu';
        }

        return 'assistant';
    }

    isSoundCueEnabledForKind(kind = '', options = {}) {
        const cueGroup = this.getSoundCueGroup(kind);
        if (cueGroup === 'menu') {
            return options?.preview === true || this.isMenuSoundsEnabled();
        }

        return options?.preview === true || this.isSoundCuesEnabled();
    }

    reportSoundCuePlaybackFailure(kind = '', options = {}) {
        if (this.isSoundCueEnabledForKind(kind, options)) {
            const now = Date.now();
            if (now - this.lastSoundCueWarningAt < this.soundCueWarningCooldownMs) {
                return;
            }

            this.lastSoundCueWarningAt = now;
            console.warn('[WebChat] Sound cue playback was blocked by browser audio permissions.', {
                kind,
                preview: options?.preview === true,
            });
        }
    }

    async maybePlaySoundCue(kind = 'response', options = {}) {
        let result = false;
        try {
            result = await Promise.resolve(this.soundManager?.play?.(kind, options));
        } catch (_error) {
            result = false;
        }

        if (result !== true) {
            this.reportSoundCuePlaybackFailure(kind, options);
        }

        return result;
    }

    setSoundCuesEnabled(value) {
        this.soundManager?.setEnabled?.(value === true);
        this.updateSoundCuesUI();
    }

    setMenuSoundsEnabled(value) {
        this.soundManager?.setMenuEnabled?.(value === true);
        this.updateMenuSoundsUI();
    }

    setSoundProfile(value) {
        this.soundManager?.setSoundProfile?.(value);
        this.updateSoundProfileUI();

        this.previewSoundCue('response');
    }

    setSoundVolume(value, options = {}) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
            return;
        }

        this.soundManager?.setVolume?.(numericValue / 100);
        this.updateSoundVolumeUI();

        if (options.preview === true) {
            this.previewSoundCue('menu-select');
        }
    }

    toggleSoundCues() {
        const nextValue = !this.isSoundCuesEnabled();
        this.setSoundCuesEnabled(nextValue);

        if (nextValue) {
            this.previewSoundCue('response');
        }
    }

    toggleMenuSounds() {
        const nextValue = !this.isMenuSoundsEnabled();
        this.setMenuSoundsEnabled(nextValue);

        if (nextValue) {
            this.previewSoundCue('menu-open');
        }
    }

    previewSoundCue(kind = 'response') {
        void this.maybePlaySoundCue(kind, { preview: true });
    }

    playAgentCue(kind = 'response') {
        void this.maybePlaySoundCue(kind);
    }

    playMenuCue(kind = 'menu-select') {
        void this.maybePlaySoundCue(kind);
    }

    playAcknowledgementCue() {
        void this.maybePlaySoundCue('ack');
    }

    playThinkingCue() {
        void this.maybePlaySoundCue('thinking-start');
    }

    async initializeTts() {
        if (!this.ttsManager) {
            return;
        }

        try {
            await this.ttsManager.ensureConfigLoaded({ quiet: true });
        } catch (_error) {
            // The UI should stay usable even when TTS is unavailable.
        }

        this.updateTtsUI();
        this.updateTtsPreviewButtons();
        this.updateMessageSpeechButtons();
    }

    isTtsAvailable() {
        return this.ttsManager?.isAvailable?.() === true;
    }

    getTtsDiagnostics() {
        return this.ttsManager?.getDiagnostics?.() || {
            status: 'unavailable',
            binaryReachable: false,
            voicesLoaded: false,
            message: 'Voice playback is unavailable.',
        };
    }

    getTtsStatus() {
        return this.ttsManager?.getStatus?.() || (this.isTtsAvailable() ? 'ready' : 'unavailable');
    }

    getTtsStatusLabel(status = '') {
        switch (String(status || '').trim().toLowerCase()) {
            case 'ready':
                return 'Ready';
            case 'misconfigured':
                return 'Misconfigured';
            default:
                return 'Unavailable';
        }
    }

    isTtsAutoPlayEnabled() {
        return this.ttsManager?.isAutoPlayEnabled?.() === true;
    }

    getTtsVoices() {
        return this.ttsManager?.getVoices?.() || [];
    }

    getTtsProviderLabel() {
        return this.ttsManager?.getProviderLabel?.() || 'Voice';
    }

    getTtsVoiceOptionLabel(voice = {}) {
        const voiceLabel = String(voice?.label || voice?.id || 'Voice').trim() || 'Voice';
        const providerId = String(voice?.provider || '').trim().toLowerCase();
        if (!providerId) {
            return voiceLabel;
        }

        const providerLabel = providerId === 'browser' ? 'Browser' : 'Piper';
        return `${providerLabel} - ${voiceLabel}`;
    }

    getTtsFeatureLabel() {
        const providerId = this.ttsManager?.getProvider?.() || '';
        if (providerId === 'browser') {
            return 'Browser voice';
        }
        if (providerId === 'piper') {
            return 'Piper voice';
        }
        return 'Voice';
    }

    getTtsVoiceLabel() {
        return this.ttsManager?.getVoiceLabel?.() || 'Voice';
    }

    setSelectedTtsVoiceId(voiceId = '') {
        this.ttsManager?.setSelectedVoiceId?.(voiceId);
        this.updateTtsUI();
    }

    getTtsPreviewSamples() {
        return [
            {
                id: 'soft-hello',
                label: 'Soft hello',
                text: 'Hi there. I am here, and I will keep things calm, clear, and easy to follow.',
            },
            {
                id: 'calm-guide',
                label: 'Calm guide',
                text: 'Here is a gentle summary of the next steps, one clear piece at a time.',
            },
            {
                id: 'gentle-close',
                label: 'Gentle close',
                text: 'You are all set. Take your time, and come back whenever you are ready.',
            },
        ];
    }

    getTtsPreviewSample(sampleId = '') {
        const normalizedSampleId = String(sampleId || '').trim();
        return this.getTtsPreviewSamples().find((sample) => sample.id === normalizedSampleId) || null;
    }

    getTtsPreviewMessageId(sampleId = '') {
        return `tts-preview:${String(sampleId || '').trim()}`;
    }

    updateTtsUI() {
        const button = document.getElementById('tts-autoplay-btn');
        const label = document.getElementById('tts-autoplay-label');
        const hint = document.getElementById('tts-voice-hint');
        const voiceSelectWrap = document.getElementById('tts-voice-select-wrap');
        const voiceSelect = document.getElementById('tts-voice-select');
        const diagnostics = this.getTtsDiagnostics();
        const status = this.getTtsStatus();
        const statusLabel = this.getTtsStatusLabel(status);
        const available = status === 'ready' && this.isTtsAvailable();
        const autoPlayEnabled = this.isTtsAutoPlayEnabled();
        const voices = this.getTtsVoices();
        const selectedVoiceId = this.ttsManager?.getSelectedVoiceId?.() || voices[0]?.id || '';

        if (button) {
            button.disabled = !available;
            button.classList.toggle('is-active', available && autoPlayEnabled);
            button.setAttribute('aria-pressed', available && autoPlayEnabled ? 'true' : 'false');
            button.title = available
                ? (autoPlayEnabled ? 'Read replies aloud: On' : 'Read replies aloud: Off')
                : `${this.getTtsFeatureLabel()} ${statusLabel.toLowerCase()}`;
        }

        if (label) {
            label.textContent = available
                ? `Read replies aloud: ${autoPlayEnabled ? 'On' : 'Off'}`
                : `Read replies aloud: ${statusLabel}`;
        }

        if (voiceSelectWrap) {
            voiceSelectWrap.hidden = voices.length === 0;
        }

        if (voiceSelect) {
            if (!voices.length) {
                voiceSelect.innerHTML = `<option value="">${this.escapeHtml(this.getTtsProviderLabel())} ${statusLabel.toLowerCase()}</option>`;
                voiceSelect.disabled = true;
                voiceSelect.value = '';
            } else {
                const optionsMarkup = voices
                    .map((voice) => `
                        <option value="${this.escapeHtmlAttr(voice.id)}">${this.escapeHtml(this.getTtsVoiceOptionLabel(voice))}</option>
                    `)
                    .join('');
                if (voiceSelect.innerHTML !== optionsMarkup) {
                    voiceSelect.innerHTML = optionsMarkup;
                }
                voiceSelect.disabled = !available;
                voiceSelect.value = selectedVoiceId || voices[0].id;
            }
        }

        if (hint) {
            hint.textContent = available
                ? `Voice status: Ready. ${this.getTtsVoiceLabel()} is ready through ${this.getTtsProviderLabel()}. Use the speaker button on any assistant reply, enable autoplay here, or preview the sample lines above.`
                : `Voice status: ${statusLabel}. ${String(diagnostics.message || 'Voice playback is unavailable.').trim()}`;
        }
    }

    updateTtsPreviewButtons() {
        const available = this.isTtsAvailable();

        document.querySelectorAll('[data-tts-preview]').forEach((button) => {
            const sampleId = String(button.dataset.ttsPreview || '').trim();
            const sample = this.getTtsPreviewSample(sampleId);
            const previewMessageId = this.getTtsPreviewMessageId(sampleId);
            const isLoading = Boolean(sample) && this.ttsManager?.isLoadingMessage?.(previewMessageId) === true;
            const isPlaying = Boolean(sample) && this.ttsManager?.isPlayingMessage?.(previewMessageId) === true;
            const title = !sample
                ? 'Preview unavailable'
                : (!available
                    ? `${this.getTtsFeatureLabel()} unavailable`
                    : (isPlaying ? `Stop preview: ${sample.label}` : `Preview: ${sample.label}`));

            button.disabled = !available || !sample || isLoading;
            button.title = title;
            button.setAttribute('aria-label', title);
            button.classList.toggle('is-active', isPlaying);
            button.classList.toggle('is-loading', isLoading);
        });
    }

    async playTtsPreview(sampleId = '') {
        const sample = this.getTtsPreviewSample(sampleId);
        if (!sample) {
            return;
        }

        if (!this.isTtsAvailable()) {
            const diagnostics = this.getTtsDiagnostics();
            this.showToast(
                String(diagnostics.message || 'Voice playback is unavailable.'),
                'warning',
                this.getTtsFeatureLabel(),
            );
            return;
        }

        try {
            await this.ttsManager?.toggleMessagePlayback?.({
                messageId: this.getTtsPreviewMessageId(sample.id),
                text: sample.text,
            });
        } catch (error) {
            this.showToast(error.message || 'Failed to preview the voice sample.', 'error', this.getTtsFeatureLabel());
        }
    }

    setTtsAutoPlayEnabled(value) {
        this.ttsManager?.setAutoPlayEnabled?.(value === true);
        this.updateTtsUI();
    }

    toggleTtsAutoPlay() {
        if (!this.isTtsAvailable()) {
            const diagnostics = this.getTtsDiagnostics();
            this.showToast(
                String(diagnostics.message || 'Voice playback is unavailable.'),
                'warning',
                this.getTtsFeatureLabel(),
            );
            return;
        }

        const nextValue = !this.isTtsAutoPlayEnabled();
        this.setTtsAutoPlayEnabled(nextValue);
        this.showToast(
            nextValue ? 'Assistant replies will play aloud' : 'Assistant reply autoplay stopped',
            'success',
            this.getTtsFeatureLabel(),
        );
    }

    buildSurveySpeechSummary(survey = {}, message = null) {
        const surveyState = message?.surveyState && typeof message.surveyState === 'object'
            ? message.surveyState
            : {};
        const steps = Array.isArray(survey?.steps) ? survey.steps : [];
        const currentStepIndex = this.getSurveyCurrentStepIndex(survey, surveyState);
        const currentStep = steps[currentStepIndex] || steps[0] || null;
        const options = currentStep
            ? this.buildRenderedSurveyOptions(currentStep)
                .map((option) => String(option?.label || option?.id || '').trim())
                .filter(Boolean)
            : [];
        const answeredSummary = this.buildSurveyAnsweredSummary(surveyState, survey);
        const parts = [
            String(survey.title || '').trim(),
            String(survey.question || '').trim(),
            String(currentStep?.question || '').trim(),
            String(currentStep?.description || currentStep?.whyThisMatters || '').trim(),
            surveyState?.status === 'answered' && answeredSummary
                ? `Current answer: ${answeredSummary}.`
                : '',
            surveyState?.status !== 'answered' && options.length > 0
                ? `Options: ${options.join(', ')}.`
                : '',
        ].filter(Boolean);

        return parts.join('\n\n').trim();
    }

    shouldPreferAssistantContentOverDisplayContent(message = null) {
        if (!message || message.role !== 'assistant') {
            return false;
        }

        const displayContent = this.extractMessageContentText(message.displayContent);
        const content = this.extractMessageContentText(message.content);
        if (!displayContent || !content || displayContent === content) {
            return false;
        }

        if (/^working in background\b/i.test(content)) {
            return false;
        }

        if (/^\s*(?:```(?:html)?\s*)?(?:html\s+)?(?:<!doctype\s+html\b|<html\b)/i.test(content)
            || /```html\b[\s\S]*?(?:<!doctype\s+html\b|<html\b)[\s\S]*?```/i.test(content)
            || /\b(?:save|saved|saving|download|open)\b[\s\S]{0,80}?\b[a-z0-9][a-z0-9._ -]{1,100}\.html?\b/i.test(content)
            || (
                /\/api\/artifacts\/[a-z0-9-]+\/(?:preview|sandbox|download|bundle)\b/i.test(content)
                && (
                    /\b(?:created|generated|saved|built)\b[\s\S]{0,160}\b(?:artifact|bundle|file|html|site|page|zip)\b/i.test(content)
                    || /\b(?:play it|preview|open site|open page|download zip|download bundle|download)\s*:/i.test(content)
                )
            )) {
            return false;
        }

        if (this.extractSurveyDefinitionFromContent(displayContent, message.id || '')) {
            return false;
        }

        const artifacts = Array.isArray(message.artifacts) ? message.artifacts : [];
        const artifactSummary = String(window.artifactManager?.buildArtifactSummary?.(artifacts) || '').trim();
        return Boolean(artifactSummary) && displayContent === artifactSummary;
    }

    resolveAssistantVisibleContent(message = null) {
        if (!message || message.role !== 'assistant') {
            return this.extractMessageContentText(message?.displayContent ?? message?.content ?? '');
        }

        if (this.shouldPreferAssistantContentOverDisplayContent(message)) {
            return this.extractMessageContentText(message.content);
        }

        const displayContent = this.extractMessageContentText(message.displayContent);
        if (displayContent) {
            return displayContent;
        }

        return this.extractMessageContentText(message.content);
    }

    buildSpeakableMessageText(message = null) {
        if (!message || message.role !== 'assistant') {
            return '';
        }

        const source = this.resolveAssistantVisibleContent(message);
        if (!source) {
            return '';
        }

        const survey = this.extractSurveyDefinitionFromContent(source, message.id || '');
        if (survey) {
            return this.buildSurveySpeechSummary(survey, message);
        }

        return source;
    }

    getMessageSpeechControlState(messageId = '', message = null) {
        const normalizedMessageId = String(messageId || '').trim();
        const speakableText = this.buildSpeakableMessageText(message);
        const available = this.isTtsAvailable();
        const visible = available && Boolean(speakableText) && message?.isStreaming !== true;
        const isLoading = this.ttsManager?.isLoadingMessage?.(normalizedMessageId) === true;
        const isPlaying = this.ttsManager?.isPlayingMessage?.(normalizedMessageId) === true;
        const disabled = !visible || isLoading;
        const title = !speakableText
            ? 'No readable text in this message'
            : (!available
                ? `${this.getTtsFeatureLabel()} unavailable`
                : (isPlaying ? 'Stop voice playback' : `Read aloud with ${this.getTtsProviderLabel()}`));

        return {
            visible,
            disabled,
            isLoading,
            isPlaying,
            title,
            icon: isLoading ? 'loader-2' : (isPlaying ? 'square' : 'volume-2'),
        };
    }

    buildMessageSpeechButtonMarkup(messageId = '', message = null) {
        const state = this.getMessageSpeechControlState(messageId, message);
        if (!state.visible) {
            return '';
        }

        return `
            <button
                class="message-action-btn${state.isPlaying ? ' is-active' : ''}${state.isLoading ? ' is-loading' : ''}"
                data-tts-message-id="${this.escapeHtmlAttr(messageId)}"
                onclick="uiHelpers.toggleMessageSpeech('${this.escapeHtmlAttr(messageId)}')"
                title="${this.escapeHtmlAttr(state.title)}"
                aria-label="${this.escapeHtmlAttr(state.title)}"
                ${state.disabled ? 'disabled' : ''}
            >
                <i data-lucide="${state.icon}" class="w-4 h-4${state.isLoading ? ' animate-spin' : ''}" aria-hidden="true"></i>
            </button>
        `;
    }

    buildAlignmentFeedbackButtonsMarkup(messageId = '', message = null) {
        if (!message || message.role === 'user' || message.isStreaming === true) {
            return '';
        }

        const feedback = message?.metadata?.alignmentFeedback && typeof message.metadata.alignmentFeedback === 'object'
            ? message.metadata.alignmentFeedback
            : {};
        const rating = String(feedback.rating || '').trim();
        const status = String(feedback.status || '').trim();
        const hasVote = rating === 'up' || rating === 'down';
        const reviewing = status === 'evaluating';
        const upActive = rating === 'up';
        const downActive = rating === 'down';
        const upTitle = upActive ? 'Aligned' : 'Mark response aligned';
        const downTitle = reviewing
            ? 'Reviewing alignment'
            : (downActive ? (status === 'failed' ? 'Alignment review failed' : 'Alignment review saved') : 'Review alignment');

        return `
            <button
                class="message-action-btn alignment-feedback-btn${upActive ? ' is-active is-positive' : ''}"
                data-alignment-rating="up"
                onclick="uiHelpers.submitAlignmentFeedback('${this.escapeHtmlAttr(messageId)}', 'up')"
                title="${this.escapeHtmlAttr(upTitle)}"
                aria-label="${this.escapeHtmlAttr(upTitle)}"
                ${hasVote ? 'disabled' : ''}
            >
                <i data-lucide="thumbs-up" class="w-4 h-4" aria-hidden="true"></i>
            </button>
            <button
                class="message-action-btn alignment-feedback-btn${downActive ? ' is-active is-negative' : ''}${reviewing ? ' is-loading' : ''}"
                data-alignment-rating="down"
                onclick="uiHelpers.submitAlignmentFeedback('${this.escapeHtmlAttr(messageId)}', 'down')"
                title="${this.escapeHtmlAttr(downTitle)}"
                aria-label="${this.escapeHtmlAttr(downTitle)}"
                ${hasVote ? 'disabled' : ''}
            >
                <i data-lucide="${reviewing ? 'loader-2' : 'thumbs-down'}" class="w-4 h-4${reviewing ? ' animate-spin' : ''}" aria-hidden="true"></i>
            </button>
        `;
    }

    updateMessageSpeechButton(button, message = null) {
        const messageId = String(button?.dataset?.ttsMessageId || '').trim();
        if (!button || !messageId) {
            return;
        }

        const state = this.getMessageSpeechControlState(messageId, message);
        button.hidden = !state.visible;
        button.setAttribute('aria-hidden', state.visible ? 'false' : 'true');
        button.disabled = state.disabled;
        button.title = state.title;
        button.setAttribute('aria-label', state.title);
        button.classList.toggle('is-active', state.isPlaying);
        button.classList.toggle('is-loading', state.isLoading);
        if (!state.visible) {
            return;
        }
        button.innerHTML = `
            <i data-lucide="${state.icon}" class="w-4 h-4${state.isLoading ? ' animate-spin' : ''}" aria-hidden="true"></i>
        `;
        this.reinitializeIcons(button);
    }

    updateMessageSpeechButtons(container = document) {
        const sessionId = window.sessionManager?.currentSessionId || null;
        if (!sessionId || !container?.querySelectorAll) {
            return;
        }

        container.querySelectorAll('[data-tts-message-id]').forEach((button) => {
            const messageId = String(button.dataset.ttsMessageId || '').trim();
            const message = typeof window.sessionManager?.getMessage === 'function'
                ? window.sessionManager.getMessage(sessionId, messageId)
                : window.sessionManager?.getMessages?.(sessionId)?.find((entry) => entry.id === messageId);
            this.updateMessageSpeechButton(button, message || null);
        });
    }

    async toggleMessageSpeech(messageId = '') {
        const sessionId = window.sessionManager?.currentSessionId || null;
        if (!sessionId || !messageId) {
            return;
        }

        const message = typeof window.sessionManager?.getMessage === 'function'
            ? window.sessionManager.getMessage(sessionId, messageId)
            : window.sessionManager?.getMessages?.(sessionId)?.find((entry) => entry.id === messageId);
        const speakableText = this.buildSpeakableMessageText(message);

        if (!speakableText) {
            this.showToast('There is no readable text in this assistant message.', 'info', this.getTtsFeatureLabel());
            return;
        }

        try {
            await this.ttsManager?.toggleMessagePlayback?.({
                messageId,
                text: speakableText,
            });
        } catch (error) {
            this.showToast(error.message || 'Failed to generate voice playback.', 'error', this.getTtsFeatureLabel());
        }
    }

    stopSpeechPlayback() {
        this.ttsManager?.stop?.();
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

    getMessageElementById(messageId = '') {
        const normalizedMessageId = String(messageId || '').trim();
        if (!normalizedMessageId || !document?.querySelectorAll) {
            return null;
        }

        return Array.from(document.querySelectorAll('.message[data-message-id]'))
            .find((element) => String(element?.dataset?.messageId || '').trim() === normalizedMessageId)
            || null;
    }

    clearSpeechHighlights(messageId = '', options = {}) {
        const messageEl = messageId ? this.getMessageElementById(messageId) : null;
        const root = messageEl || document;
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
            'pre, code, kbd, samp, script, style, textarea, input, button, svg, .message-actions, .tts-reading-highlight',
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
        ].filter((candidate, index, list) => (
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

            const start = textMap.positions[matchIndex];
            const end = textMap.positions[Math.min(textMap.positions.length - 1, matchIndex + candidate.length - 1)];
            if (!start?.node || !end?.node) {
                continue;
            }

            const range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset + 1);
            return {
                range,
                endIndex: matchIndex + candidate.length,
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

        const start = textMap.positions[Math.max(0, Number(section.startIndex) || 0)];
        const end = textMap.positions[Math.min(textMap.positions.length - 1, Math.max(Number(section.startIndex) || 0, Number(section.endIndex) - 1))];
        if (!start?.node || !end?.node) {
            return null;
        }

        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset + 1);
        return {
            range,
            endIndex: Number(section.endIndex) || 0,
        };
    }

    highlightSpeechChunk(messageId = '', chunkText = '', options = {}) {
        const normalizedMessageId = String(messageId || '').trim();
        if (!normalizedMessageId || normalizedMessageId.startsWith('tts-preview:')) {
            return false;
        }

        const messageEl = this.getMessageElementById(normalizedMessageId);
        const textRoot = messageEl?.querySelector?.('.message-text');
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
            console.warn('[WebChatUI] Failed to highlight spoken text:', error);
            this.clearSpeechHighlights();
            return false;
        }
    }

    handleTtsChunkStart(event = null) {
        const detail = event?.detail || {};
        this.highlightSpeechChunk(detail.messageId || '', detail.chunkText || '', {
            chunkIndex: detail.chunkIndex,
        });
    }

    handleTtsChunkEnd(event = null) {
        const detail = event?.detail || {};
        const chunkIndex = Number(detail.chunkIndex);
        const chunkCount = Number(detail.chunkCount);
        if (Number.isFinite(chunkIndex) && Number.isFinite(chunkCount) && chunkCount > 0 && chunkIndex >= chunkCount - 1) {
            setTimeout(() => this.clearSpeechHighlights(detail.messageId || ''), 120);
        }
    }

    getCurrentModel() {
        return this.currentModel;
    }

    setCurrentModel(modelId) {
        this.currentModel = modelId;
        window.sessionManager?.safeStorageSet?.('kimibuilt_default_model', modelId);
        this.updateModelUI();
    }

    // ============================================
    // Code Highlighting
    // ============================================

    highlightCodeBlocks(container) {
        const codeBlocks = container.querySelectorAll('pre code');
        codeBlocks.forEach(block => {
            if (block.classList.contains('language-mermaid') || block.classList.contains('no-highlight')) {
                return;
            }
            if (window.Prism) {
                try {
                    Prism.highlightElement(block);
                } catch (err) {
                    // Silently skip highlighting for problematic languages
                    console.warn('[UI] Syntax highlighting failed:', err.message);
                }
            }
        });
    }

    async copyCode(button) {
        const code = button?.dataset?.code || '';
        
        try {
            await navigator.clipboard.writeText(code);
            
            // Show copied state
            const originalHTML = button.innerHTML;
            button.classList.add('copied');
            button.innerHTML = `
                <i data-lucide="check" class="w-3.5 h-3.5" aria-hidden="true"></i>
                <span>Copied!</span>
            `;
            this.reinitializeIcons(button);
            
            // Revert after 2 seconds
            setTimeout(() => {
                button.classList.remove('copied');
                button.innerHTML = originalHTML;
                this.reinitializeIcons(button);
            }, 2000);
            
        } catch (err) {
            console.error('Failed to copy code:', err);
            this.showToast('Failed to copy code', 'error');
        }
    }

    getInlineHtmlSourceFromElement(element) {
        const block = element?.closest?.('.html-code-block');
        const sourceEl = block?.querySelector?.('.html-preview-source');
        const source = sourceEl && 'value' in sourceEl
            ? sourceEl.value
            : (sourceEl?.textContent || element?.dataset?.code || '');
        return String(source || '').trim();
    }

    getInlineHtmlSourceSignature(source = '') {
        const normalized = String(source || '');
        return [
            normalized.length,
            normalized.slice(0, 64),
            normalized.slice(-64),
        ].join(':');
    }

    async copyInlineHtml(button) {
        const source = this.getInlineHtmlSourceFromElement(button);
        if (!source) {
            this.showToast('No HTML source to copy', 'error');
            return;
        }

        try {
            await navigator.clipboard.writeText(source);

            const originalHTML = button.innerHTML;
            button.classList.add('copied');
            button.innerHTML = `
                <i data-lucide="check" class="w-3.5 h-3.5" aria-hidden="true"></i>
                <span>Copied!</span>
            `;
            this.reinitializeIcons(button);

            setTimeout(() => {
                button.classList.remove('copied');
                button.innerHTML = originalHTML;
                this.reinitializeIcons(button);
            }, 2000);
        } catch (error) {
            console.error('Failed to copy HTML:', error);
            this.showToast('Failed to copy HTML', 'error');
        }
    }

    normalizeMermaidSource(text = '') {
        let source = String(text || '')
            .replace(/\r\n?/g, '\n')
            .trim();

        if (!source) {
            return '';
        }

        source = source.replace(/^```mermaid\s*/i, '');
        source = source.replace(/^```\s*/i, '');
        source = source.replace(/```\s*$/i, '');

        const whitespaceSensitive = /^mindmap\b/i.test(source);

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

    getMermaidFilename(baseName = 'diagram', extension = 'mmd') {
        return this.sanitizeDownloadFilename(baseName, 'diagram', extension);
    }

    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = this.sanitizeDownloadFilename(filename, 'download');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    async persistGeneratedFile(blob, filename, mimeType = '') {
        if (!window.artifactManager?.persistGeneratedFile) {
            return;
        }

        try {
            await window.artifactManager.persistGeneratedFile(blob, filename, mimeType || blob.type || 'application/octet-stream');
        } catch (error) {
            console.warn('[UI] Failed to persist generated Mermaid file:', error);
        }
    }

    async fetchMermaidSourceFromUrl(url = '') {
        const targetUrl = String(url || '').trim();
        if (!targetUrl) {
            return '';
        }

        const response = await fetch(targetUrl, {
            credentials: 'same-origin',
        });
        if (!response.ok) {
            throw new Error(`Failed to load Mermaid source (${response.status})`);
        }

        return this.normalizeMermaidSource(await response.text());
    }

    async resolveMermaidSource(element = null) {
        if (!element) {
            return '';
        }

        const fetchUrl = String(element?.dataset?.mermaidUrl || '').trim();
        if (fetchUrl) {
            try {
                const fetchedSource = await this.fetchMermaidSourceFromUrl(fetchUrl);
                if (fetchedSource) {
                    if (element?.dataset) {
                        element.dataset.code = fetchedSource;
                        element.dataset.mermaidSource = fetchedSource;
                    }
                    return fetchedSource;
                }
            } catch (error) {
                console.warn('[UI] Failed to fetch Mermaid artifact source:', error);
            }
        }

        return this.normalizeMermaidSource(
            element?.dataset?.code
            || element?.dataset?.mermaidSource
            || '',
        );
    }

    async getMermaidSourceFromButton(button) {
        return this.resolveMermaidSource(button);
    }

    async downloadMermaidSource(button) {
        const source = await this.getMermaidSourceFromButton(button);
        if (!source) {
            this.showToast('No Mermaid source to download', 'error');
            return;
        }

        const filename = this.getMermaidFilename(button?.dataset?.filename || 'diagram', 'mmd');
        const blob = new Blob([source], { type: 'text/plain;charset=utf-8' });
        this.downloadBlob(blob, filename);
        await this.persistGeneratedFile(blob, filename, 'text/plain');
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

    async createMermaidPdfBlobFromSource(source, title = 'diagram') {
        if (!window.PDFLib?.PDFDocument) {
            throw new Error('PDF library is not available');
        }
        if (typeof mermaid === 'undefined') {
            throw new Error('Mermaid is not available');
        }

        const renderId = `mermaid-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await mermaid.render(renderId, source);
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
        const drawWidth = pngImage.width * scale;
        const drawHeight = pngImage.height * scale;

        page.drawImage(pngImage, {
            x: (pageWidth - drawWidth) / 2,
            y: (pageHeight - drawHeight) / 2,
            width: drawWidth,
            height: drawHeight,
        });

        const pdfBytes = await pdfDoc.save({
            updateFieldAppearances: false,
            useObjectStreams: false,
        });

        return new Blob([pdfBytes], { type: 'application/pdf' });
    }

    async downloadMermaidPdf(button) {
        const source = await this.getMermaidSourceFromButton(button);
        if (!source) {
            this.showToast('No Mermaid source to export', 'error');
            return;
        }

        const filename = this.getMermaidFilename(button?.dataset?.filename || 'diagram', 'pdf');

        try {
            const pdfBlob = await this.createMermaidPdfBlobFromSource(source, filename.replace(/\.pdf$/i, ''));
            this.downloadBlob(pdfBlob, filename);
            await this.persistGeneratedFile(pdfBlob, filename, 'application/pdf');
            this.showToast('Mermaid PDF ready', 'success');
        } catch (error) {
            console.error('[UI] Mermaid PDF export failed:', error);
            this.showToast(`Failed to export Mermaid PDF: ${error.message}`, 'error');
        }
    }

    async downloadInlineHtml(button) {
        const source = this.getInlineHtmlSourceFromElement(button);
        if (!source) {
            this.showToast('No HTML source to download', 'error');
            return;
        }

        const filename = this.sanitizeDownloadFilename(
            button?.dataset?.filename || this.createUniqueFilename('preview', 'html', 'preview'),
            'preview',
            'html',
        );
        const blob = new Blob([source], { type: 'text/html;charset=utf-8' });
        this.downloadBlob(blob, filename);
        await this.persistGeneratedFile(blob, filename, 'text/html');
    }

    getHtmlPreviewSurface(element) {
        return element?.closest?.('.html-preview-wrapper')?.querySelector?.('.html-preview-surface')
            || element?.closest?.('.html-preview-surface')
            || null;
    }

    getHtmlPreviewControls(surface) {
        const wrapper = surface?.closest?.('.html-preview-wrapper');
        return {
            start: wrapper?.querySelector?.('[data-html-preview-action="start"]') || null,
            stop: wrapper?.querySelector?.('[data-html-preview-action="stop"]') || null,
        };
    }

    shouldAutostartHtmlPreview(surface) {
        const messageEl = surface?.closest?.('.message.assistant');
        if (!messageEl) {
            return false;
        }

        const timestamp = Date.parse(messageEl.dataset.messageTimestamp || '');
        if (!Number.isFinite(timestamp)) {
            return false;
        }

        return timestamp >= this.htmlPreviewPageLoadedAt - this.htmlPreviewAutostartWindowMs;
    }

    setHtmlPreviewState(surface, active, label = '') {
        if (!surface) {
            return;
        }

        const controls = this.getHtmlPreviewControls(surface);
        surface.dataset.htmlPreviewActive = active ? 'true' : 'false';
        if (controls.start) {
            controls.start.disabled = active;
        }
        if (controls.stop) {
            controls.stop.disabled = !active;
        }
        if (label) {
            const wrapper = surface.closest('.html-preview-wrapper');
            const status = wrapper?.querySelector?.('.html-preview-label');
            if (status) {
                status.textContent = label;
            }
        }
    }

    startInlineHtmlPreview(element) {
        const surface = this.getHtmlPreviewSurface(element);
        const source = this.getInlineHtmlSourceFromElement(surface);
        if (!surface || !source) {
            this.showToast('No HTML preview source found', 'error');
            return;
        }

        const sourceSignature = this.getInlineHtmlSourceSignature(source);
        const existingIframe = surface.querySelector('iframe');
        if (existingIframe && surface.dataset.htmlRenderedSource === sourceSignature) {
            this.setHtmlPreviewState(surface, true, 'Live preview');
            return;
        }

        const iframe = document.createElement('iframe');
        iframe.loading = 'lazy';
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
        iframe.referrerPolicy = 'no-referrer';
        iframe.srcdoc = source;

        surface.innerHTML = '';
        surface.appendChild(iframe);
        surface.dataset.htmlRenderedSource = sourceSignature;
        this.setHtmlPreviewState(surface, true, 'Live preview');
    }

    stopInlineHtmlPreview(element) {
        const surface = this.getHtmlPreviewSurface(element);
        if (!surface) {
            return;
        }

        surface.innerHTML = '<div class="html-preview-placeholder">Preview stopped. Start it when you want to run this HTML.</div>';
        delete surface.dataset.htmlRenderedSource;
        this.setHtmlPreviewState(surface, false, 'Preview stopped');
    }

    renderHtmlPreviews(container = document) {
        const targets = Array.from(container.querySelectorAll('.html-preview-surface'));
        targets.forEach((target) => {
            const source = this.getInlineHtmlSourceFromElement(target);
            const sourceSignature = this.getInlineHtmlSourceSignature(source);
            if (!source) {
                return;
            }

            if (target.dataset.htmlPreviewActive === 'true') {
                if (target.dataset.htmlRenderedSource !== sourceSignature) {
                    this.startInlineHtmlPreview(target);
                }
                return;
            }

            if (this.shouldAutostartHtmlPreview(target)) {
                this.startInlineHtmlPreview(target);
                return;
            }

            if (!target.querySelector('.html-preview-placeholder')) {
                target.innerHTML = '<div class="html-preview-placeholder">Preview stopped. Start it when you want to run this HTML.</div>';
            }
            this.setHtmlPreviewState(target, false, 'Preview stopped');
        });
    }

    async renderMermaidDiagrams(container = document) {
        if (typeof mermaid === 'undefined') {
            return;
        }

        const targets = Array.from(container.querySelectorAll('.mermaid-render-surface'));
        for (const target of targets) {
            try {
                const source = await this.resolveMermaidSource(target);
                if (!source || target.dataset.mermaidRenderedSource === source) {
                    continue;
                }

                const renderId = `mermaid-inline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const result = await mermaid.render(renderId, source);
                target.innerHTML = result.svg;
                target.dataset.mermaidRenderedSource = source;
                if (typeof result.bindFunctions === 'function') {
                    result.bindFunctions(target);
                }
            } catch (error) {
                const source = this.normalizeMermaidSource(target.dataset.mermaidSource || target.dataset.code || '');
                target.innerHTML = `
                    <div class="mermaid-render-error">Mermaid render failed: ${this.escapeHtml(error.message)}</div>
                    <pre class="mermaid-source-block"><code>${this.escapeHtml(source)}</code></pre>
                `;
                delete target.dataset.mermaidRenderedSource;
            }
        }
    }

    // ============================================
    // Session List Rendering
    // ============================================

    startSessionRename(sessionId) {
        const session = sessionManager.sessions.find((entry) => entry.id === sessionId);
        if (!session) {
            return;
        }

        this.renamingSessionId = sessionId;
        this.pendingSessionRenameTitle = session.title || 'New Chat';
        this.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
    }

    cancelSessionRename() {
        if (!this.renamingSessionId) {
            return;
        }

        this.renamingSessionId = null;
        this.pendingSessionRenameTitle = '';
        this.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
    }

    async submitSessionRename(sessionId, value = '') {
        const normalizedSessionId = String(sessionId || this.renamingSessionId || '').trim();
        if (!normalizedSessionId) {
            return;
        }

        const nextTitle = String(value || this.pendingSessionRenameTitle || '').trim();
        this.renamingSessionId = null;
        this.pendingSessionRenameTitle = '';

        const result = await sessionManager.renameSession(normalizedSessionId, nextTitle);
        if (!result?.session) {
            this.renderSessionsList(sessionManager.sessions, sessionManager.currentSessionId);
            this.showToast('Unable to rename conversation', 'error');
            return;
        }

        if (result.persisted === false && !sessionManager.isLocalSession(normalizedSessionId)) {
            this.showToast('Conversation renamed locally, but the backend copy did not sync.', 'warning', 'Rename pending');
        }
    }

    getSessionScopeLabel(session = {}) {
        const metadata = session?.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
            ? session.metadata
            : {};
        const rawScope = String(
            session.scopeKey
            || metadata.workspaceKey
            || metadata.workspace_key
            || metadata.memoryScope
            || metadata.memory_scope
            || metadata.projectScope
            || metadata.project_scope
            || '',
        ).trim();

        if (!rawScope) {
            return '';
        }

        const normalized = rawScope.toLowerCase();
        const workspaceMatch = normalized.match(/(?:web-chat-)?workspace-(\d+)$/);
        if (workspaceMatch) {
            return `Workspace ${workspaceMatch[1]}`;
        }

        if (normalized === 'web-chat') {
            return 'Workspace 1';
        }

        return rawScope
            .replace(/[-_]+/g, ' ')
            .replace(/\b\w/g, (char) => char.toUpperCase());
    }

    renderSessionsList(sessions, currentSessionId) {
        if (sessions.length === 0) {
            this.renamingSessionId = null;
            this.pendingSessionRenameTitle = '';
            this.sessionsList.innerHTML = `
                <div class="empty-state py-8">
                    <i data-lucide="message-square" class="w-12 h-12 mb-3 text-text-muted" aria-hidden="true"></i>
                    <p class="text-sm text-text-secondary">No conversations yet</p>
                    <p class="text-xs text-text-muted mt-1">Start a new chat to begin</p>
                </div>
            `;
            this.reinitializeIcons(this.sessionsList);
            return;
        }

        if (this.renamingSessionId && !sessions.some((session) => session.id === this.renamingSessionId)) {
            this.renamingSessionId = null;
            this.pendingSessionRenameTitle = '';
        }

        this.sessionsList.innerHTML = sessions.map(session => {
            const isActive = session.id === currentSessionId;
            const isEditing = session.id === this.renamingSessionId;
            const modeIcon = sessionManager.getSessionModeIcon(session.mode);
            const modeClass = session.mode || 'chat';
            const timeAgo = sessionManager.formatTimestamp(session.updatedAt);
            const messageCount = sessionManager.getMessages(session.id)?.length || 0;
            const scopeLabel = this.getSessionScopeLabel(session);
            const workloadSummary = session.workloadSummary || { queued: 0, running: 0, failed: 0 };
            const workloadBadge = workloadSummary.running > 0
                ? `${workloadSummary.running} running`
                : workloadSummary.queued > 0
                    ? `${workloadSummary.queued} queued`
                    : workloadSummary.failed > 0
                        ? `${workloadSummary.failed} failed`
                        : '';
            const renameValue = this.escapeHtmlAttr(this.pendingSessionRenameTitle || session.title || 'New Chat');
            
            return `
                <div class="session-item ${isActive ? 'active' : ''} ${isEditing ? 'editing' : ''}" data-session-id="${session.id}" role="${isEditing ? 'group' : 'button'}" tabindex="${isEditing ? '-1' : '0'}" aria-label="${this.escapeHtmlAttr(session.title || 'New Chat')}" title="${this.escapeHtmlAttr(session.title || 'New Chat')}">
                    <div class="session-icon ${modeClass}" aria-hidden="true">
                        <i data-lucide="${modeIcon}" class="w-4 h-4 text-white"></i>
                    </div>
                    <div class="session-info sidebar-session-info">
                        ${isEditing ? `
                            <form class="session-rename-form" data-session-id="${session.id}">
                                <input
                                    class="session-rename-input"
                                    data-session-id="${session.id}"
                                    type="text"
                                    value="${renameValue}"
                                    maxlength="120"
                                    autocomplete="off"
                                    spellcheck="false"
                                    aria-label="Conversation name"
                                >
                                <div class="session-rename-actions">
                                    <span class="session-edit-hint">Enter to save, Esc to cancel</span>
                                    <div class="session-rename-actions-buttons">
                                        <button class="btn-icon save-session-rename-btn" data-session-id="${session.id}" type="submit" title="Save conversation name" aria-label="Save conversation name">
                                            <i data-lucide="check" class="w-4 h-4" aria-hidden="true"></i>
                                        </button>
                                        <button class="btn-icon cancel-session-rename-btn" data-session-id="${session.id}" type="button" title="Cancel rename" aria-label="Cancel rename">
                                            <i data-lucide="x" class="w-4 h-4" aria-hidden="true"></i>
                                        </button>
                                    </div>
                                </div>
                            </form>
                        ` : `
                            <div class="session-title-row">
                                <div class="session-title">${this.escapeHtml(session.title || 'New Chat')}</div>
                                ${workloadBadge ? `<span class="session-workload-badge">${this.escapeHtml(workloadBadge)}</span>` : ''}
                            </div>
                            <div class="session-meta">
                                <span>${timeAgo}</span>
                                <span aria-hidden="true">|</span>
                                <span>${messageCount} message${messageCount !== 1 ? 's' : ''}</span>
                                ${scopeLabel ? `<span aria-hidden="true">|</span><span class="session-scope-label">${this.escapeHtml(scopeLabel)}</span>` : ''}
                            </div>
                        `}
                    </div>
                    <div class="session-actions">
                        <button class="btn-icon p-1.5 rounded rename-session-btn" data-session-id="${session.id}" title="Rename conversation" aria-label="Rename conversation">
                            <i data-lucide="pencil" class="w-4 h-4" aria-hidden="true"></i>
                        </button>
                        <button class="btn-icon danger p-1.5 rounded delete-session-btn" data-session-id="${session.id}" title="Delete conversation" aria-label="Delete conversation">
                            <i data-lucide="trash-2" class="w-4 h-4" aria-hidden="true"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        this.reinitializeIcons(this.sessionsList);
        this.attachSessionListeners();

        if (this.renamingSessionId) {
            requestAnimationFrame(() => {
                const renameInput = this.sessionsList.querySelector('.session-rename-input');
                if (renameInput) {
                    renameInput.focus();
                    renameInput.setSelectionRange(0, renameInput.value.length);
                }
            });
        }
    }

    attachSessionListeners() {
        // Session item clicks (for switching)
        this.sessionsList.querySelectorAll('.session-item').forEach(item => {
            const clickHandler = (e) => {
                // Don't switch if clicking delete button
                if (item.classList.contains('editing')
                    || e.target.closest('.delete-session-btn')
                    || e.target.closest('.rename-session-btn')
                    || e.target.closest('.session-rename-form')) {
                    return;
                }
                
                const sessionId = item.dataset.sessionId;
                sessionManager.switchSession(sessionId);
            };
            
            item.addEventListener('click', clickHandler);
            
            // Keyboard support
            item.addEventListener('keydown', (e) => {
                if (e.key === 'F2') {
                    e.preventDefault();
                    this.startSessionRename(item.dataset.sessionId);
                    return;
                }

                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    clickHandler(e);
                }
            });
        });

        this.sessionsList.querySelectorAll('.rename-session-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.startSessionRename(btn.dataset.sessionId);
            });
        });

        this.sessionsList.querySelectorAll('.session-rename-form').forEach(form => {
            form.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            form.addEventListener('submit', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const input = form.querySelector('.session-rename-input');
                this.pendingSessionRenameTitle = input?.value || '';
                void this.submitSessionRename(form.dataset.sessionId, input?.value || '');
            });
        });

        this.sessionsList.querySelectorAll('.session-rename-input').forEach(input => {
            input.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            input.addEventListener('input', () => {
                this.pendingSessionRenameTitle = input.value;
            });

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.cancelSessionRename();
                }
            });
        });

        this.sessionsList.querySelectorAll('.cancel-session-rename-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.cancelSessionRename();
            });
        });

        // Delete buttons
        this.sessionsList.querySelectorAll('.delete-session-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sessionId = btn.dataset.sessionId;
                this.confirmDeleteSession(sessionId);
            });
        });
    }

    confirmDeleteSession(sessionId) {
        const session = sessionManager.sessions.find(s => s.id === sessionId);
        const title = session?.title || 'this conversation';
        
        if (confirm(`Delete "${title}"?\n\nThis action cannot be undone.`)) {
            sessionManager.deleteSession(sessionId);
            this.showToast('Conversation deleted', 'success');
        }
    }

    // ============================================
    // Connection Status
    // ============================================

    updateConnectionStatus(status) {
        const statusEl = document.getElementById('connection-status');
        const dotEl = document.getElementById('status-dot');
        const textEl = document.getElementById('status-text');

        if (!statusEl || !dotEl || !textEl) return;

        // Remove all status classes
        statusEl.classList.remove('connected', 'connecting', 'disconnected');
        dotEl.classList.remove('connected', 'connecting', 'disconnected');

        switch (status) {
            case 'connected':
                statusEl.classList.add('connected');
                dotEl.classList.add('connected');
                textEl.textContent = 'Connected';
                break;
            case 'connecting':
                statusEl.classList.add('connecting');
                dotEl.classList.add('connecting');
                textEl.textContent = 'Connecting...';
                break;
            case 'disconnected':
            default:
                statusEl.classList.add('disconnected');
                dotEl.classList.add('disconnected');
                textEl.textContent = 'Disconnected';
                break;
        }
    }

    // ============================================
    // Layout Management
    // ============================================

    getDefaultLayoutMode() {
        return window.matchMedia('(max-width: 768px)').matches ? 'minimal' : 'full';
    }

    initLayoutMode(appInstance = null) {
        const savedLayoutMode = this.storageGet(this.layoutPreferenceKey);
        const initialMode = savedLayoutMode === 'minimal' || savedLayoutMode === 'full'
            ? savedLayoutMode
            : this.getDefaultLayoutMode();
        this.applyLayoutMode(initialMode, { persist: false, appInstance });
    }

    isMinimalistMode() {
        return this.layoutMode === 'minimal';
    }

    toggleMinimalistMode(options = {}) {
        const nextMode = this.isMinimalistMode() ? 'full' : 'minimal';
        this.applyLayoutMode(nextMode, { persist: true, ...options });
    }

    applyLayoutMode(mode, options = {}) {
        const normalizedMode = mode === 'minimal' ? 'minimal' : 'full';
        const persist = options.persist !== false;
        const appInstance = options.appInstance || window.chatApp;

        this.layoutMode = normalizedMode;
        this.closeMobileActionSheet();

        document.body.classList.toggle('layout-minimal', normalizedMode === 'minimal');
        document.documentElement.setAttribute('data-layout-mode', normalizedMode);

        if (persist) {
            this.storageSet(this.layoutPreferenceKey, normalizedMode);
        }

        if (normalizedMode === 'minimal') {
            this.closeSidebar();
            this.closeSearch();
            this.closeModelSelector();
            this.ensureMobileMinimalComposer();

            if (appInstance?.workloadsOpen) {
                appInstance.workloadsOpen = false;
            }
            appInstance?.syncWorkloadsPanelState?.();
        }

        this.syncSidebarState();
        this.updateMinimalistToggleUI();
        appInstance?.updateSessionInfo?.();
        appInstance?.renderProjectViewport?.();

        if (normalizedMode === 'minimal') {
            setTimeout(() => {
                document.getElementById('message-input')?.focus();
            }, 120);
        }
    }

    ensureMobileMinimalComposer() {
        if (!window.matchMedia('(max-width: 640px)').matches) {
            return;
        }

        const inputArea = document.getElementById('input-area');
        const toggleBtn = document.getElementById('input-toggle-btn');
        const toggleIcon = document.getElementById('input-toggle-icon');
        if (!inputArea) {
            return;
        }

        inputArea.classList.remove('hidden');
        toggleBtn?.classList.remove('input-hidden');

        if (toggleIcon) {
            toggleIcon.setAttribute('data-lucide', 'chevron-down');
            this.reinitializeIcons(toggleBtn || toggleIcon);
        }
    }

    updateMinimalistToggleUI() {
        const isMinimal = this.isMinimalistMode();
        const button = document.getElementById('minimalist-toggle-btn');
        const buttonIcon = document.getElementById('minimalist-toggle-icon');
        const sidebarButton = document.getElementById('minimalist-toggle-sidebar');
        const sidebarButtonIcon = document.getElementById('minimalist-toggle-sidebar-icon');
        const sidebarButtonText = document.getElementById('minimalist-toggle-sidebar-text');
        const buttonTitle = isMinimal ? 'Return to full interface' : 'Enter minimalist mode';
        const iconName = isMinimal ? 'maximize-2' : 'minimize-2';

        if (button) {
            button.setAttribute('title', buttonTitle);
            button.setAttribute('aria-label', buttonTitle);
            button.setAttribute('aria-pressed', isMinimal ? 'true' : 'false');
            button.classList.toggle('is-active', isMinimal);
        }

        if (sidebarButton) {
            sidebarButton.setAttribute('title', buttonTitle);
            sidebarButton.setAttribute('aria-label', buttonTitle);
            sidebarButton.classList.toggle('is-active', isMinimal);
        }

        if (sidebarButtonText) {
            sidebarButtonText.textContent = isMinimal ? 'Full Interface' : 'Focus Mode';
        }

        [buttonIcon, sidebarButtonIcon].forEach((iconNode) => {
            if (!iconNode) return;
            iconNode.setAttribute('data-lucide', iconName);
        });

        this.reinitializeIcons(button || document);
        if (sidebarButton) {
            this.reinitializeIcons(sidebarButton);
        }
        this.updateMobileActionSheetUI();
    }

    syncSidebarState() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        if (!sidebar || !overlay) {
            return;
        }

        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        const isOpen = sidebar.classList.contains('open');
        const hidden = this.isMinimalistMode() || (isMobile && !isOpen);

        overlay.classList.toggle('hidden', !isMobile || !isOpen || this.isMinimalistMode());
        sidebar.setAttribute('aria-hidden', hidden ? 'true' : 'false');
    }

    isCompactActionSheetMode() {
        return window.matchMedia('(max-width: 1120px)').matches || this.isMinimalistMode();
    }

    // ============================================
    // Theme Management
    // ============================================

    initTheme() {
        const savedPresetId = this.getSavedThemePresetId();
        const legacyTheme = String(this.storageGet(WEB_CHAT_THEME_MODE_STORAGE_KEY) || '').trim().toLowerCase();
        const shouldPersistInitialPreset = Boolean(savedPresetId) || legacyTheme === 'light' || legacyTheme === 'dark';
        const initialPresetId = savedPresetId
            || (legacyTheme ? this.mapLegacyThemeToPreset(legacyTheme) : this.getDefaultThemePresetId(this.getSystemPreferredThemeMode()));

        this.applyThemePreset(initialPresetId, {
            persist: shouldPersistInitialPreset,
            playCue: false,
            showToast: false,
        });

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            const hasSavedPreset = this.getSavedThemePresetId();
            if (!hasSavedPreset) {
                this.applyThemePreset(this.getDefaultThemePresetId(e.matches ? 'dark' : 'light'), {
                    persist: true,
                    playCue: false,
                    showToast: false,
                });
            }
        });
    }

    setTheme(theme) {
        this.applyThemePreset(this.getDefaultThemePresetId(theme === 'light' ? 'light' : 'dark'));
    }

    applyThemePreset(presetId, options = {}) {
        const preset = this.getThemePresetById(presetId);
        const root = document.documentElement;
        const prismTheme = document.getElementById('prism-theme');
        const themeColorMeta = document.querySelector('meta[name="theme-color"]');

        this.currentThemePresetId = preset.id;
        root.setAttribute('data-chat-theme', preset.id);
        root.setAttribute('data-theme', preset.mode);

        if (options.persist !== false) {
            this.storageSet(WEB_CHAT_THEME_PRESET_STORAGE_KEY, preset.id);
            this.storageSet(WEB_CHAT_THEME_MODE_STORAGE_KEY, preset.mode);
        }

        if (preset.mode === 'light') {
            if (prismTheme) prismTheme.setAttribute('href', 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism.min.css');
        } else {
            if (prismTheme) prismTheme.setAttribute('href', 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css');
        }

        if (themeColorMeta) {
            themeColorMeta.setAttribute('content', preset.metaColor || (preset.mode === 'light' ? '#f4f7fb' : '#0a1018'));
        }

        if (window.parent && window.parent !== window) {
            try {
                window.parent.postMessage({
                    type: 'kimibuilt-web-chat-theme-state',
                    mode: preset.mode,
                    preset: preset.id,
                }, window.location.origin);
            } catch (_error) {
                // Ignore postMessage failures inside standalone chat windows.
            }
        }

        this.refreshMermaidTheme(preset.mode);
        this.updateThemeUI();
        this.updateMobileActionSheetUI();

        if (options?.playCue !== false) {
            this.playMenuCue('menu-select');
        }

        if (options?.showToast === true) {
            this.showToast(`${preset.name} theme applied`, 'success', 'Appearance');
        }
    }

    toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
        this.setTheme(nextTheme);
    }

    updateThemeUI() {
        const preset = this.getCurrentThemePreset();
        const themeButton = document.getElementById('theme-toggle');
        const themeText = document.getElementById('theme-text');

        if (themeButton) {
            themeButton.setAttribute('title', `${preset.name} theme`);
            themeButton.setAttribute('aria-label', `Open theme gallery. Current theme: ${preset.name}`);
        }
        if (themeText) {
            themeText.textContent = `${preset.name} Theme`;
        }

        this.renderThemeGallery();
    }

    openThemeGallery() {
        const modal = document.getElementById('theme-gallery-modal');
        if (!modal) {
            return;
        }

        this.closeSearch({ silent: true });
        this.closeModelSelector({ silent: true });
        this.closeMobileActionSheet({ silent: true });
        this.closeSidebar();
        this.renderThemeGallery();
        this.lastFocusedElement = document.activeElement;
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
        this.playMenuCue('menu-open');
        this.trapFocus(modal);
    }

    closeThemeGallery(options = {}) {
        const modal = document.getElementById('theme-gallery-modal');
        if (!modal || modal.classList.contains('hidden')) {
            return;
        }

        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');

        if (options?.silent !== true) {
            this.playMenuCue('menu-close');
        }

        if (this.lastFocusedElement && typeof this.lastFocusedElement.focus === 'function') {
            this.lastFocusedElement.focus();
            this.lastFocusedElement = null;
        }
    }

    selectThemePreset(presetId, options = {}) {
        const preset = this.getThemePresetById(presetId);
        this.applyThemePreset(preset.id, {
            persist: true,
            playCue: options.playCue !== false,
            showToast: options.showToast !== false,
        });

        if (options?.closeModal !== false) {
            this.closeThemeGallery({ silent: true });
        }
    }

    // ============================================
    // Input Handling
    // ============================================

    initAutoResize(textarea) {
        const resize = () => {
            textarea.style.height = 'auto';
            const newHeight = Math.min(textarea.scrollHeight, 192);
            textarea.style.height = newHeight + 'px';
        };

        textarea.addEventListener('input', resize);
        
        // Initial resize
        resize();

        return {
            resize,
            reset: () => {
                textarea.style.height = 'auto';
            }
        };
    }

    updateCharCounter(textarea, counter) {
        const maxLength = 4000;
        const length = textarea.value.length;
        counter.textContent = `${length}/${maxLength}`;
        
        if (length > 0) {
            counter.classList.remove('hidden');
        } else {
            counter.classList.add('hidden');
        }

        if (length > maxLength * 0.9) {
            counter.classList.add('text-red-500');
            counter.classList.remove('text-text-secondary');
        } else {
            counter.classList.remove('text-red-500');
            counter.classList.add('text-text-secondary');
        }
    }

    // ============================================
    // Search Functionality
    // ============================================

    openSearch() {
        const searchBar = document.getElementById('search-bar');
        const searchInput = document.getElementById('search-input');
        const searchPanel = searchBar?.querySelector('.search-bar-panel');
        if (!searchBar || !searchInput) {
            return;
        }

        this.closeModelSelector({ silent: true });
        this.closeThemeGallery({ silent: true });
        this.closeSidebar();
        this.closeMobileActionSheet({ silent: true });

        this.searchLastFocusedElement = document.activeElement;
        searchBar.classList.remove('hidden');
        searchBar.setAttribute('aria-hidden', 'false');
        this.playMenuCue('menu-open');
        this.trapFocus(searchPanel || searchBar);
        searchInput.focus();
    }

    closeSearch(options = {}) {
        const searchBar = document.getElementById('search-bar');
        const searchInput = document.getElementById('search-input');
        if (!searchBar || !searchInput) {
            return;
        }

        searchBar.classList.add('hidden');
        searchBar.setAttribute('aria-hidden', 'true');
        searchInput.value = '';
        this.clearSearchHighlights();
        this.searchResults = [];
        this.currentSearchIndex = -1;

        if (options?.silent !== true) {
            this.playMenuCue('menu-close');
        }

        if (this.searchLastFocusedElement && typeof this.searchLastFocusedElement.focus === 'function') {
            this.searchLastFocusedElement.focus();
            this.searchLastFocusedElement = null;
        }
    }

    performSearch(query) {
        this.clearSearchHighlights();
        
        if (!query.trim()) {
            this.searchResults = [];
            this.currentSearchIndex = -1;
            this.updateSearchCount();
            return;
        }

        const messages = this.messageContainer.querySelectorAll('.message');
        this.searchResults = [];
        
        messages.forEach((message, messageIndex) => {
            const textEl = message.querySelector('.message-text, .message-image');
            if (!textEl) return;

            const text = textEl.textContent || '';
            const regex = new RegExp(`(${this.escapeRegex(query)})`, 'gi');
            
            if (regex.test(text)) {
                this.searchResults.push({ message, messageIndex, textEl });
                
                // Highlight matches
                this.highlightText(textEl, query);
            }
        });

        this.currentSearchIndex = this.searchResults.length > 0 ? 0 : -1;
        this.updateSearchCount();
        this.navigateToCurrentResult();
    }

    highlightText(element, query) {
        const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );

        const textNodes = [];
        let node;
        while (node = walker.nextNode()) {
            if (node.parentElement.tagName !== 'CODE' && 
                node.parentElement.tagName !== 'PRE') {
                textNodes.push(node);
            }
        }

        const regex = new RegExp(`(${this.escapeRegex(query)})`, 'gi');
        
        textNodes.forEach(textNode => {
            const text = textNode.textContent;
            if (regex.test(text)) {
                const span = document.createElement('span');
                span.innerHTML = text.replace(regex, '<mark class="search-highlight">$1</mark>');
                textNode.parentNode.replaceChild(span, textNode);
            }
        });
    }

    clearSearchHighlights() {
        const marks = this.messageContainer.querySelectorAll('mark.search-highlight');
        marks.forEach(mark => {
            const parent = mark.parentNode;
            parent.replaceChild(document.createTextNode(mark.textContent), mark);
            parent.normalize();
        });
    }

    navigateSearch(direction) {
        if (this.searchResults.length === 0) return;
        
        this.currentSearchIndex += direction;
        
        if (this.currentSearchIndex < 0) {
            this.currentSearchIndex = this.searchResults.length - 1;
        } else if (this.currentSearchIndex >= this.searchResults.length) {
            this.currentSearchIndex = 0;
        }
        
        this.updateSearchCount();
        this.navigateToCurrentResult();
    }

    navigateToCurrentResult() {
        if (this.currentSearchIndex < 0 || this.searchResults.length === 0) return;
        
        // Remove current highlight from all
        this.messageContainer.querySelectorAll('.search-highlight.current').forEach(el => {
            el.classList.remove('current');
        });
        
        const result = this.searchResults[this.currentSearchIndex];
        if (result) {
            result.message.scrollIntoView({ behavior: 'smooth', block: 'center' });
            result.message.classList.add('highlighted');
            
            // Highlight current match
            const marks = result.textEl.querySelectorAll('mark.search-highlight');
            if (marks.length > 0) {
                marks[0].classList.add('current');
            }
            
            setTimeout(() => {
                result.message.classList.remove('highlighted');
            }, 2000);
        }
    }

    updateSearchCount() {
        const countEl = document.getElementById('search-count');
        if (this.searchResults.length === 0) {
            countEl.textContent = '';
        } else {
            countEl.textContent = `${this.currentSearchIndex + 1} / ${this.searchResults.length}`;
        }
    }

    escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // ============================================
    // Command Palette
    // ============================================

    openCommandPalette() {
        const palette = document.getElementById('command-palette');
        const input = document.getElementById('command-input');
        this.closeThemeGallery({ silent: true });
        palette.classList.remove('hidden');
        palette.setAttribute('aria-hidden', 'false');
        input.value = '';
        input.focus();
        this.renderCommandResults('');
        this.playMenuCue('menu-open');
        
        // Save last focused element
        this.lastFocusedElement = document.activeElement;
        
        // Trap focus
        this.trapFocus(palette);
    }

    closeCommandPalette(options = {}) {
        const palette = document.getElementById('command-palette');
        palette.classList.add('hidden');
        palette.setAttribute('aria-hidden', 'true');

        if (options?.silent !== true) {
            this.playMenuCue('menu-close');
        }
        
        // Return focus to trigger button
        if (this.lastFocusedElement) {
            this.lastFocusedElement.focus();
            this.lastFocusedElement = null;
        }
    }

    renderCommandResults(query) {
        const resultsContainer = document.getElementById('command-results');
        const commands = this.getAvailableCommands();
        
        // Handle slash commands
        if (query.startsWith('/')) {
            this.handleSlashCommand(query);
            return;
        }
        
        let filteredCommands = commands;
        if (query.trim()) {
            const lowerQuery = query.toLowerCase();
            filteredCommands = commands.filter(cmd => 
                cmd.title.toLowerCase().includes(lowerQuery) ||
                cmd.description.toLowerCase().includes(lowerQuery)
            );
        }

        if (filteredCommands.length === 0) {
            resultsContainer.innerHTML = `
                <div class="empty-state py-8">
                    <p class="text-sm text-text-secondary">No commands found</p>
                </div>
            `;
            return;
        }

        // Group commands by category
        const grouped = filteredCommands.reduce((acc, cmd) => {
            acc[cmd.category] = acc[cmd.category] || [];
            acc[cmd.category].push(cmd);
            return acc;
        }, {});

        resultsContainer.innerHTML = Object.entries(grouped).map(([category, cmds]) => `
            <div class="command-group">
                <div class="command-group-title">${category}</div>
                ${cmds.map((cmd, index) => `
                    <div class="command-item ${index === 0 ? 'selected' : ''}" data-action="${cmd.action}" role="option" tabindex="0">
                        <div class="command-item-icon">
                            <i data-lucide="${cmd.icon}" class="w-4 h-4" aria-hidden="true"></i>
                        </div>
                        <div class="command-item-content">
                            <div class="command-item-title">${cmd.title}</div>
                            <div class="command-item-desc">${cmd.description}</div>
                        </div>
                        ${cmd.shortcut ? `<span class="command-item-shortcut">${cmd.shortcut}</span>` : ''}
                    </div>
                `).join('')}
            </div>
        `).join('');

        this.reinitializeIcons(resultsContainer);
        
        // Attach click handlers
        resultsContainer.querySelectorAll('.command-item').forEach(item => {
            item.addEventListener('click', () => {
                this.executeCommand(item.dataset.action);
            });
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.executeCommand(item.dataset.action);
                }
            });
        });
    }

    handleSlashCommand(query) {
        const resultsContainer = document.getElementById('command-results');
        const parts = query.slice(1).split(' ');
        const command = parts[0];
        const args = parts.slice(1).join(' ');
        
        if (command === 'model' && args) {
            // Show model selection results
            const matchingModels = this.availableModels.filter(m => 
                m.id.toLowerCase().includes(args.toLowerCase()) ||
                this.getModelDisplayName(m).toLowerCase().includes(args.toLowerCase())
            );
            
            if (matchingModels.length > 0) {
                resultsContainer.innerHTML = `
                    <div class="command-group">
                        <div class="command-group-title">Matching Models</div>
                        ${matchingModels.map((model, index) => `
                            <div class="command-item ${index === 0 ? 'selected' : ''}" data-action="set-model:${model.id}" role="option" tabindex="0">
                                <div class="command-item-icon">
                                    <i data-lucide="cpu" class="w-4 h-4" aria-hidden="true"></i>
                                </div>
                                <div class="command-item-content">
                                    <div class="command-item-title">${this.getModelDisplayName(model)}</div>
                                    <div class="command-item-desc">${this.getModelDescription(model)}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `;
            } else {
                resultsContainer.innerHTML = `
                    <div class="empty-state py-8">
                        <p class="text-sm text-text-secondary">No matching models found</p>
                    </div>
                `;
            }
        } else if (command === 'models' || (command === 'model' && !args)) {
            // Show all models
            this.renderModelCommands(resultsContainer);
        } else if (command === 'image') {
            resultsContainer.innerHTML = `
                <div class="command-group">
                    <div class="command-group-title">Image Generation</div>
                    <div class="command-item selected" data-action="open-image-modal" role="option" tabindex="0">
                        <div class="command-item-icon">
                            <i data-lucide="image" class="w-4 h-4" aria-hidden="true"></i>
                        </div>
                        <div class="command-item-content">
                            <div class="command-item-title">Open Image Generator</div>
                            <div class="command-item-desc">Create AI-generated images</div>
                        </div>
                    </div>
                </div>
            `;
        } else if (command === 'remote') {
            resultsContainer.innerHTML = `
                <div class="command-group">
                    <div class="command-group-title">Remote CLI</div>
                    <div class="command-item selected" data-action="insert-tool-command:/remote agent " role="option" tabindex="0">
                        <div class="command-item-icon">
                            <i data-lucide="bot"></i>
                        </div>
                        <div class="command-item-content">
                            <div class="command-item-title">Remote CLI Agent</div>
                            <div class="command-item-desc">Insert /remote agent &lt;task&gt; for coding, build, deploy, and verify loops</div>
                        </div>
                    </div>
                    <div class="command-item" data-action="insert-tool-command:/remote status" role="option" tabindex="0">
                        <div class="command-item-icon">
                            <i data-lucide="terminal"></i>
                        </div>
                        <div class="command-item-content">
                            <div class="command-item-title">Remote Status</div>
                            <div class="command-item-desc">Inspect remote runner and SSH target readiness</div>
                        </div>
                    </div>
                    <div class="command-item" data-action="insert-tool-command:/remote tools" role="option" tabindex="0">
                        <div class="command-item-icon">
                            <i data-lucide="wrench"></i>
                        </div>
                        <div class="command-item-content">
                            <div class="command-item-title">Remote Tools</div>
                            <div class="command-item-desc">List remote command catalog entries</div>
                        </div>
                    </div>
                    <div class="command-item" data-action="open-model-selector" role="option" tabindex="0">
                        <div class="command-item-icon">
                            <i data-lucide="cpu"></i>
                        </div>
                        <div class="command-item-content">
                            <div class="command-item-title">Remote CLI Agent Model</div>
                            <div class="command-item-desc">Choose the router model used by chat and /remote agent</div>
                        </div>
                    </div>
                    <div class="command-item" data-action="insert-tool-command:/remote run " role="option" tabindex="0">
                        <div class="command-item-icon">
                            <i data-lucide="square-terminal"></i>
                        </div>
                        <div class="command-item-content">
                            <div class="command-item-title">Run Remote Command</div>
                            <div class="command-item-desc">Insert /remote run &lt;command&gt; into the chat input</div>
                        </div>
                    </div>
                </div>
            `;
        } else if (command === 'tools' || command === 'tool') {
            resultsContainer.innerHTML = `
                <div class="command-group">
                    <div class="command-group-title">Tools</div>
                    <div class="command-item selected" data-action="insert-tool-command:${command === 'tool' ? '/tool ' : '/tools'}" role="option" tabindex="0">
                        <div class="command-item-icon">
                            <i data-lucide="wrench" class="w-4 h-4" aria-hidden="true"></i>
                        </div>
                        <div class="command-item-content">
                            <div class="command-item-title">${command === 'tool' ? 'Invoke Tool Command' : 'List Available Tools'}</div>
                            <div class="command-item-desc">${command === 'tool' ? 'Insert /tool <id> {json} into the chat input' : 'Insert /tools into the chat input'}</div>
                        </div>
                    </div>
                </div>
            `;
        } else {
            resultsContainer.innerHTML = `
                <div class="empty-state py-8">
                    <p class="text-sm text-text-secondary">Unknown command. Try /model, /models, /image, /remote, or /tools</p>
                </div>
            `;
        }
        
        this.reinitializeIcons(resultsContainer);
        resultsContainer.querySelectorAll('.command-item').forEach(item => {
            item.addEventListener('click', () => {
                this.executeCommand(item.dataset.action);
            });
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.executeCommand(item.dataset.action);
                }
            });
        });
    }

    renderModelCommands(container) {
        if (this.availableModels.length === 0) {
            container.innerHTML = `
                <div class="empty-state py-8">
                    <p class="text-sm text-text-secondary">Loading models...</p>
                </div>
            `;
            // Load models in background
            this.loadModels().then(() => {
                this.renderModelCommands(container);
            });
            return;
        }
        
        const grouped = this.groupModelsByProvider(this.availableModels);
        
        container.innerHTML = Object.entries(grouped).map(([provider, models]) => `
            <div class="command-group">
                <div class="command-group-title">${provider}</div>
                ${models.map((model, index) => `
                    <div class="command-item ${model.id === this.currentModel ? 'selected' : ''}" data-action="set-model:${model.id}" role="option" tabindex="0">
                        <div class="command-item-icon">
                            <i data-lucide="cpu" class="w-4 h-4" aria-hidden="true"></i>
                        </div>
                        <div class="command-item-content">
                            <div class="command-item-title">${this.getModelDisplayName(model)}</div>
                            <div class="command-item-desc">${this.getModelDescription(model)}</div>
                        </div>
                        ${model.id === this.currentModel ? `<i data-lucide="check" class="w-4 h-4 text-accent" aria-hidden="true"></i>` : ''}
                    </div>
                `).join('')}
            </div>
        `).join('');
    }

    getAvailableCommands() {
        const currentSession = sessionManager.currentSessionId;
        const hasMessages = currentSession && sessionManager.getMessages(currentSession).length > 0;
        
        return [
            { category: 'Actions', icon: 'plus', title: 'New Chat', description: 'Start a new conversation', action: 'new-chat', shortcut: 'Ctrl+N' },
            { category: 'Actions', icon: 'image', title: 'Create Image', description: 'Generate AI images or search Unsplash', action: 'open-image-modal', shortcut: 'Ctrl+I' },
            { category: 'Actions', icon: 'camera', title: 'Search Unsplash', description: 'Find free stock photos', action: 'open-image-modal:unsplash' },
            { category: 'Remote CLI', icon: 'bot', title: 'Remote CLI Agent', description: 'Insert /remote agent for coding, build, deploy, and verify loops', action: 'insert-tool-command:/remote agent ' },
            { category: 'Remote CLI', icon: 'terminal', title: 'Remote Status', description: 'Insert the /remote status command into chat', action: 'insert-tool-command:/remote status' },
            { category: 'Remote CLI', icon: 'cpu', title: 'Remote CLI Agent Model', description: 'Choose the router model used by chat and /remote agent', action: 'open-model-selector' },
            { category: 'Remote CLI', icon: 'square-terminal', title: 'Run Remote Command', description: 'Insert the /remote run command into chat', action: 'insert-tool-command:/remote run ' },
            { category: 'Actions', icon: 'wrench', title: 'List Tools', description: 'Insert the /tools command into chat', action: 'insert-tool-command:/tools' },
            { category: 'Actions', icon: 'folder-open', title: 'Open File Manager', description: 'View and manage session files', action: 'open-file-manager', shortcut: 'Ctrl+Shift+F' },
            { category: 'Actions', icon: 'search', title: 'Search Messages', description: 'Search in current conversation', action: 'search', shortcut: 'Ctrl+F' },
            { category: 'Actions', icon: 'keyboard', title: 'Keyboard Shortcuts', description: 'View all keyboard shortcuts', action: 'show-shortcuts' },
            { category: 'Model', icon: 'cpu', title: 'Change Model', description: 'Select a different AI model', action: 'open-model-selector' },
            { category: 'Navigation', icon: 'sidebar', title: 'Toggle Sidebar', description: 'Show or hide the sidebar', action: 'toggle-sidebar', shortcut: 'Ctrl+B' },
            { category: 'View', icon: 'minimize-2', title: this.isMinimalistMode() ? 'Return to Full Interface' : 'Enter Minimalist Mode', description: 'Switch between the full workspace and a chat-first view', action: 'toggle-minimalist-mode', shortcut: 'Ctrl+Shift+M' },
            { category: 'View', icon: 'minimize-2', title: 'Toggle Input Area', description: 'Show or hide the message input', action: 'toggle-input-area', shortcut: 'Ctrl+Shift+H' },
            { category: 'View', icon: 'palette', title: 'Open Theme Gallery', description: 'Browse curated wallpaper and color presets', action: 'open-theme-gallery' },
            ...(hasMessages ? [
                { category: 'Export', icon: 'download', title: 'Export as Markdown', description: 'Download conversation as .md file', action: 'export-md' },
                { category: 'Export', icon: 'download', title: 'Export as JSON', description: 'Download conversation as .json file', action: 'export-json' },
                { category: 'Export', icon: 'download', title: 'Export as Text', description: 'Download conversation as .txt file', action: 'export-txt' },
                { category: 'Export', icon: 'globe', title: 'Export as HTML', description: 'Download conversation as .html file', action: 'export-html' },
                { category: 'Export', icon: 'file-box', title: 'Export as PDF', description: 'Download conversation as .pdf file', action: 'export-pdf' },
            ] : []),
            { category: 'Data', icon: 'upload', title: 'Import Conversation', description: 'Import from DOCX, PDF, HTML, MD, TXT, or JSON', action: 'import-conversations' },
            ...(currentSession ? [
                { category: 'Session', icon: 'trash-2', title: 'Clear Messages', description: 'Clear all messages in current session', action: 'clear-messages' },
                { category: 'Session', icon: 'x-circle', title: 'Delete Session', description: 'Delete current conversation', action: 'delete-session' },
            ] : []),
        ];
    }

    executeCommand(action) {
        this.closeCommandPalette({ silent: true });
        this.playMenuCue('menu-select');
        
        // Handle set-model action
        if (action.startsWith('set-model:')) {
            const modelId = action.split(':')[1];
            this.selectModel(modelId);
            return;
        }
        
        // Handle open-image-modal with source
        if (action.startsWith('open-image-modal')) {
            const source = action.split(':')[1] || 'generate';
            this.openImageModal();
            this.setImageSource(source);
            return;
        }

        if (action.startsWith('insert-tool-command:')) {
            const command = action.slice('insert-tool-command:'.length);
            const input = document.getElementById('message-input');
            if (input) {
                input.value = command;
                input.focus();
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return;
        }
        
        switch (action) {
            case 'new-chat':
                window.chatApp?.createNewSession();
                break;
            case 'search':
                this.openSearch();
                break;
            case 'toggle-sidebar':
                this.toggleSidebar();
                break;
            case 'toggle-minimalist-mode':
                this.toggleMinimalistMode();
                break;
            case 'toggle-input-area':
                this.toggleInputArea();
                break;
            case 'open-theme-gallery':
                this.openThemeGallery();
                break;
            case 'export-md':
                window.chatApp?.exportConversation('markdown');
                break;
            case 'export-json':
                window.chatApp?.exportConversation('json');
                break;
            case 'export-txt':
                window.chatApp?.exportConversation('txt');
                break;
            case 'export-html':
                window.chatApp?.exportConversation('html');
                break;
            case 'export-pdf':
                window.chatApp?.exportConversation('pdf');
                break;
            case 'clear-messages':
                window.chatApp?.clearCurrentSession();
                break;
            case 'delete-session':
                if (sessionManager.currentSessionId) {
                    this.confirmDeleteSession(sessionManager.currentSessionId);
                }
                break;
            case 'open-file-manager':
                if (window.fileManager) {
                    window.fileManager.open();
                }
                break;
            case 'open-model-selector':
                this.openModelSelector();
                break;
            case 'show-shortcuts':
                this.openShortcutsModal();
                break;
            case 'import-conversations':
                this.openImportModal();
                break;
        }
    }

    // ============================================
    // Keyboard Shortcuts Help
    // ============================================

    openShortcutsModal() {
        // Close any existing shortcuts modal first
        this.closeShortcutsModal();
        this.closeThemeGallery({ silent: true });
        
        // Save last focused element
        this.lastFocusedElement = document.activeElement;
        
        const modal = document.createElement('div');
        modal.id = 'shortcuts-modal';
        modal.className = 'modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'shortcuts-title');
        
        const shortcuts = [
            { key: 'Ctrl + K', description: 'Open command palette' },
            { key: 'Ctrl + N', description: 'New chat' },
            { key: 'Ctrl + F', description: 'Search messages' },
            { key: 'Ctrl + I', description: 'Create image (AI or Unsplash)' },
            { key: 'Ctrl + B', description: 'Toggle sidebar' },
            { key: 'Ctrl + Shift + M', description: 'Toggle minimalist mode' },
            { key: 'Ctrl + Shift + H', description: 'Toggle input area' },
            { key: 'Shift + Enter', description: 'New line in input' },
            { key: 'Enter', description: 'Send message' },
            { key: 'Esc', description: 'Close modals/panels' },
            { key: '?', description: 'Show this help' },
            { key: '', description: '' },
            { key: 'Commands', description: '/image [prompt] - Generate AI images' },
            { key: '', description: '/unsplash [query] - Search stock photos' },
            { key: '', description: '/model [name] - Change AI model' },
            { key: '', description: '/clear - Clear conversation' },
            { key: '', description: '' },
            { key: 'Import/Export', description: 'Exports PDF, HTML, Markdown, TXT, and JSON; imports also support DOCX' },
        ];
        
        modal.innerHTML = `
            <div class="modal-overlay" onclick="uiHelpers.closeShortcutsModal()"></div>
            <div class="modal-content" style="max-width: 480px;">
                <div class="modal-header">
                    <h3 id="shortcuts-title">Keyboard Shortcuts</h3>
                    <button class="btn-icon" onclick="uiHelpers.closeShortcutsModal()" aria-label="Close keyboard shortcuts help">
                        <i data-lucide="x" class="w-5 h-5" aria-hidden="true"></i>
                    </button>
                </div>
                <div class="modal-body">
                    <div class="shortcuts-list" role="list">
                        ${shortcuts.map(s => s.key ? `
                            <div class="shortcut-item" role="listitem">
                                <kbd class="shortcut-key">${s.key}</kbd>
                                <span class="shortcut-desc">${s.description}</span>
                            </div>
                        ` : `<div class="shortcut-item" style="background: transparent; border: none;"><span class="shortcut-desc" style="font-weight: 600; color: var(--text-primary);">${s.description}</span></div>`).join('')}
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        this.reinitializeIcons(modal);
        this.trapFocus(modal);
        
        // Close on escape
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeShortcutsModal();
            }
        });
    }

    closeShortcutsModal() {
        const modal = document.getElementById('shortcuts-modal');
        if (modal) {
            modal.remove();
        }
        
        // Return focus to trigger button
        if (this.lastFocusedElement) {
            this.lastFocusedElement.focus();
            this.lastFocusedElement = null;
        }
    }

    // ============================================
    // Import Modal - Enhanced with multiple formats
    // ============================================

    openImportModal() {
        // Remove any existing import modal
        this.closeImportModal();
        this.closeThemeGallery({ silent: true });
        
        // Show the new import modal from HTML
        const modal = document.getElementById('import-modal');
        if (modal) {
            modal.classList.remove('hidden');
            modal.setAttribute('aria-hidden', 'false');
            
            // Save last focused element
            this.lastFocusedElement = document.activeElement;
            
            this.setupImportHandlers(modal);
            this.trapFocus(modal);
        }
    }

    setupImportHandlers(modal) {
        const dropzone = modal.querySelector('#import-dropzone');
        const fileInput = modal.querySelector('#import-file-input');
        
        if (!dropzone || !fileInput) return;
        
        // Reset state
        this.pendingImport = null;
        this.pendingImportFormat = null;
        this.resetImportUI(modal);
        
        dropzone.addEventListener('click', () => fileInput.click());
        
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });
        
        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });
        
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                this.handleImportFile(files[0]);
            }
        });
        
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.handleImportFile(e.target.files[0]);
            }
        });
        
        // Close on escape
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeImportModal();
            }
        });
    }

    resetImportUI(modal) {
        const preview = modal.querySelector('#import-preview');
        const error = modal.querySelector('#import-error');
        const progress = modal.querySelector('#import-progress');
        const confirmBtn = modal.querySelector('#import-confirm-btn');
        
        preview?.classList.add('hidden');
        error?.classList.add('hidden');
        progress?.classList.add('hidden');
        if (confirmBtn) confirmBtn.disabled = true;
    }

    async handleImportFile(file) {
        const modal = document.getElementById('import-modal');
        const progress = modal?.querySelector('#import-progress');
        const progressText = modal?.querySelector('#import-progress-text');
        const errorDiv = modal?.querySelector('#import-error');
        const errorText = modal?.querySelector('#import-error-text');
        
        // Show progress
        progress?.classList.remove('hidden');
        errorDiv?.classList.add('hidden');
        
        try {
            const result = await window.importExportManager.importFile(file, (percent, message) => {
                if (progressText) {
                    progressText.textContent = message || `Processing... ${percent}%`;
                }
            });
            
            this.pendingImport = result;
            this.showImportPreview(result, file.name);
        } catch (error) {
            progress?.classList.add('hidden');
            if (errorText) errorText.textContent = error.message;
            errorDiv?.classList.remove('hidden');
        }
    }

    showImportPreview(result, filename) {
        const modal = document.getElementById('import-modal');
        const preview = modal?.querySelector('#import-preview');
        const filenameEl = modal?.querySelector('#import-filename');
        const statsEl = modal?.querySelector('#import-stats');
        const messagesPreviewEl = modal?.querySelector('#import-messages-preview');
        const confirmBtn = modal?.querySelector('#import-confirm-btn');
        const progress = modal?.querySelector('#import-progress');
        
        if (!preview) return;
        
        progress?.classList.add('hidden');
        
        // Update filename
        if (filenameEl) filenameEl.textContent = filename;
        
        // Update stats
        if (statsEl) {
            const formatLabels = {
                docx: 'Word Document',
                pdf: 'PDF Document',
                html: 'HTML Page',
                markdown: 'Markdown',
                txt: 'Text File',
                json: 'JSON Export'
            };
            
            statsEl.innerHTML = `
                <div class="import-stat">
                    <span class="import-stat-value">${result.messages.length}</span>
                    <span class="import-stat-label">Messages</span>
                </div>
                <div class="import-stat">
                    <span class="import-stat-value">${formatLabels[result.format] || result.format.toUpperCase()}</span>
                    <span class="import-stat-label">Format</span>
                </div>
                ${result.pageCount ? `
                <div class="import-stat">
                    <span class="import-stat-value">${result.pageCount}</span>
                    <span class="import-stat-label">Pages</span>
                </div>
                ` : ''}
            `;
        }
        
        // Show message preview (first 5 messages)
        if (messagesPreviewEl) {
            const previewMessages = result.messages.slice(0, 5);
            messagesPreviewEl.innerHTML = previewMessages.map(msg => `
                <div class="import-preview-message ${msg.role}">
                    <span class="import-preview-message-role">${msg.role}</span>
                    <span class="import-preview-message-content">${this.escapeHtml(msg.content.substring(0, 100))}${msg.content.length > 100 ? '...' : ''}</span>
                </div>
            `).join('');
            
            if (result.messages.length > 5) {
                messagesPreviewEl.innerHTML += `
                    <div style="text-align: center; padding: 0.5rem; color: var(--text-secondary); font-size: 0.75rem;">
                        + ${result.messages.length - 5} more messages
                    </div>
                `;
            }
        }
        
        preview.classList.remove('hidden');
        if (confirmBtn) confirmBtn.disabled = false;
    }

    async confirmImport() {
        if (!this.pendingImport || !this.pendingImport.messages.length) return;
        
        const modal = document.getElementById('import-modal');
        const confirmBtn = modal?.querySelector('#import-confirm-btn');
        
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = '<span class="animate-spin inline-block mr-2">...</span> Importing...';
        }
        
        try {
            // Create a new session for the imported conversation
            await window.chatApp.createNewSession();
            const sessionId = sessionManager.currentSessionId;
            
            if (!sessionId) {
                throw new Error('Failed to create session');
            }
            
            // Add messages to the session
            for (const msg of this.pendingImport.messages) {
                sessionManager.addMessage(sessionId, {
                    role: msg.role,
                    content: msg.content,
                    type: msg.type || null,
                    prompt: msg.prompt || null,
                    imageUrl: msg.imageUrl || null,
                    model: msg.model || null,
                    timestamp: msg.timestamp || new Date().toISOString()
                });
            }
            
            // Update session title if available
            if (this.pendingImport.title) {
                await sessionManager.renameSession(sessionId, this.pendingImport.title);
            }
            
            // Refresh the UI
            window.chatApp.loadSessionMessages(sessionId);
            window.chatApp.updateSessionInfo();
            uiHelpers.renderSessionsList(sessionManager.sessions, sessionId);
            
            this.showToast(`Imported ${this.pendingImport.messages.length} messages`, 'success');
            this.closeImportModal();
        } catch (error) {
            this.showToast(`Import failed: ${error.message}`, 'error');
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.textContent = 'Import Conversation';
            }
        }
    }

    closeImportModal() {
        const modal = document.getElementById('import-modal');
        if (modal) {
            modal.classList.add('hidden');
            modal.setAttribute('aria-hidden', 'true');
        }
        this.pendingImport = null;
        this.pendingImportFormat = null;
        
        // Reset file input
        const fileInput = modal?.querySelector('#import-file-input');
        if (fileInput) fileInput.value = '';
    }

    // ============================================
    // Export Modal - Enhanced with progress
    // ============================================

    openExportModal() {
        if (!sessionManager.currentSessionId) {
            this.showToast('No active conversation to export', 'warning');
            return;
        }
        
        const modal = document.getElementById('export-modal');
        this.closeThemeGallery({ silent: true });
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
        
        // Hide progress
        const progress = modal.querySelector('#export-progress');
        if (progress) progress.classList.add('hidden');
        
        // Check if we need to add export all option
        const exportOptions = modal.querySelector('.export-options');
        if (exportOptions && sessionManager.sessions.length > 1) {
            if (!exportOptions.querySelector('[data-action="export-all"]')) {
                const exportAllBtn = document.createElement('button');
                exportAllBtn.className = 'export-option';
                exportAllBtn.setAttribute('data-action', 'export-all');
                exportAllBtn.setAttribute('onclick', 'app.exportAllConversations()');
                exportAllBtn.innerHTML = `
                    <i data-lucide="archive" class="w-8 h-8 text-orange-500"></i>
                    <span class="export-name">All Conversations</span>
                    <span class="export-desc">Export all sessions as JSON</span>
                `;
                exportOptions.appendChild(exportAllBtn);
                this.reinitializeIcons(exportAllBtn);
            }
        }
        
        this.trapFocus(modal);
    }

    showExportProgress(percent, message) {
        const modal = document.getElementById('export-modal');
        const progress = modal?.querySelector('#export-progress');
        const progressText = modal?.querySelector('#export-progress-text');
        const progressPercent = modal?.querySelector('#export-progress-percent');
        const progressFill = modal?.querySelector('#export-progress-fill');
        
        if (progress) progress.classList.remove('hidden');
        if (progressText) progressText.textContent = message || 'Exporting...';
        if (progressPercent) progressPercent.textContent = `${percent}%`;
        if (progressFill) progressFill.style.width = `${percent}%`;
    }

    hideExportProgress() {
        const modal = document.getElementById('export-modal');
        const progress = modal?.querySelector('#export-progress');
        if (progress) progress.classList.add('hidden');
    }

    closeExportModal() {
        const modal = document.getElementById('export-modal');
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
        this.hideExportProgress();
    }

    // ============================================
    // Toast Notifications
    // ============================================

    shouldSuppressToast(message = '', type = 'info', title = '') {
        const normalizedType = String(type || '').trim().toLowerCase();
        if (['success', 'error'].includes(normalizedType)) {
            return true;
        }

        const normalizedTitle = String(title || '').trim().toLowerCase();
        const normalizedMessage = String(message || '').trim().toLowerCase();
        const combined = `${normalizedTitle} ${normalizedMessage}`.trim();

        if (!combined) {
            return false;
        }

        return [
            /\bsound cues?\b/,
            /\bmenu sounds?\b/,
            /\bsound theme\b/,
            /\bmodel changed\b/,
            /\bswitched to\b/,
            /\btheme applied\b/,
            /\bmode\b.*\b(applied|changed|enabled|disabled|switched)\b/,
            /\b(message queued|processing queued message)\b/,
            /\btask completed\b/,
            /\btask failed\b/,
            /\btask started\b/,
            /\btask queued\b/,
            /\bworkload completed\b/,
            /\bworkload failed\b/,
            /\bworkload started\b/,
            /\bworkload queued\b/,
            /\bworkload action failed\b/,
            /^workload (updated|created|queued|paused|resumed|deleted)\b/,
        ].some((pattern) => pattern.test(combined));
    }

    showToast(message, type = 'info', title = '') {
        if (this.shouldSuppressToast(message, type, title)) {
            return;
        }

        const container = document.getElementById('toast-container');
        if (!container) {
            return;
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'polite');

        const icons = {
            success: 'check-circle',
            error: 'x-circle',
            warning: 'alert-triangle',
            info: 'info'
        };

        const icon = icons[type] || icons.info;

        toast.innerHTML = `
            <div class="toast-icon" aria-hidden="true">
                <i data-lucide="${icon}" class="w-5 h-5"></i>
            </div>
            <div class="toast-content">
                ${title ? `<div class="toast-title">${title}</div>` : ''}
                <div class="toast-message">${message}</div>
            </div>
            <button class="toast-close" aria-label="Close notification">
                <i data-lucide="x" class="w-4 h-4" aria-hidden="true"></i>
            </button>
        `;

        container.appendChild(toast);
        this.reinitializeIcons(toast);

        // Close button handler
        toast.querySelector('.toast-close').addEventListener('click', () => {
            this.removeToast(toast);
        });

        // Auto-remove after 5 seconds
        setTimeout(() => {
            this.removeToast(toast);
        }, 5000);
    }

    showAlignmentConfetti() {
        if (typeof document === 'undefined') {
            return;
        }

        const burst = document.createElement('div');
        burst.className = 'alignment-confetti-burst';
        burst.setAttribute('aria-hidden', 'true');

        const pieces = 18;
        for (let index = 0; index < pieces; index += 1) {
            const piece = document.createElement('span');
            piece.style.setProperty('--confetti-x', `${Math.cos((Math.PI * 2 * index) / pieces) * (48 + (index % 4) * 12)}px`);
            piece.style.setProperty('--confetti-y', `${Math.sin((Math.PI * 2 * index) / pieces) * (34 + (index % 3) * 10)}px`);
            piece.style.setProperty('--confetti-delay', `${index * 12}ms`);
            piece.style.setProperty('--confetti-hue', `${(index * 47) % 360}`);
            burst.appendChild(piece);
        }

        const label = document.createElement('strong');
        label.textContent = 'Confetti yaa';
        burst.appendChild(label);
        document.body.appendChild(burst);
        window.setTimeout(() => burst.remove(), 1300);
    }

    removeToast(toast) {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }

    // ============================================
    // Scroll & View Utilities
    // ============================================

    scrollToBottom(smooth = false) {
        this.messageContainer.scrollTo({
            top: this.messageContainer.scrollHeight,
            behavior: smooth ? 'smooth' : 'auto'
        });
    }

    hideWelcomeMessage() {
        const welcome = document.getElementById('welcome-message');
        if (welcome) {
            welcome.style.display = 'none';
        }
    }

    showWelcomeMessage() {
        const welcome = document.getElementById('welcome-message');
        if (welcome) {
            welcome.style.display = 'flex';
        }
    }

    clearMessages() {
        const welcome = document.getElementById('welcome-message');
        this.messageContainer.innerHTML = '';
        if (welcome) {
            this.messageContainer.appendChild(welcome);
            this.showWelcomeMessage();
        }
    }

    // ============================================
    // Typing Indicator
    // ============================================

    showTypingIndicator(state = {}) {
        const indicator = document.getElementById('typing-indicator');
        if (!indicator) {
            return;
        }

        indicator.classList.add('hidden');
        indicator.setAttribute('aria-hidden', 'true');
        indicator.removeAttribute('aria-label');
        const content = indicator.querySelector('.typing-indicator-content');
        if (content) {
            content.removeAttribute('title');
        }
        delete indicator.dataset.livePhase;
    }

    hideTypingIndicator() {
        const indicator = document.getElementById('typing-indicator');
        if (!indicator) {
            return;
        }

        indicator.classList.add('hidden');
        indicator.setAttribute('aria-hidden', 'true');
        indicator.removeAttribute('aria-label');
        const content = indicator.querySelector('.typing-indicator-content');
        if (content) {
            content.removeAttribute('title');
        }
        delete indicator.dataset.livePhase;
    }

    // ============================================
    // Mobile Sidebar
    // ============================================

    toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;

        if (this.isMinimalistMode()) {
            this.applyLayoutMode('full');
        }

        sidebar.classList.toggle('open');
        this.syncSidebarState();
    }

    closeSidebar() {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;

        sidebar.classList.remove('open');
        this.syncSidebarState();
    }

    toggleMobileActionSheet() {
        const menu = document.getElementById('mobile-chat-menu');
        if (!menu) {
            return;
        }

        if (menu.classList.contains('hidden')) {
            this.openMobileActionSheet();
        } else {
            this.closeMobileActionSheet();
        }
    }

    openMobileActionSheet() {
        const menu = document.getElementById('mobile-chat-menu');
        const sheet = menu?.querySelector('.mobile-chat-menu__sheet');
        const trigger = document.getElementById('mobile-chat-menu-btn');
        const allowCompactActionSheet = this.isCompactActionSheetMode();
        if (!menu || !sheet || !allowCompactActionSheet) {
            return;
        }

        this.closeSidebar();
        this.closeSearch({ silent: true });
        this.closeModelSelector({ silent: true });
        this.closeThemeGallery({ silent: true });
        this.updateMobileActionSheetUI();

        this.lastFocusedElement = document.activeElement;
        menu.classList.remove('hidden');
        menu.setAttribute('aria-hidden', 'false');
        document.body.classList.add('mobile-chat-menu-open');
        trigger?.setAttribute('aria-expanded', 'true');
        this.playMenuCue('menu-open');
        this.trapFocus(sheet);
    }

    closeMobileActionSheet(options = {}) {
        const menu = document.getElementById('mobile-chat-menu');
        const trigger = document.getElementById('mobile-chat-menu-btn');
        if (!menu) {
            return;
        }

        menu.classList.add('hidden');
        menu.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('mobile-chat-menu-open');
        trigger?.setAttribute('aria-expanded', 'false');

        if (options?.silent !== true) {
            this.playMenuCue('menu-close');
        }

        if (this.lastFocusedElement && typeof this.lastFocusedElement.focus === 'function') {
            this.lastFocusedElement.focus();
            this.lastFocusedElement = null;
        }
    }

    updateMobileActionSheetUI() {
        const modelValue = document.getElementById('mobile-chat-menu-model-value');
        const themeValue = document.getElementById('mobile-chat-menu-theme-value');
        const layoutIcon = document.getElementById('mobile-chat-menu-layout-icon');
        const layoutLabel = document.getElementById('mobile-chat-menu-layout-label');
        const layoutValue = document.getElementById('mobile-chat-menu-layout-value');
        const displayName = this.getModelDisplayName({ id: this.currentModel });
        const reasoningLabel = this.getReasoningDisplayLabel(this.getCurrentReasoningEffort()).replace('Reasoning: ', '');
        const preset = this.getCurrentThemePreset();
        const isMinimal = this.isMinimalistMode();

        if (modelValue) {
            modelValue.textContent = `${displayName} | ${reasoningLabel}`;
        }

        if (themeValue) {
            themeValue.textContent = preset.name;
        }

        if (layoutLabel) {
            layoutLabel.textContent = isMinimal ? 'Full interface' : 'Focus mode';
        }

        if (layoutValue) {
            layoutValue.textContent = isMinimal ? 'Bring back menus and tools' : 'Show chat first';
        }

        if (layoutIcon) {
            layoutIcon.setAttribute('data-lucide', isMinimal ? 'maximize-2' : 'minimize-2');
            this.reinitializeIcons(layoutIcon.parentElement || layoutIcon);
        }
    }

    handleMobileActionSheetAction(action = '') {
        this.closeMobileActionSheet({ silent: true });

        switch (action) {
            case 'search':
                this.openSearch();
                break;
            case 'models':
                this.openModelSelector();
                break;
            case 'workloads':
                window.chatApp?.toggleWorkloadsPanel();
                break;
            case 'files':
                window.fileManager?.open?.();
                break;
            case 'export':
                this.openExportModal();
                break;
            case 'theme':
                this.openThemeGallery();
                break;
            case 'layout':
                this.playMenuCue('menu-select');
                this.toggleMinimalistMode();
                break;
            case 'clear':
                this.playMenuCue('menu-select');
                window.chatApp?.clearCurrentSession();
                break;
            default:
                break;
        }
    }

    // ============================================
    // Icon Management
    // ============================================

    reinitializeIcons(container = document) {
        if (window.lucide) {
            lucide.createIcons({ attrs: { 'stroke-width': 2 }, parent: container });
        }
    }

    // ============================================
    // Accessibility - Focus Trap
    // ============================================

    trapFocus(element) {
        const focusableElements = element.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        
        if (focusableElements.length === 0) return;
        
        const firstFocusable = focusableElements[0];
        const lastFocusable = focusableElements[focusableElements.length - 1];
        
        // Focus first element
        firstFocusable.focus();
        
        element.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab') return;
            
            if (e.shiftKey) {
                if (document.activeElement === firstFocusable) {
                    lastFocusable.focus();
                    e.preventDefault();
                }
            } else {
                if (document.activeElement === lastFocusable) {
                    firstFocusable.focus();
                    e.preventDefault();
                }
            }
        });
    }

    // ============================================
    // Event Listeners
    // ============================================

    setupEventListeners() {
        // Search input
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.performSearch(e.target.value);
            });
        }

        const reasoningSelect = document.getElementById('reasoning-effort-select');
        if (reasoningSelect) {
            reasoningSelect.addEventListener('change', (e) => {
                this.setCurrentReasoningEffort(e.target.value);
            });
        }

        const assistantModelSelect = document.getElementById('assistant-model-select');
        if (assistantModelSelect) {
            assistantModelSelect.addEventListener('change', (e) => {
                this.selectModel(e.target.value, { closeModal: false, showToast: true, playCue: true });
            });
        }

        const remoteAutonomyBtn = document.getElementById('remote-autonomy-btn');
        if (remoteAutonomyBtn) {
            remoteAutonomyBtn.addEventListener('click', () => {
                this.toggleRemoteBuildAutonomy();
            });
        }

        const longAgentDefaultBtn = document.getElementById('long-agent-default-btn');
        if (longAgentDefaultBtn) {
            longAgentDefaultBtn.addEventListener('click', () => {
                this.toggleLongAgentDefault();
            });
        }

        const modelListToggle = document.getElementById('model-list-toggle');
        if (modelListToggle) {
            modelListToggle.addEventListener('click', () => {
                this.toggleModelListVisibility();
                this.playMenuCue('menu-select');
            });
        }

        const soundCuesBtn = document.getElementById('sound-cues-btn');
        if (soundCuesBtn) {
            soundCuesBtn.addEventListener('click', () => {
                this.toggleSoundCues();
            });
        }

        const ttsAutoplayBtn = document.getElementById('tts-autoplay-btn');
        if (ttsAutoplayBtn) {
            ttsAutoplayBtn.addEventListener('click', () => {
                this.toggleTtsAutoPlay();
            });
        }

        const ttsVoiceSelect = document.getElementById('tts-voice-select');
        if (ttsVoiceSelect) {
            ttsVoiceSelect.addEventListener('change', () => {
                this.setSelectedTtsVoiceId(ttsVoiceSelect.value);
            });
        }

        const soundProfileSelect = document.getElementById('sound-profile-select');
        if (soundProfileSelect) {
            soundProfileSelect.addEventListener('change', () => {
                this.setSoundProfile(soundProfileSelect.value);
            });
        }

        const soundVolumeRange = document.getElementById('sound-volume-range');
        if (soundVolumeRange) {
            soundVolumeRange.addEventListener('input', () => {
                this.setSoundVolume(soundVolumeRange.value);
            });

            soundVolumeRange.addEventListener('change', () => {
                this.setSoundVolume(soundVolumeRange.value, { preview: true });
            });
        }

        const menuSoundsBtn = document.getElementById('menu-sounds-btn');
        if (menuSoundsBtn) {
            menuSoundsBtn.addEventListener('click', () => {
                this.toggleMenuSounds();
            });
        }

        document.querySelectorAll('[data-sound-preview]').forEach((button) => {
            button.addEventListener('click', () => {
                this.previewSoundCue(button.dataset.soundPreview || 'response');
            });
        });

        document.querySelectorAll('[data-tts-preview]').forEach((button) => {
            button.addEventListener('click', () => {
                this.playTtsPreview(button.dataset.ttsPreview || '');
            });
        });

        const minimalistButtons = [
            document.getElementById('minimalist-toggle-btn'),
            document.getElementById('minimalist-toggle-sidebar'),
        ].filter(Boolean);
        minimalistButtons.forEach((button) => {
            button.addEventListener('click', () => {
                this.toggleMinimalistMode();
            });
        });

        document.getElementById('mobile-chat-menu-btn')?.addEventListener('click', () => {
            this.toggleMobileActionSheet();
        });

        document.getElementById('mobile-chat-menu')?.addEventListener('click', (event) => {
            const actionNode = event.target.closest('[data-mobile-menu-action]');
            if (actionNode) {
                this.handleMobileActionSheetAction(actionNode.dataset.mobileMenuAction || '');
                return;
            }

            if (event.target.closest('[data-mobile-menu-close="true"]')) {
                this.closeMobileActionSheet();
            }
        });

        document.getElementById('theme-gallery-grid')?.addEventListener('click', (event) => {
            const presetButton = event.target.closest('[data-theme-preset]');
            if (!presetButton) {
                return;
            }

            this.selectThemePreset(presetButton.dataset.themePreset || '');
        });

        // Command palette input
        const commandInput = document.getElementById('command-input');
        if (commandInput) {
            commandInput.addEventListener('input', (e) => {
                this.renderCommandResults(e.target.value);
            });

            // Keyboard navigation for command palette
            commandInput.addEventListener('keydown', (e) => {
                const items = document.querySelectorAll('.command-item');
                const selected = document.querySelector('.command-item.selected');
                let currentIndex = Array.from(items).indexOf(selected);

                switch (e.key) {
                    case 'ArrowDown':
                        e.preventDefault();
                        currentIndex = (currentIndex + 1) % items.length;
                        break;
                    case 'ArrowUp':
                        e.preventDefault();
                        currentIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
                        break;
                    case 'Enter':
                        e.preventDefault();
                        if (selected) {
                            this.executeCommand(selected.dataset.action);
                        }
                        return;
                    case 'Escape':
                        e.preventDefault();
                        this.closeCommandPalette();
                        return;
                }

                items.forEach((item, index) => {
                    item.classList.toggle('selected', index === currentIndex);
                });
            });
        }

        // Keyboard shortcut for image generation
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
                e.preventDefault();
                this.openImageModal();
            }
        });

        // Keyboard shortcut for shortcuts help (Ctrl + /)
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === '/') {
                e.preventDefault();
                this.openShortcutsModal();
            }
        });

        // Close modals on escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeImageModal();
                this.closeImageLightbox();
                this.closeModelSelector();
                this.closeThemeGallery();
                this.closeShortcutsModal();
                this.closeImportModal();
                this.closeMobileActionSheet();
            }
        });
        
        // Handle visibility change for connection monitoring
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && window.chatApp) {
                // Re-check connection when tab becomes visible
                window.chatApp.checkConnection?.();
            }
        });

        window.addEventListener('resize', () => {
            if (!this.isCompactActionSheetMode()) {
                this.closeMobileActionSheet();
            }
            this.syncSidebarState();
        });
    }

    // ============================================
    // Utilities
    // ============================================

    formatTime(isoString) {
        if (!isoString) return '';
        const date = new Date(isoString);
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();
        
        if (isToday) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    // ============================================
    // Input Area Toggle
    // ============================================
    
    toggleInputArea() {
        const inputArea = document.getElementById('input-area');
        const toggleBtn = document.getElementById('input-toggle-btn');
        const toggleIcon = document.getElementById('input-toggle-icon');
        
        if (!inputArea || !toggleBtn) return;
        
        const isHidden = inputArea.classList.toggle('hidden');
        toggleBtn.classList.toggle('input-hidden', isHidden);
        
        // Update icon
        if (toggleIcon) {
            toggleIcon.setAttribute('data-lucide', isHidden ? 'chevron-up' : 'chevron-down');
            lucide.createIcons();
        }
        
        // Save preference
        this.storageSet('webchat_input_hidden', isHidden ? 'true' : 'false');
        
        // Scroll to bottom if showing input
        if (!isHidden) {
            setTimeout(() => this.scrollToBottom(), 100);
            // Focus input
            const messageInput = document.getElementById('message-input');
            if (messageInput) messageInput.focus();
        }
    }
    
    restoreInputAreaState() {
        if (this.isMinimalistMode() && window.matchMedia('(max-width: 640px)').matches) {
            this.ensureMobileMinimalComposer();
            return;
        }

        const isHidden = this.storageGet('webchat_input_hidden') === 'true';
        const inputArea = document.getElementById('input-area');
        const toggleBtn = document.getElementById('input-toggle-btn');
        const toggleIcon = document.getElementById('input-toggle-icon');

        if (inputArea) {
            inputArea.classList.toggle('hidden', isHidden);
        }
        if (toggleBtn) {
            toggleBtn.classList.toggle('input-hidden', isHidden);
        }
        if (toggleIcon) {
            toggleIcon.setAttribute('data-lucide', isHidden ? 'chevron-up' : 'chevron-down');
            lucide.createIcons();
        }
    }
    
    // ============================================
    // Draft Saving - Auto-save to localStorage
    // ============================================
    
    setupDraftSaving() {
        const messageInput = document.getElementById('message-input');
        if (!messageInput) return;
        
        // Save draft on input
        messageInput.addEventListener('input', () => {
            this.saveDraft(messageInput.value);
        });
        
        // Clear draft when message is sent
        const sendBtn = document.getElementById('send-btn');
        if (sendBtn) {
            sendBtn.addEventListener('click', () => {
                this.clearDraft();
            });
        }
    }
    
    saveDraft(content) {
        try {
            if (content && content.trim()) {
                this.storageSet('kimibuilt_message_draft', content);
                this.storageSet('kimibuilt_message_draft_time', Date.now().toString());
            } else {
                this.clearDraft();
            }
        } catch (e) {
            console.warn('Failed to save draft:', e);
        }
    }
    
    restoreDraft() {
        try {
            const draft = this.storageGet('kimibuilt_message_draft');
            const draftTime = this.storageGet('kimibuilt_message_draft_time');
            
            if (draft && draftTime) {
                const age = Date.now() - parseInt(draftTime, 10);
                const maxAge = 24 * 60 * 60 * 1000; // 24 hours
                
                if (age < maxAge) {
                    const messageInput = document.getElementById('message-input');
                    if (messageInput && !messageInput.value) {
                        messageInput.value = draft;
                        // Trigger input event to resize textarea
                        messageInput.dispatchEvent(new Event('input', { bubbles: true }));
                        this.showToast('Draft restored', 'info', 'Draft');
                    }
                } else {
                    this.clearDraft();
                }
            }
        } catch (e) {
            console.warn('Failed to restore draft:', e);
        }
    }
    
    clearDraft() {
        try {
            this.storageRemove('kimibuilt_message_draft');
            this.storageRemove('kimibuilt_message_draft_time');
        } catch (e) {
            console.warn('Failed to clear draft:', e);
        }
    }
    
    // ============================================
    // Code Block Scroll Indicators
    // ============================================
    
    setupCodeBlockScrollIndicators() {
        const checkScroll = () => {
            document.querySelectorAll('.code-block pre').forEach(pre => {
                if (pre.scrollWidth > pre.clientWidth) {
                    pre.classList.add('can-scroll');
                } else {
                    pre.classList.remove('can-scroll');
                }
            });
        };
        
        // Check on window resize
        window.addEventListener('resize', checkScroll);
        
        // Check after messages are rendered
        const observer = new MutationObserver(() => {
            setTimeout(checkScroll, 100);
        });
        
        const container = document.getElementById('messages-container');
        if (container) {
            observer.observe(container, { childList: true, subtree: true });
        }
    }
}

// Create global UI helpers instance
const uiHelpers = new UIHelpers();
window.uiHelpers = uiHelpers;
