# Contributing

1. `npm test` and `npm run lint` must pass (no dependencies to install). On Linux, `npm run test:integration` also runs real GUI automation (needs Xvfb, openbox, xterm, xdotool, wmctrl, x11-utils, imagemagick, xclip, tesseract-ocr).
2. Tool changes: update the definition in `src/tools/`, then `node scripts/gen-docs.js` (the lint step fails if docs are stale).
3. Platform code: keep OS-specific logic inside `src/platform/` behind the `Backend` contract; add parser tests with captured real output; report availability in `capabilities()` with an install hint.
4. Safety: any new action must have a risk assessment. When in doubt classify higher. New classifier rules need tests in `test/unit/classifier.test.js` (both a positive and a near-miss negative).
5. Workflows: examples live in `examples/workflows/<app>/<task>.json`, must validate (`npm run validate:workflows`) and should be verified on at least one OS (note it in `app.tested_version`/`platforms`).
6. Keep versions in sync (`package.json`, `src/version.js`, `.claude-plugin/*.json`) — enforced by `test/unit/meta.test.js` — and add a CHANGELOG entry.
