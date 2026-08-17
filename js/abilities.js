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
const BLOCKS_STORE = 'core/blocks';
const EDITOR_STORE = 'core/editor';
const CORE_STORE = 'core';

const PATTERN_POST_TYPE = 'wp_block';
const PATTERN_TAXONOMY = 'wp_pattern_category';
const PATTERN_BLOCK_NAME = 'core/block';
// Core names user patterns after the block that references them, so a name
// from these abilities is the same name the editor uses internally.
const USER_PATTERN_PREFIX = 'core/block/';

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
 * Patterns arrive over REST, so they have to be awaited rather than read: a
 * plain select returns nothing until the resolver has finished.
 *
 * @return {Function}
 */
function getResolveSelect() {
	const { resolveSelect } = getData();
	if ( typeof resolveSelect !== 'function' ) {
		throw new Error(
			'WordPress data resolvers are not available, so patterns cannot be loaded.'
		);
	}
	return resolveSelect;
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
 * Children of a block, including the ones the block does not own.
 *
 * A synced pattern (core/block) or template part is an inner block controller:
 * its children belong to another entity, so getBlock() reports none and only
 * getBlocks() reaches them. Reading them through getBlock alone leaves the
 * whole contents of a synced pattern invisible.
 *
 * @param {Object} store Block editor store selectors.
 * @param {Object} block
 * @return {{ innerBlocks: Object[], controlled: boolean }}
 */
function getInnerBlocks( store, block ) {
	if ( store?.areInnerBlocksControlled?.( block.clientId ) ) {
		return {
			innerBlocks: store.getBlocks( block.clientId ) || [],
			controlled: true,
		};
	}
	return { innerBlocks: block.innerBlocks || [], controlled: false };
}

/**
 * Extend the set of pattern entities on the current path, so a pattern that
 * references itself (directly or through another pattern) cannot loop forever.
 *
 * The set is copied rather than mutated: two instances of the same pattern
 * side by side are not a cycle, only one nested inside the other is.
 *
 * @param {Object}   block
 * @param {Set<any>} visitedRefs
 * @return {?Set<any>} Set for the children, or null when this entity repeats.
 */
function withControlledRef( block, visitedRefs ) {
	const ref = block.attributes?.ref;
	if ( ref === undefined ) {
		return visitedRefs;
	}
	if ( visitedRefs.has( ref ) ) {
		return null;
	}
	return new Set( visitedRefs ).add( ref );
}

/**
 * Serialize a block (and descendants) into a compact tree node.
 *
 * @param {Object}   store         Block editor store selectors.
 * @param {Object}   block
 * @param {number}   [maxDepth]    Depth of descendants to include.
 * @param {number}   [depth]
 * @param {Set<any>} [visitedRefs] Pattern entities on the current path.
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
 * Serialize a block without its subtree, for flat match lists.
 *
 * @param {Object} store Block editor store selectors.
 * @param {Object} block
 * @return {Object}
 */
function summarizeBlock( store, block ) {
	const { innerBlocks, controlled } = getInnerBlocks( store, block );
	const summary = {
		clientId: block.clientId,
		name: block.name,
		attributes: block.attributes ?? {},
		innerBlockCount: innerBlocks.length,
	};
	if ( controlled ) {
		summary.controlledInnerBlocks = true;
	}
	return summary;
}

/**
 * Walk the block tree and collect matches as flat summaries. Matched blocks are
 * still descended into, so a match nested inside a match is reported once each.
 *
 * @param {Object}                     store         Block editor store selectors.
 * @param {Object[]}                   blocks
 * @param {(block: Object) => boolean} predicate
 * @param {Object[]}                   [matches]
 * @param {Set<any>}                   [visitedRefs] Pattern entities on the current path.
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
 * Ensure a set of blocks is one unbroken run of siblings, which is what
 * replacing them with a single block requires.
 *
 * @param {Object}   store     Block editor store selectors.
 * @param {string[]} clientIds
 * @return {{ rootClientId: string, index: number, clientIds: string[] }}
 */
function requireSiblingRange( store, clientIds ) {
	const rootClientId = store.getBlockRootClientId( clientIds[ 0 ] ) || '';

	const positions = clientIds.map( ( clientId ) => {
		if ( ( store.getBlockRootClientId( clientId ) || '' ) !== rootClientId ) {
			throw new Error(
				'Every clientId must have the same parent to be replaced by one block.'
			);
		}
		return { clientId, index: store.getBlockIndex( clientId ) };
	} );

	positions.sort( ( a, b ) => a.index - b.index );

	const contiguous = positions.every(
		( position, offset ) =>
			offset === 0 ||
			position.index === positions[ offset - 1 ].index + 1
	);
	if ( ! contiguous ) {
		throw new Error(
			'The blocks to replace must sit next to each other, with nothing else between them.'
		);
	}

	return {
		rootClientId,
		index: positions[ 0 ].index,
		clientIds: positions.map( ( position ) => position.clientId ),
	};
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
 * Look up a registered block type, listing nothing useful if it is missing.
 *
 * @param {string} name
 * @return {Object}
 */
function requireBlockType( name ) {
	const { getBlockType } = getBlocksApi();
	if ( typeof name !== 'string' || ! name ) {
		throw new Error( 'name must be a block name (e.g. core/paragraph).' );
	}
	const blockType = getBlockType( name );
	if ( ! blockType ) {
		throw new Error(
			`Block type is not registered: ${ name }. Use editor/get-block-types to list what this site has.`
		);
	}
	return blockType;
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
 * @return {{ parse: Function, serialize: Function }}
 */
function getBlockMarkupApi() {
	const blocks = getBlocksApi();
	if (
		typeof blocks.parse !== 'function' ||
		typeof blocks.serialize !== 'function'
	) {
		throw new Error(
			'WordPress block markup API is not available, so patterns cannot be read or written.'
		);
	}
	return blocks;
}

/**
 * Parse pattern markup into blocks that are not yet in the document.
 *
 * @param {Object} pattern
 * @return {Object[]}
 */
function parsePatternContent( pattern ) {
	const { parse } = getBlockMarkupApi();
	const blocks =
		parse( pattern.content ?? '', {
			__unstableSkipMigrationLogs: true,
		} ) || [];
	return blocks.filter( ( block ) => block?.name );
}

/**
 * @param {Object[]} blocks
 * @return {number} Blocks at every level, not just the top one.
 */
function countPatternBlocks( blocks ) {
	return blocks.reduce(
		( total, block ) =>
			total + 1 + countPatternBlocks( block.innerBlocks || [] ),
		0
	);
}

/**
 * Serialize a parsed pattern block in the shape editor/insert-block accepts.
 *
 * Client IDs are deliberately left out: these blocks are not in the document,
 * so reporting an ID would invite an edit call that cannot resolve it.
 *
 * @param {Object} block
 * @param {number} [maxDepth]
 * @param {number} [depth]
 * @return {Object}
 */
function serializePatternBlock( block, maxDepth = Infinity, depth = 0 ) {
	const innerBlocks = block.innerBlocks || [];
	const node = {
		name: block.name,
		attributes: block.attributes ?? {},
	};

	if ( depth >= maxDepth ) {
		node.innerBlocks = [];
		node.truncatedInnerBlockCount = innerBlocks.length;
		return node;
	}

	node.innerBlocks = innerBlocks.map( ( innerBlock ) =>
		serializePatternBlock( innerBlock, maxDepth, depth + 1 )
	);
	return node;
}

/**
 * Patterns registered by core, the theme, and plugins, read over REST.
 *
 * @return {Promise<Object[]>}
 */
async function loadRegisteredPatterns() {
	const core = getResolveSelect()( CORE_STORE );
	if ( typeof core?.getBlockPatterns !== 'function' ) {
		return [];
	}
	return ( await core.getBlockPatterns() ) || [];
}

/**
 * User patterns, which are wp_block posts.
 *
 * Raw content needs the edit context, and an account without access to it gets
 * nothing back. That is reported as "no user patterns" rather than an error, so
 * the registered ones stay usable.
 *
 * @return {Promise<Object[]>}
 */
async function loadUserPatternRecords() {
	const core = getResolveSelect()( CORE_STORE );
	if ( typeof core?.getEntityRecords !== 'function' ) {
		return [];
	}
	try {
		return (
			( await core.getEntityRecords( 'postType', PATTERN_POST_TYPE, {
				per_page: -1,
				context: 'edit',
			} ) ) || []
		);
	} catch {
		return [];
	}
}

/**
 * wp_pattern_category terms, which is where user pattern categories live.
 *
 * @return {Promise<Object[]>}
 */
async function loadPatternCategoryTerms() {
	const core = getResolveSelect()( CORE_STORE );
	if ( typeof core?.getEntityRecords !== 'function' ) {
		return [];
	}
	try {
		return (
			( await core.getEntityRecords( 'taxonomy', PATTERN_TAXONOMY, {
				per_page: -1,
				hide_empty: false,
			} ) ) || []
		);
	} catch {
		return [];
	}
}

/**
 * @param {Object} pattern Registered pattern, as returned by REST.
 * @return {Object}
 */
function normalizeRegisteredPattern( pattern ) {
	return {
		name: pattern.name,
		title: pattern.title ?? pattern.name,
		description: pattern.description ?? '',
		source: pattern.source ?? null,
		isUserPattern: false,
		id: null,
		syncStatus: null,
		categories: pattern.categories ?? [],
		blockTypes: pattern.blockTypes ?? [],
		inserter: pattern.inserter !== false,
		content: pattern.content ?? '',
	};
}

/**
 * @param {Object}            record            A wp_block post.
 * @param {Map<number,string>} categorySlugsById
 * @return {Object}
 */
function normalizeUserPattern( record, categorySlugsById ) {
	const syncStatus =
		record.wp_pattern_sync_status ??
		record.meta?.wp_pattern_sync_status ??
		'';

	return {
		name: `${ USER_PATTERN_PREFIX }${ record.id }`,
		title: record.title?.raw ?? record.title?.rendered ?? '',
		description: '',
		source: 'user',
		isUserPattern: true,
		id: record.id,
		// Core stores an empty sync status for a fully synced pattern and only
		// writes the meta for unsynced ones.
		syncStatus: syncStatus === 'unsynced' ? 'unsynced' : 'synced',
		categories: ( record.wp_pattern_category ?? [] ).map(
			( termId ) => categorySlugsById.get( termId ) ?? String( termId )
		),
		blockTypes: [],
		inserter: true,
		content: record.content?.raw ?? record.content?.rendered ?? '',
	};
}

/**
 * Every pattern this editor can use, from both sources, in one shape.
 *
 * @return {Promise<Object[]>}
 */
async function loadPatterns() {
	const [ registered, records, terms ] = await Promise.all( [
		loadRegisteredPatterns(),
		loadUserPatternRecords(),
		loadPatternCategoryTerms(),
	] );

	const categorySlugsById = new Map(
		terms.map( ( term ) => [ term.id, term.slug ] )
	);

	return [
		...records.map( ( record ) =>
			normalizeUserPattern( record, categorySlugsById )
		),
		...registered.map( normalizeRegisteredPattern ),
	];
}

// Parsing is the expensive part of listing patterns, and a block theme can
// ship dozens, so the shape of each one is kept until its markup changes.
const patternStructureCache = new Map();

/**
 * @param {Object} pattern
 * @return {{ blockCount: number, rootBlockNames: string[] }}
 */
function getPatternStructure( pattern ) {
	const cached = patternStructureCache.get( pattern.name );
	if ( cached && cached.content === pattern.content ) {
		return cached.structure;
	}

	const blocks = parsePatternContent( pattern );
	const structure = {
		blockCount: countPatternBlocks( blocks ),
		rootBlockNames: blocks.map( ( block ) => block.name ),
	};
	patternStructureCache.set( pattern.name, {
		content: pattern.content,
		structure,
	} );
	return structure;
}

/**
 * Describe a pattern without its markup, for list results.
 *
 * @param {Object} pattern
 * @return {Object}
 */
function summarizePattern( pattern ) {
	const { blockCount, rootBlockNames } = getPatternStructure( pattern );
	const summary = {
		name: pattern.name,
		title: pattern.title,
		description: pattern.description,
		source: pattern.source,
		isUserPattern: pattern.isUserPattern,
		syncStatus: pattern.syncStatus,
		categories: pattern.categories,
		blockCount,
		rootBlockNames,
	};

	if ( pattern.blockTypes.length ) {
		summary.blockTypes = pattern.blockTypes;
	}

	return summary;
}

/**
 * @param {string} name
 * @return {Promise<Object>}
 */
async function requirePattern( name ) {
	if ( typeof name !== 'string' || ! name ) {
		throw new Error(
			'name must be a pattern name from editor/get-patterns.'
		);
	}

	const patterns = await loadPatterns();
	const pattern = patterns.find( ( candidate ) => candidate.name === name );
	if ( ! pattern ) {
		throw new Error(
			`Pattern not found: ${ name }. Use editor/get-patterns to list what this site has.`
		);
	}
	return pattern;
}

/**
 * Pattern categories from both sources, keyed by slug. A category only has a
 * term id once something has been filed under it.
 *
 * @return {Promise<Object[]>}
 */
async function listPatternCategories() {
	const core = getResolveSelect()( CORE_STORE );
	const [ registered, terms ] = await Promise.all( [
		typeof core?.getBlockPatternCategories === 'function'
			? core.getBlockPatternCategories()
			: [],
		loadPatternCategoryTerms(),
	] );

	const bySlug = new Map();
	for ( const category of registered || [] ) {
		bySlug.set( category.name, {
			name: category.name,
			label: category.label ?? category.name,
			description: category.description ?? '',
			id: null,
			registered: true,
		} );
	}
	for ( const term of terms ) {
		const existing = bySlug.get( term.slug );
		bySlug.set( term.slug, {
			name: term.slug,
			label: term.name ?? existing?.label ?? term.slug,
			description: term.description ?? existing?.description ?? '',
			id: term.id,
			registered: existing?.registered ?? false,
		} );
	}

	return [ ...bySlug.values() ].sort( ( a, b ) =>
		a.name.localeCompare( b.name )
	);
}

/**
 * Turn category names into the term ids wp_pattern_category stores, creating
 * the term when it does not exist yet. The editor does the same: a category a
 * theme declared has no term until a pattern is filed under it.
 *
 * @param {string[]} [names]
 * @return {Promise<{ ids: number[], slugs: string[], created: string[] }>}
 */
async function resolvePatternCategoryIds( names ) {
	if ( ! names?.length ) {
		return { ids: [], slugs: [], created: [] };
	}

	const { dispatch } = getData();
	const categories = await listPatternCategories();
	const ids = [];
	const slugs = [];
	const created = [];

	for ( const requested of names ) {
		if ( typeof requested !== 'string' || ! requested ) {
			throw new Error(
				'categories must be a list of pattern category names.'
			);
		}

		const needle = requested.toLowerCase();
		const match = categories.find(
			( category ) =>
				category.name.toLowerCase() === needle ||
				category.label.toLowerCase() === needle
		);

		if ( match?.id ) {
			ids.push( match.id );
			slugs.push( match.name );
			continue;
		}

		const term = await dispatch( CORE_STORE ).saveEntityRecord(
			'taxonomy',
			PATTERN_TAXONOMY,
			{ name: match?.label ?? requested, slug: match?.name },
			{ throwOnError: true }
		);
		if ( ! term?.id ) {
			throw new Error(
				`Could not create the pattern category "${ requested }".`
			);
		}

		ids.push( term.id );
		slugs.push( term.slug ?? requested );
		created.push( term.slug ?? requested );
	}

	return { ids, slugs, created };
}

/**
 * Refuse a save the REST API would refuse anyway, with a readable reason.
 */
async function assertCanCreatePatterns() {
	const core = getResolveSelect()( CORE_STORE );
	if ( typeof core?.canUser !== 'function' ) {
		return;
	}

	let allowed;
	try {
		allowed = await core.canUser( 'create', {
			kind: 'postType',
			name: PATTERN_POST_TYPE,
		} );
	} catch {
		// A check that cannot run is not a refusal; let the save report it.
		return;
	}

	if ( allowed === false ) {
		throw new Error(
			'This account is not allowed to create patterns on this site.'
		);
	}
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
		callback: async ( { name } = {} ) => {
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

			const transformed = switchToBlockType( block, input.name );
			if ( ! transformed || ! transformed.length ) {
				throw new Error(
					`"${ block.name }" cannot be transformed into "${ input.name }".`
				);
			}

			// The result has to be allowed where the original block sits, or
			// the store drops the replacement without saying why.
			for ( const created of transformed ) {
				assertCanInsert( store, created.name, rootClientId );
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
		callback: async ( { clientId } = {} ) => {
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

	ensureAbility( {
		name: 'editor/get-patterns',
		label: 'Get Patterns',
		description:
			'Lists the block patterns available in this editor, from the theme, plugins, core, and the patterns saved on this site. Use this to find a ready-made layout before building one block by block.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				search: {
					type: 'string',
					description:
						'Text to match against the pattern title, name, description, and categories, case-insensitively.',
				},
				category: {
					type: 'string',
					description:
						'Pattern category slug to match (e.g. header, gallery). Use editor/get-pattern-categories to list them.',
				},
				blockTypes: {
					type: 'array',
					description:
						'Only list patterns that declare one of these block types as their intended context.',
					items: { type: 'string' },
				},
				source: {
					type: 'string',
					description:
						'Only list patterns from this source: user for patterns saved on this site, otherwise the registered source such as theme, plugin, core, or pattern-directory.',
				},
				syncStatus: {
					type: 'string',
					enum: [ 'synced', 'unsynced' ],
					description:
						'Only list patterns saved on this site with this sync status.',
				},
				rootClientId: {
					type: 'string',
					description:
						'Only list patterns whose top-level blocks can all be inserted inside this block.',
				},
				includeHidden: {
					type: 'boolean',
					description:
						'Include patterns their author hid from the inserter.',
				},
			},
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				patterns: {
					type: 'array',
					description:
						'Matching patterns, without their block markup.',
				},
				count: { type: 'integer' },
				totalCount: {
					type: 'integer',
					description: 'Patterns available before filtering.',
				},
			},
			required: [ 'patterns', 'count', 'totalCount' ],
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

			if ( input.rootClientId ) {
				requireBlock( store, input.rootClientId, 'rootClientId' );
			}
			if ( input.blockTypes && ! Array.isArray( input.blockTypes ) ) {
				throw new Error( 'blockTypes must be an array of block names.' );
			}

			const all = await loadPatterns();
			const needle = input.search?.toLowerCase();

			const matches = all
				.filter( ( pattern ) => {
					if ( ! input.includeHidden && ! pattern.inserter ) {
						return false;
					}
					if (
						input.source &&
						pattern.source !== input.source &&
						! pattern.source?.startsWith( `${ input.source }/` )
					) {
						return false;
					}
					if (
						input.syncStatus &&
						pattern.syncStatus !== input.syncStatus
					) {
						return false;
					}
					if (
						input.category &&
						! pattern.categories.includes( input.category )
					) {
						return false;
					}
					if (
						input.blockTypes?.length &&
						! input.blockTypes.some( ( blockType ) =>
							pattern.blockTypes.includes( blockType )
						)
					) {
						return false;
					}
					if ( needle ) {
						const haystack = [
							pattern.name,
							pattern.title,
							pattern.description,
							...pattern.categories,
						]
							.join( ' ' )
							.toLowerCase();
						if ( ! haystack.includes( needle ) ) {
							return false;
						}
					}
					if ( input.rootClientId ) {
						const { rootBlockNames } =
							getPatternStructure( pattern );
						const fits =
							rootBlockNames.length &&
							rootBlockNames.every( ( blockName ) =>
								store.canInsertBlockType(
									blockName,
									input.rootClientId
								)
							);
						if ( ! fits ) {
							return false;
						}
					}
					return true;
				} )
				.map( summarizePattern )
				.sort( ( a, b ) => a.title.localeCompare( b.title ) );

			return {
				patterns: matches,
				count: matches.length,
				totalCount: all.length,
			};
		},
	} );
	abilityNames.push( 'editor/get-patterns' );

	ensureAbility( {
		name: 'editor/get-pattern',
		label: 'Get Pattern',
		description:
			'Returns one pattern in full, as the block tree it would insert. Read this to see what a pattern contains, or to copy its structure into editor/insert-block.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description:
						'Pattern name from editor/get-patterns (e.g. twentytwentyfive/hero, core/block/12).',
				},
				maxDepth: {
					type: 'integer',
					minimum: 0,
					description:
						'Levels of nested blocks to include. Omit for the whole tree.',
				},
				includeContent: {
					type: 'boolean',
					description:
						'Also return the raw block markup, which is what gets saved.',
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
				description: { type: 'string' },
				source: { type: [ 'string', 'null' ] },
				isUserPattern: { type: 'boolean' },
				id: { type: [ 'integer', 'null' ] },
				syncStatus: { type: [ 'string', 'null' ] },
				categories: { type: 'array' },
				blockTypes: { type: 'array' },
				blockCount: { type: 'integer' },
				blocks: {
					type: 'array',
					description:
						'Parsed blocks as { name, attributes, innerBlocks }, without client IDs: nothing here is in the document yet.',
				},
				content: { type: 'string' },
			},
			required: [ 'name', 'title', 'blocks', 'blockCount' ],
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

			if ( input.maxDepth !== undefined && ! ( input.maxDepth >= 0 ) ) {
				throw new Error( 'maxDepth must be zero or greater.' );
			}

			const pattern = await requirePattern( input.name );
			const blocks = parsePatternContent( pattern );
			const depthLimit =
				input.maxDepth === undefined ? Infinity : input.maxDepth;

			const result = {
				name: pattern.name,
				title: pattern.title,
				description: pattern.description,
				source: pattern.source,
				isUserPattern: pattern.isUserPattern,
				id: pattern.id,
				syncStatus: pattern.syncStatus,
				categories: pattern.categories,
				blockTypes: pattern.blockTypes,
				blockCount: countPatternBlocks( blocks ),
				blocks: blocks.map( ( block ) =>
					serializePatternBlock( block, depthLimit )
				),
			};

			if ( input.includeContent ) {
				result.content = pattern.content;
			}

			return result;
		},
	} );
	abilityNames.push( 'editor/get-pattern' );

	ensureAbility( {
		name: 'editor/get-pattern-categories',
		label: 'Get Pattern Categories',
		description:
			'Lists the pattern categories on this site, both the ones registered by core and the theme and the ones patterns are filed under. Use this before filtering editor/get-patterns or filing a new pattern.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				categories: {
					type: 'array',
					description:
						'Categories as { name, label, description, id, registered }. A null id means no pattern has been filed under it yet.',
				},
				count: { type: 'integer' },
			},
			required: [ 'categories', 'count' ],
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
			const categories = await listPatternCategories();
			return { categories, count: categories.length };
		},
	} );
	abilityNames.push( 'editor/get-pattern-categories' );

	ensureAbility( {
		name: 'editor/insert-pattern',
		label: 'Insert Pattern',
		description:
			'Inserts a pattern into the editor at a chosen location. Returns the client ID of every block it inserted, so the content can then be edited with editor/update-block.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description: 'Pattern name from editor/get-patterns.',
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
				asReference: {
					type: 'boolean',
					description:
						'For a pattern saved on this site, insert a single core/block that references it instead of copying its blocks in. Defaults to true for synced patterns, which is how the editor inserts them.',
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
				asReference: { type: 'boolean' },
				blocks: {
					type: 'array',
					description: 'The inserted top-level blocks, in order.',
				},
				count: { type: 'integer' },
				rootClientId: { type: [ 'string', 'null' ] },
				index: { type: 'integer' },
			},
			required: [ 'name', 'blocks', 'count' ],
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

			const pattern = await requirePattern( input.name );

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

			const asReference =
				input.asReference ?? pattern.syncStatus === 'synced';
			if ( asReference && ! pattern.isUserPattern ) {
				throw new Error(
					`Pattern "${ pattern.name }" is registered by ${
						pattern.source ?? 'this site'
					} rather than saved on it, so it has nothing to reference. Insert it without asReference.`
				);
			}

			let blocks;
			if ( asReference ) {
				requireBlockType( PATTERN_BLOCK_NAME );
				blocks = [
					getBlocksApi().createBlock( PATTERN_BLOCK_NAME, {
						ref: pattern.id,
					} ),
				];
			} else {
				blocks = parsePatternContent( pattern );
				if ( ! blocks.length ) {
					throw new Error(
						`Pattern "${ pattern.name }" contains no blocks.`
					);
				}
			}

			for ( const block of blocks ) {
				assertCanInsert( store, block.name, effectiveRootClientId );
			}

			await actions.insertBlocks(
				blocks,
				index,
				effectiveRootClientId || undefined
			);

			const inserted = blocks.filter( ( block ) =>
				store.getBlock( block.clientId )
			);
			if ( inserted.length !== blocks.length ) {
				throw new Error(
					'The editor did not insert this pattern. Its destination may be locked.'
				);
			}

			return {
				name: pattern.name,
				title: pattern.title,
				asReference,
				blocks: inserted.map( ( block ) =>
					summarizeBlock( store, store.getBlock( block.clientId ) )
				),
				count: inserted.length,
				rootClientId:
					store.getBlockRootClientId( inserted[ 0 ].clientId ) ||
					null,
				index: store.getBlockIndex( inserted[ 0 ].clientId ),
			};
		},
	} );
	abilityNames.push( 'editor/insert-pattern' );

	ensureAbility( {
		name: 'editor/create-pattern',
		label: 'Create Pattern',
		description:
			'Saves blocks as a reusable pattern on this site, either blocks already in the document or a block structure supplied directly. Synced patterns stay linked everywhere they are used; unsynced ones are copied on insert.',
		category: 'block-editor',
		input_schema: {
			type: 'object',
			properties: {
				title: {
					type: 'string',
					description: 'Name the pattern is saved and listed under.',
				},
				clientIds: {
					type: 'array',
					description:
						'Client IDs of blocks already in the document to save, in the order they should appear in the pattern.',
					items: { type: 'string' },
				},
				blocks: {
					type: 'array',
					description:
						'Blocks to save, as { name, attributes, innerBlocks }, the same shape editor/insert-block accepts. Use this instead of clientIds to save a pattern that is not in the document.',
					items: {
						type: 'object',
						properties: {
							name: { type: 'string' },
							attributes: { type: 'object' },
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
				syncStatus: {
					type: 'string',
					enum: [ 'synced', 'unsynced' ],
					description:
						'synced keeps every instance in step with the saved pattern; unsynced inserts an independent copy. Defaults to unsynced.',
				},
				categories: {
					type: 'array',
					description:
						'Category names to file the pattern under. A category with no term yet gets one created, the same as the editor does.',
					items: { type: 'string' },
				},
				replaceSource: {
					type: 'boolean',
					description:
						'Replace the blocks named in clientIds with a reference to the new pattern. Synced patterns only, and the blocks must be neighbours.',
				},
			},
			required: [ 'title' ],
			additionalProperties: false,
		},
		output_schema: {
			type: 'object',
			properties: {
				id: { type: 'integer' },
				name: {
					type: 'string',
					description:
						'Pattern name to pass to editor/insert-pattern.',
				},
				title: { type: 'string' },
				syncStatus: { type: 'string' },
				categories: { type: 'array' },
				createdCategories: {
					type: 'array',
					description: 'Categories that did not exist until now.',
				},
				blockCount: { type: 'integer' },
				replacedClientIds: { type: [ 'array', 'null' ] },
				clientId: {
					type: [ 'string', 'null' ],
					description:
						'Client ID of the reference block, when the source blocks were replaced.',
				},
			},
			required: [ 'id', 'name', 'title', 'syncStatus', 'blockCount' ],
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
			const { serialize } = getBlockMarkupApi();

			if ( typeof input.title !== 'string' || ! input.title.trim() ) {
				throw new Error( 'title must be a name for the pattern.' );
			}

			const hasClientIds = !! input.clientIds?.length;
			const hasBlocks = !! input.blocks?.length;
			if ( hasClientIds === hasBlocks ) {
				throw new Error(
					'Pass either clientIds, to save blocks already in the document, or blocks, to save a structure directly.'
				);
			}

			const syncStatus = input.syncStatus ?? 'unsynced';
			if ( ! [ 'synced', 'unsynced' ].includes( syncStatus ) ) {
				throw new Error(
					'syncStatus must be either synced or unsynced.'
				);
			}

			let sourceBlocks;
			let siblingRange = null;
			if ( hasClientIds ) {
				sourceBlocks = input.clientIds.map( ( clientId ) =>
					requireBlock( store, clientId, 'clientIds' )
				);
				if ( input.replaceSource ) {
					if ( syncStatus !== 'synced' ) {
						throw new Error(
							'replaceSource only applies to a synced pattern, since an unsynced one leaves the original blocks unchanged.'
						);
					}
					siblingRange = requireSiblingRange(
						store,
						input.clientIds
					);
				}
			} else {
				if ( input.replaceSource ) {
					throw new Error(
						'replaceSource needs clientIds, since there are no blocks in the document to replace.'
					);
				}
				sourceBlocks = input.blocks.map( ( spec, position ) =>
					buildBlock( spec, `blocks[${ position }]` )
				);
			}

			await assertCanCreatePatterns();

			const { ids, slugs, created } = await resolvePatternCategoryIds(
				input.categories
			);

			const record = await dispatch( CORE_STORE ).saveEntityRecord(
				'postType',
				PATTERN_POST_TYPE,
				{
					title: input.title,
					content: serialize( sourceBlocks ),
					status: 'publish',
					// Core writes the sync status only for unsynced patterns;
					// no meta at all is what marks one as fully synced.
					meta:
						syncStatus === 'unsynced'
							? { wp_pattern_sync_status: 'unsynced' }
							: undefined,
					wp_pattern_category: ids,
				},
				{ throwOnError: true }
			);

			if ( ! record?.id ) {
				throw new Error( 'WordPress did not save this pattern.' );
			}

			const result = {
				id: record.id,
				name: `${ USER_PATTERN_PREFIX }${ record.id }`,
				title: input.title,
				syncStatus,
				categories: slugs,
				createdCategories: created,
				blockCount: countPatternBlocks( sourceBlocks ),
				replacedClientIds: null,
				clientId: null,
			};

			if ( siblingRange ) {
				requireBlockType( PATTERN_BLOCK_NAME );
				assertCanInsert(
					store,
					PATTERN_BLOCK_NAME,
					siblingRange.rootClientId
				);

				const reference = getBlocksApi().createBlock(
					PATTERN_BLOCK_NAME,
					{ ref: record.id }
				);
				await actions.replaceBlocks( siblingRange.clientIds, [
					reference,
				] );

				if ( ! store.getBlock( reference.clientId ) ) {
					throw new Error(
						`The pattern was saved as ${ result.name }, but the editor did not replace the original blocks with it.`
					);
				}

				result.replacedClientIds = siblingRange.clientIds;
				result.clientId = reference.clientId;
			}

			return result;
		},
	} );
	abilityNames.push( 'editor/create-pattern' );

	return abilityNames;
}
