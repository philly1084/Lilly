const { config } = require('../config');

/**
 * Generate embeddings using Ollama's /api/embeddings endpoint.
 * Uses nomic-embed-text which outputs 768-dimensional vectors.
 */
class Embedder {
    constructor() {
        this.baseURL = config.ollama.baseURL;
        this.model = config.ollama.embedModel;
        this.timeoutMs = Math.max(1000, Number(config.ollama.embedTimeoutMs) || 30000);
    }

    /**
     * Generate an embedding for a single text string.
     * @param {string} text - Text to embed
     * @returns {Promise<number[]>} 768-dim embedding vector
     */
    async embed(text) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(`${this.baseURL}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    model: this.model,
                    prompt: text,
                }),
            });

            if (!response.ok) {
                const body = await response.text();
                throw new Error(`Ollama embedding failed (${response.status}): ${body}`);
            }

            const data = await response.json();
            return data.embedding;
        } finally {
            // Keep the deadline active through body reads, not just response headers.
            clearTimeout(timeoutId);
        }
    }

    /**
     * Generate embeddings for multiple texts.
     * @param {string[]} texts
     * @returns {Promise<number[][]>}
     */
    async embedBatch(texts) {
        return Promise.all(texts.map((t) => this.embed(t)));
    }

    /**
     * Check connectivity to Ollama.
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        try {
            const response = await fetch(`${this.baseURL}/api/tags`);
            return response.ok;
        } catch {
            return false;
        }
    }
}

// Singleton
const embedder = new Embedder();

module.exports = { embedder, Embedder };
