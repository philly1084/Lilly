# managed-app

Creates, updates, and deploys agent-owned applications through the external GitLab control plane and the remote runner or SSH/k3s deployment lane.

Managed-app deployment should use the configured remote runner when it is online, with SSH retained as a break-glass fallback. It should deploy through the configured remote host and remote k3s cluster, not through the backend pod's local Kubernetes service account.

Use this tool as the control-plane entry point when the remote GitLab instance, BuildKit runner, and deploy cluster all live on the same remote server or k3s environment.

Lane boundary: `managed-app` is the GitLab-observable control plane. Use `managed-app create` for new GitLab-backed app repos, `managed-app iterate` for existing app edits/builds/deploys, and `managed-app doctor` / `managed-app reconcile` for platform health. When an existing managed app needs complex CLI work, call `managed-app iterate` with `executor: "remote-cli-agent"` so the remote CLI agent is a worker inside the managed loop instead of an opaque parallel deployment path.

## Actions

- `create`: registers or provisions a managed app, creates the external GitLab repository when configured, generates the initial app source, seeds the repo, and records a build run when a commit is created.
- `update`: updates an existing managed app by slug or id, applies software changes into the managed repo, and can queue a new remote build/deploy cycle.
- `iterate`: backend-owned Replit-style managed-app loop for an existing app. It accepts `action: edit|build|deploy|verify`, records stage/evidence metadata on the build run, and returns the app, progress, GitLab evidence, preview URL, and next actions. `edit`, `build`, and `verify` are accepted as direct aliases.
- `iterate` can explicitly use `executor: "remote-cli-agent"` or `useRemoteCliAgent: true` when the app needs complex backend CLI work. In that mode `remote-cli-agent` is a managed worker, not the owner of the product loop: it must inspect the GitLab tree, push a GitLab commit, and return marker lines such as `GIT_REPO`, `GIT_COMMIT`, `CHANGED_FILES`, `PIPELINE_URL`, `IMAGE_TAG`, `DEPLOYMENT`, `PUBLIC_HOST`, `UI_CHECK_REPORT`, and `UI_SCREENSHOTS`; the managed-app build run stores those markers as iteration evidence.
- `deploy`: deploys an existing managed app into the configured remote k3s app cluster over SSH.
- `inspect`: returns the app record plus recent build runs.
- `doctor`: SSHes to the remote deploy host and inspects the managed-app platform namespace so the agent can check GitLab, BuildKit, `gitlab-runner`, runner tags, and runner token state in one call. `diagnose`, `diagnostic`, and `diagnostics` are accepted as aliases.
- `reconcile`: uses the configured GitLab settings plus remote SSH/k3s access to update the `gitlab-runner` secret on the remote cluster and restart or scale `gitlab-runner`. `repair` and `repair-runner` are accepted as aliases.
- `list`: lists the current user's managed apps.

## Required setup

- Postgres persistence must be enabled.
- Admin Settings must configure `integrations.gitlab` with:
  - `baseURL`
  - `token`
  - `webhookSecret`
  - `org`
  - `registryHost`
  - `runnerToken` for platform reconciliation
- Admin Settings must configure `integrations.managedApps` with:
  - `appBaseDomain`
  - `namespacePrefix`
  - `platformNamespace`
- The KimiBuilt runtime must have either a connected remote runner or SSH access to the configured remote k3s host.

## Notes

- Build runs are tracked authoritatively in Postgres.
- Cluster verification state and remote server baseline context are also recorded in the file-backed cluster registry so later turns can reuse rollout, ingress, TLS, HTTPS, host, k3s, and ingress-controller context.
- The external GitLab CI pipeline is expected to POST build events to `/api/integrations/gitlab/build-events` with `X-KimiBuilt-Webhook-Secret`.
- `deploy` now refuses to continue when the latest build is still queued/running or failed, unless an explicit image tag is provided. It should deploy a known-good image, not guess.
- `deploy` refreshes remote k3s platform context before manifest apply so later agents inherit a simple baseline for the deploy host and cluster.
- `deploy` creates the app namespace image pull secret from the remote `agent-platform-runtime` Secret when GitLab and k3s live on the same remote platform. Admin Settings registry credentials are only a fallback, which avoids stale local passwords causing image-pull `401 Unauthorized` errors.
- The `doctor` action is the preferred first check when GitLab pipelines are queued or waiting. It inspects the same remote cluster the managed-app deploy lane uses.
- The `reconcile` action is the preferred repair path when the platform exists but GitLab runners are missing, tokened incorrectly, or stuck waiting. It is designed for the case where the GitLab instance and deploy cluster live on the same remote server or k3s environment.
- For explicit managed app authoring requests, prefer `managed-app create` for new apps and `managed-app iterate` for follow-up edits/builds/deploys over ad hoc repo-runner tools. The iteration response must be treated as incomplete until GitLab/source, image/build, rollout, and public verification evidence are present.
- Use `remote-cli-agent` through `managed-app iterate`, not as an opaque handoff card, when the target is an existing managed app and the user wants the backend CLI agent to do complex work. Missing `GIT_COMMIT` or repeated `USER_INPUT_REQUIRED` means the iteration is blocked, not complete.
- Do not use ad hoc live-cluster ConfigMap/nginx deployments as the normal managed-app path. The normal path is GitLab tree -> pipeline/image -> k3s rollout -> public verification. Use live-cluster repair only as recovery, then persist the same change back into GitLab.
