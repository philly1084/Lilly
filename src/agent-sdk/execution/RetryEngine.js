const { randomUUID } = require('crypto');

/**
 * Error classification types for retry decisions.
 * @typedef {('timeout'|'rate-limit'|'network'|'transient'|'permanent')} ErrorType
 */

/**
 * Backoff strategy types.
 * @typedef {('immediate'|'linear'|'exponential'|'circuit-breaker')} BackoffStrategy
 */

/**
 * Retry callback context.
 * @typedef {Object} RetryContext
 * @property {number} attempt - Current attempt number (1-indexed)
 * @property {number} maxAttempts - Maximum number of attempts
 * @property {Error} error - The error that occurred
 * @property {number} delay - Delay before next retry in ms
 * @property {Object} context - Additional context passed to execute
 */

/**
 * Retry execution result.
 * @typedef {Object} RetryResult
 * @property {boolean} success - Whether the operation succeeded
 * @property {*} [result] - The operation result if successful
 * @property {Error} [error] - The last error if failed
 * @property {number} attempts - Number of attempts made
 * @property {string} policy - ID of the policy used
 */

/**
 * Defines retry policy with configurable backoff and error classification.
 * @class RetryPolicy
 */
class RetryPolicy {
  /**
   * Creates a RetryPolicy instance.
   * @param {Object} [options={}] - Policy configuration
   * @param {number} [options.maxAttempts=3] - Maximum number of retry attempts
   * @param {BackoffStrategy} [options.backoff='exponential'] - Backoff strategy
   * @param {number} [options.baseDelay=1000] - Base delay in milliseconds
   * @param {number} [options.maxDelay=30000] - Maximum delay in milliseconds
   * @param {string[]} [options.retryableErrors=['timeout', 'rate-limit', 'network', 'transient']] - Error types to retry
   * @param {Function} [options.onRetry=null] - Callback called before each retry
   */
  constructor({
    maxAttempts = 3,
    backoff = 'exponential',
    baseDelay = 1000,
    maxDelay = 30000,
    retryableErrors = ['timeout', 'rate-limit', 'network', 'transient'],
    onRetry = null
  }) {
    /** @type {string} Unique policy identifier */
    this.id = randomUUID();
    
    /** @type {number} Maximum number of retry attempts */
    this.maxAttempts = maxAttempts;
    
    /** @type {BackoffStrategy} Backoff strategy for delays */
    this.backoff = backoff;
    
    /** @type {number} Base delay in milliseconds */
    this.baseDelay = baseDelay;
    
    /** @type {number} Maximum delay in milliseconds */
    this.maxDelay = maxDelay;
    
    /** @type {string[]} Error types that should trigger a retry */
    this.retryableErrors = retryableErrors;
    
    /** @type {Function|null} Callback for retry events */
    this.onRetry = onRetry;
  }
  
  /**
   * Calculates the delay for a given attempt based on backoff strategy.
   * @param {number} attempt - The attempt number (1-indexed)
   * @returns {number} Delay in milliseconds
   */
  calculateDelay(attempt) {
    switch (this.backoff) {
      case 'immediate':
        return 0;
      
      case 'linear':
        return Math.min(this.baseDelay * attempt, this.maxDelay);
      
      case 'exponential':
        // Exponential: baseDelay * 2^(attempt-1)
        return Math.min(this.baseDelay * Math.pow(2, attempt - 1), this.maxDelay);
      
      case 'circuit-breaker':
        // Circuit breaker: normal delay until threshold, then max delay
        return attempt >= 3 ? this.maxDelay : this.baseDelay;
      
      default:
        return this.baseDelay;
    }
  }
  
  /**
   * Determines if an error is retryable based on policy configuration.
   * @param {Error} error - The error to classify
   * @returns {boolean} Whether the error is retryable
   */
  isRetryable(error) {
    const errorType = this.classifyError(error);
    return this.retryableErrors.includes(errorType);
  }
  
  /**
   * Classifies an error into a known error type.
   * @param {Error} error - The error to classify
   * @returns {ErrorType} The classified error type
   */
  classifyError(error) {
    const code = String(error?.code || '').toLowerCase();
    const status = Number(error?.status || error?.statusCode || 0);
    const message = String(error?.message || '').toLowerCase();

    // Explicit client failures take precedence over words in error messages.
    if (status >= 400 && status < 500 && status !== 429) {
      return 'permanent';
    }

    // Check for timeout errors
    if (code === 'timeout' ||
        message.includes('timeout') ||
        error?.name === 'TimeoutError') {
      return 'timeout';
    }
    
    // Check for rate limiting
    if (['rate_limit', 'rate_limit_exceeded', 'too_many_requests'].includes(code) ||
        status === 429 ||
        message.includes('rate limit') ||
        message.includes('too many requests')) {
      return 'rate-limit';
    }
    
    // Check for network errors
    if (code === 'network_error' ||
        message.includes('network') ||
        message.includes('econnrefused') ||
        message.includes('enotfound')) {
      return 'network';
    }
    
    // Check for transient/connection errors
    if (code === 'econnreset' ||
        code === 'etimedout' ||
        code === 'econnaborted' ||
        code === 'epipe') {
      return 'transient';
    }
    
    // Server errors (5xx) are typically transient
    if (status >= 500 && status < 600) {
      return 'transient';
    }
    
    // Default to transient for unknown errors
    return 'transient';
  }
  
  /**
   * Executes an operation with retry logic.
   * @param {Function} operation - Async function to execute
   * @param {Object} [context={}] - Context passed to the operation and retry callback
   * @returns {Promise<RetryResult>} Result of the operation with retry metadata
   */
  async execute(operation, context = {}) {
    let lastError;
    let attempts = 0;
    
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      attempts = attempt;
      try {
        const result = await operation(context);
        return {
          success: true,
          result,
          attempts: attempt,
          policy: this.id
        };
      } catch (error) {
        lastError = error;
        
        // Check if we should retry
        if (!this.isRetryable(error) || attempt === this.maxAttempts) {
          break;
        }
        
        // Calculate delay
        const delay = this.calculateDelay(attempt);
        
        // Notify listener
        if (this.onRetry) {
          try {
            await this.onRetry({
              attempt,
              maxAttempts: this.maxAttempts,
              error,
              delay,
              context
            });
          } catch (callbackError) {
            // Don't let callback errors break retry logic
            console.error('Retry callback error:', callbackError);
          }
        }
        
        // Wait before retry
        await this.sleep(delay);
      }
    }
    
    return {
      success: false,
      error: lastError,
      attempts,
      policy: this.id
    };
  }
  
  /**
   * Utility method for async sleep.
   * @private
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Creates a new policy with merged options.
   * @param {Object} overrides - Options to override
   * @returns {RetryPolicy} New policy instance
   */
  clone(overrides = {}) {
    return new RetryPolicy({
      maxAttempts: overrides.maxAttempts ?? this.maxAttempts,
      backoff: overrides.backoff ?? this.backoff,
      baseDelay: overrides.baseDelay ?? this.baseDelay,
      maxDelay: overrides.maxDelay ?? this.maxDelay,
      retryableErrors: overrides.retryableErrors ?? [...this.retryableErrors],
      onRetry: overrides.onRetry ?? this.onRetry
    });
  }
  
  /**
   * Converts policy to JSON representation.
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      id: this.id,
      maxAttempts: this.maxAttempts,
      backoff: this.backoff,
      baseDelay: this.baseDelay,
      maxDelay: this.maxDelay,
      retryableErrors: this.retryableErrors
    };
  }
}

/**
 * Manages multiple retry policies and executes operations with retry logic.
 * @class RetryEngine
 */
class RetryEngine {
  /**
   * Creates a RetryEngine instance.
   */
  constructor() {
    /** @type {Map<string, RetryPolicy>} Registered policies */
    this.policies = new Map();
    
    /** @type {RetryPolicy} Default policy when none specified */
    this.defaultPolicy = new RetryPolicy({});
  }
  
  /**
   * Registers a retry policy for later use.
   * @param {RetryPolicy} policy - The policy to register
   * @returns {string} The policy ID
   */
  registerPolicy(policy) {
    this.policies.set(policy.id, policy);
    return policy.id;
  }
  
  /**
   * Creates and registers a new policy from options.
   * @param {Object} options - Policy options
   * @returns {string} The new policy ID
   */
  createPolicy(options) {
    const policy = new RetryPolicy(options);
    return this.registerPolicy(policy);
  }
  
  /**
   * Gets a registered policy by ID.
   * @param {string} id - Policy ID
   * @returns {RetryPolicy} The policy or default if not found
   */
  getPolicy(id) {
    return this.policies.get(id) || this.defaultPolicy;
  }
  
  /**
   * Checks if a policy is registered.
   * @param {string} id - Policy ID
   * @returns {boolean} Whether the policy exists
   */
  hasPolicy(id) {
    return this.policies.has(id);
  }
  
  /**
   * Removes a registered policy.
   * @param {string} id - Policy ID
   * @returns {boolean} Whether a policy was removed
   */
  removePolicy(id) {
    return this.policies.delete(id);
  }
  
  /**
   * Clears all registered policies.
   */
  clearPolicies() {
    this.policies.clear();
  }
  
  /**
   * Executes an operation with retry using a policy.
   * @param {Function} operation - Async function to execute
   * @param {string|RetryPolicy|null} policyOrId - Policy ID, policy instance, or null for default
   * @param {Object} [context={}] - Context for the operation
   * @returns {Promise<RetryResult>} Result with retry metadata
   */
  async executeWithRetry(operation, policyOrId, context = {}) {
    const policy = this.resolvePolicy(policyOrId);
    return policy.execute(operation, context);
  }
  
  /**
   * Resolves a policy from ID, instance, or returns default.
   * @private
   * @param {string|RetryPolicy|null} policyOrId - Policy identifier
   * @returns {RetryPolicy} Resolved policy
   */
  resolvePolicy(policyOrId) {
    if (policyOrId instanceof RetryPolicy) {
      return policyOrId;
    }
    if (typeof policyOrId === 'string') {
      return this.getPolicy(policyOrId);
    }
    return this.defaultPolicy;
  }
  
  /**
   * Executes an operation immediately without retry.
   * @param {Function} operation - Async function to execute
   * @param {Object} [context={}] - Context for the operation
   * @returns {Promise<RetryResult>} Result
   */
  async executeOnce(operation, context = {}) {
    const oncePolicy = new RetryPolicy({ maxAttempts: 1 });
    return oncePolicy.execute(operation, context);
  }
  
  /**
   * Gets statistics about registered policies.
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      registeredPolicies: this.policies.size,
      policyIds: Array.from(this.policies.keys())
    };
  }
  
  /**
   * Creates a pre-configured aggressive retry policy.
   * @returns {RetryPolicy} Aggressive retry policy
   */
  static aggressive() {
    return new RetryPolicy({
      maxAttempts: 5,
      backoff: 'exponential',
      baseDelay: 500,
      maxDelay: 30000
    });
  }
  
  /**
   * Creates a pre-configured gentle retry policy.
   * @returns {RetryPolicy} Gentle retry policy
   */
  static gentle() {
    return new RetryPolicy({
      maxAttempts: 2,
      backoff: 'linear',
      baseDelay: 2000,
      maxDelay: 10000
    });
  }
  
  /**
   * Creates a pre-configured circuit breaker policy.
   * @returns {RetryPolicy} Circuit breaker policy
   */
  static circuitBreaker() {
    return new RetryPolicy({
      maxAttempts: 5,
      backoff: 'circuit-breaker',
      baseDelay: 1000,
      maxDelay: 60000
    });
  }
}

module.exports = { RetryPolicy, RetryEngine };
