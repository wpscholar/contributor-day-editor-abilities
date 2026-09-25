/**
 * Block-editor abilities: inspecting and modifying the block tree, block
 * types, selection, and history.
 */

import {
	BLOCK_EDITOR_STORE,
	BLOCKS_STORE,
	CORE_STORE,
	assertCanInsert,
	assertEditorReady,
	assertNoReservedAttributes,
	buildBlock,
	describeEditingLock,
	ensureAbility,
	ensureAbilityCategory,
	getBlocksApi,
	getContentAttributeNames,
	getData,
	getInnerBlocks,
	isPlainObject,
	mergeAttributeValue,
	normalizeAttributes,
	requireBlock,
	requireBlockType,
	summarizeBlock,
	trySelectBlock,
	waitForBlockListSettings,
	withControlledRef,
} from '@agentic-editor/abilities/shared';

const EDITOR_STORE = 'core/editor';

/**
 * Serialize a block (and descendants) into a compact tree node.
 *
 * @param {Object}       store         Block editor store selectors.
 * @param {Object}       block
 * @param {number}       [maxDepth]    Depth of descendants to include.
 * @param {number}       [depth]
 * @param {Set<unknown>} [visitedRefs] Pattern entities on the current path.
 * @return {Object}
 */
function serializeBlock(
	store,
	block,
	maxDepth = Infinity,
	depth = 0,
	visitedRefs = new Set()
) {
	const { innerBlocks, controlled } = getInnerBlocks( store, block );
	const node = {
		clientId: block.clientId,
		name: block.name,
		attributes: block.attributes ?? {},
	};

	if ( controlled ) {
		node.controlledInnerBlocks = true;
	}

	const childRefs = controlled
		? withControlledRef( block, visitedRefs )
		: visitedRefs;

	if ( depth >= maxDepth || childRefs === null ) {
		node.innerBlocks = [];
		node.truncatedInnerBlockCount = innerBlocks.length;
		return node;
	}

	node.innerBlocks = innerBlocks.map( ( innerBlock ) =>
		serializeBlock( store, innerBlock, maxDepth, depth + 1, childRefs )
	);
	return node;
}

/**
 * Walk the block tree and collect matches as flat summaries. Matched blocks are
 * still descended into, so a match nested inside a match is reported once each.
 *
 * @param {Object}                     store         Block editor store selectors.
 * @param {Object[]}                   blocks
 * @param {(block: Object) => boolean} predicate
 * @param {Object[]}                   [matches]
 * @param {Set<unknown>}               [visitedRefs] Pattern entities on the current path.
 * @return {Object[]}
 */
function collectBlocks(
	store,
	blocks,
	predicate,
	matches = [],
	visitedRefs = new Set()
) {
	for ( const block of blocks ) {
		if ( predicate( block ) ) {
			matches.push( summarizeBlock( store, block ) );
		}

		const { innerBlocks, controlled } = getInnerBlocks( store, block );
		if ( ! innerBlocks.length ) {
			continue;
		}

		const childRefs = controlled
			? withControlledRef( block, visitedRefs )
			: visitedRefs;
		if ( childRefs === null ) {
			continue;
		}

		collectBlocks( store, innerBlocks, predicate, matches, childRefs );
	}
	return matches;
}

/**
 * Rich-text attributes (e.g. paragraph/heading `content`) are RichTextData
 * instances, not plain strings, so a `typeof === 'string'` check misses them.
 *
 * @param {unknown} value
 * @return {boolean}
 */
function isRichTextValue( value ) {
	return (
		!! value &&
		typeof value === 'object' &&
		typeof (
			/** @type {{ toHTMLString?: unknown }} */ ( value ).toHTMLString
		) === 'function'
	);
}

/**
 * Compare an attribute against the requested value as a string. RichTextData
 * (rich-text attributes like paragraph/heading `content`) compares as its
 * rendered text; other objects and arrays compare by their JSON form.
 *
 * @param {unknown} attributeValue
 * @param {string}  expected
 * @return {boolean}
 */
function attributeMatchesValue( attributeValue, expected ) {
	if ( attributeValue === null || attributeValue === undefined ) {
		return false;
	}
	if ( isRichTextValue( attributeValue ) ) {
		return attributeValue.toString() === expected;
	}
	if ( typeof attributeValue === 'object' ) {
		return JSON.stringify( attributeValue ) === expected;
	}
	return String( attributeValue ) === expected;
}

/**
 * Reduce a rich-text attribute to searchable text so a phrase typed by a person
 * can match markup like "<strong>Chloe Nolan</strong>" or "Founder &amp; CEO".
 *
 * @param {string} value
 * @return {string}
 */
function toSearchableText( value ) {
	return value
		.replace( /<[^>]*>/g, ' ' )
		.replace( /&nbsp;/g, ' ' )
		.replace( /&amp;/g, '&' )
		.replace( /&lt;/g, '<' )
		.replace( /&gt;/g, '>' )
		.replace( /&quot;/g, '"' )
		.replace( /&#0?39;/g, "'" )
		.toLowerCase();
}

/**
 * Case-insensitive substring match against every string attribute of a block.
 *
 * @param {Object} block
 * @param {string} search
 * @return {boolean}
 */
function blockMatchesSearch( block, search ) {
	const needle = search.toLowerCase();
	return Object.values( block.attributes || {} ).some( ( value ) => {
		if ( typeof value !== 'string' && ! isRichTextValue( value ) ) {
			return false;
		}
		const text = typeof value === 'string' ? value : value.toString();
		return (
			text.toLowerCase().includes( needle ) ||
			toSearchableText( text ).includes( needle )
		);
	} );
}

/**
 * Describe a block type without its attribute schema, for list results.
 *
 * @param {Object} blockType
 * @return {Object}
 */
function summarizeBlockType( blockType ) {
	const summary = {
		name: blockType.name,
		title: blockType.title ?? blockType.name,
		category: blockType.category ?? null,
		description: blockType.description ?? '',
	};

	// Only report the constraints that exist, so an empty field is never read
	// as "nothing is allowed here".
	if ( Array.isArray( blockType.parent ) ) {
		summary.parent = blockType.parent;
	}
	if ( Array.isArray( blockType.ancestor ) ) {
		summary.ancestor = blockType.ancestor;
	}
	if ( Array.isArray( blockType.allowedBlocks ) ) {
		summary.allowedBlocks = blockType.allowedBlocks;
	}

	return summary;
}

/**
 * Style variations for a block type, with the class name that applies them.
 *
 * @param {string} name
 * @param {Object} blockType
 * @return {Object[]}
 */
function getBlockTypeStyles( name, blockType ) {
	const { select } = getData();
	const registered =
		select( BLOCKS_STORE )?.getBlockStyles?.( name ) ??
		blockType.styles ??
		[];

	return registered.map( ( style ) => ( {
		name: style.name,
		label: style.label ?? style.name,
		isDefault: !! style.isDefault,
		className: `is-style-${ style.name }`,
	} ) );
}

/**
 * Variations for a block type, reduced to what an insert call would need.
 *
 * @param {string} name
 * @return {Object[]}
 */
function getBlockTypeVariations( name ) {
	const { getBlockVariations } = getBlocksApi();
	if ( typeof getBlockVariations !== 'function' ) {
		return [];
	}

	return ( getBlockVariations( name ) || [] ).map( ( variation ) => ( {
		name: variation.name,
		title: variation.title ?? variation.name,
		description: variation.description ?? '',
		isDefault: !! variation.isDefault,
		attributes: variation.attributes ?? {},
		innerBlocks: variation.innerBlocks ?? [],
	} ) );
}

/**
 * Whether the editor has an undo or redo step available.
 *
 * The `core` entity store owns the history that the editor's undo acts on, and
 * its selectors are not deprecated, so it is asked first.
 *
 * @param {'undo'|'redo'} direction
 * @return {boolean|null} Null when this screen exposes no history selectors.
 */
function hasHistoryStep( direction ) {
	const { select } = getData();

	const core = select( CORE_STORE );
	const coreSelector = direction === 'undo' ? core?.hasUndo : core?.hasRedo;
	if ( typeof coreSelector === 'function' ) {
		return !! coreSelector();
	}

	const editor = select( EDITOR_STORE );
	const editorSelector =
		direction === 'undo' ? editor?.hasEditorUndo : editor?.hasEditorRedo;
	if ( typeof editorSelector === 'function' ) {
		return !! editorSelector();
	}

	return null;
}

/**
 * Step the editor history, preferring the editor store so post-specific state
 * is restored along with the document.
 *
 * @param {'undo'|'redo'} direction
 */
async function stepHistory( direction ) {
	const { dispatch } = getData();

	const editorAction = dispatch( EDITOR_STORE )?.[ direction ];
	if ( typeof editorAction === 'function' ) {
		await editorAction();
		return;
	}

	const coreAction = dispatch( CORE_STORE )?.[ direction ];
	if ( typeof coreAction === 'function' ) {
		await coreAction();
		return;
	}

	throw new Error(
		`Editor history is not available on this screen, so ${ direction } cannot run here.`
	);
}

/**
 * Register the block-editor category and its abilities.
 *
 * @return {string[]} Registered ability names.
 */
export function registerBlockEditorAbilities() {
	ensureAbilityCategory( 'block-editor', {
		label: 'Block Editor',
		description:
			'Abilities for inspecting and modifying the WordPress block editor.',
	} );

	const abilityNames = [];

	ensureAbility( {
		name: 'editor/get-editor-tree',
		label: 'Get Editor Tree',
		description:
			'Returns the full hierarchical block tree for the current editor document.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				maxDepth: {
					type: 'integer',
					minimum: 0,
					description:
						'Levels of nested blocks to include. Omit for the whole tree. Truncated nodes report truncatedInnerBlockCount.',
				},
			},
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
			agenticEditor: { untrustedContent: true },
			annotations: {
				readonly: true,
				destructive: false,
				idempotent: true,
			},
		},
		callback: async ( { maxDepth } = /** @type {Object} */ ( {} ) ) => {
			assertEditorReady();
			const { select } = getData();

			if ( maxDepth !== undefined && ! ( maxDepth >= 0 ) ) {
				throw new Error( 'maxDepth must be zero or greater.' );
			}

			const depthLimit = maxDepth === undefined ? Infinity : maxDepth;
			const store = select( BLOCK_EDITOR_STORE );
			const tree = store
				.getBlocks()
				.map( ( block ) => serializeBlock( store, block, depthLimit ) );
			return { blocks: tree, count: tree.length };
		},
	} );
	abilityNames.push( 'editor/get-editor-tree' );

	ensureAbility( {
		name: 'editor/find-editor-blocks',
		label: 'Find Editor Blocks',
		description:
			'Finds blocks in the editor by visible text, block name, and/or attribute value.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				search: {
					type: 'string',
					description:
						'Text to look for in the block attributes, matched case-insensitively as a substring and ignoring HTML markup. Use this to find a block by the words shown in the editor.',
				},
				name: {
					type: 'string',
					description:
						'Block name to match (e.g. core/paragraph). Omit to match any name.',
				},
				attribute: {
					type: 'string',
					description:
						'Attribute key that must be present on the block. Omit value to match on presence alone.',
				},
				value: {
					type: 'string',
					description:
						'Exact attribute value to match, requires attribute. Compared as a string; objects and arrays are compared as JSON. Without attribute it is treated as search.',
				},
				clientId: {
					type: 'string',
					description:
						'Optional client ID to search within, including the block itself. Defaults to the full document.',
				},
			},
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				blocks: {
					type: 'array',
					description:
						'Flat list of matching blocks, without their nested subtrees.',
				},
				count: { type: 'integer' },
			},
			required: [ 'blocks', 'count' ],
		},
		meta: {
			agenticEditor: { untrustedContent: true },
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
				? [ requireBlock( store, input.clientId ) ]
				: store.getBlocks();

			// A value without an attribute is a text search, never "no filter".
			const search =
				input.search ?? ( input.attribute ? undefined : input.value );

			const matches = collectBlocks( store, roots, ( block ) => {
				if ( input.name && block.name !== input.name ) {
					return false;
				}
				if ( input.attribute ) {
					const attributes = block.attributes || {};
					if ( ! ( input.attribute in attributes ) ) {
						return false;
					}
					if (
						input.value !== undefined &&
						! attributeMatchesValue(
							attributes[ input.attribute ],
							input.value
						)
					) {
						return false;
					}
				}
				if ( search && ! blockMatchesSearch( block, search ) ) {
					return false;
				}
				return true;
			} );

			return { blocks: matches, count: matches.length };
		},
	} );
	abilityNames.push( 'editor/find-editor-blocks' );

	ensureAbility( {
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
		callback: async ( { clientId } = /** @type {Object} */ ( {} ) ) => {
			assertEditorReady();
			const { select } = getData();
			const store = select( BLOCK_EDITOR_STORE );
			const block = requireBlock( store, clientId );

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

	ensureAbility( {
		name: 'editor/insert-block',
		label: 'Insert Block',
		description:
			'Inserts a block, with any nested blocks, into the editor. Optionally place it inside a parent or after another block.',
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
				innerBlocks: {
					type: 'array',
					description:
						'Optional nested blocks, inserted with the parent in one step. Build container blocks this way: an empty core/columns (or similar) shows a layout placeholder and accepts no children until it has inner blocks, so a two-column layout must be inserted as core/columns containing two core/column blocks.',
					items: {
						type: 'object',
						properties: {
							name: {
								type: 'string',
								description:
									'Block name to nest (e.g. core/column).',
							},
							attributes: {
								type: 'object',
								description: 'Optional block attributes.',
							},
							innerBlocks: {
								type: 'array',
								description:
									'Blocks nested one level deeper, in the same shape.',
								items: { type: 'object' },
							},
						},
						required: [ 'name' ],
					},
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
				innerBlockCount: { type: 'integer' },
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
			const store = select( BLOCK_EDITOR_STORE );
			const actions = dispatch( BLOCK_EDITOR_STORE );

			// Checked up front so an unknown name is reported as such, rather
			// than as a block the editor refuses to place.
			if ( ! getBlocksApi().getBlockType( input.name ) ) {
				throw new Error(
					`Block type is not registered: ${ input.name }`
				);
			}

			let index = input.index;
			if ( index !== undefined && ! Number.isInteger( index ) ) {
				throw new Error( 'index must be an integer.' );
			}
			if ( index !== undefined && index < 0 ) {
				throw new Error( 'index must be zero or greater.' );
			}

			if ( input.rootClientId ) {
				requireBlock( store, input.rootClientId, 'rootClientId' );
			}

			let effectiveRootClientId = input.rootClientId || '';

			if ( input.afterClientId ) {
				requireBlock( store, input.afterClientId, 'afterClientId' );

				const afterRoot =
					store.getBlockRootClientId( input.afterClientId ) || '';
				if ( input.rootClientId && input.rootClientId !== afterRoot ) {
					throw new Error(
						'afterClientId is not a child of the provided rootClientId.'
					);
				}

				effectiveRootClientId = afterRoot;
				index = store.getBlockIndex( input.afterClientId ) + 1;
			}

			await assertCanInsert( store, input.name, effectiveRootClientId );

			const block = buildBlock( {
				name: input.name,
				attributes: input.attributes,
				innerBlocks: input.innerBlocks,
			} );

			await actions.insertBlock(
				block,
				index,
				effectiveRootClientId || undefined
			);

			// The store drops disallowed insertions silently; report that as a
			// failure rather than returning a client ID that is not in the tree.
			if ( ! store.getBlock( block.clientId ) ) {
				throw new Error(
					'The editor did not insert this block. Its destination may be locked.'
				);
			}

			return {
				clientId: block.clientId,
				name: block.name,
				rootClientId:
					store.getBlockRootClientId( block.clientId ) || null,
				index: store.getBlockIndex( block.clientId ),
				innerBlockCount: block.innerBlocks.length,
			};
		},
	} );
	abilityNames.push( 'editor/insert-block' );

	ensureAbility( {
		name: 'editor/move-block',
		label: 'Move Block',
		description:
			'Moves an existing block to a new position, optionally into a different parent.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				clientId: {
					type: 'string',
					description: 'Client ID of the block to move.',
				},
				afterClientId: {
					type: 'string',
					description:
						'Move immediately after this block. Its parent becomes the destination parent.',
				},
				beforeClientId: {
					type: 'string',
					description:
						'Move immediately before this block. Its parent becomes the destination parent.',
				},
				rootClientId: {
					type: 'string',
					description:
						'Destination parent client ID. Omit to move within the document root.',
				},
				index: {
					type: 'integer',
					description:
						'Destination index within the parent, counted after the move. Ignored when afterClientId or beforeClientId is set. Defaults to last.',
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
				previousRootClientId: { type: [ 'string', 'null' ] },
				previousIndex: { type: 'integer' },
			},
			required: [ 'clientId', 'name', 'index' ],
		},
		meta: {
			annotations: {
				readonly: false,
				destructive: false,
				idempotent: true,
			},
		},
		callback: async ( input = {} ) => {
			assertEditorReady();
			const { select, dispatch } = getData();
			const store = select( BLOCK_EDITOR_STORE );
			const actions = dispatch( BLOCK_EDITOR_STORE );

			const block = requireBlock( store, input.clientId );

			if ( input.afterClientId && input.beforeClientId ) {
				throw new Error(
					'Provide only one of afterClientId or beforeClientId.'
				);
			}
			if (
				input.index !== undefined &&
				! Number.isInteger( input.index )
			) {
				throw new Error( 'index must be an integer.' );
			}
			if ( input.index !== undefined && input.index < 0 ) {
				throw new Error( 'index must be zero or greater.' );
			}

			const fromRootClientId =
				store.getBlockRootClientId( input.clientId ) || '';
			const fromIndex = store.getBlockIndex( input.clientId );

			const sibling = input.afterClientId || input.beforeClientId;
			let toRootClientId;
			let index;

			if ( sibling ) {
				const label = input.afterClientId
					? 'afterClientId'
					: 'beforeClientId';
				if ( sibling === input.clientId ) {
					throw new Error(
						`${ label } must be a different block than clientId.`
					);
				}
				requireBlock( store, sibling, label );

				toRootClientId = store.getBlockRootClientId( sibling ) || '';
				if (
					input.rootClientId &&
					input.rootClientId !== toRootClientId
				) {
					throw new Error(
						`${ label } is not a child of the provided rootClientId.`
					);
				}

				const siblingIndex = store.getBlockIndex( sibling );
				index = input.afterClientId ? siblingIndex + 1 : siblingIndex;

				// Within one parent the block vacates its slot first, so
				// siblings below it shift up by one.
				if (
					toRootClientId === fromRootClientId &&
					siblingIndex > fromIndex
				) {
					index -= 1;
				}
			} else {
				toRootClientId = input.rootClientId || '';
				if ( toRootClientId ) {
					requireBlock( store, toRootClientId, 'rootClientId' );
				}

				const order = store.getBlockOrder( toRootClientId ) || [];
				const lastIndex =
					toRootClientId === fromRootClientId
						? order.length - 1
						: order.length;
				index =
					input.index === undefined
						? lastIndex
						: Math.min( input.index, lastIndex );
			}

			if ( toRootClientId === input.clientId ) {
				throw new Error( 'A block cannot be moved into itself.' );
			}
			if (
				toRootClientId &&
				( store.getBlockParents( toRootClientId ) || [] ).includes(
					input.clientId
				)
			) {
				throw new Error(
					'A block cannot be moved into one of its own descendants.'
				);
			}

			await waitForBlockListSettings( store, toRootClientId );

			// Checked before canInsertBlockType, and even when the parent is not
			// changing: a locked container refuses to reorder its own children,
			// not just accept new ones, and canInsertBlockType special-cases the
			// default block type (core/paragraph) as insertable almost anywhere
			// — moving one into a locked container would otherwise slip past
			// this guard and then have moveBlocksToPosition decline it silently.
			const lockReason = describeEditingLock( store, toRootClientId );
			if ( lockReason ) {
				await trySelectBlock( input.clientId );
				throw new Error(
					`Block "${ block.name }" cannot be moved: ${ lockReason }`
				);
			}

			if (
				! store.canInsertBlockType(
					block.name,
					toRootClientId || undefined
				)
			) {
				throw new Error(
					`Block "${ block.name }" cannot be moved into the requested parent.`
				);
			}

			await actions.moveBlocksToPosition(
				[ input.clientId ],
				fromRootClientId,
				toRootClientId,
				index
			);

			const newRootClientId =
				store.getBlockRootClientId( input.clientId ) || '';
			const newIndex = store.getBlockIndex( input.clientId );

			// The store declines locked moves silently; report that as a failure.
			if ( newRootClientId !== toRootClientId || newIndex !== index ) {
				throw new Error(
					'The editor did not move this block. It or its parent may be locked.'
				);
			}

			return {
				clientId: input.clientId,
				name: block.name,
				rootClientId: newRootClientId || null,
				index: newIndex,
				previousRootClientId: fromRootClientId || null,
				previousIndex: fromIndex,
			};
		},
	} );
	abilityNames.push( 'editor/move-block' );

	ensureAbility( {
		name: 'editor/update-block',
		label: 'Update Block',
		description:
			'Updates attributes on an existing block. Supplied attributes are merged into the current ones, and object values such as style merge at every depth, so pass only what changes; a nested null removes that key. Each value must match the shape the block type declares.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				clientId: {
					type: 'string',
					description: 'Client ID of the block to update.',
				},
				attributes: {
					type: 'object',
					description:
						'Attributes to merge into the block. Omitted attributes, and omitted keys inside object attributes, keep their current values. Set a nested key to null to remove it.',
				},
			},
			required: [ 'clientId', 'attributes' ],
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				clientId: { type: 'string' },
				name: { type: 'string' },
				attributes: { type: 'object' },
				updatedAttributes: { type: 'array' },
			},
			required: [ 'clientId', 'name', 'attributes' ],
		},
		meta: {
			annotations: {
				readonly: false,
				destructive: true,
				idempotent: true,
			},
		},
		callback: async ( input = {} ) => {
			assertEditorReady();
			const { select, dispatch } = getData();
			const store = select( BLOCK_EDITOR_STORE );
			const actions = dispatch( BLOCK_EDITOR_STORE );

			const block = requireBlock( store, input.clientId );

			if ( ! isPlainObject( input.attributes ) ) {
				throw new Error( 'attributes must be an object.' );
			}

			const keys = Object.keys( input.attributes );
			if ( ! keys.length ) {
				throw new Error( 'attributes must contain at least one key.' );
			}

			try {
				assertNoReservedAttributes( input.attributes );
			} catch ( error ) {
				await trySelectBlock( input.clientId );
				throw error;
			}

			// updateBlockAttributes ignores editing modes, so the modes a
			// person would be held to are enforced here: nothing in a
			// "disabled" block (such as the inside of a synced pattern, where
			// an edit changes every copy), and only content in a
			// "contentOnly" one.
			const editingMode = store.getBlockEditingMode?.( input.clientId );

			if ( editingMode === 'disabled' ) {
				await trySelectBlock( input.clientId );
				const lockReason = describeEditingLock( store, input.clientId );
				throw new Error(
					lockReason
						? `Block "${ block.name }" cannot be updated: ${ lockReason }`
						: `Block "${ block.name }" cannot be updated: it is locked against editing in the editor.`
				);
			}

			if ( editingMode === 'contentOnly' ) {
				const contentKeys = getContentAttributeNames( block.name );
				const structural = keys.filter(
					( key ) => ! contentKeys.includes( key )
				);
				if ( structural.length ) {
					await trySelectBlock( input.clientId );
					throw new Error(
						`Block "${ block.name }" is locked so that only its content can be edited, which rules out ${ structural.join(
							', '
						) }. ${
							contentKeys.length
								? `Its content attributes are: ${ contentKeys.join(
										', '
									) }.`
								: 'It has no content attributes that can be edited here.'
						}`
					);
				}
			}

			const attributes = normalizeAttributes(
				block.name,
				input.attributes
			);

			const merged = Object.fromEntries(
				Object.entries( attributes ).map( ( [ key, value ] ) => [
					key,
					mergeAttributeValue( block.attributes?.[ key ], value ),
				] )
			);

			await actions.updateBlockAttributes( input.clientId, merged );

			const updated = requireBlock( store, input.clientId );
			return {
				clientId: input.clientId,
				name: updated.name,
				attributes: updated.attributes ?? {},
				updatedAttributes: keys,
			};
		},
	} );
	abilityNames.push( 'editor/update-block' );

	ensureAbility( {
		name: 'editor/remove-block',
		label: 'Remove Block',
		description:
			'Removes a block, and everything nested inside it, from the editor.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				clientId: {
					type: 'string',
					description: 'Client ID of the block to remove.',
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
				removedInnerBlockCount: { type: 'integer' },
			},
			required: [ 'clientId', 'name', 'index' ],
		},
		meta: {
			annotations: {
				readonly: false,
				destructive: true,
				idempotent: true,
			},
		},
		callback: async ( input = {} ) => {
			assertEditorReady();
			const { select, dispatch } = getData();
			const store = select( BLOCK_EDITOR_STORE );
			const actions = dispatch( BLOCK_EDITOR_STORE );

			const block = requireBlock( store, input.clientId );
			const rootClientId =
				store.getBlockRootClientId( input.clientId ) || null;
			const index = store.getBlockIndex( input.clientId );

			if ( store.canRemoveBlock?.( input.clientId ) === false ) {
				await trySelectBlock( input.clientId );
				const lockReason = describeEditingLock( store, rootClientId );
				throw new Error(
					lockReason
						? `Block "${ block.name }" cannot be removed: ${ lockReason }`
						: `Block "${ block.name }" cannot be removed. It or its parent may be locked.`
				);
			}

			// Leave the selection alone: the agent is editing the document,
			// not moving a caret through it.
			await actions.removeBlock( input.clientId, false );

			if ( store.getBlock( input.clientId ) ) {
				throw new Error(
					'The editor did not remove this block. It or its parent may be locked.'
				);
			}

			return {
				clientId: input.clientId,
				name: block.name,
				rootClientId,
				index,
				removedInnerBlockCount: ( block.innerBlocks || [] ).length,
			};
		},
	} );
	abilityNames.push( 'editor/remove-block' );

	ensureAbility( {
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
			agenticEditor: { untrustedContent: true },
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
			// The selection can reference a block that is already gone.
			const selectedBlock = selectedBlockClientId
				? store.getBlock( selectedBlockClientId )
				: null;

			return {
				selectedBlockClientId,
				selectedBlockClientIds,
				selectionStart,
				selectionEnd,
				selectedBlock: selectedBlock
					? serializeBlock( store, selectedBlock )
					: null,
			};
		},
	} );
	abilityNames.push( 'editor/get-editor-selection' );

	ensureAbility( {
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
		callback: async (
			{ name, rootClientId } = /** @type {Object} */ ( {} )
		) => {
			assertEditorReady();
			const { select } = getData();
			const store = select( BLOCK_EDITOR_STORE );

			if ( rootClientId ) {
				requireBlock( store, rootClientId, 'rootClientId' );
			}

			await waitForBlockListSettings( store, rootClientId );

			// canInsertBlockType special-cases the default block type
			// (core/paragraph) as insertable almost anywhere, including inside
			// a container the editor itself offers no inserter for, so a lock
			// is checked independently rather than trusted to make it false.
			const canInsert =
				! describeEditingLock( store, rootClientId ) &&
				!! store.canInsertBlockType( name, rootClientId || undefined );
			return {
				canInsert,
				name,
				rootClientId: rootClientId || null,
			};
		},
	} );
	abilityNames.push( 'editor/can-insert-block' );

	ensureAbility( {
		name: 'editor/get-block-types',
		label: 'Get Block Types',
		description:
			'Lists the block types registered on this site, including blocks added by the theme and plugins. Use this to discover what can be inserted before calling editor/insert-block.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				search: {
					type: 'string',
					description:
						'Text to match against the block name, title, and keywords, case-insensitively.',
				},
				category: {
					type: 'string',
					description:
						'Block category slug to match (e.g. text, media, design).',
				},
				rootClientId: {
					type: 'string',
					description:
						'Only list block types that can be inserted inside this block. Implies insertableOnly.',
				},
				insertableOnly: {
					type: 'boolean',
					description:
						'Only list block types the editor would allow at the requested location, defaulting to the document root.',
				},
				includeHidden: {
					type: 'boolean',
					description:
						'Include block types hidden from the inserter, which are usually managed by another block.',
				},
			},
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				blockTypes: {
					type: 'array',
					description:
						'Matching block types, without their attribute schemas.',
				},
				count: { type: 'integer' },
				totalCount: {
					type: 'integer',
					description: 'Block types registered before filtering.',
				},
			},
			required: [ 'blockTypes', 'count', 'totalCount' ],
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
			const { getBlockTypes, getCategories } = getBlocksApi();

			if ( typeof getBlockTypes !== 'function' ) {
				throw new Error( 'Block type registry is not available.' );
			}

			if ( input.rootClientId ) {
				requireBlock( store, input.rootClientId, 'rootClientId' );
			}

			const categories = getCategories?.() || [];
			if (
				input.category &&
				categories.length &&
				! categories.some(
					( category ) => category.slug === input.category
				)
			) {
				throw new Error(
					`No block category "${ input.category }". Registered categories: ${ categories
						.map( ( category ) => category.slug )
						.join( ', ' ) }.`
				);
			}

			const all = getBlockTypes();
			const needle = input.search?.toLowerCase();
			const filterInsertable =
				input.insertableOnly || !! input.rootClientId;

			if ( filterInsertable ) {
				await waitForBlockListSettings( store, input.rootClientId );
			}

			// canInsertBlockType special-cases the default block type
			// (core/paragraph) as insertable almost anywhere, including inside
			// a container the editor itself offers no inserter for, so a lock
			// on the destination is checked once, up front, rather than left
			// for canInsertBlockType to catch per block type.
			const locationLocked =
				filterInsertable &&
				!! describeEditingLock( store, input.rootClientId );

			const matches = all
				.filter( ( blockType ) => {
					if (
						! input.includeHidden &&
						blockType.supports?.inserter === false
					) {
						return false;
					}
					if (
						input.category &&
						blockType.category !== input.category
					) {
						return false;
					}
					if ( needle ) {
						const haystack = [
							blockType.name,
							blockType.title,
							...( blockType.keywords || [] ),
						]
							.join( ' ' )
							.toLowerCase();
						if ( ! haystack.includes( needle ) ) {
							return false;
						}
					}
					if ( filterInsertable && locationLocked ) {
						return false;
					}
					if (
						filterInsertable &&
						! store.canInsertBlockType(
							blockType.name,
							input.rootClientId || undefined
						)
					) {
						return false;
					}
					return true;
				} )
				.map( summarizeBlockType )
				.sort( ( a, b ) => a.name.localeCompare( b.name ) );

			return {
				blockTypes: matches,
				count: matches.length,
				totalCount: all.length,
			};
		},
	} );
	abilityNames.push( 'editor/get-block-types' );

	ensureAbility( {
		name: 'editor/get-block-type',
		label: 'Get Block Type',
		description:
			'Returns the full definition of one block type: its attribute schema, nesting rules, supports, style variations, and block variations. Read this before setting attributes on an unfamiliar block.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description: 'Block name to describe (e.g. core/table).',
				},
			},
			required: [ 'name' ],
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				name: { type: 'string' },
				title: { type: 'string' },
				category: { type: [ 'string', 'null' ] },
				description: { type: 'string' },
				keywords: { type: 'array' },
				attributes: {
					type: 'object',
					description:
						'Attribute schema keyed by attribute name, as declared by the block type.',
				},
				supports: { type: 'object' },
				parent: { type: [ 'array', 'null' ] },
				ancestor: { type: [ 'array', 'null' ] },
				allowedBlocks: { type: [ 'array', 'null' ] },
				styles: { type: 'array' },
				variations: { type: 'array' },
			},
			required: [ 'name', 'title', 'attributes' ],
		},
		meta: {
			annotations: {
				readonly: true,
				destructive: false,
				idempotent: true,
			},
		},
		callback: async ( { name } = /** @type {Object} */ ( {} ) ) => {
			assertEditorReady();
			const blockType = requireBlockType( name );

			return {
				name: blockType.name,
				title: blockType.title ?? blockType.name,
				category: blockType.category ?? null,
				description: blockType.description ?? '',
				keywords: blockType.keywords ?? [],
				attributes: blockType.attributes ?? {},
				supports: blockType.supports ?? {},
				parent: blockType.parent ?? null,
				ancestor: blockType.ancestor ?? null,
				allowedBlocks: blockType.allowedBlocks ?? null,
				styles: getBlockTypeStyles( name, blockType ),
				variations: getBlockTypeVariations( name ),
			};
		},
	} );
	abilityNames.push( 'editor/get-block-type' );

	ensureAbility( {
		name: 'editor/transform-block',
		label: 'Transform Block',
		description:
			'Converts a block to another block type in place, keeping its content (for example a paragraph to a heading). A transform can produce more than one block.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				clientId: {
					type: 'string',
					description: 'Client ID of the block to transform.',
				},
				name: {
					type: 'string',
					description:
						'Block name to transform into (e.g. core/heading).',
				},
			},
			required: [ 'clientId', 'name' ],
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				previousClientId: { type: 'string' },
				previousName: { type: 'string' },
				name: { type: 'string' },
				blocks: {
					type: 'array',
					description: 'Blocks the transform produced, in order.',
				},
				count: { type: 'integer' },
				rootClientId: { type: [ 'string', 'null' ] },
				index: { type: 'integer' },
			},
			required: [ 'previousClientId', 'previousName', 'name', 'blocks' ],
		},
		meta: {
			annotations: {
				readonly: false,
				destructive: true,
				idempotent: false,
			},
		},
		callback: async ( input = {} ) => {
			assertEditorReady();
			const { select, dispatch } = getData();
			const store = select( BLOCK_EDITOR_STORE );
			const actions = dispatch( BLOCK_EDITOR_STORE );
			const { switchToBlockType, getPossibleBlockTransformations } =
				getBlocksApi();

			if ( typeof switchToBlockType !== 'function' ) {
				throw new Error( 'Block transforms are not available.' );
			}

			const block = requireBlock( store, input.clientId );
			requireBlockType( input.name );

			if ( block.name === input.name ) {
				throw new Error(
					`Block ${ input.clientId } is already "${ input.name }".`
				);
			}

			// Listing the valid targets turns a refused transform into one the
			// agent can retry, since transforms are declared per block type.
			const possible = (
				getPossibleBlockTransformations?.( [ block ] ) || []
			).map( ( blockType ) => blockType.name );
			if ( possible.length && ! possible.includes( input.name ) ) {
				throw new Error(
					`"${ block.name }" cannot be transformed into "${ input.name }". Available transforms: ${ possible.join(
						', '
					) }.`
				);
			}

			const rootClientId =
				store.getBlockRootClientId( input.clientId ) || '';
			const index = store.getBlockIndex( input.clientId );

			// replaceBlocks checks only the destination, so a block locked
			// against removal would otherwise be replaced anyway.
			if ( store.canRemoveBlock?.( input.clientId ) === false ) {
				await trySelectBlock( input.clientId );
				const lockReason = describeEditingLock( store, rootClientId );
				throw new Error(
					lockReason
						? `Block "${ block.name }" cannot be transformed: ${ lockReason }`
						: `Block "${ block.name }" cannot be transformed, because it is locked against removal. A person needs to unlock it in the editor first.`
				);
			}

			const transformed = switchToBlockType( block, input.name );
			if ( ! transformed || ! transformed.length ) {
				throw new Error(
					`"${ block.name }" cannot be transformed into "${ input.name }".`
				);
			}

			// The result has to be allowed where the original block sits, or
			// the store drops the replacement without saying why.
			for ( const created of transformed ) {
				await assertCanInsert(
					store,
					created.name,
					rootClientId,
					input.clientId
				);
			}

			await actions.replaceBlocks( input.clientId, transformed );

			if ( store.getBlock( input.clientId ) ) {
				throw new Error(
					'The editor did not transform this block. It or its parent may be locked.'
				);
			}

			return {
				previousClientId: input.clientId,
				previousName: block.name,
				name: input.name,
				blocks: transformed.map( ( created ) =>
					summarizeBlock(
						store,
						store.getBlock( created.clientId ) ?? created
					)
				),
				count: transformed.length,
				rootClientId: rootClientId || null,
				index,
			};
		},
	} );
	abilityNames.push( 'editor/transform-block' );

	ensureAbility( {
		name: 'editor/select-block',
		label: 'Select Block',
		description:
			'Selects a block in the editor, scrolling it into view for the person watching. Changes the selection only, never the document.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				clientId: {
					type: 'string',
					description: 'Client ID of the block to select.',
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
				previousClientId: { type: [ 'string', 'null' ] },
			},
			required: [ 'clientId', 'name' ],
		},
		meta: {
			annotations: {
				readonly: false,
				destructive: false,
				idempotent: true,
			},
		},
		callback: async ( { clientId } = /** @type {Object} */ ( {} ) ) => {
			assertEditorReady();
			const { select, dispatch } = getData();
			const store = select( BLOCK_EDITOR_STORE );
			const actions = dispatch( BLOCK_EDITOR_STORE );

			const block = requireBlock( store, clientId );
			const previousClientId = store.getSelectedBlockClientId() || null;

			await actions.selectBlock( clientId );

			if ( store.getSelectedBlockClientId() !== clientId ) {
				throw new Error(
					`The editor did not select block ${ clientId }.`
				);
			}

			return {
				clientId,
				name: block.name,
				rootClientId: store.getBlockRootClientId( clientId ) || null,
				index: store.getBlockIndex( clientId ),
				previousClientId,
			};
		},
	} );
	abilityNames.push( 'editor/select-block' );

	ensureAbility( {
		name: 'editor/undo',
		label: 'Undo',
		description:
			'Undoes the last change to the document, the same as the editor undo button. Each editing ability creates its own undo step.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				undone: { type: 'boolean' },
				hasUndo: { type: [ 'boolean', 'null' ] },
				hasRedo: { type: [ 'boolean', 'null' ] },
			},
			required: [ 'undone' ],
		},
		meta: {
			annotations: {
				readonly: false,
				destructive: true,
				idempotent: false,
			},
		},
		callback: async () => {
			assertEditorReady();

			if ( hasHistoryStep( 'undo' ) === false ) {
				throw new Error( 'There is nothing to undo.' );
			}

			await stepHistory( 'undo' );

			return {
				undone: true,
				hasUndo: hasHistoryStep( 'undo' ),
				hasRedo: hasHistoryStep( 'redo' ),
			};
		},
	} );
	abilityNames.push( 'editor/undo' );

	ensureAbility( {
		name: 'editor/redo',
		label: 'Redo',
		description:
			'Redoes the last undone change to the document, the same as the editor redo button.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				redone: { type: 'boolean' },
				hasUndo: { type: [ 'boolean', 'null' ] },
				hasRedo: { type: [ 'boolean', 'null' ] },
			},
			required: [ 'redone' ],
		},
		meta: {
			annotations: {
				readonly: false,
				destructive: true,
				idempotent: false,
			},
		},
		callback: async () => {
			assertEditorReady();

			if ( hasHistoryStep( 'redo' ) === false ) {
				throw new Error( 'There is nothing to redo.' );
			}

			await stepHistory( 'redo' );

			return {
				redone: true,
				hasUndo: hasHistoryStep( 'undo' ),
				hasRedo: hasHistoryStep( 'redo' ),
			};
		},
	} );
	abilityNames.push( 'editor/redo' );

	return abilityNames;
}
