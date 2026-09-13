'use strict';
const fail = () => Object.assign(new Error('Unsupported Responses stream envelope'), { code: 'grok_response_stream_invalid' });

// Grok's pinned async-openai parser requires both usage breakdowns whenever
// usage is present. Compatible gateways may only report totals. Usage is
// optional, so omit incomplete statistics rather than fabricate zero counts.
function compatibleUsage(usage) {
  const counts = [usage?.input_tokens, usage?.output_tokens, usage?.total_tokens,
    usage?.input_tokens_details?.cached_tokens, usage?.output_tokens_details?.reasoning_tokens];
  return counts.every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff) ? usage : null;
}

// Some compatible gateways return one completed response.chunk rather than
// typed Responses events. Reframe actual output only; never infer a tool call,
// invent text, repair arguments, or turn an incomplete response into success.
async function* normalizeResponseStream(upstream) {
  let seen = false; let legacy = false; let pending = null;
  let bytes = 0;
  for await (let event of upstream) {
    bytes += Buffer.byteLength(JSON.stringify(event) || '');
    if (bytes > 16 * 1024 * 1024) throw fail();
    if (legacy) throw fail();
    if (typeof event?.type === 'string') {
      seen = true;
      if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw fail();
      if (pending) throw fail();
      if (event.type === 'response.completed') {
        if (!event.response || event.response.status !== 'completed' || !Array.isArray(event.response.output)) throw fail();
        pending = { ...event.response, object: 'response.chunk' };
      }
      // The gateway's native stream also omits lifecycle fields required by
      // Grok. Reframe its authoritative completed output, not partial deltas.
      continue;
    }
    if (seen || event?.object !== 'response.chunk' || event.status !== 'completed'
      || typeof event.id !== 'string' || !event.id || typeof event.model !== 'string'
      || !Number.isFinite(event.created_at) || !Array.isArray(event.output)) throw fail();
    legacy = true;
    pending = event;
  }
  if (!pending) throw fail();
  // The legacy envelope claims to be the whole response. Confirm clean EOF
  // before releasing any tool call or completion: a duplicate/trailing error
  // must not arrive after consumers have already acted on fabricated success.
  if (pending) {
    let event = pending;
    if (typeof event.id !== 'string' || !event.id || typeof event.model !== 'string'
      || !Number.isFinite(event.created_at)) throw fail();
    for (const item of event.output) {
      if (typeof item?.id !== 'string' || !item.id || !['message', 'function_call', 'reasoning'].includes(item.type)) throw fail();
      if (item.type === 'function_call' && (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string')) throw fail();
      if (item.type === 'message' && (!Array.isArray(item.content) || item.content.some(part => part?.type !== 'output_text' || typeof part.text !== 'string'))) throw fail();
    }
    event = { ...event, output: event.output.map(item => item.type === 'message'
      ? { ...item, content: item.content.map(part => ({ annotations: [], ...part })) }
      : item.type === 'reasoning' ? { summary: [], ...item } : item) };
    let sequence = 0;
    const envelope = { ...event, object: 'response', usage: compatibleUsage(event.usage) };
    const emit = (type, fields) => ({ type, sequence_number: sequence++, ...fields });
    yield emit('response.created', { response: { ...envelope, status: 'in_progress', output: [] } });
    for (const [output_index, item] of event.output.entries()) {
      yield emit('response.output_item.added', { output_index, item: { ...item, status: 'in_progress',
        ...(item.type === 'function_call' ? { arguments: '' } : item.type === 'message' ? { content: [] } : {}) } });
      if (item.type === 'function_call') {
        yield emit('response.function_call_arguments.delta', { item_id: item.id, output_index, delta: item.arguments });
        yield emit('response.function_call_arguments.done', { item_id: item.id, output_index, arguments: item.arguments });
      } else if (item.type === 'message') {
        for (const [content_index, part] of item.content.entries()) {
          const location = { item_id: item.id, output_index, content_index };
          yield emit('response.content_part.added', { ...location, part: { ...part, text: '' } });
          yield emit('response.output_text.delta', { ...location, delta: part.text });
          yield emit('response.output_text.done', { ...location, text: part.text });
          yield emit('response.content_part.done', { ...location, part });
        }
      }
      yield emit('response.output_item.done', { output_index, item });
    }
    yield emit('response.completed', { response: envelope });
  }
}
module.exports = { normalizeResponseStream };
