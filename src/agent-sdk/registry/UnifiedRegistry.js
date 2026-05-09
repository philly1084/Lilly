/**
 * UnifiedRegistry - Single Source of Truth for Tools, Skills, and Frontend Manifests
 * 
 * When a tool is registered here:
 * - Backend gets the tool implementation
 * - Admin dashboard sees it as a skill
 * - Frontends can discover and invoke it
 */

const EventEmitter = require('events');
const {
  evaluateToolReadiness,
  summarizeToolReadiness,
} = require('../../orchestration/tool-readiness');

class UnifiedRegistry extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    
    // Backend implementations
    this.tools = new Map();
    
    // Skill wrappers for admin
    this.skills = new Map();
    
    // Frontend manifests
    this.manifests = new Map();
    
    // Agent assignments
    this.agentAssignments = new Map();
    
    // Usage statistics
    this.stats = new Map();

    // Executability/readiness state
    this.readiness = new Map();

    this.maxUsageHistory = 25;
    
    // Categories
    this.categories = new Set(['web', 'ssh', 'design', 'sandbox', 'database', 'system']);
  }

  createEmptyStats() {
    return {
      invocations: 0,
      successes: 0,
      failures: 0,
      avgDuration: 0,
      lastUsed: null,
      byRoute: {},
      byModel: {},
      byExecutionProfile: {},
      recentUsage: [],
    };
  }

  incrementStatBucket(target, key) {
    const normalized = String(key || '').trim();
    if (!normalized) {
      return;
    }

    target[normalized] = (target[normalized] || 0) + 1;
  }

  buildUsageEntry(id, result = {}, context = {}) {
    return {
      toolId: id,
      timestamp: result.timestamp || new Date().toISOString(),
      success: result.success !== false,
      duration: Number(result.duration || 0),
      sessionId: context.sessionId || null,
      route: context.route || null,
      transport: context.transport || null,
      executionProfile: context.executionProfile || null,
      model: context.model || null,
      userId: context.userId || null,
      paramKeys: Object.keys(context.params || {}).sort(),
      error: result.success === false ? (result.error || 'Unknown error') : null,
    };
  }

  serializeStats(stats = {}) {
    const invocations = Number(stats.invocations || 0);
    const successes = Number(stats.successes || 0);
    const failures = Number(stats.failures || 0);
    const avgDuration = Number(stats.avgDuration || 0);
    const recentUsage = Array.isArray(stats.recentUsage) ? stats.recentUsage : [];

    return {
      invocations,
      usageCount: invocations,
      successes,
      failures,
      successRate: invocations > 0 ? Math.round((successes / invocations) * 100) : 100,
      avgDuration,
      lastUsed: stats.lastUsed || null,
      byRoute: { ...(stats.byRoute || {}) },
      byModel: { ...(stats.byModel || {}) },
      byExecutionProfile: { ...(stats.byExecutionProfile || {}) },
      recentUsage,
    };
  }

  /**
   * Register a tool - single registration propagates to all layers
   */
  register(toolDefinition) {
    // Validate definition
    this.validateToolDefinition(toolDefinition);
    
    const { id, category = 'system' } = toolDefinition;
    
    // 1. Register backend tool
    this.tools.set(id, {
      ...toolDefinition,
      registeredAt: new Date().toISOString()
    });
    
    // 2. Auto-generate skill
    const skill = this.generateSkill(toolDefinition);
    this.skills.set(id, skill);
    
    // 3. Generate frontend manifest
    const manifest = this.generateManifest(toolDefinition);
    this.manifests.set(id, manifest);
    
    // 4. Initialize stats
    this.stats.set(id, this.createEmptyStats());

    // 4b. Initialize readiness from the registered definition. ToolManager can
    // later refresh this with the loaded executable instance.
    this.readiness.set(id, evaluateToolReadiness(id, {
      ...toolDefinition,
      execute: toolDefinition.execute,
    }, {
      skill,
      previous: this.readiness.get(id),
    }));
    
    // 5. Add to category
    this.categories.add(category);
    
    // 6. Emit registration event
    this.emit('tool:registered', {
      id,
      tool: toolDefinition,
      skill,
      manifest,
      timestamp: new Date().toISOString()
    });
    
    console.log(`[UnifiedRegistry] Registered tool: ${id} (${category})`);
    
    return { id, skill, manifest };
  }

  /**
   * Unregister a tool
   */
  unregister(id) {
    const existed = this.tools.has(id);
    
    this.tools.delete(id);
    this.skills.delete(id);
    this.manifests.delete(id);
    this.stats.delete(id);
    
    if (existed) {
      this.emit('tool:unregistered', { id, timestamp: new Date().toISOString() });
      console.log(`[UnifiedRegistry] Unregistered tool: ${id}`);
    }
    
    return existed;
  }

  /**
   * Get backend tool implementation
   */
  getTool(id) {
    return this.tools.get(id);
  }

  /**
   * Get all tools
   */
  getAllTools() {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools by category
   */
  getToolsByCategory(category) {
    return Array.from(this.tools.values())
      .filter(tool => tool.category === category);
  }

  /**
   * Get skill for admin dashboard
   */
  getSkill(id) {
    return this.skills.get(id);
  }

  /**
   * Get all skills (for admin)
   */
  getAllSkills() {
    return Array.from(this.skills.values())
      .map(skill => {
        const stats = this.getStats(skill.id);
        return {
          ...skill,
          usageCount: stats.usageCount,
          successRate: stats.successRate,
          avgDuration: stats.avgDuration,
          lastUsed: stats.lastUsed,
          stats,
        };
      });
  }

  /**
   * Get skills by category
   */
  getSkillsByCategory(category) {
    return this.getAllSkills()
      .filter(skill => skill.category === category);
  }

  /**
   * Get frontend manifest
   */
  getManifest(id) {
    return this.manifests.get(id);
  }

  /**
   * Get all frontend-exposed tools
   */
  getFrontendTools() {
    return Array.from(this.manifests.values())
      .filter(manifest => manifest.exposeToFrontend)
      .map(manifest => ({
        ...manifest,
        isAvailable: this.isToolAvailable(manifest.id),
        readiness: summarizeToolReadiness(this.getToolReadiness(manifest.id)),
      }));
  }

  /**
   * Get all registered frontend manifests, including tools hidden from end-user surfaces.
   */
  getAllManifests() {
    return Array.from(this.manifests.values())
      .map((manifest) => ({
        ...manifest,
        isAvailable: this.isToolAvailable(manifest.id),
        readiness: summarizeToolReadiness(this.getToolReadiness(manifest.id)),
      }));
  }

  /**
   * Get frontend tools by category
   */
  getFrontendToolsByCategory(category) {
    return this.getFrontendTools()
      .filter(tool => tool.category === category);
  }

  /**
   * Check if tool is available (not disabled)
   */
  isToolAvailable(id) {
    const skill = this.skills.get(id);
    const readiness = this.getToolReadiness(id);
    return Boolean(skill && skill.enabled !== false && readiness.status !== 'unavailable');
  }

  setToolReadiness(id, readiness = {}) {
    const tool = this.tools.get(id);
    const skill = this.skills.get(id);
    const next = evaluateToolReadiness(id, tool, {
      skill,
      previous: this.readiness.get(id),
      probe: readiness,
    });
    this.readiness.set(id, next);
    this.emit('tool:readiness', { id, readiness: next, timestamp: new Date().toISOString() });
    return next;
  }

  refreshToolReadiness(id, tool = null, probe = null) {
    const skill = this.skills.get(id);
    const next = evaluateToolReadiness(id, tool || this.tools.get(id), {
      skill,
      previous: this.readiness.get(id),
      probe,
    });
    this.readiness.set(id, next);
    return next;
  }

  getToolReadiness(id) {
    if (!this.readiness.has(id)) {
      return this.refreshToolReadiness(id);
    }
    return this.readiness.get(id);
  }

  getAllToolReadiness() {
    return Array.from(this.tools.keys())
      .map((id) => summarizeToolReadiness(this.getToolReadiness(id)));
  }

  /**
   * Enable/disable skill
   */
  setSkillEnabled(id, enabled) {
    const skill = this.skills.get(id);
    if (skill) {
      skill.enabled = enabled;
      skill.updatedAt = new Date().toISOString();
      
      this.emit('skill:updated', { id, skill, timestamp: new Date().toISOString() });
      return true;
    }
    return false;
  }

  /**
   * Update skill configuration
   */
  updateSkillConfig(id, config) {
    const skill = this.skills.get(id);
    if (skill) {
      Object.assign(skill, config, { updatedAt: new Date().toISOString() });
      this.emit('skill:updated', { id, skill, timestamp: new Date().toISOString() });
      return skill;
    }
    return null;
  }

  /**
   * Record tool invocation
   */
  recordInvocation(id, result, context = {}) {
    const stats = this.stats.get(id);
    if (stats) {
      stats.invocations++;
      stats.lastUsed = new Date().toISOString();
      
      if (result.success) {
        stats.successes++;
      } else {
        stats.failures++;
      }
      
      // Update average duration
      if (result.duration) {
        const total = stats.invocations;
        stats.avgDuration = ((stats.avgDuration * (total - 1)) + result.duration) / total;
      }

      this.incrementStatBucket(stats.byRoute, context.route || 'unknown');
      this.incrementStatBucket(stats.byModel, context.model || 'unknown');
      this.incrementStatBucket(stats.byExecutionProfile, context.executionProfile || 'default');

      const usageEntry = this.buildUsageEntry(id, result, context);
      stats.recentUsage = [
        usageEntry,
        ...(Array.isArray(stats.recentUsage) ? stats.recentUsage : []),
      ].slice(0, this.maxUsageHistory);

      const serialized = this.serializeStats(stats);
      this.emit('stats:updated', { id, stats: serialized, timestamp: usageEntry.timestamp });
      this.emit('invocation:recorded', { id, entry: usageEntry, stats: serialized });
    }
  }

  /**
   * Get tool statistics
   */
  getStats(id) {
    return this.serializeStats(this.stats.get(id) || this.createEmptyStats());
  }

  /**
   * Get all categories
   */
  getCategories() {
    return Array.from(this.categories);
  }

  /**
   * Search tools/skills
   */
  search(query) {
    const searchLower = query.toLowerCase();
    
    const matchingTools = Array.from(this.tools.values())
      .filter(tool => 
        tool.id.toLowerCase().includes(searchLower) ||
        tool.name?.toLowerCase().includes(searchLower) ||
        tool.description?.toLowerCase().includes(searchLower)
      );
    
    const matchingSkills = Array.from(this.skills.values())
      .filter(skill => 
        skill.triggerPatterns?.some(p => p.toLowerCase().includes(searchLower))
      );
    
    return {
      tools: matchingTools,
      skills: matchingSkills
    };
  }

  normalizeTriggerPattern(pattern) {
    return String(pattern || '')
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ');
  }

  deriveTriggerPatterns(toolDef = {}) {
    const explicitPatterns = Array.isArray(toolDef.skill?.triggerPatterns)
      ? toolDef.skill.triggerPatterns
      : [];

    const derivedPatterns = [
      toolDef.name,
      toolDef.id,
      toolDef.id ? toolDef.id.replace(/[-_]+/g, ' ') : '',
    ];

    return Array.from(new Set(
      [...explicitPatterns, ...derivedPatterns]
        .map((pattern) => this.normalizeTriggerPattern(pattern))
        .filter(Boolean),
    ));
  }

  inferRequiresConfirmation(toolDef = {}) {
    if (typeof toolDef.skill?.requiresConfirmation === 'boolean') {
      return toolDef.skill.requiresConfirmation;
    }

    const sideEffects = new Set(
      Array.isArray(toolDef.backend?.sideEffects)
        ? toolDef.backend.sideEffects.map((effect) => String(effect || '').toLowerCase())
        : [],
    );
    const category = String(toolDef.category || '').toLowerCase();

    return sideEffects.has('write')
      || sideEffects.has('execute')
      || category === 'ssh'
      || category === 'database';
  }

  /**
   * Generate skill from tool definition
   */
  generateSkill(toolDef) {
    return {
      id: toolDef.id,
      name: toolDef.name || toolDef.id,
      description: toolDef.description || '',
      category: toolDef.category || 'system',
      version: toolDef.version || '1.0.0',
      
      // Skill-specific properties
      triggerPatterns: this.deriveTriggerPatterns(toolDef),
      
      autoApply: toolDef.skill?.autoApply === true,
      requiresConfirmation: this.inferRequiresConfirmation(toolDef),
      confidenceThreshold: Number.isFinite(toolDef.skill?.confidenceThreshold)
        ? toolDef.skill.confidenceThreshold
        : 0.7,
      
      // Tool reference
      toolId: toolDef.id,
      
      // Status
      enabled: true,
      isLearned: false, // Built-in skills are not "learned"
      
      // Metadata
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      
      // Usage stats (populated dynamically)
      usageCount: 0,
      successRate: 100
    };
  }

  /**
   * Generate frontend manifest from tool definition
   */
  generateManifest(toolDef) {
    return {
      id: toolDef.id,
      name: toolDef.name || toolDef.id,
      description: toolDef.description || '',
      category: toolDef.category || 'system',
      version: toolDef.version || '1.0.0',
      
      // Frontend-specific
      exposeToFrontend: toolDef.frontend?.exposeToFrontend !== false,
      icon: toolDef.frontend?.icon || 'tool',
      uiComponent: toolDef.frontend?.uiComponent || null,
      parameters: toolDef.frontend?.parameters || this.inferParameters(toolDef),
      shortcuts: toolDef.frontend?.shortcuts || [],
      
      // Requirements
      requiresSetup: toolDef.frontend?.requiresSetup || false,
      requiredPermissions: toolDef.frontend?.requiredPermissions || [],
      
      // Schema references
      inputSchema: toolDef.inputSchema,
      outputSchema: toolDef.outputSchema
    };
  }

  /**
   * Infer parameters from input schema
   */
  inferParameters(toolDef) {
    if (!toolDef.inputSchema || !toolDef.inputSchema.properties) {
      return [];
    }
    
    return Object.entries(toolDef.inputSchema.properties).map(([name, schema]) => ({
      name,
      type: schema.type || 'string',
      required: toolDef.inputSchema.required?.includes(name) || false,
      description: schema.description || '',
      default: schema.default
    }));
  }

  /**
   * Validate tool definition
   */
  validateToolDefinition(def) {
    if (!def.id) {
      throw new Error('Tool definition must have an id');
    }
    
    if (!def.backend?.handler) {
      throw new Error(`Tool ${def.id} must have a backend handler`);
    }
    
    if (typeof def.backend.handler !== 'function') {
      throw new Error(`Tool ${def.id} handler must be a function`);
    }
    
    return true;
  }

  /**
   * Export registry state
   */
  export() {
    return {
      tools: Array.from(this.tools.entries()),
      skills: Array.from(this.skills.entries()),
      manifests: Array.from(this.manifests.entries()),
      stats: Array.from(this.stats.entries()),
      readiness: Array.from(this.readiness.entries()),
      categories: Array.from(this.categories),
      exportedAt: new Date().toISOString()
    };
  }

  /**
   * Import registry state
   */
  import(data) {
    if (data.tools) {
      this.tools = new Map(data.tools);
    }
    if (data.skills) {
      this.skills = new Map(data.skills);
    }
    if (data.manifests) {
      this.manifests = new Map(data.manifests);
    }
    if (data.stats) {
      this.stats = new Map(data.stats);
    }
    if (data.readiness) {
      this.readiness = new Map(data.readiness);
    }
    if (data.categories) {
      this.categories = new Set(data.categories);
    }
    
    this.emit('registry:imported', { timestamp: new Date().toISOString() });
  }
}

// Singleton instance
let instance = null;

function getUnifiedRegistry() {
  if (!instance) {
    instance = new UnifiedRegistry();
  }
  return instance;
}

module.exports = { UnifiedRegistry, getUnifiedRegistry };
