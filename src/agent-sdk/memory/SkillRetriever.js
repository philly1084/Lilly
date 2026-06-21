const { SkillMemory } = require('./SkillMemory');

/**
 * @typedef {Object} Task
 * @property {string} id - Task ID
 * @property {string} objective - Task objective/description
 * @property {string} type - Task type
 * @property {Object} [input] - Task input
 * @property {any} [input.content] - Input content
 */

/**
 * @typedef {Object} FormattedSkill
 * @property {string} id - Skill ID
 * @property {string} name - Skill name
 * @property {string} description - Skill description
 * @property {string[]} toolPreferences - Preferred tools
 * @property {Object} parameterTemplates - Parameter templates
 * @property {Object} [example] - Example execution (if includeExamples was true)
 * @property {any} [example.input] - Example input
 * @property {Array<{type: string}>} [example.steps] - Example steps
 */

/**
 * @typedef {Object} RetrievalOptions
 * @property {number} [maxSkills=3] - Maximum number of skills to retrieve
 * @property {number} [minRelevance=0.7] - Minimum semantic relevance score
 * @property {boolean} [includeExamples=true] - Whether to include success examples
 */

/**
 * @interface Embedder
 * @method embed(text: string): Promise<number[]> - Generates vector embedding for text
 */

/**
 * @interface SkillMemoryInterface
 * @method search(query: string, embedding: number[], options: Object): Promise<Skill[]>
 * @method findByTrigger(query: string, limit: number): Promise<Skill[]>
 */

/**
 * Retrieves relevant skills for new tasks using semantic search
 * and trigger pattern matching. Combines both approaches for
 * comprehensive skill discovery.
 * 
 * @class SkillRetriever
 * @example
 * const retriever = new SkillRetriever(skillMemory, embedder);
 * const skills = await retriever.retrieveForTask(newTask, { maxSkills: 5 });
 * const promptContext = retriever.formatForPrompt(skills);
 */
class SkillRetriever {
  /**
   * Creates a new SkillRetriever instance.
   * 
   * @param {SkillMemoryInterface} skillMemory - Skill memory storage
   * @param {Embedder} embedder - Embedding provider
   * @throws {Error} If required dependencies are missing
   */
  constructor(skillMemory, embedder) {
    if (!skillMemory) {
      throw new Error('skillMemory is required');
    }
    if (!embedder) {
      throw new Error('embedder is required');
    }
    if (typeof embedder.embed !== 'function') {
      throw new Error('embedder must implement embed method');
    }
    if (typeof skillMemory.search !== 'function') {
      throw new Error('skillMemory must implement search method');
    }
    if (typeof skillMemory.findByTrigger !== 'function') {
      throw new Error('skillMemory must implement findByTrigger method');
    }
    
    this.skillMemory = skillMemory;
    this.embedder = embedder;
  }
  
  /**
   * Retrieves relevant skills for a task using combined semantic and pattern matching.
   * 
   * @param {Task} task - The task to find skills for
   * @param {RetrievalOptions} [options={}] - Retrieval options
   * @returns {Promise<FormattedSkill[]>} Array of relevant skills formatted for use
   * @throws {TypeError} If task is invalid
   * @throws {Error} If embedding or search fails
   */
  async retrieveForTask(task, options = {}) {
    if (!task || typeof task !== 'object') {
      throw new TypeError('task must be an object');
    }
    if (!task.objective || typeof task.objective !== 'string') {
      throw new TypeError('task.objective must be a string');
    }
    
    const {
      maxSkills = 3,
      minRelevance = 0.7,
      includeExamples = true
    } = options;
    
    try {
      // Create query from task
      const query = `${task.objective} ${task.type || ''} ${task.input?.content || ''}`.trim();
      
      // Get embedding
      const embedding = await this.embedder.embed(query);
      
      if (!Array.isArray(embedding)) {
        throw new Error('Embedder must return an array');
      }
      
      // Search by semantic similarity
      const semanticMatches = await this.skillMemory.search(
        query,
        embedding,
        { limit: maxSkills, minScore: minRelevance }
      );
      
      // Search by trigger patterns
      const patternMatches = await this.skillMemory.findByTrigger(
        query,
        maxSkills
      );
      
      // Combine and deduplicate
      const combined = [...semanticMatches];
      for (const skill of patternMatches) {
        if (!combined.find(s => s.id === skill.id)) {
          combined.push(skill);
        }
      }
      
      // Sort by relevance score (success rate)
      combined.sort((a, b) => b.successRate - a.successRate);
      
      // Format for LLM context
      return combined.slice(0, maxSkills).map(skill => this.formatSkill(skill, includeExamples));
    } catch (error) {
      throw new Error(`Failed to retrieve skills: ${error.message}`);
    }
  }
  
  /**
   * Formats a skill for LLM context inclusion.
   * 
   * @private
   * @param {import('./SkillMemory').Skill} skill - Skill to format
   * @param {boolean} includeExamples - Whether to include examples
   * @returns {FormattedSkill} Formatted skill
   */
  formatSkill(skill, includeExamples) {
    const formatted = {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      toolPreferences: skill.toolPreferences,
      parameterTemplates: skill.parameterTemplates
    };
    
    if (includeExamples && skill.successExamples && skill.successExamples[0]) {
      formatted.example = {
        input: skill.successExamples[0].input,
        steps: skill.successExamples[0].steps
      };
    }
    
    return formatted;
  }
  
  /**
   * Formats retrieved skills as a string for prompt injection.
   * 
   * @param {FormattedSkill[]} skills - Skills to format
   * @returns {string} Formatted prompt string
   */
  formatForPrompt(skills) {
    if (!Array.isArray(skills)) {
      throw new TypeError('skills must be an array');
    }
    
    if (skills.length === 0) return '';
    
    const lines = ['### Relevant Skills from Previous Tasks\n'];
    
    for (const skill of skills) {
      lines.push(`**${skill.name}**`);
      if (skill.id) {
        lines.push(`Skill ID: ${skill.id}`);
      }
      lines.push(`Description: ${skill.description}`);
      
      if (skill.toolPreferences && skill.toolPreferences.length > 0) {
        lines.push(`Recommended tools: ${skill.toolPreferences.join(', ')}`);
      }
      
      if (skill.example && skill.example.steps && skill.example.steps.length > 0) {
        const stepTypes = skill.example.steps.map(s => s.type);
        lines.push(`Example approach: ${stepTypes.join(' -> ')}`);
      }
      
      lines.push('');
    }
    
    return lines.join('\n');
  }
  
  /**
   * Retrieves and formats skills in one operation for convenience.
   * 
   * @param {Task} task - The task to find skills for
   * @param {RetrievalOptions & {formatForPrompt?: boolean}} [options={}] - Options
   * @returns {Promise<FormattedSkill[]|string>} Skills or formatted string
   * @throws {TypeError} If task is invalid
   * @throws {Error} If retrieval fails
   */
  async retrieveAndFormat(task, options = {}) {
    const { formatForPrompt: shouldFormat = false, ...retrievalOptions } = options;
    
    const skills = await this.retrieveForTask(task, retrievalOptions);
    
    if (shouldFormat) {
      return this.formatForPrompt(skills);
    }
    
    return skills;
  }
  
  /**
   * Performs a batch retrieval for multiple tasks.
   * Useful for preloading skills or analyzing task similarity.
   * 
   * @param {Task[]} tasks - Array of tasks
   * @param {RetrievalOptions} [options={}] - Retrieval options
   * @returns {Promise<Map<string, FormattedSkill[]>>} Map of task ID to skills
   * @throws {TypeError} If tasks is not an array
   */
  async retrieveForTasks(tasks, options = {}) {
    if (!Array.isArray(tasks)) {
      throw new TypeError('tasks must be an array');
    }
    
    const results = new Map();
    
    for (const task of tasks) {
      if (!task.id) {
        console.warn('Skipping task without ID in batch retrieval');
        continue;
      }
      
      try {
        const skills = await this.retrieveForTask(task, options);
        results.set(task.id, skills);
      } catch (error) {
        console.warn(`Failed to retrieve skills for task ${task.id}: ${error.message}`);
        results.set(task.id, []);
      }
    }
    
    return results;
  }
  
  /**
   * Gets statistics about retrieved skills for a task.
   * Useful for debugging and optimization.
   * 
   * @param {FormattedSkill[]} skills - Retrieved skills
   * @returns {{total: number, hasExamples: number, uniqueTools: string[]}} Statistics
   */
  getRetrievalStats(skills) {
    if (!Array.isArray(skills)) {
      throw new TypeError('skills must be an array');
    }
    
    const uniqueTools = new Set();
    let hasExamplesCount = 0;
    
    for (const skill of skills) {
      if (skill.toolPreferences) {
        skill.toolPreferences.forEach(t => uniqueTools.add(t));
      }
      if (skill.example) {
        hasExamplesCount++;
      }
    }
    
    return {
      total: skills.length,
      hasExamples: hasExamplesCount,
      uniqueTools: Array.from(uniqueTools)
    };
  }
}

module.exports = { SkillRetriever };
