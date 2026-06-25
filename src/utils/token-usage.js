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

function firstStringValue(source = {}, paths = []) {
    for (const path of paths) {
        const value = getNestedValue(source, path);
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    return '';
}

function sumFiniteValues(source = {}, paths = []) {
    let total = 0;
    let found = false;

    for (const path of paths) {
        const value = toFiniteNumber(getNestedValue(source, path));
        if (value !== null) {
            total += value;
            found = true;
        }
    }

    return found ? total : null;
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
        'usage_metadata.prompt_token_count',
        'usage_metadata.input_tokens',
        'usage_metadata.input_token_count',
        'usageMetadata.promptTokens',
        'usageMetadata.promptTokenCount',
        'usageMetadata.inputTokens',
        'usageMetadata.inputTokenCount',
        'tokenUsage.promptTokens',
        'tokenUsage.inputTokens',
        'token_usage.prompt_tokens',
        'token_usage.input_tokens',
        'total_token_usage.prompt_tokens',
        'total_token_usage.input_tokens',
        'totalTokenUsage.promptTokens',
        'totalTokenUsage.inputTokens',
        'payload.usage.promptTokens',
        'payload.usage.prompt_tokens',
        'payload.usage.inputTokens',
        'payload.usage.input_tokens',
        'payload.tokenUsage.promptTokens',
        'payload.tokenUsage.inputTokens',
        'payload.token_usage.prompt_tokens',
        'payload.token_usage.input_tokens',
        'payload.total_token_usage.prompt_tokens',
        'payload.total_token_usage.input_tokens',
        'payload.totalTokenUsage.promptTokens',
        'payload.totalTokenUsage.inputTokens',
        'body.usage.prompt_tokens',
        'response.usage.prompt_tokens',
        'result.usage.prompt_tokens',
        'data.usage.prompt_tokens',
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
        'usage_metadata.candidates_token_count',
        'usage_metadata.output_tokens',
        'usage_metadata.output_token_count',
        'usageMetadata.completionTokens',
        'usageMetadata.candidatesTokenCount',
        'usageMetadata.outputTokens',
        'usageMetadata.outputTokenCount',
        'tokenUsage.completionTokens',
        'tokenUsage.outputTokens',
        'token_usage.completion_tokens',
        'token_usage.output_tokens',
        'total_token_usage.completion_tokens',
        'total_token_usage.output_tokens',
        'totalTokenUsage.completionTokens',
        'totalTokenUsage.outputTokens',
        'payload.usage.completionTokens',
        'payload.usage.completion_tokens',
        'payload.usage.outputTokens',
        'payload.usage.output_tokens',
        'payload.tokenUsage.completionTokens',
        'payload.tokenUsage.outputTokens',
        'payload.token_usage.completion_tokens',
        'payload.token_usage.output_tokens',
        'payload.total_token_usage.completion_tokens',
        'payload.total_token_usage.output_tokens',
        'payload.totalTokenUsage.completionTokens',
        'payload.totalTokenUsage.outputTokens',
        'body.usage.completion_tokens',
        'response.usage.completion_tokens',
        'result.usage.completion_tokens',
        'data.usage.completion_tokens',
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
        'usage_metadata.total_token_count',
        'usageMetadata.totalTokens',
        'usageMetadata.totalTokenCount',
        'tokenUsage.totalTokens',
        'token_usage.total_tokens',
        'total_token_usage.total_tokens',
        'totalTokenUsage.totalTokens',
        'payload.usage.totalTokens',
        'payload.usage.total_tokens',
        'payload.usage.tokensUsed',
        'payload.tokenUsage.totalTokens',
        'payload.token_usage.total_tokens',
        'payload.total_token_usage.total_tokens',
        'payload.totalTokenUsage.totalTokens',
        'body.usage.total_tokens',
        'response.usage.total_tokens',
        'result.usage.total_tokens',
        'data.usage.total_tokens',
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
        'usageMetadata.thoughtsTokenCount',
        'usage_metadata.thoughts_token_count',
        'tokenUsage.reasoningTokens',
        'total_token_usage.reasoning_tokens',
        'payload.usage.reasoning_tokens',
        'payload.usage.output_tokens_details.reasoning_tokens',
        'payload.usage.completion_tokens_details.reasoning_tokens',
        'payload.tokenUsage.reasoningTokens',
        'payload.total_token_usage.reasoning_tokens',
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
        'usageMetadata.cachedContentTokenCount',
        'usage_metadata.cached_content_token_count',
        'tokenUsage.cachedTokens',
        'total_token_usage.cached_tokens',
        'payload.usage.cached_tokens',
        'payload.usage.input_tokens_details.cached_tokens',
        'payload.usage.prompt_tokens_details.cached_tokens',
        'payload.tokenUsage.cachedTokens',
        'payload.total_token_usage.cached_tokens',
    ];
    const cacheReadPaths = [
        'cacheReadInputTokens',
        'cache_read_input_tokens',
        'inputTokenDetails.cacheReadInputTokens',
        'input_tokens_details.cache_read_input_tokens',
        'prompt_tokens_details.cache_read_input_tokens',
        'usage.cache_read_input_tokens',
        'usage.input_tokens_details.cache_read_input_tokens',
        'usage.prompt_tokens_details.cache_read_input_tokens',
        'usageMetadata.cacheReadInputTokens',
        'usage_metadata.cache_read_input_tokens',
        'tokenUsage.cacheReadInputTokens',
        'token_usage.cache_read_input_tokens',
        'total_token_usage.cache_read_input_tokens',
        'payload.usage.cache_read_input_tokens',
        'payload.usage.input_tokens_details.cache_read_input_tokens',
        'payload.usage.prompt_tokens_details.cache_read_input_tokens',
        'payload.tokenUsage.cacheReadInputTokens',
        'payload.total_token_usage.cache_read_input_tokens',
    ];
    const cacheCreationPaths = [
        'cacheCreationInputTokens',
        'cache_creation_input_tokens',
        'inputTokenDetails.cacheCreationInputTokens',
        'input_tokens_details.cache_creation_input_tokens',
        'prompt_tokens_details.cache_creation_input_tokens',
        'usage.cache_creation_input_tokens',
        'usage.input_tokens_details.cache_creation_input_tokens',
        'usage.prompt_tokens_details.cache_creation_input_tokens',
        'usageMetadata.cacheCreationInputTokens',
        'usage_metadata.cache_creation_input_tokens',
        'tokenUsage.cacheCreationInputTokens',
        'token_usage.cache_creation_input_tokens',
        'total_token_usage.cache_creation_input_tokens',
        'payload.usage.cache_creation_input_tokens',
        'payload.usage.input_tokens_details.cache_creation_input_tokens',
        'payload.usage.prompt_tokens_details.cache_creation_input_tokens',
        'payload.tokenUsage.cacheCreationInputTokens',
        'payload.total_token_usage.cache_creation_input_tokens',
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
        'payload.usage.modelCalls',
        'payload.usage.model_calls',
        'payload.tokenUsage.modelCalls',
        'payload.token_usage.model_calls',
        'payload.total_token_usage.model_calls',
        'payload.totalTokenUsage.modelCalls',
    ];
    const sourcePaths = [
        'source',
        'usage_source',
        'usageSource',
        'usage.source',
        'usage.usage_source',
        'usage.usageSource',
        'usageMetadata.source',
        'tokenUsage.source',
        'token_usage.source',
        'total_token_usage.source',
        'payload.usage.source',
        'payload.usage.usage_source',
        'payload.usage.usageSource',
        'payload.tokenUsage.source',
        'payload.token_usage.source',
        'payload.total_token_usage.source',
        'body.usage.source',
        'response.usage.source',
        'result.usage.source',
        'data.usage.source',
    ];

    const promptTokens = firstFiniteValue(usage, promptPaths);
    const completionTokens = firstFiniteValue(usage, completionPaths);
    const totalTokens = firstFiniteValue(usage, totalPaths);
    const reasoningTokens = firstFiniteValue(usage, reasoningPaths);
    const explicitCachedTokens = firstFiniteValue(usage, cachedPaths);
    const cacheReadTokens = firstFiniteValue(usage, cacheReadPaths);
    const cacheCreationTokens = firstFiniteValue(usage, cacheCreationPaths);
    const splitCachedTokens = sumFiniteValues(usage, [
        ...cacheReadPaths,
        ...cacheCreationPaths,
    ]);
    const cachedTokens = explicitCachedTokens !== null ? explicitCachedTokens : splitCachedTokens;
    const modelCalls = firstFiniteValue(usage, modelCallPaths);

    const hasExplicitUsage = [
        hasUsagePath(usage, promptPaths),
        hasUsagePath(usage, completionPaths),
        hasUsagePath(usage, totalPaths),
        hasUsagePath(usage, reasoningPaths),
        hasUsagePath(usage, cachedPaths),
        hasUsagePath(usage, cacheReadPaths),
        hasUsagePath(usage, cacheCreationPaths),
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
    if (cacheReadTokens !== null) {
        normalized.cacheReadInputTokens = cacheReadTokens;
    }
    if (cacheCreationTokens !== null) {
        normalized.cacheCreationInputTokens = cacheCreationTokens;
    }
    if (modelCalls !== null) {
        normalized.modelCalls = modelCalls;
    }
    if (usage.estimated === true) {
        normalized.estimated = true;
    }
    const source = firstStringValue(usage, sourcePaths);
    if (source) {
        normalized.source = source;
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
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        modelCalls: 0,
    };
    let hasUsage = false;
    let hasPrompt = false;
    let hasCompletion = false;
    let hasTotal = false;
    let hasReasoning = false;
    let hasCached = false;
    let hasCacheRead = false;
    let hasCacheCreation = false;
    let hasModelCalls = false;
    let hasEstimated = false;
    const sources = new Set();

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
        if (Object.prototype.hasOwnProperty.call(normalized, 'cacheReadInputTokens')) {
            totals.cacheReadInputTokens += normalized.cacheReadInputTokens;
            hasCacheRead = true;
        }
        if (Object.prototype.hasOwnProperty.call(normalized, 'cacheCreationInputTokens')) {
            totals.cacheCreationInputTokens += normalized.cacheCreationInputTokens;
            hasCacheCreation = true;
        }
        if (Object.prototype.hasOwnProperty.call(normalized, 'modelCalls')) {
            totals.modelCalls += normalized.modelCalls;
            hasModelCalls = true;
        }
        if (normalized.estimated === true) {
            hasEstimated = true;
        }
        if (typeof normalized.source === 'string' && normalized.source.trim()) {
            sources.add(normalized.source.trim());
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
    if (hasCacheRead) {
        normalizedTotals.cacheReadInputTokens = totals.cacheReadInputTokens;
    }
    if (hasCacheCreation) {
        normalizedTotals.cacheCreationInputTokens = totals.cacheCreationInputTokens;
    }
    if (hasModelCalls) {
        normalizedTotals.modelCalls = totals.modelCalls;
    }
    if (hasEstimated) {
        normalizedTotals.estimated = true;
    }
    if (sources.size > 0) {
        normalizedTotals.source = Array.from(sources).join('+');
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

function hasMeasuredTokenCounts(usage = {}) {
    const normalized = normalizeUsageMetadata(usage);
    if (!normalized) {
        return false;
    }

    return [
        normalized.promptTokens,
        normalized.completionTokens,
        normalized.totalTokens,
        normalized.inputTokens,
        normalized.outputTokens,
    ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
}

function estimateTokensFromText(value = '') {
    const text = String(value || '').trim();
    if (!text) {
        return 0;
    }

    const words = text.split(/\s+/).filter(Boolean).length;
    const chars = text.length;
    return Math.max(1, Math.ceil(Math.max(chars / 4, words * 1.33)));
}

function createEstimatedUsageMetadata({
    input = '',
    output = '',
    modelCalls = 1,
} = {}) {
    const promptTokens = estimateTokensFromText(input);
    const completionTokens = estimateTokensFromText(output);
    if (promptTokens <= 0 && completionTokens <= 0) {
        return null;
    }

    return {
        promptTokens,
        inputTokens: promptTokens,
        completionTokens,
        outputTokens: completionTokens,
        totalTokens: promptTokens + completionTokens,
        modelCalls,
        estimated: true,
        source: 'local-estimate',
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
    createEstimatedUsageMetadata,
    extractResponseUsageMetadata,
    extractUsageMetadataFromTrace,
    hasMeasuredTokenCounts,
    mergeUsageMetadata,
    normalizeUsageMetadata,
};
