# Contributor Day Editor Abilities

A WordPress plugin that makes the block editor available to AI agents through
WordPress client-side abilities and the experimental WebMCP API. It registers
the abilities in the editor and, when the browser supports WebMCP, exposes each
ability as a WebMCP tool.

## Functionality

The plugin is active only on block-editor screens. It provides the following
abilities:

| Ability | Description |
| --- | --- |
| `editor/get-editor-tree` | Returns the complete hierarchical block tree. |
| `editor/find-editor-blocks` | Finds blocks by block name, attribute value, or location. |
| `editor/get-block-location` | Returns a block's parents, root, and index. |
| `editor/insert-block` | Inserts a permitted block at the root, in a parent, or after another block. |
| `editor/get-editor-selection` | Returns the current block and rich-text selection. |
| `editor/can-insert-block` | Checks whether a block can be inserted at a location. |

Read-only abilities are annotated as read-only when they are exposed as WebMCP
tools. Insert operations validate the editor's insertion permissions before
making a change.

## Requirements

- WordPress 7.0 or later
- PHP 7.4 or later
- A block-editor screen
- Node.js and npm for local development or creating a ZIP package

WebMCP is optional. To expose the abilities to WebMCP-capable agents, use a
browser that implements the experimental API and enable the
`chrome://flags/#enable-webmcp-testing` flag when required by that browser.
The abilities remain registered in WordPress when WebMCP is unavailable.

## Installation

### Install the packaged plugin

1. Download `contributor-day.zip` from a release, or build it locally with
   `npm run zip`.
2. In WordPress, go to **Plugins > Add New > Upload Plugin**.
3. Upload the ZIP file, install it, and activate **Contributor Day Editor
   Abilities**.
4. Open the post or site editor.

### Install from a checkout

Copy or symlink this repository into your WordPress installation's
`wp-content/plugins/contributor-day` directory, then activate the plugin from
the WordPress **Plugins** screen. The plugin does not require a JavaScript
build step; the browser loads the module files in `js/` directly.

## Local development

Install dependencies and start a disposable WordPress Playground instance:

```sh
npm install
npm start
```

`npm start` preserves the Playground data directory between runs. To reset it,
run:

```sh
npm run start:reset
```

To create an installable archive, run:

```sh
npm run zip
```

The archive is written to `dist/contributor-day.zip`.

## Testing

This project currently uses manual browser testing.

1. Install or activate the plugin in a WordPress 7.0+ site.
2. Open a post in the block editor and confirm the browser console reports
   that editor abilities were registered.
3. Use the WordPress abilities API to run the read-only abilities against a
   document with nested blocks, and verify the returned tree, matches,
   locations, and selection match the editor state.
4. Run `editor/can-insert-block` followed by `editor/insert-block`, and verify
   the block is inserted at the requested root, index, or position after a
   block.
5. With WebMCP enabled, confirm that six corresponding tools are registered:
   ability names replace `/` with `_` (for example,
   `editor/get-editor-tree` becomes `editor_get-editor-tree`).
6. Build the package with `npm run zip`, upload the resulting ZIP to
   WordPress, and repeat the editor smoke test.

## License

GPL-2.0-or-later.
