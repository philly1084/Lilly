---
name: harness-design-optimization
description: Design and optimize AI harnesses through repo comprehension, current research, sandbox design loops, regression decision breakdowns, and long-running goal completion. Use when the user asks for AI harness architecture, agent efficiency, model/tool routing, eval strategy, prompt/runtime optimization, context management, or durable agent workflow design.
---

# Harness Design Optimization

Use this skill when the task is to make an AI harness smarter, more efficient, more reliable, or more capable over time. The goal is a repo-grounded design loop that can keep moving toward a finished outcome, not a one-time check and response.

## Operating Principles

- Understand the repository before proposing harness architecture. Read instructions, package metadata, core entrypoints, tool adapters, orchestration code, prompt/model routing, evals, tests, UI surfaces, and deployment boundaries.
- Separate private reasoning from public decision records. Do not reveal hidden chain-of-thought; instead, publish concise decision breakdowns with evidence, tradeoffs, risks, and the selected path.
- Prefer source-grounded answers. Use repo code for local behavior, official docs for SDK/API/model behavior, public research for current design patterns, and the user for priorities, acceptance criteria, credentials, production risk, or ambiguous product intent.
- Optimize for repeatable loops: sense, analyze, design, prototype, verify, learn, and continue. Do not stop at synthesis while acceptance criteria remain unmet.
- Preserve working baselines. When one route or model path still works, keep it as a control while isolating changes.
- Make regression decisions explicit. Every meaningful design change needs expected behavior, likely failure modes, focused checks, and rollback or containment notes.
- Keep patches small enough to verify. Favor one coherent architecture improvement per pass unless the user explicitly asks for a larger redesign.

## Inputs

Collect only what is missing:

- Target repository or workspace path.
- Harness objective, such as model routing, tool selection, planning, memory, evals, prompt quality, sandbox output, browser QA, cost, latency, observability, or deployment confidence.
- Current pain point, failing path, desired workflow, or example task.
- Allowed change scope and risk boundary.
- Verification target: test command, harness run, UI route, sandbox preview, public URL, CLI flow, or acceptance checklist.
- Whether this is a one-time pass or an explicitly requested recurring automation.

If the user has not supplied a verification target, infer the narrowest meaningful check from the repo and explain it in the final report.

## Required First Tool Pass

Before design recommendations, run the local scanner when the repository is available:

```powershell
node plugins/ai-harness-architect/scripts/collect-harness-context.js --root .
```

Use the scanner output as a map, not as a substitute for reading files. Inspect the highest-signal files it reports before making design decisions.

If the scanner is unavailable, manually gather the same baseline:

- `AGENTS.md` or `agents.md`
- `package.json` scripts and dependencies
- harness/orchestration entrypoints
- tool registry and adapters
- prompt/model routing code
- memory/context modules
- eval and test files
- frontend/sandbox verification surfaces
- plugin and skill definitions

## Workflow

1. Baseline the harness:
   - Check `git status` before edits.
   - Run the scanner and read the top candidate files.
   - Identify the active user-facing flow, backend route, planner/orchestrator path, tool adapters, memory inputs, tests, and UI or sandbox surfaces.
   - Write a compact context model: current goal, relevant modules, control path that already works, suspected weak points, and verification options.

2. Route research deliberately:
   - Use current official docs when SDKs, model APIs, tool-calling behavior, browser automation, eval frameworks, or deployment/runtime rules may have changed.
   - Use public research or product examples when designing harness UX, dashboards, agent workflows, or evaluation methodology.
   - Use repo-local docs and tests for behavior that is already encoded locally.
   - Ask the user when the decision is about business priority, acceptable risk, credentials, production access, or subjective product direction.
   - Cite exact URLs and access dates in final reports when external research was used.

3. Create the design decision breakdown:
   - State the decision to make.
   - List 2-3 viable options.
   - Compare them on reliability, context quality, latency/cost, implementation scope, regression risk, observability, and user experience.
   - Choose one option and name the evidence that supports it.
   - Define acceptance checks before implementation.

4. Prototype or sandbox when design risk is visual, workflow-heavy, or interaction-heavy:
   - Use a sandbox preview for harness dashboards, workflow UIs, prompt/eval reports, agent control panels, or complex generated artifacts.
   - Prefer local `/api/sandbox-libraries/` routes for browser libraries in KimiBuilt previews.
   - Run `node bin/kimibuilt-ui-check.js <url-or-file-url> --out ui-checks/<name>` for generated HTML when a browser is available.
   - Treat page errors, low contrast, horizontal overflow, broken images, empty body text, clipped labels, and overlapping text as blockers.

5. Implement the smallest useful architecture improvement:
   - Follow the repo style.
   - Keep user changes intact.
   - Add or update focused tests when behavior changes.
   - Update docs, prompts, fixtures, or examples when operator behavior changes.
   - Do not hide important design assumptions inside prose only; encode reusable behavior in skills, helper functions, tests, or scripts where practical.

6. Run regression checks:
   - Identify affected flows and one known-good control.
   - Run the narrowest automated tests that cover the change.
   - For frontend or sandbox work, use browser or screenshot verification.
   - For model/prompt/tool-routing work, include fixture-style checks, harness run output, or deterministic parser/state tests where possible.
   - Record failures separately as root cause, side noise, or unrelated existing breakage.

7. Continue until the end goal is handled:
   - If a check fails, inspect the failure and iterate.
   - If external access, credentials, or product judgment blocks progress, ask the user the smallest concrete question.
   - If the user asked for recurring work, create an automation with the target repo, objective, research rules, allowed scope, and verification report format.
   - If recurring work was not requested, finish the current pass and recommend a next pass without scheduling it.

## Source Selection Guide

- OpenAI, SDK, model, Responses API, Agents SDK, or tool-calling behavior: official docs first.
- Browser automation, frontend framework, accessibility, or design-system behavior: official docs or mature project docs first.
- KimiBuilt-specific behavior: repo code, tests, local skills, and project memory before public research.
- Live deployment behavior: cluster state, logs, events, rollout status, and endpoint probes before assumptions.
- Product direction or subjective success: ask the user.

## Regression Decision Template

Use this public template instead of exposing hidden reasoning:

```markdown
Decision: <what architecture choice is being made>
Repo Evidence: <files, tests, routes, or logs inspected>
Options: <2-3 short options>
Chosen Path: <selected option and why>
Risks: <regression/cost/latency/context/user-experience risks>
Checks: <tests, harness runs, sandbox/browser checks>
Result: <pass/fail evidence and next action>
```

## Final Report

Use this compact structure:

```markdown
**Harness Architecture Pass**
Goal: <target objective>
Repo Model: <key surfaces inspected>
Decision: <chosen design direction>
Research: <sources used or "not needed">
Changed: <files or "design only">
Verified: <tests/checks/screenshots/sandbox outputs>
Risks: <remaining risk or "none found">
Next: <next useful pass, if any>
```
