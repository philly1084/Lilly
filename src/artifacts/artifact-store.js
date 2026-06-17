const { postgres } = require('../postgres');

function toArtifact(row) {
    if (!row) return null;

    return {
        id: row.id,
        sessionId: row.session_id,
        parentArtifactId: row.parent_artifact_id,
        direction: row.direction,
        sourceMode: row.source_mode,
        filename: row.filename,
        extension: row.extension,
        format: row.extension,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        sha256: row.sha256,
        extractedText: row.extracted_text || '',
        previewHtml: row.preview_html || '',
        metadata: row.metadata || {},
        vectorizedAt: row.vectorized_at instanceof Date ? row.vectorized_at.toISOString() : row.vectorized_at,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
}

class ArtifactStore {
    async create({
        id,
        sessionId,
        parentArtifactId = null,
        direction,
        sourceMode,
        filename,
        extension,
        mimeType,
        sizeBytes,
        sha256,
        contentBuffer,
        extractedText = '',
        previewHtml = '',
        metadata = {},
        vectorizedAt = null,
    }) {
        const result = await postgres.query(
            `
                INSERT INTO artifacts (
                    id,
                    session_id,
                    parent_artifact_id,
                    direction,
                    source_mode,
                    filename,
                    extension,
                    mime_type,
                    size_bytes,
                    sha256,
                    content_bytea,
                    extracted_text,
                    preview_html,
                    metadata,
                    vectorized_at
                )
                VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9, $10,
                    $11, $12, $13, $14::jsonb, $15
                )
                RETURNING *
            `,
            [
                id,
                sessionId,
                parentArtifactId,
                direction,
                sourceMode,
                filename,
                extension,
                mimeType,
                sizeBytes,
                sha256,
                contentBuffer,
                extractedText,
                previewHtml,
                JSON.stringify(metadata || {}),
                vectorizedAt,
            ],
        );

        return toArtifact(result.rows[0]);
    }

    async updateProcessing(id, { extractedText, previewHtml, metadata, vectorizedAt }) {
        const result = await postgres.query(
            `
                UPDATE artifacts
                SET extracted_text = COALESCE($2, extracted_text),
                    preview_html = COALESCE($3, preview_html),
                    metadata = $4::jsonb,
                    vectorized_at = $5,
                    updated_at = NOW()
                WHERE id = $1
                RETURNING *
            `,
            [id, extractedText, previewHtml, JSON.stringify(metadata || {}), vectorizedAt],
        );

        return toArtifact(result.rows[0]);
    }

    async get(id, { includeContent = false } = {}) {
        const columns = includeContent ? '*' : `
            id, session_id, parent_artifact_id, direction, source_mode,
            filename, extension, mime_type, size_bytes, sha256,
            extracted_text, preview_html, metadata, vectorized_at,
            created_at, updated_at
        `;

        const result = await postgres.query(`SELECT ${columns} FROM artifacts WHERE id = $1`, [id]);
        if (!result.rows[0]) return null;

        const artifact = toArtifact(result.rows[0]);
        if (includeContent) {
            artifact.contentBuffer = result.rows[0].content_bytea;
        }
        return artifact;
    }

    async listBySession(sessionId) {
        const result = await postgres.query(
            `
                SELECT
                    id, session_id, parent_artifact_id, direction, source_mode,
                    filename, extension, mime_type, size_bytes, sha256,
                    extracted_text, preview_html, metadata, vectorized_at,
                    created_at, updated_at
                FROM artifacts
                WHERE session_id = $1
                ORDER BY created_at DESC
            `,
            [sessionId],
        );

        return result.rows.map((row) => toArtifact(row));
    }

    async markSupersededSandboxArtifacts({
        sessionId,
        artifactId,
        title = '',
        windowMinutes = 30,
    } = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        const normalizedArtifactId = String(artifactId || '').trim();
        const normalizedTitle = String(title || '').trim();
        const boundedWindowMinutes = Math.max(1, Math.min(120, Number(windowMinutes) || 30));
        if (!normalizedSessionId || !normalizedArtifactId || !normalizedTitle) {
            return [];
        }

        const result = await postgres.query(
            `
                UPDATE artifacts
                SET metadata = jsonb_set(
                        jsonb_set(
                            metadata,
                            '{artifactLifecycle}',
                            jsonb_build_object(
                                'state', 'superseded',
                                'reason', 'sandbox_iteration_replaced',
                                'supersededByArtifactId', $2,
                                'supersededAt', to_jsonb(NOW())
                            ),
                            true
                        ),
                        '{hiddenFromArtifactList}',
                        'true'::jsonb,
                        true
                    ),
                    updated_at = NOW()
                WHERE session_id = $1
                    AND id <> $2
                    AND direction = 'generated'
                    AND source_mode = 'sandbox'
                    AND extension IN ('zip', 'html')
                    AND COALESCE(metadata->>'title', '') = $3
                    AND COALESCE(metadata->>'hiddenFromArtifactList', 'false') <> 'true'
                    AND created_at >= NOW() - ($4::text || ' minutes')::interval
                RETURNING *
            `,
            [normalizedSessionId, normalizedArtifactId, normalizedTitle, boundedWindowMinutes],
        );

        return result.rows.map((row) => toArtifact(row));
    }

    async findReusableExtractionBySha(sha256) {
        const normalizedSha = String(sha256 || '').trim();
        if (!normalizedSha) {
            return null;
        }

        const result = await postgres.query(
            `
                SELECT
                    id, session_id, parent_artifact_id, direction, source_mode,
                    filename, extension, mime_type, size_bytes, sha256,
                    extracted_text, preview_html, metadata, vectorized_at,
                    created_at, updated_at
                FROM artifacts
                WHERE sha256 = $1
                    AND extracted_text IS NOT NULL
                    AND length(trim(extracted_text)) > 0
                ORDER BY updated_at DESC
                LIMIT 1
            `,
            [normalizedSha],
        );

        return toArtifact(result.rows[0]);
    }

    async listAllWithSessions() {
        const result = await postgres.query(
            `
                SELECT
                    artifacts.id,
                    artifacts.session_id,
                    artifacts.parent_artifact_id,
                    artifacts.direction,
                    artifacts.source_mode,
                    artifacts.filename,
                    artifacts.extension,
                    artifacts.mime_type,
                    artifacts.size_bytes,
                    artifacts.sha256,
                    artifacts.extracted_text,
                    artifacts.preview_html,
                    artifacts.metadata,
                    artifacts.vectorized_at,
                    artifacts.created_at,
                    artifacts.updated_at,
                    COALESCE(sessions.metadata->>'ownerId', '') AS owner_id
                FROM artifacts
                LEFT JOIN sessions
                    ON sessions.id = artifacts.session_id
                ORDER BY artifacts.updated_at DESC
            `,
        );

        return result.rows.map((row) => ({
            ...toArtifact(row),
            ownerId: row.owner_id || null,
        }));
    }

    async delete(id) {
        const result = await postgres.query('DELETE FROM artifacts WHERE id = $1', [id]);
        return result.rowCount > 0;
    }

    async deleteBySession(sessionId) {
        const result = await postgres.query('DELETE FROM artifacts WHERE session_id = $1', [sessionId]);
        return result.rowCount;
    }
}

const artifactStore = new ArtifactStore();

module.exports = {
    artifactStore,
    ArtifactStore,
    toArtifact,
};
