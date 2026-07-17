#!/usr/bin/env bash
# AIDEV-NOTE: Bootstrap external pi packages on a fresh machine.
# Idempotent: `pi install` both fetches AND merges the source into
# ~/.pi/agent/settings.json (global), so re-runs are no-ops.
# Single source of truth for the external package list — edit PACKAGES below,
# do NOT hand-maintain settings.json (it also holds provider/theme/auth).
# Source of the "must call pi install" rule: Pi only auto-installs missing
# *project* packages on startup; global entries must be installed explicitly.
# See Pi README "Project Trust" + `pi install --help`.
set -euo pipefail

# External pi packages (global scope). Local repo path intentionally omitted —
# this repo is what you're deploying; it's added separately via settings.json.
PACKAGES=(
  "git:github.com/DietrichGebert/ponytail"
  "git:github.com/barvhaim/pi-openwiki"
  "npm:@carter-mcalister/pi-worktrunk"
  "npm:@tomooshi/condensed-milk-pi"
  "npm:@tomooshi/caveman-milk-pi"
  "npm:@sting8k/pi-vcc"
  "npm:pi-intercom"
  "npm:@zigai/pi-tree"
  "npm:@zigai/pi-model-modes"
  "npm:pi-inspect"
  "npm:@heyhuynhgiabuu/pi-pretty"
  "npm:@heyhuynhgiabuu/pi-diff"
)

command -v pi >/dev/null 2>&1 || {
  echo "error: pi CLI not on PATH — install pi first (https://pi.dev)" >&2
  exit 1
}

echo "Installing ${#PACKAGES[@]} external pi packages…"
for pkg in "${PACKAGES[@]}"; do
  echo "→ $pkg"
  pi install "$pkg"
done

echo
echo "Done. Installed packages:"
pi list
