# Stage

Live English ↔ Japanese subtitles for presentations. Choose floating captions, a movable caption window beside your apps, or a presentation view with a reserved caption strip on an extended projector.

Version 0.1.5 adds **Easy to read** captions, a **Separate caption window**, **Slides + caption strip** for an extended projector, and complete shared meeting transcripts with **Mark moment** bookmarks. Hosted controls become available when your organizer updates the team server; install v0.1.5 for the new native windows.

**[Download the latest release](https://github.com/vmihalis/stage-captions/releases/latest)** · [All releases](https://github.com/vmihalis/stage-captions/releases) · [Host a team server](deploy/README.md)

## For presenters

Your organizer provides a **team server address** and a **shared team access code**. You do not need a Soniox account, API key, VPN, or individual Stage account.

1. Download the installer for your computer from the [latest release](https://github.com/vmihalis/stage-captions/releases/latest). On Mac, unzip Stage and move it to Applications, or install from the DMG. On Windows, run the installer. On Linux, install the DEB or make the AppImage executable and run it.
2. Open **Stage**. Enter the **Team server address** supplied by your organizer, such as `https://captions.example.com`, and choose **Connect to Stage**.
3. Choose **Connect team** and enter the shared access code.
4. Select your microphone, choose **Check mic**, and allow microphone access when prompted. This short microphone check stays on your computer.
5. Under **Caption output**, select the display connected to the projector. Enter a **Text size (px)** from 24–96 and choose the top or bottom position.
6. At the top of Present, choose **Over your apps**, **Separate caption window**, or **Slides + caption strip**. A separate window works beside windowed content on mirrored displays. The caption strip captures explicitly selected content for an independent extended display; it cannot reserve space inside an arbitrary fullscreen app.
7. Choose automatic or fixed-direction **Translation**, then **Start captions**. Stage saves finalized speech and translations to your shared meeting history. Let participants know before starting; everyone with the team code can read and export the transcript.

Try **Run a rehearsal** first to check placement without using a microphone or translation account. Then rehearse with a real speaker and the actual projector to check accuracy and delay.

Automatic mode uses one Soniox two-way session with English and Japanese language hints. Spoken text stays separate from the translation, and an English word inside Japanese speech does not restart or reconfigure the session. The primary caption follows the provider's translation language; a language change starts a fresh translated segment. Soniox's language identification aims for sentence-level coherence, but short phrases and provisional language labels can be misidentified. Choose a fixed direction if this happens during rehearsal. See [language identification](https://soniox.com/docs/stt/concepts/language-identification) and [two-way translation](https://soniox.com/docs/translation/stt-translation).

For names or technical terms that should stay unchanged, add preferred translations such as `GitHub = GitHub` or `API = API` in **Team vocabulary**. Other pairs can use either direction; add the reverse pair separately when needed. Preferences guide the provider and cannot guarantee exact spelling or preservation. Stage displays the returned text without guessing language from Latin characters or applying word replacements.

Choose **Speech processing** before starting live captions. **Responsive** uses Soniox's recommended lower-latency endpoint settings on the v5 model; **More context** keeps the original semantic endpoint timing for speakers who pause mid-sentence. **Audience reading → Easy to read** publishes finalized phrases in fixed lines with a 600 ms batching window. **Live drafts** shows provisional words immediately. Reading time can add display delay during bursts; it does not slow recognition or discard the separate meeting transcript. Earlier finalization can split phrases and affect recognition accuracy, so compare the two with your presenters. The endpoint delay limits time after a speech boundary; it does not guarantee a translation every 1.5 seconds. See [Soniox's endpoint tuning guidance](https://soniox.com/docs/stt/rt/endpoint-detection).

The overlay lets clicks pass through to the app underneath. **Cmd+Shift+H** on Mac or **Ctrl+Shift+H** on Windows/Linux opens, hides, or shows captions. The **Show captions on screen / Hide captions** button does the same. Old text clears after six seconds without new recognized words or translation updates; late translations get a fresh reading window. Hiding keeps listening; choose **Stop captions** to stop translation. Closing Stage also ends capture.

The website is a browser preview with a separate caption window. Install the desktop app for the floating overlay. A team connection lasts seven days; click **Team connected** to disconnect this computer.

Older apps can load the hosted controls after a restart but cannot use the new native output modes. Quit Stage and replace the app with v0.1.5; the server address and existing login are retained. Choose **Meetings** to review/export complete transcripts and marked moments. **Summary brief** works for everyone. Automatic summaries are optional on an owner computer with the [local OMP worker](tools/summary-worker/README.md); credentials remain local and the installer does not include that worker.

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

The permanent Soniox key stays on the server. After team authentication, the app receives a temporary speech credential and sends microphone audio directly to Soniox. Stage does not store microphone audio. Finalized source text, translations, timestamps, and bookmarks are saved on the shared team server, along with vocabulary and login sessions; Soniox's own processing terms apply to the speech service. Translation usage is billed to the organizer's Soniox account.

Everyone with the shared code can use translation, edit **Team vocabulary**, and read/export every saved meeting. This version is intended for a trusted team.

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

For an isolated local rehearsal, see [preview setup and validation](docs/readable-meetings-preview.md). Production builds use `VITE_STAGE_PREVIEW=false`. Actual app/screen capture belongs to the trusted native picker; Stage never forces other applications to resize. See the [readability research](docs/caption-readability-research.md) for design evidence and pilot timing limits.
