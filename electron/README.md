# Stage desktop

The Electron shell loads the team-hosted Stage app and displays captions in a transparent native window above the selected screen. Presenters should start with the [installation and onboarding guide](../README.md#for-presenters).

## Development

Start the backend and Vite with `npm run dev`, then run `npm run desktop` in another terminal. The development default is `http://localhost:5173`. `STAGE_SERVER_URL` can override the server address for a local launch.

A packaged app asks for an HTTPS team server origin on first launch and stores the address as `connection.json` under Electron's application user-data directory. Credentials and paths are not accepted in this field. Team authentication uses the `persist:stage-team` partition. The **Change team server…** menu ends capture and opens the connection screen; it does not erase existing session storage. **Team connected** in the app disconnects the current session.

The desktop app has no bundled provider key. Its remote renderer can request microphone access for the configured team origin, subject to the operating system's permission. Other media and device permissions are denied in the hosted renderer. Presentation capture is available only in the separate local picker, subject to system screen recording permission. A narrow, validated IPC bridge updates a separate sandboxed caption renderer; that renderer has no network access or team credentials.

## Packaging

```sh
npm ci
npm run check
npm run package:desktop
```

The Electron Builder configuration targets Mac DMG/ZIP, Windows NSIS, and Linux AppImage/DEB. Build on the corresponding operating system; the release workflow selects each architecture explicitly. Generated files go to `release/` and stay out of Git. Linux x64 files use the target format's architecture name: `Stage-<version>-linux-x86_64.AppImage` and `Stage-<version>-linux-amd64.deb`. Linux DEB builds need valid maintainer/homepage metadata; see the packaging configuration and release workflow for supplied values or environment overrides.

The [GitHub Actions workflows](../.github/workflows) build Mac ARM64/x64, Windows x64, and Linux x64 release artifacts. Windows ARM64 and Linux ARM64 are not part of the initial release matrix. Inspect the workflow run and release assets before telling users a particular installer is available.

Mac pilot builds are ad-hoc signed (`identity: '-'`), with strict verification and hardened runtime enabled. Ad-hoc signatures have no certified Team ID, so the pilot entitlements include `disable-library-validation` for Electron's nested libraries. This preserves the other hardened-runtime protections and Electron's renderer sandbox, but relaxes the same-Team-ID library restriction. Remove that exception when all nested code can be signed with our Developer ID. Ad-hoc signing seals the bundle; it does not make a downloaded app trusted by Gatekeeper. Windows pilot installers remain unsigned.

The Mac release gate verifies the built app, the app mounted read-only from the DMG, and the app extracted from the ZIP. It checks strict signatures, resource seals, Stage's bundle identifier and version, plus the DMG checksum before a separate startup smoke test. To run it locally after packaging:

```sh
node tests/desktop/mac-distribution-check.mjs release/mac-arm64/Stage.app release/Stage-0.1.2-mac-arm64.dmg release/Stage-0.1.2-mac-arm64.zip
```

Smooth public Mac distribution requires the maintainer's Apple Developer ID certificate and notarization credentials. That future configuration must sign all nested code with the same identity, retain hardened runtime, notarize and staple the app, and set `STAGE_REQUIRE_NOTARIZATION=1` on the distribution gate. That mode additionally requires Developer ID, Gatekeeper acceptance, and a stapled ticket; the pilot gate makes none of those claims.

## Native checks and presentation limits

`npm run check` runs the web build and automated tests. On a graphical desktop, an additional check exercises the native overlay using a loopback fixture:

```sh
npx electron tests/desktop/native-smoke.cjs
```

This check uses a temporary profile, synthetic microphone permission, and no Soniox connection. It closes its fixture server and app when finished. Optional frontend and packaged-app smoke scripts also live in `tests/desktop`; inspect their inputs before running them.

The overlay follows the selected display and falls back to the primary display if it is removed. It passes clicks through to the presentation. **Cmd/Ctrl+Shift+H** toggles visibility without stopping audio; **Stop captions** or closing Stage ends capture.

Always test on the actual projector and presentation application. macOS Spaces, Windows fullscreen modes, and Linux window managers can behave differently. Wayland can restrict absolute positioning and always-on-top behavior; an X11 session may be necessary. An installer build or unit test does not establish compatibility with every fullscreen setup.

The bundled Noto Sans JP font is covered by the [SIL Open Font License](fonts/OFL.txt). The overlay does not fetch fonts over the network.


## Caption output modes

The API v2 desktop bridge supports `overlay`, `window`, and `presentation` through the optional `outputMode` setting. An omitted mode preserves the original floating overlay. `getCapabilities()` advertises supported modes; hosted UI must offer an update message when it runs in older desktop builds.

- **Overlay:** the original click-through floating captions. It can cover content; it does not reserve space inside another app.
- **Window:** an ordinary movable, resizable caption window for positioning beside windowed slides or apps, including a mirrored projector. Font and language changes preserve manual window bounds. Selecting a different display resets its placement.
- **Presentation:** a Stage-owned fullscreen output for an extended display. A trusted local picker asks the presenter to choose a window or control screen. The captured video uses `object-fit: contain` and a separate top/bottom caption row, so captions never cover the captured content. The original app remains the control surface. Stage does not remote-control it or alter its fullscreen layout.

The picker enumerates sources only after its local button is pressed. Stage windows, the output screen, screens with unknown display IDs, and mirrored/overlapping screens are excluded where detectable. Keep a selected application window on the control screen and leave it visible; operating systems can pause capture of minimized or protected windows. Presentation mode requires independent display coordinates. **Escape**, selecting another source, losing the output display, closing output, and closing Stage stop that capture. Hiding output with the caption shortcut preserves the selected stream until it is stopped or closed.

Capture uses a separate in-memory session with a one-use selected-source grant, an exact local top-level sender check, and video only. Source names and MediaStreams stay out of the hosted renderer and backend. Its local CSP denies network connections. The system permission and platform behavior still need a rehearsal on the actual projector; automated fixtures do not establish that compatibility.

Optional `stableLines` captions occupy two fixed rows and scale both rows together to fit a narrow output window. They do not rewrap or scroll. Legacy caption payloads retain their existing renderer behavior.

The native implementation follows Electron's [display-capture request handler](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts), [desktop source enumeration](https://www.electronjs.org/docs/latest/api/desktop-capturer), and [source/display ID contract](https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source). The custom local picker deliberately preserves the exact selected-source checks instead of using the experimental system-picker bypass.

## Local meeting exports and optional summaries

`saveMeetingExport({filename, text, format})` opens a native Save dialog for JSON or Markdown, with a 20 MB text limit. The remote renderer cannot provide a filesystem path. This supports exports while general downloads remain blocked.

An optional owner-local summary worker is configured before launching Stage with `STAGE_SUMMARY_WORKER` (absolute `.mjs` file) and `STAGE_SUMMARY_RUNTIME` (absolute executable named `bun` or `bun.exe`). `STAGE_SUMMARY_MODEL` may name the locally configured model. Nothing is enabled by default, installed, authenticated, or sent to a model by opening Stage. `getCapabilities().summaryWorker` reports whether those local executable paths exist; it does not verify model access or login.

`summarizeMeeting(export)` validates the complete meeting, sequential transcript entries, and bookmarks, then sends only that JSON to the worker's stdin. The bridge uses no shell, strips inherited API keys and runtime injection variables, and preserves `HOME` for the worker's existing owner-local OMP authentication. Auth files are never read by this bridge or returned to the hosted app. The worker is intended for the owner's Mac, not a shared VPS account.

One summary may run at a time. Input is limited to 20 MB/100,000 entries, output to 1 MB, and execution to ten minutes. `cancelSummary()`, changing the team server, or closing Stage terminates it. Stderr is discarded; returned errors are generic and recoverable. Successful claims must cite IDs in the submitted transcript. Synthetic tests cover these limits and cancellation; no live model call is part of the desktop suite.
