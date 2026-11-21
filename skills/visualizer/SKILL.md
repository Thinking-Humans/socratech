---
name: visualizer
description: Build a 3Blue1Brown-style interactive visual explanation of one idea as a single self-contained HTML file (Canvas 2D or SVG, vanilla JS). Use when a notebook cell, concept, formula, algorithm or proof should be made intuitive with animation, geometry and direct manipulation rather than text.
---

# 3Blue1Brown-style visualizer

You turn ONE idea into a short, beautiful, interactive visual explanation in the spirit of
3Blue1Brown: the learner should *see why* it is true, not be told. The visual replaces a
paragraph of prose with a picture that moves.

## The look

- Dark stage: background `#14161b` (near black, slightly blue). Text `#e8e8e8`, muted text `#9aa0a6`.
  The whole document is dark — body, controls, captions. No white panels.
- Colour carries meaning. Give each quantity ONE colour and keep it everywhere: in the geometry,
  in the formula, in labels, in slider names. Palette (3b1b-like):
  blue `#58c4dd`, yellow `#ffff00`/`#f4d345`, green `#83c167`, red `#fc6255`, pink `#ff77b4`,
  teal `#5cd0b3`, orange `#ff862f`, purple `#9a72ac`, grey `#888`.
- Thin, crisp strokes (2–3px at devicePixelRatio), soft glow optional, rounded line caps.
  Grids and axes faint (`#ffffff1a`), the thing being explained bright.
- Math is typeset: load KaTeX from `https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/` (css + js)
  and render formulas with `katex.render`. Colour terms with `\color{#58c4dd}{x}` to match the picture.
  If KaTeX fails to load, fall back to plain text — never throw.
- Typography: one clean sans (system-ui) for captions, generous spacing, few words.
- Canvas is HiDPI: scale the backing store by `devicePixelRatio` and redraw on resize.
  Fill the available width; height ≈ 0.6 × width (min 320px, max 80vh).

## The motion

- Everything that changes, animates. Interpolate with smooth easing
  (`t => t<.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2`), 0.6–1.2 s per transition, via
  `requestAnimationFrame`. Never jump-cut between states.
- Morph, don't replace: a shape that becomes another shape transforms in place; a term in a formula
  that corresponds to a length *is visibly the same colour* while it grows.
- Use motion to show *dependency*: drag one thing, everything that depends on it updates live.

## The story

- Structure as 3–7 **scenes**, each one idea, building from the concrete case to the general
  statement. Scene 1 is the most concrete, smallest example possible.
- Each scene has a one-line caption (≤ 20 words) and optionally one formula.
- Controls: `◀ Prev`, `Next ▶`, a scene indicator (`2 / 5`), and `▶ Play` that auto-advances.
  Keyboard: ←/→ change scene, Space toggles play. Transitions between scenes animate.
- Add direct manipulation where it builds intuition: draggable points/handles, and sliders for
  parameters with live numeric readouts in the parameter's colour. Every control labelled.
- End on the "aha": the final scene shows the general result with the picture that makes it obvious.
- Never fake the maths. Compute the real thing (numerically if needed). If the idea is not
  geometric, find the honest picture: number lines, area models, state diagrams, step-by-step
  data structures, probability as area, transformations of a grid, flows of a process.

## Runtime contract (the document runs in a sandboxed iframe)

- One self-contained HTML document; all JS inline. CDN imports only from cdn.jsdelivr.net,
  and only when they genuinely help (KaTeX is the expected one).
- `sandbox="allow-scripts"`, opaque origin: NO localStorage, sessionStorage, cookies, alerts,
  popups, top navigation, or fetches to the app.
- The parent sizes the iframe to the document height; make the layout flow normally and do not
  rely on `100vh` for the main stage height.
- No console errors, no uncaught exceptions, no failed requests — the build is tested headlessly
  and rejected otherwise.
