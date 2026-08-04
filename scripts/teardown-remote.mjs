#!/usr/bin/env node
// Delete a deployed Cloudflare Worker by name. Used to tear down ephemeral per-PR preview workers
// (see .github/workflows/preview.yml) once a pull request closes, and by scripts/reap-previews.mjs to
// enforce the preview max-lifetime. Counterpart to teardown.mjs, which only clears LOCAL miniflare
// state — this one talks to the Cloudflare API and removes a real worker.
//
// usage:
//   node scripts/teardown-remote.mjs --name sigma-ydimitrof-pr-123
//   node scripts/teardown-remote.mjs --name sigma-ydimitrof-pr-123 --dry-run   (default is to apply)
//
// Deliberately scoped to ephemeral preview workers ONLY. Preview environments share the long-lived dev
// D1 and R2 buckets (read-only from the preview worker's perspective), so there is NO per-PR D1/R2 to
// delete — and we must never delete those shared stores from here. Two barriers enforce this: an
// allowlist (only `<prefix>-<number>` may be deleted, where the prefix carries this repo's owner) and
// an explicit denylist of protected names. The owner-derived prefix is also what stops this repo's
// cleanup from reaching another fork's previews on the shared Cloudflare account — see
// scripts/preview-name.mjs and docs/dev-environments.md.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ephemeralPreviewRe, previewPrefixFromEnv } from './preview-name.mjs';

// Long-lived workers an ephemeral-cleanup path must NEVER delete, however it is invoked. The allowlist
// below already excludes these; the explicit set is a second barrier and a readable record of intent.
// Mirrors the environments in docs/deploy.md plus the shared dev workers in docs/dev-environments.md.
export const PROTECTED = new Set([
  'sigma',
  'sigma-etl',
  'sigma-stage',
  'sigma-etl-stage',
  'sigma-dev',
  'sigma-etl-dev',
]);

// Cloudflare returns code 10007 / "workers.api.error.script_not_found" when the script is already
// gone. Match the error name, or 10007 only in its `[code: 10007]` shape — a bare `\b10007\b` could
// coincidentally match unrelated numbers in wrangler output and mask a real teardown failure.
const NOT_FOUND = /script_not_found|code:?\s*10007\b/i;

export function isProtected(name) {
  return PROTECTED.has(name);
}

export function isEphemeralPreviewName(name, prefix = previewPrefixFromEnv()) {
  return typeof name === 'string' && ephemeralPreviewRe(prefix).test(name);
}

// Throws unless `name` is a deletable ephemeral preview worker owned by THIS repo. Pure — no side effects.
export function assertDeletable(name, prefix = previewPrefixFromEnv()) {
  if (!name) {
    throw new Error(
      'teardown-remote: a worker name is required (--name <worker> or SIGMA_WEB_NAME).',
    );
  }
  if (isProtected(name)) {
    throw new Error(`teardown-remote: refusing to delete protected long-lived worker "${name}".`);
  }
  if (!isEphemeralPreviewName(name, prefix)) {
    throw new Error(
      `teardown-remote: "${name}" is not an ephemeral preview worker of this repository (expected ${prefix}-<number>) — refusing to delete.`,
    );
  }
}

// --force avoids the interactive confirmation prompt. Returns wrangler's stdout.
function defaultExec(name) {
  return execFileSync('wrangler', ['delete', '--name', name, '--force'], { encoding: 'utf8' });
}

// Delete one ephemeral preview worker. Returns 'deleted' | 'already-gone' | 'dry-run'.
// Throws via assertDeletable for a protected/foreign/invalid name, and rethrows a hard wrangler failure
// (auth, network, wrong account) — those must NOT be swallowed, or a leaked worker goes unnoticed.
export function deleteWorker(name, { dryRun = false, exec = defaultExec, prefix } = {}) {
  assertDeletable(name, prefix ?? previewPrefixFromEnv());
  if (dryRun) return 'dry-run';
  try {
    const out = exec(name);
    if (out) process.stdout.write(out);
    return 'deleted';
  } catch (err) {
    const output = `${err.stdout || ''}${err.stderr || ''}`;
    if (output) process.stderr.write(output);
    if (NOT_FOUND.test(output)) return 'already-gone';
    throw err;
  }
}

function main(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const flag = (n) => {
    const i = args.indexOf(n);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const name = flag('--name') || process.env.SIGMA_WEB_NAME;

  let prefix;
  try {
    prefix = previewPrefixFromEnv();
    assertDeletable(name, prefix);
  } catch (err) {
    console.error(err.message);
    process.exit(name ? 1 : 2);
  }

  console.log(`==> wrangler delete --name ${name}${dryRun ? '  (dry run)' : ''}`);
  try {
    if (deleteWorker(name, { dryRun, prefix }) === 'already-gone') {
      console.error(`!! "${name}" not found — already gone; treating teardown as done.`);
    }
  } catch {
    console.error(
      `!! delete of "${name}" failed for a reason other than "not found" — the worker may still be live. ` +
        `Not masking this; failing so it gets surfaced.`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv);
}
