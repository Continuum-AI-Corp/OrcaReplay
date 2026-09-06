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

## graph-card.png, chain-card.png

```console
npm i --no-save playwright-core pngjs gifenc
npm run build && node scripts/render-cards.mjs
```

Both come out of a real recording rather than a drawing. The script stands up a model stub, records
a real child process through the real proxy and the real PATH shim, and then runs exactly the two
commands the README tells everyone else to run — `orca export last --graph-card` and `--card`. The
agent edits a file, runs a check through a tool call, and finishes although the check exited 1,
which is the bug hunt the README describes.

The model stub lives in the script, not in `packages/cli/test/fixtures`, so README art never
constrains a test fixture or the other way round. The three render packages are the same optional
ones `demo-cli.gif` needs, for the same reason.

## Keeping them honest

If output format changes, these go stale silently — a GIF has no test. When you change what a
command prints, re-record the session and regenerate, or delete the asset. A README that shows
output the tool no longer produces is worse than one with no picture at all.

## sync-transcript.txt — the push/pull card

`docs/sync-card.png` is rendered from `sync-transcript.txt` by
`scripts/render-sync-card.mjs`. The transcript is a real round trip, captured with `NO_COLOR=1`:

1. `orca record -- node packages/cli/test/fixtures/fake-agent.mjs` in a scratch workspace, which
   produces a genuine run (`run_e727598b1469`, 10 events, 3 blobs).
2. `orca push <run>` against a local stub that speaks the gateway's two endpoints —
   `POST /api/replay/runs` (multipart, field `file`) and
   `GET /api/replay/runs/:key/export`. The stub keeps the uploaded zip and returns it verbatim on
   export, so the pull below reads exactly the bytes the push sent.
3. `orca pull <run>` in a **second, empty** workspace.
4. `orca show <run>` there, reading the pulled copy rather than the original.

The gateway address in the transcript is therefore a loopback one, and is left as the command
printed it.

`orca show`'s output is trimmed to 104 columns at capture time — the same rule `render-demo.mjs`
states for the hero animation, "trimmed for width and nothing else". The DETAIL column is as wide as
the tool call it reports, and one `Bash` invocation here carries a full JSON argument, which alone
would have made the card 3050px wide and unreadable in a README. Nothing is reworded, no line is
dropped, and the trim happens in the capture rather than the renderer so the file on disk is exactly
what the card shows.

To regenerate after a change to either command's output:

```console
npm run build
npm i --no-save playwright-core
node scripts/render-sync-card.mjs
```

Re-capture the transcript itself only when the output genuinely changes — the card is evidence, and
a transcript edited to match a nicer story is worth less than no card at all.
