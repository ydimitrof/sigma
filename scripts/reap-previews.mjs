#!/usr/bin/env node
// Reap ephemeral preview workers that have outlived the preview max-lifetime (default 5 days).
//
// Workers have no "stop/start" — a deployed Worker costs nothing while idle, so the lifecycle is:
//   start  = preview.yml deploys <prefix>-<n> on each push to an open same-repo PR
//   stop   = this reaper DELETES <prefix>-<n> once it has gone PREVIEW_MAX_AGE_DAYS without a redeploy
//   re-start = the next push to that PR redeploys it (preview.yml on `synchronize`)
//
// It catches two things merge/close teardown (preview.yml) does not:
//   1. idle-but-open PR previews older than the max age, and
//   2. orphans whose PR already closed but whose teardown step failed.
//
// SCOPE: the Cloudflare account is SHARED with the other forks of midt-bg/sigma, and the listing below
// returns every worker on it. Only workers matching this repository's owner-derived prefix are ever
// considered — see scripts/preview-name.mjs and docs/dev-environments.md. Without that, this repo's
// scheduled reaper would delete another fork's live previews.
//
// Dry-run by default; pass --apply to actually delete. Scheduled by .github/workflows/preview-reap.yml.
//
// env:  CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (required); GITHUB_REPOSITORY_OWNER or
//       PREVIEW_WORKER_PREFIX (required, for the prefix); PREVIEW_MAX_AGE_DAYS (optional, default 5)
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { previewPrNumber, previewPrefixFromEnv } from './preview-name.mjs';
import { deleteWorker, isEphemeralPreviewName } from './teardown-remote.mjs';

const CF_API = 'https://api.cloudflare.com/client/v4';
const DAY_MS = 24 * 60 * 60 * 1000;

// Pure: pick the ephemeral preview workers older than maxAgeDays. Unknown/unparseable `modified_on`
// is left alone rather than risk reaping a worker whose age we can't establish.
export function selectStale(scripts, { maxAgeDays, nowMs, prefix }) {
  const cutoff = nowMs - maxAgeDays * DAY_MS;
  const stale = [];
  for (const s of scripts) {
    if (!isEphemeralPreviewName(s?.id, prefix)) continue;
    const modifiedMs = Date.parse(s.modified_on);
    if (!Number.isFinite(modifiedMs)) continue;
    if (modifiedMs < cutoff) {
      stale.push({ name: s.id, modifiedOn: s.modified_on, ageDays: (nowMs - modifiedMs) / DAY_MS });
    }
  }
  return stale;
}

// Bound the page walk so a misbehaving API can never hang the scheduled reaper.
const MAX_PAGES = 1000;

export async function listWorkerScripts({ accountId, token, fetchImpl = fetch }) {
  // The CF API may paginate workers/scripts (~100 per page). Walk every page via the cursor, or a
  // busy account silently hides older preview workers from the reaper — leaking them forever.
  // Guard against an API that returns a stable/repeating cursor (or ignores the param): bail on a
  // cursor we've already seen and cap total pages, so the loop always terminates.
  const scripts = [];
  const seen = new Set();
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${CF_API}/accounts/${accountId}/workers/scripts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      throw new Error(
        `Cloudflare API list scripts failed (${res.status}): ${JSON.stringify(body.errors ?? body)}`,
      );
    }
    scripts.push(...(body.result ?? []));
    cursor = body.result_info?.cursor ?? '';
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
  }
  return scripts;
}

// Delete each stale preview when `apply`; dry-run just logs. Returns the names actually reaped and a
// hard-failure count. `del` is injected so the apply loop is unit-testable without touching wrangler.
export function reapStale(
  stale,
  { apply, del = deleteWorker, log = console.log, errLog = console.error } = {},
) {
  const reaped = [];
  let hardFailures = 0;
  for (const s of stale) {
    log(`==> reaping ${s.name} (age ${s.ageDays.toFixed(1)}d, last deploy ${s.modifiedOn})`);
    if (!apply) continue;
    try {
      const result = del(s.name);
      // Only an actual delete counts as reaped. 'already-gone' (the worker vanished between list and
      // delete) must not trigger a misleading "reaped after Nd" comment on its PR.
      if (result === 'deleted') reaped.push(s.name);
    } catch (err) {
      hardFailures += 1;
      errLog(`!! failed to reap ${s.name}: ${err.message}`);
    }
  }
  return { reaped, hardFailures };
}

// Pair each reaped worker with the PR it belongs to, so the workflow's comment step never has to
// re-derive the name pattern. Deriving it there is how a renamed preview gets silently deleted with
// its PR never notified — the pattern lives in preview-name.mjs and nowhere else.
export function reapedPullRequests(reaped, prefix) {
  const pairs = [];
  for (const worker of reaped) {
    const pr = previewPrNumber(worker, prefix);
    if (pr !== null) pairs.push({ worker, pr });
  }
  return pairs;
}

function arg(args, name) {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

async function main(argv) {
  const args = argv.slice(2);
  const apply = args.includes('--apply');
  // `arg` returns boolean `true` for a bare `--max-age-days` (no `=value`); reject it rather than
  // letting Number(true) silently coerce to 1 day.
  const rawMaxAge = process.env.PREVIEW_MAX_AGE_DAYS || arg(args, 'max-age-days') || 5;
  if (rawMaxAge === true) {
    console.error('reap-previews: --max-age-days requires a value, e.g. --max-age-days=5.');
    process.exit(2);
  }
  const maxAgeDays = Number(rawMaxAge);
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    console.error(`reap-previews: invalid max age "${maxAgeDays}" days.`);
    process.exit(2);
  }

  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    console.error('reap-previews: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.');
    process.exit(2);
  }

  let prefix;
  try {
    prefix = previewPrefixFromEnv();
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const scripts = await listWorkerScripts({ accountId, token });
  const previews = scripts.filter((s) => isEphemeralPreviewName(s?.id, prefix));
  const stale = selectStale(scripts, { maxAgeDays, nowMs: Date.now(), prefix });
  console.log(
    `==> ${scripts.length} worker(s) on the account; ${previews.length} match "${prefix}-<number>"; ` +
      `${stale.length} older than ${maxAgeDays}d${apply ? '' : '  (dry run — pass --apply to delete)'}`,
  );

  const { reaped, hardFailures } = reapStale(stale, {
    apply,
    del: (name) => deleteWorker(name, { prefix }),
  });

  // Hand the reaped previews to the workflow so it can notify the corresponding open PRs.
  if (process.env.GITHUB_OUTPUT) {
    const pairs = reapedPullRequests(reaped, prefix);
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `reaped=${reaped.join(',')}\nreaped_json=${JSON.stringify(pairs)}\n`,
    );
  }

  console.log(`==> done — ${reaped.length} reaped, ${hardFailures} failed.`);
  if (hardFailures > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv).catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}
