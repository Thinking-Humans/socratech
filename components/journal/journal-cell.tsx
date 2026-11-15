"use client";

/**
 * One journal cell, Jupyter-style (owner, 2026-11-15): rendered by default
 * (markdown + KaTeX through MessageResponse; code as a highlighted fence);
 * click or Enter edits the raw text in place; Esc, Ctrl/⌘+Enter or
 * click-away commits and renders; Shift+Enter commits and opens a new cell
 * below. The draft lives here while editing, so a refetch triggered by
 * another writer (turn-end fill, MCP) never clobbers what is being typed.
 */

import { useEffect, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, EyeIcon, EyeOffIcon, Trash2Icon } from "lucide-react";
import { JOURNAL_CELL_ROLES, type CellPatch, type JournalCell, type JournalCellRole } from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";

const ROLE_LABEL: Record<JournalCellRole, string> = {
	reflection: "Reflection",
	aside: "Aside",
	code: "Code",
	exercise: "Exercise",
	attempt: "Attempt",
	verdict: "Verdict",
};

const ROLE_TONE: Record<JournalCellRole, string> = {
	reflection: "",
	aside: "border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground",
	code: "",
	exercise: "rounded-md border border-primary/30 bg-primary/5 px-3 py-2",
	attempt: "rounded-md border border-border bg-muted/40 px-3 py-2",
	verdict: "rounded-md border border-border bg-muted/20 px-3 py-2",
};

function fenced(text: string, info: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	const ticks = "`".repeat(Math.max(3, longest + 1));
	return `${ticks}${info}\n${text.replace(/\n+$/, "")}\n${ticks}`;
}

export interface JournalCellProps {
	cell: JournalCell;
	index: number;
	count: number;
	editing: boolean;
	onEdit: () => void;
	onDone: () => void;
	onCommit: (patch: CellPatch) => Promise<void>;
	onAddBelow: () => void;
	onMove: (toIndex: number) => void;
	onDelete: () => void;
}

export function JournalCellView({ cell, index, count, editing, onEdit, onDone, onCommit, onAddBelow, onMove, onDelete }: JournalCellProps) {
	const [source, setSource] = useState(cell.source);
	const [lang, setLang] = useState(cell.lang ?? "");
	const [output, setOutput] = useState(cell.output ?? "");
	const rootRef = useRef<HTMLDivElement>(null);
	const sourceRef = useRef<HTMLTextAreaElement>(null);

	// Adopt server truth only while NOT editing (the draft is the learner's).
	useEffect(() => {
		if (editing) return;
		setSource(cell.source);
		setLang(cell.lang ?? "");
		setOutput(cell.output ?? "");
	}, [editing, cell.source, cell.lang, cell.output]);

	useEffect(() => {
		if (!editing) return;
		const el = sourceRef.current;
		if (!el) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
	}, [editing]);

	const commit = async (then: () => void) => {
		const patch: CellPatch = {};
		if (source !== cell.source) patch.source = source;
		if (cell.role === "code") {
			if (lang !== (cell.lang ?? "")) patch.lang = lang;
			if (output !== (cell.output ?? "")) patch.output = output;
		}
		if (Object.keys(patch).length > 0) await onCommit(patch);
		then();
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
			e.preventDefault();
			e.stopPropagation();
			void commit(() => {
				onDone();
				rootRef.current?.focus();
			});
		} else if (e.key === "Enter" && e.shiftKey) {
			e.preventDefault();
			void commit(() => {
				onDone();
				onAddBelow();
			});
		}
	};

	// Click-away commits (focus leaving the cell's own controls).
	const onBlur = (e: React.FocusEvent) => {
		if (!editing) return;
		if (rootRef.current?.contains(e.relatedTarget as Node | null)) return;
		void commit(onDone);
	};

	const rendered =
		cell.role === "code"
			? [cell.source.trim() ? fenced(cell.source, cell.lang || "text") : "", cell.output?.trim() ? fenced(cell.output, "text") : ""]
					.filter(Boolean)
					.join("\n\n")
			: cell.source;

	return (
		<div
			ref={rootRef}
			tabIndex={-1}
			data-testid="journal-cell"
			data-role={cell.role}
			onBlur={onBlur}
			onKeyDown={(e) => {
				if (!editing && e.key === "Enter" && e.target === rootRef.current) {
					e.preventDefault();
					onEdit();
				}
			}}
			className={cn(
				"group relative rounded-lg px-3 py-2 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
				editing ? "bg-accent/40" : "hover:bg-accent/20",
				!cell.publish && !editing && "opacity-70",
			)}
		>
			<div className="mb-1 flex select-none items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
				{editing ? (
					<select
						aria-label="Cell role"
						value={cell.role}
						onChange={(e) => void onCommit({ role: e.target.value as JournalCellRole })}
						className="rounded-sm border border-border bg-background px-1 py-0.5 text-[11px] uppercase tracking-wider"
					>
						{JOURNAL_CELL_ROLES.map((r) => (
							<option key={r} value={r}>
								{ROLE_LABEL[r]}
							</option>
						))}
					</select>
				) : (
					<span>{ROLE_LABEL[cell.role]}</span>
				)}
				{cell.origin && <span className="normal-case tracking-normal text-muted-foreground/60">from session</span>}
				<span className="flex-1" />
				<div className={cn("flex items-center gap-0.5", !editing && "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100")}>
					<IconButton label="Move up" disabled={index === 0} onClick={() => onMove(index - 1)}>
						<ArrowUpIcon className="size-3.5" />
					</IconButton>
					<IconButton label="Move down" disabled={index === count - 1} onClick={() => onMove(index + 1)}>
						<ArrowDownIcon className="size-3.5" />
					</IconButton>
					<IconButton label="Delete cell" onClick={onDelete}>
						<Trash2Icon className="size-3.5" />
					</IconButton>
				</div>
				<IconButton
					label={cell.publish ? "Published — click to keep private" : "Private — click to publish"}
					testid="journal-cell-publish"
					onClick={() => void onCommit({ publish: !cell.publish })}
				>
					{cell.publish ? <EyeIcon className="size-3.5 text-primary" /> : <EyeOffIcon className="size-3.5" />}
				</IconButton>
			</div>

			{editing ? (
				<div className="flex flex-col gap-2" onKeyDown={onKeyDown}>
					{cell.role === "code" && (
						<input
							aria-label="Language"
							value={lang}
							onChange={(e) => setLang(e.target.value)}
							placeholder="language (python, cpp, …)"
							className="lh-input w-48 border-0 border-b border-border bg-transparent px-0 font-mono text-xs outline-none"
						/>
					)}
					<textarea
						ref={sourceRef}
						aria-label={cell.role === "code" ? "Code" : "Cell text"}
						value={source}
						onChange={(e) => setSource(e.target.value)}
						placeholder={cell.role === "code" ? "code" : "Markdown — $math$ welcome"}
						className={cn(
							"field-sizing-content lh-input min-h-16 w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 outline-none",
							cell.role === "code" && "font-mono text-sm",
						)}
					/>
					{cell.role === "code" && (
						<textarea
							aria-label="Recorded output"
							value={output}
							onChange={(e) => setOutput(e.target.value)}
							placeholder="recorded output (optional, pasted)"
							className="field-sizing-content lh-input min-h-10 w-full resize-none rounded-md border border-dashed border-border bg-background px-2.5 py-2 font-mono text-xs outline-none"
						/>
					)}
					<div className="text-[11px] text-muted-foreground/70">Esc to render · Shift+Enter for a new cell</div>
				</div>
			) : (
				<div className={cn("cursor-text", ROLE_TONE[cell.role])} onClick={onEdit}>
					{rendered.trim() ? (
						<MessageResponse>{rendered}</MessageResponse>
					) : (
						<span className="text-sm italic text-muted-foreground/60">Empty — click to write</span>
					)}
				</div>
			)}
		</div>
	);
}

function IconButton({
	label,
	onClick,
	disabled,
	testid,
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	testid?: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			data-testid={testid}
			disabled={disabled}
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
		>
			{children}
		</button>
	);
}
