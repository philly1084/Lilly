const { randomUUID } = require('crypto');

/**
 * @typedef {Object} ContextItem
 * @property {string} type - Type of context item (e.g., 'message', 'tool_result')
 * @property {Object} data - The context data
 * @property {string} timestamp - ISO timestamp
 */

/**
 * @typedef {Object} Message
 * @property {string} id - Unique message ID
 * @property {'user'|'assistant'|'system'|'tool'} role - Message role
 * @property {string} content - Message content
 * @property {string} timestamp - ISO timestamp
 * @property {Object} [metadata] - Additional metadata
 */

/**
 * @typedef {Object} UserPreferences
 * @property {string} [preferredModel] - Preferred LLM model
 * @property {'concise'|'detailed'|'balanced'} responseStyle - Response verbosity
 * @property {string} [codeStyle] - Preferred code style (e.g., 'functional', 'oop')
 * @property {string} language - Preferred language code
 */

/**
 * @typedef {Object} TokenUsage
 * @property {number} input - Input token count
 * @property {number} output - Output token count
 */

/**
 * @typedef {Object} WorkingMemoryOptions
 * @property {string} [preferredModel] - Preferred LLM model
 * @property {'concise'|'detailed'|'balanced'} [responseStyle='balanced'] - Response verbosity
 * @property {string} [codeStyle] - Preferred code style
 * @property {string} [language='en'] - Preferred language
 * @property {number} [maxContextItems=20] - Maximum items in context window
 * @property {number} [ttl=86400000] - Time to live in milliseconds (default 24 hours)
 */

/**
 * Ephemeral per-session memory for maintaining context during agent interactions.
 * Automatically manages context window size and tracks session metadata.
 * 
 * @class WorkingMemory
 * @example
 * const memory = new WorkingMemory('session-123', { responseStyle: 'detailed' });
 * memory.setCurrentTask({ type: 'code-generation', objective: 'Create a function' });
 * memory.addMessage('user', 'Write a function to parse JSON');
 */
class WorkingMemory {
  /**
   * Creates a new WorkingMemory instance.
   * 
   * @param {string} sessionId - Unique identifier for the session
   * @param {WorkingMemoryOptions} [options={}] - Configuration options
   * @throws {Error} If sessionId is not provided
   */
  constructor(sessionId, options = {}) {
    if (!sessionId) {
      throw new Error('sessionId is required');
    }
    
    if (typeof sessionId !== 'string') {
      throw new TypeError('sessionId must be a string');
    }

    this.sessionId = sessionId;
    this.id = randomUUID();
    
    // Core context
    /** @type {Object|null} */
    this.currentTask = null;
    
    /** @type {ContextItem[]} */
    this.contextWindow = [];
    
    /** @type {string[]} */
    this.activeTools = [];
    
    /** @type {Map<string, any>} */
    this.intermediateResults = new Map();
    
    // User preferences (learned during session)
    /** @type {UserPreferences} */
    this.userPreferences = {
      preferredModel: options.preferredModel,
      responseStyle: options.responseStyle || 'balanced',
      codeStyle: options.codeStyle,
      language: options.language || 'en'
    };
    
    // Session state
    /** @type {Message[]} */
    this.conversationHistory = [];
    
    /** @type {TokenUsage} */
    this.tokenUsage = { input: 0, output: 0 };
    
    this.startTime = new Date().toISOString();
    this.lastActivity = this.startTime;
    
    // Configuration
    this.maxContextItems = options.maxContextItems || 20;
    this.ttl = options.ttl || 24 * 60 * 60 * 1000; // 24 hours
  }
  
  /**
   * Sets the current task being worked on.
   * 
   * @param {Object} task - The task object
   * @param {string} task.type - Task type (e.g., 'code-generation', 'analysis')
   * @param {string} task.objective - Task description
   * @param {Object} [task.metadata] - Additional task metadata
   * @throws {TypeError} If task is not an object
   */
  setCurrentTask(task) {
    if (!task || typeof task !== 'object') {
      throw new TypeError('task must be an object');
    }
    this.currentTask = task;
    this.touch();
  }
  
  /**
   * Clears the current task.
   */
  clearCurrentTask() {
    this.currentTask = null;
    this.touch();
  }
  
  /**
   * Adds an item to the context window.
   * Automatically prunes old items when maxContextItems is exceeded.
   * 
   * @param {Object} item - Item to add to context
   * @param {string} item.type - Type of context item
   * @param {Object} [item.data] - Item data
   * @throws {TypeError} If item is not an object
   */
  addToContext(item) {
    if (!item || typeof item !== 'object') {
      throw new TypeError('item must be an object');
    }
    
    this.contextWindow.push({
      ...item,
      timestamp: new Date().toISOString()
    });
    
    // Prune old items
    if (this.contextWindow.length > this.maxContextItems) {
      this.contextWindow.shift();
    }
    
    this.touch();
  }
  
  /**
   * Gets all items in the context window.
   * 
   * @returns {ContextItem[]} Array of context items
   */
  getContext() {
    return [...this.contextWindow];
  }
  
  /**
   * Gets the most recent n items from the context window.
   * 
   * @param {number} [n=5] - Number of items to retrieve
   * @returns {ContextItem[]} Array of recent context items
   * @throws {TypeError} If n is not a positive number
   */
  getRecentContext(n = 5) {
    if (typeof n !== 'number' || n < 1) {
      throw new TypeError('n must be a positive number');
    }
    return this.contextWindow.slice(-n);
  }
  
  /**
   * Sets the list of currently active tools.
   * 
   * @param {string[]} tools - Array of tool IDs
   * @throws {TypeError} If tools is not an array
   */
  setActiveTools(tools) {
    if (!Array.isArray(tools)) {
      throw new TypeError('tools must be an array');
    }
    this.activeTools = [...tools];
    this.touch();
  }
  
  /**
   * Adds a tool to the active tools list if not already present.
   * 
   * @param {string} toolId - Tool identifier to add
   * @throws {TypeError} If toolId is not a string
   */
  addActiveTool(toolId) {
    if (typeof toolId !== 'string') {
      throw new TypeError('toolId must be a string');
    }
    if (!this.activeTools.includes(toolId)) {
      this.activeTools.push(toolId);
      this.touch();
    }
  }
  
  /**
   * Stores an intermediate result during task execution.
   * 
   * @param {string} key - Unique key for the result
   * @param {any} value - Result value to store
   * @throws {TypeError} If key is not a string
   */
  setIntermediateResult(key, value) {
    if (typeof key !== 'string') {
      throw new TypeError('key must be a string');
    }
    this.intermediateResults.set(key, value);
    this.touch();
  }
  
  /**
   * Retrieves an intermediate result by key.
   * 
   * @param {string} key - Key to retrieve
   * @returns {any} The stored value or undefined
   * @throws {TypeError} If key is not a string
   */
  getIntermediateResult(key) {
    if (typeof key !== 'string') {
      throw new TypeError('key must be a string');
    }
    return this.intermediateResults.get(key);
  }
  
  /**
   * Checks if an intermediate result exists.
   * 
   * @param {string} key - Key to check
   * @returns {boolean} True if the key exists
   * @throws {TypeError} If key is not a string
   */
  hasIntermediateResult(key) {
    if (typeof key !== 'string') {
      throw new TypeError('key must be a string');
    }
    return this.intermediateResults.has(key);
  }
  
  /**
   * Adds a message to the conversation history and context window.
   * 
   * @param {'user'|'assistant'|'system'|'tool'} role - Message role
   * @param {string} content - Message content
   * @param {Object} [metadata={}] - Additional metadata
   * @throws {TypeError} If role is invalid or content is not a string
   */
  addMessage(role, content, metadata = {}) {
    const validRoles = ['user', 'assistant', 'system', 'tool'];
    if (!validRoles.includes(role)) {
      throw new TypeError(`role must be one of: ${validRoles.join(', ')}`);
    }
    if (typeof content !== 'string') {
      throw new TypeError('content must be a string');
    }
    if (metadata && typeof metadata !== 'object') {
      throw new TypeError('metadata must be an object');
    }
    
    const message = {
      id: randomUUID(),
      role,
      content,
      timestamp: new Date().toISOString(),
      ...metadata
    };
    
    this.conversationHistory.push(message);
    this.addToContext({ type: 'message', role, content });
    this.touch();
  }
  
  /**
   * Gets all messages in the conversation history.
   * 
   * @returns {Message[]} Array of messages
   */
  getMessages() {
    return [...this.conversationHistory];
  }

  /**
   * Resolves a value from working memory using dot-notation.
   * Searches intermediate results first, then well-known top-level fields.
   *
   * @param {string} key - Dot-notation key
   * @returns {any} Resolved value or undefined
   * @throws {TypeError} If key is not a string
   */
  get(key) {
    if (typeof key !== 'string') {
      throw new TypeError('key must be a string');
    }

    if (this.intermediateResults.has(key)) {
      return this.intermediateResults.get(key);
    }

    const segments = key.split('.').filter(Boolean);
    if (segments.length === 0) {
      return undefined;
    }

    let root;
    const [firstSegment, ...rest] = segments;

    if (firstSegment === 'currentTask') {
      root = this.currentTask;
    } else if (firstSegment === 'userPreferences') {
      root = this.userPreferences;
    } else if (firstSegment === 'tokenUsage') {
      root = this.tokenUsage;
    } else if (firstSegment === 'conversationHistory') {
      root = this.conversationHistory;
    } else if (firstSegment === 'contextWindow') {
      root = this.contextWindow;
    } else if (firstSegment === 'activeTools') {
      root = this.activeTools;
    } else if (firstSegment === 'sessionId') {
      root = this.sessionId;
    } else if (this.intermediateResults.has(firstSegment)) {
      root = this.intermediateResults.get(firstSegment);
    } else if (Object.prototype.hasOwnProperty.call(this.userPreferences, firstSegment)) {
      root = this.userPreferences[firstSegment];
    } else if (Object.prototype.hasOwnProperty.call(this.tokenUsage, firstSegment)) {
      root = this.tokenUsage[firstSegment];
    } else {
      root = this[firstSegment];
    }

    return rest.reduce((value, segment) => {
      if (value == null) {
        return undefined;
      }
      return value[segment];
    }, root);
  }
  
  /**
   * Adds token usage to the running totals.
   * 
   * @param {number} [input=0] - Input tokens consumed
   * @param {number} [output=0] - Output tokens generated
   * @throws {TypeError} If input or output are not numbers
   */
  addTokenUsage(input = 0, output = 0) {
    if (typeof input !== 'number' || input < 0) {
      throw new TypeError('input must be a non-negative number');
    }
    if (typeof output !== 'number' || output < 0) {
      throw new TypeError('output must be a non-negative number');
    }
    this.tokenUsage.input += input;
    this.tokenUsage.output += output;
    this.touch();
  }
  
  /**
   * Gets the current token usage totals.
   * 
   * @returns {TokenUsage} Copy of token usage object
   */
  getTokenUsage() {
    return { ...this.tokenUsage };
  }
  
  /**
   * Updates a user preference.
   * 
   * @param {string} key - Preference key
   * @param {any} value - Preference value
   * @throws {TypeError} If key is not a string
   */
  updatePreference(key, value) {
    if (typeof key !== 'string') {
      throw new TypeError('key must be a string');
    }
    this.userPreferences[key] = value;
    this.touch();
  }
  
  /**
   * Gets a user preference value.
   * 
   * @param {string} key - Preference key
   * @returns {any} Preference value or undefined
   * @throws {TypeError} If key is not a string
   */
  getPreference(key) {
    if (typeof key !== 'string') {
      throw new TypeError('key must be a string');
    }
    return this.userPreferences[key];
  }
  
  /**
   * Updates the last activity timestamp.
   * Called automatically by most methods.
   */
  touch() {
    this.lastActivity = new Date().toISOString();
  }
  
  /**
   * Checks if this working memory has expired based on TTL.
   * 
   * @returns {boolean} True if expired
   */
  isExpired() {
    const lastActivity = new Date(this.lastActivity).getTime();
    return Date.now() - lastActivity > this.ttl;
  }
  
  /**
   * Converts the working memory to a plain JSON object.
   * 
   * @returns {Object} Serializable representation
   */
  toJSON() {
    return {
      id: this.id,
      sessionId: this.sessionId,
      currentTask: this.currentTask,
      contextWindow: this.contextWindow,
      activeTools: this.activeTools,
      intermediateResults: Object.fromEntries(this.intermediateResults),
      userPreferences: this.userPreferences,
      conversationHistory: this.conversationHistory,
      tokenUsage: this.tokenUsage,
      startTime: this.startTime,
      lastActivity: this.lastActivity
    };
  }
  
  /**
   * Creates a WorkingMemory instance from a JSON object.
   * 
   * @param {Object} json - Serialized working memory
   * @param {string} json.sessionId - Session identifier
   * @param {string} json.id - Memory instance ID
   * @param {Object} [json.currentTask] - Current task
   * @param {Array} [json.contextWindow] - Context window items
   * @param {Array} [json.activeTools] - Active tool IDs
   * @param {Object} [json.intermediateResults] - Intermediate results map
   * @param {Object} [json.userPreferences] - User preferences
   * @param {Array} [json.conversationHistory] - Message history
   * @param {Object} [json.tokenUsage] - Token usage stats
   * @param {string} json.startTime - Session start time
   * @param {string} json.lastActivity - Last activity timestamp
   * @returns {WorkingMemory} Reconstructed WorkingMemory instance
   * @throws {Error} If json or sessionId is missing
   */
  static fromJSON(json) {
    if (!json || typeof json !== 'object') {
      throw new Error('Invalid JSON object provided');
    }
    if (!json.sessionId) {
      throw new Error('sessionId is required in JSON');
    }
    
    const wm = new WorkingMemory(json.sessionId);
    Object.assign(wm, json);
    wm.intermediateResults = new Map(Object.entries(json.intermediateResults || {}));
    return wm;
  }
}

module.exports = { WorkingMemory };
