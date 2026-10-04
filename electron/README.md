# Stage desktop

The Electron shell loads the team-hosted Stage app and displays captions in a transparent native window above the selected screen. Presenters should start with the [installation and onboarding guide](../README.md#for-presenters).

## Development

Start the backend and Vite with `npm run dev`, then run `npm run desktop` in another terminal. The development default is `http://localhost:5173`. `STAGE_SERVER_URL` can override the server address for a local launch.

A packaged app asks for an HTTPS team server origin on first launch and stores the address as `connection.json` under Electron's application user-data directory. Credentials and paths are not accepted in this field. Team authentication uses the `persist:stage-team` partition. The **Change team server…** menu ends capture and opens the connection screen; it does not erase existing session storage. **Team connected** in the app disconnects the current session.

The desktop app has no bundled provider key. Its remote renderer can request microphone access for the configured team origin, subject to the operating system's permission. Other media and device permissions are denied. A narrow, validated IPC bridge updates a separate sandboxed caption renderer; that renderer has no network access or team credentials.

## Packaging

```sh
npm ci
npm run check
npm run desktop:package
```

The Electron Builder configuration targets Mac DMG/ZIP, Windows NSIS, and Linux AppImage/DEB, with x64 and ARM64 variants. Build on the corresponding operating system. Generated files go to `release/` and stay out of Git. Linux DEB builds need valid maintainer/homepage metadata; see the packaging configuration and release workflow for supplied values or environment overrides.

The [GitHub Actions workflows](../.github/workflows) build Mac ARM64/x64, Windows x64, and Linux x64 release artifacts. Windows ARM64 and Linux ARM64 are not part of the initial release matrix. Inspect the workflow run and release assets before telling users a particular installer is available. Signing and notarization require the maintainer's own credentials; without them the artifacts are unsigned pilot builds.

## Native checks and presentation limits

`npm run check` runs the web build and automated tests. On a graphical desktop, an additional check exercises the native overlay using a loopback fixture:

```sh
npx electron tests/desktop/native-smoke.cjs
```

This check uses a temporary profile, synthetic microphone permission, and no Soniox connection. It closes its fixture server and app when finished. Optional frontend and packaged-app smoke scripts also live in `tests/desktop`; inspect their inputs before running them.

The overlay follows the selected display and falls back to the primary display if it is removed. It passes clicks through to the presentation. **Cmd/Ctrl+Shift+H** toggles visibility without stopping audio; **Stop captions** or closing Stage ends capture.

Always test on the actual projector and presentation application. macOS Spaces, Windows fullscreen modes, and Linux window managers can behave differently. Wayland can restrict absolute positioning and always-on-top behavior; an X11 session may be necessary. An installer build or unit test does not establish compatibility with every fullscreen setup.

The bundled Noto Sans JP font is covered by the [SIL Open Font License](fonts/OFL.txt). The overlay does not fetch fonts over the network.
