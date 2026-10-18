# pi-desktop-notify

Pi extension that sends a desktop notification (via `notify-send`) when Pi finishes a response after the machine has been idle. Avoids spamming during active back-and-forth.

## Usage

```
/notify            — show current state
/notify on|off     — enable or disable
/notify idle <s>   — set idle threshold in seconds (default 30)
```

Notifications are sent only when the idle timer exceeds the threshold, preventing noise during rapid exchanges. When running inside a [herdr](https://herdr.dev) session (`HERDR_ENV=1`), a herdr notification with the `done` sound is shown alongside the desktop one.
