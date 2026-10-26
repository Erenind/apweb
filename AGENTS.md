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
- Comments explain *why*, in English. In-app strings live in `src/shared/i18n.js` (`zh`/`en` by browser language); everything the *browser* shows before our scripts run — the installed name, description, toolbar tooltip and the static settings page — comes from `_locales/{en,zh_CN}/messages.json` (referenced as `__MSG_*__` in `manifest.json`). A test fails on CJK elsewhere in `src/` and on hardcoded Chinese in `src/options/options.html`.
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
- Android builds the bottom layout instead (`.apweb-scope--mobile`): a card holding **only the transcript and the composer** (no title bar, and it never focuses the input — that used to throw the keyboard over the answer), and a corner column of round buttons: close, a green **提问 / Ask** shortcut, then the switch (`.apweb-scope--mirrored` swaps the card and the column to the other sides). `content.js` asks `runtime.getPlatformInfo()` for it (the user agent and a coarse pointer are the panel's fallbacks) and `background.js` uses the same answer to send the toolbar button to the settings page instead of toggling the panel. That layout owns its geometry — no drag, no resize grip, no `panelRect`. Tapping the switch switches `selectionTrigger` between `auto` (send on select) and `click` (show the pill), holding it opens the card, and the settings-page `✦` button is the same two-state control — the third state, `off`, is only reachable from the select below them. The 提问 button only shows in `click` mode and asks about the current selection like the pill does (opening the card when nothing is selected).
- Android-only settings live on the settings page: `panelMaxHeight` (clamped by `AICore.clampCardHeight` — no practical minimum, only 1px — published to CSS as `--ap-card-max`), `panelBottom` (clamped by `AICore.clampPanelBottom`, moves the card and the button column up together via `--ap-dock-bottom`), `mirrorLayout` (the `.apweb-scope--mirrored` class), `hideSelectionPill` (`content.js` then skips the pill entirely; the dock's 提问 button is the way to ask) and `showSentContent` (a class on the card, so it reflows without a re-render). Touch selections never fire `mouseup`, so `content.js` also listens to `selectionchange`/`touchend`.
- The composer folds via the `composerOpen` setting.
- Assistant replies render LaTeX: `math.js` masks formulas, then KaTeX (MathML-only build in `vendor/`) renders them after sanitising. Never widen DOMPurify's allow-list for maths.
- UI and conversation language follow the browser (`AII18n.language()`); shipped prompts re-localise only while still unedited.
- Refresh `vendor/` from `../apreader/node_modules` per `vendor/LICENSES.md`; regenerate icons with the `magick` loop in `README.md`.
