const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { config } = require('../config');

const STORE_VERSION = 1;
let writeQueue = Promise.resolve();

function getStorePath() {
  const configured = String(process.env.CONTENT_STUDIO_STORE_PATH || '').trim();
  return configured
    ? path.resolve(configured)
    : path.join(config.persistence?.dataDir || path.resolve(process.cwd(), 'data'), 'content-studio.json');
}

function emptyStore() {
  return { version: STORE_VERSION, owners: {} };
}

function ownerKey(ownerId = '') {
  return crypto.createHash('sha256').update(String(ownerId || 'anonymous')).digest('hex').slice(0, 24);
}

function createId(prefix) {
  const value = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
  return `${prefix}-${value}`;
}

async function readStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(getStorePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : emptyStore();
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStore();
    throw error;
  }
}

async function writeStore(store) {
  const filePath = getStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(temporaryPath, filePath);
}

function withOwner(store, ownerId) {
  const key = ownerKey(ownerId);
  store.owners[key] ||= { brandKits: [], campaigns: [] };
  return store.owners[key];
}

function mutate(ownerId, operation) {
  const task = writeQueue.then(async () => {
    const store = await readStore();
    const result = await operation(withOwner(store, ownerId));
    await writeStore(store);
    return result;
  });
  writeQueue = task.catch(() => undefined);
  return task;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function notFound(label) {
  const error = new Error(`${label} was not found.`);
  error.statusCode = 404;
  error.code = 'content_studio_not_found';
  return error;
}

async function listBrandKits(ownerId) {
  const store = await readStore();
  return clone(withOwner(store, ownerId).brandKits);
}

async function getBrandKit(ownerId, id) {
  const kits = await listBrandKits(ownerId);
  const kit = kits.find((entry) => entry.id === id);
  if (!kit) throw notFound('Brand kit');
  return kit;
}

async function saveBrandKit(ownerId, input = {}, id = null) {
  return mutate(ownerId, (owner) => {
    const now = new Date().toISOString();
    const index = id ? owner.brandKits.findIndex((entry) => entry.id === id) : -1;
    if (id && index < 0) throw notFound('Brand kit');
    const previous = index >= 0 ? owner.brandKits[index] : null;
    const record = {
      id: previous?.id || createId('brand'),
      name: String(input.name || previous?.name || '').trim(),
      palette: Array.isArray(input.palette) ? input.palette.slice(0, 8) : (previous?.palette || []),
      typography: String(input.typography ?? previous?.typography ?? '').trim(),
      tone: String(input.tone ?? previous?.tone ?? '').trim(),
      visualStyle: String(input.visualStyle ?? previous?.visualStyle ?? '').trim(),
      accessibility: String(input.accessibility ?? previous?.accessibility ?? '').trim(),
      attributionPreference: String(input.attributionPreference ?? previous?.attributionPreference ?? 'always').trim() || 'always',
      hostVoices: Array.isArray(input.hostVoices) ? input.hostVoices.slice(0, 2) : (previous?.hostVoices || []),
      referenceArtifactIds: Array.isArray(input.referenceArtifactIds) ? input.referenceArtifactIds.slice(0, 12) : (previous?.referenceArtifactIds || []),
      logoArtifactId: String(input.logoArtifactId ?? previous?.logoArtifactId ?? '').trim(),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    if (!record.name) {
      const error = new Error('Brand kit name is required.');
      error.statusCode = 400;
      error.code = 'brand_kit_name_required';
      throw error;
    }
    if (index >= 0) owner.brandKits[index] = record;
    else owner.brandKits.unshift(record);
    return clone(record);
  });
}

async function deleteBrandKit(ownerId, id) {
  return mutate(ownerId, (owner) => {
    const index = owner.brandKits.findIndex((entry) => entry.id === id);
    if (index < 0) throw notFound('Brand kit');
    owner.brandKits.splice(index, 1);
    return { deleted: true, id };
  });
}

async function listCampaigns(ownerId) {
  const store = await readStore();
  return clone(withOwner(store, ownerId).campaigns);
}

async function getCampaign(ownerId, id) {
  const campaigns = await listCampaigns(ownerId);
  const campaign = campaigns.find((entry) => entry.id === id);
  if (!campaign) throw notFound('Campaign');
  return campaign;
}

async function saveCampaign(ownerId, campaign = {}) {
  return mutate(ownerId, (owner) => {
    const now = new Date().toISOString();
    const index = campaign.id ? owner.campaigns.findIndex((entry) => entry.id === campaign.id) : -1;
    const previous = index >= 0 ? owner.campaigns[index] : null;
    const record = {
      ...(previous || {}),
      ...clone(campaign),
      id: previous?.id || campaign.id || createId('campaign'),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    if (index >= 0) owner.campaigns[index] = record;
    else owner.campaigns.unshift(record);
    owner.campaigns = owner.campaigns.slice(0, 100);
    return clone(record);
  });
}

module.exports = {
  deleteBrandKit,
  getBrandKit,
  getCampaign,
  getStorePath,
  listBrandKits,
  listCampaigns,
  saveBrandKit,
  saveCampaign,
};
