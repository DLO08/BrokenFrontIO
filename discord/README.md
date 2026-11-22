# BrokenFront Discord server

The community server's layout as data. `layout.json` is the source of truth;
`apply.mjs` reconciles a live guild against it.

## Files

| File            | What it is                                                           |
| --------------- | -------------------------------------------------------------------- |
| `layout.json`   | Roles, categories, channels, permissions, AutoMod, Onboarding          |
| `apply.mjs`     | Reconciler for all of the above. Zero deps, raw `fetch`                |
| `content.mjs`   | Bot avatar, Welcome Screen, and the posts in `#welcome`                |
| `presence.mjs`  | Long-running gateway connection that makes the bot show as online      |
| `rasterize.mjs` | Renders the brand mark to the PNGs Discord needs                       |
| `brand/`        | Generated icons (committed, so nobody needs a browser to re-run)       |

`apply.mjs` owns structure; `content.mjs` owns anything made of words or
pixels. Both take the same `--guild` / `--token-file` / `--apply` flags and both
default to a dry run.

## One-time setup

The bot cannot do these for you:

1. Create the server in the Discord client.
2. **Server Settings → Enable Community.** Forum channels, announcement
   channels, Onboarding and the AutoMod preset filter do not exist without it.
   `apply.mjs` skips all of them with a warning if Community is off.
3. Create an application at <https://discord.com/developers/applications>,
   **Bot** tab → **Reset Token** → copy. (The *Public Key* on the General
   Information page is a different thing and will not work.) Turn **Public Bot**
   off. No privileged intents are needed.
4. **OAuth2 → URL Generator** → scope `bot` → permission `Administrator` → open
   the generated URL → authorize into the server.
5. **Server Settings → Roles → drag the bot's role to the top.** A bot can only
   manage roles *below* its own highest role. This is the most common cause of a
   half-applied run.

   Do this *before* the first `--apply`. Discord's API creates every new role at
   position 1 without shifting existing roles up, so they all arrive tied at the
   bottom; sorting them into the layout's order needs the bot's own role to sit
   strictly above all of them, and a bot cannot raise its own role. If you miss
   this, the roles are still created correctly — just unordered. Drag the bot up
   and re-run, and the ordering pass fixes them in place.

## Running it

Dry run is the default. Nothing is written without `--apply`.

```bash
node discord/apply.mjs --guild <guild-id> --token-file <path>
node discord/apply.mjs --guild <guild-id> --token-file <path> --apply
```

The token can also come from `$DISCORD_TOKEN`. Prefer `--token-file` pointing
somewhere outside the repo: it keeps the token out of your shell history.

The guild ID comes from the Discord client with Developer Mode on
(User Settings → Advanced): right-click the server icon → Copy Server ID.

## How reconciling behaves

- **Matched by name.** Rename a channel in the Discord UI and the next run will
  treat it as missing and create a new one. Rename it in `layout.json` instead.
- **Never deletes.** Removing something from `layout.json` does not remove it
  from the server. Delete by hand; this script will not destroy a channel with
  history in it.
- **Only touches drift.** Unchanged objects are reported as `=` and skipped.
- **Re-runnable.** Edit the layout, re-run, read the diff, then `--apply`.

AutoMod rules are created once and then left alone, so tuning them in the UI
will not be clobbered. Onboarding is a full `PUT` and *is* overwritten each run.

## Keeping the bot online

A Discord bot shows as online **only while it holds an open WebSocket to the
gateway**. There is no API field and no dashboard toggle for it: the green dot
*is* the connection. `presence.mjs` exists to hold that socket open and nothing
else — it requests zero intents, so it receives no message content and no member
data.

```bash
node discord/presence.mjs --token-file <path>
node discord/presence.mjs --token-file <path> --status idle --activity "the front lines" --type watching
```

`--type` is one of `playing`, `streaming`, `listening`, `watching`, `competing`.
`--status` is `online`, `idle`, `dnd` or `invisible`.

Stop the process and the bot goes offline within about 45 seconds, when Discord
notices the heartbeat stopped. So it needs to live somewhere that stays up — a
laptop will not do it. On a Linux host:

```ini
# /etc/systemd/system/brokenbot-presence.service
[Unit]
Description=BrokenBot presence
After=network-online.target

[Service]
ExecStart=/usr/bin/node /srv/brokenfront/discord/presence.mjs
Environment=DISCORD_TOKEN=...
Restart=always
RestartSec=10
User=brokenbot

[Install]
WantedBy=multi-user.target
```

`Restart=always` matters more than it looks: the script already reconnects
through network blips and gateway `RECONNECT` opcodes, but it deliberately exits
on fatal close codes (bad token, disallowed intents) rather than hammering a
connection that will never succeed.

Prefer `EnvironmentFile=` over an inline `Environment=` if anyone else can read
the unit file — systemd unit files are world-readable by default.

## Regenerating the icons

```bash
node discord/rasterize.mjs
```

Needs a Chromium-based browser (Edge or Chrome) installed; it screenshots the
mark rather than depending on an SVG rasterizer library. Source art lives in
`resources/images/BrokenFrontMarkBare.svg`.

## Boost-gated branding

Not everything can be set on a new server, regardless of permissions:

| Asset            | Requires       |
| ---------------- | -------------- |
| Server icon      | nothing        |
| Invite splash    | Boost level 1  |
| Server banner    | Boost level 2  |
| Vanity invite URL| Boost level 3  |

`apply.mjs` sets the icon and leaves the rest alone.

## Security

The bot token *is* the bot: anything holding it has Administrator on the server.
Never commit it. `discord/.gitignore` blocks the obvious filenames, but the
reliable habit is to keep the token outside the repo entirely and reset it in
the Developer Portal once you are done with a batch of changes.

Webhook URLs printed by `apply.mjs` are also credentials — anyone with one can
post into that channel as that webhook.
