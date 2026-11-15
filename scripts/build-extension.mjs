// Web clip (docs/web-clip.md): copy Readability into the Chrome extension
// so extensions/chrome/ loads unpacked as is.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "extensions", "chrome", "vendor");
fs.mkdirSync(vendor, { recursive: true });
for (const file of ["Readability.js", "LICENSE.md"]) {
	fs.copyFileSync(path.join(root, "node_modules", "@mozilla", "readability", file), path.join(vendor, file === "LICENSE.md" ? "Readability.LICENSE.md" : file));
}
console.log(`extension ready: ${path.relative(root, path.join(root, "extensions", "chrome"))}`);
