const { Router } = require('express');
const { sessionStore } = require('../session-store');

const WEB_CHAT_PREFERENCE_KEYS = new Set([
    'kimibuilt_default_model',
    'kimibuilt_reasoning_effort',
    'kimibuilt_remote_build_autonomy',
    'kimibuilt_theme_preset',
    'kimibuilt_theme',
    'webchat_layout_mode',
    'kimibuilt_sound_cues_enabled',
    'kimibuilt_menu_sounds_enabled',
    'kimibuilt_sound_profile',
    'kimibuilt_sound_volume',
    'kimibuilt_tts_autoplay',
    'kimibuilt_tts_voice_id',
    'webchat_input_hidden',
    'kimibuilt_sidebar_width',
    'kimibuilt_sidebar_collapsed',
    'kimibuilt_web_chat_workspace_host_active',
]);

const router = Router();

function getRequestOwnerId(req) {
    return String(req.user?.username || '').trim() || null;
}

function normalizeWebChatPreferencePatch(source = {}) {
    const input = source && typeof source === 'object' && !Array.isArray(source)
        ? source
        : {};
    const normalized = {};

    Object.entries(input).forEach(([rawKey, rawValue]) => {
        const key = String(rawKey || '').trim();
        if (!WEB_CHAT_PREFERENCE_KEYS.has(key)) {
            return;
        }

        if (rawValue == null) {
            normalized[key] = null;
            return;
        }

        const value = String(rawValue);
        if (!value || value.length > 512) {
            return;
        }

        normalized[key] = value;
    });

    return normalized;
}

router.get('/web-chat', async (req, res, next) => {
    try {
        const preferences = await sessionStore.getUserPreferences(getRequestOwnerId(req), 'webChat');
        res.json({
            preferences,
            count: Object.keys(preferences || {}).length,
        });
    } catch (err) {
        next(err);
    }
});

router.put('/web-chat', async (req, res, next) => {
    try {
        const patch = normalizeWebChatPreferencePatch(req.body?.preferences || req.body || {});
        const preferences = await sessionStore.patchUserPreferences(
            getRequestOwnerId(req),
            'webChat',
            patch,
        );

        res.json({
            preferences,
            count: Object.keys(preferences || {}).length,
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
