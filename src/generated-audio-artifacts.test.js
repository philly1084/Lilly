jest.mock('./artifacts/artifact-service', () => ({
    artifactService: {
        createStoredArtifact: jest.fn(),
        serializeArtifact: jest.fn(),
    },
}));

jest.mock('fs/promises', () => ({
    mkdir: jest.fn(),
    writeFile: jest.fn(),
    readFile: jest.fn(),
}));

jest.mock('./session-store', () => ({
    sessionStore: {
        update: jest.fn(),
    },
}));

const { artifactService } = require('./artifacts/artifact-service');
const { sessionStore } = require('./session-store');
const fs = require('fs/promises');
const {
    buildGeneratedAudioFilename,
    persistGeneratedAudio,
} = require('./generated-audio-artifacts');

describe('generated-audio-artifacts', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        artifactService.createStoredArtifact.mockResolvedValue({
            id: 'artifact-audio-1',
            sessionId: 'session-1',
            filename: 'release-brief.wav',
            extension: 'wav',
            mimeType: 'audio/wav',
            metadata: {},
        });
        artifactService.serializeArtifact.mockReturnValue({
            id: 'artifact-audio-1',
            filename: 'release-brief.wav',
            format: 'wav',
            mimeType: 'audio/wav',
            downloadUrl: '/api/artifacts/artifact-audio-1/download',
            metadata: {},
        });
        sessionStore.update.mockResolvedValue({});
        fs.mkdir.mockResolvedValue(undefined);
        fs.writeFile.mockResolvedValue(undefined);
        fs.readFile.mockResolvedValue(Buffer.from('RIFF-test-audio'));
    });

    test('persists generated audio as a session artifact and returns reusable URLs', async () => {
        const result = await persistGeneratedAudio({
            sessionId: 'session-1',
            sourceMode: 'chat',
            text: 'This is the saved narration.',
            title: 'Release brief',
            provider: 'piper',
            voice: {
                id: 'piper-female-natural',
                label: 'Female natural',
            },
            audioBuffer: Buffer.from('RIFF-test-audio'),
            mimeType: 'audio/wav',
        });

        expect(artifactService.createStoredArtifact).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            direction: 'generated',
            sourceMode: 'chat',
            extension: 'wav',
            mimeType: 'audio/wav',
            extractedText: 'This is the saved narration.',
            vectorize: true,
        }));
        expect(sessionStore.update).toHaveBeenCalledWith('session-1', {
            metadata: {
                lastGeneratedAudioArtifactIds: ['artifact-audio-1'],
            },
        });
        expect(result.audio).toEqual(expect.objectContaining({
            artifactId: 'artifact-audio-1',
            downloadUrl: '/api/artifacts/artifact-audio-1/download',
            inlinePath: '/api/artifacts/artifact-audio-1/download?inline=1',
        }));
    });

    test('sanitizes explicit generated audio filenames before download handoff', () => {
        expect(buildGeneratedAudioFilename({
            filename: '../Release: Brief\r\nFinal\"',
            extension: 'wav',
        })).toBe('-Release- BriefFinal.wav');
    });

    test('falls back to local audio artifacts when Postgres artifacts are unavailable', async () => {
        const error = new Error('Artifacts require Postgres to be configured');
        error.statusCode = 503;
        artifactService.createStoredArtifact.mockRejectedValue(error);

        const result = await persistGeneratedAudio({
            sessionId: 'session-1',
            sourceMode: 'chat',
            text: 'This is the local narration.',
            title: 'Local brief',
            provider: 'piper',
            voice: {
                id: 'piper-female-natural',
            },
            audioBuffer: Buffer.from('RIFF-local-audio'),
            mimeType: 'audio/wav',
        });

        expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining('generated-audio'), { recursive: true });
        expect(fs.writeFile).toHaveBeenCalledWith(
            expect.stringMatching(/audio-local-.+\.wav$/),
            Buffer.from('RIFF-local-audio'),
        );
        expect(result.artifact).toEqual(expect.objectContaining({
            id: expect.stringMatching(/^audio-local-/),
            filename: 'local-brief.wav',
            downloadUrl: expect.stringContaining('/api/artifacts/audio-local-'),
        }));
        expect(result.audio).toEqual(expect.objectContaining({
            artifactId: expect.stringMatching(/^audio-local-/),
            downloadUrl: expect.stringContaining('/api/artifacts/audio-local-'),
            inlinePath: expect.stringContaining('?inline=1'),
        }));
    });
});
