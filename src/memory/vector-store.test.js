jest.mock('../config', () => ({
  config: { qdrant: { url: 'http://qdrant.test', collection: 'conversations', vectorSize: 3 } },
}));
jest.mock('./embedder', () => ({ embedder: { embed: jest.fn() } }));
jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn(() => ({
    getCollections: jest.fn(),
    createCollection: jest.fn(),
    upsert: jest.fn().mockResolvedValue(undefined),
  })),
}));

const { VectorStore } = require('./vector-store');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('concurrent memory collection initialization', () => {
  let store;

  beforeEach(() => {
    store = new VectorStore();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  test('concurrent writes share creation and wait until the collection is ready', async () => {
    const creation = deferred();
    store.client.getCollections.mockResolvedValue({ collections: [] });
    store.client.createCollection
      .mockImplementationOnce(() => creation.promise)
      .mockRejectedValue(new Error('Collection already exists'));
    const points = [{ id: 'point-1', vector: [0.1, 0.2, 0.3] }];
    const writes = Array.from({ length: 8 }, () => store.upsert('conversations', points));
    const outcomes = Promise.allSettled(writes);
    await new Promise(setImmediate);
    expect(store.client.upsert).not.toHaveBeenCalled();
    creation.resolve();

    expect(await outcomes).toEqual(writes.map(() => ({ status: 'fulfilled', value: points })));
    expect(store.client.getCollections).toHaveBeenCalledTimes(1);
    expect(store.client.createCollection).toHaveBeenCalledTimes(1);
    expect(store.client.createCollection).toHaveBeenCalledWith('conversations', {
      vectors: { size: 3, distance: 'Cosine' },
    });
    expect(store.client.upsert).toHaveBeenCalledTimes(8);
    await store.ensureCollection('conversations');
    expect(store.client.getCollections).toHaveBeenCalledTimes(1);
  });

  test.each(['getCollections', 'createCollection'])('retries after a shared %s failure', async (method) => {
    const failure = deferred();
    const error = new Error('Qdrant unavailable');
    store.client.getCollections.mockResolvedValue({ collections: [] });
    store.client.createCollection.mockResolvedValue(undefined);
    store.client[method].mockImplementationOnce(() => failure.promise);
    const attempts = Promise.allSettled([
      store.ensureCollection('conversations'),
      store.ensureCollection('conversations'),
    ]);
    await new Promise(setImmediate);
    failure.reject(error);
    expect(await attempts).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ]);
    expect(store.knownCollections.has('conversations')).toBe(false);

    await store.ensureCollection('conversations');
    expect(store.knownCollections.has('conversations')).toBe(true);
    expect(store.client[method]).toHaveBeenCalledTimes(2);
  });

  test('initializes different collections independently and reuses existing ones', async () => {
    const slow = deferred();
    store.client.getCollections
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValue({ collections: [{ name: 'ready' }] });
    const pending = store.ensureCollection('slow');
    await store.ensureCollection('ready');
    expect(store.knownCollections.has('ready')).toBe(true);
    expect(store.knownCollections.has('slow')).toBe(false);
    slow.resolve({ collections: [{ name: 'slow' }] });
    await pending;
    expect(store.client.createCollection).not.toHaveBeenCalled();
  });
});
