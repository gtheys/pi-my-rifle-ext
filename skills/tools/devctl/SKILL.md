---
name: devctl
description: >
  Guide for using the `devctl` CLI to manage the SalaryHero local Kubernetes
  development environment (minikube-based). Use this skill whenever someone
  asks about: starting or stopping services locally, bootstrapping the dev
  environment, rebuilding a service image, watching for code changes, streaming
  pod logs, shelling into a pod, checking deployed image tags, managing /etc/hosts
  entries, running database migrations locally, or syncing/cloning all SalaryHero
  GitHub repositories. Also use it when someone asks "how do I deploy X locally",
  "why is my service not updating", "how do I get the local env running", or
  "how do I clone all repos". Covers first-time setup through day-to-day workflows.
---

# devctl — SalaryHero Local Dev Tool

`devctl` wraps minikube + kubectl + kustomize into one CLI for running the
SalaryHero stack locally. All services live in the `salaryhero-local` namespace
by default.

## Critical env var

```bash
export DEVCTL_INFRA_DIR=/path/to/infra   # clone of the infra repo
```

Without this, kustomize overlays will not be found. Add it to your shell profile.

---

## Available services

`account-api`, `account-worker`, `auth-api`, `bank-api`, `bank-worker`,
`balance-worker`, `company-service`, `console`, `flexben-api`, `flexben-worker`

---

## Command reference

### bootstrap — full first-time setup

```bash
devctl bootstrap                    # build images + deploy all services + hosts
devctl bootstrap account-api        # bootstrap a single service
devctl bootstrap --no-build         # deploy only (skip image builds)
devctl bootstrap --no-hosts         # skip /etc/hosts setup
devctl bootstrap --no-wait          # don't wait for pods to be ready
devctl bootstrap --force            # redeploy even if already running
devctl bootstrap --namespace dev-alice  # isolated namespace
```

Bootstrap does: check minikube, create namespace, build images, deploy via
kustomize, write `/etc/hosts` entries, wait for pods ready. All three of
`--build`, `--hosts`, and `--wait` default to `true`; negate any with `--no-<flag>`.

### start — deploy / redeploy

```bash
devctl start                        # start all services (no rebuild)
devctl start account-api            # start one service
devctl start account-api --build    # build image first, then deploy
devctl start --no-cache             # rebuild without Docker layer cache (implies --build)
devctl start account-api --tag main-a1b2c3d4  # pin a specific image tag
```

Image tag defaults to `<branch>-<shortSHA>` read from the **service's own git
repo** (e.g. `../account-api`), not the infra repo.

When `--build` is used, a rollout restart is forced even if kustomize manifests
are unchanged — this is necessary when the pod is in `ImagePullBackOff`.

### stop

```bash
devctl stop                         # stop all services
devctl stop account-api bank-api    # stop specific services
```

### watch — file-watching auto-rebuild

```bash
devctl watch                        # watch all services for file changes
devctl watch account-api            # watch one service
```

Detects changes in each service's `WatchPaths`, rebuilds the image, and
redeploys automatically.

### logs

```bash
devctl logs account-api             # stream logs
devctl logs account-api -f          # follow (same as above, -f is default)
```

### shell — exec into a pod

```bash
devctl shell account-api            # interactive shell
devctl shell account-api -- ls /app # run a single command
```

### image verify — inspect deployed tags

```bash
devctl image verify                 # show image + git branch/SHA for all services
```

### hosts — manage /etc/hosts

```bash
devctl hosts apply                  # write *.localdev.test entries (needs sudo or write perm)
devctl hosts show                   # print what would be written
devctl hosts plan                   # dry-run
devctl hosts remove                 # remove entries
```

### migrate — database migrations

```bash
devctl migrate                      # run DB migrations
```

> Note: prefer `sh-db-schema` over `devctl migrate` for schema changes.

### sync — clone or update all SalaryHero repos

```bash
devctl sync                         # clone missing repos, pull updates for existing ones
devctl sync --path ~/projects       # override checkout directory for this run
devctl sync --verbose               # show branch, upstream ref, and pull summary per repo
devctl sync --config ~/my.json      # use a custom config file
```

On first run creates `~/.config/devctl/sync.json` with all known repos
pre-populated. Edit that file to add or remove repos.

**Config file** (`~/.config/devctl/sync.json`):
```json
{
  "org": "salaryhero",
  "checkout_path": "~/Code/salaryhero",
  "repos": ["account-api", "auth-api", "..."]
}
```

**Update behaviour per repo:**
- Runs `git fetch --all --prune` first (always safe)
- If current branch has a remote upstream → `git pull --ff-only`
- If no upstream (orphaned feature branch) → checks out `develop` and pulls
- Always prints the current branch name so you know where each repo stands

---

## First-time setup

```bash
# 1. Start minikube
minikube start
minikube addons enable ingress

# 2. Install trusted TLS certs (once per machine — close browser first)
bash scripts/setup-local-tls.sh install
# Restart browser after

# 3. Set infra dir
export DEVCTL_INFRA_DIR=/path/to/infra

# 4. Bootstrap everything
devctl bootstrap
```

After a cluster reset (cert already exists):

```bash
bash scripts/setup-local-tls.sh apply
devctl bootstrap
```

---

## Daily workflow

```bash
minikube start          # if stopped overnight
devctl start            # or just the services you need
devctl watch account-api  # leave running while editing code
```

---

## GitHub token (private npm packages)

Resolution order:
1. `--gh-token` flag
2. `GH_TOKEN` env var
3. `GITHUB_TOKEN` env var
4. `gh auth token` (if `gh` CLI is authenticated)

---

## Namespace isolation

```bash
devctl bootstrap --namespace dev-alice
devctl watch --namespace dev-alice
devctl logs account-api --namespace dev-alice
```

All commands accept `--namespace` / `-n`.

---

## SQS / LocalStack scripts

```bash
bash scripts/add-sqs-queues.sh recreate-all           # create all standard queues
bash scripts/add-sqs-queues.sh create my-queue        # single queue
bash scripts/add-sqs-queues.sh create my-q my-q-dlq   # queue + dead-letter queue
bash scripts/add-sqs-queues.sh list                   # list queues
bash scripts/add-sqs-queues.sh messages my-q peek     # inspect messages
bash scripts/add-sqs-queues.sh messages my-q purge    # purge messages
```

---

## Common problems

| Symptom | Fix |
|---|---|
| Pod stuck in `ImagePullBackOff` after `devctl start` | Use `devctl start --build` to force a rebuild and rollout restart |
| Kustomize paths wrong / "overlay not found" | Check `DEVCTL_INFRA_DIR` is set and points to the `infra` repo |
| Browser shows CORS error on `*.localdev.test` | Self-signed cert rejected — run `bash scripts/setup-local-tls.sh install` and restart browser |
| `devctl hosts apply` fails with permission error | Needs write access to `/etc/hosts`; run with sudo or grant user permission |
| Image tag is `dev` instead of branch-SHA | `devctl` could not read git info from the service repo — ensure the service repo exists at `../service-name` relative to infra |
| `account-worker` not updating after account-api build | They share an image; rebuilding `account-api` also rebuilds the worker — start both |
| `sync` clone fails with "Could not resolve to a Repository" | Repo name in `~/.config/devctl/sync.json` doesn't match GitHub — fix the name and re-run |
| `sync` pull fails with merge conflicts | devctl only fast-forwards; resolve the conflict manually then re-run `devctl sync` |
| `sync` reports "could not checkout develop" | Repo has no `develop` branch (some use `main`) — check out the correct branch manually |

---

## Building devctl itself

```bash
cd /path/to/sh-devctl
make build          # produces ./devctl binary
make install-local  # installs to ~/.local/bin (no sudo)
make install        # installs to /usr/local/bin (sudo required)
make test           # run tests
```
