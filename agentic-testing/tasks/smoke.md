# Task: smoke test

Minimal task for verifying that `./agentic-testing/run launch claude
--task tasks/smoke.md` plumbs through correctly: setup runs, launcher
spawns claude, transcript captures, analyzer produces output. Doesn't
exercise any MCP tool — just proves the chain end-to-end without
spending an agentic-test budget.

## Prompt

Output the literal text "smoke test ok" and stop. Do not call any
tools. Do not write a retrospective.
