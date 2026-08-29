# README media

Everything the README shows is generated from a real session. Nothing here is a mock-up, and the
rule is enforceable rather than aspirational: `transcript.txt` is the raw capture, so any line in
the hero animation can be traced back to output a command actually produced.

## transcript.txt

One session, captured with `NO_COLOR=1`:

```console
orca record claude -- --permission-mode acceptEdits -p "Reject tokens shorter than 8 characters in auth.ts. Edit the file."
orca replay last
orca compare <run> --from 4 --models claude-sonnet-5,claude-haiku-4-5-20251001 --verify "npx tsc --noEmit auth.ts"
```

## demo-cli.gif

```console
npm i --no-save playwright-core pngjs gifenc
node scripts/render-demo.mjs
```

The three packages are deliberately **not** in `package.json`. They are needed only to redraw
README art, and everyone who runs `npm ci` to work on OrcaReplay itself should not pay for them.

Note that the ffmpeg shipped with Playwright cannot do this job — it is stripped to what Playwright
needs for video capture and has neither a PNG decoder nor a GIF muxer, so it fails at both ends of
the pipeline. The encoder in `render-demo.mjs` is pure JavaScript for that reason.

## demo-viewer.gif, viewer-timeline.png, compare-card.png

Captured from the real viewer, driven in the same browser:

```console
orca ui <run> --port 8821          # in one shell
```

then a Playwright script that steps the selection with `ArrowDown`, types into `#orca-filter`, and
screenshots one frame per state change — the same one-frame-per-state approach `render-demo.mjs`
uses, because 100 near-identical frames cost megabytes and say nothing extra.

`compare-card.png` is `orca compare --share`, rendered from its SVG.

## Keeping them honest

If output format changes, these go stale silently — a GIF has no test. When you change what a
command prints, re-record the session and regenerate, or delete the asset. A README that shows
output the tool no longer produces is worse than one with no picture at all.
