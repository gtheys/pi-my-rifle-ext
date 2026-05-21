#!/usr/bin/env bash
#
# jira-branch.sh
# Fetches a Jira issue via acli, derives a branch name from the issue type
# and summary, creates it locally, and sets git-town parent to 'develop'.
#
# Usage:
#   ./jira-branch.sh <JIRA-KEY> [--dry-run]
#
# Requires: acli (Atlassian CLI), jq, git, git-town

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
DRY_RUN=false
JIRA_KEY=""
PARENT_BRANCH="develop"

# ── Issue type → branch prefix map ────────────────────────────────────────────
# AIDEV-NOTE: Extend this associative array to support additional Jira issue types.
# Keys must be lowercase. Fallback is DEFAULT_PREFIX.
declare -A TYPE_PREFIX_MAP=(
  ["bug"]="bugfix"
  ["hotfix"]="hotfix"
  ["story"]="feature"
  ["feature"]="feature"
  ["epic"]="feature"
  ["task"]="chore"
  ["sub-task"]="chore"
  ["subtask"]="chore"
  ["improvement"]="feature"
  ["technical debt"]="chore"
  ["spike"]="chore"
)
DEFAULT_PREFIX="feature"

# ── Help ──────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") <JIRA-KEY> [OPTIONS]

Fetch a Jira issue via acli, derive a branch name from the issue type and
summary, create the branch locally, and set its git-town parent to '$PARENT_BRANCH'.

Branch format: <prefix>/<JIRA-KEY>-<summary-slug>

Issue type → prefix mapping:
  Bug / Hotfix               → bugfix / hotfix
  Story / Feature / Epic     → feature  (default for unknown types)
  Task / Sub-task / Spike    → chore

Options:
  --dry-run    Print the derived branch name without creating it
  -h, --help   Show this help

Examples:
  $(basename "$0") IMP-1234
  $(basename "$0") IMP-1234 --dry-run
EOF
  exit 0
}

# ── Parse arguments ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)  usage ;;
    --dry-run)  DRY_RUN=true; shift ;;
    *)
      if [[ -z "$JIRA_KEY" && "$1" =~ ^[A-Z]+-[0-9]+$ ]]; then
        JIRA_KEY="$1"; shift
      else
        echo "Error: Unknown argument '$1'" >&2
        echo "Run '$(basename "$0") --help' for usage." >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$JIRA_KEY" ]]; then
  echo "Error: Jira key is required (e.g. IMP-1234)" >&2
  echo "Run '$(basename "$0") --help' for usage." >&2
  exit 1
fi

# ── Verify dependencies ───────────────────────────────────────────────────────
for cmd in acli jq git; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' not found in PATH." >&2
    exit 1
  fi
done

if ! git rev-parse --git-dir &>/dev/null 2>&1; then
  echo "Error: Not inside a git repository." >&2
  exit 1
fi

# ── Fetch issue from Jira ─────────────────────────────────────────────────────
echo "→ Fetching $JIRA_KEY from Jira..."

# AIDEV-NOTE: acli returns the standard Jira REST API shape with --json:
#   { "key": "...", "fields": { "summary": "...", "issuetype": { "name": "..." } } }
ISSUE_JSON=$(acli jira workitem view "$JIRA_KEY" --json --fields "summary,issuetype" 2>&1) || {
  echo "Error: acli failed to fetch '$JIRA_KEY'." >&2
  echo "$ISSUE_JSON" >&2
  exit 1
}

SUMMARY=$(echo "$ISSUE_JSON" | jq -r '.fields.summary // empty')
ISSUE_TYPE=$(echo "$ISSUE_JSON" | jq -r '.fields.issuetype.name // empty')

if [[ -z "$SUMMARY" ]]; then
  echo "Error: Could not parse summary from Jira response." >&2
  echo "$ISSUE_JSON" >&2
  exit 1
fi

# ── Derive branch prefix from issue type ─────────────────────────────────────
ISSUE_TYPE_LC=$(echo "$ISSUE_TYPE" | tr '[:upper:]' '[:lower:]')
PREFIX="${TYPE_PREFIX_MAP[$ISSUE_TYPE_LC]:-$DEFAULT_PREFIX}"

# ── Slugify summary ───────────────────────────────────────────────────────────
# Steps: lowercase → strip non-alphanumeric (keep spaces/hyphens)
#        → spaces to dashes → collapse repeated dashes
#        → take first 5 dash-delimited words → strip leading/trailing dashes
SLUG=$(echo "$SUMMARY" \
  | tr '[:upper:]' '[:lower:]' \
  | sed 's/[^a-z0-9 -]//g' \
  | sed 's/[[:space:]]\+/-/g' \
  | sed 's/-\+/-/g' \
  | cut -d'-' -f1-5 \
  | sed 's/^-//;s/-$//')

BRANCH="${PREFIX}/${JIRA_KEY}-${SLUG}"

# ── Preview ───────────────────────────────────────────────────────────────────
echo "  Issue:   $JIRA_KEY — $SUMMARY"
echo "  Type:    ${ISSUE_TYPE:-unknown} → prefix '$PREFIX'"
echo "  Branch:  $BRANCH"
echo ""

# ── Dry-run exit ──────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] Would run: git checkout -b $BRANCH"
  echo "[dry-run] Would run: git town set-parent $PARENT_BRANCH"
  exit 0
fi

# ── Guard: branch must not already exist ─────────────────────────────────────
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "Error: Branch '$BRANCH' already exists." >&2
  exit 1
fi

# ── Create branch and set git-town parent ─────────────────────────────────────
echo "→ Creating branch..."
git checkout -b "$BRANCH"

echo "→ Setting git-town parent to '$PARENT_BRANCH'..."
git town set-parent "$PARENT_BRANCH"

echo ""
echo "✓ Done. Branch '$BRANCH' created with git-town parent '$PARENT_BRANCH'."
