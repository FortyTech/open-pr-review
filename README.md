# open-pr-review

Automated AI code review on every pull request across a whole GitHub
organisation — from **one** central repository. No workflow file is added to
any of the repos being reviewed.

It runs on a **Claude subscription** rather than a metered API key. That is the
main thing that distinguishes it from the other self-hosted reviewers: they all
want pay-as-you-go tokens on top of whatever you already pay.

---

## Why it looks like this

A GitHub workflow can only be triggered by events **in its own repository**.

That single rule rules out the obvious design. You cannot put one workflow
somewhere central and have it listen for pull requests elsewhere. The only
inbound cross-repo trigger is a workflow dispatch, and something outside GitHub
has to make that call.

Hence the detour out of GitHub and back in:

```
PR opened in any repo in your org
        │
        ▼
  org-level webhook            one setup, covers every repo, present and future
        │
        ▼
  webhook handler              verify signature, filter noise   (Vercel, 40 lines)
        │
        ▼
  workflow_dispatch  ─────▶  this repo
        │
        ▼
  check out rules + the PR's source at the dispatched commit
        │
        ▼
  Claude reviews  ─────▶  inline comments on the PR
```

**The trigger is repo-bound. The reach is credential-bound.** That sentence is
the whole architecture.

### Why `workflow_dispatch` and not `repository_dispatch`

Both start the workflow. They differ in the permission the caller needs:

| | Token needs | Which means |
|---|---|---|
| `repository_dispatch` | Contents: **write** | push access to this repo, including to the workflow file that reads your org-wide token |
| `workflow_dispatch` | Actions: **write** | start the workflow, and nothing else |

The handler sits on a public URL. Giving it push access to the repository
holding your credentials is more authority than the job needs.

---

## What it does beyond "post some comments"

- **Reads around the diff.** The PR's full source is checked out at the
  reviewed commit, at full depth, so findings can cite callers and existing
  conventions instead of guessing from the hunks.
- **Never runs the code.** Tools are restricted to reading. The runner holds a
  token with pull-request write access to your whole org; it has no business
  executing a contributor's branch.
- **Doesn't repeat itself.** Prior findings are fed back in, so later pushes
  report what changed rather than restating everything.
- **Skips commits it has already reviewed**, via an invisible marker in its own
  review bodies. The pull request is the state store — there is no database.
- **Marks findings that no longer apply**, and closes those threads where the
  credential allows it.
- **Fails loudly.** A crashed run posts a comment saying so. A silent reviewer
  is indistinguishable from a clean bill of health, and that is the worst
  possible failure mode.

---

## Setup

### 1. Deploy this repo

Fork or clone it into your own org, then deploy it to Vercel (or anywhere that
can host a Next.js route). The only live surface is
`POST /api/github-webhook`.

### 2. Secrets on the repo

| Secret | What it is |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Run `claude setup-token` locally. Uses your Claude subscription |
| `ORG_REVIEW_TOKEN` | Fine-grained PAT, owner = your org, all repositories: Contents `read`, Pull requests `write`, Metadata `read` |

To use a metered API key instead, swap `claude_code_oauth_token` for
`anthropic_api_key` in `.github/workflows/review.yml`. Other providers work the
same way — see the `claude-code-action` docs for the input names.

### 3. Environment variables on the deployment

| Variable | Purpose |
|---|---|
| `WEBHOOK_SECRET` | Shared secret for the org webhook. `openssl rand -hex 32` |
| `WORKFLOW_REPO` | This repo, as `owner/name` |
| `DISPATCH_TOKEN` | Fine-grained PAT scoped to **this repo only**, Actions `write`. Leave unset to verify and log without triggering anything |
| `WORKFLOW_REF` | Branch to run the workflow from. Default `main` |
| `REVIEW_REPOS` | Optional comma-separated allowlist while you roll out. Unset means every repo |
| `SKIP_AUTHORS` | Optional. Defaults to dependabot / renovate / github-actions |

### 4. The org webhook

Organisation settings → Webhooks → Add webhook.

- **Payload URL:** your deployment, `/api/github-webhook`
- **Content type:** `application/json` — **not** the default
- **Secret:** your `WEBHOOK_SECRET`
- **Events:** Pull requests only

### 5. Prove it before switching it on

Fire the workflow by hand first, so you are debugging one thing rather than four:

```bash
gh workflow run review.yml --repo OWNER/open-pr-review \
  -f repo=OWNER/some-repo -f number=12 -f sha=<head sha>
```

Once comments land on that PR, add `DISPATCH_TOKEN` and redeploy.

---

## Four ways this fails silently

Every one of these cost real time to find.

1. **The workflow isn't on the default branch.** Dispatch is accepted, returns
   204, and nothing runs. No error anywhere.
2. **The webhook content type is left as `form`.** The signature still
   *verifies*, because it covers the raw bytes either way — so this is not an
   auth failure, however much it looks like one. It surfaces later as a 500 at
   the JSON parse.
3. **The signature is checked against re-serialised JSON.** Parsing and
   re-stringifying reorders keys and breaks every digest. Verify the raw body.
4. **Only one checkout.** With just the diff and no surrounding source, the
   reviewer cannot see callers and starts inventing problems.

---

## `REVIEW.md` is the actual product

The plumbing is written once and then left alone. `REVIEW.md` is what decides
whether the output is worth reading, and it only gets good by being rewritten
against real reviews for a couple of weeks.

The example here is a starting point. Tune what counts as blocking versus a
nit, cap the nits, list what to skip, and set the standard of evidence required
before a finding is posted.

---

## Known limitation

Resolving a review thread is a GraphQL-only operation and is **not available to
fine-grained personal access tokens** — the mutation returns *"Resource not
accessible by personal access token"* regardless of permissions. Until this
runs as a GitHub App, a fixed finding gets a ✅ reply in its thread instead of
the thread being closed.

## Licence

MIT.
