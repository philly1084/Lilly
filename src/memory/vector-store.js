const { QdrantClient } = require('@qdrant/js-client-rest');
const { config } = require('../config');
const { embedder } = require('./embedder');
const { v4: uuidv4 } = require('uuid');

/**
 * Qdrant vector store wrapper.
 * Manages the conversations collection and provides store/search/delete.
 */
class VectorStore {
    constructor() {
        // The explicit compatibility probe runs out-of-band and leaves noisy
        // post-test logs; normal collection/search operations still fail fast.
        this.client = new QdrantClient({
            url: config.qdrant.url,
            checkCompatibility: false,
        });
        this.collection = config.qdrant.collection;
        this.vectorSize = config.qdrant.vectorSize;
        this.initialized = false;
        this.knownCollections = new Set();
    }

    buildPayloadFilter({
        sessionId = null,
        ownerId = null,
        memoryScope = null,
        projectKey = null,
        memoryNamespace = null,
        sourceSurface = null,
        memoryClass = null,
    } = {}) {
        const must = [];
        if (sessionId) {
            must.push({ key: 'sessionId', match: { value: sessionId } });
        } else if (ownerId) {
            must.push({ key: 'ownerId', match: { value: ownerId } });
        }
        if (memoryScope) {
            must.push({ key: 'memoryScope', match: { value: memoryScope } });
        }
        if (projectKey) {
            must.push({ key: 'projectKey', match: { value: projectKey } });
        }
        if (memoryNamespace) {
            must.push({ key: 'memoryNamespace', match: { value: memoryNamespace } });
        }
        if (sourceSurface) {
            must.push({ key: 'sourceSurface', match: { value: sourceSurface } });
        }
        if (memoryClass) {
            must.push({ key: 'memoryClass', match: { value: memoryClass } });
        }

        return must.length > 0 ? { must } : undefined;
    }

    async initialize() {
        if (this.initialized) return;
        await this.ensureCollection(this.collection);
        this.initialized = true;
    }

    async ensureCollection(collectionName, vectorSize = this.vectorSize) {
        if (this.knownCollections.has(collectionName)) {
            return;
        }

        try {
            const collections = await this.client.getCollections();
            const exists = collections.collections.some((collection) => collection.name === collectionName);

            if (!exists) {
                await this.client.createCollection(collectionName, {
                    vectors: {
                        size: vectorSize,
                        distance: 'Cosine',
                    },
                });
                console.log(`[Qdrant] Created collection: ${collectionName}`);
            } else {
                console.log(`[Qdrant] Collection already exists: ${collectionName}`);
            }

            this.knownCollections.add(collectionName);
        } catch (err) {
            console.error('[Qdrant] Initialization failed:', err.message);
            throw err;
        }
    }

    async store(sessionId, text, metadata = {}) {
        await this.ensureCollection(this.collection);
        const vector = await embedder.embed(text);
        const pointId = uuidv4();

        await this.client.upsert(this.collection, {
            wait: true,
            points: [
                {
                    id: pointId,
                    vector,
                    payload: {
                        sessionId,
                        text,
                        timestamp: new Date().toISOString(),
                        ...metadata,
                    },
                },
            ],
        });

        return pointId;
    }

    async search(queryOrCollection, options = {}) {
        if (typeof queryOrCollection === 'string' && Array.isArray(options.vector)) {
            await this.ensureCollection(queryOrCollection, options.vector.length || this.vectorSize);
            return this.client.search(queryOrCollection, {
                ...options,
                with_payload: options.with_payload ?? true,
                with_vector: options.with_vector ?? false,
            });
        }

        const query = queryOrCollection;
        const {
            sessionId = null,
            ownerId = null,
            memoryScope = null,
            projectKey = null,
            memoryNamespace = null,
            sourceSurface = null,
            memoryClass = null,
            topK = config.memory.recallTopK,
            scoreThreshold = config.memory.recallScoreThreshold,
        } = options;
        await this.ensureCollection(this.collection);
        const vector = await embedder.embed(query);

        const filter = this.buildPayloadFilter({
            sessionId,
            ownerId,
            memoryScope,
            projectKey,
            memoryNamespace,
            sourceSurface,
            memoryClass,
        });

        const results = await this.client.search(this.collection, {
            vector,
            limit: topK,
            score_threshold: scoreThreshold,
            filter,
            with_payload: true,
        });

        return results.map((result) => ({
            id: result.id,
            score: result.score,
            text: result.payload.text,
            sessionId: result.payload.sessionId,
            timestamp: result.payload.timestamp,
            metadata: result.payload,
        }));
    }

    async upsert(collectionName, points = []) {
        const inferredSize = points[0]?.vector?.length || this.vectorSize;
        await this.ensureCollection(collectionName, inferredSize);
        await this.client.upsert(collectionName, {
            wait: true,
            points,
        });
        return points;
    }

    async retrieve(collectionName, pointId) {
        await this.ensureCollection(collectionName);
        const results = await this.client.retrieve(collectionName, {
            ids: [pointId],
            with_payload: true,
            with_vector: true,
        });
        return Array.isArray(results) ? results[0] || null : null;
    }

    async scroll(collectionName, options = {}) {
        await this.ensureCollection(collectionName);
        const response = await this.client.scroll(collectionName, {
            limit: options.limit || 100,
            ...(options.filter ? { filter: options.filter } : {}),
            ...(options.offset ? { offset: options.offset } : {}),
            with_payload: options.with_payload ?? true,
            with_vector: options.with_vector ?? false,
        });

        if (Array.isArray(response?.points)) {
            return response.points;
        }
        if (Array.isArray(response?.result?.points)) {
            return response.result.points;
        }
        if (Array.isArray(response?.result)) {
            return response.result;
        }
        return [];
    }

    async delete(collectionName, pointIds = []) {
        await this.ensureCollection(collectionName);
        await this.client.delete(collectionName, {
            wait: true,
            points: pointIds,
        });
    }

    async deleteSession(sessionId) {
        await this.client.delete(this.collection, {
            wait: true,
            filter: {
                must: [{ key: 'sessionId', match: { value: sessionId } }],
            },
        });
    }

    async deleteArtifact(artifactId) {
        await this.client.delete(this.collection, {
            wait: true,
            filter: {
                must: [{ key: 'artifactId', match: { value: artifactId } }],
            },
        });
    }

    async healthCheck() {
        try {
            await this.client.getCollections();
            return true;
        } catch {
            return false;
        }
    }
}

const vectorStore = new VectorStore();

module.exports = { vectorStore, VectorStore };
