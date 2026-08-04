#!/usr/bin/env node
// Ephemeral preview naming — the SINGLE source of truth for what a per-PR preview worker is called.
//
// Every consumer must agree on the name, or a preview leaks: .github/workflows/preview.yml deploys it,
// the teardown job deletes it on PR close, and scripts/reap-previews.mjs deletes it after the max
// lifetime. Three independent copies of a regex is how a renamed preview ends up orphaned forever, so
// the pattern lives here and everything else imports it (see docs/dev-environments.md).
//
// The name carries the REPOSITORY OWNER, not just the PR number:
//
//   ydimitrof/sigma          PR #12 -> sigma-ydimitrof-pr-12
//   lyubomir-bozhinov/sigma  PR #12 -> sigma-lyubomir-bozhinov-pr-12
//
// This repo and the other forks of midt-bg/sigma deploy previews into ONE shared Cloudflare account.
// A bare `sigma-pr-<n>` scheme collides across forks on the same PR number — the second deploy silently
// overwrites the first, and each repo's reaper deletes the other's workers. The owner segment makes
// collision structurally impossible and makes a stray worker self-identifying on the account.
//
// Derived by default rather than configured: an optional variable that falls back to a shared default
// reintroduces exactly the collision it was meant to prevent whenever someone forgets to set it.
// PREVIEW_WORKER_PREFIX remains as a deliberate override for shorter URLs.
//
// usage:
//   node scripts/preview-name.mjs --pr 12          (writes PREVIEW_WORKER_PREFIX + SIGMA_WEB_NAME)
//   node scripts/preview-name.mjs                  (prefix only — for the reaper)

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The application segment every preview name starts with. Kept separate from the owner so the shape
// stays `<app>-<owner>-pr-<n>` and reads left-to-right from most to least stable.
export const APP = 'sigma';

// A worker name becomes a DNS label in `<name>.<subdomain>.workers.dev`, so it is bound by the 63-char
// label limit — not by any Cloudflare-specific cap. Worst case here is 6 + 39 (GitHub's login ceiling)
// + 4 + PR digits, which stays well inside it; assert anyway rather than trust the arithmetic.
export const MAX_LABEL_LENGTH = 63;

// Lowercase alphanumerics and interior hyphens — the DNS label grammar the workers.dev host must satisfy.
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Fold a GitHub owner login into a DNS-safe segment: lowercase, anything outside `[a-z0-9-]` becomes a
 * hyphen, runs of hyphens collapse, and leading/trailing hyphens are trimmed. GitHub logins are already
 * `[A-Za-z0-9-]` with no leading/trailing/repeated hyphens, so in practice this only folds case — the
 * rest guards the CLI being handed something hand-typed. Throws when nothing usable survives.
 */
export function sanitizeOwner(owner) {
  const folded = String(owner ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!folded) {
    throw new Error(
      `preview-name: cannot derive a preview prefix from owner "${owner ?? ''}" — set GITHUB_REPOSITORY_OWNER or pass --owner.`,
    );
  }
  return folded;
}

/**
 * The `<app>-<owner>-pr` prefix every preview worker in this repo shares. An `override` (the
 * PREVIEW_WORKER_PREFIX variable) wins when set, but is validated rather than silently mangled — a
 * prefix is a deliberate human choice, and quietly rewriting it would desync deploy from teardown.
 */
export function previewPrefix({ owner, override } = {}) {
  const explicit = String(override ?? '').trim();
  if (explicit) {
    if (!LABEL_RE.test(explicit)) {
      throw new Error(
        `preview-name: PREVIEW_WORKER_PREFIX "${explicit}" is not a valid DNS label (lowercase letters, digits and interior hyphens only).`,
      );
    }
    return explicit;
  }
  return `${APP}-${sanitizeOwner(owner)}-pr`;
}

/** Read the prefix straight from the process environment — how teardown and the reaper resolve it. */
export function previewPrefixFromEnv(env = process.env) {
  return previewPrefix({ owner: env.GITHUB_REPOSITORY_OWNER, override: env.PREVIEW_WORKER_PREFIX });
}

/**
 * `<prefix>-<PR number>`. Rejects a non-positive-integer PR number and any result that would not be a
 * legal workers.dev host, so a bad name fails here rather than as an opaque Cloudflare API error.
 */
export function previewWorkerName(prefix, prNumber) {
  const n = Number(prNumber);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`preview-name: "${prNumber}" is not a valid PR number.`);
  }
  const name = `${prefix}-${n}`;
  if (name.length > MAX_LABEL_LENGTH) {
    throw new Error(
      `preview-name: "${name}" is ${name.length} chars — over the ${MAX_LABEL_LENGTH}-char DNS label limit for <name>.<subdomain>.workers.dev. Shorten it with PREVIEW_WORKER_PREFIX.`,
    );
  }
  if (!LABEL_RE.test(name)) {
    throw new Error(`preview-name: "${name}" is not a valid DNS label.`);
  }
  return name;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches ONLY ephemeral previews carrying this prefix. The mandatory trailing `-<digits>` is what keeps
 * long-lived workers (`sigma`, `sigma-etl`, …) from ever matching, whatever the prefix — and the prefix
 * itself is what keeps another fork's previews out of this repo's deletion allowlist.
 */
export function ephemeralPreviewRe(prefix) {
  return new RegExp(`^${escapeRegExp(prefix)}-\\d+$`);
}

/** The PR number a preview worker belongs to, or `null` when the name isn't ours. */
export function previewPrNumber(name, prefix) {
  if (typeof name !== 'string') return null;
  const match = ephemeralPreviewRe(prefix).exec(name);
  return match ? Number(name.slice(prefix.length + 1)) : null;
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(inline.indexOf('=') + 1) : undefined;
}

// Emitting through $GITHUB_ENV (rather than interpolating the name in YAML) is deliberate:
// `github.repository_owner` preserves the login's original case, and a Worker name must be lowercase.
function main(argv) {
  const args = argv.slice(2);
  const owner = flag(args, 'owner') || process.env.GITHUB_REPOSITORY_OWNER;
  const pr = flag(args, 'pr');

  let lines;
  try {
    const prefix = previewPrefix({ owner, override: process.env.PREVIEW_WORKER_PREFIX });
    lines = [`PREVIEW_WORKER_PREFIX=${prefix}`];
    if (pr !== undefined) lines.push(`SIGMA_WEB_NAME=${previewWorkerName(prefix, pr)}`);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  for (const line of lines) console.log(line);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${lines.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv);
}
