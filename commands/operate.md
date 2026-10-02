---
description: Perform a task on this computer (apps, GUI, terminal) using the computer-skills operator procedure - inspect, plan, act, verify, recover, and remember the workflow.
---

Task: $ARGUMENTS

Follow the `computer-skills` skill:

1. Restate the goal as observable outcomes.
2. Inspect: `workflow_search` (task + app), `app_profile get` for the app, `env_inspect` if you haven't this session.
3. Plan the most reliable mechanism per step (CLI/scripting before GUI; text targets before coordinates). For multi-part tasks, use the expert-workflow approach if available, but keep all screen/input work in one agent.
4. Execute step by step; observe and `verify` each important result.
5. On failure: `diagnose`, adapt (never repeat unchanged), stop after two failed approaches on the same step.
6. Persist: save new or improved workflows (`workflow_save`, verified only after success), record outcomes (`workflow_feedback`), update `app_profile`.
7. Report: what was done, the evidence (files, checks, screenshot ids), and anything that needs the user (approvals, permissions).
