const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');

const { config } = require('./config');
const {
    deleteLocalGeneratedArtifact,
    getLocalGeneratedArtifact,
    listLocalGeneratedArtifactsBySession,
    persistGeneratedArtifactLocally,
} = require('./generated-file-artifacts');

describe('generated-file-artifacts', () => {
    let originalDataDir;
    let tempDir;

    beforeEach(async () => {
        originalDataDir = config.persistence.dataDir;
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-local-artifacts-'));
        config.persistence.dataDir = tempDir;
    });

    afterEach(async () => {
        config.persistence.dataDir = originalDataDir;
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('sanitizes explicit local fallback artifact filenames before persisting metadata', async () => {
        const artifact = await persistGeneratedArtifactLocally({
            sessionId: 'session-1',
            filename: 'Client "Q3" / Draft?.html',
            extension: 'html',
            mimeType: 'text/html',
            buffer: Buffer.from('<h1>Report</h1>'),
            previewHtml: '<h1>Report</h1>',
        });

        expect(artifact.filename).toBe('Client Q3 - Draft-.html');
        expect(artifact.downloadUrl).toBe(`/api/artifacts/${artifact.id}/download`);
        expect(artifact.previewUrl).toBe(`/api/artifacts/${artifact.id}/preview`);

        const stored = await getLocalGeneratedArtifact(artifact.id);
        expect(stored).toEqual(expect.objectContaining({
            id: artifact.id,
            filename: 'Client Q3 - Draft-.html',
            metadata: expect.objectContaining({
                storage: 'local-fallback',
            }),
        }));
    });

    test('persists MIME-like extension values as a usable local artifact file', async () => {
        const artifact = await persistGeneratedArtifactLocally({
            sessionId: 'session-2',
            filename: 'Quarterly brief',
            extension: 'application/pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from('%PDF-test'),
        });

        expect(artifact).toEqual(expect.objectContaining({
            filename: 'Quarterly brief.pdf',
            extension: 'pdf',
            format: 'pdf',
        }));

        const storedFiles = await fs.readdir(path.join(tempDir, 'generated-artifacts'));
        expect(storedFiles).toContain(`${artifact.id}.content.pdf`);
    });

    test.each(['json', ''])('preserves JSON bytes with extension %p through storage and deletion', async (extension) => {
        const buffer = Buffer.from('{"message":"Ready", "count":0, "enabled":false}\n');
        const artifact = await persistGeneratedArtifactLocally({
            sessionId: 'json-session',
            filename: 'result.json',
            extension,
            mimeType: 'application/json',
            buffer,
        });

        const stored = await getLocalGeneratedArtifact(artifact.id, { includeContent: true });
        expect(stored.contentBuffer).toEqual(buffer);
        expect(stored.sizeBytes).toBe(buffer.length);
        expect(stored.sha256).toBe(createHash('sha256').update(stored.contentBuffer).digest('hex'));
        expect(stored.filename).toBe('result.json');
        expect(await listLocalGeneratedArtifactsBySession('json-session')).toEqual([artifact]);

        expect(await deleteLocalGeneratedArtifact(artifact.id)).toBe(true);
        expect(await getLocalGeneratedArtifact(artifact.id)).toBeNull();
        expect(await fs.readdir(path.join(tempDir, 'generated-artifacts'))).toEqual([]);
    });

    test('reads and deletes artifacts saved with the legacy content filename', async () => {
        const id = 'artifact-local-legacy';
        const baseDir = path.join(tempDir, 'generated-artifacts');
        const contentPath = path.join(baseDir, `${id}.txt`);
        await fs.mkdir(baseDir, { recursive: true });
        await fs.writeFile(contentPath, 'Original report');
        await fs.writeFile(path.join(baseDir, `${id}.json`), JSON.stringify({
            id,
            sessionId: 'legacy-session',
            filename: 'report.txt',
            extension: 'txt',
            contentPath,
        }));

        const stored = await getLocalGeneratedArtifact(id, { includeContent: true });
        expect(stored.contentBuffer.toString()).toBe('Original report');
        expect(await deleteLocalGeneratedArtifact(id)).toBe(true);
        expect(await fs.readdir(baseDir)).toEqual([]);
    });
});
