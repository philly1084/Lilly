'use strict';
const { executionError } = require('./execution-error');
test.each([[401, 'provider_authentication'], [403, 'provider_authentication'], [404, 'provider_endpoint_or_model'],
  [429, 'provider_rate_limit'], [500, 'provider_http_error']])('records safe HTTP category for %s', (status, category) => {
  expect(executionError({ status, message: 'Bearer secret', code: 'private-url', headers: { authorization: 'secret' } })).toEqual({ status, category });
});
test('unknown errors expose no raw provider data', () => {
  expect(executionError({ status: '401', name: 'secret', message: 'secret' })).toEqual({ category: 'execution_error' });
  expect(executionError(null)).toEqual({ category: 'execution_error' });
});
