'use strict';
const { rpcDiagnostic } = require('./rpc-diagnostic');
test('keeps only fixed categories and standard codes, not upstream content', () => {
  const diagnostic = rpcDiagnostic({ code: -32603, message: 'stream deserialize: missing field `sequence_number` sk-secret https://private/',
    data: { message: 'connection error PROMPT CONTENT' } }, 'session/prompt');
  expect(diagnostic).toEqual({ method: 'session/prompt', rpcCode: -32603,
    hints: ['schema', 'stream', 'connection'], missingFields: ['sequence_number'] });
  expect(JSON.stringify(diagnostic)).not.toMatch(/secret|private|PROMPT/);
});
test('untrusted method, code and nested error data cannot become diagnostic output', () => {
  expect(rpcDiagnostic({ code: 123456789, message: 'secret', data: { token: 'secret' } }, 'secret'))
    .toEqual({ method: 'unknown', rpcCode: null, hints: [], missingFields: [] });
  expect(rpcDiagnostic(null)).toEqual({ method: 'unknown', rpcCode: null, hints: [], missingFields: [] });
});

test('identifies missing usage schema fields without retaining provider content', () => {
  const diagnostic = rpcDiagnostic({ code: -32603,
    message: 'deserialize missing field `input_tokens_details`; prompt SECRET; missing field `private_field`' }, 'session/prompt');
  expect(diagnostic.missingFields).toEqual(['input_tokens_details']);
  expect(JSON.stringify(diagnostic)).not.toMatch(/SECRET|private_field/);
});
