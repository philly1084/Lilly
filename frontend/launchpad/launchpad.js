(function initLillyLaunchpad(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.LillyLaunchpad = api;
    }
    if (root?.document) {
        root.document.addEventListener('DOMContentLoaded', () => api.hydrateLaunchpad(root.document));
    }
})(typeof window !== 'undefined' ? window : globalThis, () => {
    const MISSION_TEMPLATES = Object.freeze({
        'build-launch': Object.freeze({
            id: 'build-launch',
            label: 'Build and launch',
            starter: 'Build and launch a polished product experience from this goal. Keep the objective, plan, live progress, decisions, artifacts, deployment state, and verification evidence connected. Ask before any material external or destructive action, and do not claim success without real route or browser proof.',
        }),
        'research-publish': Object.freeze({
            id: 'research-publish',
            label: 'Research and publish',
            starter: 'Research this topic using current, credible sources and publish a concise, decision-ready brief. Keep citations attached to claims, produce a reusable artifact, and show the checks or limits that affect confidence.',
        }),
        'create-refine': Object.freeze({
            id: 'create-refine',
            label: 'Create and refine',
            starter: 'Create a finished document or editable visual for this goal, then keep every refinement tied to the source artifact and revision lineage. Use precise edits, preserve working content, and show target-medium verification before calling it complete.',
        }),
    });

    function getMissionTemplate(templateId = '') {
        return MISSION_TEMPLATES[String(templateId || '').trim()] || null;
    }

    function buildMissionHref(templateId = '', basePath = '/web-chat/app.html') {
        const template = getMissionTemplate(templateId);
        if (!template) {
            return basePath;
        }
        const params = new URLSearchParams({
            mission: template.id,
            starter: template.starter,
        });
        return `${basePath}?${params.toString()}`;
    }

    function hydrateLaunchpad(documentRef) {
        if (!documentRef?.querySelectorAll) {
            return 0;
        }
        const links = Array.from(documentRef.querySelectorAll('[data-mission-link]'));
        links.forEach((link) => {
            const template = getMissionTemplate(link.dataset.missionLink);
            if (!template) {
                return;
            }
            link.href = buildMissionHref(template.id);
            link.setAttribute('aria-label', `${template.label} with Lilly`);
        });
        return links.length;
    }

    return {
        MISSION_TEMPLATES,
        getMissionTemplate,
        buildMissionHref,
        hydrateLaunchpad,
    };
});
