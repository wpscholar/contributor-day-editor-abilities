# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project purpose

This repo **is** a WordPress plugin (not an app with a nested plugin folder). The project root mounts into Playground as `wp-content/plugins/contributor-day`.

Goal: register **client-side** block editor abilities with `@wordpress/abilities`, then expose them to browser agents via **WebMCP** (`document.modelContext.registerTool`).

## Stack constraints

- **WordPress 7.0+** required (`wp_enqueue_script_module`, `@wordpress/abilities`)
- **No bundler** — ship native ESM under `js/`; WordPress import maps resolve `@wordpress/abilities`
- **PHP** only bootstraps and enqueues; all ability logic is client-side JS
- **Playground CLI** (`@wp-playground/cli`) for local WordPress; `npm start` auto-mounts CWD as the plugin

## Key files

| Path | Responsibility |
| --- | --- |
| `contributor-day.php` | Plugin header + `enqueue_block_editor_assets` → script module |
| `js/index.js` | Bootstrap: abilities → WebMCP bridge; sets `window.contributorDayEditorAbilities` |
| `js/abilities.js` | `registerAbility` / category; talks to `core/block-editor` via `wp.data` |
| `js/webmcp-bridge.js` | Maps abilities to WebMCP tools; feature-detects `document.modelContext` |
| `bin/build-zip.sh` | Packaging only — do not put build tooling requirements on runtime JS |

## Conventions

### Abilities

- Ability names: `editor/<slug>` (e.g. `editor/get-editor-tree`)
- Category slug: `block-editor`
- Registration must be **idempotent** (`getAbility` / `getAbilityCategory` before register). Duplicate registration throws and can abort bootstrap.
- Define `input_schema` / `output_schema` (JSON Schema) and `meta.annotations` (`readonly`, `destructive`, `idempotent`)
- Callbacks may assume they run in the block editor; guard with the `core/block-editor` store and throw clear errors otherwise
- Use `window.wp.data` and `window.wp.blocks` (classic globals). Only `@wordpress/abilities` is imported as a script module

### WebMCP bridge

- Prefer `document.modelContext`; fall back to `navigator.modelContext`
- Tool name = ability name with `/` → `_` (e.g. `editor_insert-block`)
- **Do not pass `AbortSignal`** for these page-lifetime editor tools. Aborting the signal unregisters tools and caused “tools appear then vanish” in the inspector
- WebMCP `annotations` only support `readOnlyHint` / `untrustedContentHint` — do not pass WordPress-only keys like `destructiveHint`
- Tool name charset (spec): ASCII alphanumerics, `_`, `-`, `.` (max 128). No `/`
- Treat “already registered” / `InvalidStateError` as success on re-bootstrap
- Execute path: WebMCP `execute` → `executeAbility(name, input)` → ability callback

### PHP enqueue

- Always `wp_enqueue_script_module( '@wordpress/abilities' )` so the import map exists
- Enqueue only on `enqueue_block_editor_assets`
- Version scripts with `filemtime` for cache busting during development

## Commands

```bash
npm start            # Playground at http://127.0.0.1:9400 (plugin auto-mounted)
npm run start:reset  # Reset Playground site data
npm run zip          # Write dist/contributor-day.zip (gitignored)
```

## Verification checklist

After JS changes, hard-refresh the block editor (`post-new.php` or edit post):

1. Console: `[contributor-day] Registered editor abilities with WebMCP: …` **or** a clear “WebMCP unavailable” message
2. `window.contributorDayEditorAbilities.webmcp.registered` lists the nine abilities
3. With WebMCP flag + inspector: tools remain visible (they must not disappear after load)
4. Spot-check one read tool (`editor_get-editor-tree`) and one write tool (`editor_move-block`)

## What not to do

- Do not add webpack/`@wordpress/scripts` unless explicitly requested — keep ESM + import maps
- Do not register WebMCP tools with a shared `AbortController` for page-lifetime tools
- Do not call `registerAbility` / `registerAbilityCategory` without an existence check
- Do not commit `dist/`, `*.zip`, or `node_modules/`
- Do not invent server-side PHP abilities for this plugin’s editor features — they must run against the live editor stores in the browser
- Do not use `provideContext` / `clearContext` / `unregisterTool` (removed or deprecated in current WebMCP)

## Extending

To add an ability:

1. Add an `ensureAbility({ ... })` entry in `js/abilities.js` with schemas + callback
2. Push the name onto the returned `abilityNames` array (same function)
3. The bridge in `js/index.js` registers all returned names automatically
4. Document the ability and WebMCP tool name in `README.md`

## External docs

- https://make.wordpress.org/core/2026/03/24/client-side-abilities-api-in-wordpress-7-0/
- https://developer.wordpress.org/block-editor/reference-guides/packages/packages-abilities/
- https://developer.chrome.com/docs/ai/webmcp/imperative-api
