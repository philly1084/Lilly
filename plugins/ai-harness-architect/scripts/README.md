# Scripts

## `collect-harness-context.js`

Scans a repository and emits a compact JSON baseline for AI harness architecture work. It is intentionally heuristic: use it to find likely entrypoints and then read the files it highlights.

```powershell
node plugins/ai-harness-architect/scripts/collect-harness-context.js --root .
```
