/**
 * ToolBase - Abstract base class for all tools
 * Provides common functionality for execution, validation, and error handling
 */

const { AsyncLocalStorage } = require('async_hooks');
const {
  SideEffectTracker,
  createSideEffectTracker,
} = require('./SideEffectTracker');
const {
  createToolInvocation,
  decideToolInvocationApproval,
} = require('../../tool-invocation');
const {
  createEvidenceAttestation,
  extractEvidenceAttestations,
} = require('../../agent-evidence');

function flattenSideEffects(sideEffects = {}) {
  return Object.entries(sideEffects || {}).flatMap(([category, entries]) => (
    (Array.isArray(entries) ? entries : []).map((entry) => ({ category, ...entry }))
  ));
}

function collectApprovalReceipts(context = {}) {
  return [
    context.approvalReceipt,
    context.approval,
    ...(Array.isArray(context.approvalReceipts) ? context.approvalReceipts : []),
    ...(Array.isArray(context.metadata?.approvalReceipts) ? context.metadata.approvalReceipts : []),
  ].filter(Boolean);
}

function shouldEnforceInvocationPolicy(context = {}) {
  if (context.enforceToolInvocationPolicy === false
    || context.toolInvocationPolicyMode === 'shadow') {
    return false;
  }
  return context.enforceToolInvocationPolicy === true
    || context.toolInvocationPolicyMode === 'enforce'
    || context.metadata?.missionMode === true;
}

class ToolBase {
  constructor(definition) {
    const defaultHandler = typeof this.handler === 'function' ? this.handler.bind(this) : null;

    this.id = definition.id;
    this.name = definition.name || definition.id;
    this.description = definition.description || '';
    this.category = definition.category || 'system';
    this.version = definition.version || '1.0.0';
    
    // Backend configuration
    this.handler = definition.backend?.handler || defaultHandler;
    this.sideEffects = definition.backend?.sideEffects || [];
    this.sandbox = definition.backend?.sandbox || {};
    this.timeout = definition.backend?.timeout || 30000;
    
    // Schemas
    this.inputSchema = definition.inputSchema || { type: 'object' };
    this.outputSchema = definition.outputSchema || null;
    
    // Hooks
    this.beforeExecute = definition.hooks?.beforeExecute;
    this.afterExecute = definition.hooks?.afterExecute;
    this.onError = definition.hooks?.onError;
    
    // Side effect tracking. Async-local storage keeps the legacy property safe
    // when multiple invocations share one tool instance.
    this.sideEffectTrackerContext = new AsyncLocalStorage();
    this.defaultSideEffectTracker = createSideEffectTracker();
    Object.defineProperty(this, 'sideEffectTracker', {
      configurable: true,
      enumerable: true,
      get: () => this.sideEffectTrackerContext.getStore() || this.defaultSideEffectTracker,
      set: (tracker) => {
        this.defaultSideEffectTracker = tracker;
      },
    });
  }

  /**
   * Execute the tool with given parameters
   */
  async execute(params = {}, context = {}) {
    const startTime = Date.now();
    const invocationSideEffects = createSideEffectTracker();
    const runId = String(context.runId || context.agentRunId || '').trim();
    let invocation = null;
    let approvalDecision = null;

    return this.sideEffectTrackerContext.run(invocationSideEffects, async () => {
      try {
        // Normalize inputs before validation. Hooks are limited to input shaping;
        // handlers remain the first boundary allowed to perform side effects.
        if (this.beforeExecute) {
          await this.beforeExecute(params, context);
        }

        this.validateInputs(params);

        if (runId) {
          const approvalReceipts = collectApprovalReceipts(context);
          invocation = createToolInvocation({
            runId,
            toolId: this.id,
            toolVersion: this.version,
            input: params,
            sideEffects: this.sideEffects,
            idempotencyKey: context.idempotencyKey || params.idempotencyKey,
            idempotency: context.idempotency,
            status: 'planned',
          });
          const sandboxMode = context.sandboxMode === true
            || context.sandbox?.enabled === true
            || this.sandbox?.filesystem === 'isolated';
          const workspaceBounded = context.workspaceBounded === true
            || context.sandbox?.workspaceBounded === true
            || this.sandbox?.filesystem === 'isolated';
          approvalDecision = approvalReceipts
            .map((approvalReceipt) => decideToolInvocationApproval(invocation, {
              sandboxMode,
              workspaceBounded,
              approvalReceipt,
            }))
            .find((decision) => decision.allowed)
            || decideToolInvocationApproval(invocation, { sandboxMode, workspaceBounded });
          if (shouldEnforceInvocationPolicy(context) && !approvalDecision.allowed) {
            const error = new Error(approvalDecision.reason);
            error.name = 'ToolApprovalRequiredError';
            error.code = 'TOOL_APPROVAL_REQUIRED';
            error.statusCode = 409;
            throw error;
          }
        }

        // Execute with timeout
        const result = await this.executeWithTimeout(params, context, invocationSideEffects);

        // Validate outputs
        this.validateOutputs(result);

        // Post-execution hooks
        if (this.afterExecute) {
          await this.afterExecute(result, params, context);
        }

        const duration = Date.now() - startTime;
        const sideEffects = invocationSideEffects.getAll();
        const extractedEvidence = extractEvidenceAttestations({
          evidenceAttestations: Array.isArray(result?.evidenceAttestations)
            ? result.evidenceAttestations
            : (Array.isArray(result?.evidence) ? result.evidence : []),
        }).attestations;
        const typedEvidence = invocation
          ? extractedEvidence.map((entry) => createEvidenceAttestation({
              ...entry,
              sourceInvocationId: invocation.id,
            }))
          : extractedEvidence;
        const completedInvocation = invocation ? createToolInvocation({
          ...invocation,
          input: params,
          retrySafe: invocation.retrySafe,
          approvalReceipt: approvalDecision?.receipt,
          result,
          evidence: typedEvidence,
          sideEffects: flattenSideEffects(sideEffects),
          status: 'succeeded',
        }) : null;

        return {
          success: true,
          data: result,
          duration,
          sideEffects,
          toolId: this.id,
          timestamp: new Date().toISOString(),
          ...(completedInvocation ? { invocation: completedInvocation, approvalDecision } : {}),
        };
      } catch (error) {
        const duration = Date.now() - startTime;

        // Error hook
        if (this.onError) {
          await this.onError(error, params, context);
        }

        const sideEffects = invocationSideEffects.getAll();
        const failedInvocation = invocation ? createToolInvocation({
          ...invocation,
          input: params,
          retrySafe: invocation.retrySafe,
          approvalReceipt: approvalDecision?.receipt,
          result: {
            error: error.message,
            errorCode: error.code || null,
          },
          sideEffects: flattenSideEffects(sideEffects),
          status: error.code === 'TOOL_APPROVAL_REQUIRED' ? 'blocked' : 'failed',
        }) : null;

        return {
          success: false,
          error: error.message,
          ...(error.code ? { errorCode: error.code } : {}),
          ...(Number.isFinite(Number(error.statusCode || error.status)) ? { statusCode: Number(error.statusCode || error.status) } : {}),
          ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
          errorType: error.name,
          duration,
          sideEffects,
          toolId: this.id,
          timestamp: new Date().toISOString(),
          ...(failedInvocation ? { invocation: failedInvocation, approvalDecision } : {}),
        };
      }
    });
  }

  /**
   * Execute with timeout protection
   */
  async executeWithTimeout(params, context, sideEffectTracker = this.sideEffectTracker) {
    const requestedTimeout = Number(params?.timeout);
    const effectiveTimeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : this.timeout;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Tool ${this.id} timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
      
      Promise.resolve(this.handler(params, context, sideEffectTracker))
        .then(result => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Validate input parameters against schema
   */
  validateInputs(params) {
    if (!this.inputSchema) return;
    
    const required = this.inputSchema.required || [];
    const properties = this.inputSchema.properties || {};
    
    // Check required fields
    for (const field of required) {
      if (params[field] === undefined || params[field] === null) {
        throw new Error(`Missing required parameter: ${field}`);
      }
    }
    
    // Type validation (basic)
    for (const [key, value] of Object.entries(params)) {
      const propSchema = properties[key];
      if (propSchema && propSchema.type) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== propSchema.type && !(propSchema.type === 'integer' && actualType === 'number')) {
          throw new Error(`Invalid type for ${key}: expected ${propSchema.type}, got ${actualType}`);
        }
      }
    }
  }

  /**
   * Validate outputs against schema
   */
  validateOutputs(result) {
    if (!this.outputSchema) return;
    const failure = this.findSchemaFailure(result, this.outputSchema, 'result');
    if (!failure) return;

    const error = new Error(
      `Invalid tool output at ${failure.path}: expected ${failure.expected}, got ${failure.actual}`,
    );
    error.name = 'ToolOutputValidationError';
    error.code = 'TOOL_OUTPUT_SCHEMA_VALIDATION_FAILED';
    error.diagnostics = failure;
    throw error;
  }

  findSchemaFailure(value, schema = {}, path = 'result') {
    if (!schema || typeof schema !== 'object') return null;
    const expectedTypes = Array.isArray(schema.type)
      ? schema.type
      : (schema.type ? [schema.type] : []);
    if (schema.nullable === true) expectedTypes.push('null');

    if (expectedTypes.length > 0 && !expectedTypes.some(type => this.matchesSchemaType(value, type))) {
      return {
        path,
        expected: expectedTypes.join('|'),
        actual: this.getSchemaType(value),
      };
    }
    if (value === null || value === undefined) return null;

    if (schema.type === 'object' || (!schema.type && schema.properties)) {
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const field of required) {
        if (!Object.prototype.hasOwnProperty.call(value, field) || value[field] === undefined || value[field] === null) {
          return {
            path: `${path}.${field}`,
            expected: 'required value',
            actual: value[field] === null ? 'null' : 'missing',
          };
        }
      }
      const properties = schema.properties && typeof schema.properties === 'object'
        ? schema.properties
        : {};
      for (const [field, propertySchema] of Object.entries(properties)) {
        if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
        const failure = this.findSchemaFailure(value[field], propertySchema, `${path}.${field}`);
        if (failure) return failure;
      }
    }
    if (schema.type === 'array' && schema.items && Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const failure = this.findSchemaFailure(value[index], schema.items, `${path}[${index}]`);
        if (failure) return failure;
      }
    }
    return null;
  }

  matchesSchemaType(value, expected) {
    switch (expected) {
      case 'array': return Array.isArray(value);
      case 'integer': return Number.isInteger(value);
      case 'null': return value === null;
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'object': return Boolean(value && typeof value === 'object' && !Array.isArray(value));
      default: return typeof value === expected;
    }
  }

  getSchemaType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (Number.isInteger(value)) return 'integer';
    return typeof value;
  }

  /**
   * Get tool definition for registry
   */
  toDefinition() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      category: this.category,
      version: this.version,
      backend: {
        handler: this.handler,
        sideEffects: this.sideEffects,
        sandbox: this.sandbox,
        timeout: this.timeout
      },
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema
    };
  }

  /**
   * Check if tool has side effect
   */
  hasSideEffect(effect) {
    return this.sideEffects.includes(effect);
  }

  /**
   * Check if tool can be undone
   */
  canUndo() {
    return this.sideEffectTracker.canUndo();
  }

  /**
   * Undo side effects
   */
  async undo() {
    return this.sideEffectTracker.undo();
  }
}

module.exports = { ToolBase, SideEffectTracker };
