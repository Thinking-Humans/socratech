/**
 * The surfaces that hardcoded dark (light-mode wave, 2026-10-29): each now
 * reads the active palette or the rendered mode.
 */

import React from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { confidenceRailStyle } from "../components/confidence-rail.tsx";
import { mermaidConfig } from "../components/mermaid-render.ts";
import { CLUSTER_LIGHTNESS } from "../components/graph-canvas.ts";
import { LhMark } from "../components/lh-mark.tsx";

describe("confidence rail", () => {
	it("sits on the page background, ticks in the foreground ink", () => {
		const style = confidenceRailStyle(50);
		assert.equal(style.backgroundColor, "var(--background)");
		const tick = "color-mix(in oklab, var(--foreground) 35%, transparent)";
		assert.ok(String(style.backgroundImage).includes(`linear-gradient(90deg, ${tick}, ${tick})`));
		assert.ok(!String(style.backgroundImage).includes("rgba(230,230,230"));
	});
});

describe("mermaid", () => {
	it("dark mode renders mermaid's dark theme, light its default", () => {
		assert.equal(mermaidConfig("dark").theme, "dark");
		assert.equal(mermaidConfig("light").theme, "default");
		assert.equal(mermaidConfig("light").securityLevel, "strict");
	});
});

describe("graph clusters", () => {
	it("dark keeps today's lightness; light darkens rings and labels", () => {
		assert.deepEqual(CLUSTER_LIGHTNESS.dark, { ring: 60, label: 78 });
		assert.ok(CLUSTER_LIGHTNESS.light.ring < CLUSTER_LIGHTNESS.dark.ring);
		assert.ok(CLUSTER_LIGHTNESS.light.label < CLUSTER_LIGHTNESS.dark.label);
	});
});

describe("Socratech mark", () => {
	it("one fill in the strong line ink; the details are mask cut-outs, unique per instance", () => {
		const html = renderToStaticMarkup(<><LhMark /><LhMark /></>);
		assert.equal((html.match(/fill:var\(--lh-line-strong\)/g) ?? []).length, 2);
		const ids = [...html.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]!);
		assert.equal(ids.length, 2);
		assert.notEqual(ids[0], ids[1]);
		for (const id of ids) assert.ok(html.includes(`url(#${id})`), id);
	});
});
