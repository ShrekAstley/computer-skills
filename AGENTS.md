# Agent notes for this repository

- Runtime: Node.js ≥ 18, ES modules, **no npm dependencies** (keep it that way — the Claude Code plugin runs straight from the repo).
- Test: `npm test` (unit), `npm run test:integration` (stdio server, CLI, X11 GUI under Xvfb), `npm run lint` (syntax, unused imports, manifests, generated docs, example workflows).
- After changing any tool schema/description: `node scripts/gen-docs.js`.
- Architecture: `docs/ARCHITECTURE.md`. Safety model: `docs/SAFETY.md`. Adapters: `docs/ADAPTERS.md`.
- The agent-facing procedure lives in `skills/computer-skills/SKILL.md`; keep tool names there in sync (checked by tests).
