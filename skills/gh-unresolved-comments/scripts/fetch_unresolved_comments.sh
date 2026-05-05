#!/usr/bin/env bash
#
# fetch_unresolved_comments.sh
# Fetches unresolved review comments from a GitHub Pull Request using gh CLI.
#
# Usage:
#   ./fetch_unresolved_comments.sh <PR_NUMBER> [--repo OWNER/REPO] [--format json|table|minimal] [--limit N]
#
# If --repo is omitted, the script infers it from the current git repository.
# Requires: gh (GitHub CLI), jq

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
FORMAT="table"
LIMIT=100
REPO=""
PR_NUMBER=""

# ── Parse arguments ───────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") <PR_NUMBER> [OPTIONS]

Fetch unresolved review comments from a GitHub Pull Request.

Options:
  --repo OWNER/REPO   Repository (default: inferred from git remote)
  --format FORMAT     Output format: json | table | minimal (default: table)
  --limit N           Max review threads to fetch (default: 100)
  -h, --help          Show this help message

Examples:
  $(basename "$0") 42
  $(basename "$0") 42 --repo octocat/hello-world --format json
  $(basename "$0") 42 --format minimal
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    --repo)    REPO="$2"; shift 2 ;;
    --format)  FORMAT="$2"; shift 2 ;;
    --limit)   LIMIT="$2"; shift 2 ;;
    *)
      if [[ -z "$PR_NUMBER" && "$1" =~ ^[0-9]+$ ]]; then
        PR_NUMBER="$1"; shift
      else
        echo "Error: Unknown argument '$1'" >&2; exit 1
      fi
      ;;
  esac
done

if [[ -z "$PR_NUMBER" ]]; then
  echo "Error: PR number is required." >&2
  echo "Run '$(basename "$0") --help' for usage." >&2
  exit 1
fi

# ── Resolve repository ────────────────────────────────────────────────────────
if [[ -z "$REPO" ]]; then
  REPO=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null || true)
  if [[ -z "$REPO" ]]; then
    echo "Error: Could not detect repository. Use --repo OWNER/REPO." >&2
    exit 1
  fi
fi

OWNER="${REPO%%/*}"
REPO_NAME="${REPO##*/}"

# ── GraphQL query ─────────────────────────────────────────────────────────────
QUERY='
query($owner: String!, $repo: String!, $pr: Int!, $limit: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      title
      url
      reviewThreads(first: $limit) {
        totalCount
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          comments(first: 10) {
            nodes {
              body
              author { login }
              createdAt
              updatedAt
              url
            }
          }
        }
      }
    }
  }
}
'

# ── Execute query ─────────────────────────────────────────────────────────────
RESULT=$(gh api graphql \
  -f query="$QUERY" \
  -F owner="$OWNER" \
  -F repo="$REPO_NAME" \
  -F pr="$PR_NUMBER" \
  -F limit="$LIMIT" 2>&1) || {
  echo "Error: GraphQL query failed." >&2
  echo "$RESULT" >&2
  exit 1
}

# ── Filter unresolved threads ─────────────────────────────────────────────────
PR_TITLE=$(echo "$RESULT" | jq -r '.data.repository.pullRequest.title // "Unknown"')
PR_URL=$(echo "$RESULT" | jq -r '.data.repository.pullRequest.url // ""')
TOTAL_THREADS=$(echo "$RESULT" | jq '.data.repository.pullRequest.reviewThreads.totalCount // 0')

UNRESOLVED=$(echo "$RESULT" | jq '[
  .data.repository.pullRequest.reviewThreads.nodes[]
  | select(.isResolved == false)
  | {
      threadId: .id,
      path,
      line,
      startLine,
      isOutdated,
      comments: [.comments.nodes[] | {
        author: .author.login,
        body,
        createdAt,
        updatedAt,
        url
      }]
    }
]')

UNRESOLVED_COUNT=$(echo "$UNRESOLVED" | jq 'length')

# ── Output ────────────────────────────────────────────────────────────────────
case "$FORMAT" in
  json)
    jq -n \
      --arg title "$PR_TITLE" \
      --arg url "$PR_URL" \
      --argjson total "$TOTAL_THREADS" \
      --argjson unresolved_count "$UNRESOLVED_COUNT" \
      --argjson threads "$UNRESOLVED" \
      '{
        pr_title: $title,
        pr_url: $url,
        total_review_threads: $total,
        unresolved_count: $unresolved_count,
        unresolved_threads: $threads
      }'
    ;;

  minimal)
    echo "PR #${PR_NUMBER}: ${PR_TITLE}"
    echo "Unresolved: ${UNRESOLVED_COUNT} / ${TOTAL_THREADS} threads"
    echo ""
    echo "$UNRESOLVED" | jq -r '.[] |
      "• \(.path):\(.line // "N/A") — @\(.comments[0].author): \(.comments[0].body | split("\n")[0] | if length > 80 then .[:80] + "..." else . end)"
    '
    ;;

  table|*)
    echo "═══════════════════════════════════════════════════════════════"
    echo "  PR #${PR_NUMBER}: ${PR_TITLE}"
    echo "  ${PR_URL}"
    echo "  Unresolved: ${UNRESOLVED_COUNT} / ${TOTAL_THREADS} review threads"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""

    if [[ "$UNRESOLVED_COUNT" -eq 0 ]]; then
      echo "  ✅ All review threads are resolved!"
      exit 0
    fi

    echo "$UNRESOLVED" | jq -r '
      to_entries[] |
      "───────────────────────────────────────────────────────────────\n" +
      "  Thread #\(.key + 1)  │  \(.value.path):\(.value.line // "N/A")" +
      (if .value.isOutdated then "  [outdated]" else "" end) +
      "\n───────────────────────────────────────────────────────────────\n" +
      (.value.comments[] |
        "  @\(.author) (\(.createdAt | split("T")[0])):\n" +
        "  \(.body | gsub("\n"; "\n  "))\n" +
        "  🔗 \(.url)\n"
      )
    '
    ;;
esac
