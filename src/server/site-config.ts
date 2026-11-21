/**
 * Site-config preflight for publishing (owner, 2026-11-22).
 *
 * Interactive visuals publish as full HTML documents in <bundle>/media/*.html,
 * embedded by <iframe>. Hugo treats every .html under content/ as a content
 * page and refuses it ("text/html" is not whitelisted in policy
 * "security.allowContent"), so the site build fails. The fix is site-side:
 * module mounts that keep those files out of content and serve them as
 * static files at the same path, so the bundle stays self-contained.
 *
 * hugoHtmlMediaFix(siteRepo) decides what a publish carrying .html media
 * needs: nothing (not a Hugo site, or already configured), a patched
 * hugo.toml committed together with the bundle, or a blocker with the
 * snippet to add by hand when the config can't be patched safely.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Marker for "already configured": the include glob of the static mount. */
const MEDIA_GLOB = "**/media/*.html";

/** Module mounts in TOML. `files` needs Hugo >= 0.153 (it replaced
 *  includeFiles/excludeFiles). Declaring mounts replaces Hugo's defaults,
 *  so content and static are declared again. */
export const HUGO_HTML_MEDIA_MOUNTS = `# Socratech journal bundles carry interactive visuals as full HTML documents
# (<bundle>/media/*.html, embedded via <iframe>). Hugo refuses .html under
# content/ ("text/html" is not in security.allowContent), so serve them as
# static files at the same path. Declaring mounts replaces the defaults, so
# content and static are re-declared. \`files\` needs Hugo >= 0.153.
[module]
  [[module.mounts]]
    source = "content"
    target = "content"
    files = ["! ${MEDIA_GLOB}"]
  [[module.mounts]]
    source = "static"
    target = "static"
  [[module.mounts]]
    source = "content"
    target = "static"
    files = ["${MEDIA_GLOB}"]
`;

/** Hugo's config file names, in its own lookup order. */
const CONFIG_FILES = ["hugo.toml", "hugo.yaml", "hugo.yml", "hugo.json", "config.toml", "config.yaml", "config.yml", "config.json"];

export type HugoHtmlMediaFix =
	/** Nothing to do: not a Hugo site, or the mounts are already there. */
	| { kind: "none" }
	/** Write `content` to `name` (relative to the site repo) and commit it with the bundle. */
	| { kind: "patch"; name: string; content: string }
	/** Can't patch safely; a user-facing sentence with the snippet. */
	| { kind: "blocker"; message: string };

function readIfExists(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
}

export function hugoHtmlMediaFix(siteRepo: string): HugoHtmlMediaFix {
	const manual = (why: string): HugoHtmlMediaFix => ({
		kind: "blocker",
		message:
			`This journal publishes interactive visuals (media/*.html), which Hugo refuses under content/. ${why} ` +
			`Add these module mounts to the site's Hugo config by hand, then publish again:\n\n${HUGO_HTML_MEDIA_MOUNTS}`,
	});

	const name = CONFIG_FILES.find((f) => fs.existsSync(path.join(siteRepo, f)));
	const configDir = path.join(siteRepo, "config", "_default");
	if (!name) {
		if (fs.existsSync(configDir)) {
			const dirHasFix = fs.readdirSync(configDir).some((f) => readIfExists(path.join(configDir, f))?.includes(MEDIA_GLOB));
			return dirHasFix ? { kind: "none" } : manual("The site keeps its config in config/_default/, which Socratech doesn't edit.");
		}
		return { kind: "none" }; // not a Hugo site
	}

	const text = readIfExists(path.join(siteRepo, name)) ?? "";
	if (text.includes(MEDIA_GLOB)) return { kind: "none" };
	if (!name.endsWith(".toml")) return manual(`The site's ${name} isn't TOML, which Socratech doesn't edit.`);
	// An existing [module] table (or its mounts) can't take a second one.
	if (/^\s*\[\[?module[.\]]/m.test(text)) return manual(`${name} already has a [module] section, which Socratech doesn't merge into.`);
	const sep = text.length === 0 || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
	return { kind: "patch", name, content: `${text}${sep}${HUGO_HTML_MEDIA_MOUNTS}` };
}
