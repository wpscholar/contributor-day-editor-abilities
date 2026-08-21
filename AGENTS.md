# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project purpose

This repo **is** a WordPress plugin (not an app with a nested plugin folder). The project root mounts into Playground as `wp-content/plugins/contributor-day`.

Two goals:

1. Register **client-side** block editor abilities with `@wordpress/abilities`, then expose them to browser agents via **WebMCP** (`document.modelContext.registerTool`).
2. Ship a **chat panel** that consumes those WebMCP tools and runs prompts through the WordPress 7.0 **AI Client** (`wp_ai_client_prompt()`), so the site's own connector answers.

## Stack constraints

- **WordPress 7.0+** required (`wp_enqueue_script_module`, `@wordpress/abilities`, `wp_ai_client_prompt`)
- **Two layers, two build stories.** The abilities and WebMCP layer under `js/` is hand-written native ESM with no build step; WordPress import maps resolve its bare specifiers. The chat panel under `src/` is a React app built with Vite into `build/`
- **React comes from WordPress, never from the bundle.** WordPress 7.0 ships React 18.3 as the `react`, `react-dom`, and `react-jsx-runtime` classic scripts. The build aliases every React specifier to a shim that re-exports those globals
- **PHP** bootstraps, enqueues, and owns the AI Client; all ability and UI logic is client-side JS
- **Playground CLI** (`@wp-playground/cli`) for local WordPress; `npm start` auto-mounts CWD as the plugin

## Key files

| Path | Responsibility |
| --- | --- |
| `contributor-day.php` | Plugin header, includes, `enqueue_block_editor_assets` |
| `includes/chat-rest.php` | `/contributor-day/v1/chat` — one AI Client turn per request |
| `includes/chat-assets.php` | Script module registration, polyfill script, per-screen config |
| `includes/chat-admin-page.php` | Tools → AI Chat |
| `js/index.js` | Bootstrap: abilities → WebMCP bridge; sets `window.contributorDayEditorAbilities` |
| `js/abilities.js` | `registerAbility` / category; talks to `core/block-editor` via `wp.data` |
| `js/webmcp-bridge.js` | Maps abilities to WebMCP tools; feature-detects `document.modelContext` |
| `js/webmcp-polyfill.js` | Reports on the WebMCP environment; installs nothing |
| `js/webmcp-tools.js` | Consumer side: list and call the page's tools |
| `js/chat/config.js` | Reads the server config JSON; the only hand-written chat module left |
| `vite.config.ts` | Build: React aliased to WordPress globals, two entries, one stylesheet |
| `src/lib/shims/*` | Re-export `window.React` / `ReactDOM` / `ReactJSXRuntime` as ES modules |
| `src/chat/transport.ts` | The AI SDK `ChatTransport`: one REST turn per round plus the tool loop |
| `src/components/chat-panel.tsx` | The panel: `useChat`, transcript, composer |
| `src/components/ui/*` | shadcn components — regenerate with the CLI, don't hand-edit |
| `src/entries/*.tsx` | The two mounts (editor sidebar, standalone screen) |
| `css/chat-chrome.css` | Layout for the wp-admin containers *around* the panel |
| `bin/build-zip.sh` | Packaging; runs `npm run build` and strips source maps |
| `bin/vendor-webmcp-polyfill.sh` | Re-copies the vendored polyfill from `node_modules` |

## Conventions

### Abilities

- Ability names: `editor/<slug>` (e.g. `editor/get-editor-tree`)
- Category slug: `block-editor`
- Registration must be **idempotent** (`getAbility` / `getAbilityCategory` before register). Duplicate registration throws and can abort bootstrap.
- Define `input_schema` / `output_schema` (JSON Schema) and `meta.annotations` (`readonly`, `destructive`, `idempotent`)
- Every `type: 'array'` in an **input** schema needs `items`, at every depth. Gemini rejects a function declaration without it and fails the whole chat request, not just that one tool. Output schemas are never sent to a provider, so they are free to be loose
- Callbacks may assume they run in the block editor; guard with the `core/block-editor` store and throw clear errors otherwise
- Use `window.wp.data` and `window.wp.blocks` (classic globals). Only `@wordpress/abilities` is imported as a script module
- Anything backed by REST (patterns, `wp_block` posts, taxonomy terms) must be read with `wp.data.resolveSelect`, not `select` — a plain select returns nothing until the resolver finishes
- Walking the block tree must go through `getInnerBlocks()`: `getBlock()` reports no children for inner block controllers (synced patterns, template parts), so a plain `innerBlocks` walk goes blind inside them

### WebMCP bridge

- Prefer `document.modelContext`; fall back to `navigator.modelContext`
- Tool name = ability name with `/` → `_` (e.g. `editor_insert-block`)
- **Do not pass `AbortSignal`** for these page-lifetime editor tools. Aborting the signal unregisters tools and caused “tools appear then vanish” in the inspector
- WebMCP `annotations` only support `readOnlyHint` / `untrustedContentHint` — do not pass WordPress-only keys like `destructiveHint`
- Tool name charset (spec): ASCII alphanumerics, `_`, `-`, `.` (max 128). No `/`
- Treat “already registered” / `InvalidStateError` as success on re-bootstrap
- Execute path: WebMCP `execute` → `executeAbility(name, input)` → ability callback

### WebMCP polyfill

- The polyfill is vendored from `@mcp-b/webmcp-polyfill` and enqueued as a **classic script**, not a module. Its ESM build imports `@cfworker/json-schema` as a bare specifier that nothing here would resolve; the IIFE build inlines it and self-initializes on load
- Do not edit `js/vendor/` by hand — run `npm run vendor`
- Classic scripts execute before deferred modules, so `document.modelContext` is present by the time modules run. Never add `defer`/`async` to the polyfill handle
- Anything that registers or consumes WebMCP tools must enqueue `contributor-day-webmcp-polyfill`

### Chat

- The AI Client is **PHP-only** in 7.0. Core recommends a purpose-built REST endpoint per feature rather than a generic prompt endpoint, which is what `includes/chat-rest.php` is
- The endpoint runs **one** model turn. The browser owns conversation state and the tool-call loop, which keeps the endpoint stateless and lets the chat run on any screen. That loop lives in `WordPressAiTransport`, which presents it to `useChat` as a single streaming assistant message with a step boundary per round
- Replay assistant turns from the `parts` the previous response returned, so function call IDs survive the trip through the browser. That is `historyMode: 'native'` and it is what every turn tries first. Those raw parts ride on the UI message's `metadata.wire`, because anything reconstructed from the rendered message would have lost them
- Gemini requires the thought signature it issued with a function call to come back with that call, but no php-ai-client provider reads or writes `MessagePart::thoughtSignature`, so it never reaches this plugin. A turn that fails that way is retried once as `historyMode: 'text'` (tool calls and results replayed as a transcript) and the client reports the working mode back, so a conversation discovers it at most once. Revisit if a provider starts carrying signatures
- Tools come from the page, not from the server: `listTools()` reads whatever WebMCP has. Never hard-code a tool list into the chat
- Rewrite tool names for providers (`[^a-zA-Z0-9_-]` → `_`, 64 chars) and map them back before the browser sees them. OpenAI rejects the dots WebMCP allows
- Client schemas are third-party input, so `contributor_day_chat_prepare_schema()` makes them safe to send: `{}` decodes to an empty PHP array that would re-encode as `[]`, an array with no `items` fails the request outright, and union types (`['string','null']`) have no place in a function declaration
- The panel mounts anywhere, so keep `src/components/` free of editor packages — only `src/entries/editor-sidebar.tsx` may read `window.wp`
- Model output is rendered through `src/components/markdown.tsx`, which returns React elements. Never put a model response through `dangerouslySetInnerHTML`

### React and the build

- Never import `react`, `react-dom`, or `react/jsx-runtime` expecting them to be bundled. The Vite aliases point them at `src/lib/shims/`, which read WordPress's globals. Shipping a second React is the documented cause of the breakage that pushed React 19 out of WordPress 7.1
- Because React is shared with the editor, the sidebar renders the panel as ordinary `PluginSidebar` children. Do not go back to mounting into a `ref`'d div
- The shims list their exports by hand, since an ES module cannot re-export an object's properties dynamically. A dependency reaching for a React export nobody has needed yet fails at build time — add the name to the shim
- WordPress is on **React 18.3**, so any shadcn component that pulls in the `@shadcn/react` package (`message-scroller`, `questionnaire`) cannot be used: that package requires React 19. `src/components/chat-scroller.tsx` is the stand-in for `MessageScroller`
- `@contributor-day/webmcp-tools` and `@contributor-day/chat-config` are **externals**, resolved by the WordPress import map at runtime. Bundling the tool layer would give the chat a private, empty tool registry
- Tailwind is imported **without Preflight** (`tailwindcss/theme.css` + `tailwindcss/utilities.css`, never `@import "tailwindcss"`). Preflight is a global reset and this stylesheet loads in wp-admin. The parts the components need are re-applied scoped to `.cdchat` in `src/styles/chat.css`
- Tailwind breakpoints measure the viewport, not the container, so `md:` utilities fire on a wide screen even when the panel is in a 350px sidebar. Pin padding and sizing rather than relying on them
- Design tokens are defined on `.cdchat`, not `:root`, so they do not leak into the rest of the admin
- Anything styling WordPress's own markup around the panel goes in `css/chat-chrome.css`, outside the bundle and outside the `.cdchat` scope

### PHP enqueue

- Always `wp_enqueue_script_module( '@wordpress/abilities' )` so the import map exists
- Register shared modules on `init` (see `contributor_day_register_chat_modules`) so both the editor and the standalone screen can enqueue them
- Import submodules by their import-map ID, never by relative path. A relative import produces a second copy of the module under a different URL, which silently splits module-level state such as the local tool registry
- Script modules cannot be localized — pass data with the `script_module_data_{$module_id}` filter and read the JSON tag on the client
- Version scripts with `filemtime` for cache busting during development
- Any screen showing the chat must also `wp_enqueue_script()` the `react`, `react-dom`, and `react-jsx-runtime` handles. They are classic scripts, so they run before the deferred module that reads them — `contributor_day_enqueue_chat()` already does this
- The built entry is enqueued as a **script module**, not a classic script, because it imports the two externals by their import-map IDs

## Commands

```bash
npm install          # Required first; the chat panel is compiled
npm run build        # Build the chat panel into build/ (gitignored)
npm run dev          # Same, rebuilding on change
npm run typecheck    # tsc --noEmit
npm start            # Playground at http://127.0.0.1:9400 (plugin auto-mounted)
npm run start:reset  # Reset Playground site data
npm run vendor       # Re-copy the WebMCP polyfill from node_modules
npm run zip          # Build, then write dist/contributor-day.zip (gitignored)
```

`build/` is gitignored, so a fresh checkout has no panel until `npm run build` runs. PHP shows an admin notice saying exactly that rather than rendering nothing.

## Verification checklist

After JS changes, hard-refresh the block editor (`post-new.php` or edit post):

1. Console: `[contributor-day] Registered editor abilities with WebMCP: …` **or** a clear “WebMCP unavailable” message
2. `window.contributorDayEditorAbilities.webmcp.registered` lists every registered ability
3. `await document.modelContext.getTools()` returns every tool, with or without the Chrome flag
4. With WebMCP flag + inspector: tools remain visible (they must not disappear after load)
5. Spot-check one read tool (`editor_get-editor-tree`) and one write tool (`editor_move-block`)

After chat changes, run `npm run build` first, then:

1. The **AI Chat** sidebar opens from the editor's Plugins menu, and the tool count next to Send matches the ability count
2. **Tools → AI Chat** renders the same panel and reports no page tools
3. Without a connector, both say so instead of failing on send, and `GET /wp-json/contributor-day/v1/chat/status` reports `hasAiClient: true`
4. With a connector, a prompt that needs the editor ("summarize the blocks in this post") shows tool calls resolving to `Done` before the answer
5. `window.React.version` is WordPress's React, and the console has no "two copies of React" or invalid-hook warnings
6. wp-admin still looks like wp-admin on the screens the chat loads on — an `h1` on **Tools → AI Chat** stays 23px, which is the tell that Preflight has not leaked
7. The composer stays on screen in the sidebar at a short viewport; the transcript scrolls, not the sidebar

## What not to do

- Do not add a build step to the abilities/WebMCP layer under `js/` — it stays native ESM + import maps. The Vite build exists for the chat panel only
- Do not bundle React, `react-dom`, or `react/jsx-runtime`. See the React section above
- Do not add a shadcn component that depends on the `@shadcn/react` package; it requires React 19 and WordPress is on 18.3
- Do not use `@import "tailwindcss"` — it pulls in Preflight and would reset wp-admin
- Do not hand-edit `src/components/ui/*`; those are shadcn output, re-addable with the CLI
- Do not register WebMCP tools with a shared `AbortController` for page-lifetime tools
- Do not call `registerAbility` / `registerAbilityCategory` without an existence check
- Do not commit `build/`, `dist/`, `*.zip`, or `node_modules/`
- Do not invent server-side PHP abilities for this plugin’s editor features — they must run against the live editor stores in the browser
- Do not use `provideContext` / `clearContext` / `unregisterTool` (removed or deprecated in current WebMCP)
- Do not use the `wordpress/wp-ai-client` JS API for the chat. It exposes arbitrary prompting to the client and is admin-only for that reason; core recommends per-feature REST endpoints instead
- Do not call an AI provider SDK directly — everything goes through `wp_ai_client_prompt()` so the site's connector and credentials stay in charge
- Do not read `window.wp` from `src/components/`; only `src/entries/editor-sidebar.tsx` may assume the editor is present

## Extending

To add an ability:

1. Add an `ensureAbility({ ... })` entry in `js/abilities.js` with schemas + callback
2. Push the name onto the returned `abilityNames` array (same function)
3. The bridge in `js/index.js` registers all returned names automatically
4. Document the ability and WebMCP tool name in `README.md`

The chat picks up new abilities automatically — they are just more WebMCP tools.

To mount the chat on another screen:

1. Add `src/entries/<name>.tsx`, importing `@/styles/chat.css` and rendering `<ChatPanel getContext={…} suggestions={…} />`
2. Add the entry to `build.rollupOptions.input` in `vite.config.ts`
3. Enqueue it with `contributor_day_enqueue_chat( '@contributor-day/chat-<name>', 'chat-<name>.js' )`
4. Give the container a definite height in `css/chat-chrome.css`; the transcript scrolls, not the page
5. Register any page-specific tools with WebMCP; the chat will offer them

## External docs

- https://make.wordpress.org/core/2026/03/24/client-side-abilities-api-in-wordpress-7-0/
- https://make.wordpress.org/core/2026/03/24/introducing-the-ai-client-in-wordpress-7-0/
- https://make.wordpress.org/core/2026/03/18/introducing-the-connectors-api-in-wordpress-7-0/
- https://developer.wordpress.org/block-editor/reference-guides/packages/packages-abilities/
- https://developer.chrome.com/docs/ai/webmcp/imperative-api
- https://docs.mcp-b.ai/packages/webmcp-polyfill/reference
- https://make.wordpress.org/core/2026/07/24/react-19-punted-beyond-wordpress-7-1-experiment-in-gutenberg/ — why React must not be bundled
- https://ui.shadcn.com/docs/components/message — the chat components in use
- https://ai-sdk.dev/docs/ai-sdk-ui/transport — the `ChatTransport` contract
