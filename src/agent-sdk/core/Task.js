/**
 * @fileoverview Task Class Implementation
 * 
 * Main Task class for the OpenAI Agent SDK. Represents a unit of work
 * with lifecycle management, validation, and state tracking.
 * 
 * @module Task
 * @version 1.0.0
 */

'use strict';

const { randomUUID } = require('crypto');
const { TaskStatus, canTransition, isTerminalState } = require('./TaskStatus');
const { validateTask, validateTaskOutput } = require('./TaskSchema');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validateUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);

/**
 * Custom error class for Task-related errors.
 * @extends Error
 */
class TaskError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} code - Error code
   * @param {Object} [details] - Additional error details
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Represents a task in the OpenAI Agent SDK.
 * Tasks encapsulate objectives, execution context, constraints, and lifecycle state.
 * 
 * @class Task
 * @example
 * ```javascript
 * const task = new Task({
 *   type: 'code-generation',
 *   objective: 'Create a REST API endpoint',
 *   input: { content: 'Generate a user login endpoint' },
 *   constraints: { maxTokens: 8000, maxSteps: 5 }
 * });
 * 
 * task.transitionStatus(TaskStatus.PLANNING);
 * task.addStep({ type: 'analysis', description: 'Analyzing requirements' });
 * task.setResult('code', 'const login = ...');
 * task.transitionStatus(TaskStatus.COMPLETED);
 * ```
 */
class Task {
  /**
   * Creates a new Task instance.
   * 
   * @param {Object} [data={}] - Task initialization data
   * @param {string} [data.id] - Unique identifier (auto-generated if not provided)
   * @param {string} [data.type='multi-step'] - Task type
   * @param {string} [data.objective=''] - Task objective description
   * @param {Object} [data.context] - Execution context
   * @param {Object} [data.input] - Input data
   * @param {Object} [data.output] - Output configuration
   * @param {string[]} [data.tools] - Available tools
   * @param {Object} [data.constraints] - Execution constraints
   * @param {Object} [data.completionCriteria] - Completion criteria
   * @param {Object} [data.retryPolicy] - Retry policy configuration
   * @throws {TaskError} If validation fails
   */
  constructor(data = {}) {
    // Initialize ID
    if (data.id) {
      if (!validateUuid(data.id)) {
        throw new TaskError(
          `Invalid task ID: '${data.id}'. Must be a valid UUID.`,
          'INVALID_ID',
          { providedId: data.id }
        );
      }
      this.id = data.id;
    } else {
      this.id = randomUUID();
    }

    // Core properties
    this.type = data.type || 'multi-step';
    this.objective = data.objective || '';

    // Context with defaults
    this.context = {
      sessionId: data.context?.sessionId,
      parentTaskId: data.context?.parentTaskId,
      priority: data.context?.priority ?? 5,
      deadline: data.context?.deadline,
      tags: data.context?.tags || [],
      metadata: data.context?.metadata || {},
      ...data.context
    };

    // Input with defaults
    this.input = {
      content: data.input?.content || '',
      format: data.input?.format || 'text',
      attachments: data.input?.attachments || [],
      references: data.input?.references || [],
      ...data.input
    };

    // Output configuration with defaults
    this.output = {
      format: data.output?.format || 'text',
      schema: data.output?.schema,
      destination: data.output?.destination || 'chat',
      filePath: data.output?.filePath,
      ...data.output
    };

    // Tools list
    this.tools = data.tools || [];

    // Constraints with defaults
    this.constraints = {
      maxTokens: data.constraints?.maxTokens ?? 4000,
      maxSteps: data.constraints?.maxSteps ?? 10,
      timeout: data.constraints?.timeout,
      allowedOperations: data.constraints?.allowedOperations || ['read'],
      forbiddenPaths: data.constraints?.forbiddenPaths || [],
      requireApproval: data.constraints?.requireApproval || [],
      ...data.constraints
    };

    // Completion criteria
    this.completionCriteria = {
      conditions: data.completionCriteria?.conditions || [],
      minConfidence: data.completionCriteria?.minConfidence ?? 0.8,
      customValidator: data.completionCriteria?.customValidator,
      ...data.completionCriteria
    };

    // Retry policy with defaults
    this.retryPolicy = {
      maxAttempts: data.retryPolicy?.maxAttempts ?? 3,
      backoff: data.retryPolicy?.backoff || 'exponential',
      initialDelay: data.retryPolicy?.initialDelay ?? 1000,
      maxDelay: data.retryPolicy?.maxDelay ?? 60000,
      retryableErrors: data.retryPolicy?.retryableErrors || ['timeout', 'rate-limit'],
      ...data.retryPolicy
    };

    // State tracking
    this.status = TaskStatus.PENDING;
    this.steps = [];
    this.results = {};

    // Metadata
    const now = new Date().toISOString();
    this.metadata = {
      createdAt: data.metadata?.createdAt || now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      attempts: 0,
      tokensUsed: 0,
      executionTime: 0,
      ...data.metadata
    };

    // Validate on creation
    const validation = validateTask(this.toJSON());
    if (!validation.valid) {
      throw new TaskError(
        `Invalid task: ${validation.errors.join(', ')}`,
        'VALIDATION_ERROR',
        { errors: validation.errors }
      );
    }
  }

  /**
   * Transitions the task to a new status.
   * 
   * @param {string} newStatus - The target status
   * @param {Object} [options={}] - Transition options
   * @param {string} [options.reason] - Reason for the transition
   * @param {Object} [options.metadata] - Additional metadata for the transition
   * @throws {TaskError} If the transition is invalid
   * @returns {boolean} True if transition succeeded
   * 
   * @example
   * ```javascript
   * task.transitionStatus(TaskStatus.EXECUTING, { 
   *   reason: 'Planning complete, starting execution' 
   * });
   * ```
   */
  transitionStatus(newStatus, options = {}) {
    if (!canTransition(this.status, newStatus)) {
      throw new TaskError(
        `Invalid transition: ${this.status} -> ${newStatus}`,
        'INVALID_TRANSITION',
        { 
          fromStatus: this.status, 
          toStatus: newStatus,
          allowedTransitions: this.getAllowedTransitions()
        }
      );
    }

    const oldStatus = this.status;
    this.status = newStatus;
    this.metadata.updatedAt = new Date().toISOString();

    // Track start time when moving to an active state
    if (oldStatus === TaskStatus.PENDING && 
        [TaskStatus.PLANNING, TaskStatus.EXECUTING].includes(newStatus)) {
      this.metadata.startedAt = new Date().toISOString();
    }

    // Track completion for terminal states
    if (isTerminalState(newStatus)) {
      this.metadata.completedAt = new Date().toISOString();
      
      // Calculate execution time if started
      if (this.metadata.startedAt) {
        const started = new Date(this.metadata.startedAt);
        const completed = new Date(this.metadata.completedAt);
        this.metadata.executionTime = completed.getTime() - started.getTime();
      }
    }

    // Add transition info as a step if reason provided
    if (options.reason) {
      this.addStep({
        type: 'status-change',
        description: options.reason,
        fromStatus: oldStatus,
        toStatus: newStatus,
        metadata: options.metadata
      });
    }

    return true;
  }

  /**
   * Gets the list of allowed next statuses.
   * 
   * @returns {string[]} Array of valid next statuses
   */
  getAllowedTransitions() {
    const { getAllowedTransitions } = require('./TaskStatus');
    return getAllowedTransitions(this.status);
  }

  /**
   * Adds an execution step to the task.
   * 
   * @param {Object} step - The step to add
   * @param {string} step.type - Step type (e.g., 'analysis', 'execution', 'tool-call')
   * @param {string} [step.description] - Step description
   * @param {*} [step.input] - Step input
   * @param {*} [step.output] - Step output
   * @param {string} [step.status='completed'] - Step status
   * @param {Object} [step.metadata] - Additional step metadata
   * @throws {TaskError} If max steps constraint is exceeded
   * @returns {Object} The added step with generated ID and timestamp
   * 
   * @example
   * ```javascript
   * task.addStep({
   *   type: 'tool-call',
   *   description: 'Read file contents',
   *   input: { path: '/path/to/file' },
   *   output: { content: '...' },
   *   status: 'completed'
   * });
   * ```
   */
  addStep(step) {
    if (this.steps.length >= this.constraints.maxSteps) {
      throw new TaskError(
        `Max steps (${this.constraints.maxSteps}) exceeded`,
        'CONSTRAINT_VIOLATION',
        { 
          maxSteps: this.constraints.maxSteps, 
          attemptedSteps: this.steps.length + 1 
        }
      );
    }

    const enrichedStep = {
      id: randomUUID(),
      type: step.type,
      description: step.description || '',
      input: step.input,
      output: step.output,
      status: step.status || 'completed',
      timestamp: new Date().toISOString(),
      metadata: step.metadata || {},
      ...step
    };

    this.steps.push(enrichedStep);
    this.metadata.updatedAt = new Date().toISOString();

    return enrichedStep;
  }

  /**
   * Gets a step by its ID.
   * 
   * @param {string} stepId - The step ID
   * @returns {Object|undefined} The step or undefined if not found
   */
  getStep(stepId) {
    return this.steps.find(s => s.id === stepId);
  }

  /**
   * Gets the most recent step.
   * 
   * @returns {Object|undefined} The last step or undefined if no steps
   */
  getLastStep() {
    return this.steps[this.steps.length - 1];
  }

  /**
   * Sets a result value.
   * 
   * @param {string} key - Result key
   * @param {*} value - Result value
   * @param {Object} [metadata] - Result metadata
   * @returns {*} The set value
   * 
   * @example
   * ```javascript
   * task.setResult('code', 'function hello() {}', { language: 'javascript' });
   * ```
   */
  setResult(key, value, metadata) {
    this.results[key] = {
      value,
      metadata,
      timestamp: new Date().toISOString()
    };
    this.metadata.updatedAt = new Date().toISOString();
    return value;
  }

  /**
   * Gets a result value by key.
   * 
   * @param {string} key - Result key
   * @returns {*} The result value or undefined
   */
  getResult(key) {
    return this.results[key]?.value;
  }

  /**
   * Gets all result keys.
   * 
   * @returns {string[]} Array of result keys
   */
  getResultKeys() {
    return Object.keys(this.results);
  }

  /**
   * Increments the attempt counter.
   * 
   * @returns {number} The new attempt count
   */
  incrementAttempt() {
    this.metadata.attempts++;
    this.metadata.updatedAt = new Date().toISOString();
    return this.metadata.attempts;
  }

  /**
   * Adds token usage to the metadata.
   * 
   * @param {number} tokens - Number of tokens to add
   * @returns {number} The new total tokens used
   */
  addTokenUsage(tokens) {
    if (typeof tokens !== 'number' || tokens < 0) {
      throw new TaskError(
        `Invalid token count: ${tokens}`,
        'INVALID_ARGUMENT',
        { tokens }
      );
    }
    this.metadata.tokensUsed += tokens;
    this.metadata.updatedAt = new Date().toISOString();
    return this.metadata.tokensUsed;
  }

  /**
   * Sets the execution time.
   * 
   * @param {number} milliseconds - Execution time in milliseconds
   * @returns {number} The set execution time
   */
  setExecutionTime(milliseconds) {
    if (typeof milliseconds !== 'number' || milliseconds < 0) {
      throw new TaskError(
        `Invalid execution time: ${milliseconds}`,
        'INVALID_ARGUMENT',
        { milliseconds }
      );
    }
    this.metadata.executionTime = milliseconds;
    this.metadata.updatedAt = new Date().toISOString();
    return this.metadata.executionTime;
  }

  /**
   * Checks if the task is in a terminal state.
   * 
   * @returns {boolean} True if terminal
   */
  isTerminal() {
    return isTerminalState(this.status);
  }

  /**
   * Checks if the task can be retried.
   * 
   * @returns {boolean} True if can retry
   */
  canRetry() {
    return this.metadata.attempts < this.retryPolicy.maxAttempts &&
           (this.status === TaskStatus.FAILED || this.status === TaskStatus.CANCELLED);
  }

  /**
   * Calculates the next retry delay.
   * 
   * @returns {number} Delay in milliseconds
   */
  getRetryDelay() {
    const { backoff, initialDelay, maxDelay } = this.retryPolicy;
    const attempt = this.metadata.attempts;
    
    let delay;
    switch (backoff) {
      case 'fixed':
        delay = initialDelay;
        break;
      case 'linear':
        delay = initialDelay * attempt;
        break;
      case 'exponential':
      default:
        delay = initialDelay * Math.pow(2, attempt - 1);
        break;
    }
    
    return Math.min(delay, maxDelay);
  }

  /**
   * Validates the current output against the expected schema.
   * 
   * @returns {Object} Validation result
   */
  validateOutput() {
    const outputValue = this.getResult('output');
    if (!outputValue || !this.output.schema) {
      return { valid: true, errors: [] };
    }
    return validateTaskOutput(outputValue, this.output.schema);
  }

  /**
   * Converts the task to a plain JSON object.
   * 
   * @returns {Object} Plain object representation
   */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      objective: this.objective,
      context: { ...this.context },
      input: { ...this.input },
      output: { ...this.output },
      tools: [...this.tools],
      constraints: { ...this.constraints },
      completionCriteria: { ...this.completionCriteria },
      retryPolicy: { ...this.retryPolicy },
      status: this.status,
      steps: [...this.steps],
      results: { ...this.results },
      metadata: { ...this.metadata }
    };
  }

  /**
   * Serializes the task to a JSON string.
   * 
   * @param {number} [indent=2] - Indentation spaces
   * @returns {string} JSON string
   */
  serialize(indent = 2) {
    return JSON.stringify(this.toJSON(), null, indent);
  }

  /**
   * Creates a Task instance from a plain object.
   * 
   * @param {Object} json - The plain object
   * @returns {Task} A new Task instance
   * @throws {TaskError} If the JSON is invalid
   * 
   * @example
   * ```javascript
   * const task = Task.fromJSON({
   *   id: '...',
   *   type: 'code-generation',
   *   objective: '...',
   *   // ... other fields
   * });
   * ```
   */
  static fromJSON(json) {
    if (!json || typeof json !== 'object') {
      throw new TaskError(
        'Invalid JSON: must be a non-null object',
        'DESERIALIZATION_ERROR',
        { json }
      );
    }

    // Create task with JSON data
    const task = new Task(json);
    
    // Restore mutable state
    if (json.status && Object.values(TaskStatus).includes(json.status)) {
      task.status = json.status;
    }
    if (Array.isArray(json.steps)) {
      task.steps = json.steps;
    }
    if (json.results && typeof json.results === 'object') {
      task.results = json.results;
    }
    if (json.metadata && typeof json.metadata === 'object') {
      task.metadata = { ...task.metadata, ...json.metadata };
    }

    return task;
  }

  /**
   * Creates a Task instance from a JSON string.
   * 
   * @param {string} jsonString - The JSON string
   * @returns {Task} A new Task instance
   * @throws {TaskError} If the string is invalid JSON
   */
  static deserialize(jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      return Task.fromJSON(parsed);
    } catch (error) {
      throw new TaskError(
        `Failed to deserialize task: ${error.message}`,
        'DESERIALIZATION_ERROR',
        { originalError: error.message }
      );
    }
  }

  /**
   * Creates a child task with this task as parent.
   * 
   * @param {Object} childData - Data for the child task
   * @returns {Task} The child task
   */
  createChildTask(childData = {}) {
    return new Task({
      ...childData,
      context: {
        ...childData.context,
        parentTaskId: this.id,
        sessionId: this.context.sessionId
      }
    });
  }

  /**
   * Creates a clone of this task.
   * 
   * @param {Object} [overrides={}] - Properties to override
   * @returns {Task} A new cloned Task instance
   */
  clone(overrides = {}) {
    const cloned = new Task({
      ...this.toJSON(),
      id: undefined, // Generate new ID
      ...overrides,
      context: {
        ...this.context,
        ...overrides.context
      }
    });
    return cloned;
  }
}

module.exports = {
  Task,
  TaskError
};
