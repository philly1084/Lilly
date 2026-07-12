const fs = require('fs/promises');
const path = require('path');

describe('content studio store', () => {
  const storePath = path.join('C:\\tmp', `kimibuilt-content-studio-${process.pid}.json`);
  let store;

  beforeEach(() => {
    process.env.CONTENT_STUDIO_STORE_PATH = storePath;
    jest.resetModules();
    store = require('./store');
  });

  afterEach(async () => {
    await fs.rm(storePath, { force: true });
    delete process.env.CONTENT_STUDIO_STORE_PATH;
  });

  test('keeps brand kits and campaigns isolated per owner', async () => {
    const alpha = await store.saveBrandKit('alpha', {
      name: 'Alpha Studio',
      palette: ['#091426', '#37c6ff'],
      attributionPreference: 'always',
    });
    await store.saveBrandKit('beta', { name: 'Beta Studio' });

    expect(await store.listBrandKits('alpha')).toEqual([expect.objectContaining({ id: alpha.id, name: 'Alpha Studio' })]);
    expect(await store.listBrandKits('beta')).toEqual([expect.objectContaining({ name: 'Beta Studio' })]);
    await expect(store.getBrandKit('beta', alpha.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('updates and deletes only an owned brand kit', async () => {
    const created = await store.saveBrandKit('alpha', { name: 'Launch Brand' });
    const updated = await store.saveBrandKit('alpha', { name: 'Launch Brand 2', hostVoices: ['af_heart'] }, created.id);
    expect(updated).toEqual(expect.objectContaining({ id: created.id, name: 'Launch Brand 2', hostVoices: ['af_heart'] }));
    await store.deleteBrandKit('alpha', created.id);
    expect(await store.listBrandKits('alpha')).toEqual([]);
  });
});
