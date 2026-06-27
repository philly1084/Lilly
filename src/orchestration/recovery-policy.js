function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function classifyFailureText(text = '') {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return 'unknown_failure';
  if (/missing required|requires? (a |an )?|must include|missing .*params?|invalid tool call|schema|validation|unknown params?|invalid_enum/.test(normalized)) {
    return 'bad_schema_or_missing_params';
  }
  if (/tool not found|disabled|unavailable|no executable handler|not registered/.test(normalized)) {
    return 'unavailable_tool';
  }
  if (/model .*does not support|unsupported.*tool|tool_choice|function calling|responses api|not supported/.test(normalized)) {
    return 'model_lacks_capability';
  }
  if (/permission denied|authentication|unauthorized|forbidden|missing.*token|missing.*secret|api key|publickey/.test(normalized)) {
    return 'auth_or_secret';
  }
  if (/timeout|timed out|econnreset|etimedout|socket hang up|dns|could not resolve|network|connection refused|502|503|504|429|rate limit/.test(normalized)) {
    return 'network_or_transient';
  }
  if (/empty|no content|not found|404|missing artifact|missing_token|blank/.test(normalized)) {
    return 'empty_or_missing_artifact';
  }
  if (/low confidence|unverified|insufficient evidence|no verified source/.test(normalized)) {
    return 'low_confidence_source';
  }
  return 'tool_failure';
}

function buildRecoveryPolicy({ toolId = '', failureKind = 'tool_failure' } = {}) {
  const id = normalizeText(toolId);
  const policies = {
    bad_schema_or_missing_params: {
      retryable: true,
      maxAttempts: 2,
      nextAction: 'replan_with_validated_params',
      hint: 'Fill required params from context or choose a tool whose schema matches the available input.',
    },
    unavailable_tool: {
      retryable: true,
      maxAttempts: 1,
      nextAction: 'choose_alternate_ready_tool',
      hint: 'Remove unavailable or degraded tools from the candidate set before replanning.',
    },
    model_lacks_capability: {
      retryable: true,
      maxAttempts: 1,
      nextAction: 'route_to_capable_model_or_internal_tool_loop',
      hint: 'Prefer a model with tools/responses support, or keep tool execution internal and synthesize separately.',
    },
    auth_or_secret: {
      retryable: false,
      maxAttempts: 0,
      nextAction: 'request_missing_credential_or_use_readonly_path',
      hint: 'Do not retry secret-gated operations without new credentials or a read-only fallback.',
    },
    network_or_transient: {
      retryable: true,
      maxAttempts: 2,
      nextAction: 'retry_once_then_alternate_source',
      hint: 'Retry with a smaller timeout-safe request, then switch source or tool.',
    },
    empty_or_missing_artifact: {
      retryable: true,
      maxAttempts: 2,
      nextAction: 'recover_source_then_retry',
      hint: 'Search/read the source artifact or generate the missing preview before consuming it.',
    },
    low_confidence_source: {
      retryable: true,
      maxAttempts: 2,
      nextAction: 'gather_verified_source',
      hint: 'Use search/fetch/scrape evidence before synthesis.',
    },
  };

  return {
    toolId: id || null,
    failureKind,
    ...(policies[failureKind] || {
      retryable: true,
      maxAttempts: 1,
      nextAction: 'replan_with_smaller_candidate_set',
      hint: 'Avoid repeating the same failed signature without changed inputs.',
    }),
  };
}

function classifyToolEventFailure(event = {}) {
  const toolId = normalizeText(
    event?.toolCall?.function?.name
    || event?.tool_call?.function?.name
    || event?.tool_call?.name
    || event?.result?.toolId
    || event?.result?.tool_id
    || '',
  );
  const errorText = [
    event?.result?.error,
    event?.result?.errorCode,
    event?.result?.diagnostics ? JSON.stringify(event.result.diagnostics) : '',
  ].filter(Boolean).join('\n');
  const failureKind = classifyFailureText(errorText);
  return buildRecoveryPolicy({ toolId, failureKind });
}

module.exports = {
  buildRecoveryPolicy,
  classifyFailureText,
  classifyToolEventFailure,
};
