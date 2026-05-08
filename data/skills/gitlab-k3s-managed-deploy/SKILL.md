Use this skill when a user asks to build, fix, retry, or redeploy a remote app/site/game on the k3s cluster and GitLab observability matters.

Operating rule:
- Treat the GitLab repository tree as the source of truth. Do not make direct live-cluster artifacts the normal deployment path.
- Use `managed-app` as the control-plane tool for GitLab-backed apps. For existing managed apps that need implementation work, call `managed-app iterate` with `executor: "remote-cli-agent"` or `useRemoteCliAgent: true`.
- Use `remote-cli-agent` directly only when there is no managed-app record yet or the task is a generic remote workspace; it must still inspect git status/remotes, prefer GitLab, commit changes, and return continuity markers.
- Use `remote-command` for diagnosis, logs, runner/platform checks, and public route verification. Avoid writing YAML or patch blobs in raw shell unless repairing a specific verified failure.
- Use `k3s-deploy` only for standard repo manifest apply or image rollout when the repo/image is already known.

Workflow:
1. Resolve the owning app/repo from managed-app catalog, session state, artifact metadata, domain, recent tool markers, or cluster registry.
2. Inspect the current GitLab tree, manifests, latest commit, pipeline/build status, image tag or digest, namespace, deployment, service, ingress, and public host.
3. Patch source and manifests in the repo, not only the live cluster. Run focused checks when practical.
4. Commit and push. Prefer the configured GitLab origin; if GitLab credentials are missing, commit locally and report the exact missing credential/API capability.
5. Observe GitLab pipeline/build events and image availability. Do not call green pods proof if no new source/image moved.
6. Deploy the known image or repo-managed manifests through managed-app/k3s-deploy.
7. Verify rollout, ingress, TLS trust separately from route/body reachability, and browser/screenshot QA for UI work.

Completion evidence:
- changed files
- commit SHA
- GitLab pipeline URL/status or build-event evidence
- image tag or digest
- k3s namespace/deployment rollout
- public host and HTTPS status
- screenshot/report path for UI deployments

Retry handling:
- For "the deployed address did not work, try again", first determine what was actually deployed and which repo/image produced it.
- Do not repeat a failed kubectl command shape. If a live repair is necessary, validate manifests before apply and then persist the durable fix back into GitLab.
- If the same root error appears twice, stop with the blocker and the next distinct recovery path.
