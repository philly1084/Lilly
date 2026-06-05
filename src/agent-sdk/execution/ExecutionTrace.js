const { randomUUID } = require('crypto');

/**
 * Represents a single step in an execution trace.
 * Can contain nested substeps for hierarchical execution tracking.
 * @class ExecutionStep
 */
class ExecutionStep {
  /**
   * Creates an ExecutionStep instance.
   * @param {Object} options - Step configuration
   * @param {string} options.type - Type of step: 'plan', 'tool-call', 'llm-call', 'verify', 'error'
   * @param {string} options.description - Human-readable description of the step
   * @param {*} [options.input=null] - Input data for the step
   * @param {*} [options.output=null] - Output data from the step
   * @param {Error|string} [options.error=null] - Error if step failed
   * @param {Object} [options.metadata={}] - Additional metadata
   */
  constructor({
    type,
    description,
    input = null,
    output = null,
    error = null,
    metadata = {}
  }) {
    /** @type {string} Unique identifier for this step */
    this.id = randomUUID();
    
    /** @type {string} Type of execution step */
    this.type = type;
    
    /** @type {string} Description of what this step does */
    this.description = description;
    
    /** @type {*} Input data provided to this step */
    this.input = input;
    
    /** @type {*} Output data produced by this step */
    this.output = output;
    
    /** @type {Error|string|null} Error if step failed */
    this.error = error;
    
    /** @type {Object} Metadata including timestamps, duration, tokens */
    this.metadata = {
      timestamp: new Date().toISOString(),
      duration: 0,
      tokens: { input: 0, output: 0 },
      ...metadata
    };
    
    /** @type {ExecutionStep[]} Nested substeps */
    this.substeps = [];
  }
  
  /**
   * Adds a nested substep to this step.
   * @param {ExecutionStep} step - The substep to add
   * @returns {ExecutionStep} This step for chaining
   */
  addSubstep(step) {
    this.substeps.push(step);
    return this;
  }
  
  /**
   * Calculates and sets the duration based on start time.
   * @param {number} startTime - Start timestamp from Date.now()
   * @returns {number} The calculated duration in milliseconds
   */
  setDuration(startTime) {
    this.metadata.duration = Date.now() - startTime;
    return this.metadata.duration;
  }
  
  /**
   * Sets token usage for this step.
   * @param {number} input - Number of input tokens
   * @param {number} output - Number of output tokens
   * @returns {ExecutionStep} This step for chaining
   */
  setTokens(input, output) {
    this.metadata.tokens = { input, output };
    return this;
  }
  
  /**
   * Converts this step to a plain JSON object.
   * @returns {Object} JSON representation of this step
   */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      description: this.description,
      input: this.input,
      output: this.output,
      error: this.error,
      metadata: this.metadata,
      substeps: this.substeps.map(s => s.toJSON())
    };
  }
  
  /**
   * Creates a human-readable string representation.
   * @returns {string} String representation
   */
  toString() {
    const status = this.error ? '❌ FAILED' : '✅ SUCCESS';
    return `[${this.type}] ${this.description} (${this.metadata.duration}ms) ${status}`;
  }
}

/**
 * Captures detailed execution traces for tasks.
 * Tracks all steps, metrics, timing, and provides export capabilities.
 * @class ExecutionTrace
 */
class ExecutionTrace {
  /**
   * Creates an ExecutionTrace instance.
   * @param {string} taskId - The ID of the task being traced
   */
  constructor(taskId) {
    /** @type {string} Unique identifier for this trace */
    this.id = randomUUID();
    
    /** @type {string} ID of the associated task */
    this.taskId = taskId;
    
    /** @type {number} Start timestamp */
    this.startTime = Date.now();
    
    /** @type {number|null} End timestamp */
    this.endTime = null;
    
    /** @type {ExecutionStep[]} Top-level steps */
    this.steps = [];
    
    /** @type {Object} Aggregated metrics */
    this.metrics = {
      totalSteps: 0,
      totalDuration: 0,
      totalTokens: { input: 0, output: 0 },
      toolCalls: 0,
      llmCalls: 0,
      errors: 0,
      retries: 0
    };
  }
  
  /**
   * Adds a step to the trace and updates metrics.
   * @param {ExecutionStep} step - The step to add
   * @returns {ExecutionTrace} This trace for chaining
   */
  addStep(step) {
    this.steps.push(step);
    this.updateMetricsForStep(step);
    
    return this;
  }

  /**
   * Updates aggregate metrics for a step and any nested substeps.
   * @param {ExecutionStep} step - The step to aggregate
   * @returns {ExecutionTrace} This trace for chaining
   */
  updateMetricsForStep(step) {
    for (const current of this.flattenSteps([step])) {
      this.metrics.totalSteps++;

      if (current.type === 'tool-call') this.metrics.toolCalls++;
      if (current.type === 'llm-call') this.metrics.llmCalls++;
      if (current.error) this.metrics.errors++;
      if (current.metadata.retries) this.metrics.retries += current.metadata.retries;

      this.metrics.totalTokens.input += current.metadata.tokens?.input || 0;
      this.metrics.totalTokens.output += current.metadata.tokens?.output || 0;
    }

    return this;
  }
  
  /**
   * Finalizes the trace by setting end time and total duration.
   * @returns {ExecutionTrace} This trace for chaining
   */
  finalize() {
    this.endTime = Date.now();
    this.metrics.totalDuration = this.endTime - this.startTime;
    return this;
  }
  
  /**
   * Finds a step by its ID, searching recursively through substeps.
   * @param {string} id - The step ID to find
   * @returns {ExecutionStep|null} The found step or null
   */
  getStepById(id) {
    return this.findStep(this.steps, id);
  }
  
  /**
   * Recursively searches for a step by ID.
   * @private
   * @param {ExecutionStep[]} steps - Steps to search
   * @param {string} id - ID to find
   * @returns {ExecutionStep|null} Found step or null
   */
  findStep(steps, id) {
    for (const step of steps) {
      if (step.id === id) return step;
      if (step.substeps.length > 0) {
        const found = this.findStep(step.substeps, id);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Flattens steps recursively while preserving traversal order.
   * @param {ExecutionStep[]} steps - Steps to flatten
   * @returns {ExecutionStep[]} Flattened step list
   */
  flattenSteps(steps = this.steps) {
    const flattened = [];

    for (const step of steps) {
      flattened.push(step);

      if (step.substeps.length > 0) {
        flattened.push(...this.flattenSteps(step.substeps));
      }
    }

    return flattened;
  }
  
  /**
   * Filters steps by a predicate function.
   * @param {Function} predicate - Function to test each step
   * @returns {ExecutionStep[]} Filtered steps
   */
  filterSteps(predicate) {
    return this.flattenSteps().filter(predicate);
  }
  
  /**
   * Gets all steps that have errors.
   * @returns {ExecutionStep[]} Steps with errors
   */
  getErrors() {
    return this.filterSteps(s => s.error);
  }
  
  /**
   * Gets all tool call steps.
   * @returns {ExecutionStep[]} Tool call steps
   */
  getToolCalls() {
    return this.filterSteps(s => s.type === 'tool-call');
  }
  
  /**
   * Gets all LLM call steps.
   * @returns {ExecutionStep[]} LLM call steps
   */
  getLLMCalls() {
    return this.filterSteps(s => s.type === 'llm-call');
  }
  
  /**
   * Gets steps by type.
   * @param {string} type - Step type to filter by
   * @returns {ExecutionStep[]} Steps of the specified type
   */
  getStepsByType(type) {
    return this.filterSteps(s => s.type === type);
  }
  
  /**
   * Converts the trace to a plain JSON object.
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      id: this.id,
      taskId: this.taskId,
      startTime: new Date(this.startTime).toISOString(),
      endTime: this.endTime ? new Date(this.endTime).toISOString() : null,
      steps: this.steps.map(s => s.toJSON()),
      metrics: this.metrics
    };
  }
  
  /**
   * Exports the trace in the specified format.
   * @param {string} [format='json'] - Export format: 'json', 'markdown', 'compact'
   * @returns {string} Exported trace
   */
  export(format = 'json') {
    switch (format) {
      case 'json':
        return JSON.stringify(this.toJSON(), null, 2);
      case 'compact':
        return JSON.stringify(this.toJSON());
      case 'markdown':
        return this.toMarkdown();
      default:
        throw new Error(`Unknown export format: ${format}`);
    }
  }
  
  /**
   * Converts the trace to Markdown format.
   * @returns {string} Markdown representation
   */
  toMarkdown() {
    const lines = [
      `# Execution Trace: ${this.taskId}`,
      ``,
      `**Trace ID:** \`${this.id}\``,
      `**Duration:** ${this.metrics.totalDuration}ms`,
      `**Steps:** ${this.metrics.totalSteps}`,
      `**Tokens:** ${this.metrics.totalTokens.input} in / ${this.metrics.totalTokens.output} out`,
      `**Tool Calls:** ${this.metrics.toolCalls}`,
      `**LLM Calls:** ${this.metrics.llmCalls}`,
      `**Errors:** ${this.metrics.errors}`,
      ``
    ];
    
    for (let i = 0; i < this.steps.length; i++) {
      lines.push(`## Step ${i + 1}`);
      lines.push(this.stepToMarkdown(this.steps[i], 0));
      lines.push('');
    }
    
    return lines.join('\n');
  }
  
  /**
   * Converts a step to Markdown format.
   * @private
   * @param {ExecutionStep} step - The step to convert
   * @param {number} depth - Nesting depth
   * @returns {string} Markdown representation
   */
  stepToMarkdown(step, depth) {
    const indent = '  '.repeat(depth);
    const lines = [
      `${indent}### ${step.type}: ${step.description}`,
      `${indent}- **ID:** \`${step.id}\``,
      `${indent}- **Duration:** ${step.metadata.duration}ms`,
      `${indent}- **Timestamp:** ${step.metadata.timestamp}`
    ];
    
    if (step.metadata.tokens.input || step.metadata.tokens.output) {
      lines.push(`${indent}- **Tokens:** ${step.metadata.tokens.input} in / ${step.metadata.tokens.output} out`);
    }
    
    if (step.error) {
      lines.push(`${indent}- **Error:** \`\`\`${step.error}\`\`\``);
    }
    
    if (step.substeps.length > 0) {
      lines.push(`${indent}- **Substeps:**`);
      for (const substep of step.substeps) {
        lines.push(this.stepToMarkdown(substep, depth + 1));
      }
    }
    
    return lines.join('\n');
  }
  
  /**
   * Creates a summary of the execution.
   * @returns {Object} Summary object
   */
  summarize() {
    return {
      taskId: this.taskId,
      traceId: this.id,
      duration: this.metrics.totalDuration,
      success: this.metrics.errors === 0,
      stepCount: this.metrics.totalSteps,
      toolCalls: this.metrics.toolCalls,
      llmCalls: this.metrics.llmCalls,
      errors: this.metrics.errors,
      retries: this.metrics.retries,
      tokens: this.metrics.totalTokens
    };
  }
  
  /**
   * Creates a human-readable summary string.
   * @returns {string} Summary string
   */
  toString() {
    const summary = this.summarize();
    const status = summary.success ? '✅ SUCCESS' : '❌ FAILED';
    return `ExecutionTrace[${this.taskId}] ${status} - ${summary.stepCount} steps, ${summary.duration}ms`;
  }
}

module.exports = { ExecutionTrace, ExecutionStep };
