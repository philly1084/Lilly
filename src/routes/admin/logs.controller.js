/**
 * Logs Controller
 * Manages request/response logs
 */

const { randomUUID } = require('crypto');
const path = require('path');
const { PROJECT_ROOT, resolvePreferredWritableFile } = require('../../runtime-state-paths');
const {
  appendJsonlRecordSync,
  readJsonlRecordsSync,
  writeJsonlRecordsSync,
} = require('../../observability/jsonl-persistence');

function getLogsStoragePath() {
  return resolvePreferredWritableFile(
    path.join(PROJECT_ROOT, 'data', 'observability', 'logs.jsonl'),
    ['observability', 'logs.jsonl'],
  );
}

class LogsController {
  constructor(options = {}) {
    this.storagePath = path.resolve(options.storagePath || getLogsStoragePath());
    this.logs = readJsonlRecordsSync(this.storagePath);
    this.maxLogs = 10000;
  }

  /**
   * Add a log entry (called by other controllers)
   */
  addLog(entry) {
    const log = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry
    };

    this.logs.unshift(log);

    // Keep only recent logs
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(0, this.maxLogs);
      writeJsonlRecordsSync(this.storagePath, this.logs);
    } else {
      appendJsonlRecordSync(this.storagePath, log);
    }

    return log;
  }

  /**
   * Get all logs with filtering
   */
  async getAll(req, res) {
    try {
      const { 
        level = 'all', 
        model = 'all', 
        status = 'all',
        search = '',
        from,
        to,
        page = 1,
        limit = 50
      } = req.query;

      let filtered = [...this.logs];

      // Apply filters
      if (level !== 'all') {
        filtered = filtered.filter(l => l.level === level);
      }

      if (model !== 'all') {
        filtered = filtered.filter(l => l.model === model);
      }

      if (status !== 'all') {
        filtered = filtered.filter(l => l.status === status);
      }

      if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter(l => 
          l.message?.toLowerCase().includes(searchLower) ||
          l.prompt?.toLowerCase().includes(searchLower) ||
          l.error?.toLowerCase().includes(searchLower)
        );
      }

      if (from) {
        const fromDate = new Date(from);
        filtered = filtered.filter(l => new Date(l.timestamp) >= fromDate);
      }

      if (to) {
        const toDate = new Date(to);
        filtered = filtered.filter(l => new Date(l.timestamp) <= toDate);
      }

      // Pagination
      const total = filtered.length;
      const offset = (page - 1) * limit;
      const paginated = filtered.slice(offset, offset + parseInt(limit));

      res.json({
        success: true,
        data: paginated,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      console.error('Error getting logs:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Stream logs (Server-Sent Events)
   */
  async stream(req, res) {
    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const sendLog = (log) => {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
      };

      // Send existing recent logs
      this.logs.slice(0, 50).reverse().forEach(sendLog);

      // Set up listener for new logs
      const interval = setInterval(() => {
        // In real implementation, this would listen to an event emitter
        res.write(`: heartbeat\n\n`);
      }, 30000);

      req.on('close', () => {
        clearInterval(interval);
      });
    } catch (error) {
      console.error('Error streaming logs:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get log by ID
   */
  async getById(req, res) {
    try {
      const { id } = req.params;
      const log = this.logs.find(l => l.id === id);

      if (!log) {
        return res.status(404).json({ success: false, error: 'Log not found' });
      }

      res.json({ success: true, data: log });
    } catch (error) {
      console.error('Error getting log:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Clear all logs
   */
  async clear(req, res) {
    try {
      const count = this.logs.length;
      this.logs = [];
      writeJsonlRecordsSync(this.storagePath, this.logs);

      res.json({ 
        success: true, 
        data: { cleared: true, count } 
      });
    } catch (error) {
      console.error('Error clearing logs:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Export logs
   */
  async export(req, res) {
    try {
      const { format } = req.params;
      const { level, model, from, to } = req.query;

      let filtered = [...this.logs];

      if (level && level !== 'all') {
        filtered = filtered.filter(l => l.level === level);
      }

      if (model && model !== 'all') {
        filtered = filtered.filter(l => l.model === model);
      }

      if (from || to) {
        const fromDate = from ? new Date(from) : new Date(0);
        const toDate = to ? new Date(to) : new Date();
        filtered = filtered.filter(l => {
          const date = new Date(l.timestamp);
          return date >= fromDate && date <= toDate;
        });
      }

      switch (format) {
        case 'json':
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Disposition', 'attachment; filename="logs.json"');
          res.json(filtered);
          break;

        case 'csv':
          res.setHeader('Content-Type', 'text/csv');
          res.setHeader('Content-Disposition', 'attachment; filename="logs.csv"');
          
          const headers = ['timestamp', 'level', 'model', 'status', 'message', 'duration'];
          const csv = [
            headers.join(','),
            ...filtered.map(l => 
              headers.map(h => {
                const val = l[h];
                if (val === null || val === undefined) return '';
                const str = String(val).replace(/"/g, '""');
                return str.includes(',') ? `"${str}"` : str;
              }).join(',')
            )
          ].join('\n');
          
          res.send(csv);
          break;

        default:
          res.status(400).json({ success: false, error: 'Unsupported format' });
      }
    } catch (error) {
      console.error('Error exporting logs:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
}

module.exports = new LogsController();
module.exports.LogsController = LogsController;
module.exports.getLogsStoragePath = getLogsStoragePath;
