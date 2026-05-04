function toFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function getNestedValue(source = {}, path = '') {
    return String(path || '')
        .split('.')
        .filter(Boolean)
        .reduce((current, segment) => (
            current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)
                ? current[segment]
                : undefined
        ), source);
}

function firstFiniteValue(source = {}, paths = []) {
    for (const path of paths) {
        const value = toFiniteNumber(getNestedValue(source, path));
        if (value !== null) {
            return value;
        }
    }

    return null;
}

function hasUsagePath(source = {}, paths = []) {
    return paths.some((path) => getNestedValue(source, path) !== undefined);
}

function normalizeUsageMetadata(usage = {}) {
    if (!usage || typeof usage !== 'object') {
        return null;
    }

    const promptPaths = [
        'promptTokens',
        'prompt_tokens',
        'inputTokens',
        'input_tokens',
        'input',
        'prompt',
        'prompt_eval_count',
        'tokens.input',
        'tokens.prompt',
        'usage.promptTokens',
        'usage.prompt_tokens',
        'usage.inputTokens',
        'usage.input_tokens',
        'usage_metadata.prompt_tokens',
        'usage_metadata.input_tokens',
        'usageMetadata.promptTokens',
        'usageMetadata.inputTokens',
        'tokenUsage.promptTokens',
        'tokenUsage.inputTokens',
        'token_usage.prompt_tokens',
        'token_usage.input_tokens',
        'total_token_usage.prompt_tokens',
        'total_token_usage.input_tokens',
        'totalTokenUsage.promptTokens',
        'totalTokenUsage.inputTokens',
    ];
    const completionPaths = [
        'completionTokens',
        'completion_tokens',
        'outputTokens',
        'output_tokens',
        'output',
        'completion',
        'eval_count',
        'tokens.output',
        'tokens.completion',
        'usage.completionTokens',
        'usage.completion_tokens',
        'usage.outputTokens',
        'usage.output_tokens',
        'usage_metadata.completion_tokens',
        'usage_metadata.output_tokens',
        'usageMetadata.completionTokens',
        'usageMetadata.outputTokens',
        'tokenUsage.completionTokens',
        'tokenUsage.outputTokens',
        'token_usage.completion_tokens',
        'token_usage.output_tokens',
        'total_token_usage.completion_tokens',
        'total_token_usage.output_tokens',
        'totalTokenUsage.completionTokens',
        'totalTokenUsage.outputTokens',
    ];
    const totalPaths = [
        'totalTokens',
        'total_tokens',
        'tokensUsed',
        'tokens_used',
        'total',
        'token_count',
        'tokenCount',
        'tokens.total',
        'usage.totalTokens',
        'usage.total_tokens',
        'usage.tokensUsed',
        'usage_metadata.total_tokens',
        'usageMetadata.totalTokens',
        'tokenUsage.totalTokens',
        'token_usage.total_tokens',
        'total_token_usage.total_tokens',
        'totalTokenUsage.totalTokens',
    ];
    const reasoningPaths = [
        'reasoningTokens',
        'reasoning_tokens',
        'outputTokenDetails.reasoningTokens',
        'output_tokens_details.reasoning_tokens',
        'completion_tokens_details.reasoning_tokens',
        'usage.output_tokens_details.reasoning_tokens',
        'usage.completion_tokens_details.reasoning_tokens',
        'usageMetadata.outputTokenDetails.reasoningTokens',
        'tokenUsage.reasoningTokens',
        'total_token_usage.reasoning_tokens',
    ];
    const cachedPaths = [
        'cachedTokens',
        'cached_tokens',
        'inputTokenDetails.cachedTokens',
        'input_tokens_details.cached_tokens',
        'prompt_tokens_details.cached_tokens',
        'usage.input_tokens_details.cached_tokens',
        'usage.prompt_tokens_details.cached_tokens',
        'usageMetadata.inputTokenDetails.cachedTokens',
        'tokenUsage.cachedTokens',
        'total_token_usage.cached_tokens',
    ];
    const modelCallPaths = [
        'modelCalls',
        'model_calls',
        'usage.modelCalls',
        'usage.model_calls',
        'tokenUsage.modelCalls',
        'token_usage.model_calls',
        'total_token_usage.model_calls',
        'totalTokenUsage.modelCalls',
    ];

    const promptTokens = firstFiniteValue(usage, promptPaths);
    const completionTokens = firstFiniteValue(usage, completionPaths);
    const totalTokens = firstFiniteValue(usage, totalPaths);
    const reasoningTokens = firstFiniteValue(usage, reasoningPaths);
    const cachedTokens = firstFiniteValue(usage, cachedPaths);
    const modelCalls = firstFiniteValue(usage, modelCallPaths);

    const hasExplicitUsage = [
        hasUsagePath(usage, promptPaths),
        hasUsagePath(usage, completionPaths),
        hasUsagePath(usage, totalPaths),
        hasUsagePath(usage, reasoningPaths),
        hasUsagePath(usage, cachedPaths),
        hasUsagePath(usage, modelCallPaths),
    ].some(Boolean);

    if (!hasExplicitUsage) {
        return null;
    }

    const normalized = {};
    if (promptTokens !== null) {
        normalized.promptTokens = promptTokens;
        normalized.inputTokens = promptTokens;
    }
    if (completionTokens !== null) {
        normalized.completionTokens = completionTokens;
        normalized.outputTokens = completionTokens;
    }
    if (totalTokens !== null) {
        normalized.totalTokens = totalTokens;
    } else if (promptTokens !== null || completionTokens !== null) {
        normalized.totalTokens = (promptTokens || 0) + (completionTokens || 0);
    }
    if (reasoningTokens !== null) {
        normalized.reasoningTokens = reasoningTokens;
    }
    if (cachedTokens !== null) {
        normalized.cachedTokens = cachedTokens;
    }
    if (modelCalls !== null) {
        normalized.modelCalls = modelCalls;
    }

    return normalized;
}

function mergeUsageMetadata(...entries) {
    const flattened = entries.flat().filter(Boolean);
    const totals = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0,
        modelCalls: 0,
    };
    let hasUsage = false;
    let hasPrompt = false;
    let hasCompletion = false;
    let hasTotal = false;
    let hasReasoning = false;
    let hasCached = false;
    let hasModelCalls = false;

    for (const entry of flattened) {
        const normalized = normalizeUsageMetadata(entry);
        if (!normalized) {
            continue;
        }

        hasUsage = true;

        if (Object.prototype.hasOwnProperty.call(normalized, 'promptTokens')) {
            totals.promptTokens += normalized.promptTokens;
            totals.inputTokens += normalized.inputTokens;
            hasPrompt = true;
        }
        if (Object.prototype.hasOwnProperty.call(normalized, 'completionTokens')) {
            totals.completionTokens += normalized.completionTokens;
            totals.outputTokens += normalized.outputTokens;
            hasCompletion = true;
        }
        if (Object.prototype.hasOwnProperty.call(normalized, 'totalTokens')) {
            totals.totalTokens += normalized.totalTokens;
            hasTotal = true;
        }
        if (Object.prototype.hasOwnProperty.call(normalized, 'reasoningTokens')) {
            totals.reasoningTokens += normalized.reasoningTokens;
            hasReasoning = true;
        }
        if (Object.prototype.hasOwnProperty.call(normalized, 'cachedTokens')) {
            totals.cachedTokens += normalized.cachedTokens;
            hasCached = true;
        }
        if (Object.prototype.hasOwnProperty.call(normalized, 'modelCalls')) {
            totals.modelCalls += normalized.modelCalls;
            hasModelCalls = true;
        }
    }

    if (!hasUsage) {
        return null;
    }

    const normalizedTotals = {};
    if (hasPrompt) {
        normalizedTotals.promptTokens = totals.promptTokens;
        normalizedTotals.inputTokens = totals.inputTokens;
    }
    if (hasCompletion) {
        normalizedTotals.completionTokens = totals.completionTokens;
        normalizedTotals.outputTokens = totals.outputTokens;
    }
    if (hasTotal) {
        normalizedTotals.totalTokens = totals.totalTokens;
    } else if (hasPrompt || hasCompletion) {
        normalizedTotals.totalTokens = totals.promptTokens + totals.completionTokens;
    }
    if (hasReasoning) {
        normalizedTotals.reasoningTokens = totals.reasoningTokens;
    }
    if (hasCached) {
        normalizedTotals.cachedTokens = totals.cachedTokens;
    }
    if (hasModelCalls) {
        normalizedTotals.modelCalls = totals.modelCalls;
    }

    return normalizedTotals;
}

function withDefaultModelCallCount(usage = {}, defaultModelCalls = 1) {
    const normalized = normalizeUsageMetadata(usage);
    if (!normalized) {
        return null;
    }

    if (Object.prototype.hasOwnProperty.call(normalized, 'modelCalls')) {
        return normalized;
    }

    return {
        ...normalized,
        modelCalls: defaultModelCalls,
    };
}

function extractResponseUsageMetadata(response = {}) {
    const metadataUsage = withDefaultModelCallCount(
        response?.metadata?.usage
        || response?.metadata?.tokenUsage
        || response?._kimibuilt?.usage
        || response?._kimibuilt?.tokenUsage,
        1,
    );
    if (metadataUsage) {
        return metadataUsage;
    }

    return withDefaultModelCallCount(response?.usage || {}, 1);
}

function extractUsageMetadataFromTrace(executionTrace = []) {
    const traceEntries = Array.isArray(executionTrace) ? executionTrace : [];
    const usageEntries = [];

    for (const entry of traceEntries) {
        const type = String(entry?.type || '').trim().toLowerCase();
        if (!['model_call', 'model-call', 'llm-call', 'llm_call'].includes(type)) {
            continue;
        }

        usageEntries.push(
            entry?.details?.usage,
            entry?.details?.tokenUsage,
            entry?.metadata?.usage,
            entry?.metadata?.tokenUsage,
        );

        const metadataTokens = entry?.metadata?.tokens;
        if (metadataTokens && typeof metadataTokens === 'object') {
            usageEntries.push({
                promptTokens: metadataTokens.input,
                completionTokens: metadataTokens.output,
            });
        }
    }

    return mergeUsageMetadata(usageEntries.filter(Boolean));
}

function createZeroUsageMetadata() {
    return normalizeUsageMetadata({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        modelCalls: 0,
    });
}

module.exports = {
    createZeroUsageMetadata,
    extractResponseUsageMetadata,
    extractUsageMetadataFromTrace,
    mergeUsageMetadata,
    normalizeUsageMetadata,
};
