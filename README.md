# Contributor Day Editor Abilities

WordPress plugin that registers **client-side block editor abilities** via [`@wordpress/abilities`](https://developer.wordpress.org/block-editor/reference-guides/packages/packages-abilities/) and exposes them to browser AI agents through [WebMCP](https://developer.chrome.com/docs/ai/webmcp).

Requires **WordPress 7.0+** (client-side Abilities API).

## What it does

On block editor screens the plugin:

1. Registers a `block-editor` ability category
2. Registers six editor abilities (inspect / query / mutate the live editor)
3. Bridges each ability to `document.modelContext.registerTool()` when WebMCP is available

| Ability | WebMCP tool name | Purpose |
| --- | --- | --- |
| `editor/get-editor-tree` | `editor_get-editor-tree` | Full hierarchical block tree (optional `maxDepth`) |
| `editor/find-editor-blocks` | `editor_find-editor-blocks` | Find blocks by name / attribute; returns flat summaries |
| `editor/get-block-location` | `editor_get-block-location` | Parents, root, and index for a block |
| `editor/insert-block` | `editor_insert-block` | Insert a block (optional parent / after) |
| `editor/get-editor-selection` | `editor_get-editor-selection` | Current selection state |
| `editor/can-insert-block` | `editor_can-insert-block` | Whether a block type can be inserted |

Ability names keep the `namespace/name` form. WebMCP tool names replace `/` with `_` (some agents reject `/` in tool names).

Behavior worth knowing when calling these:

- Unknown client IDs are an error, never a silent no-op. Passing a stale `afterClientId` to `editor/insert-block` fails instead of inserting at the top of the document.
- `editor/find-editor-blocks` returns each match once as `{ clientId, name, attributes, innerBlockCount }`, so a match nested inside another match is not duplicated. A supplied `clientId` scopes the search and includes that block itself.
- `attribute` matches on presence; add `value` to compare, which is done as a string (objects and arrays compare as JSON).
- Ability failures come back as MCP tool errors with a readable message rather than rejecting the tool call.

## Project layout

```text
contributor-day.php   # Plugin bootstrap; enqueues script module in the editor
js/
  index.js            # Entry: register abilities + bridge to WebMCP
  abilities.js        # Client-side ability definitions (block editor store)
  webmcp-bridge.js    # Abilities → document.modelContext.registerTool
bin/build-zip.sh      # Builds a distributable plugin zip
```

No bundler. Files are native ES modules resolved through WordPress import maps (`@wordpress/abilities`).

## Local development (WP Playground)

```bash
npm install
npm start
```

Playground auto-mounts this directory as `wp-content/plugins/contributor-day` and starts WordPress at [http://127.0.0.1:9400](http://127.0.0.1:9400) (admin login is enabled by default).

| Script | Description |
| --- | --- |
| `npm start` | Start Playground with this plugin mounted |
| `npm run start:reset` | Wipe stored site data and restart |
| `npm run zip` | Create `dist/contributor-day.zip` for distribution |

## Testing WebMCP

1. Use Chrome with WebMCP enabled (`chrome://flags/#enable-webmcp-testing`)
2. Install the [Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd) extension (optional but useful)
3. Open **Posts → Add New** (or edit any post)
4. Confirm tools in the inspector, or in DevTools:

```js
window.contributorDayEditorAbilities
// { abilityNames, webmcp: { supported, registered, skipped, errors }, isWebMCPSupported }
```

Without WebMCP, abilities still register in the `@wordpress/abilities` store; only the browser tool bridge is skipped.

## Distributable zip

```bash
npm run zip
```

Writes `dist/contributor-day.zip` containing only plugin runtime files (`contributor-day.php` + `js/`). `dist/` and `*.zip` are gitignored.

## References

- [Introducing the WordPress Abilities API](https://developer.wordpress.org/news/2025/11/introducing-the-wordpress-abilities-api/)
- [Client-Side Abilities API in WordPress 7.0](https://make.wordpress.org/core/2026/03/24/client-side-abilities-api-in-wordpress-7-0/)
- [WebMCP (Chrome)](https://developer.chrome.com/docs/ai/webmcp)
- [WebMCP Imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
