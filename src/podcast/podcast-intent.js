function hasExplicitPodcastIntent(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return false;
    }

    return [
        /\bpodcasts?\b/i,
        /\btwo[- ]host podcasts?\b/i,
        /\btwo[- ]agent podcasts?\b/i,
        /\b(?:record|make|create|generate|produce|turn|convert)\b[\s\S]{0,40}\b(?:a |the )?podcasts?\b/i,
        /\b(?:use|run|start|launch|trigger)\b[\s\S]{0,20}\bpodcast(?: workflow| tool)?\b/i,
    ].some((pattern) => pattern.test(normalized));
}

function hasExplicitPodcastVideoIntent(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return false;
    }

    return [
        /\bvideo\s+podcasts?\b/i,
        /\bpodcasts?\s+videos?\b/i,
        /\b(?:mp4|m4v|rendered|encoded)\b[\s\S]{0,40}\bpodcasts?\b/i,
        /\bpodcasts?\b[\s\S]{0,40}\b(?:mp4|m4v|rendered|encoded|video|visuals?|images?|cover art|scene images?)\b/i,
        /\b(?:make|create|generate|produce|build|render)\b[\s\S]{0,60}\b(?:podcasts?)\b[\s\S]{0,60}\b(?:video|visuals?|images?|mp4)\b/i,
        /\b(?:make|create|generate|produce|build|render)\b[\s\S]{0,60}\b(?:video|mp4)\b[\s\S]{0,60}\b(?:podcasts?)\b/i,
    ].some((pattern) => pattern.test(normalized));
}

function inferPodcastVideoAspectRatio(text = '') {
    const normalized = String(text || '').toLowerCase();
    if (/\b(?:vertical|portrait|shorts?|reels?|tiktok|9:16)\b/.test(normalized)) {
        return '9:16';
    }
    if (/\b(?:square|instagram post|1:1)\b/.test(normalized)) {
        return '1:1';
    }
    if (/\b(?:wide|widescreen|landscape|youtube|16:9)\b/.test(normalized)) {
        return '16:9';
    }
    return '16:9';
}

function inferPodcastVideoImageMode(text = '') {
    const normalized = String(text || '').toLowerCase();
    if (/\b(?:no generated images?|no ai images?|stock only|real photos? only|web images? only)\b/.test(normalized)) {
        return 'web';
    }
    if (/\b(?:generated images?|ai images?|custom images?|illustrations?|cover art|scene art)\b/.test(normalized)) {
        return 'generated';
    }
    if (/\b(?:unsplash|stock photos?)\b/.test(normalized)) {
        return 'unsplash';
    }
    if (/\b(?:fallback only|simple frames?|placeholder frames?)\b/.test(normalized)) {
        return 'fallback';
    }
    return 'generated';
}

function inferPodcastVideoSceneCount(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return null;
    }

    const match = normalized.match(/\b(\d{1,2})\s+(?:scenes?|slides?|visuals?|images?|frames?)\b/i);
    if (!match) {
        return null;
    }

    const count = Number(match[1]);
    if (!Number.isFinite(count) || count < 1) {
        return null;
    }

    return Math.max(1, Math.min(36, Math.round(count)));
}

function hasExplicitPodcastStoryboardIntent(text = '') {
    return /\b(?:generated images?|ai images?|custom images?|illustrations?|visuals?|scene images?|cover art|artwork|storyboards?|slides?|stock photos?|web images?|unsplash|infographics?|designed pages?|content pages?|image output|match(?:es|ing)? (?:the )?content|visual show)\b/i
        .test(String(text || ''));
}

function inferPodcastVideoOptions(text = '') {
    if (!hasExplicitPodcastVideoIntent(text)) {
        return {};
    }

    const imageMode = inferPodcastVideoImageMode(text);
    const generateImages = !/\b(?:no generated images?|no ai images?|do not generate images?|without generated images?)\b/i.test(String(text || ''));
    const sceneCount = inferPodcastVideoSceneCount(text);
    const normalized = String(text || '');
    const useStoryboard = hasExplicitPodcastStoryboardIntent(text)
        || /\b(?:video\s+podcasts?|podcasts?\s+videos?)\b/i.test(normalized);

    return {
        includeVideo: true,
        videoAspectRatio: inferPodcastVideoAspectRatio(text),
        videoRenderMode: useStoryboard ? 'storyboard' : 'waveform-card',
        videoImageMode: useStoryboard ? imageMode : 'fallback',
        videoGenerateImages: useStoryboard ? generateImages : false,
        ...(sceneCount ? { videoSceneCount: sceneCount } : {}),
    };
}

function inferPodcastAudioAssetOptions(text = '') {
    const normalized = String(text || '').toLowerCase();
    if (!normalized.trim()) {
        return {};
    }

    const explicitCleanAudio = /\b(?:speaker[- ]only|voice[- ]only|clean audio|no music|without music|no intro|without intro|no outro|without outro|no admin audio|without admin audio|no audio sources|without audio sources)\b/i
        .test(normalized);
    if (explicitCleanAudio) {
        return {
            voiceOnlyAudio: true,
            includeIntro: false,
            includeOutro: false,
            includeMusicBed: false,
        };
    }

    const useAllAdminAudio = /\b(?:admin|uploaded|saved|configured)\s+(?:podcast\s+)?(?:audio|audio sources|audio assets|tracks)\b/i.test(normalized)
        || /\b(?:use|add|include|with)\b[\s\S]{0,40}\b(?:podcast\s+)?(?:audio sources|audio assets|admin audio|uploaded audio|saved audio|configured audio)\b/i.test(normalized);
    const includeIntro = useAllAdminAudio
        || /\b(?:use|add|include|with)\b[\s\S]{0,30}\b(?:intro|opening bumper|opener)\b/i.test(normalized);
    const includeOutro = useAllAdminAudio
        || /\b(?:use|add|include|with)\b[\s\S]{0,30}\b(?:outro|closing bumper|closer)\b/i.test(normalized);
    const includeMusicBed = useAllAdminAudio
        || /\b(?:use|add|include|with|want|needs?|give it|make it)\b[\s\S]{0,50}\b(?:music bed|background music|bed music|theme music|backing track|soundtrack|score|music underneath|music underlay)\b/i.test(normalized)
        || /\b(?:music bed|background music|bed music|theme music|backing track|soundtrack|score)\b[\s\S]{0,30}\b(?:under|behind|beneath|throughout|in the background)\b/i.test(normalized);

    if (!includeIntro && !includeOutro && !includeMusicBed) {
        return {};
    }

    return {
        voiceOnlyAudio: false,
        ...(includeIntro ? { includeIntro: true } : {}),
        ...(includeOutro ? { includeOutro: true } : {}),
        ...(includeMusicBed ? { includeMusicBed: true } : {}),
    };
}

function cleanExtractedPodcastTopic(value = '') {
    return String(value || '')
        .replace(/\b(?:with|using|use|include|add)\s+(?:the\s+)?(?:admin|uploaded|saved|configured)\s+(?:podcast\s+)?(?:audio|audio sources|audio assets|tracks)\b[\s\S]*$/i, '')
        .replace(/\b(?:with|using|use|include|add|want|needs?)\s+(?:an?\s+)?(?:subtle|light|soft|quiet|ambient|background)?\s*(?:intro|outro|music bed|background music|background soundtrack|opening bumper|closing bumper|theme music|backing track|soundtrack|score)\b[\s\S]*$/i, '')
        .replace(/\b(?:speaker[- ]only|voice[- ]only|clean audio|no music|without music|no admin audio|without admin audio|no audio sources|without audio sources)\b[\s\S]*$/i, '')
        .replace(/\bwith\s+(?:generated|ai|custom|scene|cover)\s+(?:images?|visuals?|art|artwork)\b[\s\S]*$/i, '')
        .replace(/\bwith\s+(?:visuals?|scene images?|cover art|an? image|images?)\b[\s\S]*$/i, '')
        .replace(/\b(?:as|for)\s+(?:an?\s+)?(?:video\s+podcast|podcast\s+video|mp4)\b[\s\S]*$/i, '')
        .replace(/\b(?:in|as)\s+(?:vertical|portrait|landscape|widescreen|square|9:16|16:9|1:1)\b[\s\S]*$/i, '')
        .replace(/[.?!]+$/, '')
        .trim();
}

function extractPodcastRequestBrief(text = '') {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function inferPodcastHostCount(text = '') {
    const normalized = String(text || '').toLowerCase();
    if (!normalized.trim()) {
        return null;
    }

    if (/\b(?:one|1|single|solo)[- ](?:speaker|host|voice|narrator)\b/.test(normalized)
        || /\b(?:one|1)\s+speaker\b/.test(normalized)
        || /\b(?:solo|single-host|single host|monologue|one-person|one person)\b/.test(normalized)
        || /\bwithout\s+(?:a\s+)?(?:co[- ]?host|second speaker|second host)\b/.test(normalized)) {
        return 1;
    }

    if (/\b(?:two|2|dual)[- ](?:speaker|host|voice|narrator)\b/.test(normalized)
        || /\b(?:two|2)\s+(?:speakers|hosts|voices)\b/.test(normalized)
        || /\bco[- ]?host\b/.test(normalized)
        || /\bconversation\b/.test(normalized)) {
        return 2;
    }

    return null;
}

function extractExplicitPodcastTopic(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return null;
    }

    const cleaned = normalized
        .replace(/\b(can you|could you|please|let'?s|lets|i want|we need to|help me)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const matchers = [
        /\bpodcasts?(?: episode)?\b[\s\S]{0,30}\b(?:about|on|regarding|covering)\b\s+(.+)$/i,
        /\b(?:make|create|generate|record|produce|turn|convert)\b[\s\S]{0,30}\bpodcasts?\b[\s\S]{0,20}\b(?:about|on|regarding|covering)\b\s+(.+)$/i,
        /\b(?:use|run|start|launch|trigger)\b[\s\S]{0,20}\bpodcast(?: workflow| tool)?\b[\s\S]{0,20}\b(?:for|on|about)\b\s+(.+)$/i,
        /\b(?:about|on)\b\s+(.+?)\s*\b(?:for|in)\s+(?:a |the )?podcasts?\b/i,
    ];

    for (const matcher of matchers) {
        const candidate = String(cleaned.match(matcher)?.[1] || '').trim();
        if (candidate) {
            return cleanExtractedPodcastTopic(candidate);
        }
    }

    return cleanExtractedPodcastTopic(cleaned) || null;
}

module.exports = {
    hasExplicitPodcastIntent,
    hasExplicitPodcastVideoIntent,
    inferPodcastVideoOptions,
    inferPodcastAudioAssetOptions,
    extractExplicitPodcastTopic,
    extractPodcastRequestBrief,
    inferPodcastHostCount,
};
