# pi-review

Pi extension providing code-review commands powered by GitHub and SonarCloud.

## Extensions

| Entry | Description |
|---|---|
| `review/review.ts` | `/review` — agent-driven code review for uncommitted changes, branches, commits, PRs, or custom instructions |
| `sonarqube/sonarqube.ts` | `/sonarqube` — fetch SonarCloud coverage gaps and quality issues for a PR |
| `pr-quality/index.ts` | `/pr-quality` — combined GitHub unresolved threads + SonarCloud analysis; auto-resolves invalid threads |

## Usage

```
/review                     — pick review mode interactively
/review pr <number>         — review a specific PR
/sonarqube <pr-number>      — SonarCloud analysis for a PR
/pr-quality <pr-number>     — full PR quality pass (threads + SonarCloud)
```
