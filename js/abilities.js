/**
 * Client-side block editor abilities.
 *
 * These run in the browser against the live block editor stores and are
 * discoverable via @wordpress/abilities (and WebMCP via the bridge).
 */

import {
	registerAbility,
	registerAbilityCategory,
} from '@wordpress/abilities';

const BLOCK_EDITOR_STORE = 'core/block-editor';

/**
 * @return {{ select: Function, dispatch: Function }}
 */
function getData() {
	const { data } = window.wp || {};
	if ( ! data?.select || ! data?.dispatch ) {
		throw new Error(
			'WordPress data store is not available. Open this ability in the block editor.'
		);
	}
	return data;
}

/**
 * @return {{ createBlock: Function }}
 */
function getBlocksApi() {
	const { blocks } = window.wp || {};
	if ( ! blocks?.createBlock ) {
		throw new Error( 'WordPress blocks API is not available.' );
	}
	return blocks;
}

/**
 * Serialize a block (and descendants) into a compact tree node.
 *
 * @param {Object} block
 * @return {Object}
 */
function serializeBlock( block ) {
	return {
		clientId: block.clientId,
		name: block.name,
		attributes: block.attributes ?? {},
		innerBlocks: ( block.innerBlocks || [] ).map( serializeBlock ),
	};
}

/**
 * Walk the block tree and collect matches.
 *
 * @param {Object[]} blocks
 * @param {(block: Object) => boolean} predicate
 * @param {Object[]} [matches]
 * @return {Object[]}
 */
function collectBlocks( blocks, predicate, matches = [] ) {
	for ( const block of blocks ) {
		if ( predicate( block ) ) {
			matches.push( serializeBlock( block ) );
		}
		if ( block.innerBlocks?.length ) {
			collectBlocks( block.innerBlocks, predicate, matches );
		}
	}
	return matches;
}

/**
 * Ensure the block editor store is mounted.
 */
function assertEditorReady() {
	const { select } = getData();
	if ( ! select( BLOCK_EDITOR_STORE ) ) {
		throw new Error(
			'Block editor store is not available. These abilities only work in the block editor.'
		);
	}
}

/**
 * Register the block-editor category and editor abilities.
 *
 * @return {string[]} Registered ability names.
 */
export async function registerEditorAbilities() {
	await registerAbilityCategory( 'block-editor', {
		label: 'Block Editor',
		description:
			'Abilities for inspecting and modifying the WordPress block editor.',
	} );

	const abilityNames = [];

	registerAbility( {
		name: 'editor/get-editor-tree',
		label: 'Get Editor Tree',
		description:
			'Returns the full hierarchical block tree for the current editor document.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				blocks: {
					type: 'array',
					description: 'Top-level blocks and their descendants.',
				},
				count: {
					type: 'integer',
					description: 'Number of top-level blocks.',
				},
			},
			required: [ 'blocks', 'count' ],
		},
		meta: {
			annotations: {
				readonly: true,
				destructive: false,
				idempotent: true,
			},
		},
		callback: async () => {
			assertEditorReady();
			const { select } = getData();
			const blocks = select( BLOCK_EDITOR_STORE ).getBlocks();
			const tree = blocks.map( serializeBlock );
			return { blocks: tree, count: tree.length };
		},
	} );
	abilityNames.push( 'editor/get-editor-tree' );

	registerAbility( {
		name: 'editor/find-editor-blocks',
		label: 'Find Editor Blocks',
		description:
			'Finds blocks in the editor by block name and/or attribute value.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description:
						'Block name to match (e.g. core/paragraph). Omit to match any name.',
				},
				attribute: {
					type: 'string',
					description:
						'Attribute key to match. When set, value is compared with ==.',
				},
				value: {
					description:
						'Attribute value to match when attribute is provided.',
				},
				clientId: {
					type: 'string',
					description:
						'Optional root client ID to search within. Defaults to the full document.',
				},
			},
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				blocks: { type: 'array' },
				count: { type: 'integer' },
			},
			required: [ 'blocks', 'count' ],
		},
		meta: {
			annotations: {
				readonly: true,
				destructive: false,
				idempotent: true,
			},
		},
		callback: async ( input = {} ) => {
			assertEditorReady();
			const { select } = getData();
			const store = select( BLOCK_EDITOR_STORE );
			const roots = input.clientId
				? store.getBlock( input.clientId )?.innerBlocks || []
				: store.getBlocks();

			const matches = collectBlocks( roots, ( block ) => {
				if ( input.name && block.name !== input.name ) {
					return false;
				}
				if ( input.attribute ) {
					return (
						block.attributes?.[ input.attribute ] == input.value
					);
				}
				return true;
			} );

			return { blocks: matches, count: matches.length };
		},
	} );
	abilityNames.push( 'editor/find-editor-blocks' );

	registerAbility( {
		name: 'editor/get-block-location',
		label: 'Get Block Location',
		description:
			'Returns the hierarchical location of a block (parents, root, and index).',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				clientId: {
					type: 'string',
					description: 'Client ID of the block to locate.',
				},
			},
			required: [ 'clientId' ],
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				clientId: { type: 'string' },
				name: { type: 'string' },
				rootClientId: { type: [ 'string', 'null' ] },
				index: { type: 'integer' },
				parentClientIds: { type: 'array' },
				path: { type: 'array' },
			},
			required: [ 'clientId', 'index', 'parentClientIds', 'path' ],
		},
		meta: {
			annotations: {
				readonly: true,
				destructive: false,
				idempotent: true,
			},
		},
		callback: async ( { clientId } = {} ) => {
			assertEditorReady();
			const { select } = getData();
			const store = select( BLOCK_EDITOR_STORE );
			const block = store.getBlock( clientId );

			if ( ! block ) {
				throw new Error( `Block not found: ${ clientId }` );
			}

			const parentClientIds = store.getBlockParents( clientId ) || [];
			const rootClientId = store.getBlockRootClientId( clientId );
			const index = store.getBlockIndex( clientId );

			const path = [ ...parentClientIds, clientId ].map( ( id ) => {
				const node = store.getBlock( id );
				return {
					clientId: id,
					name: node?.name ?? null,
					index: store.getBlockIndex( id ),
				};
			} );

			return {
				clientId,
				name: block.name,
				rootClientId: rootClientId || null,
				index,
				parentClientIds,
				path,
			};
		},
	} );
	abilityNames.push( 'editor/get-block-location' );

	registerAbility( {
		name: 'editor/insert-block',
		label: 'Insert Block',
		description:
			'Inserts a block into the editor. Optionally place it inside a parent or after another block.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description: 'Block name to insert (e.g. core/paragraph).',
				},
				attributes: {
					type: 'object',
					description: 'Optional block attributes.',
				},
				rootClientId: {
					type: 'string',
					description:
						'Optional parent client ID. Omit to insert at the document root.',
				},
				index: {
					type: 'integer',
					description:
						'Optional index within the parent (or root). Defaults to append.',
				},
				afterClientId: {
					type: 'string',
					description:
						'Insert immediately after this block (overrides index when set).',
				},
			},
			required: [ 'name' ],
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				clientId: { type: 'string' },
				name: { type: 'string' },
				rootClientId: { type: [ 'string', 'null' ] },
				index: { type: 'integer' },
			},
			required: [ 'clientId', 'name', 'index' ],
		},
		meta: {
			annotations: {
				readonly: false,
				destructive: false,
				idempotent: false,
			},
		},
		callback: async ( input = {} ) => {
			assertEditorReady();
			const { select, dispatch } = getData();
			const { createBlock } = getBlocksApi();
			const store = select( BLOCK_EDITOR_STORE );
			const actions = dispatch( BLOCK_EDITOR_STORE );

			let effectiveRootClientId = input.rootClientId || '';
			let index = input.index;

			if ( input.afterClientId ) {
				const afterRoot =
					store.getBlockRootClientId( input.afterClientId ) || '';
				const afterIndex = store.getBlockIndex( input.afterClientId );
				index = afterIndex + 1;

				if (
					input.rootClientId &&
					input.rootClientId !== afterRoot
				) {
					throw new Error(
						'afterClientId is not a child of the provided rootClientId.'
					);
				}

				effectiveRootClientId = afterRoot;
			}

			const canInsert = store.canInsertBlockType(
				input.name,
				effectiveRootClientId || undefined
			);
			if ( ! canInsert ) {
				throw new Error(
					`Block type "${ input.name }" cannot be inserted at the requested location.`
				);
			}

			const block = createBlock(
				input.name,
				input.attributes || {},
				[]
			);

			actions.insertBlock(
				block,
				typeof index === 'number' ? index : undefined,
				effectiveRootClientId || undefined
			);

			const insertedIndex = store.getBlockIndex( block.clientId );
			return {
				clientId: block.clientId,
				name: block.name,
				rootClientId: store.getBlockRootClientId( block.clientId ) || null,
				index: insertedIndex,
			};
		},
	} );
	abilityNames.push( 'editor/insert-block' );

	registerAbility( {
		name: 'editor/get-editor-selection',
		label: 'Get Editor Selection',
		description:
			'Returns the current block and rich-text selection in the editor.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				selectedBlockClientId: { type: [ 'string', 'null' ] },
				selectedBlockClientIds: { type: 'array' },
				selectionStart: { type: [ 'object', 'null' ] },
				selectionEnd: { type: [ 'object', 'null' ] },
				selectedBlock: { type: [ 'object', 'null' ] },
			},
			required: [
				'selectedBlockClientId',
				'selectedBlockClientIds',
				'selectionStart',
				'selectionEnd',
			],
		},
		meta: {
			annotations: {
				readonly: true,
				destructive: false,
				idempotent: true,
			},
		},
		callback: async () => {
			assertEditorReady();
			const { select } = getData();
			const store = select( BLOCK_EDITOR_STORE );
			const selectedBlockClientId =
				store.getSelectedBlockClientId() || null;
			const selectedBlockClientIds =
				store.getSelectedBlockClientIds() || [];
			const selectionStart = store.getSelectionStart() || null;
			const selectionEnd = store.getSelectionEnd() || null;
			const selectedBlock = selectedBlockClientId
				? serializeBlock( store.getBlock( selectedBlockClientId ) )
				: null;

			return {
				selectedBlockClientId,
				selectedBlockClientIds,
				selectionStart,
				selectionEnd,
				selectedBlock,
			};
		},
	} );
	abilityNames.push( 'editor/get-editor-selection' );

	registerAbility( {
		name: 'editor/can-insert-block',
		label: 'Can Insert Block',
		description:
			'Checks whether a block type can be inserted at a given location in the editor.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description: 'Block name to check (e.g. core/image).',
				},
				rootClientId: {
					type: 'string',
					description:
						'Optional parent client ID. Omit to check at the document root.',
				},
			},
			required: [ 'name' ],
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				canInsert: { type: 'boolean' },
				name: { type: 'string' },
				rootClientId: { type: [ 'string', 'null' ] },
			},
			required: [ 'canInsert', 'name' ],
		},
		meta: {
			annotations: {
				readonly: true,
				destructive: false,
				idempotent: true,
			},
		},
		callback: async ( { name, rootClientId } = {} ) => {
			assertEditorReady();
			const { select } = getData();
			const canInsert = select( BLOCK_EDITOR_STORE ).canInsertBlockType(
				name,
				rootClientId || undefined
			);
			return {
				canInsert: !! canInsert,
				name,
				rootClientId: rootClientId || null,
			};
		},
	} );
	abilityNames.push( 'editor/can-insert-block' );

	return abilityNames;
}
