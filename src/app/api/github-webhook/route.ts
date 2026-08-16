import { createHmac, timingSafeEqual } from 'node:crypto';

// crypto + raw body handling: this must not run on the edge runtime.
export const runtime = 'nodejs';

/**
 * Where the review workflow lives, and which branch to run it from — i.e.
 * your own deployment of this repo, as `owner/name`.
 */
const WORKFLOW_REPO = process.env.WORKFLOW_REPO ?? '';
const WORKFLOW_FILE = process.env.WORKFLOW_FILE ?? 'review.yml';
const WORKFLOW_REF = process.env.WORKFLOW_REF ?? 'main';

/** PR actions worth reviewing. Everything else (labels, assignment, closes) is noise. */
const REVIEWABLE = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

/**
 * Authors whose pull requests we skip.
 *
 * NOTE: if an automation account opens most of your pull requests, do NOT add
 * it here. Blanket-skipping bot-ish accounts is the obvious default and it
 * will silently review almost nothing. Only genuine dependency noise belongs
 * in this list.
 */
const SKIP_AUTHORS = new Set(
  (process.env.SKIP_AUTHORS ?? 'dependabot[bot],renovate[bot],github-actions[bot]')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

/** Past this, review quality degrades and cost climbs. Reviewed by hand instead. */
const MAX_CHANGED_LINES = 3000;

function verify(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so check that first.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Allowlist during rollout. Unset or empty means every repo in the org. */
function repoAllowed(fullName: string): boolean {
  const raw = process.env.REVIEW_REPOS?.trim();
  if (!raw) return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(fullName);
}

async function handle(rawBody: string, event: string | null): Promise<Response> {

  // Sent once when the webhook is created. Answer it so the UI shows a tick.
  if (event === 'ping') {
    console.log('Ping received — webhook is wired up.');
    return new Response('pong', { status: 200 });
  }

  if (event !== 'pull_request') {
    return new Response('ignored: not a pull_request event', { status: 202 });
  }

  // GitHub's default content type is form encoding, which arrives as
  // `payload=<urlencoded json>` rather than JSON. The signature is over the
  // raw bytes either way, so it verifies happily and the failure only shows up
  // here — as a SyntaxError that says nothing about the real cause.
  if (rawBody.startsWith('payload=')) {
    console.error('Webhook is sending form encoding. Set its content type to application/json.');
    return new Response(
      'content type must be application/json — this webhook is set to ' +
        'application/x-www-form-urlencoded',
      { status: 400 },
    );
  }

  const payload = JSON.parse(rawBody);
  const pr = payload.pull_request;
  const repo: string = payload.repository?.full_name ?? 'unknown';
  const action: string = payload.action;

  const skip =
    !pr ? 'no pull_request in payload'
    : !REVIEWABLE.has(action) ? `action is "${action}"`
    : pr.draft ? 'pull request is a draft'
    : SKIP_AUTHORS.has(pr.user?.login) ? `author is ${pr.user?.login}`
    : !repoAllowed(repo) ? 'repo is not in REVIEW_REPOS'
    : (pr.additions ?? 0) + (pr.deletions ?? 0) > MAX_CHANGED_LINES ? 'diff is too large'
    : null;

  if (skip) {
    console.log(`Skipping ${repo}#${pr?.number} (${action}): ${skip}`);
    return new Response(`skipped: ${skip}`, { status: 202 });
  }

  const target = { repo, number: pr.number, sha: pr.head.sha };

  // Phase 2 runs without DISPATCH_TOKEN: verify, filter and log, but forward
  // nothing. Setting the token turns the bridge on. A missing token is a
  // deliberate no-op rather than a 500, so a half-configured deploy stays quiet
  // instead of erroring on every delivery.
  //
  // The token needs Actions:write on this repo alone -- enough to start the
  // workflow, not enough to alter it. repository_dispatch would have required
  // Contents:write, i.e. push access to the very file holding the org-wide
  // review token.
  const token = process.env.DISPATCH_TOKEN;
  if (!token) {
    console.log('WOULD DISPATCH (DISPATCH_TOKEN unset):', JSON.stringify(target));
    return new Response('accepted: dispatch not configured', { status: 202 });
  }

  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${WORKFLOW_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'open-pr-review-bridge',
        },
        // workflow_dispatch inputs are strings only, hence String(number).
        body: JSON.stringify({
          ref: WORKFLOW_REF,
          inputs: { repo: target.repo, number: String(target.number), sha: target.sha },
        }),
        signal: AbortSignal.timeout(8000),
      },
    );
  } catch (err) {
    // GitHub gives the whole delivery 10s. Failing here loses the review, so
    // say so plainly rather than letting it surface as an opaque platform 500.
    console.error(`Dispatch request threw for ${repo}#${pr.number}:`, err);
    return new Response('dispatch request failed', { status: 502 });
  }

  if (!res.ok) {
    // Log loudly: a failure here means no review, and the PR shows nothing at
    // all — not even the workflow's heartbeat, which never gets to run.
    console.error(`Dispatch failed ${res.status}: ${await res.text()}`);
    return new Response('dispatch failed', { status: 502 });
  }

  console.log(`Dispatched review for ${repo}#${pr.number} @ ${target.sha.slice(0, 7)}`);
  return new Response('dispatched', { status: 202 });
}


/**
 * Authentication first, and deliberately quiet about failures.
 *
 * Reading the body can itself throw — an aborted or malformed request — and
 * that happens before we know who the caller is. Anyone can POST here, so a
 * caller who has not proved they hold the shared secret learns nothing about
 * what went wrong.
 */
export async function POST(req: Request): Promise<Response> {
  if (!WORKFLOW_REPO) {
    console.error('WORKFLOW_REPO is not set — nothing to dispatch to.');
    return new Response('not configured', { status: 500 });
  }

  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.error('WEBHOOK_SECRET is not set — refusing to process the delivery.');
    return new Response('not configured', { status: 500 });
  }

  let rawBody: string;
  try {
    // The signature covers the exact bytes GitHub sent. Parsing to JSON and
    // re-stringifying reorders keys and silently breaks every delivery.
    rawBody = await req.text();
  } catch (err) {
    console.error('Could not read the request body:', err);
    return new Response('bad request', { status: 400 });
  }

  if (!verify(rawBody, req.headers.get('x-hub-signature-256'), secret)) {
    console.warn('Rejected a delivery with a bad or missing signature.');
    return new Response('bad signature', { status: 401 });
  }

  // Past this point the caller holds the shared secret, so it is GitHub.
  // Echoing the cause is safe here, and it means a failed delivery explains
  // itself in the Response tab instead of sending us to the platform logs.
  // GitHub does not retry, so a crash silently loses a review — the delivery
  // still fails loudly, it just says why now.
  try {
    return await handle(rawBody, req.headers.get('x-github-event'));
  } catch (err) {
    console.error('Unhandled error processing a webhook delivery:', err);
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return new Response(`handler error — ${detail}`, { status: 500 });
  }
}
