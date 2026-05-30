const { Task } = require('./core/Task');
const { TaskStatus } = require('./core/TaskStatus');
const { ToolRegistry } = require('./tools/ToolRegistry');
const { WorkingMemory } = require('./memory/WorkingMemory');
const { SkillMemory, Skill } = require('./memory/SkillMemory');
const { SkillExtractor } = require('./memory/SkillExtractor');
const { SkillRetriever } = require('./memory/SkillRetriever');
const { Executor } = require('./execution/Executor');
const { RetryEngine } = require('./execution/RetryEngine');
const { Verifier } = require('./execution/Verifier');
const { Planner } = require('./execution/Planner');
const { VALID_TASK_TYPES } = require('./core/TaskSchema');
const { createResponse } = require('../openai-client');
const { extractResponseText } = require('../artifacts/artifact-service');
const { config } = require('../config');
const {
  resolveClientSurface,
  resolveSessionScope,
} = require('../session-scope');
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const settingsController = require('../routes/admin/settings.controller');

const DEFAULT_EXECUTION_PROFILE = 'default';
const REMOTE_BUILD_EXECUTION_PROFILE = 'remote-build';
const TRACE_OUTPUT_PREVIEW_CHARS = Math.max(400, parseInt(process.env.TRACE_OUTPUT_PREVIEW_CHARS, 10) || 1200);
const REMOTE_BUILD_TOOL_ALLOWLIST = new Set([
  'remote-command',
  'remote-cli-agent',
  'remote-workbench',
  'k3s-deploy',
  'web-search',
  'web-fetch',
  'web-scrape',
  'news-scraper',
  'file-read',
  'file-write',
  'file-search',
  'file-mkdir',
  'git-safe',
  'code-sandbox',
  'tool-doc-read',
]);

function previewTraceText(value = '', limit = TRACE_OUTPUT_PREVIEW_CHARS) {
  const text = String(value || '').trim();
  const safeLimit = Math.max(1, Number(limit) || TRACE_OUTPUT_PREVIEW_CHARS);
  if (!text || text.length <= safeLimit) {
    return text;
  }

  const marker = `\n[omitted ${text.length - safeLimit} middle chars]\n`;
  const available = Math.max(1, safeLimit - marker.length);
  const headLength = Math.max(1, Math.floor(available * 0.68));
  const tailLength = Math.max(1, available - headLength);
  const omitted = Math.max(0, text.length - headLength - tailLength);
  return [
    text.slice(0, headLength).trimEnd(),
    `\n[omitted ${omitted} middle chars]\n`,
    text.slice(-tailLength).trimStart(),
  ].join('');
}

function createNoopVectorStore() {
  return {
    async upsert() {
      return [];
    },
    async retrieve() {
      return null;
    },
    async search() {
      return [];
    },
    async scroll() {
      return [];
    },
    async delete() {
      return undefined;
    }
  };
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        if (entry?.type === 'text') {
          return entry.text || '';
        }
        return entry?.text || '';
      })
      .join('');
  }

  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') {
      return content.text;
    }

    if (typeof content.value === 'string') {
      return content.value;
    }

    if (typeof content.content === 'string') {
      return content.content;
    }

    if (Array.isArray(content.content)) {
      return normalizeMessageContent(content.content);
    }

    if (Array.isArray(content.parts)) {
      return normalizeMessageContent(content.parts);
    }

    if (Array.isArray(content.items)) {
      return normalizeMessageContent(content.items);
    }
  }

  return '';
}

function inferRecallProfileFromObjective(text = '') {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) {
    return 'default';
  }

  return /\b(web research|research|look up|search for|search the web|browse the web|search online|browse online|latest|current|today|news|headlines?|weather|forecast|temperature)\b/.test(normalized)
    ? 'research'
    : 'default';
}

function isUuidLike(value) {
  return typeof value === 'string' && UUID_V4_REGEX.test(value.trim());
}

/**
 * @typedef {Object} AgentOrchestratorConfig
 * @property {number} [maxRetries=3] - Maximum number of retry attempts for failed operations
 * @property {number} [defaultTimeout=30000] - Default timeout in milliseconds for task execution
 * @property {boolean} [enableTracing=true] - Whether to enable execution tracing
 * @property {boolean} [enableSkills=true] - Whether to enable skill learning and retrieval
 * @property {Object} [custom] - Additional custom configuration options
 */

/**
 * @typedef {Object} ExecuteOptions
 * @property {string} [sessionId='default'] - Session identifier for maintaining conversation context
 * @property {boolean} [useSkills=true] - Whether to use skills for this execution
 * @property {number} [timeout] - Override default timeout for this execution
 * @property {AbortSignal} [signal] - AbortSignal for cancellation support
 */

/**
 * @typedef {Object} ExecuteResult
 * @property {boolean} success - Whether the task executed successfully
 * @property {Object} task - Serialized task object
 * @property {*} output - The task output
 * @property {Object} [trace] - Execution trace if tracing is enabled
 * @property {string} sessionId - The session ID used for execution
 */

/**
 * @typedef {Object} OrchestratorStats
 * @property {Object} tools - Tool registry statistics
 * @property {number} sessions - Number of active sessions
 * @property {Object} skills - Skill memory statistics
 */

/**
 * Main entry point for the Agent SDK.
 * Orchestrates task execution with memory, tools, and skills.
 * 
 * The AgentOrchestrator serves as the central coordinator for all agent operations,
 * managing the lifecycle of tasks from planning through execution, verification,
 * and skill capture. It maintains working memory per session and integrates with
 * various subsystems including tool execution, retry logic, and skill learning.
 * 
 * @example
 * const orchestrator = new AgentOrchestrator({
 *   llmClient: openaiClient,
 *   embedder: embeddingClient,
 *   vectorStore: pineconeStore,
 *   config: { maxRetries: 5, enableSkills: true }
 * });
 * 
 * orchestrator.on('task:complete', ({ task, result }) => {
 *   console.log(`Task ${task.id} completed`);
 * });
 * 
 * const result = await orchestrator.execute('Analyze this data', { 
 *   sessionId: 'user-123' 
 * });
 * 
 * @class
 */
class AgentOrchestrator {
  /**
   * Creates a new AgentOrchestrator instance.
   * 
   * @param {Object} dependencies - Required dependencies
   * @param {Object} dependencies.llmClient - LLM client for generating responses and plans
   * @param {Object} dependencies.embedder - Embedding client for vector operations
   * @param {Object} dependencies.vectorStore - Vector store for skill persistence
   * @param {AgentOrchestratorConfig} [dependencies.config={}] - Configuration options
   * @throws {Error} If required dependencies (llmClient, embedder, vectorStore) are not provided
   */
  constructor({
    llmClient,
    embedder,
    vectorStore,
    sessionStore = null,
    memoryService = null,
    config = {}
  }) {
    if (!llmClient) {
      throw new Error('AgentOrchestrator requires an llmClient');
    }
    if (!embedder) {
      throw new Error('AgentOrchestrator requires an embedder');
    }

    const resolvedVectorStore = vectorStore || createNoopVectorStore();
    const skillsEnabled = vectorStore ? config.enableSkills !== false : false;
    if (!vectorStore) {
      console.warn('AgentOrchestrator started without a vectorStore; skill persistence is disabled');
    }

    this.llmClient = llmClient;
    this.embedder = embedder;
    this.vectorStore = resolvedVectorStore;
    this.sessionStore = sessionStore;
    this.memoryService = memoryService;

    // Initialize core execution components
    /**
     * Registry for managing available tools.
     * @type {ToolRegistry}
     * @private
     */
    this.toolRegistry = new ToolRegistry();

    /**
     * Engine for handling retry logic on failures.
     * @type {RetryEngine}
     * @private
     */
    this.retryEngine = new RetryEngine();

    /**
     * Verifier for validating execution results.
     * @type {Verifier}
     * @private
     */
    this.verifier = new Verifier();

    /**
     * Planner for creating execution strategies.
     * @type {Planner}
     * @private
     */
    this.planner = new Planner(this.toolRegistry, llmClient);

    // Memory systems
    /**
     * Map of session IDs to WorkingMemory instances.
     * @type {Map<string, WorkingMemory>}
     * @private
     */
    this.workingMemories = new Map();

    /**
     * Persistent memory for learned skills.
     * @type {SkillMemory}
     * @private
     */
    this.skillMemory = new SkillMemory(resolvedVectorStore);

    /**
     * Extractor for capturing skills from successful tasks.
     * @type {SkillExtractor}
     * @private
     */
    this.skillExtractor = new SkillExtractor(embedder);

    /**
     * Retriever for finding relevant skills for tasks.
     * @type {SkillRetriever}
     * @private
     */
    this.skillRetriever = new SkillRetriever(this.skillMemory, embedder);

    // Configuration
    /**
     * Merged configuration with defaults.
     * @type {AgentOrchestratorConfig}
     * @private
     */
    this.config = {
      maxRetries: 3,
      defaultTimeout: 30000,
      enableTracing: true,
      enableConversationAgentExecutor: false,
      ...config
    };
    this.config.enableSkills = skillsEnabled && this.config.enableSkills !== false;

    // Event handling system
    /**
     * Map of event names to arrays of handler functions.
     * @type {Map<string, Function[]>}
     * @private
     */
    this.eventHandlers = new Map();
  }

  /**
   * Execute a task with full orchestration lifecycle.
   * 
   * The execution flow:
   * 1. Get or create working memory for the session
   * 2. Create and register the task
   * 3. Retrieve relevant skills from memory
   * 4. Create an executor with all dependencies
   * 5. Execute the task with event emission
   * 6. Capture skill if execution was successful
   * 
   * @param {string|Object} taskInput - Task description string or task configuration object
   * @param {ExecuteOptions} [options={}] - Execution options
   * @returns {Promise<ExecuteResult>} Execution result with task data, output, and trace
   * @throws {Error} If execution fails and all retries are exhausted
   * @fires AgentOrchestrator#task:start
   * @fires AgentOrchestrator#task:complete
   * @fires AgentOrchestrator#task:error
   */
  async execute(taskInput, options = {}) {
    const { 
      sessionId = 'default', 
      useSkills = true,
      timeout = this.config.defaultTimeout,
      signal
    } = options;

    // Get or create working memory for this session
    const workingMemory = this.getWorkingMemory(sessionId);

    // Create task from input
    const task = new Task(this.normalizeTaskInput(taskInput, sessionId));
    workingMemory.setCurrentTask(task);

    // Retrieve relevant skills to provide context
    let skillContext = '';
    if (useSkills && this.config.enableSkills) {
      try {
        const skills = await this.skillRetriever.retrieveForTask(task);
        skillContext = this.skillRetriever.formatForPrompt(skills);
        workingMemory.setIntermediateResult('relevantSkills', skills);
        workingMemory.setIntermediateResult('skillContext', skillContext);
      } catch (error) {
        console.warn('Failed to retrieve skills:', error.message);
      }
    }

    // Create executor with all dependencies
    const executor = new Executor({
      toolRegistry: this.toolRegistry,
      workingMemory,
      retryEngine: this.retryEngine,
      verifier: this.verifier,
      planner: this.planner,
      llmClient: this.llmClient,
      skillContext,
      timeout,
      signal
    });

    // Emit start event
    this.emit('task:start', { task, sessionId, timestamp: Date.now() });

    try {
      const result = await executor.execute(task);

      // Emit completion event
      this.emit('task:complete', { 
        task, 
        result, 
        sessionId, 
        timestamp: Date.now(),
        duration: result.duration 
      });

      // Capture skill if execution was successful
      if (result.success && this.config.enableSkills) {
        try {
          await this.captureSkill(task.id);
        } catch (error) {
          console.warn('Failed to capture skill:', error.message);
        }
      }

      return {
        success: result.success,
        task: task.toJSON(),
        output: result.output,
        trace: typeof result.trace?.toJSON === 'function' ? result.trace.toJSON() : result.trace,
        sessionId
      };

    } catch (error) {
      // Emit error event
      this.emit('task:error', { 
        task, 
        error: error.message, 
        sessionId, 
        timestamp: Date.now(),
        stack: error.stack 
      });
      throw error;
    }
  }

  async executeConversation({
    input,
    instructions = null,
    contextMessages = [],
    recentMessages = [],
    previousResponseId = null,
    stream = false,
    model = null,
    toolManager = null,
    toolContext = {},
    enableAutomaticToolCalls = false,
    loadContextMessages = true,
    loadRecentMessages = true,
    sessionId = 'default',
    ownerId = null,
    taskType = 'chat',
    metadata = {},
    clientSurface = '',
    memoryScope = null,
    useAgentExecutor = false,
    executionProfile = DEFAULT_EXECUTION_PROFILE,
  } = {}) {
    const workingMemory = this.getWorkingMemory(sessionId);
    const objective = this.getConversationObjective(input);
    const resolvedClientSurface = resolveClientSurface({
      taskType,
      clientSurface: clientSurface || toolContext?.clientSurface || metadata?.clientSurface || metadata?.client_surface || '',
      metadata,
    }, null, taskType);
    const resolvedMemoryScope = resolveSessionScope({
      mode: taskType,
      taskType,
      clientSurface: resolvedClientSurface,
      memoryScope: memoryScope || toolContext?.memoryScope || metadata?.memoryScope || metadata?.memory_scope || '',
      metadata,
    });
    const resolvedContextMessages = contextMessages.length > 0
      ? contextMessages
      : loadContextMessages !== false
        ? await this.loadContextMessages(sessionId, objective, ownerId, resolvedMemoryScope)
        : [];
    const resolvedRecentMessages = recentMessages.length > 0
      ? recentMessages
      : loadRecentMessages !== false
        ? await this.loadRecentMessages(sessionId)
        : [];
    const task = new Task(this.normalizeTaskInput({
      type: this.normalizeConversationTaskType(taskType),
      objective,
      input: {
        content: objective,
        format: Array.isArray(input) ? 'json' : 'text',
      },
      context: {
        sessionId,
        metadata: {
          ...metadata,
          model,
          executionProfile,
          clientSurface: resolvedClientSurface,
          memoryScope: resolvedMemoryScope,
        },
      },
      completionCriteria: {
        conditions: ['output-not-empty', 'no-errors'],
      },
    }, sessionId));

    workingMemory.setCurrentTask(task);
    this.syncWorkingMemoryTranscript(workingMemory, resolvedRecentMessages);
    if (objective) {
      workingMemory.addMessage('user', objective, { source: 'runtime' });
    }

    this.emit('task:start', {
      task,
      sessionId,
      timestamp: Date.now(),
      metadata: {
        ...metadata,
        stream,
        taskType,
      },
    });

    try {
      const shouldUseAgentExecutor = Boolean(
        useAgentExecutor && this.config.enableConversationAgentExecutor === true
      );

      if (shouldUseAgentExecutor) {
        try {
          return await this.executeConversationWithAgentExecutor({
            task,
            input,
            instructions,
            contextMessages: resolvedContextMessages,
            recentMessages: resolvedRecentMessages,
            stream,
            model,
            sessionId,
            ownerId,
            clientSurface: resolvedClientSurface,
            memoryScope: resolvedMemoryScope,
            taskType,
            metadata,
            workingMemory,
            executionProfile,
          });
        } catch (agentError) {
          console.warn('[AgentOrchestrator] Agent executor failed, falling back to conversation runtime:', agentError.message);
        }
      }

      this.transitionRuntimeTask(task, TaskStatus.EXECUTING);
      const response = await this.requestResponse({
        input,
        previousResponseId,
        contextMessages: resolvedContextMessages,
        recentMessages: resolvedRecentMessages,
        instructions,
        stream,
        model,
        toolManager,
        toolContext: {
          ...toolContext,
          sessionId,
          ownerId,
          executionProfile,
          ...(resolvedClientSurface ? { clientSurface: resolvedClientSurface } : {}),
          ...(resolvedMemoryScope ? { memoryScope: resolvedMemoryScope } : {}),
        },
        enableAutomaticToolCalls,
      });

        if (stream) {
          return {
            success: true,
            sessionId,
            task: task.toJSON(),
            response: this.wrapConversationStream({
              response,
              task,
              workingMemory,
              sessionId,
              ownerId,
              memoryScope: resolvedMemoryScope,
              model,
              userText: objective,
              metadata: {
                ...metadata,
                taskType,
              },
            }),
          };
        }
  
        const output = this.extractResponseOutput(response);
        const toolEvents = this.extractToolEvents(response);
        const duration = this.finalizeRuntimeTask(task, workingMemory, output);
        await this.persistConversationState({
          sessionId,
          ownerId,
          memoryScope: resolvedMemoryScope,
          userText: objective,
          assistantText: output,
          responseId: response?.id || null,
          promptState: response?.metadata?.promptState || null,
          toolEvents,
        });
        const trace = this.buildConversationTrace({
          task,
          sessionId,
          output,
          responseId: response?.id || null,
          model: response?.model || model || null,
          duration,
          metadata: {
            ...metadata,
            taskType,
            stream,
            toolEventCount: toolEvents.length,
          },
        });

      this.emit('task:complete', {
        task,
        sessionId,
        timestamp: Date.now(),
        result: {
          success: true,
          output,
          responseId: response?.id || null,
          trace,
          duration,
        },
      });

      return {
        success: true,
        sessionId,
        task: task.toJSON(),
        output,
        response,
        trace,
      };
    } catch (error) {
      this.failRuntimeTask(task);
      this.emit('task:error', {
        task,
        sessionId,
        timestamp: Date.now(),
        error: error.message,
        stack: error.stack,
        metadata: {
          ...metadata,
          taskType,
        },
      });
      throw error;
    }
  }

  async executeConversationWithAgentExecutor({
    task,
    input,
    instructions,
    contextMessages = [],
    recentMessages = [],
    stream = false,
    model = null,
    sessionId,
    ownerId = null,
    clientSurface = '',
    memoryScope = null,
    taskType,
    metadata = {},
    workingMemory,
    executionProfile = DEFAULT_EXECUTION_PROFILE,
  }) {
    const retrievedSkills = this.config.enableSkills
      ? await this.skillRetriever.retrieveForTask(task).catch(() => [])
      : [];
    const skillContext = this.config.enableSkills
      ? this.skillRetriever.formatForPrompt(retrievedSkills)
      : '';
    const selectedSkills = retrievedSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      tools: Array.isArray(skill.toolPreferences) ? skill.toolPreferences : [],
    }));

    task.tools = this.getConversationToolIds(task.objective, instructions, {
      executionProfile,
    });
    task.skillContext = skillContext;
    task.context = {
      ...(task.context || {}),
      skillContext,
      metadata: {
        ...(task.context?.metadata || {}),
        ...metadata,
        skillContext,
        model,
        executionProfile,
        instructions: instructions || '',
        contextMessages,
        recentMessages,
      },
    };

    this.seedConversationExecutionContext(workingMemory, {
      instructions,
      contextMessages,
      recentMessages,
      input,
      skillContext,
    });

    const executor = new Executor({
      toolRegistry: this.toolRegistry,
      workingMemory,
      retryEngine: this.retryEngine,
      verifier: this.verifier,
      planner: this.planner,
      llmClient: this.llmClient,
      skillContext,
    });

    const result = await executor.execute(task);
    if (!result.success) {
      throw new Error(result.error || 'Agent execution failed');
    }

    const output = typeof result.output === 'string'
      ? result.output
      : result.output == null
        ? ''
        : JSON.stringify(result.output, null, 2);
    const trace = typeof result.trace?.toJSON === 'function' ? result.trace.toJSON() : result.trace;
    const toolEvents = this.buildToolEventsFromTrace(trace);
    const response = this.buildSyntheticConversationResponse({
      sessionId,
      model,
      output,
      metadata: {
        toolEvents,
        trace,
        agentExecutor: true,
        taskType,
        skillContext,
        selectedSkills,
      },
    });

    if (stream) {
      return {
        success: true,
        sessionId,
        task: task.toJSON(),
        response: this.wrapConversationStream({
          response: this.createSyntheticConversationStream(response),
          task,
          workingMemory,
          sessionId,
          ownerId,
          memoryScope,
          model,
          userText: this.getConversationObjective(input),
          metadata: {
            ...metadata,
            taskType,
            clientSurface,
            agentExecutor: true,
            skillContext,
            selectedSkills,
          },
        }),
      };
    }

    const duration = this.finalizeRuntimeTask(task, workingMemory, output);
    await this.persistConversationState({
      sessionId,
      ownerId,
      memoryScope,
      userText: this.getConversationObjective(input),
      assistantText: output,
      responseId: response.id,
      promptState: response?.metadata?.promptState || null,
      toolEvents,
    });
    const conversationTrace = this.buildConversationTrace({
      task,
      sessionId,
      output,
      responseId: response.id,
      model: response.model || model || null,
      duration,
      metadata: {
        ...metadata,
        taskType,
        stream,
        toolEventCount: toolEvents.length,
        agentExecutor: true,
        executionTrace: trace,
        skillContext,
        selectedSkills,
      },
    });

    this.emit('task:complete', {
      task,
      sessionId,
      timestamp: Date.now(),
      result: {
        success: true,
        output,
        responseId: response.id,
        trace: conversationTrace,
        duration,
      },
    });

    return {
      success: true,
      sessionId,
      task: task.toJSON(),
      output,
      response,
      trace: conversationTrace,
    };
  }

  normalizeExecutionProfile(value = '') {
    const normalized = String(value || '').trim().toLowerCase();

    if ([
      'remote-build',
      'remote_builder',
      'remote-builder',
      'server-build',
      'server-builder',
      'software-builder',
    ].includes(normalized)) {
      return REMOTE_BUILD_EXECUTION_PROFILE;
    }

    return DEFAULT_EXECUTION_PROFILE;
  }

  getConversationToolIds(objective = '', instructions = '', options = {}) {
    const allTools = this.toolRegistry.list().map((tool) => tool.id);
    const sshConfig = settingsController.getEffectiveSshConfig();
    const hasUsableSshDefaults = Boolean(
      sshConfig.enabled
      && sshConfig.host
      && sshConfig.username
      && (sshConfig.password || sshConfig.privateKeyPath)
    );
    const combinedPrompt = `${objective || ''}\n${instructions || ''}`.toLowerCase();
    const executionProfile = this.normalizeExecutionProfile(options.executionProfile);
    const remoteBuildProfile = executionProfile === REMOTE_BUILD_EXECUTION_PROFILE;
    const hasExplicitSshIntent = /\bssh\b/.test(combinedPrompt)
      || /\b(remote host|remote server|remote machine)\b/.test(combinedPrompt)
      || /\b(login to|log into|ssh into|ssh to|connect to)\b/.test(combinedPrompt);
    const hasRemoteOpsIntent = remoteBuildProfile
      || hasExplicitSshIntent
      || /\b(kubectl|kubernetes|k8s|docker compose|docker-compose|systemctl|journalctl|nginx|pm2)\b/.test(combinedPrompt)
      || /\b(deploy|release|rollout|restart)\b[\s\S]{0,40}\b(server|host|container|cluster|pod|deployment)\b/.test(combinedPrompt);

    return allTools.filter((toolId) => {
      if (remoteBuildProfile && !REMOTE_BUILD_TOOL_ALLOWLIST.has(toolId)) {
        return false;
      }

      if (toolId === 'remote-command' || toolId === 'k3s-deploy') {
        return hasRemoteOpsIntent && hasUsableSshDefaults;
      }

      if (toolId === 'docker-exec') {
        return /\b(docker|container)\b/.test(combinedPrompt)
          && /\b(docker (?:is )?(?:available|configured|enabled)|use docker|docker exec)\b/.test(combinedPrompt);
      }

      return true;
    });
  }

  /**
   * Capture a skill from a successfully completed task.
   * 
   * This method extracts patterns from the task execution and stores
   * them as reusable skills for future similar tasks.
   * 
   * @param {string} taskId - The ID of the task to extract skill from
   * @returns {Promise<Skill|null>} The captured skill or null if extraction failed
   * @fires AgentOrchestrator#skill:captured
   * @private
   */
  async captureSkill(taskId) {
    const task = this.findTaskInMemory(taskId);
    if (!task) {
      console.warn(`Task ${taskId} not found in memory for skill capture`);
      return null;
    }

    const skill = await this.skillExtractor.extractFromTask(task);
    if (!skill) {
      return null;
    }

    await this.skillMemory.store(skill);

    this.emit('skill:captured', { skill, taskId, timestamp: Date.now() });

    return skill;
  }

  /**
   * Register a single tool with the orchestrator.
   * 
   * @param {Object} toolDefinition - Tool definition object
   * @param {string} toolDefinition.name - Unique tool name
   * @param {string} toolDefinition.description - Tool description for LLM
   * @param {Object} toolDefinition.parameters - JSON Schema for tool parameters
   * @param {Function} toolDefinition.execute - Async function to execute the tool
   * @returns {AgentOrchestrator} This orchestrator instance for method chaining
   * @throws {Error} If tool definition is invalid
   * @example
   * orchestrator.registerTool({
   *   name: 'calculator',
   *   description: 'Perform mathematical calculations',
   *   parameters: {
   *     type: 'object',
   *     properties: {
   *       expression: { type: 'string' }
   *     },
   *     required: ['expression']
   *   },
   *   execute: async ({ expression }) => eval(expression)
   * });
   */
  registerTool(toolDefinition) {
    this.toolRegistry.register(toolDefinition);
    return this;
  }

  /**
   * Register multiple tools at once.
   * 
   * @param {Object[]} tools - Array of tool definition objects
   * @returns {AgentOrchestrator} This orchestrator instance for method chaining
   */
  registerTools(tools) {
    for (const tool of tools) {
      this.registerTool(tool);
    }
    return this;
  }

  /**
   * Get or create working memory for a session.
   * 
   * @param {string} sessionId - Unique session identifier
   * @returns {WorkingMemory} The working memory instance for this session
   */
  getWorkingMemory(sessionId) {
    const existingMemory = this.workingMemories.get(sessionId);
    if (existingMemory?.isExpired()) {
      this.workingMemories.delete(sessionId);
    }

    if (!this.workingMemories.has(sessionId)) {
      this.workingMemories.set(sessionId, new WorkingMemory(sessionId));
    }
    return this.workingMemories.get(sessionId);
  }

  normalizeTaskInput(taskInput, sessionId) {
    const normalized = typeof taskInput === 'string'
      ? {
          type: 'chat',
          objective: taskInput,
          input: {
            content: taskInput,
            format: 'text'
          }
        }
      : {
          ...(taskInput || {})
        };

    const inferredObjective = typeof normalized.objective === 'string' && normalized.objective.trim()
      ? normalized.objective.trim()
      : typeof normalized.input?.content === 'string' && normalized.input.content.trim()
        ? normalized.input.content.trim()
        : '';

    const normalizedType = VALID_TASK_TYPES.includes(normalized.type)
      ? normalized.type
      : normalized.type === 'chat-interaction'
        ? 'chat'
        : 'multi-step';

    const normalizedConditions = Array.isArray(normalized.completionCriteria?.conditions)
      ? normalized.completionCriteria.conditions.map((condition) => {
          if (typeof condition === 'string') {
            if (condition === 'output-not-empty' || condition === 'response-delivered') {
              return {
                type: 'output-present',
              };
            }

            if (condition === 'no-errors') {
              return {
                type: 'custom-check',
                check: 'no-errors',
                expected: true,
              };
            }

            return {
              type: 'custom-check',
              check: condition,
            };
          }

          return condition;
        })
      : normalized.completionCriteria?.conditions;

    return {
      ...normalized,
      type: normalizedType,
      objective: inferredObjective,
      input: {
        format: 'text',
        ...(normalized.input || {}),
        content: typeof normalized.input?.content === 'string'
          ? normalized.input.content
          : inferredObjective,
      },
      context: {
        ...(function() {
          const ctx = { ...(normalized.context || {}) };
          delete ctx.sessionId;
          return ctx;
        })(),
        ...(isUuidLike(normalized.context?.sessionId)
          ? { sessionId: normalized.context.sessionId }
          : isUuidLike(sessionId)
            ? { sessionId }
            : {}),
        metadata: {
          ...(normalized.context?.metadata || {}),
          runtimeSessionId: sessionId || null,
        },
      },
      completionCriteria: normalized.completionCriteria
        ? {
            ...normalized.completionCriteria,
            conditions: normalizedConditions,
          }
        : normalized.completionCriteria,
    };
  }

  normalizeConversationTaskType(taskType) {
    if (VALID_TASK_TYPES.includes(taskType)) {
      return taskType;
    }

    return 'chat';
  }

  getConversationObjective(input) {
    if (typeof input === 'string') {
      return input;
    }

    if (Array.isArray(input)) {
      for (let index = input.length - 1; index >= 0; index -= 1) {
        if (input[index]?.role === 'user') {
          return normalizeMessageContent(input[index].content);
        }
      }
    }

    return '';
  }

  async loadContextMessages(sessionId, objective, ownerId = null, memoryScope = null) {
    if (!objective || !this.memoryService?.recall) {
      return [];
    }

    try {
      return await this.memoryService.recall(objective, {
        sessionId: ownerId ? null : sessionId,
        ownerId,
        memoryScope,
        profile: inferRecallProfileFromObjective(objective),
      });
    } catch (error) {
      console.error('[AgentOrchestrator] Failed to load recalled context:', error.message);
      return [];
    }
  }

  async loadRecentMessages(sessionId, limit = config.memory.recentTranscriptLimit) {
    if (!sessionId || !this.sessionStore?.getRecentMessages) {
      return [];
    }

    try {
      return await this.sessionStore.getRecentMessages(sessionId, limit);
    } catch (error) {
      console.error('[AgentOrchestrator] Failed to load recent transcript:', error.message);
      return [];
    }
  }

  syncWorkingMemoryTranscript(workingMemory, recentMessages = []) {
    if (!Array.isArray(recentMessages) || recentMessages.length === 0) {
      return;
    }

    const existingKeys = new Set(
      workingMemory.getMessages().map((message) => `${message.role}:${message.content}`)
    );

    for (const entry of recentMessages) {
      if (!['user', 'assistant', 'system', 'tool'].includes(entry?.role)) {
        continue;
      }

      const content = normalizeMessageContent(entry?.content);
      if (!content) {
        continue;
      }

      const key = `${entry.role}:${content}`;
      if (existingKeys.has(key)) {
        continue;
      }

      workingMemory.addMessage(entry.role, content, {
        source: 'session-store',
      });
      existingKeys.add(key);
    }
  }

  extractResponseOutput(response) {
    return extractResponseText(response);
  }

  extractToolEvents(response = {}) {
    return Array.isArray(response?.metadata?.toolEvents)
      ? response.metadata.toolEvents
      : [];
  }

  wrapConversationStream({
    response,
    task,
    workingMemory,
    sessionId,
    ownerId = null,
    memoryScope = null,
    model,
    userText = '',
    metadata = {},
  }) {
    const orchestrator = this;

    return (async function* wrappedStream() {
      let fullText = '';

      try {
        for await (const event of response) {
          if (event.type === 'response.output_text.delta') {
            fullText += event.delta;
          }

          if (event.type === 'response.completed') {
            fullText = orchestrator.extractResponseOutput(event.response) || fullText;
            const toolEvents = orchestrator.extractToolEvents(event.response);
            const duration = orchestrator.finalizeRuntimeTask(task, workingMemory, fullText);
            await orchestrator.persistConversationState({
              sessionId,
              ownerId,
              memoryScope,
              userText,
              assistantText: fullText,
              responseId: event.response?.id || null,
              promptState: event.response?.metadata?.promptState || null,
              toolEvents,
            });
            const trace = orchestrator.buildConversationTrace({
              task,
              sessionId,
              output: fullText,
              responseId: event.response?.id || null,
              model: event.response?.model || model || null,
              duration,
              metadata: {
                ...metadata,
                stream: true,
                toolEventCount: toolEvents.length,
              },
            });

            orchestrator.emit('task:complete', {
              task,
              sessionId,
              timestamp: Date.now(),
              result: {
                success: true,
                output: fullText,
                responseId: event.response?.id || null,
                trace,
                duration,
              },
            });
          }

          yield event;
        }
      } catch (error) {
        orchestrator.failRuntimeTask(task);
        orchestrator.emit('task:error', {
          task,
          sessionId,
          timestamp: Date.now(),
          error: error.message,
          stack: error.stack,
          metadata,
        });
        throw error;
      }
    }());
  }

  transitionRuntimeTask(task, nextStatus) {
    try {
      task.transitionStatus(nextStatus);
    } catch (_error) {
      task.status = nextStatus;
    }
  }

  finalizeRuntimeTask(task, workingMemory, output) {
    if (output) {
      workingMemory.addMessage('assistant', output, { source: 'runtime' });
    }

    this.transitionRuntimeTask(task, TaskStatus.COMPLETED);
    return task.metadata?.executionTime || 0;
  }

  failRuntimeTask(task) {
    this.transitionRuntimeTask(task, TaskStatus.FAILED);
  }

  seedConversationExecutionContext(workingMemory, {
    instructions = '',
    contextMessages = [],
    recentMessages = [],
    input = null,
    skillContext = '',
  } = {}) {
    if (!workingMemory) {
      return;
    }

    const inputSummary = Array.isArray(input)
      ? input.map((entry) => `${entry?.role || 'unknown'}: ${normalizeMessageContent(entry?.content)}`).join('\n')
      : normalizeMessageContent(input);

    workingMemory.setIntermediateResult('runtimeInstructions', instructions || '');
    workingMemory.setIntermediateResult('contextMessages', contextMessages);
    workingMemory.setIntermediateResult('recentMessages', recentMessages);
    workingMemory.setIntermediateResult('contextMessagesText', this.formatConversationMessages(contextMessages));
    workingMemory.setIntermediateResult('recentMessagesText', this.formatConversationMessages(recentMessages));
    workingMemory.setIntermediateResult('inputSummary', inputSummary || '');
    workingMemory.setIntermediateResult('skillContext', skillContext || '');
    workingMemory.setIntermediateResult('results', {});
    workingMemory.setIntermediateResult('stepResults', []);
    workingMemory.setIntermediateResult('resultsJson', JSON.stringify({}, null, 2));
    workingMemory.setIntermediateResult('stepResultsJson', JSON.stringify([], null, 2));
  }

  formatConversationMessages(messages = []) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return '';
    }

    return messages
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }

        return `${entry?.role || 'context'}: ${normalizeMessageContent(entry?.content || entry)}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  buildToolEventsFromTrace(trace = {}) {
    const flattenSteps = (stepsToFlatten = []) => stepsToFlatten.flatMap((step) => [
      step,
      ...flattenSteps(Array.isArray(step?.substeps) ? step.substeps : []),
    ]);
    const steps = flattenSteps(Array.isArray(trace?.steps) ? trace.steps : []);

    return steps
      .filter((step) => step?.type === 'tool-call')
      .map((step) => {
        const input = step.input && typeof step.input === 'object' ? step.input : {};
        const params = input.params && typeof input.params === 'object'
          ? input.params
          : input;
        const toolName = input.tool || 'tool';

        return {
          toolCall: {
            id: step.id || `tool_${Date.now()}`,
            type: 'function',
            function: {
              name: toolName,
              arguments: JSON.stringify(params || {}),
            },
          },
          result: {
            success: !step.error,
            toolId: toolName,
            data: step.output,
            error: step.error || null,
          },
        };
      });
  }

  buildSyntheticConversationResponse({
    sessionId,
    model = null,
    output = '',
    metadata = {},
  } = {}) {
    return {
      id: `resp_${Date.now()}`,
      object: 'response',
      created: Math.floor(Date.now() / 1000),
      model,
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        },
      ],
      session_id: sessionId,
      metadata,
    };
  }

  createSyntheticConversationStream(response = {}) {
    const text = this.extractResponseOutput(response);
    const responseId = response?.id || `resp_${Date.now()}`;
    const model = response?.model || null;
    const metadata = response?.metadata || {};
    const chunkSize = 120;

    return (async function* syntheticStream() {
      for (let index = 0; index < text.length; index += chunkSize) {
        yield {
          type: 'response.output_text.delta',
          delta: text.slice(index, index + chunkSize),
        };
      }

      yield {
        type: 'response.completed',
        response: {
          id: responseId,
          model,
          output: response.output || [],
          metadata,
        },
      };
    }());
  }

  buildConversationTrace({
    task,
    sessionId,
    output,
    responseId,
    model,
    duration,
    metadata = {},
  }) {
    return {
      id: `runtime-${task.id}`,
      taskId: task.id,
      sessionId,
      model,
      responseId,
      duration,
      status: 'completed',
      createdAt: task.metadata?.createdAt || new Date().toISOString(),
      completedAt: task.metadata?.completedAt || new Date().toISOString(),
      metadata,
      steps: [
        {
          type: 'model_call',
          status: 'completed',
          description: `${metadata.taskType || task.type} runtime response`,
          outputPreview: previewTraceText(output),
          outputChars: String(output || '').length,
        },
      ],
    };
  }

  async persistConversationState({
    sessionId,
    ownerId = null,
    memoryScope = null,
    userText,
    assistantText,
    responseId,
    promptState = null,
    toolEvents = [],
  }) {
    if (!sessionId) {
      return;
    }

    if (this.sessionStore?.recordResponse && responseId) {
      try {
        if (promptState) {
          await this.sessionStore.recordResponse(sessionId, responseId, { promptState });
        } else {
          await this.sessionStore.recordResponse(sessionId, responseId);
        }
      } catch (error) {
        console.error('[AgentOrchestrator] Failed to record response ID:', error.message);
      }
    }

    const transcriptMessages = [];
    if (userText) {
      transcriptMessages.push({ role: 'user', content: userText });
    }

    for (const toolEvent of toolEvents) {
      const toolName = toolEvent?.toolCall?.function?.name || 'tool';
      const argumentsJson = toolEvent?.toolCall?.function?.arguments || '{}';
      transcriptMessages.push({
        role: 'tool',
        content: JSON.stringify({
          tool: toolName,
          arguments: argumentsJson,
          result: toolEvent?.result || {},
        }),
      });
    }

    if (assistantText) {
      transcriptMessages.push({ role: 'assistant', content: assistantText });
    }

    if (this.sessionStore?.appendMessages && transcriptMessages.length > 0) {
      try {
        await this.sessionStore.appendMessages(sessionId, transcriptMessages);
      } catch (error) {
        console.error('[AgentOrchestrator] Failed to persist transcript:', error.message);
      }
    }

    if (this.memoryService?.remember && userText) {
      try {
        await this.memoryService.remember(sessionId, userText, 'user', {
          ...(ownerId ? { ownerId } : {}),
          ...(memoryScope ? { memoryScope } : {}),
        });
      } catch (error) {
        console.error('[AgentOrchestrator] Failed to persist user memory:', error.message);
      }
    }

    if (this.memoryService?.rememberResponse && assistantText) {
      try {
        await this.memoryService.rememberResponse(sessionId, assistantText, {
          ...(ownerId ? { ownerId } : {}),
          ...(memoryScope ? { memoryScope } : {}),
        });
      } catch (error) {
        console.error('[AgentOrchestrator] Failed to persist assistant memory:', error.message);
      }
    }

    if (this.memoryService?.remember) {
      for (const toolEvent of toolEvents) {
        const toolName = toolEvent?.toolCall?.function?.name || 'tool';
        try {
          await this.memoryService.remember(
            sessionId,
            JSON.stringify({
              tool: toolName,
              result: toolEvent?.result || {},
            }),
            'tool',
            {
              ...(ownerId ? { ownerId } : {}),
              ...(memoryScope ? { memoryScope } : {}),
            },
          );
        } catch (error) {
          console.error(`[AgentOrchestrator] Failed to persist tool memory for '${toolName}':`, error.message);
        }
      }
    }
  }

  /**
   * Clear working memory for a specific session.
   * This frees up memory and resets the session state.
   * 
   * @param {string} sessionId - Session identifier to clear
   * @returns {boolean} True if a session was cleared, false if not found
   */
  clearWorkingMemory(sessionId) {
    return this.workingMemories.delete(sessionId);
  }

  /**
   * Clear all working memories across all sessions.
   * Use with caution as this resets all conversation contexts.
   * 
   * @returns {number} Number of sessions cleared
   */
  clearAllWorkingMemories() {
    const count = this.workingMemories.size;
    this.workingMemories.clear();
    return count;
  }

  /**
   * Find a task in any active working memory.
   * Searches across all sessions for the specified task ID.
   * 
   * @param {string} taskId - Task identifier to search for
   * @returns {Task|null} The found task or null if not found
   * @private
   */
  findTaskInMemory(taskId) {
    for (const [sessionId, memory] of this.workingMemories) {
      if (memory.currentTask?.id === taskId) {
        return memory.currentTask;
      }
    }
    return null;
  }

  /**
   * Register an event handler.
   * 
   * Supported events:
   * - 'task:start' - Emitted when a task begins execution
   * - 'task:complete' - Emitted when a task completes successfully
   * - 'task:error' - Emitted when a task fails
   * - 'skill:captured' - Emitted when a skill is learned from a task
   * 
   * @param {string} event - Event name to listen for
   * @param {Function} handler - Event handler function
   * @returns {AgentOrchestrator} This orchestrator instance for method chaining
   */
  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new Error('Event handler must be a function');
    }
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
    return this;
  }

  /**
   * Remove an event handler.
   * 
   * @param {string} event - Event name
   * @param {Function} handler - Handler function to remove
   * @returns {boolean} True if handler was found and removed
   */
  off(event, handler) {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return false;
    
    const index = handlers.indexOf(handler);
    if (index > -1) {
      handlers.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Emit an event to all registered handlers.
   * Handlers are called synchronously but errors are caught and logged.
   * 
   * @param {string} event - Event name to emit
   * @param {Object} data - Event data payload
   * @returns {number} Number of handlers invoked
   * @private
   */
  emit(event, data) {
    const handlers = this.eventHandlers.get(event) || [];
    let invoked = 0;
    
    for (const handler of handlers) {
      try {
        handler(data);
        invoked++;
      } catch (error) {
        console.error(`Event handler error for ${event}:`, error);
      }
    }
    
    return invoked;
  }

  /**
   * Get comprehensive orchestrator statistics.
   * 
   * @returns {OrchestratorStats} Statistics object containing tool, session, and skill counts
   */
  getStats() {
    return {
      tools: this.toolRegistry.getStats(),
      sessions: this.workingMemories.size,
      skills: this.skillMemory.getStats?.() || { total: 0 },
      config: {
        maxRetries: this.config.maxRetries,
        defaultTimeout: this.config.defaultTimeout,
        enableTracing: this.config.enableTracing,
        enableSkills: this.config.enableSkills
      }
    };
  }

  /**
   * Get a list of all active session IDs.
   * 
   * @returns {string[]} Array of session identifiers
   */
  getActiveSessions() {
    return Array.from(this.workingMemories.keys());
  }

  /**
   * Check if a session has active working memory.
   * 
   * @param {string} sessionId - Session identifier to check
   * @returns {boolean} True if session exists
   */
  hasSession(sessionId) {
    return this.workingMemories.has(sessionId);
  }

  /**
   * Gracefully shutdown the orchestrator.
   * Clears all working memories and releases resources.
   * 
   * @returns {Promise<void>}
   */
  async shutdown() {
    this.clearAllWorkingMemories();
    this.eventHandlers.clear();
  }

  async requestResponse(params = {}) {
    if (typeof this.llmClient?.createResponse === 'function') {
      return this.llmClient.createResponse(params);
    }

    console.warn('[AgentOrchestrator] llmClient.createResponse is unavailable; falling back to openai-client.createResponse');
    return createResponse(params);
  }
}

module.exports = { AgentOrchestrator };
