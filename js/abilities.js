/**
 * Client-side block editor abilities.
 *
 * These run in the browser against the live block editor stores and are
 * discoverable via @wordpress/abilities (and WebMCP via the bridge).
 */

import {
	getAbility,
	getAbilityCategory,
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
 * @return {{ createBlock: Function, getBlockType: Function }}
 */
function getBlocksApi() {
	const { blocks } = window.wp || {};
	if ( ! blocks?.createBlock || ! blocks?.getBlockType ) {
		throw new Error( 'WordPress blocks API is not available.' );
	}
	return blocks;
}

/**
 * @param {unknown} value
 * @return {boolean}
 */
function isPlainObject( value ) {
	return !! value && typeof value === 'object' && ! Array.isArray( value );
}

/**
 * @param {unknown} value
 * @return {string}
 */
function describeValue( value ) {
	if ( value === null ) {
		return 'null';
	}
	if ( Array.isArray( value ) ) {
		return 'an array';
	}
	return `a ${ typeof value }`;
}

const ATTRIBUTE_TYPE_CHECKS = {
	string: ( value ) => typeof value === 'string',
	'rich-text': ( value ) => typeof value === 'string',
	number: ( value ) => typeof value === 'number',
	integer: ( value ) => Number.isInteger( value ),
	boolean: ( value ) => typeof value === 'boolean',
	array: ( value ) => Array.isArray( value ),
	object: ( value ) => isPlainObject( value ),
	null: ( value ) => value === null,
};

/**
 * @param {string|string[]} type
 * @param {unknown}         value
 * @return {boolean}
 */
function matchesAttributeType( type, value ) {
	const types = Array.isArray( type ) ? type : [ type ];
	return types.some( ( name ) => {
		const check = ATTRIBUTE_TYPE_CHECKS[ name ];
		// An unfamiliar type keyword is not a reason to reject a value.
		return check ? check( value ) : true;
	} );
}

/**
 * Complete one item of a query-sourced attribute against its sub-schema.
 *
 * Defaults declared inside a `query` are only applied while parsing saved
 * markup, so attributes set programmatically arrive incomplete. A table cell
 * without its `tag` default renders as an undefined element and breaks the
 * block, so the defaults are filled in here.
 *
 * @param {unknown} item
 * @param {Object}  query Attribute sub-schema keyed by field.
 * @param {string}  path  Field path, used in error messages.
 * @return {Object}
 */
function normalizeQueryItem( item, query, path ) {
	if ( ! isPlainObject( item ) ) {
		throw new Error(
			`${ path } must be an object, received ${ describeValue( item ) }.`
		);
	}

	const unknown = Object.keys( item ).filter( ( key ) => ! ( key in query ) );
	if ( unknown.length ) {
		throw new Error(
			`${ path } has no field(s): ${ unknown.join(
				', '
			) }. Supported fields: ${ Object.keys( query ).join( ', ' ) }.`
		);
	}

	const normalized = {};
	for ( const [ key, schema ] of Object.entries( query ) ) {
		if ( item[ key ] === undefined ) {
			if ( schema?.default !== undefined ) {
				normalized[ key ] = schema.default;
			}
			continue;
		}
		normalized[ key ] = normalizeAttributeValue(
			item[ key ],
			schema,
			`${ path }.${ key }`
		);
	}
	return normalized;
}

/**
 * Validate one attribute value against its schema and complete nested rows.
 *
 * @param {unknown} value
 * @param {Object}  [schema]
 * @param {string}  path
 * @return {unknown}
 */
function normalizeAttributeValue( value, schema, path ) {
	if ( schema?.type && ! matchesAttributeType( schema.type, value ) ) {
		const expected = Array.isArray( schema.type )
			? schema.type.join( ' or ' )
			: schema.type;
		throw new Error(
			`${ path } must be of type ${ expected }, received ${ describeValue(
				value
			) }.`
		);
	}

	if ( schema?.query && Array.isArray( value ) ) {
		return value.map( ( item, index ) =>
			normalizeQueryItem( item, schema.query, `${ path }[${ index }]` )
		);
	}

	return value;
}

/**
 * Validate attribute keys and values against what the block type declares.
 *
 * @param {string} blockName
 * @param {Object} attributes
 * @return {Object}
 */
function normalizeAttributes( blockName, attributes ) {
	const { getBlockType } = getBlocksApi();

	if ( ! isPlainObject( attributes ) ) {
		throw new Error( 'attributes must be an object.' );
	}

	// Unknown keys are stored but never serialized, so fail loudly with the
	// list the block actually accepts.
	const supported = getBlockType( blockName )?.attributes;
	if ( ! supported ) {
		return { ...attributes };
	}

	const keys = Object.keys( attributes );
	const unknown = keys.filter( ( key ) => ! ( key in supported ) );
	if ( unknown.length ) {
		throw new Error(
			`Block "${ blockName }" has no attribute(s): ${ unknown.join(
				', '
			) }. Supported attributes: ${ Object.keys( supported ).join(
				', '
			) }.`
		);
	}

	const normalized = {};
	for ( const key of keys ) {
		normalized[ key ] = normalizeAttributeValue(
			attributes[ key ],
			supported[ key ],
			key
		);
	}
	return normalized;
}

/**
 * Reject nesting the editor would refuse anyway, before anything is inserted.
 *
 * @param {string} parentName
 * @param {string} childName
 * @param {string} path
 */
function assertNestingAllowed( parentName, childName, path ) {
	const { getBlockType } = getBlocksApi();

	const allowedParents = getBlockType( childName )?.parent;
	if (
		Array.isArray( allowedParents ) &&
		! allowedParents.includes( parentName )
	) {
		throw new Error(
			`${ path }: "${ childName }" can only be nested inside ${ allowedParents.join(
				', '
			) }.`
		);
	}

	const allowedChildren = getBlockType( parentName )?.allowedBlocks;
	if (
		Array.isArray( allowedChildren ) &&
		! allowedChildren.includes( childName )
	) {
		throw new Error(
			`${ path }: "${ parentName }" only accepts ${ allowedChildren.join(
				', '
			) }.`
		);
	}
}

/**
 * Build a block and its descendants from a plain { name, attributes,
 * innerBlocks } spec.
 *
 * @param {Object}  spec
 * @param {string}  [path]       Field path prefix, used in error messages.
 * @param {?string} [parentName] Block name this spec is nested in.
 * @return {Object}
 */
function buildBlock( spec, path = '', parentName = null ) {
	const { createBlock, getBlockType } = getBlocksApi();
	const field = ( key ) => ( path ? `${ path }.${ key }` : key );

	if ( ! isPlainObject( spec ) ) {
		throw new Error(
			`${ path || 'block' } must be an object with a block name.`
		);
	}
	if ( typeof spec.name !== 'string' || ! spec.name ) {
		throw new Error( `${ field( 'name' ) } must be a block name.` );
	}
	if ( ! getBlockType( spec.name ) ) {
		throw new Error( `Block type is not registered: ${ spec.name }` );
	}
	if ( parentName ) {
		assertNestingAllowed( parentName, spec.name, path );
	}

	const children = spec.innerBlocks ?? [];
	if ( ! Array.isArray( children ) ) {
		throw new Error(
			`${ field( 'innerBlocks' ) } must be an array of blocks.`
		);
	}

	return createBlock(
		spec.name,
		normalizeAttributes( spec.name, spec.attributes ?? {} ),
		children.map( ( child, index ) =>
			buildBlock(
				child,
				`${ field( 'innerBlocks' ) }[${ index }]`,
				spec.name
			)
		)
	);
}

/**
 * Serialize a block (and descendants) into a compact tree node.
 *
 * @param {Object} block
 * @param {number} [maxDepth] Depth of descendants to include.
 * @param {number} [depth]
 * @return {Object}
 */
function serializeBlock( block, maxDepth = Infinity, depth = 0 ) {
	const innerBlocks = block.innerBlocks || [];
	const node = {
		clientId: block.clientId,
		name: block.name,
		attributes: block.attributes ?? {},
	};

	if ( depth >= maxDepth ) {
		node.innerBlocks = [];
		node.truncatedInnerBlockCount = innerBlocks.length;
		return node;
	}

	node.innerBlocks = innerBlocks.map( ( innerBlock ) =>
		serializeBlock( innerBlock, maxDepth, depth + 1 )
	);
	return node;
}

/**
 * Serialize a block without its subtree, for flat match lists.
 *
 * @param {Object} block
 * @return {Object}
 */
function summarizeBlock( block ) {
	return {
		clientId: block.clientId,
		name: block.name,
		attributes: block.attributes ?? {},
		innerBlockCount: ( block.innerBlocks || [] ).length,
	};
}

/**
 * Walk the block tree and collect matches as flat summaries. Matched blocks are
 * still descended into, so a match nested inside a match is reported once each.
 *
 * @param {Object[]} blocks
 * @param {(block: Object) => boolean} predicate
 * @param {Object[]} [matches]
 * @return {Object[]}
 */
function collectBlocks( blocks, predicate, matches = [] ) {
	for ( const block of blocks ) {
		if ( predicate( block ) ) {
			matches.push( summarizeBlock( block ) );
		}
		if ( block.innerBlocks?.length ) {
			collectBlocks( block.innerBlocks, predicate, matches );
		}
	}
	return matches;
}

/**
 * Compare an attribute against the requested value as a string. Objects and
 * arrays are compared by their JSON form.
 *
 * @param {unknown} attributeValue
 * @param {string}  expected
 * @return {boolean}
 */
function attributeMatchesValue( attributeValue, expected ) {
	if ( attributeValue === null || attributeValue === undefined ) {
		return false;
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
		if ( typeof value !== 'string' ) {
			return false;
		}
		return (
			value.toLowerCase().includes( needle ) ||
			toSearchableText( value ).includes( needle )
		);
	} );
}

/**
 * Resolve a client ID to a block, throwing when it is missing or unknown.
 *
 * @param {Object} store    Block editor store selectors.
 * @param {string} clientId
 * @param {string} [label]  Input field name, used in the error message.
 * @return {Object}
 */
function requireBlock( store, clientId, label = 'clientId' ) {
	const block = clientId ? store.getBlock( clientId ) : null;
	if ( ! block ) {
		throw new Error( `Block not found for ${ label }: ${ clientId }` );
	}
	return block;
}

/**
 * Ensure a block type is allowed at a location, with an actionable reason when
 * it is not.
 *
 * @param {Object}  store        Block editor store selectors.
 * @param {string}  name         Block name to insert.
 * @param {?string} rootClientId Destination parent, empty for the root.
 */
function assertCanInsert( store, name, rootClientId ) {
	if ( store.canInsertBlockType( name, rootClientId || undefined ) ) {
		return;
	}

	// A container that is still empty renders a placeholder instead of an
	// inner block list, and the editor refuses every child until that list
	// exists. Point at the way out instead of just saying no.
	const parent = rootClientId ? store.getBlock( rootClientId ) : null;
	if (
		parent &&
		! ( parent.innerBlocks || [] ).length &&
		store.getBlockListSettings?.( rootClientId ) === undefined
	) {
		throw new Error(
			`Block type "${ name }" cannot be inserted into "${ parent.name }" because that block is empty and is showing its placeholder, so it accepts no children yet. Insert a new "${ parent.name }" with its children in a single call using innerBlocks, then remove the empty one.`
		);
	}

	throw new Error(
		`Block type "${ name }" cannot be inserted at the requested location.`
	);
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
 * Ensure a category exists without throwing if it was already registered.
 *
 * @param {string} slug
 * @param {{ label: string, description: string }} args
 */
function ensureAbilityCategory( slug, args ) {
	if ( ! getAbilityCategory( slug ) ) {
		registerAbilityCategory( slug, args );
	}
}

/**
 * Ensure an ability exists without throwing if it was already registered.
 *
 * @param {Object} ability
 */
function ensureAbility( ability ) {
	if ( ! getAbility( ability.name ) ) {
		registerAbility( ability );
	}
}

/**
 * Register the block-editor category and editor abilities.
 *
 * @return {string[]} Registered ability names.
 */
export function registerEditorAbilities() {
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
			annotations: {
				readonly: true,
				destructive: false,
				idempotent: true,
			},
		},
		callback: async ( { maxDepth } = {} ) => {
			assertEditorReady();
			const { select } = getData();

			if ( maxDepth !== undefined && ! ( maxDepth >= 0 ) ) {
				throw new Error( 'maxDepth must be zero or greater.' );
			}

			const depthLimit = maxDepth === undefined ? Infinity : maxDepth;
			const blocks = select( BLOCK_EDITOR_STORE ).getBlocks();
			const tree = blocks.map( ( block ) =>
				serializeBlock( block, depthLimit )
			);
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

			const matches = collectBlocks( roots, ( block ) => {
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
		callback: async ( { clientId } = {} ) => {
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

			assertCanInsert( store, input.name, effectiveRootClientId );

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

			if (
				toRootClientId !== fromRootClientId &&
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
			'Updates attributes on an existing block. Supplied attributes are merged into the current ones, and each value must match the shape the block type declares.',
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
						'Attributes to merge into the block. Omitted attributes keep their current values.',
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

			const attributes = normalizeAttributes(
				block.name,
				input.attributes
			);

			await actions.updateBlockAttributes( input.clientId, attributes );

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
				throw new Error(
					`Block "${ block.name }" cannot be removed. It or its parent may be locked.`
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
					? serializeBlock( selectedBlock )
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
		callback: async ( { name, rootClientId } = {} ) => {
			assertEditorReady();
			const { select } = getData();
			const store = select( BLOCK_EDITOR_STORE );

			if ( rootClientId ) {
				requireBlock( store, rootClientId, 'rootClientId' );
			}

			const canInsert = store.canInsertBlockType(
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
