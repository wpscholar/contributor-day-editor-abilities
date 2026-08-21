/**
 * Types for the WebMCP tool layer.
 *
 * The implementation lives in `js/webmcp-tools.js` and stays outside this
 * bundle so that the chat and the ability bridge share one tool registry. It is
 * resolved at runtime through the WordPress import map, so only the shape is
 * described here.
 */

declare module '@contributor-day/webmcp-tools' {
	export interface WebMcpTool {
		name: string;
		description: string;
		inputSchema?: Record< string, unknown >;
		annotations?: Record< string, unknown >;
		source: 'local' | 'webmcp';
	}

	export interface WebMcpToolResult {
		isError: boolean;
		value: unknown;
		text: string;
	}

	export function listTools(): Promise< WebMcpTool[] >;

	export function callTool(
		name: string,
		args?: Record< string, unknown >
	): Promise< WebMcpToolResult >;

	export function onToolsChanged( listener: () => void ): () => void;
}
