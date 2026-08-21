/**
 * One tool call, shown inline in the assistant turn that asked for it.
 */

import * as React from 'react';
import {
	CheckIcon,
	ChevronRightIcon,
	TriangleAlertIcon,
	WrenchIcon,
} from 'lucide-react';
import type { DynamicToolUIPart } from 'ai';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

function format( value: unknown ): string {
	if ( value === undefined || value === null ) {
		return '{}';
	}
	if ( typeof value === 'string' ) {
		return value;
	}
	try {
		return JSON.stringify( value, null, 2 );
	} catch {
		return String( value );
	}
}

const STATE_LABELS: Record< DynamicToolUIPart[ 'state' ], string > = {
	'input-streaming': 'Preparing',
	'input-available': 'Running',
	'approval-requested': 'Waiting for approval',
	'approval-responded': 'Running',
	'output-available': 'Done',
	'output-denied': 'Denied',
	'output-error': 'Failed',
};

export function ToolCall( { part }: { part: DynamicToolUIPart } ) {
	const failed = part.state === 'output-error';
	const settled = part.state === 'output-available' || failed;

	return (
		<details className="group/tool w-full rounded-lg border border-border bg-card text-xs">
			<summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
				<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/tool:rotate-90" />

				{ ! settled && <Spinner className="size-3.5 shrink-0" /> }
				{ part.state === 'output-available' && (
					<CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
				) }
				{ failed && (
					<TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" />
				) }

				<WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />

				<span className="min-w-0 flex-1 truncate font-mono font-medium">
					{ part.toolName }
				</span>

				<span
					className={ cn(
						'shrink-0 text-muted-foreground',
						failed && 'text-destructive'
					) }
				>
					{ STATE_LABELS[ part.state ] }
				</span>
			</summary>

			<div className="flex flex-col gap-2 border-t border-border px-2.5 py-2">
				<Field label="Input" value={ format( part.input ) } />

				{ part.state === 'output-available' && (
					<Field label="Result" value={ format( part.output ) } />
				) }

				{ failed && (
					<Field
						label="Error"
						value={ part.errorText ?? 'The tool call failed.' }
						tone="destructive"
					/>
				) }
			</div>
		</details>
	);
}

function Field( {
	label,
	value,
	tone,
}: {
	label: string;
	value: string;
	tone?: 'destructive';
} ) {
	return (
		<div className="flex flex-col gap-1">
			<span className="font-medium text-muted-foreground">{ label }</span>
			<pre
				className={ cn(
					'max-h-56 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap',
					tone === 'destructive' &&
						'bg-destructive/10 text-destructive'
				) }
			>
				{ value }
			</pre>
		</div>
	);
}
