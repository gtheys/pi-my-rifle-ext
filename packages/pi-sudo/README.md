# @gtheys/pi-sudo

Pi tool — `sudo_run` with confirm dialog + masked password prompt.

## What it does

Registers `sudo_run`, which executes a shell command as root behind a two-stage overlay: first an Allow/Deny confirmation showing the command and the AI's stated reason (`y` / `n` or Esc), then — only if allowed — an inline masked password field (`●` per char, Enter to submit, Esc to cancel). A 60s inactivity timeout auto-denies. The password is piped to `sudo -S` on stdin, never written to disk, and never appears in tool result content or details. Output is truncated to 50 KB / 2000 lines. Requires an interactive terminal session (`ctx.mode === 'tui'`); blocked immediately otherwise.

Unlike a PAM-caching variant, every call re-prompts for approval and password, and a wrong password fails the call once (call the tool again to retry).

While the overlay waits for approval, a best-effort attention alert fires: a critical `notify-send` desktop notification, plus a herdr notification (`request` sound) when inside a [herdr](https://herdr.dev) session (`HERDR_ENV=1`). Neither channel can block or fail the prompt.

## Install

Add `./packages/pi-sudo/index.ts` to your `pi.extensions` list.

## License

MIT
