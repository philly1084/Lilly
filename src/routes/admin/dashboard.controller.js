/**
 * Dashboard Controller
 * Handles dashboard overview and SDK control endpoints
 */

const { v4: uuidv4 } = require('uuid');
const logsController = require('./logs.controller');
const tracesController = require('./traces.controller');
const { vectorStore } = require('../../memory/vector-store');
const { getUnifiedRegistry } = require('../../agent-sdk/registry/UnifiedRegistry');
const { parseLenientJson } = require('../../utils/lenient-json');
const { normalizeUsageMetadata } = require('../../utils/token-usage');
const { formatImageDiagnosticsSummary } = require('../../image-generation-diagnostics');
const { buildSystemHealthReport } = require('../../observability/health-report');

class DashboardController {
  constructor(agentOrchestrator) {
    this.orchestrator = agentOrchestrator;
    this.registry = getUnifiedRegistry();
    this.taskStore = new Map();
    this.sessionStore = new Map();
    this.activityLog = [];
    this.maxActivityItems = 100;
    this.handleRegistryInvocation = this.handleRegistryInvocation.bind(this);
    this.registry.on('invocation:recorded', this.handleRegistryInvocation);
  }

  setOrchestrator(agentOrchestrator) {
    this.orchestrator = agentOrchestrator;
    return this;
  }

  estimateTokens(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
      return 0;
    }

    return Math.max(1, Math.ceil(normalized.length / 4));
  }

  inferTokenUsage(input = '', output = '', explicitUsage = 0, usageMetadata = {}) {
    const normalizedUsage = normalizeUsageMetadata(usageMetadata) || {};
    const hasPromptTokens = Object.prototype.hasOwnProperty.call(normalizedUsage, 'promptTokens');
    const hasCompletionTokens = Object.prototype.hasOwnProperty.call(normalizedUsage, 'completionTokens');
    const hasTotalTokens = Object.prototype.hasOwnProperty.call(normalizedUsage, 'totalTokens');
    const explicitCompletion = Number(explicitUsage);
    const hasExplicitUsage = hasPromptTokens
      || hasCompletionTokens
      || hasTotalTokens
      || (Number.isFinite(explicitCompletion) && explicitCompletion > 0);
    const promptTokens = hasPromptTokens
      ? normalizedUsage.promptTokens
      : (hasExplicitUsage ? 0 : this.estimateTokens(input));
    const completionTokens = hasCompletionTokens
      ? normalizedUsage.completionTokens
      : (hasTotalTokens && !hasPromptTokens
        ? normalizedUsage.totalTokens
        : (Number.isFinite(explicitCompletion) && explicitCompletion > 0)
        ? explicitCompletion
        : (hasExplicitUsage ? 0 : this.estimateTokens(output)));
    const totalTokens = hasTotalTokens
      ? normalizedUsage.totalTokens
      : (hasExplicitUsage ? (promptTokens + completionTokens) : (promptTokens + completionTokens));

    const usage = {
      promptTokens,
      completionTokens,
      totalTokens,
      inferred: !hasExplicitUsage,
    };

    ['reasoningTokens', 'cachedTokens', 'modelCalls'].forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(normalizedUsage, key)) {
        usage[key] = normalizedUsage[key];
      }
    });

    return usage;
  }

  deriveLogTokenUsage(log = {}) {
    const normalizedUsage = normalizeUsageMetadata({
      promptTokens: log.promptTokens,
      completionTokens: log.completionTokens,
      totalTokens: log.tokens,
      reasoningTokens: log.reasoningTokens,
      cachedTokens: log.cachedTokens,
      modelCalls: log.modelCalls,
    }) || {};

    const hasPromptTokens = Object.prototype.hasOwnProperty.call(normalizedUsage, 'promptTokens');
    const hasCompletionTokens = Object.prototype.hasOwnProperty.call(normalizedUsage, 'completionTokens');
    const hasTotalTokens = Object.prototype.hasOwnProperty.call(normalizedUsage, 'totalTokens');
    const totalTokens = hasTotalTokens
      ? normalizedUsage.totalTokens
      : (hasPromptTokens ? normalizedUsage.promptTokens : 0) + (hasCompletionTokens ? normalizedUsage.completionTokens : 0);
    const promptTokens = hasPromptTokens ? normalizedUsage.promptTokens : 0;
    const completionTokens = hasCompletionTokens
      ? normalizedUsage.completionTokens
      : Math.max(0, totalTokens - promptTokens);

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      inferred: log.tokenUsageInferred === true,
    };
  }

  normalizeToolEvent(event = {}) {
    const rawArgs = parseLenientJson(event?.toolCall?.function?.arguments || '{}') || {};

    const toolId = event?.toolCall?.function?.name
      || event?.result?.toolId
      || event?.toolId
      || 'unknown-tool';
    const duration = Number(event?.result?.duration || event?.duration || 0);
    const success = event?.result?.success !== false && event?.success !== false;
    const endTime = event?.result?.endedAt
      || event?.result?.timestamp
      || event?.endedAt
      || event?.timestamp
      || new Date().toISOString();
    const startTime = event?.result?.startedAt
      || event?.startedAt
      || new Date(new Date(endTime).getTime() - Math.max(0, duration)).toISOString();

    return {
      toolId,
      success,
      duration,
      reason: event?.reason || '',
      timestamp: endTime,
      startTime,
      endTime,
      error: event?.result?.error || event?.error || null,
      diagnostics: event?.result?.diagnostics || event?.diagnostics || null,
      paramKeys: Object.keys(rawArgs).sort(),
      dataPreview: typeof event?.result?.data === 'string'
        ? String(event.result.data).slice(0, 160)
        : '',
    };
  }

  extractToolUsage(metadata = {}) {
    const toolEvents = Array.isArray(metadata?.toolEvents)
      ? metadata.toolEvents.map((event) => this.normalizeToolEvent(event))
      : [];
    const skillsUsed = Array.from(new Set(toolEvents.map((event) => event.toolId).filter(Boolean)));

    return {
      toolEvents,
      skillsUsed,
      toolCallCount: toolEvents.length,
    };
  }

  normalizeExecutionTraceStep(step = {}, fallbackStartTime = null, fallbackEndTime = null) {
    const startTime = step?.startTime || fallbackStartTime || new Date().toISOString();
    const endTime = step?.endTime || fallbackEndTime || startTime;

    return {
      type: step?.type || 'runtime',
      name: step?.name || 'Runtime step',
      startTime,
      endTime,
      duration: Number(step?.duration || Math.max(0, new Date(endTime).getTime() - new Date(startTime).getTime()) || 0),
      status: step?.status || 'completed',
      details: step?.details && typeof step.details === 'object' ? step.details : {},
    };
  }

  extractExecutionTrace(metadata = {}, fallbackStartTime = null, fallbackEndTime = null) {
    const steps = Array.isArray(metadata?.executionTrace)
      ? metadata.executionTrace
      : [];

    return steps.map((step) => this.normalizeExecutionTraceStep(step, fallbackStartTime, fallbackEndTime));
  }

  extractDiagnostics(metadata = {}) {
    if (!metadata || typeof metadata !== 'object') {
      return null;
    }

    return metadata.diagnostics
      || (metadata.imageDiagnostics ? { imageGeneration: metadata.imageDiagnostics } : null)
      || metadata.imageGenerationDiagnostics
      || null;
  }

  buildTimeline(task, toolUsage, metadata = {}, { completed = true, responseId = null, output = '', duration = 0, error = '' } = {}) {
    const endTime = completed ? task.completedAt : task.failedAt;
    const traceMetadata = {
      ...(task?.metadata || {}),
      ...(metadata || {}),
    };
    const executionTrace = this.extractExecutionTrace(traceMetadata, task.createdAt, endTime);
    const diagnostics = this.extractDiagnostics(traceMetadata);
    const diagnosticSummary = formatImageDiagnosticsSummary(diagnostics);
    const hasExplicitToolCalls = executionTrace.some((step) => step.type === 'tool_call');
    const hasExplicitModelCall = executionTrace.some((step) => step.type === 'model_call');
    const fallbackToolSteps = hasExplicitToolCalls
      ? []
      : toolUsage.toolEvents.map((event) => ({
        type: 'tool_call',
        name: `Tool call (${event.toolId})`,
        startTime: event.startTime || task.createdAt,
        endTime: event.endTime || event.timestamp || endTime,
        duration: Number(event.duration || 0),
        status: event.success ? 'completed' : 'error',
        details: {
          reason: event.reason,
          paramKeys: event.paramKeys,
          error: event.error,
          diagnostics: event.diagnostics,
          diagnosticSummary: formatImageDiagnosticsSummary(event.diagnostics),
        },
      }));
    const fallbackModelStep = hasExplicitModelCall
      ? []
      : [
        completed
          ? {
            type: 'model_call',
            name: `Model response (${task.model})`,
            startTime: new Date(new Date(endTime).getTime() - Math.max(0, Number(duration || 0))).toISOString(),
            endTime,
            duration: Number(duration || 0),
            status: 'completed',
            details: {
              responseId,
              outputPreview: String(output || '').slice(0, 200),
              diagnostics,
              diagnosticSummary,
            },
          }
          : {
            type: 'model_call',
            name: `Model request failed (${task.model})`,
            startTime: new Date(new Date(endTime).getTime() - Math.max(0, Number(duration || 0))).toISOString(),
            endTime,
            duration: Number(duration || 0),
            status: 'error',
            details: {
              error,
              diagnostics,
              diagnosticSummary,
            },
          },
      ];
    const timeline = [
      {
        type: 'request',
        name: `${task.mode} request received`,
        startTime: task.createdAt,
        endTime: task.createdAt,
        duration: 0,
        status: 'completed',
        details: {
          transport: task.transport,
          sessionId: task.sessionId,
          route: traceMetadata.route,
          clientSurface: traceMetadata.clientSurface,
          requestedCount: traceMetadata.requestedCount,
          diagnostics,
          diagnosticSummary,
        },
      },
      ...executionTrace,
      ...fallbackToolSteps,
      ...fallbackModelStep,
    ].filter(Boolean);

    const orderedTimeline = timeline
      .map((entry, index) => ({ ...entry, __index: index }))
      .sort((left, right) => {
        const leftTime = new Date(left.startTime || task.createdAt).getTime();
        const rightTime = new Date(right.startTime || task.createdAt).getTime();
        if (leftTime === rightTime) {
          return left.__index - right.__index;
        }
        return leftTime - rightTime;
      });

    return orderedTimeline.map((entry, index) => {
      const { __index, ...rest } = entry;
      return {
        step: index + 1,
        ...rest,
      };
    });
  }

  buildToolUsageSummary() {
    const toolCounts = new Map();
    let totalCalls = 0;

    Array.from(this.taskStore.values()).forEach((task) => {
      const toolEvents = Array.isArray(task?.result?.toolEvents) ? task.result.toolEvents : [];
      toolEvents.forEach((event) => {
        const toolId = event?.toolId || 'unknown-tool';
        totalCalls += 1;
        toolCounts.set(toolId, (toolCounts.get(toolId) || 0) + 1);
      });
    });

    const topTools = Array.from(toolCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([toolId, count]) => ({ toolId, count }));

    return {
      totalCalls,
      distinctTools: toolCounts.size,
      topTools,
    };
  }

  handleRegistryInvocation({ id, entry = {}, stats = {} } = {}) {
    this.logActivity('tool_invoked', `Tool used: ${id}`, {
      toolId: id,
      sessionId: entry.sessionId || null,
      route: entry.route || null,
      executionProfile: entry.executionProfile || null,
      model: entry.model || null,
      success: entry.success !== false,
      duration: Number(entry.duration || 0),
      error: entry.error || null,
      invocations: Number(stats.invocations || 0),
    });
  }

  /**
   * Get dashboard statistics
   */
  async getStats(req, res) {
    try {
      const range = String(req.query.range || '24h').toLowerCase();
      const requestChart = this.buildRequestChart(range);
      const tokenSummary = this.buildTokenSummary();
      const stats = {
        overview: {
          totalTasks: this.taskStore.size,
          successfulTasks: Array.from(this.taskStore.values()).filter(t => t.status === 'completed').length,
          failedTasks: Array.from(this.taskStore.values()).filter(t => t.status === 'failed').length,
          activeSessions: this.sessionStore.size,
          totalSkills: await this.getSkillCount(),
          totalTraces: await this.getTraceCount(),
          avgResponseTime: this.calculateAvgResponseTime(),
          successRate: this.calculateSuccessRate()
        },
        requests: {
          today: this.getRequestCount('day'),
          thisWeek: this.getRequestCount('week'),
          thisMonth: this.getRequestCount('month'),
          total: this.taskStore.size,
          chart: requestChart,
        },
        tokens: tokenSummary,
        tools: this.buildToolUsageSummary(),
        models: await this.getModelUsageStats(),
        timestamp: new Date().toISOString()
      };

      res.json({ success: true, data: stats });
    } catch (error) {
      console.error('Error getting stats:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get system health status
   */
  async getHealth(req, res) {
    try {
      const health = await buildSystemHealthReport({
        app: req.app,
        startupState: req.app?.locals?.startupState || null,
      });
      res.json({ success: true, data: health });
    } catch (error) {
      console.error('Error getting health:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message,
        data: { status: 'error', timestamp: new Date().toISOString() }
      });
    }
  }

  /**
   * Get recent activity
   */
  async getRecentActivity(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 20;
      const activity = this.activityLog
        .slice(-limit)
        .reverse()
        .map(item => ({
          id: item.id,
          type: item.type,
          description: item.description,
          timestamp: item.timestamp,
          metadata: item.metadata
        }));

      res.json({ success: true, data: activity });
    } catch (error) {
      console.error('Error getting activity:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Execute a new task via SDK
   */
  async executeTask(req, res) {
    try {
      const { prompt, model, tools = [], options = {} } = req.body;
      
      if (!prompt) {
        return res.status(400).json({ success: false, error: 'Prompt is required' });
      }

      const taskId = uuidv4();
      const sessionId = options.sessionId || uuidv4();

      // Create task configuration
      const taskConfig = {
        id: taskId,
        sessionId,
        input: prompt,
        model: model || 'gpt-4o',
        tools,
        options: {
          enableTracing: true,
          enableSkills: true,
          ...options
        }
      };

      // Store task
      this.taskStore.set(taskId, {
        ...taskConfig,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      // Update session
      if (!this.sessionStore.has(sessionId)) {
        this.sessionStore.set(sessionId, {
          id: sessionId,
          tasks: [],
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString()
        });
      }
      this.sessionStore.get(sessionId).tasks.push(taskId);
      this.sessionStore.get(sessionId).lastActivity = new Date().toISOString();

      // Log activity
      this.logActivity('task_created', `Task created: ${taskId.substring(0, 8)}...`, { taskId, sessionId });

      // Execute task if orchestrator is available
      let result = null;
      if (this.orchestrator) {
        try {
          this.taskStore.get(taskId).status = 'running';
          result = await this.orchestrator.execute(taskConfig);
          
          this.taskStore.get(taskId).status = 'completed';
          this.taskStore.get(taskId).result = result;
          this.taskStore.get(taskId).completedAt = new Date().toISOString();
          
          this.logActivity('task_completed', `Task completed: ${taskId.substring(0, 8)}...`, { taskId, duration: result.duration });
        } catch (execError) {
          this.taskStore.get(taskId).status = 'failed';
          this.taskStore.get(taskId).error = execError.message;
          this.taskStore.get(taskId).failedAt = new Date().toISOString();
          
          this.logActivity('task_failed', `Task failed: ${taskId.substring(0, 8)}...`, { taskId, error: execError.message });
          throw execError;
        }
      }

      res.json({
        success: true,
        data: {
          taskId,
          sessionId,
          status: this.taskStore.get(taskId).status,
          result: result ? {
            output: result.output,
            trace: result.trace,
            skillsUsed: result.skillsUsed,
            tokensUsed: result.tokensUsed,
            duration: result.duration
          } : null
        }
      });
    } catch (error) {
      console.error('Error executing task:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Cancel a running task
   */
  async cancelTask(req, res) {
    try {
      const { taskId } = req.params;
      const task = this.taskStore.get(taskId);

      if (!task) {
        return res.status(404).json({ success: false, error: 'Task not found' });
      }

      if (task.status !== 'running') {
        return res.status(400).json({ success: false, error: 'Task is not running' });
      }

      // Cancel logic here if orchestrator supports it
      task.status = 'cancelled';
      task.cancelledAt = new Date().toISOString();

      this.logActivity('task_cancelled', `Task cancelled: ${taskId.substring(0, 8)}...`, { taskId });

      res.json({ success: true, data: { taskId, status: 'cancelled' } });
    } catch (error) {
      console.error('Error cancelling task:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get all active sessions
   */
  async getActiveSessions(req, res) {
    try {
      const sessions = Array.from(this.sessionStore.values())
        .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))
        .map(session => ({
          id: session.id,
          taskCount: session.tasks.length,
          createdAt: session.createdAt,
          lastActivity: session.lastActivity,
          isActive: (new Date() - new Date(session.lastActivity)) < 30 * 60 * 1000 // 30 min
        }));

      res.json({ success: true, data: sessions });
    } catch (error) {
      console.error('Error getting sessions:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get session details
   */
  async getSessionDetails(req, res) {
    try {
      const { id } = req.params;
      const session = this.sessionStore.get(id);

      if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }

      const tasks = session.tasks.map(taskId => {
        const task = this.taskStore.get(taskId);
        return task ? {
          id: task.id,
          status: task.status,
          input: task.input?.substring(0, 100) + '...',
          createdAt: task.createdAt,
          completedAt: task.completedAt,
          duration: task.result?.duration
        } : null;
      }).filter(Boolean);

      res.json({
        success: true,
        data: {
          ...session,
          tasks
        }
      });
    } catch (error) {
      console.error('Error getting session details:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Clear a session
   */
  async clearSession(req, res) {
    try {
      const { id } = req.params;
      
      if (!this.sessionStore.has(id)) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }

      // Remove session tasks from store
      const session = this.sessionStore.get(id);
      session.tasks.forEach(taskId => {
        this.taskStore.delete(taskId);
      });

      this.sessionStore.delete(id);

      this.logActivity('session_cleared', `Session cleared: ${id.substring(0, 8)}...`, { sessionId: id });

      res.json({ success: true, data: { sessionId: id, cleared: true } });
    } catch (error) {
      console.error('Error clearing session:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  // Helper methods

  logActivity(type, description, metadata = {}) {
    this.activityLog.push({
      id: uuidv4(),
      type,
      description,
      timestamp: new Date().toISOString(),
      metadata
    });

    // Keep only recent items
    if (this.activityLog.length > this.maxActivityItems) {
      this.activityLog = this.activityLog.slice(-this.maxActivityItems);
    }
  }

  ensureRuntimeSession(sessionId, metadata = {}) {
    if (!sessionId) {
      return null;
    }

    if (!this.sessionStore.has(sessionId)) {
      this.sessionStore.set(sessionId, {
        id: sessionId,
        tasks: [],
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        metadata,
      });
    }

    const session = this.sessionStore.get(sessionId);
    session.lastActivity = new Date().toISOString();
    session.metadata = {
      ...(session.metadata || {}),
      ...metadata,
    };
    return session;
  }

  recordRuntimeTaskStart({ sessionId, input, model, mode = 'chat', transport = 'http', metadata = {} }) {
    const taskId = uuidv4();
    const now = new Date().toISOString();
    const task = {
      id: taskId,
      sessionId,
      input,
      model: model || 'unknown',
      mode,
      transport,
      metadata,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      source: 'runtime',
    };

    this.taskStore.set(taskId, task);
    const session = this.ensureRuntimeSession(sessionId, { mode, transport });
    if (session && !session.tasks.includes(taskId)) {
      session.tasks.push(taskId);
    }

    this.logActivity('task_created', `${mode} request started`, {
      taskId,
      sessionId,
      model: task.model,
      transport,
    });

    return task;
  }

  recordRuntimeTaskComplete(taskId, { responseId, output = '', model, duration = 0, tokensUsed = 0, metadata = {} } = {}) {
    const task = this.taskStore.get(taskId);
    if (!task) {
      return null;
    }

    const tokenUsage = this.inferTokenUsage(task.input, output, tokensUsed, metadata?.usage || metadata?.tokenUsage || {});
    const toolUsage = this.extractToolUsage(metadata);
    const diagnostics = this.extractDiagnostics(metadata);

    task.status = 'completed';
    task.model = model || task.model;
    task.completedAt = new Date().toISOString();
    task.updatedAt = task.completedAt;
    task.result = {
      output,
      duration,
      tokensUsed: tokenUsage.totalTokens,
      tokenUsage,
      responseId,
      toolEvents: toolUsage.toolEvents,
      skillsUsed: toolUsage.skillsUsed,
      toolCallCount: toolUsage.toolCallCount,
      metadata,
    };

    logsController.addLog({
      level: 'info',
      model: task.model,
      prompt: task.input,
      response: String(output || '').slice(0, 2000),
      tokens: tokenUsage.totalTokens,
      promptTokens: tokenUsage.promptTokens,
      completionTokens: tokenUsage.completionTokens,
      reasoningTokens: tokenUsage.reasoningTokens,
      cachedTokens: tokenUsage.cachedTokens,
      modelCalls: tokenUsage.modelCalls,
      tokenUsageInferred: tokenUsage.inferred,
      latency: Number(duration || 0),
      status: 'success',
      message: `${task.mode} request completed`,
      taskId,
      route: task.mode,
      transport: task.transport,
      sessionId: task.sessionId,
      responseId,
      toolCalls: toolUsage.toolCallCount,
      toolsUsed: toolUsage.skillsUsed,
      diagnostics,
    });

    tracesController.addTrace({
      id: `trace-${taskId}`,
      taskId,
      sessionId: task.sessionId,
      status: 'completed',
      startTime: task.createdAt,
      endTime: task.completedAt,
      duration: Number(duration || 0),
      model: task.model,
      input: task.input,
      output: String(output || '').slice(0, 4000),
      timeline: this.buildTimeline(task, toolUsage, metadata, {
        completed: true,
        responseId,
        output,
        duration,
      }),
      metrics: {
        totalTokens: tokenUsage.totalTokens,
        promptTokens: tokenUsage.promptTokens,
        completionTokens: tokenUsage.completionTokens,
        toolCalls: toolUsage.toolCallCount,
        retries: 0,
      },
      createdAt: task.createdAt,
    });

    this.ensureRuntimeSession(task.sessionId, { mode: task.mode, transport: task.transport });
    this.logActivity('task_completed', `${task.mode} request completed`, {
      taskId,
      sessionId: task.sessionId,
      model: task.model,
      duration: Number(duration || 0),
      tokens: tokenUsage.totalTokens,
      responseId,
      toolsUsed: toolUsage.skillsUsed,
      toolCalls: toolUsage.toolCallCount,
      diagnostics,
    });

    return task;
  }

  recordRuntimeTaskError(taskId, { error, model, duration = 0, metadata = {} } = {}) {
    const task = this.taskStore.get(taskId);
    if (!task) {
      return null;
    }

    const tokenUsage = this.inferTokenUsage(task.input, '', 0, metadata?.usage || metadata?.tokenUsage || {});
    const toolUsage = this.extractToolUsage(metadata);
    const diagnostics = this.extractDiagnostics(metadata);

    task.status = 'failed';
    task.model = model || task.model;
    task.failedAt = new Date().toISOString();
    task.updatedAt = task.failedAt;
    task.error = error?.message || String(error || 'Unknown error');
    task.metadata = {
      ...(task.metadata || {}),
      ...metadata,
    };
    task.result = {
      ...(task.result || {}),
      toolEvents: toolUsage.toolEvents,
      skillsUsed: toolUsage.skillsUsed,
      toolCallCount: toolUsage.toolCallCount,
    };

    logsController.addLog({
      level: 'error',
      model: task.model,
      prompt: task.input,
      response: '',
      tokens: tokenUsage.totalTokens,
      promptTokens: tokenUsage.promptTokens,
      completionTokens: tokenUsage.completionTokens,
      reasoningTokens: tokenUsage.reasoningTokens,
      cachedTokens: tokenUsage.cachedTokens,
      modelCalls: tokenUsage.modelCalls,
      tokenUsageInferred: tokenUsage.inferred,
      latency: Number(duration || 0),
      status: 'error',
      message: task.error,
      taskId,
      route: task.mode,
      transport: task.transport,
      sessionId: task.sessionId,
      error: task.error,
      toolCalls: toolUsage.toolCallCount,
      toolsUsed: toolUsage.skillsUsed,
      diagnostics,
    });

    tracesController.addTrace({
      id: `trace-${taskId}`,
      taskId,
      sessionId: task.sessionId,
      status: 'failed',
      startTime: task.createdAt,
      endTime: task.failedAt,
      duration: Number(duration || 0),
      model: task.model,
      input: task.input,
      output: '',
      timeline: this.buildTimeline(task, toolUsage, metadata, {
        completed: false,
        duration,
        error: task.error,
      }),
      metrics: {
        totalTokens: tokenUsage.totalTokens,
        promptTokens: tokenUsage.promptTokens,
        completionTokens: tokenUsage.completionTokens,
        toolCalls: toolUsage.toolCallCount,
        retries: 0,
      },
      createdAt: task.createdAt,
    });

    this.ensureRuntimeSession(task.sessionId, { mode: task.mode, transport: task.transport });
    this.logActivity('task_failed', `${task.mode} request failed`, {
      taskId,
      sessionId: task.sessionId,
      model: task.model,
      duration: Number(duration || 0),
      error: task.error,
      toolsUsed: toolUsage.skillsUsed,
      toolCalls: toolUsage.toolCallCount,
      diagnostics,
    });

    return task;
  }

  async getSkillCount() {
    if (this.orchestrator?.skillMemory) {
      try {
        return await this.orchestrator.skillMemory.count() || 0;
      } catch {
        return 0;
      }
    }
    return 0;
  }

  async getTraceCount() {
    return tracesController.traces.size;
  }

  calculateAvgResponseTime() {
    const completed = Array.from(this.taskStore.values())
      .filter(t => t.result?.duration);
    
    if (completed.length === 0) return 0;
    
    const total = completed.reduce((sum, t) => sum + (t.result.duration || 0), 0);
    return Math.round(total / completed.length);
  }

  calculateSuccessRate() {
    const completed = Array.from(this.taskStore.values())
      .filter(t => t.status === 'completed' || t.status === 'failed');
    
    if (completed.length === 0) return 100;
    
    const successful = completed.filter(t => t.status === 'completed').length;
    return Math.round((successful / completed.length) * 100);
  }

  getRequestCount(period) {
    const now = new Date();
    const tasks = Array.from(this.taskStore.values());

    return tasks.filter(t => {
      const created = new Date(t.createdAt);
      const diff = now - created;
      
      switch (period) {
        case 'day':
          return diff < 24 * 60 * 60 * 1000;
        case 'week':
          return diff < 7 * 24 * 60 * 60 * 1000;
        case 'month':
          return diff < 30 * 24 * 60 * 60 * 1000;
        default:
          return true;
      }
    }).length;
  }

  async getModelUsageStats() {
    const modelCounts = {};
    
    Array.from(this.taskStore.values()).forEach(task => {
      const model = task.model || 'unknown';
      modelCounts[model] = (modelCounts[model] || 0) + 1;
    });

    return Object.entries(modelCounts).map(([name, count]) => ({
      name,
      count,
      percentage: this.taskStore.size > 0 ? Math.round((count / this.taskStore.size) * 100) : 0
    }));
  }

  async checkVectorStore() {
    const sdkVectorStore = this.orchestrator?.vectorStore || this.orchestrator?.skillMemory?.vectorStore;
    const candidate = sdkVectorStore || vectorStore;

    if (!candidate) {
      return 'not_configured';
    }

    try {
      if (typeof candidate.healthCheck === 'function') {
        return (await candidate.healthCheck()) ? 'connected' : 'disconnected';
      }
      if (typeof candidate.health === 'function') {
        await candidate.health();
        return 'connected';
      }
      return 'available';
    } catch {
      return 'disconnected';
    }
  }

  async checkLLMClient() {
    if (this.orchestrator?.llmClient?.complete || this.orchestrator?.llmClient?.createResponse) {
      return 'connected';
    }
    return 'not_configured';
  }

  async checkEmbedder() {
    if (this.orchestrator?.embedder) {
      try {
        if (typeof this.orchestrator.embedder.healthCheck === 'function') {
          return (await this.orchestrator.embedder.healthCheck()) ? 'connected' : 'disconnected';
        }
      } catch {
        return 'disconnected';
      }

      return 'connected';
    }
    return 'not_configured';
  }

  buildRequestChart(range = '24h') {
    const tasks = Array.from(this.taskStore.values());
    const now = Date.now();
    const presets = {
      '1h': { bucketMs: 5 * 60 * 1000, buckets: 12, label: '5m' },
      '24h': { bucketMs: 60 * 60 * 1000, buckets: 24, label: '1h' },
      '7d': { bucketMs: 24 * 60 * 60 * 1000, buckets: 7, label: '1d' },
      '30d': { bucketMs: 24 * 60 * 60 * 1000, buckets: 30, label: '1d' },
    };
    const config = presets[range] || presets['24h'];
    const start = now - (config.bucketMs * config.buckets);

    const points = Array.from({ length: config.buckets }, (_, index) => {
      const bucketStart = start + (index * config.bucketMs);
      const bucketEnd = bucketStart + config.bucketMs;
      const count = tasks.filter((task) => {
        const createdAt = new Date(task.createdAt || 0).getTime();
        return createdAt >= bucketStart && createdAt < bucketEnd;
      }).length;

      return {
        label: config.bucketMs >= 24 * 60 * 60 * 1000
          ? new Date(bucketStart).toLocaleDateString([], { month: 'short', day: 'numeric' })
          : new Date(bucketStart).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        value: count,
      };
    });

    return {
      range,
      bucket: config.label,
      labels: points.map((point) => point.label),
      values: points.map((point) => point.value),
      maxValue: Math.max(...points.map((point) => point.value), 0),
    };
  }

  buildTokenSummary() {
    const successLogs = (logsController.logs || [])
      .filter((log) => log.status !== 'error' && Number.isFinite(Number(log.tokens)));

    if (successLogs.length > 0) {
      return successLogs.reduce((summary, log) => {
        const usage = this.deriveLogTokenUsage(log);
        summary.total += usage.totalTokens;
        summary.prompt += usage.promptTokens;
        summary.completion += usage.completionTokens;
        summary.inferredRequests += usage.inferred ? 1 : 0;
        summary.requests += 1;
        return summary;
      }, {
        total: 0,
        prompt: 0,
        completion: 0,
        inferredRequests: 0,
        requests: 0,
        source: 'logs',
      });
    }

    const completedTasks = Array.from(this.taskStore.values())
      .filter((task) => task.status === 'completed');

    return completedTasks.reduce((summary, task) => {
      const usage = task.result?.tokenUsage || this.inferTokenUsage(task.input, task.result?.output || '', task.result?.tokensUsed || 0);
      summary.total += usage.totalTokens;
      summary.prompt += usage.promptTokens;
      summary.completion += usage.completionTokens;
      summary.inferredRequests += usage.inferred ? 1 : 0;
      summary.requests += 1;
      return summary;
    }, {
      total: 0,
      prompt: 0,
      completion: 0,
      inferredRequests: 0,
      requests: 0,
      source: 'runtime',
    });
  }
}

module.exports = DashboardController;
