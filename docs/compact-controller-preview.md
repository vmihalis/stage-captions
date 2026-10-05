# Compact controller

The v0.1.6 desktop app adds the small native floating remote and separate workspace. Both the hosted app and desktop installer must be updated to use them. The compact controller does not require changes to the speech API or production database. The local preview validation recorded below is separate from release packaging and deployment verification.

## Interaction

The presenter gets a small floating remote with a start/pause button, session status, language direction, output controls, a bookmark, and an overflow menu. Settings open beneath the remote. Meetings, vocabulary, and help open in a separate workspace without acquiring the microphone or meeting-recorder lock.

- **Pause / Resume** keeps the same meeting and speech session. New audio is not transmitted while paused; previously sent speech can finish translating. The microphone stream remains allocated, so the operating system's microphone indicator and provider session charges may continue. End the meeting to release the microphone.
- **Hide captions** changes output visibility while keeping translation and presentation capture running.
- **Hide remote** hides only the controls. On desktop, restore them from Stage's menu-bar/system-tray icon or **Cmd/Ctrl+Shift+B**. **Cmd/Ctrl+Shift+H** still toggles caption output.
- **End & save** finishes speech and saves the transcript. Pending saves and recoverable errors remain visible in the remote.

Language direction, microphone selection, caption layout, reading mode, and font preferences persist locally. Team codes and speech keys are not stored in those preferences. The desktop also remembers the remote's position and clamps it to connected displays.

The browser shows the same controls but cannot become a native floating remote. Older desktop shells show update guidance and need v0.1.6 for the compact native window and separate workspace integration. The output icon offers **Overlay**, **Window**, and **Slides + strip**. **⋯** opens Settings, Meetings, Vocabulary, Rehearse, and End & save; those last controls appear as appropriate for the session state.

## Try locally

Use the [isolated preview setup](readable-meetings-preview.md#run-the-isolated-preview), build with `VITE_STAGE_PREVIEW=true npm run check`, and launch `npm run desktop:preview`. The local server at `http://127.0.0.1:4318/` uses the fixture-only team code `stage-preview-only`; no live Soniox key is configured. Use **Rehearse** for interaction checks.

The preview uses its own desktop profile under `work/desktop-preview`. Testing or closing that preview does not replace the installed Stage app or restart the team service.

## Recorded local preview validation

- `VITE_STAGE_PREVIEW=true npm run check`: build and all 138 tests passed.
- Extended native smoke passed with a synthetic microphone: compact sizing and position recovery, hide/close without ending audio, caption visibility preservation, workspace permissions, summary ownership, and connection cleanup.
- Actual browser checks covered 320 px layouts, typed font persistence, Escape/focus return, rehearsal pause/resume/end, and an empty error console.
- Actual desktop checks covered the small window, expanded settings, separate meeting history, shared fixture login, retained vocabulary drafts, synchronized workspace navigation, and shortcut recovery while the preview workspace was fullscreen.

No real microphone or Soniox stream was used in these checks. Windows, Linux, other fullscreen presentation apps, and physical mirrored/extended projectors still need presenter rehearsal before an event. At the end of these checks, the test profile was idle, with sample output hidden. These results do not establish live translation accuracy or physical projector compatibility.
