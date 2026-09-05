let Ajv;
const { verifiedAttestations } = require('../../orchestration/completion-evidence');

try {
  Ajv = require('ajv');
} catch (error) {
  console.warn('[AgentSDK] AJV not available, schema validation will degrade:', error.message);
  Ajv = class FallbackAjv {
    compile() {
      const validate = () => { throw new Error('Schema validator unavailable'); };
      validate.errors = [];
      return validate;
    }
  };
}

/**
 * Result of a single validation criterion.
 * @class ValidationResult
 */
class ValidationResult {
  /**
   * Creates a ValidationResult instance.
   * @param {Object} options - Result configuration
   * @param {boolean} options.valid - Whether the validation passed
   * @param {string} options.criterion - Name of the validation criterion
   * @param {string} options.message - Human-readable result message
   * @param {Object} [options.details={}] - Additional validation details
   */
  constructor({ valid, criterion, message, details = {} }) {
    /** @type {boolean} Whether validation passed */
    this.valid = valid;
    
    /** @type {string} Criterion name */
    this.criterion = criterion;
    
    /** @type {string} Result message */
    this.message = message;
    
    /** @type {Object} Additional details */
    this.details = details;
    
    /** @type {string} ISO timestamp */
    this.timestamp = new Date().toISOString();
  }
  
  /**
   * Creates a successful validation result.
   * @param {string} criterion - Criterion name
   * @param {string} message - Success message
   * @param {Object} [details={}] - Additional details
   * @returns {ValidationResult} Success result
   */
  static success(criterion, message, details = {}) {
    return new ValidationResult({
      valid: true,
      criterion,
      message,
      details
    });
  }
  
  /**
   * Creates a failed validation result.
   * @param {string} criterion - Criterion name
   * @param {string} message - Failure message
   * @param {Object} [details={}] - Additional details
   * @returns {ValidationResult} Failure result
   */
  static failure(criterion, message, details = {}) {
    return new ValidationResult({
      valid: false,
      criterion,
      message,
      details
    });
  }
  
  /**
   * Converts to JSON representation.
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      valid: this.valid,
      criterion: this.criterion,
      message: this.message,
      details: this.details,
      timestamp: this.timestamp
    };
  }
}

/**
 * Overall verification result combining multiple criteria.
 * @typedef {Object} VerificationResult
 * @property {boolean} valid - Whether all criteria passed
 * @property {number} passed - Number of criteria that passed
 * @property {number} total - Total number of criteria checked
 * @property {ValidationResult[]} results - Individual criterion results
 * @property {string} timestamp - ISO timestamp of verification
 */

/**
 * Validates task outputs against configurable criteria.
 * Supports custom validators, schema validation, and extensible validation rules.
 * @class Verifier
 */
class Verifier {
  /**
   * Creates a Verifier instance with default validators.
   */
  constructor({ testRunner = null, embedder = null } = {}) {
    this.testRunner = testRunner;
    this.embedder = embedder;
    /** @type {Map<string, Function>} Registered validators */
    this.validators = new Map();
    
    /** @type {Ajv} JSON schema validator instance */
    this.ajv = new Ajv({ allErrors: true, strict: false });
    
    this.registerDefaultValidators();
  }
  
  /**
   * Registers the built-in default validators.
   * @private
   */
  registerDefaultValidators() {
    this.register('output-validated', this.validateOutputSchema.bind(this));
    this.register('tests-pass', this.validateTests.bind(this));
    this.register('no-errors', this.validateNoErrors.bind(this));
    this.register('user-approved', this.validateUserApproval.bind(this));
    this.register('similarity-threshold', this.validateSimilarity.bind(this));
    this.register('custom-function', this.validateCustomFunction.bind(this));
    this.register('output-not-empty', this.validateOutputNotEmpty.bind(this));
    this.register('output-present', this.validateOutputNotEmpty.bind(this));
    this.register('custom-check', this.validateCustomCheck.bind(this));
    this.register('contains-string', this.validateContainsString.bind(this));
    this.register('matches-pattern', this.validateMatchesPattern.bind(this));
  }
  
  /**
   * Registers a custom validator.
   * @param {string} name - Unique name for the validator
   * @param {Function} validatorFn - Async function(task, executionResult) => ValidationResult
   * @returns {Verifier} This verifier for chaining
   * @throws {Error} If name is already registered
   */
  register(name, validatorFn) {
    if (this.validators.has(name)) {
      throw new Error(`Validator '${name}' is already registered`);
    }
    
    if (typeof validatorFn !== 'function') {
      throw new Error(`Validator '${name}' must be a function`);
    }
    
    this.validators.set(name, validatorFn);
    return this;
  }
  
  /**
   * Unregisters a validator.
   * @param {string} name - Name of validator to remove
   * @returns {boolean} Whether a validator was removed
   */
  unregister(name) {
    return this.validators.delete(name);
  }
  
  /**
   * Checks if a validator is registered.
   * @param {string} name - Validator name
   * @returns {boolean} Whether the validator exists
   */
  hasValidator(name) {
    return this.validators.has(name);
  }
  
  /**
   * Gets a registered validator.
   * @param {string} name - Validator name
   * @returns {Function|undefined} The validator function
   */
  getValidator(name) {
    return this.validators.get(name);
  }
  
  /**
   * Lists all registered validator names.
   * @returns {string[]} Array of validator names
   */
  listValidators() {
    return Array.from(this.validators.keys());
  }
  
  /**
   * Verifies a task's execution result against its completion criteria.
   * @param {Object} task - The task with completionCriteria
   * @param {Object} executionResult - The result from task execution
   * @returns {Promise<VerificationResult>} Comprehensive verification result
   */
  async verify(task, executionResult) {
    const criteria = task.completionCriteria || { conditions: [] };
    const results = [];
    
    // Handle single condition shorthand
    const conditions = Array.isArray(criteria.conditions) 
      ? criteria.conditions 
      : [criteria.conditions].filter(Boolean);
    
    for (const criterion of conditions) {
      // Handle criterion as string or object with config
      const criterionName = typeof criterion === 'string' ? criterion : criterion.type;
      const criterionConfig = typeof criterion === 'object' ? criterion : {};
      
      const validator = this.validators.get(criterionName);
      
      if (!validator) {
        results.push(new ValidationResult({
          valid: false,
          criterion: criterionName,
          message: `Unknown criterion: ${criterionName}`
        }));
        continue;
      }
      
      try {
        const result = await validator(task, executionResult, criterionConfig);
        results.push(result);
      } catch (error) {
        results.push(new ValidationResult({
          valid: false,
          criterion: criterionName,
          message: `Validation error: ${error.message}`,
          details: { error: error.stack }
        }));
      }
    }
    
    const passed = results.filter(r => r.valid).length;
    const total = results.length;
    
    // Support anyOf logic (pass if any criterion passes)
    const allPassed = criteria.anyOf 
      ? passed > 0 
      : passed === total && total > 0;
    
    return {
      valid: allPassed,
      passed,
      total,
      results,
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * Validates output against a JSON schema.
   * @param {Object} task - Task with output.schema
   * @param {Object} executionResult - Execution result with output
   * @returns {Promise<ValidationResult>} Validation result
   */
  async validateOutputSchema(task, executionResult) {
    const schema = task.output?.schema;
    if (!schema) {
      return ValidationResult.failure(
        'output-validated',
        'Unverified: no output schema specified',
        { status: 'unverified', nextAction: 'configure_output_schema' }
      );
    }
    
    const output = executionResult.output;
    
    if (output === undefined || output === null) {
      return ValidationResult.failure(
        'output-validated',
        'Output is null or undefined',
        { received: output }
      );
    }
    
    try {
      const validate = this.ajv.compile(schema);
      const valid = validate(output);
      
      if (valid) {
        return ValidationResult.success(
          'output-validated',
          'Output matches schema'
        );
      } else {
        return ValidationResult.failure(
          'output-validated',
          'Output does not match schema',
          { errors: validate.errors }
        );
      }
    } catch (error) {
      return ValidationResult.failure(
        'output-validated',
        `Schema compilation error: ${error.message}`,
        { error: error.message }
      );
    }
  }
  
  /**
   * Validates that tests pass.
   * @param {Object} task - Task configuration
   * @param {Object} executionResult - Execution result
   * @returns {Promise<ValidationResult>} Validation result
   */
  async validateTests(task, executionResult) {
    const tests = task.completionCriteria?.tests || [];
    
    if (tests.length === 0) {
      return ValidationResult.failure(
        'tests-pass',
        'Unverified: configure the tests that establish completion',
        { status: 'unverified', nextAction: 'configure_tests' }
      );
    }
    
    // Run configured tests
    const passed = [];
    const failed = [];
    
    for (const test of tests) {
      try {
        const subject = typeof test === 'string' ? test : test.id || test.test;
        const evidence = [executionResult, ...(executionResult.results || []).map((entry) => entry.output)]
          .flatMap((result) => verifiedAttestations(result || {}));
        if (evidence.some((entry) => entry.kind === 'test' && entry.subject === subject)) {
          passed.push(test);
          continue;
        }
        if (typeof this.testRunner !== 'function') {
          return ValidationResult.failure('tests-pass', 'Unverified: test runner unavailable', {
            status: 'unverified', nextAction: 'provide_test_runner',
          });
        }
        const result = await this.testRunner(test, task, executionResult);
        const data = result?.data || result;
        if (data?.status === 'unverified') {
          return ValidationResult.failure('tests-pass', 'Unverified: test runner unavailable', {
            status: 'unverified', nextAction: 'provide_test_runner',
          });
        }
        if (result?.success === false || data?.exitCode !== 0 || data?.timedOut === true) {
          failed.push({ test, error: 'Test did not return a successful exit code' });
        } else {
          passed.push(test);
        }
      } catch (error) {
        failed.push({ test, error: error.message });
      }
    }
    
    if (failed.length === 0) {
      return ValidationResult.success(
        'tests-pass',
        `All ${passed.length} tests passed`,
        { passed: passed.length }
      );
    } else {
      return ValidationResult.failure(
        'tests-pass',
        `${failed.length} of ${tests.length} tests failed`,
        { passed: passed.length, failed }
      );
    }
  }
  
  /**
   * Validates that no errors occurred during execution.
   * @param {Object} task - Task configuration
   * @param {Object} executionResult - Execution result with trace
   * @returns {Promise<ValidationResult>} Validation result
   */
  async validateNoErrors(task, executionResult) {
    const hasErrors = executionResult.trace?.metrics?.errors > 0 ||
                      executionResult.error !== undefined;
    
    if (hasErrors) {
      const errorCount = executionResult.trace?.metrics?.errors || 1;
      return ValidationResult.failure(
        'no-errors',
        `Execution had ${errorCount} error(s)`,
        { errorCount }
      );
    }
    
    return ValidationResult.success(
      'no-errors',
      'No errors during execution'
    );
  }
  
  /**
   * Validates user approval.
   * @param {Object} task - Task configuration
   * @param {Object} executionResult - Execution result
   * @returns {Promise<ValidationResult>} Validation result
   */
  async validateUserApproval(task, executionResult) {
    // Placeholder - would check if user explicitly approved
    const approved = executionResult.userApproved === true ||
                     task.completionCriteria?.autoApprove === true;
    
    if (approved) {
      return ValidationResult.success(
        'user-approved',
        'User approval confirmed'
      );
    }
    
    return ValidationResult.failure(
      'user-approved',
      'User approval required but not received'
    );
  }
  
  /**
   * Validates semantic similarity threshold.
   * @param {Object} task - Task with similarity config
   * @param {Object} executionResult - Execution result
   * @param {Object} config - Criterion configuration
   * @returns {Promise<ValidationResult>} Validation result
   */
  async validateSimilarity(task, executionResult, config = {}) {
    const threshold = config.threshold ?? 0.8;
    const reference = config.reference || task.expectedOutput;
    
    if (!reference || !this.embedder?.embed || !Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
      return ValidationResult.failure(
        'similarity-threshold',
        'Unverified: a reference, embedder and valid threshold are required',
        { status: 'unverified', nextAction: 'configure_similarity_check' }
      );
    }
    
    const [left, right] = await Promise.all([
      this.embedder.embed(String(reference)),
      this.embedder.embed(typeof executionResult.output === 'string' ? executionResult.output : JSON.stringify(executionResult.output)),
    ]);
    if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length
      || !left.every(Number.isFinite) || !right.every(Number.isFinite)) {
      return ValidationResult.failure('similarity-threshold', 'Invalid embedding vectors');
    }
    const magnitude = Math.hypot(...left) * Math.hypot(...right);
    if (!magnitude) return ValidationResult.failure('similarity-threshold', 'Empty embedding magnitude');
    const similarity = left.reduce((sum, value, index) => sum + value * right[index], 0) / magnitude;
    
    if (similarity >= threshold) {
      return ValidationResult.success(
        'similarity-threshold',
        `Similarity ${similarity.toFixed(2)} meets threshold ${threshold}`,
        { similarity, threshold }
      );
    }
    
    return ValidationResult.failure(
      'similarity-threshold',
      `Similarity ${similarity.toFixed(2)} below threshold ${threshold}`,
      { similarity, threshold }
    );
  }
  
  /**
   * Validates using a custom function.
   * @param {Object} task - Task configuration
   * @param {Object} executionResult - Execution result
   * @param {Object} config - Criterion configuration with fn property
   * @returns {Promise<ValidationResult>} Validation result
   */
  async validateCustomFunction(task, executionResult, config = {}) {
    const fn = config.fn || task.completionCriteria?.customValidator;
    
    if (!fn || typeof fn !== 'function') {
      return ValidationResult.failure(
        'custom-function',
        'No custom validation function provided'
      );
    }
    
    try {
      const result = await fn(task, executionResult);
      
      if (result === true) {
        return ValidationResult.success(
          'custom-function',
          'Custom validation passed'
        );
      }
      
      if (typeof result === 'string') {
        return ValidationResult.failure('custom-function', result);
      }
      
      if (result && typeof result === 'object') {
        return new ValidationResult({
          valid: result.valid !== false,
          criterion: 'custom-function',
          message: result.message || 'Custom validation completed',
          details: result.details || {}
        });
      }
      
      return ValidationResult.failure(
        'custom-function',
        'Custom validation returned false'
      );
    } catch (error) {
      return ValidationResult.failure(
        'custom-function',
        `Custom validation error: ${error.message}`,
        { error: error.stack }
      );
    }
  }

  /**
   * Validates a schema-normalized custom check.
   * @param {Object} task - Task configuration
   * @param {Object} executionResult - Execution result
   * @param {Object} config - Criterion configuration
   * @returns {Promise<ValidationResult>} Validation result
   */
  async validateCustomCheck(task, executionResult, config = {}) {
    const check = String(config.check || '').trim();

    if (check === 'no-errors') {
      return this.validateNoErrors(task, executionResult, config);
    }

    if (check && this.validators.has(check)) {
      return this.validators.get(check)(task, executionResult, config);
    }

    if (config.expected === true) {
      return ValidationResult.success(
        'custom-check',
        check ? `Custom check "${check}" accepted` : 'Custom check accepted'
      );
    }

    return ValidationResult.failure(
      'custom-check',
      check ? `Unknown custom check: ${check}` : 'Custom check name is required'
    );
  }
  
  /**
   * Validates that output is not empty.
   * @param {Object} task - Task configuration
   * @param {Object} executionResult - Execution result
   * @returns {Promise<ValidationResult>} Validation result
   */
  async validateOutputNotEmpty(task, executionResult) {
    const output = executionResult.output;
    
    const isEmpty = output === undefined || 
                    output === null ||
                    (typeof output === 'string' && output.trim() === '') ||
                    (Array.isArray(output) && output.length === 0) ||
                    (typeof output === 'object' && Object.keys(output).length === 0);
    
    if (isEmpty) {
      return ValidationResult.failure(
        'output-not-empty',
        'Output is empty',
        { output }
      );
    }
    
    return ValidationResult.success(
      'output-not-empty',
      'Output is not empty'
    );
  }
  
  /**
   * Validates that output contains a specific string.
   * @param {Object} task - Task configuration
   * @param {Object} executionResult - Execution result
   * @param {Object} config - Criterion configuration
   * @returns {Promise<ValidationResult>} Validation result
   */
  async validateContainsString(task, executionResult, config = {}) {
    const substring = config.substring || config.value;
    const output = executionResult.output;
    
    if (!substring) {
      return ValidationResult.success(
        'contains-string',
        'Contains-string validation passed (no substring specified)'
      );
    }
    
    const outputStr = typeof output === 'string' 
      ? output 
      : JSON.stringify(output);
    
    const contains = outputStr.toLowerCase().includes(substring.toLowerCase());
    
    if (contains) {
      return ValidationResult.success(
        'contains-string',
        `Output contains "${substring}"`
      );
    }
    
    return ValidationResult.failure(
      'contains-string',
      `Output does not contain "${substring}"`,
      { substring, output: outputStr.substring(0, 200) }
    );
  }
  
  /**
   * Validates that output matches a regex pattern.
   * @param {Object} task - Task configuration
   * @param {Object} executionResult - Execution result
   * @param {Object} config - Criterion configuration
   * @returns {Promise<ValidationResult>} Validation result
   */
  async validateMatchesPattern(task, executionResult, config = {}) {
    const pattern = config.pattern || config.regex;
    const output = executionResult.output;
    
    if (!pattern) {
      return ValidationResult.success(
        'matches-pattern',
        'Matches-pattern validation passed (no pattern specified)'
      );
    }
    
    const outputStr = typeof output === 'string' 
      ? output 
      : JSON.stringify(output);
    
    try {
      const regex = new RegExp(pattern, config.flags || 'i');
      const matches = regex.test(outputStr);
      
      if (matches) {
        return ValidationResult.success(
          'matches-pattern',
          `Output matches pattern "${pattern}"`
        );
      }
      
      return ValidationResult.failure(
        'matches-pattern',
        `Output does not match pattern "${pattern}"`,
        { pattern, output: outputStr.substring(0, 200) }
      );
    } catch (error) {
      return ValidationResult.failure(
        'matches-pattern',
        `Invalid regex pattern: ${error.message}`
      );
    }
  }
}

module.exports = { Verifier, ValidationResult };
