const {
    buildUserCheckpointContinuationInput,
    buildUserCheckpointAnsweredPatch,
    buildUserCheckpointAskedPatch,
    extractPendingUserCheckpoint,
    getUserCheckpointState,
    parseUserCheckpointResponseMessage,
} = require('./user-checkpoints');
const { resolveTranscriptObjectiveFromSession } = require('./conversation-continuity');

function attachUpdatedControlState(session = null, controlState = null) {
    if (!session || !controlState) {
        return session;
    }

    return {
        ...session,
        controlState,
        metadata: {
            ...(session.metadata || {}),
            controlState,
        },
    };
}

function buildUserCheckpointPolicyMetadata(policy = {}) {
    const normalizedPolicy = policy && typeof policy === 'object' ? policy : {};

    return {
        enabled: normalizedPolicy.enabled === true,
        maxQuestions: Math.max(0, Number(normalizedPolicy.maxQuestions) || 0),
        askedCount: Math.max(0, Number(normalizedPolicy.askedCount) || 0),
        remaining: Math.max(0, Number(normalizedPolicy.remaining) || 0),
        pending: normalizedPolicy.pending
            ? {
                id: String(normalizedPolicy.pending.id || '').trim(),
                title: String(normalizedPolicy.pending.title || '').trim(),
                question: String(normalizedPolicy.pending.question || '').trim(),
            }
            : null,
        answeredThisTurn: normalizedPolicy.answeredThisTurn === true,
    };
}

async function applyAnsweredUserCheckpointState(sessionStore, sessionId, session, userText = '') {
    const response = parseUserCheckpointResponseMessage(userText);
    if (!response) {
        return {
            session,
            response: null,
        };
    }

    const checkpointState = getUserCheckpointState(session);
    if (checkpointState.pending?.id && checkpointState.pending.id !== response.checkpointId) {
        return {
            session,
            response,
        };
    }

    const controlState = await sessionStore.updateControlState(
        sessionId,
        buildUserCheckpointAnsweredPatch(session, response),
    );

    return {
        session: attachUpdatedControlState(session, controlState),
        response,
        checkpoint: checkpointState.pending,
    };
}

function resolveAnsweredUserCheckpointInput({
    userText = '',
    response = null,
    checkpoint = null,
    recentMessages = [],
} = {}) {
    if (!response) {
        return String(userText || '').trim();
    }

    const transcriptObjective = resolveTranscriptObjectiveFromSession(userText, recentMessages);
    return buildUserCheckpointContinuationInput({
        userText,
        response,
        checkpoint,
        priorObjective: transcriptObjective.priorUserObjective || '',
    });
}

async function applyAskedUserCheckpointState(sessionStore, sessionId, session, toolEvents = []) {
    const checkpoint = extractPendingUserCheckpoint(toolEvents);
    if (!checkpoint) {
        return session;
    }

    const controlState = await sessionStore.updateControlState(
        sessionId,
        buildUserCheckpointAskedPatch(session, checkpoint),
    );

    return attachUpdatedControlState(session, controlState);
}

module.exports = {
    applyAnsweredUserCheckpointState,
    applyAskedUserCheckpointState,
    buildUserCheckpointPolicyMetadata,
    resolveAnsweredUserCheckpointInput,
};
