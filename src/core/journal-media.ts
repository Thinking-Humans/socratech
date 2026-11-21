/**
 * Journal media embeds (owner, 2026-11-15): images and videos attached to
 * markdown cells. A cell refers to one as `![alt](media/<name>)` on its own
 * line — the same relative path the published bundle uses (the files land
 * in `<bundle>/media/`), so the text never needs rewriting for the blog.
 * Videos use the image syntax in the journal; the exporter turns them into
 * `<video>` tags (the blog renders raw HTML).
 */

export const MEDIA_DIR = "media";
export const MAX_MEDIA_BYTES = 500 * 1024 * 1024;

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"];
const VIDEO_EXT = ["mp4", "webm", "mov", "m4v", "ogv"];
/** Generated interactive visuals (V on a cell): self-contained HTML, drawn in
 *  a sandboxed iframe — never uploaded, so not in isMediaName / MEDIA_ACCEPT. */
const VISUAL_EXT = ["html"];

const ext = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();
export const isImageName = (name: string) => IMAGE_EXT.includes(ext(name));
export const isVideoName = (name: string) => VIDEO_EXT.includes(ext(name));
export const isMediaName = (name: string) => isImageName(name) || isVideoName(name);
export const isVisualName = (name: string) => VISUAL_EXT.includes(ext(name));

export const MEDIA_ACCEPT = [...IMAGE_EXT, ...VIDEO_EXT].map((e) => `.${e}`).join(",");

const CONTENT_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	avif: "image/avif",
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	ogv: "video/ogg",
	html: "text/html; charset=utf-8",
};
export const mediaContentType = (name: string) => CONTENT_TYPES[ext(name)] ?? "application/octet-stream";

/** A stored media name: lowercase words + a short unique tag + the extension. */
export function mediaFileName(original: string, tag: string): string {
	const e = ext(original);
	const base =
		original
			.replace(/\.[^.]*$/, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "media";
	return `${base}-${tag}.${e}`;
}

/** A safe stored name (no paths, a known media extension). */
export const isSafeMediaName = (name: string) => /^[a-z0-9][a-z0-9-]*\.[a-z0-9]+$/.test(name) && (isMediaName(name) || isVisualName(name));

/** The markdown a cell gets for an uploaded file. */
export function mediaMarkdown(name: string, alt = ""): string {
	return `![${alt.replace(/[[\]]/g, "")}](${MEDIA_DIR}/${name})`;
}

const MEDIA_REF_RE = /!\[([^\]]*)\]\(media\/([a-z0-9][a-z0-9-]*\.[a-z0-9]+)\)/g;

/** Every media name a text refers to. */
export function mediaRefs(text: string): string[] {
	return [...text.matchAll(MEDIA_REF_RE)].map((m) => m[2]!).filter(isSafeMediaName);
}

/** A whole-line embed of this journal's media → alt, name, kind. The app
 *  draws these itself (same-origin files only); markdown rendering keeps
 *  blocking images, so model output can never load a remote one. */
export function mediaEmbedLine(line: string): { alt: string; name: string; kind: "image" | "video" | "visual" } | null {
	const m = /^\s*!\[([^\]]*)\]\(media\/([a-z0-9][a-z0-9-]*\.[a-z0-9]+)\)\s*$/.exec(line);
	if (!m || !isSafeMediaName(m[2]!)) return null;
	return { alt: m[1]!, name: m[2]!, kind: isVideoName(m[2]!) ? "video" : isVisualName(m[2]!) ? "visual" : "image" };
}

/** A whole-line video embed (the exporter turns these into <video> tags). */
export function videoEmbedLine(line: string): { alt: string; name: string } | null {
	const e = mediaEmbedLine(line);
	return e?.kind === "video" ? { alt: e.alt, name: e.name } : null;
}

/** The app's URL for a stored media file. */
export const journalMediaUrl = (journalId: string, name: string) => `/api/journals/${encodeURIComponent(journalId)}/media/${name}`;

/** Published form: video embeds become `<video>` tags, visuals sandboxed
 *  `<iframe>`s; images stay markdown. */
export function publishedMediaMarkdown(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			const e = mediaEmbedLine(line);
			if (e?.kind === "visual") {
				const title = e.alt ? ` title="${e.alt.replace(/"/g, "&quot;")}"` : "";
				return `<iframe src="${MEDIA_DIR}/${e.name}" sandbox="allow-scripts" loading="lazy"${title} style="width:100%;height:36rem;border:0;border-radius:8px"></iframe>`;
			}
			const v = videoEmbedLine(line);
			if (!v) return line;
			const label = v.alt ? ` aria-label="${v.alt.replace(/"/g, "&quot;")}"` : "";
			return `<video controls preload="metadata" src="${MEDIA_DIR}/${v.name}"${label}></video>`;
		})
		.join("\n");
}
