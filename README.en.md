<div align="center">
  <img width="64" height="64" alt="icon" src="https://github.com/user-attachments/assets/7d54f34d-f47e-4b77-a12c-b07e66b1e8d4" />
</div>

<h3 align="center">AI Partner in Web</h3>
<h3 align="center">Get instant AI answers to all your questions</h3>
<div align="center">
  <img alt="GitHub repo size" src="https://img.shields.io/github/repo-size/erenind/apweb">
  <img alt="GitHub language count" src="https://img.shields.io/github/languages/count/erenind/apweb">
  <img alt="GitHub top language" src="https://img.shields.io/github/languages/top/erenind/apweb">
  <img alt="GitHub Created At" src="https://img.shields.io/github/created-at/erenind/apweb">
  <img alt="GitHub forks" src="https://img.shields.io/github/forks/erenind/apweb">
  <img alt="GitHub Repo stars" src="https://img.shields.io/github/stars/erenind/apweb">
</div>

## [Chinese README](README.md)

## Demo Videos
### Explain Anything
https://github.com/user-attachments/assets/a16d46de-6ed9-4f4e-83b3-02c055312408
### AI Translation
https://github.com/user-attachments/assets/bc63238f-fb14-42c2-8094-2c286b54416c
### Mobile Demo Videos
https://github.com/user-attachments/assets/74ab2483-1e7d-4d19-a7dd-4e67cf75163e
## Tips

- Answer quality depends on the prompts and the AI model.
- Prompts are customizable.
- You can enter any model name.
- Temperature is customizable.
- Press `ESC` to hide the panel.
- `Alt + C` toggles between "Ask on Selection" and "Show Button on Selection".

Mobile tips: [Android (Firefox for Android)](#android-firefox-for-android)

## Installation

### Firefox

#### Add-ons Store

<a href="https://addons.mozilla.org/zh-CN/firefox/addon/%E7%BD%91%E9%A1%B5-ai-%E5%8A%A9%E6%89%8B-%E5%88%92%E8%AF%8D%E9%97%AE%E7%AD%94/">Open the Firefox add-on page</a>

#### Temporary Installation

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click "Load Temporary Add-on…".
3. Select **`manifest.json`** in this directory.

> This is a temporary installation and will disappear when you restart Firefox. During development,
> click "Reload" after changing the code.
> For long-term use, you can package it as a `.zip` and have the developer version signed,
> or continue loading it temporarily from this page.

### Edge

🕳

### Chrome

🕳

### Safari

🕳

## Getting Started

For first-time setup: click the toolbar icon to open the panel → click ⚙ → choose a provider and
enter your API key → click "Done".
You can also configure it directly on the extension's Preferences page
(`about:addons` → this extension → Preferences). Both locations share the same settings.

## Features

- **API requests** use the **OpenAI-compatible** protocol, so DeepSeek / OpenAI / Moonshot /
  Qwen / Zhipu / OpenRouter / local Ollama all work. Your browser sends requests directly to the
  endpoint you specify. **Your key is stored only on your device**, with no intermediary.
- **The interface language follows your browser**: Chinese is used when
  `browser.i18n.getUILanguage()` returns Chinese; English is used for all other languages.
  If unavailable, it falls back to `navigator.language`. For content scripts, the background page
  sends this value along with the panel state, because content scripts may not have i18n access.
  The extension name, store description, toolbar tooltip and the settings page's intro come from
  `_locales/` (`en` / `zh_CN`), so an English install shows an English name and settings page.
  **The conversation language follows it too**: default prompts use the current language.
  In an English-language browser, the default assistant prompt asks it to "write them in English",
  and the default selection action becomes "Explain and translate".
  Prompts you have edited are never overwritten—only those still matching the **factory defaults**
  change when the language changes. There is no language switch in the panel; change your browser
  language instead.
- **Enable instant questions on selection**: click ⚙ to open settings. A prominent
  `✦ Enable instant questions` button appears at the top of the form. Clicking it turns it solid
  green and changes its label to `✦ Instant questions · On`, with a short description of the current
  behavior below. Click again to return to "show a button after selecting text; send only when
  clicked". This button, the "Ask on selection" dropdown below it, and the round button at the
  bottom right on Android all control **the same setting and stay in sync**. The buttons switch
  only between these two modes. To disable selection questions entirely, so selecting text does
  nothing, choose "Completely off" in the dropdown. `Alt+C` also toggles between instant questions
  and the selection button by default; you can change the shortcut in Firefox's extension shortcuts
  settings.
- **Ask about selected text**: select text on any web page and a green button appears beside it.
  By default, its label shows the action for the selection, such as "Explain and translate".
  Click it to send the text to the model. In settings, you can switch to "Ask automatically
  after selecting".
- **Changing the selection action discards context from the previous action**: earlier turns
  using a different action are no longer sent to the model. Otherwise, those answers form a series
  of examples that contradict the new instruction, and the model keeps following the old pattern.
  A typical symptom is switching from "Explain and translate" to "Explain only" and still getting
  both explanations and translations. Consecutive questions using the same action continue to
  include conversation context.
- **Chat panel**: click the toolbar icon to toggle the panel. In the input box, `Enter` sends and
  `Shift+Enter` inserts a line break. Answers are rendered as Markdown and can be copied.
  The `reasoning_content` returned by reasoning models appears in a collapsible "Thinking" section.
- **One floating panel**: a draggable, resizable card, with no "display mode" setting.
- **Position and size are remembered**: drag the title bar to move the panel, or the diagonal grip
  at the bottom right to resize it. Changes are saved as soon as you release it. The next time it
  opens—including automatically after selecting text—it returns to **its last position and size**.
  If the browser window becomes too small, the panel is adjusted to fit entirely on screen.
- **Open/closed state is remembered per tab**: after installation, the panel starts closed;
  only the small button appears when you select text. Once you open the panel in a tab,
  **it stays open as you navigate within that tab**, while **other tabs still start with it closed**.
- **Esc hides the panel**: press Esc while the panel is open to close it, whether focus is on the
  page or in the panel's input box.
- **The input area collapses completely**: a small downward arrow is embedded in the
  **top-left corner of the input area's upper border**. Clicking it animates the input and send
  button down to zero height, including the separator, and flips the arrow upward. Click again
  to expand and focus the input, with your draft preserved. The arrow is drawn with CSS borders
  rather than a character, so it does not depend on the font. The collapsed state is remembered.
- **Request parameters are configurable**: settings include a "Send temperature parameter"
  toggle and a numeric field, enabled by default at 0.3. These support endpoints that reject
  `temperature`; see the three safeguards described below.
- **Page context**: by default, only **the paragraph containing the selection** is included
  (you can switch to the full page text in settings), and **only** when the selection is a word or
  short phrase of fewer than 40 characters. A word on its own can be ambiguous; longer selections
  omit context to save tokens. Each message in the panel shows "Context: …", so you can see
  exactly what was sent.
- **Only the selected text is processed**: the user message for every selection question always
  includes "Only process the text in quotes below; do not translate the page body."
  This instruction cannot be edited—it prevents the whole page from being translated.
  What you can edit is the instruction describing what to do in the "Selection prompt".

- **Thinking mode** uses the fields each provider's API actually accepts and is remembered
  separately **for each provider**:

  | Provider | Field sent when thinking is disabled | Restrictions |
  | --- | --- | --- |
  | DeepSeek | `thinking: {type: "disabled"}` | — |
  | Zhipu GLM | `thinking: {type: "disabled"}` | **GLM-5.3 always requires thinking**, so this field is omitted |
  | Qwen | `enable_thinking: false` | Accepted only by the `qwen3` family |
  | Kimi | `thinking: {type: "disabled"}` | Only `kimi-k2.6`; k3 always requires thinking |
  | OpenAI | `reasoning_effort: "minimal"` | Accepted only by `gpt-5` |
  | Ollama / Custom | **Nothing sent** | No guessing fields: an incorrect guess causes a 400 error |

- **The endpoint field appears only when the provider is set to "Custom"**. Preset providers
  use their preset endpoints, normalized on load and reset when switching providers.
  Otherwise, an old endpoint could silently remain active while hidden from view.
  A custom endpoint pointing to `api.deepseek.com` still offers the thinking toggle.
- **Temperature (default: 0.3) has three safeguards**. Some models accept only a fixed temperature
  and return a 400 error for any other value: Moonshot's `kimi-k3` allows only 1,
  `kimi-k2.6` allows only 0.6, and OpenAI's `gpt-5` supports only the default value.
  These are listed in the `FIXED_TEMPERATURE` table in `src/shared/ai.js`. When a model matches,
  **the field is omitted**. Sending the default and omitting it are equivalent, but omission also
  avoids errors if the server changes its default. Custom endpoints pointing to `api.moonshot.cn`
  receive the same handling as Moonshot.
  The second safeguard is **automatic retry**: when any endpoint returns a 400 error indicating
  that temperature was rejected (`deprecated` / `unsupported` / `only X allowed` / `invalid`),
  the panel **retries once without that field** and records the "endpoint + model" pair in
  `temperatureOffSlots`. Future requests to that model omit it automatically. This handles models
  such as `claude-fable-5` at `https://modelsell.cc/v1`, which accepts only 1—in testing, 0.3 and 0
  both returned 400, while 1 or omission returned 200—without any manual intervention.
  The third safeguard is the **"Send temperature parameter" toggle and numeric field** in settings.
  For endpoints not covered by the table or where automatic retry is unsuitable, you can disable
  the field entirely or set a value the server accepts.
- **API keys are stored separately for each "endpoint + model" pair**. When you switch models
  or providers, the key changes automatically. A short note in settings identifies which model
  the current key belongs to.
- **Two sets of prompts**—chat prompts and selection prompts—can each be edited, created, deleted,
  and reset to defaults, with separate sets for the **two ways of asking questions**.
  IDs are stable, so switching prompts after editing does not lose changes.
  The "Prompts" section in settings is **collapsed by default**; click to expand it.
  Its collapsed state is preserved even when switching or creating prompts redraws the form.
- All answers pass through **DOMPurify** before rendering, and **all images are discarded**.
  The model can read web page content, and a page can induce it to output HTML; a remote `<img>`
  would become a tracking pixel controlled by the page. `javascript:` links are stripped,
  and regular links always use `target="_blank" rel="noopener noreferrer nofollow"`.
- **Math formulas are rendered** with **KaTeX**: its JavaScript, official CSS, and `.woff2` fonts
  are bundled with the extension and work offline. It uses **HTML rendering**, specifically
  `htmlAndMathml`: the visible part is KaTeX's own typesetting, matching its official preview with
  the bundled stylesheet and fonts; a hidden MathML copy is included for screen readers.
  **Do not switch back to MathML-only output**: that version has no built-in styling and appeared
  too small and compressed in Firefox testing (see below).
  Supported syntax covers what models actually produce: inline `$…$` / `\(…\)`, display
  `$$…$$` / `\[…\]`, 17 bare environments such as `\begin{align}`, and **fenced code blocks whose
  info string is `latex`/`math`/`tex`**. Ordinary fenced code blocks remain code.
  `\$`, `$5 and $10`, and `$` inside inline code are not mistaken for formulas.
  Processing follows this order: replace formulas with placeholders → run marked and DOMPurify
  → insert the KaTeX output. This keeps DOMPurify's allowlist unchanged for math.
  Malformed formulas appear as a line of red text rather than throwing an error.

- **Selection questions are not sent automatically by default**. On ordinary web pages, selecting
  text often just means you want to copy it, so the default is "show a button after selection;
  click to ask".
- **Context has changed from "the current page's PDF text" to "the paragraph containing the
  selection"**, with an option to use the full page text. The page title and URL are included
  to help the model understand what you are reading.
- **Settings are stored in `browser.storage.local`**. The panel reads the same settings on every
  page; keys are no longer stored separately for each site.
- **Only plain data is saved for settings and conversations**. For streaming updates, the panel
  attaches DOM nodes to message objects in memory. DOM nodes cannot be structured-cloned, so saving
  those objects directly would make `storage.set` fail and prevent the entire history from being
  saved. Before persistence, messages are reduced to fields such as `role`/`content`/`context`.
- **The in-page panel, Preferences page, and other tabs stay in sync by default**. They share
  the same storage, and changes anywhere are sent to the other locations through `storage.onChanged`.
  Echoes of a location's own writes are recognized and ignored, avoiding unnecessary re-renders
  and preventing delayed, stale echoes from overwriting newer state.
- The panel is isolated with **Shadow DOM**, so its styles and the page's styles do not interfere
  with each other.

## Known Trade-offs

- **Requires `host_permissions: <all_urls>`**: the extension needs to send requests to arbitrary
  providers or self-hosted proxies and inject the panel and selection button into arbitrary pages,
  so its permissions are broad. Firefox explicitly notifies you of this when you install it.
- **Subject to the target service's CORS policy**: requests originate from the background page,
  not the web page, so the page's CORS restrictions normally do not apply. If a provider rejects
  direct browser connections, however, you will see "Cannot connect to this endpoint".
- **No panel on restricted pages**: injection is not possible on `about:`, `chrome://`, add-on
  store pages, and similar restricted pages. For tabs already open before installation, the first
  toolbar click **injects the content scripts on demand**; they then work normally.
- **Sites with strict CSP**: panel styles load from the extension's CSS through a `<link>` inside
  the shadow root. On rare sites with extremely strict CSP, loading may fail; the panel will
  look plain but remain functional.
- **There is one global conversation history**, just like Reader's single session, rather than
  a separate history for each site. Chatting in multiple tabs at once can overwrite conversations;
  this shared history now syncs live across all locations.
- **The floating panel covers a small portion of the page**; it does not push page content aside.
- **The panel scales with page zoom**, because it is drawn inside the page. Inverse scaling was
  previously used to counteract this, but it pushed the entire panel off the right edge when
  zooming in, so it was removed.
- **All panel dimensions use absolute `px` values, never `rem`**. Even inside a shadow tree,
  `rem` is based on the page's `<html>` font size. On pages with rules such as
  `html{font-size:62.5%}`, the panel text can shrink to roughly half its size. This is what caused
  the tiny panel text on certain zoomed pages; a test assertion guards against this regression.
- **The floating panel's open/closed state is stored per tab in `storage.session`**: new tabs
  start with it closed, navigation within the same tab preserves its state, and closing a tab
  clears that state.
- **Position and size are shared globally** through `panelRect` in `storage.local`, rather than
  stored separately for each site.
- Still missing: full-page translation, a context menu, and online OCR. These are possible
  future directions.

## Project Structure

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest: background page, content scripts, toolbar button, and options page |
| `src/shared/ai.js` | Port of Reader's `src/lib/ai.js`: providers, thinking toggles, prompts, and streaming client |
| `src/shared/i18n.js` | Interface and conversation language: zh/en string tables selected by browser language; must load first in every host |
| `_locales/` | Browser-level strings: extension name, store description, toolbar tooltip, settings-page title and intro (`en` / `zh_CN`, referenced as `__MSG_*__` from `manifest.json`) |
| `src/shared/math.js` | LaTeX extraction: replace formulas with placeholders and restore them after rendering; edge cases covered by `test/logic.test.js` |
| `src/shared/markdown.js` | Port of Reader's `src/lib/markdown.js`: marked + DOMPurify |
| `src/shared/store.js` | Port of Reader's `src/lib/chat-storage.js`: settings/message persistence and normalization |
| `src/background.js` | Background event page: requests that bypass page CORS, streaming responses, toolbar button, and per-tab panel state |
| `src/content/content.js` | Content script: shadow root, selection detection, floating "Ask AI" button, page context extraction, and Esc to hide |
| `src/content/panel.js` | Chat panel and settings form: DOM rewrites of Reader's `ChatPanel.vue`/`ChatSettingsForm.vue` |
| `src/content/panel.css` | Panel styles, loaded inside the shadow root and reused by the options page |
| `src/options/options.html` | Preferences page: reuses the same panel |
| `test/` | Three tests with no dependencies, using Node.js built-ins; see "Testing" below |
| `web-ext-config.mjs` | Ignore list for `web-ext lint` / `build`, excluding tests and documentation from the package |
| `LICENSE` | [PolyForm Noncommercial 1.0.0](LICENSE): free for noncommercial use; commercial use requires separate permission |
| `vendor/` | `marked` and `DOMPurify` from Reader's node_modules, plus KaTeX JavaScript, CSS, and `.woff2` fonts; see `vendor/LICENSES.md` for versions and licenses |
| `icons/` | Icons: `icon.svg` is the source; `icon-*.png` files are generated from it |

**Plain DOM and vanilla JavaScript**. Logic in `ai.js` / `store.js` / `markdown.js` is shared
between the background page and content scripts as classic scripts attached to `globalThis`.
`node --check` and the tests below are sufficient for code checks.

# Android (Firefox for Android)

On Android, the interface and settings are arranged differently from desktop: web pages contain
only a content card and a row of round buttons, while **settings have their own page**.

## How to Use

- **Tap the extension icon to open settings**: on Android, the toolbar icon opens the settings
  page directly instead of toggling the panel. On desktop, it still toggles the floating panel.
- **The round button at the bottom right toggles "send on selection"**: dark green means selected
  text is sent immediately; a light background means selecting text first shows an "Ask AI" button,
  and sending happens only when you tap it. The latter is the default. Tap to switch modes;
  **press and hold to open the content card**. The collapsed card has no title bar, so open it
  by holding the button, or let it open automatically when the AI responds.
- **The green "Ask" button above it** appears only in the show-a-button mode (the other two modes
  hide it). Tapping it does the same thing as the "Ask AI" pill under a selection: it asks about
  the text selected right now. With nothing selected it opens the card instead.
- **The content card does not open the keyboard automatically**: opening it from a selection
  does not focus the input box, because the keyboard would cover the answer. Tap the input when
  you want to type. On desktop, opening the panel still focuses the input.
- **The content card at the bottom left** contains only the conversation and input area,
  with **no title bar**, so there is no dragging to move or resize it. The round ✕ at the top of
  the button column hides it. The card grows upward from the bottom of the screen until it reaches
  "Maximum card height", then scrolls internally. There is **no minimum height**, and the card
  and the whole button column move up and down together.
- **The input area can collapse**: tap the small arrow at its top left to collapse or expand
  the input row. This state shares the same setting as desktop.
- **"Ask AI" appears after selecting text**: long-press text selection on mobile does not trigger
  `mouseup`, so selection detection follows `selectionchange` / `touchend`. After selecting,
  wait briefly for the small green button to appear beside the selection, then tap it to ask.

## Android-Specific Settings

The "Android settings" section appears only on Android and is hidden on desktop:

| Setting | Purpose | Default |
| --- | --- | --- |
| **Maximum card height (px)** | The card grows upward from the bottom of the screen to this height, then scrolls internally. There is **no minimum**, range 1–2000; if the screen is shorter, the screen height takes precedence. | 220 |
| **Bottom offset (px)** | Moves the card and the whole button column up together, clear of content hidden at the bottom of the page. Range 0–500. | 12 |
| **Mirror the layout (buttons on the left)** | On moves the buttons to the far left and the card to the right; off keeps the buttons in the bottom-right corner. | Off |
| **Show my sent content in the card** | Turn this off to show only AI answers in the card and hide the messages sent when asking about selections. The settings page still shows the full conversation. | On |

They are stored in `browser.storage.local` as `panelMaxHeight` / `panelBottom` /
`mirrorLayout` / `showSentContent`. Changes take effect immediately without reloading the page.

## Settings Page and Content Card

- **Settings page**: API key, provider, model, temperature, thinking mode, both prompt sets,
  selection questions and actions, and the Android settings above. It uses the same settings
  and page implementation as the desktop panel's ⚙ view.
- **Content card**: only for reading answers and asking questions. It stays at the bottom of the
  screen, cannot be dragged or resized, and never writes `panelRect`.
- Both share the same storage: changes on the settings page immediately affect the in-page card,
  and vice versa. The round button at the bottom right and the `✦` button on the settings page
  control the same switch with the same two meanings: green sends on selection; light shows
  a button first. Both stay in sync.

## Android Test Command

```sh
web-ext run --target=firefox-android --android-device=DEVICE_ID --firefox-apk=org.mozilla.firefox --firefox-apk-component=org.mozilla.firefox.AppMomo
```

## Icon Design

After editing `icons/icon.svg`, regenerate the PNGs:

```sh
for s in 16 32 48 96; do
  magick -background none -density 384 icons/icon.svg -resize ${s}x${s} icons/icon-$s.png
done
```

## Testing

The repository includes three **tests with no dependencies**, using only Node.js built-ins.
No npm install is needed:

```sh
node test/logic.test.js       # Pure logic: providers, thinking toggles, key slots, prompts, message limits, etc.
node test/panel.test.js       # Panel, settings, streaming turns, selection → button → question, dragging/resizing, Esc
node test/background.test.js  # Background: per-tab panel state
```

`panel.test.js` uses a small handwritten DOM with real capture/bubble and `stopPropagation`
semantics, plus a fake WebExtension port, to run the **real** `panel.js` / `content.js` /
`store.js` / `ai.js` modules. It covers streaming turns, selection → button → question,
dragging to reposition and ending a drag on release, saving/restoring position and size,
Esc to hide, open/closed state, the instant-question toggle, synchronization across interfaces,
and regressions such as ensuring persisted messages contain only plain data.
`background.test.js` uses stubs to cover per-tab panel state, including cleanup when tabs close.
These tests **do not cover** styling in a real browser, DOMPurify's sanitization results,
or Shadow DOM behavior; those three areas require a manual check in Firefox.

The extension itself is validated with
[`web-ext`](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/).
`web-ext-config.mjs` already excludes tests and documentation from the package:

```sh
nix-shell -p nodejs web-ext --run 'web-ext lint'      # 0 errors
nix-shell -p nodejs web-ext --run 'web-ext build'     # Package as a zip
```

`web-ext lint` currently reports only two `UNSAFE_VAR_ASSIGNMENT` notices: one from DOMPurify
itself, and one from inserting **sanitized** Markdown output into `innerHTML` only after
`DOMPurify.sanitize` has run.

## License

This project uses the [PolyForm Noncommercial License 1.0.0](LICENSE)
(see `LICENSE` for the full text):

- **Free for personal / noncommercial use**: personal learning, research, experimentation,
  private entertainment, hobbies, and use by charitable organizations, educational institutions,
  public research, public safety and health, environmental organizations, and government
  institutions are free under the license terms. You may modify the code and distribute copies;
  include `LICENSE` when distributing.
- **Commercial use requires permission**: uses with a commercial purpose—internal production
  tools at a company, sales, hosting as SaaS, distribution with your own products, customization
  for clients, and similar uses—require written commercial permission in advance. Contact the
  repository owner through GitHub Issues or the email listed on the profile and describe your
  intended use.
- Third-party libraries in `vendor/`—`marked` under MIT, `DOMPurify` under MPL-2.0 or Apache-2.0,
  and KaTeX under MIT—remain under their own original licenses, independently of the terms above.
  See `vendor/LICENSES.md`.

This is not an OSI-approved open-source license. It is **source-available**: you can view,
modify, and use the source yourself, but commercial use requires a separate agreement.
