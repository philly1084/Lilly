const { RetryPolicy } = require('./RetryEngine');

describe('RetryPolicy', () => {
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
