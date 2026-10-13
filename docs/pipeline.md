# Automated Agent Pipeline

This document describes the full automated pipeline that takes a GitHub issue from
creation to a merged PR — and then advances to the next issue — without human
intervention in the happy path.

---

## Overview

```
Human: merge PR #2 (one-time kick-off)
              │
              ▼
   ┌─────────────────────┐
   │   advance-queue     │  fires on every claude/issue-* merge
   │   (agent-advance-   │  finds next open issue → adds `auto` label
   │    queue.yml)       │
   └──────────┬──────────┘
              │ `auto` label added to issue #N
              ▼
   ┌─────────────────────┐
   │    Implementer      │  reads issue + all comments (incl. failure context)
   │  (agent-implement   │  writes code + tests, runs checks on runner
   │   .yml / Opus)      │  opens PR (never merges it)
   └──────────┬──────────┘
              │ PR opened on branch claude/issue-N
              ▼
   ┌──────────────────────────────────────┐
   │  CI                  Agent - Review  │  run in parallel
   │  (ci.yml)            (agent-review   │
   │  ruff, alembic,      .yml / Sonnet)  │
   │  pytest, eslint,     issue = spec,   │
   │  next build          REVIEW.md rules │
   │                      PASS or BLOCK   │
   └──────────────────────────────────────┘
              │
        ┌─────┴──────┐
        │            │
      PASS         FAIL
        │            │
        ▼            ▼
  agent-merge   auto-retry
   (squash)      (agent-auto-
        │         retry.yml)
        │            │
        │     ┌──────┴───────┐
        │     │              │
        │  retry < 3     retry = 3
        │     │              │
        │     │          needs-human
        │     │          label added
        │     │          → pipeline
        │     │            pauses
        │     ▼
        │  close PR, delete branch,
        │  post failure context on issue,
        │  re-add `auto` → implementer re-runs
        │
        ▼
   advance-queue fires
   → next issue labeled `auto`
   → cycle repeats
```

---

## Workflows

| File | Trigger | Role |
|---|---|---|
| `agent-implement.yml` | `auto` label added to issue | Implements the issue and opens a PR; fails (and retries) if the run left no PR and no comment |
| `ci.yml` | PR opened / updated | Lint, migrations, tests, frontend build |
| `agent-review.yml` | PR opened / updated | Read-only review against the linked issue and `REVIEW.md` — inline comments, PASS or BLOCK |
| `agent-merge.yml` | CI or Review run completed | Merges a `claude/issue-*` PR once CI and the review both passed on its head commit |
| `agent-auto-retry.yml` | CI or Review workflow fails | Closes PR, posts failure context, re-triggers implementer |
| `agent-advance-queue.yml` | `claude/issue-*` PR merged | Labels the next open issue `auto` |
| `notify-merge.yml` | Any PR merged | Slack notification |

---

## Issue labels

| Label | Meaning |
|---|---|
| `auto` | Issue is in the pipeline — implementer will run (or is running) |
| `retry-1` / `retry-2` / `retry-3` | How many auto-retry attempts have been made |
| `needs-human` | Max retries (3) exceeded — pipeline paused, human action required |
| `no-auto` | Issue is excluded from the automated queue |
| `epic` | Tracking issue — excluded from the automated queue |

---

## Issue selection order

`agent-advance-queue.yml` picks issues in **ascending numeric order**, excluding:

- Issues already labeled `auto` (in progress)
- Issues labeled `needs-human`, `epic`, or `no-auto`
- Issues whose title starts with `Epic:` (catches epic tracking issues without a label)

---

## GitHub Setup (required before first run)

### 1. Repository secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | What it is | How to create |
|---|---|---|
| `PIPELINE_PAT` | Personal Access Token used to re-add the `auto` label (so it fires the `issues:labeled` trigger) and to merge passing PRs (so the merge fires the Advance Queue) | See note below |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token that authenticates the Claude Code GitHub Action | Generate at [claude.ai/settings](https://claude.ai/settings) under **Claude Code → GitHub Actions** |
| `SLACK_WEBHOOK_URL` | Incoming webhook URL for merge/pipeline notifications | Create an Incoming Webhook app in your Slack workspace |

#### Why `PIPELINE_PAT` is required (not just `GITHUB_TOKEN`)

GitHub **silently suppresses** workflow triggers caused by the built-in `GITHUB_TOKEN`. When `advance-queue` or `auto-retry` add the `auto` label using `GITHUB_TOKEN`, the `issues:labeled` event is never dispatched — so `agent-implement.yml` never fires. A PAT belonging to a real user (or a dedicated machine user) bypasses this restriction and correctly triggers the downstream workflow.

**Required PAT scopes:**
- `repo` — full repository access (needed to add/remove labels and trigger events)

**Recommended:** create a dedicated GitHub machine account (e.g. `your-org-bot`), grant it write access to the repo, and generate the PAT from that account so pipeline actions are not tied to a personal account.

### 2. Repository settings

None are required. `agent-merge.yml` is the merge gate, so the pipeline needs
neither **Allow auto-merge** nor branch protection, which a private repository on
GitHub's free plan cannot have. If your plan allows it, protecting `main` with the
`backend`, `frontend` and `review` checks is an extra safeguard against a human
merging a blocked PR by hand.

### 3. Issue labels

Create these labels in **Issues → Labels** (the workflows expect them to exist):

| Label | Suggested color |
|---|---|
| `auto` | `#0075ca` (blue) |
| `retry-1` | `#e4e669` (yellow) |
| `retry-2` | `#e4a232` (orange) |
| `retry-3` | `#d93f0b` (red) |
| `needs-human` | `#b60205` (dark red) |
| `no-auto` | `#cccccc` (grey) |
| `epic` | `#7057ff` (purple) |

---

## How to start the pipeline

1. Complete the GitHub Setup steps above.

2. Merge the current open PR to kick off the first advance-queue run.

3. Watch Slack — each issue will be announced as it triggers.

---

## Handling a `needs-human` escalation

When an issue hits 3 consecutive failures:

1. The issue gets a `needs-human` label and a comment with the full failure history.
2. The pipeline stops for that issue.

To resume:

1. Read the failure context comments on the issue.
2. Either fix the issue description (clarify requirements) or push a manual fix to the
   branch (if you want to salvage the partial work).
3. Remove the `needs-human` label.
4. Re-add the `auto` label — the implementer will run again (retry count resets because
   the auto-retry counter only increments on consecutive failures without a human touch).

---

## Excluding an issue from the queue

Add the `no-auto` label to any issue you want to skip in the automated run. You can
re-add `auto` manually whenever you want to process it.

---

## Architecture notes

- **Concurrency**: `agent-auto-retry.yml` uses a concurrency group keyed on the branch
  name (`auto-retry-claude/issue-N`). If CI and the Reviewer both fail simultaneously,
  the second retry run is queued rather than racing. The second run finds no open PR
  (already closed by the first) and exits gracefully.
- **Failure context**: Retry comments are posted on the **issue** (not the PR) so the
  Implementer can read them on the next run via `gh issue view --comments`.
- **Branch lifecycle**: Each implementer run creates `claude/issue-N` from `main`.
  On failure, the retry workflow closes the PR and deletes the branch before re-triggering,
  so the implementer always starts from a clean branch off the latest `main`.
- **Merge gate**: the implementer never merges (`gh pr merge` is in its disallowed
  tools). `agent-merge.yml` runs after every CI and Agent - Review run, checks that
  the latest run of both passed on the PR's current head commit, and squash-merges
  with `--match-head-commit`, so a commit pushed after the checks is never merged
  unchecked. It deletes the branch on merge. It and `agent-auto-retry.yml` ignore
  branches from forks, which can also be named `claude/issue-N`.
- **Reviewer inputs**: the review workflow saves the issue(s) the PR closes to
  `.review-context/linked-issues.md`; that is the spec the Reviewer checks. `REVIEW.md`
  supplies the project's invariants. A missing verdict fails the check (fail-closed);
  a `review-verdict.txt` committed in the PR is deleted before the Reviewer runs.

---

## Generic vs project-specific files

The pipeline is split so it can be copied into a project created from this
template, or into an existing one, without rewriting it.

| Kind | Files | What to do |
|---|---|---|
| Generic | `.claude/agents/reviewer.md`, `agent-review.yml`, `agent-merge.yml`, `agent-auto-retry.yml`, `agent-advance-queue.yml`, `agent-plan.yml`, `claude.yml`, `notify-merge.yml`, `.github/actions/slack-notify/`, `design/refs/README.md` | Copy as-is |
| Stack-dependent | `.claude/agents/implementer.md`, `.claude/agents/planner.md`, `agent-implement.yml` | Copy, then adjust the toolchain: setup steps and check commands in `agent-implement.yml`, and the Alembic / pytest / pnpm mentions in the two agents |
| Project-specific | `REVIEW.md`, `CLAUDE.md`, `ci.yml`, `.github/ISSUE_TEMPLATE/` | Write per project. `REVIEW.md` keeps its structure (IDs, severities, path map, "Do not flag") and grows from the project's own bugs |

Everything the agents need to know about a project comes from `CLAUDE.md` and
`REVIEW.md`; the generic files never name the project.
