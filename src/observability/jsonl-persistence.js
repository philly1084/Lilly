const fs = require('fs');
const path = require('path');

function ensureParentDirectory(filePath = '') {
    if (!filePath) {
        return;
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonlRecordsSync(filePath = '') {
    if (!filePath || !fs.existsSync(filePath)) {
        return [];
    }

    try {
        const contents = fs.readFileSync(filePath, 'utf8');
        return contents
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                try {
                    return JSON.parse(line);
                } catch (_error) {
                    return null;
                }
            })
            .filter(Boolean);
    } catch (_error) {
        return [];
    }
}

function appendJsonlRecordSync(filePath = '', record = null) {
    if (!filePath || !record || typeof record !== 'object') {
        return;
    }

    const serialized = `${JSON.stringify(record)}\n`;
    ensureParentDirectory(filePath);
    const descriptor = fs.openSync(filePath, 'a+');
    try {
        const { size } = fs.fstatSync(descriptor);
        let separator = '';
        if (size > 0) {
            const lastByte = Buffer.alloc(1);
            fs.readSync(descriptor, lastByte, 0, 1, size - 1);
            // Isolate an interrupted tail so it cannot swallow the next record.
            separator = lastByte[0] === 0x0a ? '' : '\n';
        }
        fs.appendFileSync(descriptor, `${separator}${serialized}`, 'utf8');
    } finally {
        fs.closeSync(descriptor);
    }
}

function writeJsonlRecordsSync(filePath = '', records = []) {
    if (!filePath) {
        return;
    }

    ensureParentDirectory(filePath);
    const serialized = (Array.isArray(records) ? records : [])
        .filter((record) => record && typeof record === 'object')
        .map((record) => JSON.stringify(record))
        .join('\n');
    fs.writeFileSync(filePath, serialized ? `${serialized}\n` : '', 'utf8');
}

module.exports = {
    appendJsonlRecordSync,
    readJsonlRecordsSync,
    writeJsonlRecordsSync,
};
