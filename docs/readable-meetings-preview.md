# Readable meetings and output layouts — local preview

This revision is on `codex/readable-meetings` in the isolated streaming worktree. It has not been pushed, released, or deployed. Production v0.1.4 and the installed Stage profile were left unchanged.

## What changes

- The top of Present now offers Over your apps, Separate caption window, and Slides + caption strip. Start/Stop/Rehearsal is also at the top.
- Separate caption window is a normal movable, resizable desktop window. Put it beside windowed content on a mirrored or extended screen. It cannot force an arbitrary fullscreen app to reserve desktop space.
- Slides + caption strip captures an explicitly selected local window or a different screen, fits it without cropping, and reserves top/bottom caption space on a separate extended display. Stage never sends these frames to its server or Soniox. Mirrored and single-display setups use the separate window instead, preventing screen recursion.
- Easy to read is the default audience mode: provider-final tokens, a 600 ms batching window, immutable two-line cards, lossless queued text, and exposure time adjusted for pending content. Live drafts remains available. The captions are processed continuously; the hold affects audience display. Pilot timings are not an end-to-end latency guarantee. Long bursts can build a visible backlog.
- Lines are sized for the selected output and font; unread cards can be rewrapped when these change. Visible lines stay fixed. Narrow windows fit long lines without deleting text. The audience preview scales down the output layout.
- Finalized source and translation tokens are saved separately and completely on the team server. Clear captions and automatic caption expiry do not erase the meeting. Stage does not store microphone audio. All team-code holders can read and export meeting history.
- An IndexedDB outbox preserves exact immutable requests across retries and reloads. A previous unfinished meeting is marked interrupted on recovery, after its pending transcript batches. One recorder tab per browser profile avoids competing recovery writers. Uploads have a 15-second deadline and retry every five seconds. Storage failures are shown explicitly; keep the app open while saving is pending. Unfinalized recognition hypotheses are not a durable verbatim recording.
- Mark moment saves a bookmark while speech continues. Meeting history supports search, bookmark navigation, full Markdown/JSON export, and a complete summary brief.
- On a configured owner computer, Summarize on this Mac invokes a local OMP SDK worker. Personal auth remains in the OMP-managed store; no OAuth tokens are sent to the team server. The worker cannot run tools, discover project instructions, load MCPs, or use a fallback model. Claims must cite saved transcript entries. Large meetings are chunked and reduced without silently truncating the input. Summary text is an AI draft and remains local in the current view.

## Run the isolated preview

Build the client with `VITE_STAGE_PREVIEW=true npm run build`.

Run the local server with `PORT=4318 HOST=127.0.0.1 PUBLIC_ORIGIN=http://127.0.0.1:4318 DATABASE_PATH=work/preview-readable/stage.db TEAM_ACCESS_CODE=stage-preview-only SONIOX_API_KEY= node server/index.mjs`.

Then run `npm run desktop:preview`. Its profile is in `work/desktop-preview`, not the installed Stage profile. The preview URL is http://127.0.0.1:4318/ and its fixture-only access code is `stage-preview-only`. No live Soniox credential is configured in this preview; use rehearsal to assess the layout. A labeled sample bilingual meeting is available for history/summary checks.

The optional worker is documented in [tools/summary-worker/README.md](../tools/summary-worker/README.md). This Mac has an isolated Bun 1.3.14 runtime and pinned OMP 18.6.1 SDK. Ignored local `work/summary-runtime/preview-config.json` selects these paths and `gpt-6-sol`; it contains no credentials. Other team computers do not receive the owner's summary capability.

## Validation and limits

Automated coverage includes late and revised translations, large bursts, explicit clearing, language switches, resizing, exact batch retries, concurrent append/start, storage failures, whole-meeting persistence, authentication/origins, source picker permission grants, capture teardown/retry, and summary subprocess/evidence validation.

A real macOS native smoke checked movable/resizable output, preserved bounds, overlay switching, and caption fitting at 96 px in a narrow window. Browser checks covered rehearsal, visible layout controls, transcript search, and marked-moment navigation.

One end-to-end summary request through the native runner and the actual local OMP/Codex integration succeeded on a synthetic six-entry English/Japanese meeting. It used `gpt-6-sol` and returned five evidence-linked claims; it did not process a real meeting. This checks current integration, not general summary accuracy or future account entitlement.

Remaining acceptance checks: an actual extended projector and OS capture permission, real English/Japanese speakers and accents, slow venue networking, and reader feedback on the 600 ms display buffer. Desktop capture has lifecycle fixture coverage, not a physical-projector result. The new desktop modes require a future installer/release before other team computers receive them.
