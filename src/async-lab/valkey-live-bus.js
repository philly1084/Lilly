'use strict';

const EventEmitter = require('events');
const Redis = require('ioredis');

function normalizeText(value = '') {
    return String(value || '').trim();
}

function normalizeCursor(value = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function sleep(ms = 0) {
    const delay = Number(ms) || 0;
    return delay > 0 ? new Promise((resolve) => setTimeout(resolve, delay)) : Promise.resolve();
}

class ValkeyLiveBus {
    constructor(options = {}) {
        this.url = normalizeText(options.url);
        this.keyPrefix = normalizeText(options.keyPrefix || 'kimibuilt:async-lab');
        this.eventTtlSeconds = Math.max(60, Number(options.eventTtlSeconds) || 3600);
        this.idempotencyTtlSeconds = Math.max(60, Number(options.idempotencyTtlSeconds) || 86400);
        this.leaseTtlMs = Math.max(1000, Number(options.leaseTtlMs) || 120000);
        this.redisFactory = options.redisFactory || ((url, extra = {}) => new Redis(url, {
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
            connectTimeout: 2500,
            ...extra,
        }));
        this.redis = options.redis || null;
        this.subscriber = options.subscriber || null;
        this.available = false;
        this.lastError = '';
        this.memoryEvents = new Map();
        this.memoryIdempotency = new Map();
        this.memoryLocks = new Map();
        this.memoryQueue = [];
        this.memoryEmitter = new EventEmitter();
    }

    isValkeyConfigured() {
        return Boolean(this.url || this.redis);
    }

    key(...parts) {
        return [this.keyPrefix, ...parts.map((part) => normalizeText(part)).filter(Boolean)].join(':');
    }

    runEventsKey(runId = '') {
        return this.key('runs', runId, 'events');
    }

    runChannel(runId = '') {
        return this.key('runs', runId, 'events', 'pub');
    }

    queueKey() {
        return this.key('queue', 'runs');
    }

    idempotencyKey(key = '') {
        return this.key('idempotency', key);
    }

    lockKey(key = '') {
        return this.key('locks', key);
    }

    async connect() {
        if (!this.isValkeyConfigured()) {
            this.available = false;
            return false;
        }

        try {
            if (!this.redis) {
                this.redis = this.redisFactory(this.url);
            }
            if (this.redis.status === 'wait') {
                await this.redis.connect();
            }
            await this.redis.ping();
            this.available = true;
            this.lastError = '';
            return true;
        } catch (error) {
            this.available = false;
            this.lastError = error.message;
            return false;
        }
    }

    async getRedis() {
        if (this.available && this.redis) {
            return this.redis;
        }
        const ok = await this.connect();
        return ok ? this.redis : null;
    }

    rememberMemoryEvent(runId = '', event = {}) {
        const key = normalizeText(runId);
        if (!key) {
            return;
        }
        const events = this.memoryEvents.get(key) || [];
        events.push({ ...event });
        this.memoryEvents.set(key, events.slice(-1000));
        this.memoryEmitter.emit(this.runChannel(key), { ...event });
    }

    async appendEvent(runId = '', event = {}) {
        const normalizedRunId = normalizeText(runId || event.runId);
        if (!normalizedRunId) {
            return { persisted: false, backend: 'none' };
        }

        const eventPayload = {
            ...event,
            runId: normalizedRunId,
        };
        this.rememberMemoryEvent(normalizedRunId, eventPayload);

        const redis = await this.getRedis();
        if (!redis) {
            return { persisted: true, backend: 'memory' };
        }

        try {
            const streamKey = this.runEventsKey(normalizedRunId);
            await redis.xadd(streamKey, '*', 'event', JSON.stringify(eventPayload));
            await redis.expire(streamKey, this.eventTtlSeconds);
            await redis.publish(this.runChannel(normalizedRunId), JSON.stringify(eventPayload));
            return { persisted: true, backend: 'valkey' };
        } catch (error) {
            this.available = false;
            this.lastError = error.message;
            return { persisted: true, backend: 'memory', error: error.message };
        }
    }

    async listEvents(runId = '', afterCursor = 0) {
        const normalizedRunId = normalizeText(runId);
        const after = normalizeCursor(afterCursor);
        if (!normalizedRunId) {
            return [];
        }

        const redis = await this.getRedis();
        if (redis) {
            try {
                const entries = await redis.xrange(this.runEventsKey(normalizedRunId), '-', '+');
                return entries
                    .map((entry) => {
                        const values = Array.isArray(entry?.[1]) ? entry[1] : [];
                        const eventIndex = values.findIndex((value) => value === 'event');
                        if (eventIndex < 0) {
                            return null;
                        }
                        try {
                            return JSON.parse(values[eventIndex + 1] || '{}');
                        } catch (_error) {
                            return null;
                        }
                    })
                    .filter((event) => event && normalizeCursor(event.cursor) > after);
            } catch (error) {
                this.available = false;
                this.lastError = error.message;
            }
        }

        return (this.memoryEvents.get(normalizedRunId) || [])
            .filter((event) => normalizeCursor(event.cursor) > after)
            .map((event) => ({ ...event }));
    }

    subscribe(runId = '', handler = () => {}) {
        const normalizedRunId = normalizeText(runId);
        if (!normalizedRunId) {
            return () => {};
        }

        const channel = this.runChannel(normalizedRunId);
        const memoryHandler = (event) => handler({ ...event });
        this.memoryEmitter.on(channel, memoryHandler);

        let closed = false;
        let subscriber = null;
        let messageHandler = null;
        let resolveReady;
        const ready = new Promise((resolve) => {
            resolveReady = resolve;
        });
        const attachSubscriber = async () => {
            if (!this.isValkeyConfigured()) {
                resolveReady({ backend: 'memory' });
                return;
            }
            try {
                subscriber = this.subscriber || this.redisFactory(this.url);
                if (subscriber.status === 'wait') {
                    await subscriber.connect();
                }
                if (closed) {
                    resolveReady({ backend: 'closed' });
                    return;
                }
                messageHandler = (messageChannel, raw) => {
                    if (closed || messageChannel !== channel) {
                        return;
                    }
                    try {
                        handler(JSON.parse(raw));
                    } catch (_error) {
                        // Ignore malformed live fanout payloads; durable replay remains available.
                    }
                };
                subscriber.on('message', messageHandler);
                await subscriber.subscribe(channel);
                if (closed) {
                    subscriber.off?.('message', messageHandler);
                    await subscriber.unsubscribe(channel).catch(() => {});
                    if (subscriber !== this.subscriber) {
                        await subscriber.quit().catch(() => {});
                    }
                    resolveReady({ backend: 'closed' });
                    return;
                }
                resolveReady({ backend: 'valkey' });
            } catch (error) {
                this.lastError = error.message;
                resolveReady({ backend: 'memory', error: error.message });
            }
        };
        void attachSubscriber();

        const unsubscribe = () => {
            closed = true;
            this.memoryEmitter.off(channel, memoryHandler);
            if (subscriber && messageHandler) {
                subscriber.off?.('message', messageHandler);
            }
            if (subscriber) {
                subscriber.unsubscribe(channel).catch(() => {});
            }
            if (subscriber && subscriber !== this.subscriber) {
                subscriber.quit().catch(() => {});
            }
        };
        unsubscribe.ready = ready;
        return unsubscribe;
    }

    async claimIdempotency(idempotencyKey = '', runId = '') {
        const key = normalizeText(idempotencyKey);
        const value = normalizeText(runId);
        if (!key || !value) {
            return { claimed: false, runId: '' };
        }

        const existing = await this.getIdempotency(key);
        if (existing) {
            return { claimed: false, runId: existing };
        }

        const redis = await this.getRedis();
        if (redis) {
            try {
                const result = await redis.set(this.idempotencyKey(key), value, 'EX', this.idempotencyTtlSeconds, 'NX');
                if (result === 'OK') {
                    return { claimed: true, runId: value };
                }
                return { claimed: false, runId: await this.getIdempotency(key) };
            } catch (error) {
                this.available = false;
                this.lastError = error.message;
            }
        }

        if (this.memoryIdempotency.has(key)) {
            return { claimed: false, runId: this.memoryIdempotency.get(key) };
        }
        this.memoryIdempotency.set(key, value);
        return { claimed: true, runId: value };
    }

    async getIdempotency(idempotencyKey = '') {
        const key = normalizeText(idempotencyKey);
        if (!key) {
            return '';
        }

        const redis = await this.getRedis();
        if (redis) {
            try {
                return normalizeText(await redis.get(this.idempotencyKey(key)));
            } catch (error) {
                this.available = false;
                this.lastError = error.message;
            }
        }

        return normalizeText(this.memoryIdempotency.get(key));
    }

    async enqueueRun(runId = '') {
        const normalizedRunId = normalizeText(runId);
        if (!normalizedRunId) {
            return false;
        }

        const redis = await this.getRedis();
        if (redis) {
            try {
                await redis.rpush(this.queueKey(), normalizedRunId);
                return true;
            } catch (error) {
                this.available = false;
                this.lastError = error.message;
            }
        }

        this.memoryQueue.push(normalizedRunId);
        return true;
    }

    async dequeueRun() {
        const redis = await this.getRedis();
        if (redis) {
            try {
                return normalizeText(await redis.lpop(this.queueKey()));
            } catch (error) {
                this.available = false;
                this.lastError = error.message;
            }
        }

        return normalizeText(this.memoryQueue.shift());
    }

    async acquireLock(lockName = '', owner = '', ttlMs = this.leaseTtlMs) {
        const key = normalizeText(lockName);
        const value = normalizeText(owner);
        if (!key || !value) {
            return false;
        }

        this.pruneMemoryLocks();
        const redis = await this.getRedis();
        if (redis) {
            try {
                const result = await redis.set(this.lockKey(key), value, 'PX', Math.max(1000, Number(ttlMs) || this.leaseTtlMs), 'NX');
                return result === 'OK';
            } catch (error) {
                this.available = false;
                this.lastError = error.message;
            }
        }

        if (this.memoryLocks.has(key)) {
            return false;
        }
        this.memoryLocks.set(key, {
            owner: value,
            expiresAt: Date.now() + Math.max(1000, Number(ttlMs) || this.leaseTtlMs),
        });
        return true;
    }

    async releaseLock(lockName = '', owner = '') {
        const key = normalizeText(lockName);
        const value = normalizeText(owner);
        if (!key || !value) {
            return false;
        }

        const redis = await this.getRedis();
        if (redis) {
            try {
                const result = await redis.eval(
                    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
                    1,
                    this.lockKey(key),
                    value,
                );
                return Number(result) > 0;
            } catch (error) {
                this.available = false;
                this.lastError = error.message;
            }
        }

        const lock = this.memoryLocks.get(key);
        if (lock?.owner !== value) {
            return false;
        }
        this.memoryLocks.delete(key);
        return true;
    }

    pruneMemoryLocks() {
        const now = Date.now();
        for (const [key, lock] of this.memoryLocks.entries()) {
            if (Number(lock.expiresAt || 0) <= now) {
                this.memoryLocks.delete(key);
            }
        }
    }

    async close() {
        if (this.redis) {
            await this.redis.quit().catch(() => {});
        }
        if (this.subscriber) {
            await this.subscriber.quit().catch(() => {});
        }
        await sleep(0);
    }

    getStatus() {
        return {
            configured: this.isValkeyConfigured(),
            available: this.available,
            backend: this.available ? 'valkey' : 'memory',
            keyPrefix: this.keyPrefix,
            lastError: this.lastError || null,
        };
    }
}

module.exports = {
    ValkeyLiveBus,
    normalizeCursor,
    normalizeText,
    sleep,
};
