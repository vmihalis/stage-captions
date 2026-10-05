# Host a Stage team server

Presenters install the desktop app and connect to a shared HTTPS server. Only the organizer configures Soniox. The server serves the app, authenticates the shared code, stores vocabulary and complete finalized meeting transcripts, and issues temporary speech credentials. Audio streams directly from the presenter's computer to Soniox.

## Docker Compose

Use a host with Docker and the Compose plugin, plus an HTTPS reverse proxy or tunnel. From the repository root:

```sh
cp .env.example .env.production
chmod 600 .env.production
```

Edit `.env.production` with your own values:

```dotenv
PUBLIC_ORIGIN=https://captions.example.com
STAGE_PORT=4310
TEAM_ACCESS_CODE=replace-with-a-long-random-team-code
SONIOX_API_KEY=
SONIOX_REGION=global
TRUSTED_PROXY_IPS=
TEAM_TOKEN_LIMIT_PER_MINUTE=60
```

Replace the example code with at least 16 random characters. For example, generate a code locally with `openssl rand -hex 24`. Keep the team code and permanent Soniox key out of Git, release files, and public logs. Obtain the provider key from the [Soniox console](https://console.soniox.com/) and set `SONIOX_API_KEY` before live use. Rehearsal works without it. Regional Soniox projects require matching credentials and region (`global`, `eu`, or `jp`).

Start the service:

```sh
docker compose --env-file .env.production -f deploy/compose.yml up -d --build
docker compose --env-file .env.production -f deploy/compose.yml ps
```

Configure your HTTPS proxy or tunnel to forward only the Stage hostname to `http://127.0.0.1:4310`. Set `PUBLIC_ORIGIN` to the exact external origin, including a nonstandard port if used, without a path. Compose binds Stage to host loopback; keep that backend port private. Presenters need no VPN when this HTTPS address is publicly reachable.

`TRUSTED_PROXY_IPS` accepts exact comma-separated IPv4/IPv6 addresses only. Leave it blank until you identify the immediate proxy's source address as Stage sees it; Docker may present a bridge gateway address. The trusted proxy must replace client-supplied forwarding headers. This setting lets login rate limiting distinguish clients behind the proxy; do not set it to a wildcard, subnet, or arbitrary public address.

The container runs as a non-root user with a read-only filesystem, dropped capabilities, bounded resources and logs, and a dedicated writable data volume.

## Verify and share

Open the public HTTPS address from outside the server's private network. Connect with the code, run a rehearsal, then test automatic English ↔ Japanese captions and any fixed direction your team needs. Compare **Responsive** and **More context** pacing with your speakers, and check a custom text size from 24–96 px. Verify microphone permission and overlay placement in the desktop app on the actual presentation display. Check Soniox usage after the test.

Give presenters the [latest release](https://github.com/vmihalis/stage-captions/releases/latest), your HTTPS address, and the code through your team's normal private channel. They never enter the permanent provider key.

## Operations

The named `stage-data` volume holds a SQLite database containing shared vocabulary, hashed login sessions, meetings, finalized source/translation entries, and bookmarks. Back it up before replacing or migrating the host. Stage does not persist microphone audio. Meeting transcripts are shared with everyone holding the team code; protect backups as team data. Protect `.env.production` separately as a credential file.

For a v0.1.6 upgrade, preserve the existing `.env.production`, Compose project, data volume, and previous image for rollback. Take a consistent SQLite backup; do not copy only the database file while it has active WAL writes. The compact controller adds no database migration or speech API change over v0.1.5. Build the frontend with `VITE_STAGE_PREVIEW=false`, then rebuild and recreate only the Stage container. Audio streams directly between clients and Soniox; avoid refreshing presenters mid-talk.

After upgrading, verify public assets and container health, retained team settings/login, and authenticated meeting APIs. Install v0.1.6 on presenter computers for the small native floating remote and separate Meetings/Vocabulary workspace. Older apps show update guidance for unsupported actions; a server update alone cannot resize an older native shell into the remote. Publishing desktop installers does not deploy the hosted server.

Presenters start from the remote's **Start** button. The output icon offers **Overlay**, **Window**, and **Slides + strip**; **⋯** contains Settings, Meetings, Vocabulary, Rehearse, and End & save. **Cmd/Ctrl+Shift+B** toggles the remote and **Cmd/Ctrl+Shift+H** toggles captions. Hiding either keeps audio running. Pause keeps the existing session and microphone resource, so usage charges may continue; End & save releases the microphone and finishes the meeting.

Optional personal summaries run on configured owner computers, never inside this shared server. A summary brief and complete transcript exports remain available to every team member. The server has no personal OMP/Codex login.
To rotate the code or update provider settings, edit `.env.production` and rerun the Compose `up -d` command. Changing the code invalidates existing team logins. It does not cancel an already connected client-to-Soniox stream; revoke provider credentials separately if required.

The server limits login failures and temporary speech credential requests. `TEAM_TOKEN_LIMIT_PER_MINUTE` is a single-server, in-memory issuance limit that resets on restart; it is not a spending or active-stream limit. Monitor usage through the provider account.

Use `docker compose --env-file .env.production -f deploy/compose.yml down` to stop the service while preserving its volume. Removing the volume deletes stored team settings and sessions.

## Without Docker

Use Node.js 24 or newer, `npm ci`, and `npm run build`. Configure `.env` from `.env.example`, set `NODE_ENV=production`, keep `HOST=127.0.0.1`, and run `npm start` under your service manager. Terminate HTTPS at a proxy or tunnel and follow the same origin, proxy-trust, credential, and backup guidance above.
