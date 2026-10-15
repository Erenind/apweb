# Repository Guidelines

A build-free Firefox (MV3) extension adding AI chat and 「划词即问」 to web pages.
The repository root **is** the add-on: no bundler, no `node_modules`.

## Project Structure & Module Organization

- `manifest.json` — background page, content script, toolbar button, options.
- `src/shared/` — classic scripts (IIFEs on `globalThis`): `i18n.js` (`AII18n`), `ai.js` (`AICore`), `math.js` (`AIMath`), `markdown.js` (`AIMarkdown`), `store.js` (`AIStore`); `i18n.js` loads first everywhere.
- `src/content/` — `content.js` (shadow host, selection detection, page context), `panel.js` (panel + settings), `panel.css` (all UI styles).
- `src/background.js`, `src/options/` — background page and options host.
- `test/` — zero-dependency tests; `icons/` — `icon.svg` is the source, PNGs are generated; `vendor/` — third-party builds, never hand-edit.

## Build, Test, and Development Commands

```sh
for t in logic panel background; do node test/$t.test.js; done   # all tests
nix-shell -p nodejs --run 'node test/panel.test.js'              # if node is not installed
nix-shell -p nodejs web-ext --run 'web-ext lint'
nix-shell -p nodejs web-ext --run 'web-ext build'
```

Load locally: `about:debugging` → 临时载入附加组件 → `manifest.json`, then Reload.

## Coding Style & Naming Conventions

- Two-space indent, no semicolons, single quotes, ~100 column lines, `const` by default.
- Comments explain *why*, in English. User-facing strings live only in `src/shared/i18n.js` (`zh`/`en` by browser language); a test fails on CJK elsewhere in `src/`.
- `camelCase` functions/variables, `SCREAMING_SNAKE_CASE` module constants, `apweb-` prefixed CSS classes.
- Settings controls expose a `data-field="kebab-case"` attribute; tests select by it.
- **No `eval`, no ES modules**: the CSP forbids eval and content scripts are classic scripts; keep DOM code plain.
- UI styles live in `src/content/panel.css` (loaded in a ShadowRoot) and use absolute `px` only: `rem` resolves against the page's `<html>` size, not ours.

## Testing Guidelines

Tests use node's built-ins only — never add dependencies. `panel.test.js` drives the real modules on a mini DOM; `background.test.js` stubs the browser APIs. Name files `test/<area>.test.js`, assert with `check(name, condition)`, and cover every behavior change.

## Commit & Pull Request Guidelines

Commit subjects are short, lowercase and descriptive (`save panel rect`); one behavior per commit, noting whether a reload is needed. PRs: describe the user-visible change, name the affected surface (panel / options / background), and paste test + `web-ext lint` output.

## Notes

- Persisted keys are namespaced `apweb.*`; store plain data only (DOM nodes are not structured-cloneable).
- The panel's last `{ left, top, width, height }` lives in settings as `panelRect`; clamp it on restore.
- Android builds the bottom layout instead (`.apweb-scope--mobile`): the card sits at the bottom left, a round 划词即问 switch with the close button above it in the bottom-right corner. `content.js` asks `runtime.getPlatformInfo()` for it (the user agent and a coarse pointer are the panel's fallbacks), and that layout owns its geometry — no drag, no resize grip, no `panelRect`. The switch is two-state over the three-state `selectionTrigger`, so `selectionTriggerOn` remembers what it turns back on.
- The composer folds via the `composerOpen` setting.
- Assistant replies render LaTeX: `math.js` masks formulas, then KaTeX (MathML-only build in `vendor/`) renders them after sanitising. Never widen DOMPurify's allow-list for maths.
- UI and conversation language follow the browser (`AII18n.language()`); shipped prompts re-localise only while still unedited.
- Refresh `vendor/` from `../apreader/node_modules` per `vendor/LICENSES.md`; regenerate icons with the `magick` loop in `README.md`.
