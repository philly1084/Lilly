const { randomUUID } = require('crypto');

/**
 * @typedef {Object} SuccessExample
 * @property {any} input - Example input
 * @property {any} output - Example output
 * @property {Array<{type: string, description: string}>} steps - Steps taken
 */

/**
 * @typedef {Object} SkillMetadata
 * @property {number[]} [embedding] - Vector embedding for semantic search
 * @property {string[]} [tags=[]] - Skill tags
 * @property {string} [category='general'] - Skill category
 * @property {string} [difficulty='intermediate'] - Skill difficulty level
 */

/**
 * @typedef {Object} SkillOptions
 * @property {string} [id] - Unique skill ID (auto-generated if not provided)
 * @property {string} name - Skill name
 * @property {string} description - Skill description
 * @property {string[]} [triggerPatterns=[]] - Keywords/patterns that trigger this skill
 * @property {SuccessExample[]} [successExamples=[]] - Examples of successful executions
 * @property {string[]} [toolPreferences=[]] - Preferred tools for this skill
 * @property {Object} [parameterTemplates={}] - Reusable parameter templates
 * @property {string} [createdFrom] - ID of task this skill was created from
 * @property {SkillMetadata} [metadata={}] - Additional metadata
 */

/**
 * @typedef {Object} VectorPoint
 * @property {string} id - Point ID
 * @property {number[]} vector - Vector embedding
 * @property {Object} payload - Associated data
 */

/**
 * @typedef {Object} SearchOptions
 * @property {number} [limit=5] - Maximum results to return
 * @property {number} [minScore=0.7] - Minimum similarity score
 * @property {string} [category] - Filter by category
 */

/**
 * @typedef {Object} CacheEntry
 * @property {Skill} skill - Cached skill
 * @property {number} timestamp - Cache timestamp
 */

/**
 * Represents a learned skill extracted from successful task executions.
 * Contains trigger patterns, tool preferences, and success examples.
 * 
 * @class Skill
 * @example
 * const skill = new Skill({
 *   name: 'Generate API Endpoint',
 *   description: 'Creates REST API endpoints with proper error handling',
 *   triggerPatterns: ['api', 'endpoint', 'rest'],
 *   toolPreferences: ['code-writer', 'linter'],
 *   metadata: { category: 'coding', difficulty: 'intermediate' }
 * });
 */
class Skill {
  /**
   * Creates a new Skill instance.
   * 
   * @param {SkillOptions} options - Skill configuration
   * @throws {Error} If name or description is missing
   */
  constructor({
    id,
    name,
    description,
    triggerPatterns = [],
    successExamples = [],
    toolPreferences = [],
    parameterTemplates = {},
    createdFrom,
    metadata = {}
  }) {
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a string');
    }
    if (!description || typeof description !== 'string') {
      throw new Error('description is required and must be a string');
    }
    if (!Array.isArray(triggerPatterns)) {
      throw new TypeError('triggerPatterns must be an array');
    }
    if (!Array.isArray(successExamples)) {
      throw new TypeError('successExamples must be an array');
    }
    if (!Array.isArray(toolPreferences)) {
      throw new TypeError('toolPreferences must be an array');
    }
    if (parameterTemplates && typeof parameterTemplates !== 'object') {
      throw new TypeError('parameterTemplates must be an object');
    }
    if (metadata && typeof metadata !== 'object') {
      throw new TypeError('metadata must be an object');
    }

    this.id = id || randomUUID();
    this.name = name;
    this.description = description;
    this.triggerPatterns = triggerPatterns;
    this.successExamples = successExamples;
    this.toolPreferences = toolPreferences;
    this.parameterTemplates = parameterTemplates;
    this.createdFrom = createdFrom;
    
    // Stats
    this.usageCount = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.createdAt = new Date().toISOString();
    this.lastUsed = null;
    
    // Vector embedding (for semantic search)
    this.embedding = metadata.embedding || null;
    
    // Additional metadata
    this.tags = metadata.tags || [];
    this.category = metadata.category || 'general';
    this.difficulty = metadata.difficulty || 'intermediate';
  }
  
  /**
   * Gets the success rate of this skill.
   * 
   * @returns {number} Success rate between 0 and 1
   */
  get successRate() {
    const total = this.successCount + this.failureCount;
    return total > 0 ? this.successCount / total : 0;
  }
  
  /**
   * Records a usage of this skill.
   * 
   * @param {boolean} [success=true] - Whether the execution was successful
   */
  recordUsage(success = true) {
    this.usageCount++;
    if (success) {
      this.successCount++;
    } else {
      this.failureCount++;
    }
    this.lastUsed = new Date().toISOString();
  }
  
  /**
   * Checks if the query matches any trigger patterns.
   * Performs case-insensitive partial matching.
   * 
   * @param {string} query - Query string to check
   * @returns {boolean} True if any pattern matches
   * @throws {TypeError} If query is not a string
   */
  matchesTrigger(query) {
    if (typeof query !== 'string') {
      throw new TypeError('query must be a string');
    }
    const queryLower = query.toLowerCase();
    return this.triggerPatterns.some(pattern => 
      queryLower.includes(pattern.toLowerCase())
    );
  }
  
  /**
   * Converts the skill to a plain JSON object.
   * 
   * @returns {Object} Serializable representation including computed successRate
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      triggerPatterns: this.triggerPatterns,
      successExamples: this.successExamples,
      toolPreferences: this.toolPreferences,
      parameterTemplates: this.parameterTemplates,
      createdFrom: this.createdFrom,
      usageCount: this.usageCount,
      successCount: this.successCount,
      failureCount: this.failureCount,
      successRate: this.successRate,
      createdAt: this.createdAt,
      lastUsed: this.lastUsed,
      embedding: this.embedding,
      tags: this.tags,
      category: this.category,
      difficulty: this.difficulty
    };
  }
}

/**
 * Long-term storage for learned skills using vector search with caching.
 * Requires a vector store implementation (e.g., Qdrant, Pinecone).
 * 
 * @class SkillMemory
 * @example
 * const skillMemory = new SkillMemory(vectorStore);
 * await skillMemory.store(new Skill({ name: 'Parse JSON', ... }));
 * const skills = await skillMemory.search(query, embedding);
 */
class SkillMemory {
  /**
   * Creates a new SkillMemory instance.
   * 
   * @param {Object} vectorStore - Vector store client with upsert, retrieve, search, scroll, delete methods
   * @throws {Error} If vectorStore is not provided or missing required methods
   */
  constructor(vectorStore) {
    if (!vectorStore) {
      throw new Error('vectorStore is required');
    }
    
    // Validate required methods
    const requiredMethods = ['upsert', 'retrieve', 'search', 'scroll', 'delete'];
    for (const method of requiredMethods) {
      if (typeof vectorStore[method] !== 'function') {
        throw new Error(`vectorStore must implement ${method} method`);
      }
    }
    
    this.vectorStore = vectorStore;
    
    /** @type {Map<string, CacheEntry>} */
    this.cache = new Map();
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes
  }
  
  /**
   * Stores a skill in the vector database with caching.
   * 
   * @param {Skill} skill - Skill to store
   * @returns {Promise<Skill>} The stored skill
   * @throws {TypeError} If skill is not a Skill instance
   * @throws {Error} If vector store operation fails
   */
  async store(skill) {
    if (!(skill instanceof Skill)) {
      throw new TypeError('skill must be a Skill instance');
    }
    
    try {
      // Store in vector DB with embedding
      const point = {
        id: skill.id,
        vector: skill.embedding,
        payload: skill.toJSON()
      };
      
      await this.vectorStore.upsert('skills', [point]);
      
      // Update cache
      this.cache.set(skill.id, {
        skill,
        timestamp: Date.now()
      });
      
      return skill;
    } catch (error) {
      throw new Error(`Failed to store skill: ${error.message}`);
    }
  }
  
  /**
   * Retrieves a skill by ID, checking cache first.
   * 
   * @param {string} skillId - Skill ID to retrieve
   * @returns {Promise<Skill|null>} The skill or null if not found
   * @throws {TypeError} If skillId is not a string
   * @throws {Error} If retrieval fails
   */
  async retrieve(skillId) {
    if (typeof skillId !== 'string') {
      throw new TypeError('skillId must be a string');
    }
    
    try {
      // Check cache first
      const cached = this.cache.get(skillId);
      if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
        return cached.skill;
      }
      
      // Fetch from vector store
      const result = await this.vectorStore.retrieve('skills', skillId);
      if (!result) return null;
      
      const skill = new Skill(result.payload);
      
      // Update cache
      this.cache.set(skillId, {
        skill,
        timestamp: Date.now()
      });
      
      return skill;
    } catch (error) {
      throw new Error(`Failed to retrieve skill: ${error.message}`);
    }
  }
  
  /**
   * Searches for skills by semantic similarity.
   * 
   * @param {string} query - Original query text
   * @param {number[]} embedding - Vector embedding of the query
   * @param {SearchOptions} [options={}] - Search options
   * @returns {Promise<Skill[]>} Array of matching skills
   * @throws {TypeError} If embedding is not an array
   * @throws {Error} If search fails
   */
  async search(query, embedding, options = {}) {
    if (!Array.isArray(embedding)) {
      throw new TypeError('embedding must be an array');
    }
    
    const {
      limit = 5,
      minScore = 0.7,
      category = null
    } = options;
    
    try {
      // Search by vector similarity
      const results = await this.vectorStore.search('skills', {
        vector: embedding,
        limit,
        score_threshold: minScore
      });
      
      // Filter by category if specified
      let skills = results.map(r => new Skill(r.payload));
      if (category) {
        skills = skills.filter(s => s.category === category);
      }
      
      return skills;
    } catch (error) {
      throw new Error(`Failed to search skills: ${error.message}`);
    }
  }
  
  /**
   * Finds skills by trigger pattern matching.
   * Results are sorted by success rate and usage count.
   * 
   * @param {string} query - Query to match against trigger patterns
   * @param {number} [limit=3] - Maximum number of results
   * @returns {Promise<Skill[]>} Array of matching skills
   * @throws {TypeError} If query is not a string
   * @throws {Error} If operation fails
   */
  async findByTrigger(query, limit = 3) {
    if (typeof query !== 'string') {
      throw new TypeError('query must be a string');
    }
    
    try {
      // Search by trigger pattern matching
      const allSkills = await this.getAll();
      const matching = allSkills.filter(s => s.matchesTrigger(query));
      
      // Sort by success rate and usage
      matching.sort((a, b) => {
        const scoreA = a.successRate * Math.log(a.usageCount + 1);
        const scoreB = b.successRate * Math.log(b.usageCount + 1);
        return scoreB - scoreA;
      });
      
      return matching.slice(0, limit);
    } catch (error) {
      throw new Error(`Failed to find skills by trigger: ${error.message}`);
    }
  }
  
  /**
   * Gets all skills from the vector store.
   * Note: This may be expensive for large collections.
   * 
   * @returns {Promise<Skill[]>} Array of all skills
   * @throws {Error} If operation fails
   */
  async getAll() {
    try {
      const results = await this.vectorStore.scroll('skills');
      return results.map(r => new Skill(r.payload));
    } catch (error) {
      throw new Error(`Failed to get all skills: ${error.message}`);
    }
  }
  
  /**
   * Deletes a skill from storage and cache.
   * 
   * @param {string} skillId - Skill ID to delete
   * @returns {Promise<void>}
   * @throws {TypeError} If skillId is not a string
   * @throws {Error} If deletion fails
   */
  async delete(skillId) {
    if (typeof skillId !== 'string') {
      throw new TypeError('skillId must be a string');
    }
    
    try {
      await this.vectorStore.delete('skills', [skillId]);
      this.cache.delete(skillId);
    } catch (error) {
      throw new Error(`Failed to delete skill: ${error.message}`);
    }
  }
  
  /**
   * Clears the in-memory cache.
   */
  clearCache() {
    this.cache.clear();
  }
  
  /**
   * Gets cache statistics for monitoring.
   * 
   * @returns {{size: number, entries: string[]}} Cache statistics
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys())
    };
  }

  async count() {
    const results = await this.vectorStore.scroll('skills', { limit: 1000 });
    return results.length;
  }

  getStats() {
    return {
      total: this.cache.size,
      cached: this.cache.size,
      cacheTTL: this.cacheTTL,
    };
  }
}

module.exports = { Skill, SkillMemory };
