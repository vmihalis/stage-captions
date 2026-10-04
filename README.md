# Stage

Live English → Japanese subtitles for presentations. The desktop app places a caption overlay above your slides, browser, and other apps on the screen you choose.

**[Download the latest release](https://github.com/vmihalis/stage-captions/releases/latest)** · [All releases](https://github.com/vmihalis/stage-captions/releases) · [Host a team server](deploy/README.md)

## For presenters

Your organizer provides a **team server address** and a **shared team access code**. You do not need a Soniox account, API key, VPN, or individual Stage account.

1. Download the installer for your computer from the [latest release](https://github.com/vmihalis/stage-captions/releases/latest). On Mac, unzip Stage and move it to Applications, or install from the DMG. On Windows, run the installer. On Linux, install the DEB or make the AppImage executable and run it.
2. Open **Stage**. Enter the **Team server address** supplied by your organizer, such as `https://captions.example.com`, and choose **Connect to Stage**.
3. Choose **Connect team** and enter the shared access code.
4. Select your microphone, choose **Check mic**, and allow microphone access when prompted. This short microphone check stays on your computer.
5. Under **Caption output**, select the display connected to the projector. Choose **Open caption window** and adjust text size and position.
6. Choose **Start captions**, speak English, and switch to your presentation. Japanese subtitles appear in the overlay.

Try **Run a rehearsal** first to check placement without using a microphone or translation account. Then rehearse with a real speaker and the actual projector to check accuracy and delay.

The overlay lets clicks pass through to the app underneath. **Cmd+Shift+H** on Mac or **Ctrl+Shift+H** on Windows/Linux hides or shows captions. Hiding keeps listening; choose **Stop captions** to stop translation. Closing Stage also ends capture.

The website is a browser preview with a separate caption window. Install the desktop app for the floating overlay. A team connection lasts seven days; click **Team connected** to disconnect this computer.

### Choose a download

| Computer | Download to look for in the release |
| --- | --- |
| Apple Silicon Mac | `mac-arm64` ZIP or DMG |
| Intel Mac | `mac-x64` ZIP or DMG |
| Windows x64 | `win-x64` installer |
| Linux x64 | `linux-x86_64.AppImage` or `linux-amd64.deb` |

The initial release targets these four platforms. Native Windows ARM64 and Linux ARM64 installers are not included. Mac pilot builds use ad-hoc signatures to seal the app's contents; they do not have Apple Developer ID signatures or notarization. Windows installers are unsigned. Release notes list the installers actually available and their validation status. Successful packaging alone does not verify an overlay during a talk. Test microphone capture, projector placement, and fullscreen behavior on each presentation computer.

**Mac installation:** move Stage to Applications before opening it. If macOS blocks it because the developer cannot be verified, confirm you downloaded this repository's latest release, then follow Apple's [app-specific approval instructions](https://support.apple.com/en-us/102445): attempt to open Stage, open **System Settings → Privacy & Security**, and choose **Open Anyway** for Stage. Do not disable Gatekeeper. Version 0.1.1 had an invalid bundle signature; replace it with 0.1.2 or later. If the current release still reports that it is damaged, stop and report the version and Mac model to your organizer rather than removing quarantine attributes.

Fullscreen behavior depends on the operating system and display setup. Linux Wayland compositors can restrict overlay positioning or always-on-top behavior; an X11 session may be needed. Accent accuracy and delay depend on the speaker, microphone, network, and translation service; no accent or latency guarantee is implied.

## For organizers

Host one shared Stage server, configure its Soniox account, and give presenters the installer, HTTPS address, and shared code. [Deployment instructions](deploy/README.md) cover configuration, storage, and code rotation.

The permanent Soniox key stays on the server. After team authentication, the app receives a temporary speech credential and sends microphone audio directly to Soniox. Stage does not save audio or transcripts. Team vocabulary and login sessions are stored on the server; Soniox's own processing terms apply to the speech service. Translation usage is billed to the organizer's Soniox account.

Everyone with the shared code can use translation and edit **Team vocabulary**. This version is intended for a trusted team.

## Develop locally

Use Node.js 24 or newer and npm.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`. On the default loopback configuration, the backend creates a private shared code at `data/team-access-code.txt` if `TEAM_ACCESS_CODE` is empty. Rehearsal works without Soniox. For live translation, put your key in the server's `.env` as `SONIOX_API_KEY` and restart the backend.

With the development servers running, open the desktop shell in another terminal:

```sh
npm run desktop
```

Run the production build and automated tests:

```sh
npm run check
```

See [desktop development and packaging](electron/README.md) for native checks and installer builds. Secrets, local databases, and generated installers are excluded from Git; release installers are distributed as GitHub release assets.
