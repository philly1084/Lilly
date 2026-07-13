const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { config } = require('./config');
const {
    getLocalGeneratedArtifact,
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
        expect(storedFiles).toContain(`${artifact.id}.pdf`);
    });
});
