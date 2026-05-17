const crypto = require('crypto');
const { postgres } = require('../postgres');

function getMasterKey() {
  const raw = String(process.env.KIMIBUILT_PII_MASTER_KEY || '').trim();
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  } catch (_error) {
    // Fall back to hashing the configured value.
  }
  return crypto.createHash('sha256').update(raw).digest();
}

function assertVaultReady() {
  const key = getMasterKey();
  if (!key) {
    const error = new Error('KIMIBUILT_PII_MASTER_KEY is required for PII vault encryption.');
    error.statusCode = 503;
    error.code = 'pii_master_key_missing';
    throw error;
  }
  if (!postgres?.getStatus?.().initialized) {
    const error = new Error('Postgres is required for encrypted PII vault storage.');
    error.statusCode = 503;
    error.code = 'pii_vault_unavailable';
    throw error;
  }
  return key;
}

function encryptValue(value = '') {
  const key = assertVaultReady();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value || ''), 'utf8'), cipher.final()]);
  return {
    encryptedValue: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptValue(entry = {}) {
  const key = assertVaultReady();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(entry.authTag || entry.auth_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(entry.encryptedValue || entry.encrypted_value, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function valueIndexHmac(value = '', type = '') {
  const key = getMasterKey();
  if (!key) {
    const error = new Error('KIMIBUILT_PII_MASTER_KEY is required for PII vault indexing.');
    error.statusCode = 503;
    error.code = 'pii_master_key_missing';
    throw error;
  }
  return crypto
    .createHmac('sha256', key)
    .update(`${String(type || '').toLowerCase()}\0${String(value || '')}`)
    .digest('hex');
}

function toContext(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    sourceSurface: row.source_surface,
    policySnapshot: row.policy_snapshot || {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
  };
}

function toEntry(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    contextId: row.context_id,
    placeholder: row.placeholder,
    piiType: row.pii_type,
    valueIndexHmac: row.value_index_hmac,
    encryptedValue: row.encrypted_value,
    iv: row.iv,
    authTag: row.auth_tag,
    sourceRange: row.source_range || {},
    occurrenceIndex: row.occurrence_index,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

class PiiVaultStore {
  async createContext({ id = crypto.randomUUID(), sessionId, ownerId = null, sourceSurface = '', policySnapshot = {}, expiresAt = null }) {
    assertVaultReady();
    const result = await postgres.query(
      `
        INSERT INTO pii_contexts (id, session_id, owner_id, source_surface, policy_snapshot, expires_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        RETURNING *
      `,
      [id, sessionId, ownerId, sourceSurface, JSON.stringify(policySnapshot || {}), expiresAt],
    );
    return toContext(result.rows[0]);
  }

  async addEntries(contextId, entries = []) {
    assertVaultReady();
    const stored = [];
    for (const entry of entries) {
      const encrypted = encryptValue(entry.value);
      const result = await postgres.query(
        `
          INSERT INTO pii_context_entries (
            context_id, placeholder, pii_type, value_index_hmac,
            encrypted_value, iv, auth_tag, source_range, occurrence_index
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
          RETURNING *
        `,
        [
          contextId,
          entry.placeholder,
          entry.type,
          valueIndexHmac(entry.value, entry.type),
          encrypted.encryptedValue,
          encrypted.iv,
          encrypted.authTag,
          JSON.stringify(entry.sourceRange || {}),
          Number(entry.occurrenceIndex || 0),
        ],
      );
      stored.push(toEntry(result.rows[0]));
    }
    return stored;
  }

  async listEntriesForSession(sessionId, ownerId = null) {
    assertVaultReady();
    const params = [sessionId];
    const ownerClause = ownerId ? 'AND (c.owner_id IS NULL OR c.owner_id = $2)' : '';
    if (ownerId) params.push(ownerId);
    const result = await postgres.query(
      `
        SELECT e.*
        FROM pii_context_entries e
        INNER JOIN pii_contexts c ON c.id = e.context_id
        WHERE c.session_id = $1 ${ownerClause}
        ORDER BY e.created_at ASC, e.occurrence_index ASC
      `,
      params,
    );
    return result.rows.map(toEntry);
  }

  async listEntriesForContexts(contextIds = [], ownerId = null) {
    const ids = (Array.isArray(contextIds) ? contextIds : []).map((id) => String(id || '').trim()).filter(Boolean);
    if (ids.length === 0) return [];
    assertVaultReady();
    const params = [ids];
    const ownerClause = ownerId ? 'AND (c.owner_id IS NULL OR c.owner_id = $2)' : '';
    if (ownerId) params.push(ownerId);
    const result = await postgres.query(
      `
        SELECT e.*
        FROM pii_context_entries e
        INNER JOIN pii_contexts c ON c.id = e.context_id
        WHERE e.context_id = ANY($1) ${ownerClause}
        ORDER BY e.created_at ASC, e.occurrence_index ASC
      `,
      params,
    );
    return result.rows.map(toEntry);
  }

  async deleteBySession(sessionId) {
    if (!postgres?.getStatus?.().initialized) return 0;
    const result = await postgres.query('DELETE FROM pii_contexts WHERE session_id = $1', [sessionId]);
    return result.rowCount || 0;
  }

  decryptEntry(entry = {}) {
    return decryptValue(entry);
  }
}

const piiVaultStore = new PiiVaultStore();

module.exports = {
  piiVaultStore,
  PiiVaultStore,
  encryptValue,
  decryptValue,
  valueIndexHmac,
  getMasterKey,
};
