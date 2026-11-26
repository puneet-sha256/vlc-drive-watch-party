# VLC Drive Watch Party

A standalone companion for an existing VLC installation. This is **not a VLC fork** and does not modify VLC's installed files or saved preferences.

Every viewer runs a companion and VLC on their own computer. Their companion downloads original video bytes from Google Drive using their own account and feeds their own VLC over a private loopback bridge. VLC handles MKV, decoding, audio and subtitles locally. Nothing is transcoded.

The common server carries only small room and playback messages. It has no Google credentials, media endpoints, file downloader, or converter. Only its port is exposed through Dev Tunnel. Your laptop does not fetch or upload your friend's video.

## Windows installer

Install `VLC-Drive-Watch-Party-Setup-0.1.1.exe` and open **VLC Drive Watch Party** from Start or its desktop shortcut. The installer is per-user for Windows 10 (2004+) / Windows 11 x64 and includes Node.js, the companion and its Google application settings. No terminal, npm, or `.env` editing is needed.

Version 0.1.1 changes the synchronization protocol. Update **every viewer, including the host**, before creating a new party; older clients cannot join the new protocol. Updating a running installation closes its party, so install between sessions.

Install standard desktop [VLC](https://www.videolan.org/vlc/) separately if the application asks. VLC is deliberately not redistributed or modified. The browser provides the controls; VLC displays the movie. Closing the browser tab keeps the app running. Double-click the tray icon or launch the shortcut again to reopen it; **Quit** ends the party and stops only this app's VLC/tunnel processes.

**Join:** sign in with your own Google account, paste the complete invite, and click **Join party and open VLC**. If requested, choose the exact shared file in Google Picker and retry. Joining needs no Microsoft/GitHub login or hosting-tool download.

**Host:** expand **Hosting setup**, choose Microsoft or GitHub, open the official sign-in page and enter the displayed device code. First setup downloads a checksum-verified Dev Tunnel executable directly from Microsoft after you choose to accept its linked terms. Select your Drive video and click **Create party and open VLC**. Copy the resulting invite; only the sync port is exposed. Leaving or quitting stops the owned tunnel process; its named cloud resource expires after 30 days and can be reused before then.

If the CLI already has a valid sign-in on your computer, setup reuses it rather than starting a replacement login. On a new computer, cancelling sign-in leaves hosting unconfigured and can be retried; joining still works without it.

The host must still share the original Drive file and add the friend as a Google test user while the Google application is in Testing. The included Google settings identify this application: Desktop OAuth is a public-client flow, and an installer cannot hide its client configuration or Picker key. No personal Google tokens, Microsoft/GitHub login cache, room capabilities, `.env`, or user media are included. Google tokens remain in memory and each launch requires Google sign-in. The Dev Tunnel CLI manages its own per-user sign-in cache.

App-owned hosting tools and the non-secret tunnel ID live in `%LOCALAPPDATA%\DriveWatchParty`. Uninstall removes the installed program and shortcuts, not Microsoft-managed credentials or app data. It does not change or uninstall VLC. This private-build installer is unsigned; Windows may show an unknown-publisher warning. Do not disable Windows protections.

## Source/development requirements

- Node.js 22+ and npm.
- Installed desktop VLC, including its HTTP interface (the standard VideoLAN Windows installation includes this).
- A Google Cloud project with Drive API and Google Picker API enabled.
- On the host only, for remote parties: Microsoft Dev Tunnel CLI and an account with which to host a tunnel. Guests do not need Dev Tunnel.

Windows is the verified platform. Other platforms have VLC path detection but are not yet verified. No Lua menu extension is included.

## Guest setup with Copilot

Extract the project and open the folder containing `package.json` in Copilot or your editor. The ZIP includes `.github/copilot-instructions.md` with a guest setup/run checklist and troubleshooting. Copilot CLI reads this instruction file from its working directory; a Git checkout is not required.

Use this prompt:

> Read .github/copilot-instructions.md and set up and run this project for me as a guest joining my friend's existing party. Check Node.js and VLC, preserve my existing .env, help me configure missing Google application settings locally without printing secrets, install missing dependencies, build, and keep the companion running. Guide me through Google sign-in and joining with my invite. Do not create a party or a tunnel for me.

The ZIP does not contain credentials. A guest needs the shared Google application's settings in their own `.env`, but signs in with their own Google account. Leave the guest's `PUBLIC_SYNC_URL` empty: the complete invite supplies the host's server address. The host must separately share the original video and, while the Google app is in Testing, add the guest as a test user.

## Install from source

From this project's directory:

```powershell
npm ci
Copy-Item .env.example .env
npm run build
```

Do not overwrite an existing `.env`. Set `VLC_PATH` only if VLC is not installed in a detected location.

### Google configuration

Use a Google OAuth client of type **Desktop app**. This is different from the Web application client used by the older browser project. The companion uses a loopback callback with PKCE and opens Google's normal sign-in page in your browser.

1. Enable Google Drive API and Google Picker API in your project.
2. In Google Auth Platform, configure the consent screen and add each participating Google account under Audience/Test users while the application is in Testing.
3. Create a Desktop app OAuth client. Put its client ID and, if supplied, client secret in `.env`.
4. Create a Picker API key restricted to Drive API and Google Picker API. Allow `http://127.0.0.1:43821/*` and `https://docs.google.com/*` as website referrers.
5. Put the numeric project number in `GOOGLE_APP_ID` and the key in `GOOGLE_API_KEY`. Picker and OAuth must use the same Google project.

| Setting | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Desktop OAuth application configuration, not your Google password. |
| `GOOGLE_API_KEY`, `GOOGLE_APP_ID` | Allow Google Picker to grant access to an explicitly selected file. |
| `COMPANION_PORT` | Local UI and private media bridge; default 43821. Never expose this port remotely. |
| `SYNC_PORT` | Room coordination only; default 43822. This is the tunnel port. |
| `PUBLIC_SYNC_URL` | Host's Dev Tunnel HTTPS origin used in copied invites. Guests leave this blank; local-only hosts may also leave it blank. |

Google's Desktop OAuth flow permits loopback redirects. The callback is `http://127.0.0.1:43821/oauth/callback`; a changing sync tunnel address does not change this callback. If you change the companion port, update the Picker referrer accordingly.

The owner must share the original movie with the friend's Google account and permit downloads. Each viewer signs in and selects that file in Picker. The app retains the narrow `drive.file` scope; the file need not be public.

Google credentials are held **only in that companion's memory** in this prototype. Restarting requires sign-in again. Do not put downloaded credential JSON, tokens, or movies in Git. Do not paste credentials into Copilot chat.

## Run locally

```powershell
npm start
```

The companion opens an authorized local browser window. Keep that window or bookmark neither its temporary fragment nor invite secrets publicly. If you close it, restarting the companion opens a fresh authorized window.

Sign in, choose a video, then **Create party and open VLC**. A dedicated VLC process starts with a password-protected HTTP control interface bound to loopback. Existing unrelated VLC instances are not commandeered. Closing the companion closes only the VLC process it launched.

Use the companion's Play/Pause/Seek buttons. Native host VLC play/pause and sufficiently large seek changes are also detected. Guest playback follows the host; guest audio, volume and subtitle selections remain local in VLC.

Routine synchronization checks run once per second and tolerate up to three seconds of playback difference. A viewer more than three seconds ahead pauses locally until the others are within one second. The lagging viewer continues playing; automatic waiting is not a shared host pause. Routine drift never causes seeks or playback-speed changes.

Host Play, Pause and Seek commands from the browser are handled on receipt, without waiting for the next routine check. A forward or backward seek clears automatic holds and old position reports, moves every viewer to the new position, and preserves the host's playing/paused intent. Native host VLC controls are detected by the one-second poll; sufficiently large native position jumps also propagate. A native seek already applied on the host is not repeated there. Actual seeking can still require VLC to buffer.

Disconnected viewers and position reports older than five seconds do not hold up others. After 30 seconds of continuous waiting, viewers still behind temporarily stop holding up the group until they catch up within one second. No one is automatically skipped forward. A late join or reconnection aligns once to the host's actual reported position, including when the host is waiting.

The Playback section distinguishes automatic waiting, local stalls, seeking and disconnection. Recent playback events are bounded, in-memory diagnostics and contain no account credentials or invite keys. They reset on restart. Losing the sync connection pauses the affected companion. Losing the host pauses the room, and a host absent for 60 seconds closes it.

## A party across two computers with Dev Tunnel

Install the [Dev Tunnel CLI](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started) on the host computer and sign in using its supported interactive login.

```powershell
devtunnel user login
devtunnel create vlc-drive-watch-party --allow-anonymous --expiration 30d
```

Create the named tunnel once. Copy the full tunnel ID printed by that command (including its region suffix), then run:

```powershell
$tunnelId = "PASTE_THE_FULL_TUNNEL_ID_HERE"
devtunnel port create $tunnelId -p 43822 --protocol http
devtunnel host $tunnelId
```

Only port **43822** is forwarded. Never forward the companion port or VLC control port.

`--allow-anonymous` permits companions to reach the transport without sharing the host's Microsoft/GitHub login. The application still requires unguessable room capabilities and a separate, private host-control capability. Anyone with the complete invite can join; do not post it publicly. Invites carry the guest key in the URL fragment, not an HTTP query. The key authorizes room access, not Google Drive access.

Copy the tunnel's HTTPS origin (no path or trailing slash) into `PUBLIC_SYNC_URL` in the host's `.env`, then start/restart the companion. Create a new room and copy the invite.

Restarting the companion clears its in-memory Google sign-in and room, so sign in and select the video again. The copied invite must start with the tunnel's HTTPS origin, not `http://127.0.0.1`. Do not change the Google OAuth callback: the tunnel carries synchronization only.

Your friend starts their own configured companion, signs into their own Google account, pastes the invite and clicks Join. If access is missing, they must select the exact original video in Picker and retry Join. They do not need to host a tunnel.

Both companions stream video locally from Drive. The host may connect to its sync server over localhost while guests use the tunnel; they still join the same room. The host computer, companion and tunnel must stay running.

To host the same tunnel again, run `devtunnel host $tunnelId`; do not create another tunnel or port each time. The named tunnel keeps its address while it exists, and the example requests a 30-day expiration. The tunnel process must remain running.

Dev Tunnel is intended for development/testing rather than production. The runtime has no dependency on a particular tunnel provider, provided HTTPS/WSS is supported.

## Verification

```powershell
npm run typecheck
npm run build
npm test
```

The integration test generates an MKV and starts **two real VLC processes** with dummy video/audio outputs. It checks independent per-viewer sources, video decoding, embedded subtitle recognition, play/pause/seek, native host pause, rejoin, disconnection pause, and rejection of unauthenticated/local-cross-origin/guest-control requests. FFmpeg is a **test-only dependency**, never part of playback or the sync server.

Synthetic integration success does not verify your Google OAuth client or a two-computer Dev Tunnel deployment. Those require real accounts, consent, and live checks after configuration.

## Build the Windows installer

On Windows x64, keep the working `.env` application configuration private, install Node/npm dependencies as above, and install [Inno Setup 6](https://jrsoftware.org/isinfo.php) if its compiler is missing. The Windows .NET Framework compiler builds the small tray launcher.

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
npm.cmd run package:windows
npm.cmd run test:installer
```

Output: `artifacts\VLC-Drive-Watch-Party-Setup-0.1.1.exe`, with a SHA-256 sidecar and payload inventory. Only the four allowlisted Google application settings are copied out of `.env`. Production dependencies retain their licenses; the bundled Node license is included. FFmpeg and other development dependencies are excluded.

The packager intentionally refuses to merge an old `artifacts\payload` into a new build: rename that staging directory before rebuilding. `INNO_SETUP_COMPILER` may specify a nonstandard `ISCC.exe` location. Installer verification refuses to replace an existing installed copy and uses a temporary installation, isolated data/ports and a browser test double; it checks startup, authorized APIs, single-instance reopening, owned-process cleanup and uninstall. It does not authenticate real Google accounts.

An optional `node scripts\test-tunnel.mjs --live` check uses an existing Dev Tunnel sign-in to create a temporary sync-only tunnel, exercise public HTTPS/WSS, restart it, and delete it. It downloads the same verified hosting tool as the installed app and uses no Google credentials or media.

For isolated desktop development/testing, `WATCH_PARTY_DATA_DIR`, `WATCH_PARTY_PORT`, `WATCH_PARTY_SYNC_PORT`, `WATCH_PARTY_BROWSER` and `WATCH_PARTY_NO_BROWSER=1` are optional process-level overrides, not user setup requirements. Changing a real-use companion port requires updating the Picker key's allowed referrer. Never change ports to expose the local bridge.

## Boundaries of this first version

- No registered deep-link handler or VLC Lua extension. Paste the copied invite into the companion.
- Sessions and rooms are ephemeral. Run one sync-server process per host.
- Do not assume the original browser project's rooms, credentials or cloud configuration were migrated.
- Google account setup, download quotas, file permissions, and local VLC codec availability still apply.
- The sync service and local bridge are intentionally separate. Do not add a central video-proxy fallback.
