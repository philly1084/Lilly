# KimiBuilt Privacy And Data Governance

This packet documents KimiBuilt's current data flows and operating controls for a Canadian-first project review. It is not a legal compliance certification. Operators should treat PIPEDA, applicable provincial privacy laws, sector requirements, customer contracts, and deployment-specific policies as obligations to validate before production use with real users.

## Scope

KimiBuilt is a multi-interface AI workbench. Data can enter through web chat, web CLI, notes/canvas/document tools, artifact upload and generation, admin operations, API clients, WebSocket/SSE streams, and scheduled or managed workloads.

The current implementation stores durable application data mainly in:

- Postgres tables for sessions, session messages, user session state/preferences, generated artifacts, agent workloads/runs, managed apps, and related metadata.
- Qdrant for vector memory derived from selected conversation, artifact, research, and skill summaries.
- Ollama for embeddings; the default embedding model is `nomic-embed-text:latest`.
- Local file-backed fallback state under the configured persistence data directory when Postgres is not configured.
- Kubernetes secrets and environment variables for credentials and service configuration.

## Data Categories

| Category | Examples | Primary storage | Purpose |
| --- | --- | --- | --- |
| Chat and tool conversation data | User prompts, assistant replies, tool metadata, response ids, timestamps | `sessions`, `session_messages`, session metadata | Session continuity, streaming chat, admin history, troubleshooting |
| Notes and canvas content | Notes pages, trash, spaces, selected page id, preferred model | `user_session_state.preferences` namespace `notes` | Persisted user workspace state |
| Generated artifacts | HTML, PDF, PPTX, XLSX, Markdown, images, audio/video references, extracted text, preview HTML, SHA-256, metadata | `artifacts` table or local generated artifact fallback | Download, preview, reuse, document generation, managed app export |
| Uploads | Uploaded files, labels, tags, extracted text and previews | `artifacts` table or local fallback | User-provided source material for AI tasks |
| Vector memory | Conversation facts, artifact summaries/source chunks, research notes, learned workflow summaries, owner/scope metadata | Qdrant collection from `QDRANT_COLLECTION` | Context recall across current session, scoped workspace, or shared artifact workflows |
| Auth/session data | JWT cookie subject/role/expiry, bearer/API key checks, active session ids, owner ids | HTTP-only cookies, request headers, `user_session_state`, session metadata | Access control and session ownership |
| Logs and telemetry | Console logs, health checks, runtime diagnostics, admin storage summaries, Kubernetes events | Process logs, admin endpoints, cluster logs | Operations monitoring, incident triage, release evidence |
| Workload and managed app metadata | Scheduled/deferred workload prompts, stages, run events, managed app source metadata | Postgres workload/managed app tables | Automation, deployment, and auditability |

## Collection And Use

KimiBuilt should collect only the content needed to complete the user's requested AI task, preserve session continuity, operate the platform, and support incident response. Prompts, notes, uploads, artifacts, and model/tool metadata may contain personal information if users provide it. Operators should avoid asking for sensitive personal information unless it is necessary for the task and appropriate for the deployment context.

Generated output and uploaded files may be sent to configured model, tool, renderer, embedding, or remote runner services. Deployment owners must document any external processors used in their environment, including OpenAI-compatible model endpoints, media generation providers, remote build runners, and browser/rendering services.

## Access Control

- Authenticated routes use the configured username/password/JWT secret when auth is enabled.
- Auth cookies are HTTP-only, `SameSite=Lax`, and secure in production or HTTPS-forwarded requests.
- API, WebSocket, preview, and OpenAI-compatible routes can also authorize with configured frontend/API gateway tokens where implemented.
- Session and artifact routes check the authenticated owner before returning user-owned sessions, messages, artifacts, previews, downloads, or managed-app exports.
- Admin storage cleanup and inspection routes should be limited to trusted operators.

## Retention

KimiBuilt does not currently enforce a universal automatic retention schedule for all production data. The practical retention policy is:

- Keep active sessions, notes, artifacts, vector memory, and workload records only as long as they are needed for user continuity, project evidence, support, or legal/business requirements.
- Use admin storage cleanup for age-based cleanup where available, with dry-run first.
- Treat generated artifacts and uploads as user content; delete them when the related session is deleted or when an operator removes them directly.
- Treat vector memory as derived user content; delete it when deleting the related session, and document any shared memory scopes that intentionally outlive a single session.
- Backups, database snapshots, and cluster-level persistent volumes may retain deleted data until the backup retention period expires. Deployment owners must define and document that backup window.

Recommended default for small private deployments: review stale sessions/artifacts monthly, dry-run cleanup first, then remove records older than the agreed project retention window.

## Instituted Operating Measures

Use these measures for every privacy-impacting operation until a broader automated privacy workflow exists.

### Data Request Intake

Record each access, export, correction, or deletion request in the project support log with:

- Request date, request type, requester, authenticated owner id, and affected workspace/session/artifact ids.
- Verification method used before acting on the request.
- Operator handling the request and the date completed.
- Systems checked: Postgres sessions/messages, artifacts, notes preferences, workloads/managed apps if relevant, Qdrant memory, local generated files, and backups.
- Any unavailable dependency or deferred backup deletion follow-up.

Do not process a data request from chat text alone. The operator must confirm the requester controls the authenticated owner account or use a deployment-approved identity verification path.

### Monthly Retention Review

Run this review monthly, or before handing the system to a new operator:

1. Open the admin storage dashboard or call `GET /api/admin/storage`.
2. Run admin storage cleanup in dry-run mode for the agreed retention window.
3. Review stale chat sessions, stored artifacts, local generated artifacts, audio, and video records.
4. Confirm no records are needed for active support, audit evidence, project deliverables, or legal/business hold.
5. Run cleanup only after dry-run review and record the matched/deleted counts.
6. Confirm backup retention windows separately; app cleanup does not immediately erase backups.

### Export Procedure

For owner-scoped export requests, provide only data the authenticated owner can access:

1. Confirm the owner id and relevant scope or session ids.
2. Export recent messages with `GET /api/sessions/:id/messages`.
3. Export session artifact inventory with `GET /api/sessions/:id/artifacts`.
4. Download requested artifacts with `GET /api/artifacts/:id/download`.
5. Export notes with `GET /api/notes`.
6. Include a plain-language note that Qdrant memory export is not currently exposed as a user-facing route.

Do not use admin exports to bypass owner checks unless the request is being handled as an approved operator/admin request.

### Deletion Procedure

For owner-scoped deletion requests:

1. Confirm the owner id and scope/session/artifact ids.
2. Delete individual sessions with `DELETE /api/sessions/:id`, or delete a scoped workspace with `DELETE /api/sessions` and the required scope hints.
3. Delete individual artifacts with `DELETE /api/artifacts/:id` when only a generated/uploaded file should be removed.
4. Delete notes data with `DELETE /api/notes`.
5. For stale admin-managed storage, use `POST /api/admin/storage/cleanup` with dry-run first, then run without dry-run only after review.
6. Check logs for memory cleanup warnings. If Qdrant was unavailable, re-run or manually verify `memoryService.forget(sessionId)` equivalent cleanup when the dependency is healthy.
7. Record backup retention follow-up; snapshots and persistent volume backups may retain deleted data until their retention window expires.

### Secret Or Sensitive Data Incident

If API keys, passwords, private tokens, personal health information, financial details, or other sensitive material appear in chat, notes, uploads, artifacts, or logs:

1. Stop sharing the affected artifact/session externally.
2. Rotate exposed credentials immediately; deletion alone is not enough for secrets.
3. Delete or restrict affected sessions, notes, and artifacts through the routes above.
4. Check logs and generated previews for copied values.
5. Record the incident, rotation evidence, deletion steps, and any backup-retention follow-up.

## Deletion

Implemented deletion paths include:

- `DELETE /api/sessions/:id` deletes the owned session, clears active-session pointers, deletes persisted artifacts for that session when Postgres artifact storage is active, and asynchronously removes Qdrant memory for the session.
- `DELETE /api/sessions` with a required scoped workspace deletes all owned sessions in that scope and triggers the same artifact and memory cleanup path.
- `DELETE /api/artifacts/:id` deletes an owned artifact.
- `DELETE /api/notes` clears persisted notes data, selected page, and notes model preference for the authenticated owner.
- Admin storage cleanup can remove chat sessions, stored artifacts, and generated local files by category and age.

Known gaps:

- Memory cleanup failures are logged and do not block session deletion, so operators should re-run cleanup or manually check Qdrant after a failed dependency incident.
- There is no single user-wide "delete all personal data" endpoint that spans sessions, notes, artifacts, workloads, managed apps, local generated files, vector memory, and backups.
- Backup and volume snapshot deletion depends on the deployment environment and is not enforced by application routes.

## Export And Portability

Implemented export/download paths include:

- `GET /api/sessions/:id/messages` for recent session messages.
- `GET /api/sessions/:id/artifacts` for artifact inventory associated with a session.
- `GET /api/artifacts/:id/download` and artifact bundle routes for generated or uploaded artifacts.
- Notes data is returned by `GET /api/notes` for the authenticated owner.

Known gaps:

- There is no single consolidated export package for all data associated with an owner.
- Vector memory export is not exposed as a user-facing route.
- Admin/operator exports should be handled carefully to avoid exposing another user's scoped sessions or artifacts.

## Secrets Handling

- Do not commit `.env` files, API keys, JWT secrets, database passwords, or Kubernetes secret manifests containing live values.
- Store runtime secrets in Kubernetes Secrets, GitHub/GitLab Actions secrets, or the deployment's secret manager.
- Logs and load-test output should report token presence or sanitized status only, not token values or full sensitive response bodies.
- If a secret is pasted into chat, notes, uploads, or artifacts, treat it as exposed and rotate it rather than relying only on deletion.

## Backups And Recovery

Production operators should define:

- Postgres backup frequency, retention window, encryption, restore test cadence, and who can access backups.
- Persistent volume and local generated-file backup rules.
- Whether Qdrant memory is backed up, rebuilt from source records, or treated as disposable derived data.
- A deletion-after-restore procedure so previously deleted user records are not accidentally restored permanently.

## Canadian Privacy Notes

For Canadian operations, use PIPEDA's practical accountability principles as the baseline: identify purposes, limit collection, limit use/disclosure/retention, safeguard data, keep practices transparent, and provide access/correction/deletion workflows appropriate to the deployment. Provincial public-sector, health, education, or private-sector laws may add requirements depending on who uses the system and what data they enter.

Do not claim KimiBuilt is compliant with PIPEDA or any provincial statute solely because this document exists. Treat this packet as the operational evidence map and gap register for a privacy review.

## Operator Checklist

- Confirm auth is enabled before exposing non-local deployments.
- Confirm sessions, artifacts, notes, memory, workloads, and managed apps have documented owners and scopes.
- Confirm the model/provider list and data processors match the deployment's privacy notice.
- Confirm backup retention and restore procedures are documented.
- Run storage cleanup in dry-run mode before deleting stale records.
- Verify deletion requests by checking session records, artifacts, notes preferences, and Qdrant memory when possible.
- Record privacy-impacting incidents in the incident runbook and rotate exposed secrets immediately.
