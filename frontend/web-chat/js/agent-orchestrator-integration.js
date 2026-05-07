/**
 * Agent SDK Integration for Web Chat Frontend
 * 
 * Integrates the LillyBuilt Agent SDK with the web chat interface
 * providing enhanced AI capabilities with traceability and skill learning.
 */

(function() {
  'use strict';

  function extractMessageText(value) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return '';

      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          const parsed = JSON.parse(trimmed);
          const extracted = extractMessageText(parsed);
          if (extracted) return extracted;
        } catch (_error) {
          // Ignore parse failures and fall back to the raw string.
        }
      }

      return trimmed;
    }

    if (Array.isArray(value)) {
      return value.map((item) => extractMessageText(item)).filter(Boolean).join('');
    }

    if (!value || typeof value !== 'object') {
      return '';
    }

    return extractMessageText(
      value.output_text
      ?? value.text
      ?? value.content
      ?? value.message
      ?? value.response
      ?? value.output
      ?? value.data
      ?? ''
    );
  }
  
  // Check if Agent SDK is available
  if (typeof AgentOrchestrator === 'undefined') {
    console.warn('[Agent Integration] Agent SDK not loaded');
    return;
  }

  const gatewayHelpers = window.KimiBuiltGatewaySSE || {};
  const buildGatewayHeaders = gatewayHelpers.buildGatewayHeaders || ((headers = {}) => ({
    ...headers,
    Authorization: 'Bearer any-key',
  }));
  const resolvePreferredChatModel = gatewayHelpers.resolvePreferredChatModel || ((_models, preferredModel = '', fallbackModel = 'auto') => (
    String(preferredModel || '').trim() || fallbackModel
  ));
  
  /**
   * ChatAgentBridge - Bridges the Agent SDK with the Web Chat
   */
  class ChatAgentBridge {
    constructor() {
      this.orchestrator = null;
      this.currentTrace = null;
      this.isInitialized = false;
      this.sessionContext = new Map();
    }
    
    /**
     * Initialize the agent bridge
     */
    async init() {
      if (this.isInitialized) return;
      
      // Create LLM client using existing OpenAI SDK integration
      const llmClient = {
        complete: async (prompt, options = {}) => {
          const model = resolvePreferredChatModel([], options.model || window.ChatAPI?.getSelectedModel?.(), 'auto');
          
          const messages = [
            { role: 'system', content: this.getSystemPrompt() },
            ...(options.history || []),
            { role: 'user', content: prompt }
          ];
          
          const response = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: buildGatewayHeaders({ 'Content-Type': 'application/json' }),
            credentials: 'same-origin',
            body: JSON.stringify({
              model,
              messages,
              stream: false,
              temperature: options.temperature || 0.7,
              enableConversationExecutor: true,
              taskType: 'chat',
              clientSurface: 'web-chat',
              metadata: {
                clientSurface: 'web-chat',
                sessionIsolation: true,
                enableConversationExecutor: true,
              },
            })
          });
          
          const data = await response.json();
          return extractMessageText(data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.message ?? data);
        },
        
        completeStream: async (prompt, options = {}) => {
          const model = resolvePreferredChatModel([], options.model || window.ChatAPI?.getSelectedModel?.(), 'auto');
          
          const messages = [
            { role: 'system', content: this.getSystemPrompt() },
            ...(options.history || []),
            { role: 'user', content: prompt }
          ];
          
          const response = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: buildGatewayHeaders({ 'Content-Type': 'application/json' }),
            credentials: 'same-origin',
            body: JSON.stringify({
              model,
              messages,
              stream: true,
              temperature: options.temperature || 0.7,
              enableConversationExecutor: true,
              taskType: 'chat',
              clientSurface: 'web-chat',
              metadata: {
                clientSurface: 'web-chat',
                sessionIsolation: true,
                enableConversationExecutor: true,
              },
            })
          });
          
          return response.body;
        }
      };
      
      // Create embedder
      const embedder = {
        embed: async (text) => {
          const response = await fetch('/v1/embeddings', {
            method: 'POST',
            headers: buildGatewayHeaders({ 'Content-Type': 'application/json' }),
            credentials: 'same-origin',
            body: JSON.stringify({ input: text, model: 'text-embedding-3-small' })
          });
          const data = await response.json();
          return data.data[0].embedding;
        }
      };
      
      // Create orchestrator
      this.orchestrator = new AgentOrchestrator({
        llmClient,
        embedder,
        config: {
          enableTracing: true,
          enableSkills: true,
          maxRetries: 3
        }
      });
      
      // Register chat-specific tools
      this.registerChatTools();
      
      // Set up event handlers
      this.setupEventHandlers();
      
      this.isInitialized = true;
      console.log('[Agent Integration] Chat bridge initialized');
    }
    
    /**
     * Get system prompt for chat context
     */
    getSystemPrompt() {
      return `You are an AI assistant integrated into the Lilly Web Chat interface. 
You have access to tools for enhanced task execution.
When appropriate, use the available tools to provide better responses.
Always be helpful, accurate, and concise.`;
    }
    
    /**
     * Register tools for chat operations
     */
    registerChatTools() {
      const { ToolDefinition } = AgentOrchestrator;
      
      // Message sending tool
      this.orchestrator.registerTool(new ToolDefinition({
        id: 'chat-send-message',
        name: 'Send Chat Message',
        description: 'Send a message to the chat interface',
        inputSchema: {
          type: 'object',
          required: ['content'],
          properties: {
            content: { type: 'string' },
            role: { type: 'string', enum: ['user', 'assistant', 'system'] },
            metadata: { type: 'object' }
          }
        },
        sideEffects: ['write'],
        handler: async (input) => {
          const { content, role = 'assistant', metadata = {} } = input;
          
          if (window.ChatUI && window.ChatUI.addMessage) {
            window.ChatUI.addMessage({
              role,
              content,
              metadata,
              timestamp: new Date().toISOString()
            });
          }
          
          return { success: true, messageId: this.generateMessageId() };
        }
      }));
      
      // Session management tool
      this.orchestrator.registerTool(new ToolDefinition({
        id: 'chat-manage-session',
        name: 'Manage Chat Session',
        description: 'Create, switch, or clear chat sessions',
        inputSchema: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['create', 'switch', 'clear', 'rename'] },
            sessionId: { type: 'string' },
            name: { type: 'string' }
          }
        },
        sideEffects: ['write'],
        handler: async (input) => {
          const { action, sessionId, name } = input;
          
          switch (action) {
            case 'create':
              if (window.SessionManager && window.SessionManager.create) {
                const newSession = window.SessionManager.create(name);
                return { success: true, session: newSession };
              }
              break;
              
            case 'switch':
              if (window.SessionManager && window.SessionManager.switch) {
                window.SessionManager.switch(sessionId);
                return { success: true, sessionId };
              }
              break;
              
            case 'clear':
              if (window.ChatUI && window.ChatUI.clearMessages) {
                window.ChatUI.clearMessages();
                this.sessionContext.clear();
                return { success: true, message: 'Session cleared' };
              }
              break;
              
            case 'rename':
              if (window.SessionManager && window.SessionManager.rename) {
                window.SessionManager.rename(sessionId, name);
                return { success: true, sessionId, name };
              }
              break;
          }
          
          return { success: false, error: 'Session management not available' };
        }
      }));
      
      // Model selection tool
      this.orchestrator.registerTool(new ToolDefinition({
        id: 'chat-select-model',
        name: 'Select AI Model',
        description: 'Change the AI model for the current session',
        inputSchema: {
          type: 'object',
          required: ['modelId'],
          properties: {
            modelId: { type: 'string' },
            provider: { type: 'string' }
          }
        },
        sideEffects: ['write'],
        handler: async (input) => {
          const { modelId, provider } = input;
          
          if (window.ModelSelector && window.ModelSelector.select) {
            window.ModelSelector.select(modelId);
            
            if (window.ChatUI && window.ChatUI.showToast) {
              window.ChatUI.showToast(`Switched to ${modelId}`, 'info');
            }
            
            return { success: true, model: modelId, provider };
          }
          
          return { success: false, error: 'Model selector not available' };
        }
      }));
      
      // Export conversation tool
      this.orchestrator.registerTool(new ToolDefinition({
        id: 'chat-export',
        name: 'Export Conversation',
        description: 'Export the current conversation',
        inputSchema: {
          type: 'object',
          required: ['format'],
          properties: {
            format: { type: 'string', enum: ['markdown', 'json', 'txt'] },
            filename: { type: 'string' }
          }
        },
        sideEffects: ['read'],
        handler: async (input) => {
          const { format, filename } = input;
          
          const messages = window.ChatUI ? window.ChatUI.getMessages() : [];
          
          let exportContent;
          let defaultFilename;
          let mimeType;
          
          switch (format) {
            case 'markdown':
              exportContent = messages.map(m => {
                const role = m.role === 'assistant' ? 'AI' : 'User';
                return `## ${role}\n\n${m.content}\n`;
              }).join('\n---\n\n');
              defaultFilename = `chat-${Date.now()}.md`;
              mimeType = 'text/markdown';
              break;
              
            case 'json':
              exportContent = JSON.stringify({
                messages,
                exportedAt: new Date().toISOString(),
                model: window.ChatAPI?.getSelectedModel?.()
              }, null, 2);
              defaultFilename = `chat-${Date.now()}.json`;
              mimeType = 'application/json';
              break;
              
            case 'txt':
              exportContent = messages.map(m => {
                const role = m.role === 'assistant' ? 'AI' : 'User';
                return `${role}: ${m.content}`;
              }).join('\n\n---\n\n');
              defaultFilename = `chat-${Date.now()}.txt`;
              mimeType = 'text/plain';
              break;
              
            default:
              return { success: false, error: 'Unsupported format' };
          }
          
          // Trigger download
          const blob = new Blob([exportContent], { type: mimeType });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename || defaultFilename;
          a.click();
          URL.revokeObjectURL(url);
          
          return { success: true, format, filename: filename || defaultFilename };
        }
      }));
      
      // Search messages tool
      this.orchestrator.registerTool(new ToolDefinition({
        id: 'chat-search',
        name: 'Search Messages',
        description: 'Search through conversation history',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string' },
            caseSensitive: { type: 'boolean', default: false }
          }
        },
        sideEffects: ['read'],
        handler: async (input) => {
          const { query, caseSensitive = false } = input;
          
          const messages = window.ChatUI ? window.ChatUI.getMessages() : [];
          
          const results = messages.map((m, index) => ({
            index,
            message: m,
            matches: this.searchInMessage(m.content, query, caseSensitive)
          })).filter(r => r.matches.length > 0);
          
          // Highlight results in UI
          if (window.ChatUI && window.ChatUI.highlightSearchResults) {
            window.ChatUI.highlightSearchResults(results);
          }
          
          return { 
            success: true, 
            query,
            resultsCount: results.length,
            results
          };
        }
      }));
      
      // Image generation tool
      this.orchestrator.registerTool(new ToolDefinition({
        id: 'chat-generate-image',
        name: 'Generate Image',
        description: 'Generate an image using the custom OpenAI-compatible image endpoint',
        inputSchema: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string' },
            model: { type: 'string' },
            size: { type: 'string', enum: ['auto', '1024x1024', '1536x1024', '1024x1536'] },
            quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
            style: { type: 'string' }
          }
        },
        sideEffects: ['write'],
        handler: async (input) => {
          const { prompt, model = null, size = 'auto', quality = 'auto', style = null } = input;
          
          if (window.ImageGenerator && window.ImageGenerator.generate) {
            const result = await window.ImageGenerator.generate({
              prompt,
              model,
              size,
              quality,
              style
            });
            
            // Add image message to chat
            if (window.ChatUI && window.ChatUI.addImageMessage) {
              window.ChatUI.addImageMessage({
                url: result.url,
                prompt: result.revisedPrompt || prompt,
                metadata: { model, size, quality, style }
              });
            }
            
            return { success: true, url: result.url, revisedPrompt: result.revisedPrompt };
          }
          
          return { success: false, error: 'Image generator not available' };
        }
      }));
    }
    
    /**
     * Search within message content
     */
    searchInMessage(content, query, caseSensitive) {
      const searchContent = caseSensitive ? content : content.toLowerCase();
      const searchQuery = caseSensitive ? query : query.toLowerCase();
      
      const matches = [];
      let index = 0;
      
      while ((index = searchContent.indexOf(searchQuery, index)) !== -1) {
        matches.push({
          start: index,
          end: index + query.length,
          context: content.substring(Math.max(0, index - 20), Math.min(content.length, index + query.length + 20))
        });
        index += query.length;
      }
      
      return matches;
    }
    
    /**
     * Set up event handlers
     */
    setupEventHandlers() {
      this.orchestrator.on('task:start', ({ task }) => {
        console.log('[Agent] Chat task started:', task.id);
        
        // Show typing indicator
        if (window.ChatUI && window.ChatUI.showTyping) {
          window.ChatUI.showTyping(true);
        }
      });
      
      this.orchestrator.on('task:complete', ({ task, result }) => {
        console.log('[Agent] Chat task completed:', task.id);
        this.currentTrace = result.trace;
        
        // Hide typing indicator
        if (window.ChatUI && window.ChatUI.showTyping) {
          window.ChatUI.showTyping(false);
        }
        
        // Add assistant message if result is text
        if (result.output && typeof result.output === 'string') {
          if (window.ChatUI && window.ChatUI.addMessage) {
            window.ChatUI.addMessage({
              role: 'assistant',
              content: result.output,
              metadata: {
                traceId: result.trace?.id,
                toolsUsed: result.toolsUsed || []
              }
            });
          }
        }
      });
      
      this.orchestrator.on('task:error', ({ task, error }) => {
        console.error('[Agent] Chat task error:', error);
        
        if (window.ChatUI && window.ChatUI.showTyping) {
          window.ChatUI.showTyping(false);
        }
        
        if (window.ChatUI && window.ChatUI.showToast) {
          window.ChatUI.showToast(`Error: ${error.message}`, 'error');
        }
      });
      
      this.orchestrator.on('skill:captured', ({ skill }) => {
        console.log('[Agent] Skill captured:', skill.name);
        if (window.ChatUI && window.ChatUI.showToast) {
          window.ChatUI.showToast(`Learned new interaction pattern: ${skill.name}`, 'success');
        }
      });
    }
    
    /**
     * Execute an agent task
     */
    async executeTask(objective, options = {}) {
      await this.init();
      
      const sessionId = this.getSessionId();
      const history = window.ChatUI ? window.ChatUI.getMessages() : [];
      
      const result = await this.orchestrator.execute({
        type: options.type || 'chat-interaction',
        objective,
        input: {
          message: options.message || objective,
          history: history.slice(-10), // Last 10 messages for context
          sessionId,
          ...options.input
        },
        output: {
          format: 'text',
          destination: 'chat'
        },
        tools: options.tools || ['chat-send-message', 'chat-export', 'chat-search'],
        completionCriteria: {
          conditions: ['response-delivered', 'no-errors']
        }
      }, {
        sessionId,
        useSkills: true
      });
      
      return result;
    }
    
    /**
     * Get current session ID
     */
    getSessionId() {
      return window.SessionManager && window.SessionManager.getCurrentSessionId 
        ? window.SessionManager.getCurrentSessionId() 
        : 'chat-session-' + Date.now();
    }
    
    /**
     * Generate unique message ID
     */
    generateMessageId() {
      return 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    }
  }
  
  // Create global instance
  window.ChatAgentBridge = new ChatAgentBridge();
  
  // Override existing sendMessage if available
  if (typeof window.ChatAPI !== 'undefined' && window.ChatAPI.sendMessage) {
    const originalSendMessage = window.ChatAPI.sendMessage;
    window.ChatAPI.sendMessage = async function(message, options = {}) {
      // Use orchestrator for complex multi-step tasks
      if (message.toLowerCase().includes('export') ||
          message.toLowerCase().includes('search') ||
          message.toLowerCase().includes('switch to') ||
          message.toLowerCase().includes('generate image')) {
        return window.ChatAgentBridge.executeTask(message, {
          type: 'chat-interaction',
          message,
          useOrchestrator: true
        });
      }
      
      // Fall back to original for simple chat
      return originalSendMessage.call(this, message, options);
    };
  }
  
})();
