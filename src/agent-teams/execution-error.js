'use strict';

// Never persist provider messages, bodies, URLs, headers or arbitrary codes.
function executionError(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null;
  const category = status === 401 || status === 403 ? 'provider_authentication'
    : status === 404 ? 'provider_endpoint_or_model'
      : status === 429 ? 'provider_rate_limit'
        : status ? 'provider_http_error'
          : error?.name === 'APIConnectionTimeoutError' ? 'provider_timeout'
            : error?.name === 'APIConnectionError' ? 'provider_connection'
              : error?.name === 'AbortError' ? 'execution_aborted' : 'execution_error';
  return { category, ...(status ? { status } : {}) };
}
module.exports = { executionError };
