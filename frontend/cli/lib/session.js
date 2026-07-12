const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./config');

const SESSION_FILE = path.join(CONFIG_DIR, 'session');
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');

/**
 * Ensure the session directory exists.
 */
function ensureSessionDir() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    }
  } catch (err) {
    console.error('[Session] Error creating session directory:', err.message);
  }
}

/**
 * Load the current session ID from file.
 * @returns {string|null} Session ID or null if not found
 */
function load() {
  ensureSessionDir();
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const sessionId = fs.readFileSync(SESSION_FILE, 'utf8').trim();
      // Validate that the session exists in our history
      const history = getHistory();
      const exists = history.some(s => s.id === sessionId);
      return exists ? sessionId : null;
    }
  } catch (err) {
    console.error('[Session] Error loading session:', err.message);
  }
  return null;
}

/**
 * Save the session ID to file.
 * @param {string} sessionId - Session ID to save
 * @param {Object} metadata - Optional session metadata
 */
function save(sessionId, metadata = {}) {
  ensureSessionDir();
  try {
    fs.writeFileSync(SESSION_FILE, sessionId, { mode: 0o600 });
    
    // Also save to history
    addToHistory(sessionId, metadata);
  } catch (err) {
    console.error('[Session] Error saving session:', err.message);
  }
}

/**
 * Add a session to history.
 * @param {string} sessionId - Session ID
 * @param {Object} metadata - Session metadata
 */
function addToHistory(sessionId, metadata = {}) {
  ensureSessionDir();
  try {
    const history = getHistory();
    const existingIndex = history.findIndex(s => s.id === sessionId);
    const existingEntry = existingIndex >= 0 ? history[existingIndex] : {};
    
    const sessionEntry = {
      id: sessionId,
      ...existingEntry,
      createdAt: metadata.createdAt || existingEntry.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mode: metadata.mode || existingEntry.mode || 'chat',
      name: metadata.name || existingEntry.name || `Session ${sessionId.slice(0, 8)}`,
      ...metadata,
    };
    
    if (existingIndex >= 0) {
      history[existingIndex] = sessionEntry;
    } else {
      history.unshift(sessionEntry);
    }
    
    // Keep only last 50 sessions
    const trimmedHistory = history.slice(0, 50);
    const historyFile = path.join(CONFIG_DIR, 'session-history.json');
    fs.writeFileSync(historyFile, JSON.stringify(trimmedHistory, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[Session] Error saving to history:', err.message);
  }
}

function addReasoningEntry(sessionId, entry = {}) {
  ensureSessionDir();
  try {
    const history = getHistory();
    const index = history.findIndex(s => s.id === sessionId);
    if (index < 0) {
      return false;
    }

    const reasoningHistory = Array.isArray(history[index].reasoningHistory)
      ? history[index].reasoningHistory
      : [];
    const text = String(entry.text || entry.reasoningSummary || '').trim();
    if (!text) {
      return false;
    }

    history[index] = {
      ...history[index],
      updatedAt: new Date().toISOString(),
      reasoningHistory: [
        {
          id: entry.id || `reasoning-${Date.now()}`,
          timestamp: entry.timestamp || new Date().toISOString(),
          prompt: entry.prompt || '',
          text,
          model: entry.model || history[index].model || null,
          mode: entry.mode || history[index].mode || 'chat',
        },
        ...reasoningHistory,
      ].slice(0, 25),
    };

    const historyFile = path.join(CONFIG_DIR, 'session-history.json');
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2), { mode: 0o600 });
    return true;
  } catch (err) {
    console.error('[Session] Error saving reasoning history:', err.message);
    return false;
  }
}

function getReasoningHistory(sessionId) {
  const history = getHistory();
  const current = history.find(s => s.id === sessionId);
  return Array.isArray(current?.reasoningHistory) ? current.reasoningHistory : [];
}

/**
 * Get session history.
 * @returns {Array} Array of session objects
 */
function getHistory() {
  ensureSessionDir();
  try {
    const historyFile = path.join(CONFIG_DIR, 'session-history.json');
    if (fs.existsSync(historyFile)) {
      const data = fs.readFileSync(historyFile, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[Session] Error loading history:', err.message);
  }
  return [];
}

/**
 * Clear the current session ID.
 */
function clear() {
  ensureSessionDir();
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
  } catch (err) {
    console.error('[Session] Error clearing session:', err.message);
  }
}

/**
 * Get the current session ID or null.
 * @returns {string|null} Current session ID
 */
function getCurrent() {
  return load();
}

/**
 * Set a new session ID.
 * @param {string} sessionId - New session ID
 * @param {Object} metadata - Optional session metadata
 */
function setCurrent(sessionId, metadata = {}) {
  save(sessionId, metadata);
}

/**
 * Switch to a different session from history.
 * @param {string} sessionId - Session ID to switch to
 * @returns {boolean} Success status
 */
function switchTo(sessionId) {
  const history = getHistory();
  const session = history.find(s => s.id === sessionId);
  
  if (session) {
    save(sessionId, session);
    return true;
  }
  return false;
}

/**
 * Remove a session from history.
 * @param {string} sessionId - Session ID to remove
 * @returns {boolean} Success status
 */
function remove(sessionId) {
  ensureSessionDir();
  try {
    const history = getHistory();
    const filtered = history.filter(s => s.id !== sessionId);
    
    const historyFile = path.join(CONFIG_DIR, 'session-history.json');
    fs.writeFileSync(historyFile, JSON.stringify(filtered, null, 2), { mode: 0o600 });
    
    // If this was the current session, clear it
    const current = getCurrent();
    if (current === sessionId) {
      clear();
    }
    
    return true;
  } catch (err) {
    console.error('[Session] Error removing session:', err.message);
    return false;
  }
}

/**
 * Rename a session.
 * @param {string} sessionId - Session ID to rename
 * @param {string} newName - New name for the session
 * @returns {boolean} Success status
 */
function rename(sessionId, newName) {
  ensureSessionDir();
  try {
    const history = getHistory();
    const session = history.find(s => s.id === sessionId);
    
    if (session) {
      session.name = newName;
      session.updatedAt = new Date().toISOString();
      
      const historyFile = path.join(CONFIG_DIR, 'session-history.json');
      fs.writeFileSync(historyFile, JSON.stringify(history, null, 2), { mode: 0o600 });
      return true;
    }
    return false;
  } catch (err) {
    console.error('[Session] Error renaming session:', err.message);
    return false;
  }
}

/**
 * Export a session to a file.
 * @param {string} sessionId - Session ID to export
 * @param {string} outputPath - Output file path
 * @returns {boolean} Success status
 */
function exportSession(sessionId, outputPath) {
  try {
    const history = getHistory();
    const session = history.find(s => s.id === sessionId);
    
    if (!session) {
      return false;
    }
    
    const exportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      session: session,
    };
    
    fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2));
    return true;
  } catch (err) {
    console.error('[Session] Error exporting session:', err.message);
    return false;
  }
}

/**
 * Import a session from a file.
 * @param {string} inputPath - Input file path
 * @returns {Object|null} Imported session or null
 */
function importSession(inputPath) {
  try {
    if (!fs.existsSync(inputPath)) {
      return null;
    }
    
    const data = fs.readFileSync(inputPath, 'utf8');
    const importData = JSON.parse(data);
    
    if (!importData.session || !importData.session.id) {
      return null;
    }
    
    const session = importData.session;
    session.importedAt = new Date().toISOString();
    
    addToHistory(session.id, session);
    return session;
  } catch (err) {
    console.error('[Session] Error importing session:', err.message);
    return null;
  }
}

/**
 * Get all sessions with optional filtering.
 * @param {Object} filters - Filter options
 * @returns {Array} Filtered sessions
 */
function getAll(filters = {}) {
  let history = getHistory();
  
  if (filters.mode) {
    history = history.filter(s => s.mode === filters.mode);
  }
  
  if (filters.search) {
    const search = filters.search.toLowerCase();
    history = history.filter(s => 
      (s.name && s.name.toLowerCase().includes(search)) ||
      s.id.toLowerCase().includes(search)
    );
  }
  
  return history;
}

module.exports = {
  load,
  save,
  clear,
  getCurrent,
  setCurrent,
  switchTo,
  remove,
  rename,
  export: exportSession,
  import: importSession,
  getHistory,
  getAll,
  addToHistory,
  addReasoningEntry,
  getReasoningHistory,
};
