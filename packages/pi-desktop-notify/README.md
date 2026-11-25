# pi-desktop-notify

Pi extension that sends notifications when Pi finishes a response after the machine has been idle — or when Pi is blocked waiting for your input. Channels: desktop (`notify-send`), [herdr](https://herdr.dev) (inside a herdr session), and **ntfy** (self-hosted push notification server).

## Usage

```
/notify            — toggle notifications on/off
/notify on|off     — enable or disable (master switch for all channels)
/notify idle <s>   — set idle threshold in seconds (default 30)
/notify test       — send a test notification on every enabled channel
```

Completion notifications are sent only when the idle timer exceeds the threshold, preventing noise during rapid exchanges. "Pi needs input" notifications (blocking prompts: select/confirm/input/editor/custom) fire immediately, regardless of the idle threshold — disable them with `notifyOnPrompt: false`.

## Configuration

Global config lives at `~/.pi/agent/pi-desktop-notify/config.json`. Create the file (and the `ntfy` section) to enable ntfy pushes — the channel is off while the section is absent.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `desktop.enabled` | boolean | `true` | Send `notify-send` desktop notifications |
| `herdr.enabled` | boolean | `true` | Mirror notifications into herdr when `HERDR_ENV=1` |
| `herdr.sound` | string | `done` | herdr notification sound name |
| `ntfy` | object | — | ntfy section; presence enables the channel (unless `enabled: false`) |
| `ntfy.serverUrl` | string | — | **Required.** Base URL, e.g. `https://ntfy.homelab.local` |
| `ntfy.topic` | string | — | **Required.** Topic to publish to (secret topics work too) |
| `ntfy.token` | string | — | Bearer token for access control; `PI_NTFY_TOKEN` env wins over this |
| `ntfy.priority` | integer | `3` | ntfy priority 1–5 (5 = max priority, persistent) |
| `ntfy.tags` | string[] | `[]` | Emoji tags, e.g. `["robot", "white_check_mark"]` |
| `ntfy.clickUrl` | string | — | URL opened when the notification is tapped |
| `ntfy.timeoutMs` | integer | `5000` | HTTP timeout for the publish request |
| `notifyOnPrompt` | boolean | `true` | Also notify when Pi shows a blocking user prompt |

```json
{
  "$schema": "https://raw.githubusercontent.com/gtheys/pi-my-rifle-ext/main/packages/pi-desktop-notify/config.schema.json",
  "desktop": {
    "enabled": true
  },
  "herdr": {
    "enabled": true,
    "sound": "done"
  },
  "ntfy": {
    "enabled": true,
    "serverUrl": "https://ntfy.homelab.local",
    "topic": "pi-notifications",
    "priority": 3,
    "tags": ["robot"],
    "timeoutMs": 5000
  },
  "notifyOnPrompt": true
}
```

Minimal homelab setup:

```json
{
  "ntfy": {
    "serverUrl": "https://ntfy.homelab.local",
    "topic": "pi-notifications"
  }
}
```

If your ntfy topic requires access control, prefer the `PI_NTFY_TOKEN` environment variable over putting the token in the config file.

All channels are best-effort: an unreachable ntfy server or missing `notify-send` never interrupts a Pi session. A present-but-malformed config file is reported as an error at session start instead of being silently ignored.

## Library subpath (`./notify`)

The package also exports a node-only `@gtheys/pi-desktop-notify/notify`
subpath: `dispatchNotification(config, summary, body)` plus the re-exported
`loadConfig` and config types. It reuses this package's channel dispatch
(desktop / herdr / ntfy, best-effort per channel) without loading the
extension, so another extension can page through the **same user channel
toggles**. It is currently consumed by [`pi-flow`](../pi-flow/README.md),
which dynamically imports `@gtheys/pi-desktop-notify/notify` to send a desktop
notification on a `waiting_human` / `halted` flow transition (PMR-ZV9Y). The
subpath keeps the node-only bar: it never imports the pi extension runtime
directly — only node built-ins plus `./config.ts` (which reaches
`@earendil-works/pi-coding-agent` for `getAgentDir()` transitively; accepted,
because the only consumer runs inside a Pi session already).
