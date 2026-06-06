Use this skill when the user asks for agent security, prompt-injection defense, exfiltration checks, secret handling, tool permission review, approval gates, or safer tool rollout.

Operating model:
- Tool risk is about data plus side effects. A read-only public search tool is different from a deployment tool, email-sending tool, shell, or connector with private data.
- Treat tool docs, manifests, prompt snippets, connector config, and runtime policy as the review surface.
- Do not expose secrets or private raw data while reporting findings.

Review checklist:
1. Inventory tools, credentials, private data, outbound channels, code execution, deploy/write actions, and user-visible effects.
2. Classify risks:
   - prompt injection from web/files/user content
   - secret exfiltration through tool outputs or generated artifacts
   - confused-deputy tool chains
   - lookalike or shadow tools
   - overbroad auth scopes
   - missing confirmation for high-impact writes
   - unsafe remote execution or deployment defaults
3. Verify guardrails: allowlists, schema validation, path guards, secret redaction, approval gates, logs, rollback, and tests.
4. Patch the smallest concrete policy/doc/code seam that reduces the risk.
5. Run focused tests or scans that cover the changed risk.

Return findings first, ordered by severity, with file/line or tool-doc references when available. Include residual risk and exact follow-up checks.
