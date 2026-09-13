# Lilly source consolidation — 2026-09-13

This checkpoint consolidates the pending persistent-team runtime, private
computer and Grok worker adapters, Agent Workroom controls, artifact reservations,
deployment templates, and operator verification scripts into source control.
It follows the explicit request to clean and push the existing checkout.

Machine-local proof outputs, release archives, test sessions, and nested
worktrees remain on disk under ignored `local/` and `.worktrees/` directories.
No existing local files were deleted. Deployment and token-issuance scripts
were reviewed as source; they were not executed during this consolidation.

## Verification of this source checkpoint

- Node.js 24.19.0: 1,242 tests passed in 75 suites covering team runtime,
  computer adapters, Grok integration, team routes, artifact storage, and
  workroom interactions. Exact test paths excluded copied scratch checkouts.
- Seven server readiness, frontend serving, and caching tests passed separately.
- Syntax checks passed for all 215 selected JavaScript/CommonJS files; static
  relative `require()` targets resolved to existing files.
- The local no-worker browser fixture passed desktop (1440px) and mobile
  (390px) workroom, dialog, knowledge-management, and saved-state read-back checks.
- The repository UI checker passed both viewports with no reported issues.
- The secret-sweep scanner reported 42 matches. Inspection classified them as
  runtime variable references, generated values, synthetic fixtures, or matches
  inside tool names. No embedded live credential was found in the selected files.
  The scanner's Python implementation ran directly because its Bash launcher
  was unavailable in this environment.

Local reports: `local/cleanup-team-tests.json`,
`local/cleanup-server-tests.json`, `local/cleanup-secret-scan.log`,
`ui-checks/cleanup-team-workroom/`, and
`output/playwright/persistent-teams/`. These generated reports are not committed.

## Evidence boundary

These checks establish local source and fixture behavior. This consolidation
does not deploy a release, enable team execution, start a live agent, or refresh
historical production claims in the other release documents. Live model,
storage, recovery, and deployment acceptance remain governed by their existing
runbooks and recorded limitations.
