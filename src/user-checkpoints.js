const { getSessionControlState } = require('./runtime-control-state');

const DEFAULT_MAX_USER_CHECKPOINTS = 8;
const MAX_USER_CHECKPOINT_STEPS = 6;
const USER_CHECKPOINT_TOOL_ID = 'user-checkpoint';
const USER_CHECKPOINT_SURFACE = 'web-chat';
const USER_CHECKPOINT_FENCE_LANGUAGE = 'survey';
const USER_CHECKPOINT_RESPONSE_PREFIX = 'Survey response';
const DEFAULT_USER_CHECKPOINT_FREE_TEXT_LABEL = 'Add your own input (optional)';

function trimText(value = '') {
    return String(value || '').trim();
}

function normalizeSurface(value = '') {
    return trimText(value).toLowerCase();
}

function slugifyOptionId(value = '', fallback = 'option') {
    const normalized = trimText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized || fallback;
}

function clampInteger(value, minimum, maximum, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function resolveAllowFreeText(value = {}) {
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

function normalizeCheckpointInputType(value = '', { hasOptions = false, allowMultiple = false } = {}) {
    const normalized = trimText(value)
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

function isUserCheckpointSurface(clientSurface = '') {
    return normalizeSurface(clientSurface) === USER_CHECKPOINT_SURFACE;
}

function normalizeCheckpointOption(option = {}, index = 0) {
    if (typeof option === 'string') {
        const label = trimText(option);
        if (!label) {
            return null;
        }

        return {
            id: slugifyOptionId(label, `option-${index + 1}`),
            label,
        };
    }

    if (!option || typeof option !== 'object') {
        return null;
    }

    const label = trimText(option.label || option.title || option.text || `Option ${index + 1}`);
    if (!label) {
        return null;
    }

    const description = trimText(option.description || option.details || option.hint || '');
    const id = slugifyOptionId(option.id || option.value || label, `option-${index + 1}`);

    return {
        id,
        label,
        ...(description ? { description } : {}),
    };
}

function normalizeCheckpointOptions(options = []) {
    const normalized = (Array.isArray(options) ? options : [])
        .map((option, index) => normalizeCheckpointOption(option, index))
        .filter(Boolean);

    const seen = new Set();
    return normalized
        .filter((option) => {
            if (seen.has(option.id)) {
                return false;
            }
            seen.add(option.id);
            return true;
        })
        .slice(0, 4);
}

function normalizeCheckpointValidationText(value = '') {
    return trimText(value)
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function isLikelyStatusCheckpointOption(option = {}) {
    const label = normalizeCheckpointValidationText(option?.label || '');
    const description = normalizeCheckpointValidationText(option?.description || '');
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

function assertCheckpointStepIsDecisionLike(step = {}) {
    const inputType = trimText(step.inputType || '');
    if (!['choice', 'multi-choice'].includes(inputType)) {
        return;
    }

    const options = Array.isArray(step.options) ? step.options : [];
    if (options.length < 2) {
        return;
    }

    const statusOptionCount = options.filter((option) => isLikelyStatusCheckpointOption(option)).length;
    if (statusOptionCount >= 2 || statusOptionCount === options.length) {
        throw new Error('user-checkpoint choice options must be answerable decisions, not remote status, deployment proof, or progress-summary rows.');
    }
}

function normalizeCheckpointStep(step = {}, index = 0) {
    if (!step || typeof step !== 'object') {
        return null;
    }

    const question = trimText(step.question || step.prompt || step.ask || step.label || '');
    if (!question) {
        return null;
    }

    const options = normalizeCheckpointOptions(step.options || step.choices || []);
    const allowMultiple = step.allowMultiple === true || step.multiple === true;
    const inputType = normalizeCheckpointInputType(step.inputType || step.fieldType || step.type || step.kind || '', {
        hasOptions: options.length > 0,
        allowMultiple,
    });
    const isChoiceInput = inputType === 'choice' || inputType === 'multi-choice';

    if (isChoiceInput && options.length < 2) {
        return null;
    }

    const title = trimText(step.title || '');
    const placeholder = trimText(step.placeholder || step.inputPlaceholder || step.freeTextPlaceholder || '');
    const allowFreeText = isChoiceInput ? resolveAllowFreeText(step) : false;
    const freeTextLabel = allowFreeText
        ? trimText(step.freeTextLabel || step.freeTextPrompt || DEFAULT_USER_CHECKPOINT_FREE_TEXT_LABEL) || DEFAULT_USER_CHECKPOINT_FREE_TEXT_LABEL
        : '';

    const normalizedStep = {
        id: trimText(step.id || `step-${index + 1}`),
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
                    ? clampInteger(step.maxSelections, 1, options.length, Math.min(2, options.length))
                    : 1,
                allowFreeText,
                ...(allowFreeText ? { freeTextLabel } : {}),
            }
            : {}),
    };

    assertCheckpointStepIsDecisionLike(normalizedStep);
    return normalizedStep;
}

function normalizeCheckpointSteps(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const rawSteps = Array.isArray(source.steps)
        ? source.steps
        : (Array.isArray(source.questions)
            ? source.questions
            : (Array.isArray(source.fields) ? source.fields : []));
    const legacyStep = normalizeCheckpointStep({
        ...source,
        options: source.options || source.choices || [],
        inputType: source.inputType || source.type || source.kind || '',
    }, 0);
    const normalizedRawSteps = rawSteps.length > 0
        ? rawSteps
            .map((step, index) => normalizeCheckpointStep(step, index))
            .filter(Boolean)
            .slice(0, MAX_USER_CHECKPOINT_STEPS)
        : [];

    const steps = normalizedRawSteps.length > 0
        ? normalizedRawSteps
        : (legacyStep ? [legacyStep] : []);

    return steps;
}

function buildCheckpointLegacyFields(steps = []) {
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
        ...(firstStep.allowFreeText
            ? { freeTextLabel: firstStep.freeTextLabel || DEFAULT_USER_CHECKPOINT_FREE_TEXT_LABEL }
            : {}),
        inputType: firstStep.inputType || 'choice',
        ...(firstStep.placeholder ? { placeholder: firstStep.placeholder } : {}),
    };
}

function normalizePendingCheckpoint(value = null) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const steps = normalizeCheckpointSteps(value);
    if (steps.length === 0) {
        return null;
    }
    const title = trimText(value.title || 'Choose a direction');
    const whyThisMatters = trimText(value.whyThisMatters || value.context || value.rationale || '');
    const preamble = trimText(value.preamble || value.message || '');

    return {
        id: trimText(value.id || `checkpoint-${Date.now().toString(36)}`),
        title,
        ...(whyThisMatters ? { whyThisMatters } : {}),
        ...(preamble ? { preamble } : {}),
        steps,
        ...buildCheckpointLegacyFields(steps),
    };
}

function getUserCheckpointState(session = null) {
    const controlState = getSessionControlState(session);
    const rawState = controlState?.userCheckpoint && typeof controlState.userCheckpoint === 'object'
        ? controlState.userCheckpoint
        : {};

    const storedMaxQuestions = clampInteger(
        rawState.maxQuestions,
        1,
        12,
        DEFAULT_MAX_USER_CHECKPOINTS,
    );
    const maxQuestions = Math.max(DEFAULT_MAX_USER_CHECKPOINTS, storedMaxQuestions);
    const askedCount = clampInteger(rawState.askedCount, 0, maxQuestions, 0);

    return {
        maxQuestions,
        askedCount,
        pending: normalizePendingCheckpoint(rawState.pending),
        lastResponse: rawState.lastResponse && typeof rawState.lastResponse === 'object'
            ? {
                checkpointId: trimText(rawState.lastResponse.checkpointId || ''),
                summary: trimText(rawState.lastResponse.summary || ''),
                answeredAt: trimText(rawState.lastResponse.answeredAt || ''),
            }
            : null,
    };
}

function buildUserCheckpointPolicy({ session = null, clientSurface = '', latestResponse = null } = {}) {
    const state = getUserCheckpointState(session);
    const enabled = isUserCheckpointSurface(clientSurface);
    const answeredThisTurn = Boolean(latestResponse?.checkpointId);

    return {
        enabled,
        maxQuestions: state.maxQuestions,
        askedCount: state.askedCount,
        remaining: enabled && !answeredThisTurn
            ? Math.max(0, state.maxQuestions - state.askedCount)
            : 0,
        pending: enabled ? state.pending : null,
        lastResponse: state.lastResponse,
        answeredThisTurn,
    };
}

function normalizeCheckpointRequest(params = {}) {
    const steps = normalizeCheckpointSteps(params);
    if (steps.length === 0) {
        throw new Error('user-checkpoint requires either a valid `question` with answer options or a non-empty `steps` questionnaire.');
    }

    return {
        id: trimText(params.id || `checkpoint-${Date.now().toString(36)}`),
        title: trimText(params.title || 'Choose a direction'),
        ...(trimText(params.whyThisMatters || params.context || params.rationale || '')
            ? { whyThisMatters: trimText(params.whyThisMatters || params.context || params.rationale || '') }
            : {}),
        ...(trimText(params.preamble || params.message || 'I need one decision before I continue with the main work.')
            ? { preamble: trimText(params.preamble || params.message || 'I need one decision before I continue with the main work.') }
            : {}),
        steps,
        ...buildCheckpointLegacyFields(steps),
    };
}

function buildUserCheckpointFence(checkpoint) {
    return `\`\`\`${USER_CHECKPOINT_FENCE_LANGUAGE}\n${JSON.stringify(checkpoint, null, 2)}\n\`\`\``;
}

function buildUserCheckpointMessage(checkpoint = null) {
    const normalized = normalizePendingCheckpoint(checkpoint);
    if (!normalized) {
        return 'I need one decision before I continue.';
    }

    const stepCount = Array.isArray(normalized.steps) ? normalized.steps.length : 0;
    const firstStep = stepCount > 0 ? normalized.steps[0] : null;
    const closingLine = stepCount > 1
        ? 'Complete the questionnaire below and I will continue from there.'
        : (['text', 'date', 'time', 'datetime'].includes(firstStep?.inputType)
            ? 'Answer below and I will continue from there.'
            : 'Choose an option below and I will continue from there.');

    return [
        normalized.preamble || 'I need one decision before I continue with the main work.',
        normalized.whyThisMatters || '',
        buildUserCheckpointFence(normalized),
        closingLine,
    ].filter(Boolean).join('\n\n');
}

function extractPendingUserCheckpoint(toolEvents = []) {
    const events = Array.isArray(toolEvents) ? toolEvents : [];
    const checkpointEvent = [...events].reverse().find((event) => (
        (event?.toolCall?.function?.name || event?.result?.toolId || '') === USER_CHECKPOINT_TOOL_ID
        && event?.result?.success !== false
    ));

    if (!checkpointEvent) {
        return null;
    }

    return normalizePendingCheckpoint(
        checkpointEvent?.result?.data?.checkpoint
        || checkpointEvent?.result?.data
        || null,
    );
}

function buildUserCheckpointAskedPatch(session = null, checkpoint = null) {
    const state = getUserCheckpointState(session);
    const normalized = normalizePendingCheckpoint(checkpoint);
    if (!normalized) {
        return {};
    }

    return {
        userCheckpoint: {
            maxQuestions: state.maxQuestions,
            askedCount: Math.min(state.maxQuestions, state.askedCount + 1),
            pending: normalized,
            lastAskedAt: new Date().toISOString(),
        },
    };
}

function parseUserCheckpointResponseMessage(text = '') {
    const normalized = trimText(text);
    if (!normalized) {
        return null;
    }

    const match = normalized.match(/^Survey response \(([^)]+)\):\s*([\s\S]+)$/i);
    if (!match) {
        return null;
    }

    return {
        checkpointId: trimText(match[1]),
        summary: trimText(match[2]),
    };
}

function isUserCheckpointResponseText(text = '') {
    return Boolean(parseUserCheckpointResponseMessage(text));
}

function buildUserCheckpointAnsweredPatch(session = null, response = null) {
    const state = getUserCheckpointState(session);
    if (!response?.checkpointId) {
        return {};
    }

    return {
        userCheckpoint: {
            maxQuestions: state.maxQuestions,
            askedCount: state.askedCount,
            pending: null,
            lastResponse: {
                checkpointId: trimText(response.checkpointId),
                summary: trimText(response.summary || ''),
                answeredAt: new Date().toISOString(),
            },
        },
    };
}

function buildUserCheckpointResponseMessage({ checkpointId = '', selectedOptions = [], notes = '' } = {}) {
    const normalizedCheckpointId = trimText(checkpointId);
    const chosen = (Array.isArray(selectedOptions) ? selectedOptions : [])
        .map((option) => {
            const label = trimText(option?.label || option?.title || option?.id || '');
            const id = trimText(option?.id || '');

            if (!label) {
                return '';
            }

            return id && id !== label
                ? `"${label}" [${id}]`
                : `"${label}"`;
        })
        .filter(Boolean)
        .join(', ');
    const noteText = trimText(notes);
    const summaryParts = [
        chosen ? `chose ${chosen}` : 'answered the checkpoint',
        noteText ? `Notes: ${noteText}` : '',
    ].filter(Boolean);

    return `${USER_CHECKPOINT_RESPONSE_PREFIX} (${normalizedCheckpointId}): ${summaryParts.join('. ')}`;
}

function buildUserCheckpointInstructions(policy = {}) {
    if (policy?.enabled !== true) {
        return '';
    }

    const lines = [
        '[User checkpoint policy]',
        'Continue with reasonable assumptions by default. Pause only when a high-impact decision would materially change the plan, architecture, implementation scope, final output, or safety posture.',
        Number(policy.remaining || 0) > 0
            ? 'A checkpoint card is still available in this session for a real decision gate that cannot be responsibly inferred.'
            : 'No additional checkpoint cards are currently available in this session.',
        policy.pending
            ? `A checkpoint is already pending (${policy.pending.id}). Do not ask another one until the user answers it.`
            : 'If you truly need that decision, call the `user-checkpoint` tool instead of asking in free-form prose.',
        'Do not call or mention `request_user_input` in this runtime. Use `user-checkpoint` for web-chat questionnaires.',
        'On web-chat, use `user-checkpoint` only when one concise choice or direction check is the best way to avoid a wrong or unsafe path.',
        'On web-chat, treat `user-checkpoint` as the primary quick way to involve the user when one concise choice or direction check would help.',
        'On the web-chat surface, do not ask a blocking multiple-choice question as plain assistant text when `user-checkpoint` is available; use the tool so the UI can render inline options.',
        'Prefer `user-checkpoint` over a prose "which option do you want?" message when a real checkpoint is needed.',
        'Do not mention checkpoint quotas, budgets, remaining counts, or internal runtime policy to the user.',
        'Do not claim that the questionnaire rendered, popped up, was dismissed, or was answered unless the transcript explicitly shows the user response.',
        'If the user explicitly asks to test the questionnaire or survey tool, use exactly one `user-checkpoint` question. Do not turn that into a multi-question quiz, personality test, or numbered prose form.',
        'If the user asks you to ask them a survey, questionnaire, inline survey card, or checkpoint card, call `user-checkpoint` directly instead of replying with sample survey text, markdown checkboxes, or an offer to turn it into a card later.',
        'Prefer a reasonable stated assumption over asking a checkpoint when the choice is low-risk or easily reversible.',
        'Use a checkpoint only when the answer would materially change the plan, architecture, implementation scope, or final output.',
        'For build, implementation, deployment, server, and debugging work, do not use a checkpoint for routine next steps such as inspecting logs, editing files, running tests, applying a fix, redeploying, or verifying. Keep executing until the work completes or a hard blocker appears.',
        'Treat missing credentials or secrets, destructive actions, unrecoverable repeated tool failures, and explicit design/product/architecture choices as valid checkpoint reasons.',
        'Do not use a checkpoint for small clarifications or details you can infer reasonably.',
        'Keep the checkpoint concise: one card with one visible step at a time. Prefer 1 question by default, or a short 2 to 4 step questionnaire when the user explicitly wants structured intake or back-and-forth.',
        'Supported step types are single-choice, multi-choice, text, date, time, and datetime. For choice steps, use 2 to 4 strong options and keep the optional free-text path available when helpful.',
        'For choice checkpoints, every option must be an answer the user can choose. Do not use remote status rows, deployment proof, file paths, git status, verification results, progress summaries, or completed-work bullets as options.',
        `Do not turn checkpoints into long forms or sprawling questionnaires. Keep them to at most ${MAX_USER_CHECKPOINT_STEPS} steps unless the product adds a richer form surface.`,
        'If there are no checkpoint questions remaining, do not output a prose questionnaire, numbered list of questions, or pseudo-survey.',
        'If more user input is truly required after no checkpoint cards remain, do not say the quota or budget is exhausted; ask at most one concise plain-text question or proceed with the best reasonable assumption and state that assumption briefly.',
        'When the user sends a message starting with `Survey response (` treat it as the answer to the checkpoint and continue the work.',
        'After a checkpoint answer, do not ask a fresh checkpoint unless the user explicitly asks for more intake or a new high-impact blocker appears.',
        'For research, web-search, web-fetch, or web-scrape work, avoid multi-step intake forms and example-heavy scrape surveys.',
        'Do not use a checkpoint just to ask which public websites to scrape for routine research-backed slides, reports, or deep research. Discover candidate URLs with Perplexity-backed search, choose the strongest sites yourself, verify them with `web-fetch` first, and only scrape when the page needs rendered or structured extraction.',
        'For daily news, article roundups, source-backed briefings, and gathered research data, use the richer research path yourself instead of asking the user for source lists.',
        'If research or scraping truly needs clarification, use one short choice checkpoint with 2 to 4 concrete options as a quick hotlist, then continue the work after the answer.',
    ];

    return lines.join('\n');
}

module.exports = {
    DEFAULT_MAX_USER_CHECKPOINTS,
    MAX_USER_CHECKPOINT_STEPS,
    USER_CHECKPOINT_FENCE_LANGUAGE,
    USER_CHECKPOINT_RESPONSE_PREFIX,
    USER_CHECKPOINT_SURFACE,
    USER_CHECKPOINT_TOOL_ID,
    DEFAULT_USER_CHECKPOINT_FREE_TEXT_LABEL,
    buildUserCheckpointAnsweredPatch,
    buildUserCheckpointAskedPatch,
    buildUserCheckpointInstructions,
    buildUserCheckpointMessage,
    buildUserCheckpointPolicy,
    buildUserCheckpointResponseMessage,
    extractPendingUserCheckpoint,
    getUserCheckpointState,
    isUserCheckpointSurface,
    isUserCheckpointResponseText,
    normalizeCheckpointRequest,
    normalizePendingCheckpoint,
    parseUserCheckpointResponseMessage,
    isLikelyStatusCheckpointOption,
};
