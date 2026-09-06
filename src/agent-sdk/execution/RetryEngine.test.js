const { RetryPolicy } = require('./RetryEngine');

describe('RetryPolicy', () => {
  test.each([
    { status: 400, message: 'Invalid timeout parameter' },
    { status: 401, message: 'Network credentials are invalid' },
    { status: 403, message: 'Rate limit configuration access denied' },
    { statusCode: 404, message: 'Network resource not found' },
    { status: 422, message: 'Too many requests in the supplied batch' },
  ])('stops permanent client errors without keyword-triggered retries: %j', async (details) => {
    const onRetry = jest.fn();
    const policy = new RetryPolicy({ maxAttempts: 3, onRetry });
    const sleep = jest.spyOn(policy, 'sleep').mockResolvedValue();
    const error = Object.assign(new Error(details.message), details);
    const operation = jest.fn().mockRejectedValue(error);

    await expect(policy.execute(operation)).resolves.toMatchObject({
      success: false,
      error,
      attempts: 1,
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  test('reports actual attempts when a transient failure becomes permanent', async () => {
    const policy = new RetryPolicy({ maxAttempts: 4, backoff: 'immediate' });
    jest.spyOn(policy, 'sleep').mockResolvedValue();
    const error = Object.assign(new Error('Unauthorized'), { status: 401 });
    const operation = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { status: 503 }))
      .mockRejectedValue(error);

    await expect(policy.execute(operation)).resolves.toMatchObject({ success: false, error, attempts: 2 });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test.each([429, 503])('still retries HTTP %i through exhaustion', async (status) => {
    const policy = new RetryPolicy({ maxAttempts: 3, backoff: 'immediate' });
    const sleep = jest.spyOn(policy, 'sleep').mockResolvedValue();
    const error = Object.assign(new Error('Provider unavailable'), { status });
    const operation = jest.fn().mockRejectedValue(error);

    await expect(policy.execute(operation)).resolves.toMatchObject({ success: false, error, attempts: 3 });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test('classifies gateway rate-limit codes as retryable rate limits', () => {
    const policy = new RetryPolicy({ maxAttempts: 2, backoff: 'immediate' });

    expect(policy.classifyError(Object.assign(new Error('provider throttled'), {
      code: 'rate_limit_exceeded',
    }))).toBe('rate-limit');
    expect(policy.classifyError(Object.assign(new Error('provider throttled'), {
      code: 'too_many_requests',
    }))).toBe('rate-limit');
    expect(policy.isRetryable(Object.assign(new Error('provider throttled'), {
      code: 'RATE_LIMIT_EXCEEDED',
    }))).toBe(true);
  });

  test('retries coded provider rate limits but keeps ordinary client errors permanent', async () => {
    const onRetry = jest.fn();
    const policy = new RetryPolicy({
      maxAttempts: 2,
      backoff: 'immediate',
      onRetry,
    });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('provider throttled'), {
        code: 'too_many_requests',
      }))
      .mockResolvedValueOnce('ok');

    await expect(policy.execute(operation)).resolves.toEqual(expect.objectContaining({
      success: true,
      result: 'ok',
      attempts: 2,
    }));
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      delay: 0,
      error: expect.objectContaining({ code: 'too_many_requests' }),
    }));

    expect(policy.classifyError(Object.assign(new Error('bad request'), {
      status: 400,
    }))).toBe('permanent');
  });
});
