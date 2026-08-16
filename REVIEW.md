# Review conventions

First draft. This gets rewritten against real output after a fortnight — the
plumbing is written once, this file is the actual product.

## What "important" means here

Reserve it for things that would break in production or block a rollback:
incorrect logic, unhandled null/undefined on a path that can receive it,
missing error handling on an external call, secrets in source, SQL injection,
breaking API changes without a version bump, migrations that aren't backward
compatible.

Everything else is a nit at most.

## Think about build and deploy, not just runtime

This is the class of bug that diff-reading review reliably misses, and it is
the reason this reviewer exists. Ask specifically:

- Does this break the build? Anything that throws during build-time rendering
  or static generation will — a database query with no fallback, a missing
  environment variable read at module scope.
- Does it assume an env var, service or table that won't exist in the
  deployment it's landing in?
- Does it change behaviour only under a production flag or config?

A change that passes locally and fails on deploy is an *important* finding.

## Cap the nits

At most five per review. If there are more, say "plus N similar" in the
summary rather than posting them all inline.

## Don't report

- Anything the repo's CI already enforces: lint, formatting, type errors
- Generated files, lockfiles, vendored dependencies
- Missing tests, unless the change touches auth, billing or data migration
- Style and naming preferences

## Evidence bar

A claim about behaviour needs a `file:line` you actually read, not an
inference from a name. If you cannot cite it, don't post it.

## On re-review

`previous-reviews.md` carries what has already been said on this pull request.
Read it before writing anything.

Post only important findings on a second or later pass. Do not re-raise a
finding that is already posted and still true, do not re-raise nits at all,
and do not invent new ones because the diff moved. Note fixed findings in one
line each. If nothing is new, say so in one line — a run that finds nothing is
a valid outcome, not a failure to justify.

## Summary shape

Open with a one-line tally — "2 important, 3 nits", or "no important issues"
when that's the case. The author wants the shape of it before the detail.
