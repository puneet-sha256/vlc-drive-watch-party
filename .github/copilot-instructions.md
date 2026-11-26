# VLC Drive Watch Party

## Installed Windows application

The per-user Windows installer includes its runtime and the allowlisted Google application settings. Installed users do not need Node, npm, source files, or `.env`. Start **VLC Drive Watch Party**, install official desktop VLC if prompted, and use the local browser controls. A guest signs into Google and joins with the complete invite; never require hosting setup for a guest. A host uses **Hosting setup** to obtain Microsoft's checksum-verified Dev Tunnel tool and sign in with Microsoft/GitHub. Never request device codes in chat or share personal sign-in caches. A shortcut reopens the existing instance; tray **Quit** stops its owned processes.

For packaging changes, preserve the distinction between `src/main.ts` (source/.env) and `src/desktop.ts` (installed/app-config.json). Run typecheck, tests and `npm.cmd run package:windows`; `npm.cmd run test:installer` validates an isolated install when no real installed copy exists. Do not copy `.env`, OAuth downloads, user credentials, caches or media into `artifacts`. Never tunnel the companion/VLC ports. Keep generated artifacts ignored, production dependencies only, third-party notices intact, and the hosting-tool download pinned and verified.

## Set up and run for a guest

When asked to help a friend run this project or join an existing party, follow this checklist. Normal setup does not require source changes, a Git repository, or a new Google Cloud project. Do not create a party, configure a tunnel, initialize Git, or publish anything unless the user requests that separately.

1. Work in the extracted folder containing `package.json`, `README.md`, and `.env.example`, not its parent folder. Read README.md. Use paths on this computer; do not assume the host's installation paths.
2. Check Node.js 22+, npm, and installed desktop VLC. On Windows, use `node --version` and `npm.cmd --version`. Use `npm.cmd` instead of changing PowerShell's execution policy if `npm.ps1` is blocked. If Node or VLC is missing, guide installation from https://nodejs.org/en/download and https://www.videolan.org/vlc/ or obtain approval before installing them. Windows is the verified platform; other platforms have VLC detection but are not yet verified.
3. Preserve an existing `.env`. Create it from `.env.example` only if it does not exist:

   ```powershell
   if (-not (Test-Path .env)) { Copy-Item .env.example .env }
   ```

4. Check configuration without printing its values. The shared application settings are `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (if supplied with the Desktop client), `GOOGLE_API_KEY`, and `GOOGLE_APP_ID`. They identify the Google application, not the host's personal Google login. If missing, ask the user to supply the host-provided application configuration in a local file or edit `.env`; do not ask for secrets in chat, invent values, or automatically create replacement Google resources. A supplied OAuth JSON must contain a Desktop client under `installed`, not a Web client under `web`. Never dump `.env`, client JSON, API keys, client secrets, tokens, or complete invitation links into output.
5. For a guest, leave `PUBLIC_SYNC_URL` empty. Keep `COMPANION_PORT=43821` and `SYNC_PORT=43822` unless there is a diagnosed conflict. These defaults can be identical on separate computers. Leave `VLC_PATH` empty unless automatic detection fails. A changed companion port also requires the Google Picker key's allowed referrer to match. Do not install Dev Tunnel or copy the host's tunnel configuration onto a guest computer.
6. Use the npm lockfile to install missing dependencies with `npm.cmd ci`, then build and start from the project root:

   ```powershell
   npm.cmd run build
   npm.cmd start
   ```

   On other platforms use `npm` instead of `npm.cmd`. Do not repeatedly reinstall a working dependency tree. Keep the server running in a persistent terminal or supported background session; do not terminate it when replying. If your tools cannot keep it alive, provide the start command for the user's terminal and say so. Check that the process remains running and the configured loopback UI responds (default `http://127.0.0.1:43821/`).
7. Use the authorized browser window opened by the companion. A bare localhost URL in another browser tab may lack its temporary local authorization. Let the user complete Google sign-in with their own account in the normal browser; do not request passwords or extract browser cookies. The owner must share the original Drive file with that account and, while the Google app is in Testing, add it as a test user.
8. Guide the user to **Choose video**, select the same original shared file, paste the full HTTPS invite including `#room=...&key=...`, and click **Join party and open VLC**. Do not click **Create party** for a guest. An invite does not grant Drive permissions, and opening it in a browser does not play video.
9. Confirm **Sync connected**, the guest role, and a dedicated VLC window. The host controls shared play/pause/seek; disabled guest playback buttons are intentional. The guest chooses volume, audio tracks, subtitles, and fullscreen locally in VLC. Ask for or observe real playback following the host before claiming the watch party works. A responding homepage or passing synthetic test alone is not proof of a successful join.

## Setup troubleshooting

- **Missing Desktop OAuth configuration:** check the four application settings locally and restart after changes. Restarting clears in-memory Google sign-in and the current party, so explain the interruption first.
- **API developer key is invalid:** the Picker key must belong to the OAuth client's Google project, allow Drive and Picker APIs, and allow the configured local origin. The UI's `strict-origin` referrer metadata is intentional: Google needs the origin to validate a website-restricted key. Preserve it; do not remove key restrictions as a shortcut.
- **Open the companion's launch window / local 403:** use the window opened by `npm start`. Do not weaken local API authorization. Restarting opens a fresh authorized window but requires Google sign-in again.
- **Cannot read the video:** check the guest's Google account, owner sharing/download permission, and selection of the exact original file in Picker, not a different copy.
- **Cannot connect to the party:** check that the full invite has its fragment and that the host's companion, party, and tunnel remain active. Guests use the invite's server address; they do not need `PUBLIC_SYNC_URL`.

If blocked by missing application settings, user consent, file access, or an offline host, report the specific blocker. Do not fabricate successful setup or substitute a central video relay.

## Development and architecture

Use Node.js/TypeScript and the npm lockfile. Commands from the repository root: `npm ci`, `npm run typecheck`, `npm run build`, `npm test`. `npm start` opens the local companion UI and requires configuration in `.env`.

Core invariant: **the common sync server must never download, convert, cache or relay video/subtitle media**. `src/sync-server.ts` handles only rooms and timestamped playback. Each viewer's `src/companion.ts` and `src/drive.ts` fetch their own Google Drive bytes into their own local VLC. Runtime FFmpeg is prohibited; its dev dependency generates synthetic test fixtures only.

Do not fork VLC or edit its installation. `src/vlc.ts` launches and controls a dedicated VLC process via its loopback-only, password-protected HTTP interface. Never expose the companion or VLC ports through a tunnel. Only the sync port may be forwarded.

Keep Google credentials on the viewer's machine, in memory for this version. Use Desktop OAuth with state and PKCE, narrow `drive.file` grants, exact-file confirmation, and authenticated byte-range requests. Never log tokens, OAuth codes, local UI keys, or invite/host capabilities, and never commit `.env` or user media.

Preserve host-only command authorization, separate host/guest capabilities, bounded input sizes, revision ordering, seek-while-playing state, reconnect snapshots, and disconnection pause. Protocol version 2 requires every viewer to update together. Routine position reports run every second: hold only viewers more than three seconds ahead, resume within one second, and never seek or change playback speed to correct ordinary drift. Stale/disconnected viewers cannot hold others; after 30 seconds of waiting, lagging viewers temporarily stop holding the group until they catch up. Automatic holds must not become host pause commands.

Explicit host seeks bypass waiting, retain play/pause intent, clear pre-seek reports, and run as soon as received. Align a joining/reconnecting viewer once to the host's actual position, not an advancing theoretical clock while the host is held. Native VLC seek detection must not mistake buffering or delayed status responses for seeks. Keep the bounded playback event history free of credentials and invite keys. Do not claim sample/frame accuracy for polling-based VLC control.

VLC's `in_play` response may still describe the previous input. Wait for a different valid `currentplid`, ready media metadata, and a confirmed pause before returning from `Vlc.open`. Keep that wait bounded and cancellable. Rejoin tests must check the replacement input and its settled position, not merely a transient matching timestamp.

Read README.md for setup and limitations. The browser watch-party project in another folder is separate; do not change it or borrow its configured secrets automatically.

For playback changes, run the actual two-VLC integration test, not only mocks. Tests require installed VLC and generate their own media. Do not skip missing-VLC failures and claim success. Keep production Google/tunnel validation distinct from synthetic local verification. Documentation-only changes do not require the playback test.
