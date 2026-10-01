---
description: Check which computer-control capabilities work on this machine (screen, input, windows, accessibility, OCR) and what to install for the missing ones.
---

Use the computer-skills tools to report on this computer:

1. Call `env_inspect` with sections ["system", "session", "displays", "shells", "capabilities", "safety"] and refresh=true.
2. Summarise in a short table: capability, available?, mechanism, what to install/grant if missing (use the hints; for macOS mention Accessibility and Screen Recording permissions).
3. Report the safety level and whether the kill switch is engaged.
4. List learned workflows briefly with `workflow_versions` action "all".

Do not install anything; only report and suggest. $ARGUMENTS
