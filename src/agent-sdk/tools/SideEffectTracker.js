/**
 * @fileoverview SideEffectTracker - Tracks and manages side effects of tool executions
 * 
 * This module provides a mechanism to record, categorize, and potentially undo
 * side effects caused by tool executions. It supports four types of side effects:
 * - read: Reading from resources (file systems, databases, etc.)
 * - write: Writing to resources
 * - network: Network calls (HTTP requests, etc.)
 * - execute: Command execution
 * 
 * @module SideEffectTracker
 * @requires uuid
 */

const { randomUUID } = require('crypto');

/**
 * Enum for side effect types
 * @readonly
 * @enum {string}
 */
const SideEffectType = {
  READ: 'read',
  WRITE: 'write',
  NETWORK: 'network',
  EXECUTE: 'execute'
};

/**
 * Represents a single side effect caused by a tool execution
 * 
 * @class SideEffect
 * @description Encapsulates metadata about a side effect including its type,
 * description, affected resource, and state information for potential undo operations
 */
class SideEffect {
  /**
   * Creates a new SideEffect instance
   * 
   * @param {Object} options - Configuration options
   * @param {SideEffectType} options.type - The type of side effect
   * @param {string} options.description - Human-readable description of the effect
   * @param {string} options.resource - The affected resource (file path, URL, etc.)
   * @param {*} [options.beforeState=null] - State before the effect occurred (for undo)
   * @param {string} [options.timestamp=new Date().toISOString()] - ISO timestamp
   * @throws {Error} If type is not a valid SideEffectType
   * @throws {Error} If description or resource is missing
   */
  constructor({
    type,
    description,
    resource,
    beforeState = null,
    timestamp = new Date().toISOString()
  }) {
    if (!Object.values(SideEffectType).includes(type)) {
      throw new Error(`Invalid side effect type: ${type}. Must be one of: ${Object.values(SideEffectType).join(', ')}`);
    }

    if (!description || typeof description !== 'string') {
      throw new Error('Description is required and must be a string');
    }

    if (!resource || typeof resource !== 'string') {
      throw new Error('Resource is required and must be a string');
    }

    /**
     * Unique identifier for this side effect
     * @type {string}
     * @readonly
     */
    this.id = randomUUID();

    /**
     * The type of side effect
     * @type {SideEffectType}
     * @readonly
     */
    this.type = type;

    /**
     * Human-readable description
     * @type {string}
     * @readonly
     */
    this.description = description;

    /**
     * The affected resource identifier
     * @type {string}
     * @readonly
     */
    this.resource = resource;

    /**
     * State before the effect occurred (used for undo)
     * @type {*}
     * @readonly
     */
    this.beforeState = beforeState;

    /**
     * ISO 8601 timestamp
     * @type {string}
     * @readonly
     */
    this.timestamp = timestamp;

    /**
     * Whether this effect has been undone
     * @type {boolean}
     */
    this.undone = false;
  }

  /**
   * Marks this side effect as undone
   * 
   * @returns {void}
   */
  markUndone() {
    this.undone = true;
  }

  /**
   * Converts the side effect to a plain object
   * 
   * @returns {Object} Plain object representation
   */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      description: this.description,
      resource: this.resource,
      beforeState: this.beforeState,
      timestamp: this.timestamp,
      undone: this.undone
    };
  }
}

/**
 * Tracks and manages side effects from tool executions
 * 
 * @class SideEffectTracker
 * @description Provides methods to record different types of side effects,
 * categorize them, and attempt to undo reversible operations
 */
class SideEffectTracker {
  /**
   * Creates a new SideEffectTracker instance
   */
  constructor() {
    /**
     * All recorded side effects
     * @type {SideEffect[]}
     * @private
     */
    this.effects = [];

    /**
     * Read operations (type: 'read')
     * @type {SideEffect[]}
     * @private
     */
    this.reads = [];

    /**
     * Write operations (type: 'write')
     * @type {SideEffect[]}
     * @private
     */
    this.writes = [];

    /**
     * Network calls (type: 'network')
     * @type {SideEffect[]}
     * @private
     */
    this.networkCalls = [];

    /**
     * Command executions (type: 'execute')
     * @type {SideEffect[]}
     * @private
     */
    this.executions = [];

    /**
     * Undo handlers for different effect types
     * @type {Map<string, Function>}
     * @private
     */
    this.undoHandlers = new Map();

    // Register default undo handlers
    this.registerUndoHandler(SideEffectType.WRITE, this._defaultWriteUndo.bind(this));
    this.registerUndoHandler(SideEffectType.EXECUTE, this._defaultExecuteUndo.bind(this));
  }

  /**
   * Registers a custom undo handler for a side effect type
   * 
   * @param {SideEffectType} type - The side effect type
   * @param {Function} handler - Async handler function(effect) => Promise<void>
   * @returns {void}
   */
  registerUndoHandler(type, handler) {
    if (typeof handler !== 'function') {
      throw new Error('Undo handler must be a function');
    }
    this.undoHandlers.set(type, handler);
  }

  /**
   * Default undo handler for write operations
   * 
   * @private
   * @param {SideEffect} effect - The effect to undo
   * @returns {Promise<boolean>}
   */
  async _defaultWriteUndo(effect) {
    // Base implementation - subclasses or handlers should override
    // This is a placeholder that assumes beforeState contains the data to restore
    if (!effect.beforeState) {
      throw new Error('Cannot undo write: no beforeState recorded');
    }
    return true;
  }

  /**
   * Default undo handler for execute operations
   * 
   * @private
   * @param {SideEffect} effect - The effect to undo
   * @returns {Promise<boolean>}
   */
  async _defaultExecuteUndo(effect) {
    // Command execution cannot typically be undone
    // This would require recording reverse commands in beforeState
    if (!effect.beforeState?.reverseCommand) {
      throw new Error('Cannot undo execute: no reverse command specified');
    }
    return true;
  }

  /**
   * Records a side effect
   * 
   * @param {SideEffect} effect - The side effect to record
   * @returns {SideEffect} The recorded effect
   * @throws {Error} If effect is not a SideEffect instance
   */
  record(effect) {
    if (!(effect instanceof SideEffect)) {
      throw new Error('Effect must be a SideEffect instance');
    }

    this.effects.push(effect);

    // Categorize by type
    switch (effect.type) {
      case SideEffectType.READ:
        this.reads.push(effect);
        break;
      case SideEffectType.WRITE:
        this.writes.push(effect);
        break;
      case SideEffectType.NETWORK:
        this.networkCalls.push(effect);
        break;
      case SideEffectType.EXECUTE:
        this.executions.push(effect);
        break;
    }

    return effect;
  }

  /**
   * Records a read operation
   * 
   * @param {string} resource - The resource that was read
   * @param {*} [beforeState=null] - State before reading (for tracking)
   * @returns {SideEffect} The recorded effect
   */
  recordRead(resource, beforeState = null) {
    return this.record(new SideEffect({
      type: SideEffectType.READ,
      description: `Read ${resource}`,
      resource,
      beforeState
    }));
  }

  /**
   * Records a write operation
   * 
   * @param {string} resource - The resource that was written
   * @param {*} beforeState - State before writing (required for undo)
   * @returns {SideEffect} The recorded effect
   */
  recordWrite(resource, beforeState) {
    return this.record(new SideEffect({
      type: SideEffectType.WRITE,
      description: `Wrote to ${resource}`,
      resource,
      beforeState
    }));
  }

  /**
   * Records a network call
   * 
   * @param {string} url - The URL called
   * @param {string} [method='GET'] - HTTP method
   * @param {Object} [metadata={}] - Additional metadata (headers, body, etc.)
   * @returns {SideEffect} The recorded effect
   */
  recordNetwork(url, method = 'GET', metadata = {}) {
    const description = `${method} ${url}`;
    const effect = new SideEffect({
      type: SideEffectType.NETWORK,
      description,
      resource: url,
      beforeState: { method, ...metadata }
    });
    return this.record(effect);
  }

  /**
   * Records a command execution
   * 
   * @param {string} command - The command executed
   * @param {string} [cwd=process.cwd()] - Working directory
   * @param {Object} [metadata={}] - Additional metadata (env vars, etc.)
   * @returns {SideEffect} The recorded effect
   */
  recordExecute(command, cwd = process.cwd(), metadata = {}) {
    return this.record(new SideEffect({
      type: SideEffectType.EXECUTE,
      description: `Executed: ${command}`,
      resource: cwd,
      beforeState: { command, cwd, ...metadata }
    }));
  }

  /**
   * Checks if any effects can be undone
   * 
   * @returns {boolean} True if there are undoable effects
   */
  canUndo() {
    const undoableEffects = [...this.writes, ...this.executions]
      .filter(e => !e.undone);
    return undoableEffects.length > 0;
  }

  /**
   * Gets the number of effects that can be undone
   * 
   * @returns {number} Count of undoable effects
   */
  undoableCount() {
    return [...this.writes, ...this.executions].filter(e => !e.undone).length;
  }

  /**
   * Attempts to undo reversible side effects in reverse order
   * 
   * @param {Object} [options={}] - Undo options
   * @param {boolean} [options.stopOnError=true] - Stop on first error
   * @returns {Promise<Array<{effectId: string, success: boolean, error?: string}>>} Undo results
   */
  async undo(options = {}) {
    const { stopOnError = true } = options;

    // Get undoable effects in reverse chronological order
    const undoableEffects = [...this.writes, ...this.executions]
      .filter(e => !e.undone)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const results = [];

    for (const effect of undoableEffects) {
      try {
        const handler = this.undoHandlers.get(effect.type);
        
        if (!handler) {
          throw new Error(`No undo handler registered for type: ${effect.type}`);
        }

        await handler(effect);
        effect.markUndone();
        
        results.push({ 
          effectId: effect.id, 
          success: true,
          type: effect.type,
          resource: effect.resource
        });
      } catch (error) {
        results.push({ 
          effectId: effect.id, 
          success: false, 
          error: error.message,
          type: effect.type,
          resource: effect.resource
        });

        if (stopOnError) {
          break;
        }
      }
    }

    return results;
  }

  /**
   * Gets all effects of a specific type
   * 
   * @param {SideEffectType} type - The effect type to filter by
   * @returns {SideEffect[]} Array of matching effects
   * @throws {Error} If type is invalid
   */
  getEffectsByType(type) {
    if (!Object.values(SideEffectType).includes(type)) {
      throw new Error(`Invalid side effect type: ${type}`);
    }
    return this.effects.filter(e => e.type === type);
  }

  /**
   * Gets all effects affecting a specific resource
   * 
   * @param {string} resource - Resource identifier
   * @returns {SideEffect[]} Array of matching effects
   */
  getEffectsByResource(resource) {
    return this.effects.filter(e => e.resource === resource);
  }

  /**
   * Gets effects within a time range
   * 
   * @param {Date} startTime - Start of range
   * @param {Date} endTime - End of range
   * @returns {SideEffect[]} Array of effects in range
   */
  getEffectsByTimeRange(startTime, endTime) {
    return this.effects.filter(e => {
      const effectTime = new Date(e.timestamp);
      return effectTime >= startTime && effectTime <= endTime;
    });
  }

  /**
   * Clears all recorded effects
   * 
   * @returns {void}
   */
  clear() {
    this.effects = [];
    this.reads = [];
    this.writes = [];
    this.networkCalls = [];
    this.executions = [];
  }

  /**
   * Gets summary statistics
   * 
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      total: this.effects.length,
      byType: {
        read: this.reads.length,
        write: this.writes.length,
        network: this.networkCalls.length,
        execute: this.executions.length
      },
      undone: this.effects.filter(e => e.undone).length,
      canUndo: this.canUndo(),
      undoableCount: this.undoableCount()
    };
  }

  /**
   * Converts the tracker to a JSON-serializable object
   * 
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      effects: this.effects.map(e => e.toJSON()),
      summary: {
        reads: this.reads.length,
        writes: this.writes.length,
        networkCalls: this.networkCalls.length,
        executions: this.executions.length,
        total: this.effects.length,
        canUndo: this.canUndo()
      }
    };
  }
}

module.exports = { 
  SideEffect, 
  SideEffectTracker,
  SideEffectType
};
