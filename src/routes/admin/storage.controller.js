const fs = require('fs/promises');
const path = require('path');
const { getStateDirectory } = require('../../runtime-state-paths');
const { artifactService } = require('../../artifacts/artifact-service');
const { artifactStore } = require('../../artifacts/artifact-store');
const { sessionStore } = require('../../session-store');
const { memoryService } = require('../../memory/memory-service');

const CATEGORIES = {
  chatSessions: {
    label: 'Old chats',
    storage: 'sessions',
  },
  storedArtifacts: {
    label: 'Stored documents',
    storage: 'postgres',
  },
  generatedArtifacts: {
    label: 'Generated artifacts',
    directory: 'generated-artifacts',
    contentPathKey: 'contentPath',
  },
  generatedAudio: {
    label: 'Generated audio',
    directory: 'generated-audio',
    contentPathKey: 'audioPath',
  },
  generatedVideo: {
    label: 'Generated video',
    directory: 'generated-video',
    contentPathKey: 'videoPath',
  },
};

function getDataDirectory() {
  const configured = String(process.env.KIMIBUILT_DATA_DIR || '').trim();
  return configured ? path.resolve(configured) : getStateDirectory();
}

function formatCategory(category = '') {
  const normalized = String(category || '').trim();
  return CATEGORIES[normalized] ? normalized : '';
}

function safeNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function normalizeDate(value, fallback = null) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function statSize(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return {
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      mtime: stat.mtime.toISOString(),
    };
  } catch (_error) {
    return {
      bytes: 0,
      mtimeMs: 0,
      mtime: null,
    };
  }
}

async function readDirectoryEntries(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function resolveRecordPath(directory, recordPath = '') {
  const resolvedDirectory = path.resolve(directory);
  const resolvedPath = path.resolve(String(recordPath || ''));
  return isInside(resolvedDirectory, resolvedPath) ? resolvedPath : '';
}

async function findContentPath(directory, id, entries) {
  const prefix = `${id}.`;
  const match = entries.find((entry) => (
    entry.isFile()
    && entry.name.startsWith(prefix)
    && entry.name !== `${id}.json`
  ));
  return match ? path.join(directory, match.name) : '';
}

async function scanCategory(category) {
  const definition = CATEGORIES[category];
  if (definition.storage === 'sessions') {
    return scanChatSessionsCategory(category, definition);
  }

  if (definition.storage === 'postgres') {
    return scanStoredArtifactsCategory(category, definition);
  }

  const directory = path.join(getDataDirectory(), definition.directory);
  const entries = await readDirectoryEntries(directory);
  const records = [];
  const claimedPaths = new Set();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const metadataPath = path.join(directory, entry.name);
    let record = null;
    try {
      record = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    } catch (_error) {
      record = {};
    }

    const id = String(record.id || path.basename(entry.name, '.json')).trim();
    if (!id) {
      continue;
    }

    const metadataStats = await statSize(metadataPath);
    const explicitContentPath = resolveRecordPath(directory, record[definition.contentPathKey]);
    const contentPath = explicitContentPath || await findContentPath(directory, id, entries);
    const contentStats = contentPath ? await statSize(contentPath) : { bytes: 0, mtimeMs: 0, mtime: null };
    claimedPaths.add(path.resolve(metadataPath));
    if (contentPath) {
      claimedPaths.add(path.resolve(contentPath));
    }

    const updatedAt = normalizeDate(record.updatedAt, contentStats.mtime || metadataStats.mtime);
    records.push({
      id,
      category,
      label: definition.label,
      filename: String(record.filename || path.basename(contentPath || metadataPath)).trim(),
      sessionId: String(record.sessionId || '').trim() || null,
      mimeType: String(record.mimeType || '').trim() || null,
      createdAt: normalizeDate(record.createdAt, updatedAt),
      updatedAt,
      sizeBytes: safeNumber(record.sizeBytes, contentStats.bytes),
      diskBytes: contentStats.bytes + metadataStats.bytes,
      contentBytes: contentStats.bytes,
      metadataBytes: metadataStats.bytes,
      files: [contentPath, metadataPath].filter(Boolean),
      storage: record.metadata?.storage || 'local',
      downloadUrl: `/api/artifacts/${encodeURIComponent(id)}/download`,
    });
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const orphanPath = path.resolve(directory, entry.name);
    if (claimedPaths.has(orphanPath)) {
      continue;
    }

    const stats = await statSize(orphanPath);
    records.push({
      id: entry.name,
      category,
      label: definition.label,
      filename: entry.name,
      sessionId: null,
      mimeType: null,
      createdAt: stats.mtime,
      updatedAt: stats.mtime,
      sizeBytes: stats.bytes,
      diskBytes: stats.bytes,
      contentBytes: stats.bytes,
      metadataBytes: 0,
      files: [orphanPath],
      storage: 'orphan',
      downloadUrl: null,
    });
  }

  records.sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));
  const totalBytes = records.reduce((sum, record) => sum + record.diskBytes, 0);

  return {
    category,
    label: definition.label,
    directory,
    count: records.length,
    totalBytes,
    records,
  };
}

async function scanChatSessionsCategory(category, definition) {
  const sessions = await sessionStore.list();
  const records = sessions.map((session) => {
    const metadata = session.metadata || {};
    const ownerId = String(metadata.ownerId || metadata.userId || metadata.username || '').trim();
    const recentMessages = Array.isArray(metadata.recentMessages) ? metadata.recentMessages : [];
    const latestUserMessage = [...recentMessages].reverse()
      .find((message) => message?.role === 'user' && String(message.content || '').trim());
    const fallbackTitle = latestUserMessage?.content || metadata.title || metadata.name || session.id;
    const filename = String(fallbackTitle || session.id).replace(/\s+/g, ' ').trim();
    const metadataBytes = Buffer.byteLength(JSON.stringify(metadata || {}), 'utf8');

    return {
      id: session.id,
      category,
      label: definition.label,
      filename: filename.length > 90 ? `${filename.slice(0, 87)}...` : filename,
      sessionId: session.id,
      ownerId: ownerId || null,
      mimeType: 'application/vnd.kimibuilt.chat-session',
      format: 'chat',
      createdAt: normalizeDate(session.createdAt, null),
      updatedAt: normalizeDate(session.updatedAt, session.createdAt),
      sizeBytes: metadataBytes,
      diskBytes: metadataBytes,
      contentBytes: 0,
      metadataBytes,
      messageCount: safeNumber(session.messageCount, 0),
      scopeKey: session.scopeKey || metadata.memoryScope || null,
      files: [],
      storage: sessionStore.isPersistent() ? 'postgres' : 'file-backed',
      downloadUrl: null,
      previewUrl: null,
    };
  });

  records.sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));
  return {
    category,
    label: definition.label,
    directory: sessionStore.isPersistent() ? 'Postgres sessions table' : 'File-backed sessions state',
    count: records.length,
    totalBytes: records.reduce((sum, record) => sum + record.diskBytes, 0),
    records,
  };
}

function isDocumentLikeArtifact(artifact = {}) {
  const format = String(artifact.format || artifact.extension || '').toLowerCase();
  const mimeType = String(artifact.mimeType || '').toLowerCase();
  const sourceMode = String(artifact.sourceMode || '').toLowerCase();
  const generatedBy = String(artifact.metadata?.generatedBy || '').toLowerCase();

  return [
    'html',
    'pdf',
    'pptx',
    'xlsx',
    'md',
    'markdown',
    'docx',
    'txt',
    'csv',
    'json',
    'svg',
    'mermaid',
  ].includes(format)
    || mimeType.includes('pdf')
    || mimeType.includes('text/')
    || mimeType.includes('presentation')
    || mimeType.includes('spreadsheet')
    || sourceMode.includes('document')
    || generatedBy.includes('document');
}

async function scanStoredArtifactsCategory(category, definition) {
  if (!artifactService.isEnabled()) {
    return {
      category,
      label: definition.label,
      directory: 'Postgres artifacts table',
      count: 0,
      totalBytes: 0,
      records: [],
    };
  }

  let rows = [];
  try {
    rows = await artifactStore.listAllWithSessions();
  } catch (error) {
    console.warn('[AdminStorage] Failed to list stored artifacts:', error.message);
    return {
      category,
      label: definition.label,
      directory: 'Postgres artifacts table',
      count: 0,
      totalBytes: 0,
      error: error.message,
      records: [],
    };
  }
  const records = rows
    .filter((artifact) => isDocumentLikeArtifact(artifact))
    .map((artifact) => {
      const serialized = artifactService.serializeArtifact(artifact) || {};
      const id = String(artifact.id || '').trim();
      const format = String(artifact.extension || serialized.format || '').trim();
      return {
        id,
        category,
        label: definition.label,
        filename: String(artifact.filename || id).trim(),
        sessionId: String(artifact.sessionId || '').trim() || null,
        ownerId: artifact.ownerId || null,
        mimeType: String(artifact.mimeType || '').trim() || null,
        format,
        createdAt: normalizeDate(artifact.createdAt, null),
        updatedAt: normalizeDate(artifact.updatedAt, artifact.createdAt),
        sizeBytes: safeNumber(artifact.sizeBytes, 0),
        diskBytes: safeNumber(artifact.sizeBytes, 0),
        contentBytes: safeNumber(artifact.sizeBytes, 0),
        metadataBytes: 0,
        fileCount: 1,
        files: [],
        storage: 'postgres',
        downloadUrl: serialized.downloadUrl || `/api/artifacts/${encodeURIComponent(id)}/download`,
        previewUrl: serialized.previewUrl || serialized.sandboxUrl || null,
      };
    });

  records.sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));
  return {
    category,
    label: definition.label,
    directory: 'Postgres artifacts table',
    count: records.length,
    totalBytes: records.reduce((sum, record) => sum + record.diskBytes, 0),
    records,
  };
}

function serializeCategory(result, { includeRecords = true, limit = 100 } = {}) {
  return {
    category: result.category,
    label: result.label,
    directory: result.directory,
    count: result.count,
    totalBytes: result.totalBytes,
    error: result.error,
    records: includeRecords
      ? result.records.slice(0, limit).map(({ files = [], ...record }) => ({
        ...record,
        fileCount: record.fileCount || files.length,
      }))
      : undefined,
  };
}

async function deleteStorageRecord(record) {
  if (record.category === 'chatSessions') {
    await deleteChatSession(record.id);
    return true;
  }

  if (record.category === 'storedArtifacts') {
    const deleted = await artifactService.deleteArtifact(record.id);
    if (!deleted) {
      const error = new Error('Stored artifact not found.');
      error.statusCode = 404;
      throw error;
    }
    return true;
  }

  for (const filePath of record.files || []) {
    await fs.rm(filePath, { force: true });
  }
  return true;
}

async function list(req, res, next) {
  try {
    const limit = Math.max(1, Math.min(500, safeNumber(req.query.limit, 100)));
    const results = await Promise.all(Object.keys(CATEGORIES).map((category) => scanCategory(category)));
    res.json({
      success: true,
      data: {
        dataDirectory: getDataDirectory(),
        totalBytes: results.reduce((sum, result) => sum + result.totalBytes, 0),
        totalCount: results.reduce((sum, result) => sum + result.count, 0),
        categories: results.map((result) => serializeCategory(result, { limit })),
      },
    });
  } catch (error) {
    next(error);
  }
}

async function bulkRemove(req, res, next) {
  try {
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const uniqueItems = [];
    const seen = new Set();

    for (const item of rawItems.slice(0, 150)) {
      const category = formatCategory(item?.category);
      const id = String(item?.id || '').trim();
      const key = `${category}::${id}`;
      if (!category || !id || seen.has(key)) {
        continue;
      }
      seen.add(key);
      uniqueItems.push({ category, id });
    }

    if (uniqueItems.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid storage records selected.' });
    }

    const scanByCategory = new Map();
    const deleted = [];
    const failed = [];

    for (const item of uniqueItems) {
      try {
        if (!scanByCategory.has(item.category)) {
          scanByCategory.set(item.category, await scanCategory(item.category));
        }

        const result = scanByCategory.get(item.category);
        const record = result.records.find((candidate) => candidate.id === item.id);
        if (!record) {
          failed.push({
            ...item,
            error: 'Stored file not found.',
          });
          continue;
        }

        await deleteStorageRecord(record);
        deleted.push({
          id: record.id,
          category: record.category,
          filename: record.filename,
          diskBytes: record.diskBytes,
          sessionId: record.sessionId || null,
        });
      } catch (error) {
        failed.push({
          ...item,
          error: error.message || 'Delete failed.',
        });
      }
    }

    res.json({
      success: true,
      data: {
        requestedCount: uniqueItems.length,
        deletedCount: deleted.length,
        failedCount: failed.length,
        deletedBytes: deleted.reduce((sum, record) => sum + safeNumber(record.diskBytes, 0), 0),
        records: deleted,
        failed,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function remove(req, res, next) {
  try {
    const category = formatCategory(req.params.category);
    if (!category) {
      return res.status(400).json({ success: false, error: 'Unknown storage category.' });
    }

    const id = String(req.params.id || '').trim();
    const result = await scanCategory(category);
    const record = result.records.find((item) => item.id === id);
    if (!record) {
      return res.status(404).json({ success: false, error: 'Stored file not found.' });
    }

    await deleteStorageRecord(record);

    res.json({
      success: true,
      data: {
        deleted: 1,
        deletedBytes: record.diskBytes,
        record: {
          id: record.id,
          category: record.category,
          filename: record.filename,
          diskBytes: record.diskBytes,
          sessionId: record.sessionId || null,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

async function cleanup(req, res, next) {
  try {
    const category = formatCategory(req.body?.category || req.query.category || '');
    const categories = category ? [category] : Object.keys(CATEGORIES);
    const clearAll = req.body?.clearAll === true || req.query.clearAll === 'true';
    const olderThanDays = clearAll
      ? 0
      : Math.max(1, Math.min(3650, safeNumber(req.body?.olderThanDays, 30)));
    const dryRun = req.body?.dryRun !== false;
    const cutoff = clearAll ? Number.POSITIVE_INFINITY : Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    const deleted = [];

    for (const currentCategory of categories) {
      const result = await scanCategory(currentCategory);
      const expired = result.records.filter((record) => {
        if (clearAll) {
          return true;
        }
        const timestamp = Date.parse(record.updatedAt || record.createdAt || '');
        return Number.isFinite(timestamp) && timestamp < cutoff;
      });

      for (const record of expired) {
        if (!dryRun && currentCategory === 'chatSessions') {
          await deleteChatSession(record.id);
        } else if (!dryRun && currentCategory === 'storedArtifacts') {
          await artifactService.deleteArtifact(record.id);
        } else if (!dryRun) {
          for (const filePath of record.files) {
            await fs.rm(filePath, { force: true });
          }
        }

        deleted.push({
          id: record.id,
          category: record.category,
          filename: record.filename,
          diskBytes: record.diskBytes,
          updatedAt: record.updatedAt,
        });
      }
    }

    res.json({
      success: true,
      data: {
        dryRun,
        clearAll,
        olderThanDays,
        deletedCount: dryRun ? 0 : deleted.length,
        matchedCount: deleted.length,
        matchedBytes: deleted.reduce((sum, record) => sum + record.diskBytes, 0),
        records: deleted,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function deleteChatSession(sessionId) {
  try {
    await artifactService.deleteArtifactsForSession(sessionId);
  } catch (error) {
    console.warn(`[AdminStorage] Failed to delete artifacts for chat session ${sessionId}:`, error.message);
  }

  const deleted = await sessionStore.delete(sessionId);
  if (!deleted) {
    const error = new Error('Chat session not found.');
    error.statusCode = 404;
    throw error;
  }

  void memoryService.forget(sessionId).catch((error) => {
    console.warn(`[AdminStorage] Failed to forget memory for deleted chat session ${sessionId}:`, error.message);
  });

  return true;
}

module.exports = {
  bulkRemove,
  cleanup,
  list,
  remove,
  _private: {
    deleteChatSession,
    scanCategory,
  },
};
