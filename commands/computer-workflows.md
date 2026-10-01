---
description: List, inspect or search the learned computer workflows (optionally pass a search query or app name).
---

Show the user's computer-skills workflow memory.

- If arguments are given ("$ARGUMENTS"), call `workflow_search` with them as the query (and as `app` if it looks like an app name) and show the matches with status, confidence, last verified date and parameters.
- Otherwise call `workflow_versions` with action "all" and present a compact table grouped by app (id, name, version, scope, runs, last verified).
- Offer next steps: run one (`workflow_run` with dry_run first), inspect one (`workflow_get`), or remove an obsolete one (needs confirmation from the user).
