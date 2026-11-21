---
name: notebook-video
description: Turn a Socratech learning notebook (notebook.md + media/) into one voiced explainer video with HyperFrames, unattended. The taste and the workflow for the "notebook visualizer". Edit this in Settings → Notebook video to change the look, the voice or add steps.
---

# Notebook video — taste and workflow

You are making ONE explainer video of the learner's notebook. The video should feel like a
3Blue1Brown / good YouTube explainer: one idea at a time, the picture carries the idea, the
voice explains *why*, not *what is on screen*.

## Inputs (already in this project)

- `notebook.md` — every cell of the notebook in order (markdown, code, agent answers).
  Cells marked `<!-- private -->` are the learner's own notes; use them for understanding and
  narration, but do not show raw personal text on screen verbatim.
- `media/` — images, videos and `*.html` interactive visuals the notebook embeds.
- `request.md` — present only on an update: what the learner wants changed. Do exactly that,
  keep everything else.

## Taste

- **Length:** about 30–45 seconds of narration per main idea; whole video 1–5 minutes.
  Skip filler cells. Merge cells that make one point.
- **Voice:** local Kokoro — `npx --yes hyperframes tts "<text>" -v am_michael -o assets/vo/<scene>.wav`.
  Warm, plain spoken English, short sentences, no "In this video". Speed 1.0.
- **Look:** dark stage `#14161b`, text `#e8e8e8`; colour carries meaning and stays consistent
  (blue `#58c4dd`, yellow `#f4d345`, green `#83c167`, red `#fc6255`, pink `#ff77b4`).
  Typeset maths with KaTeX. Large type (≥ 48px body at 1080p). One focal element per moment.
- **Motion:** everything that changes animates (eased 0.6–1.2 s). Build diagrams up in sync with
  the words that name them. No jump cuts between scenes; short crossfades or match moves.
- **Code cells:** show the few lines that matter, highlighted step by step; never a full screen dump.
- **Interactive visuals (`media/*.html`):** they are live pages, NOT seek-safe. Never iframe them.
  Read them for the idea and rebuild that idea as a HyperFrames scene.
- **Captions:** burn in short captions synced to the voiceover (one track).
- **Music:** none by default.

## Workflow

1. Read `notebook.md` and `request.md` (if any). Write `script.md`: scenes with narration text
   and what is on screen.
2. Voiceover per scene with Kokoro (above). Measure each clip with `ffprobe` and time scenes to it.
3. Build the composition (HyperFrames skills: `hyperframes`, `hyperframes-core`,
   `hyperframes-animation`, `hyperframes-creative`). 1920×1080, 30 fps.
4. `npx --yes hyperframes lint` and `npx --yes hyperframes check --json`; fix every error.
5. `npx --yes hyperframes snapshot` and LOOK at the PNGs; fix what looks wrong.
6. Render: `npx --yes hyperframes render --quality delivery -o renders/notebook.mp4`.
   Check with `ffprobe` that the duration matches the composition.
7. Finish with a 2–4 sentence summary of the video.

<!-- Add your own steps or rules below: e.g. an intro card, a different voice, music,
     a sign-off. They apply to every notebook video. -->
