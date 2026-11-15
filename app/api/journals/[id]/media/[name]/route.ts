/**
 * GET /api/journals/[id]/media/[name] — a stored image / video. Honors a
 * single byte Range so video seeking works.
 */
import fs from "node:fs";
import { Readable } from "node:stream";
import { mediaContentType } from "@/src/core";
import { journalMediaFile } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; name: string }> };

export async function GET(req: Request, { params }: Ctx) {
	const { id, name } = await params;
	const file = journalMediaFile(id, name);
	if (!file) return new Response("Not found", { status: 404 });
	const size = fs.statSync(file).size;
	const headers: Record<string, string> = {
		"content-type": mediaContentType(name),
		"accept-ranges": "bytes",
		"cache-control": "private, max-age=31536000, immutable",
		// SVG may carry script: never let it run as a document.
		"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
		"x-content-type-options": "nosniff",
	};
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
	if (range && (range[1] || range[2])) {
		let start = range[1] ? Number(range[1]) : size - Number(range[2]);
		let end = range[1] && range[2] ? Number(range[2]) : size - 1;
		start = Math.max(0, start);
		end = Math.min(size - 1, end);
		if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
		const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
		return new Response(body, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
	}
	const body = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
	return new Response(body, { headers: { ...headers, "content-length": String(size) } });
}
