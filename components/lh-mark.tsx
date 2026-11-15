"use client";

import { useId } from "react";

/**
 * LhMark — the Socratech app mark: a profile bust of Socrates (bald dome,
 * snub nose, curled beard). Inlined as JSX so it rides along with the
 * components (no network fetch, recolorable, crisp at any size).
 *
 * The detail lines are cut out through a mask, so the mark is a single
 * fill in the strong line ink (white in dark, the foreground in light) and
 * stays correct on any background — including the hover chip. Square
 * viewBox, no padding: sizing/padding is the consumer's job. Canonical
 * source: docs/assets/socratech-mark.svg (same paths).
 *
 * Name kept as LhMark: Socratech is a fork of LearnHarness, and the
 * export is imported by the sidebar band.
 */
export function LhMark({ className = "" }: { className?: string }) {
	const mask = `socratech-mark-${useId().replace(/:/g, "")}`;
	return (
		<svg viewBox="41 62 450 450" className={className} aria-hidden="true">
			<defs>
				<mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
					<path fill="#fff" d="M 112 512 C 122 470, 150 440, 160 400 C 150 385, 128 372, 130 350 C 108 340, 104 312, 122 298 C 100 282, 104 252, 128 244 C 112 220, 124 190, 150 186 C 150 118, 212 70, 288 70 C 356 70, 404 112, 406 176 C 407 196, 404 206, 410 216 C 414 224, 410 232, 402 238 C 398 244, 396 250, 400 258 C 412 266, 430 280, 428 296 C 426 309, 410 310, 400 305 C 406 313, 406 319, 402 325 C 416 337, 424 360, 416 384 C 422 404, 416 424, 402 436 C 402 456, 386 472, 366 476 C 352 492, 328 496, 308 488 C 298 498, 296 506, 298 512 Z" />
					<g fill="none" stroke="#000" strokeWidth={8} strokeLinecap="round">
					<path d="M 362 236 Q 377 228 394 234" />
					<path d="M 252 232 C 234 226, 224 244, 232 260 C 238 272, 252 272, 254 262" />
					<path d="M 244 284 C 252 304, 266 318, 286 326" />
					<path d="M 396 322 C 384 330, 368 330, 356 322" />
					<path d="M 330 330 C 322 352, 340 366, 330 388" />
					<path d="M 366 336 C 358 360, 376 374, 366 400" />
					<path d="M 300 344 C 292 372, 312 392, 300 420" />
					<path d="M 176 204 C 192 216, 194 234, 182 248" />
					<path d="M 166 274 C 182 286, 184 304, 172 318" />
					</g>
				</mask>
			</defs>
			<rect width="512" height="512" mask={`url(#${mask})`} style={{ fill: "var(--lh-line-strong)" }} />
		</svg>
	);
}

/**
 * The wordmark beside the mark: "Socratech" in the title serif, with a
 * small "by Thinking Humans" byline underneath.
 */
export function SocratechWordmark({ className = "" }: { className?: string }) {
	return (
		<span className={`flex flex-col leading-none ${className}`}>
			<span className="font-title text-[15px] tracking-tight text-foreground">Socratech</span>
			<span className="mt-0.5 text-[9px] uppercase tracking-[0.08em] text-muted-foreground">by Thinking Humans</span>
		</span>
	);
}
