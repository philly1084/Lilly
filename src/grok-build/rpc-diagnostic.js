'use strict';

// Never retain upstream message/data: either may contain prompts, URLs or keys.
// Categories are hints for investigation, not proof of an underlying cause.
function rpcDiagnostic(error, method) {
  const methods = new Set(['initialize', 'authenticate', 'session/new', 'session/load', 'session/prompt']);
  let text = typeof error?.message === 'string' ? error.message.slice(0, 8192) : '';
  if (typeof error?.data === 'string') text += error.data.slice(0, 8192);
  else if (typeof error?.data?.message === 'string') text += error.data.message.slice(0, 8192);
  const hints = [];
  for (const [name, pattern] of [
    ['schema', /deserializ|missing field|invalid type|unknown variant/i],
    ['stream', /stream|server.sent.event|SSE/],
    ['timeout', /timed? ?out|deadline/i],
    ['authentication', /unauthorized|authentication|invalid.api.key/i],
    ['rate_limit', /rate.limit|too many requests/i],
    ['connection', /connection|connect error|broken pipe/i],
    ['tool', /tool.call|function.call|tool.name/i],
  ]) if (pattern.test(text)) hints.push(name);
  const missingFields = ['sequence_number', 'item_id', 'output_index', 'content_index', 'response', 'status', 'id', 'type',
    'annotations', 'summary', 'created_at', 'role', 'name', 'arguments', 'call_id', 'content',
    'input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details', 'output_tokens_details', 'cached_tokens', 'reasoning_tokens']
    .filter(field => text.includes(`missing field \`${field}\``));
  return { method: methods.has(method) ? method : 'unknown',
    rpcCode: [-32700, -32600, -32601, -32602, -32603, -32000].includes(error?.code) ? error.code : null,
    hints, missingFields };
}
module.exports = { rpcDiagnostic };
