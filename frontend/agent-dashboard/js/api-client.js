/**
 * Agent SDK Admin Dashboard - API Client
 * Handles all HTTP communication with the backend API
 */

function safeLocalStorageSet(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (_error) {
        return false;
    }
}

function safeLocalStorageRemove(key) {
    try {
        localStorage.removeItem(key);
        return true;
    } catch (_error) {
        return false;
    }
}

class ApiClient {
    constructor(options = {}) {
        this.baseUrl = options.baseUrl || '';
        this.apiKey = options.apiKey || '';
        this.timeout = options.timeout || 30000;
        this.maxRetries = options.maxRetries || 3;
        this.retryDelay = options.retryDelay || 1000;
        
        // Request interceptors
        this.requestInterceptors = [];
        
        // Response interceptors
        this.responseInterceptors = [];
        
        // Default headers
        this.defaultHeaders = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
        };
    }
    
    /**
     * Add a request interceptor
     */
    addRequestInterceptor(interceptor) {
        this.requestInterceptors.push(interceptor);
        return () => {
            const index = this.requestInterceptors.indexOf(interceptor);
            if (index > -1) {
                this.requestInterceptors.splice(index, 1);
            }
        };
    }
    
    /**
     * Add a response interceptor
     */
    addResponseInterceptor(interceptor) {
        this.responseInterceptors.push(interceptor);
        return () => {
            const index = this.responseInterceptors.indexOf(interceptor);
            if (index > -1) {
                this.responseInterceptors.splice(index, 1);
            }
        };
    }
    
    /**
     * Build the full URL
     */
    buildUrl(path) {
        if (path.startsWith('http')) {
            return path;
        }
        const base = this.baseUrl.replace(/\/$/, '');
        const cleanPath = path.startsWith('/') ? path : `/${path}`;
        return `${base}${cleanPath}`;
    }
    
    /**
     * Build request headers
     */
    buildHeaders(customHeaders = {}) {
        const headers = { ...this.defaultHeaders };
        
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }
        
        // Apply request interceptors
        let config = { headers: { ...headers, ...customHeaders } };
        this.requestInterceptors.forEach(interceptor => {
            config = interceptor(config) || config;
        });
        
        return config.headers;
    }
    
    /**
     * Make an HTTP request with retry logic
     */
    async request(method, path, data = null, options = {}) {
        const url = this.buildUrl(path);
        const headers = this.buildHeaders(options.headers);
        
        const fetchOptions = {
            method: method.toUpperCase(),
            headers,
            credentials: options.credentials || 'same-origin',
            ...options.fetchOptions
        };
        
        if (data && method.toLowerCase() !== 'get') {
            fetchOptions.body = typeof data === 'string' ? data : JSON.stringify(data);
        }
        
        // Add query params for GET requests
        let finalUrl = url;
        if (data && method.toLowerCase() === 'get') {
            const params = new URLSearchParams();
            Object.entries(data).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    params.append(key, String(value));
                }
            });
            if (params.toString()) {
                finalUrl += `?${params.toString()}`;
            }
        }
        
        let lastError;
        
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), options.timeout || this.timeout);
                
                fetchOptions.signal = controller.signal;
                
                const response = await fetch(finalUrl, fetchOptions);
                clearTimeout(timeoutId);
                
                // Handle HTTP errors
                if (!response.ok) {
                    throw await this.handleHttpError(response);
                }
                
                // Parse response
                const result = await this.parseResponse(response, options.responseType);
                
                // Apply response interceptors
                let processedResult = result;
                this.responseInterceptors.forEach(interceptor => {
                    processedResult = interceptor(processedResult, response) || processedResult;
                });
                
                return processedResult;
                
            } catch (error) {
                lastError = error;
                
                // Don't retry on certain errors
                if (error.name === 'AbortError' || 
                    (error.status >= 400 && error.status < 500 && error.status !== 429)) {
                    throw error;
                }
                
                // Wait before retrying
                if (attempt < this.maxRetries - 1) {
                    const delay = this.retryDelay * Math.pow(2, attempt);
                    await this.sleep(delay);
                }
            }
        }
        
        throw lastError;
    }
    
    /**
     * Handle HTTP errors
     */
    async handleHttpError(response) {
        let errorData;
        
        try {
            errorData = await response.json();
        } catch {
            errorData = { message: response.statusText };
        }
        
        const normalizedMessage = errorData?.message || errorData?.error?.message || errorData?.error || `HTTP ${response.status}: ${response.statusText}`;
        const error = new Error(normalizedMessage);
        error.status = response.status;
        error.statusText = response.statusText;
        error.data = errorData;
        error.response = response;
        
        // Add user-friendly messages for common errors
        switch (response.status) {
            case 400:
                error.userMessage = 'Invalid request. Please check your input.';
                break;
            case 401:
                error.userMessage = 'Your login session is missing or expired. Sign in again.';
                break;
            case 403:
                error.userMessage = 'You don\'t have permission to perform this action.';
                break;
            case 404:
                error.userMessage = 'The requested resource was not found.';
                break;
            case 429:
                error.userMessage = 'Too many requests. Please wait a moment.';
                break;
            case 500:
            case 502:
            case 503:
            case 504:
                error.userMessage = 'Server error. Please try again later.';
                break;
            default:
                error.userMessage = error.message;
        }
        
        return error;
    }
    
    /**
     * Parse response based on content type
     */
    async parseResponse(response, responseType) {
        if (responseType === 'blob') {
            return response.blob();
        }
        
        if (responseType === 'text') {
            return response.text();
        }
        
        if (responseType === 'arraybuffer') {
            return response.arrayBuffer();
        }
        
        // Default: try to parse as JSON
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            return response.json();
        }
        
        // Try JSON anyway, fall back to text
        try {
            return await response.json();
        } catch {
            return response.text();
        }
    }
    
    /**
     * Sleep utility for retry delays
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    persistApiKey(value = '') {
        this.apiKey = String(value || '');
        return safeLocalStorageSet('api_key', this.apiKey);
    }

    clearPersistedApiKey() {
        this.apiKey = '';
        return safeLocalStorageRemove('api_key');
    }
    
    // ==================== HTTP METHODS ====================
    
    /**
     * GET request
     */
    async get(path, params = null, options = {}) {
        return this.request('get', path, params, options);
    }
    
    /**
     * POST request
     */
    async post(path, data = null, options = {}) {
        return this.request('post', path, data, options);
    }
    
    /**
     * PUT request
     */
    async put(path, data = null, options = {}) {
        return this.request('put', path, data, options);
    }
    
    /**
     * PATCH request
     */
    async patch(path, data = null, options = {}) {
        return this.request('patch', path, data, options);
    }
    
    /**
     * DELETE request
     */
    async delete(path, options = {}) {
        return this.request('delete', path, null, options);
    }
    
    // ==================== ADMIN API METHODS ====================
    
    /**
     * Get dashboard statistics
     */
    async getStats() {
        return this.get('/api/admin/stats');
    }
    
    /**
     * Get all prompts
     */
    async getPrompts() {
        return this.get('/api/admin/prompts');
    }
    
    /**
     * Get a specific prompt
     */
    async getPrompt(id) {
        return this.get(`/api/admin/prompts/${id}`);
    }
    
    /**
     * Create a new prompt
     */
    async createPrompt(prompt) {
        return this.post('/api/admin/prompts', prompt);
    }
    
    /**
     * Update a prompt
     */
    async updatePrompt(id, prompt) {
        return this.put(`/api/admin/prompts/${id}`, prompt);
    }
    
    /**
     * Delete a prompt
     */
    async deletePrompt(id) {
        return this.delete(`/api/admin/prompts/${id}`);
    }
    
    /**
     * Get prompt history
     */
    async getPromptHistory(id) {
        return this.get(`/api/admin/prompts/${id}/history`);
    }
    
    /**
     * Get all models
     */
    async getModels() {
        return this.get('/api/admin/models');
    }
    
    /**
     * Get model details
     */
    async getModel(id) {
        return this.get(`/api/admin/models/${id}`);
    }
    
    /**
     * Update model configuration
     */
    async updateModel(id, config) {
        return this.put(`/api/admin/models/${id}`, config);
    }
    
    /**
     * Get default configuration
     */
    async getDefaultConfig() {
        return this.get('/api/admin/settings');
    }
    
    /**
     * Update default configuration
     */
    async updateDefaultConfig(config) {
        return this.put('/api/admin/settings', config);
    }
    
    /**
     * Get logs with pagination
     */
    async getLogs(page = 1, limit = 50, filters = {}) {
        return this.get('/api/admin/logs', { page, limit, ...filters });
    }
    
    /**
     * Get single log entry
     */
    async getLog(id) {
        return this.get(`/api/admin/logs/${id}`);
    }
    
    /**
     * Clear all logs
     */
    async clearLogs() {
        return this.post('/api/admin/logs/clear');
    }
    
    /**
     * Export logs
     */
    async exportLogs(format = 'json', filters = {}) {
        return this.get(`/api/admin/logs/export/${format}`, filters, {
            responseType: 'blob'
        });
    }
    
    /**
     * Get all skills
     */
    async getSkills() {
        return this.get('/api/admin/skills');
    }

    /**
     * Get frontend-visible tools from the live registry
     */
    async getTools(category = null) {
        return this.get('/api/tools/available', {
            ...(category ? { category } : {}),
            includeAll: true,
        });
    }

    /**
     * Get detailed tool documentation
     */
    async getToolDocumentation(id) {
        return this.get(`/api/tools/docs/${id}`);
    }
    
    /**
     * Get skill details
     */
    async getSkill(id) {
        return this.get(`/api/admin/skills/${id}`);
    }
    
    /**
     * Enable/disable a skill
     */
    async toggleSkill(id, enabled) {
        return this.post(`/api/admin/skills/${id}/${enabled ? 'enable' : 'disable'}`);
    }
    
    /**
     * Update skill configuration
     */
    async updateSkill(id, config) {
        return this.put(`/api/admin/skills/${id}`, config);
    }
    
    /**
     * Discover new skills
     */
    async discoverSkills() {
        return this.get('/api/admin/skills/search/query', { q: '' });
    }
    
    /**
     * Get all traces
     */
    async getTraces(page = 1, limit = 20, filters = {}) {
        return this.get('/api/admin/traces', { page, limit, ...filters });
    }
    
    /**
     * Get trace details
     */
    async getTrace(id) {
        return this.get(`/api/admin/traces/${id}`);
    }

    /**
     * Get deferred agent workloads
     */
    async getAdminWorkloads(limit = 100) {
        return this.get('/api/admin/workloads', { limit });
    }

    /**
     * Update a deferred workload from the admin dashboard
     */
    async updateAdminWorkload(id, payload = {}) {
        return this.patch(`/api/admin/workloads/${id}`, payload);
    }

    /**
     * Pause a deferred workload from the admin dashboard
     */
    async pauseAdminWorkload(id) {
        return this.post(`/api/admin/workloads/${id}/pause`);
    }

    /**
     * Resume a deferred workload from the admin dashboard
     */
    async resumeAdminWorkload(id) {
        return this.post(`/api/admin/workloads/${id}/resume`);
    }

    /**
     * Delete a deferred workload from the admin dashboard
     */
    async deleteAdminWorkload(id) {
        return this.delete(`/api/admin/workloads/${id}`);
    }

    /**
     * Get deferred workload runs
     */
    async getAdminRuns(limit = 100) {
        return this.get('/api/admin/runs', { limit });
    }

    /**
     * Get a single deferred workload run
     */
    async getAdminRun(id) {
        return this.get(`/api/admin/runs/${id}`);
    }

    /**
     * Get recent bounded self-reflection updates
     */
    async getSelfReflectionUpdates(limit = 6) {
        return this.get('/api/admin/self-reflection-updates', { limit }, {
            timeout: 10000,
        });
    }

    /**
     * Get pending evaluator-suggested self-reflection updates
     */
    async getSelfReflectionSuggestions(limit = 6) {
        return this.get('/api/admin/self-reflection-updates/suggestions', { limit }, {
            timeout: 10000,
        });
    }

    /**
     * Approve and apply one evaluator self-reflection suggestion
     */
    async applySelfReflectionSuggestion(id) {
        return this.post(`/api/admin/self-reflection-updates/suggestions/${encodeURIComponent(id)}/apply`, null, {
            timeout: 15000,
        });
    }

    /**
     * Get settings
     */
    async getSettings() {
        return this.get('/api/admin/settings');
    }
    
    /**
     * Update settings
     */
    async updateSettings(settings) {
        return this.put('/api/admin/settings', settings);
    }
    
    /**
     * Get feature toggles
     */
    async getFeatures() {
        return this.get('/api/admin/settings');
    }
    
    /**
     * Update feature toggle
     */
    async updateFeature(featureId, enabled) {
        return this.put('/api/admin/settings', {
            features: {
                [featureId]: enabled
            }
        });
    }
    
    /**
     * Test a prompt
     */
    async testPrompt(id, variables = {}) {
        return this.post(`/api/admin/prompts/${id}/test`, {
            variables
        });
    }
    
    /**
     * Test API connection
     */
    async testConnection() {
        return this.get('/api/admin/health');
    }
    
    /**
     * Get system health
     */
    async getHealth() {
        return this.get('/api/admin/health');
    }
    
    /**
     * Export all data
     */
    async exportAllData() {
        throw new Error('Bulk export route is not available');
    }
    
    /**
     * Import data
     */
    async importData(data) {
        return this.post('/api/admin/import', data);
    }
}

// ==================== ERROR HANDLING ====================

class ApiError extends Error {
    constructor(message, status, data = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.data = data;
        this.userMessage = data.userMessage || message;
    }
}

// ==================== INITIALIZATION ====================

// Create global API client instance
const apiClient = new ApiClient({
    baseUrl: window.location.origin,
    timeout: 30000,
    maxRetries: 3
});

// Add request interceptor for loading states
apiClient.addRequestInterceptor((config) => {
    document.body.classList.add('api-loading');
    return config;
});

// Add response interceptor to remove loading state
apiClient.addResponseInterceptor((data, response) => {
    document.body.classList.remove('api-loading');
    return data;
});

// Add error handler
apiClient.addResponseInterceptor((data, response) => {
    if (data instanceof Error) {
        console.error('API Error:', data);
        
        // Show error notification if dashboard is available
        if (window.dashboard && data.userMessage) {
            window.dashboard.showToast(data.userMessage, 'error');
        }
    }
    return data;
});

// Expose to global scope
window.ApiClient = ApiClient;
window.ApiError = ApiError;
window.apiClient = apiClient;

// CSS for loading state
const style = document.createElement('style');
style.textContent = `
    .api-loading {
        cursor: progress !important;
    }
    .api-loading::after {
        content: '';
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(13, 17, 23, 0.5);
        z-index: 9999;
        pointer-events: none;
    }
`;
document.head.appendChild(style);
