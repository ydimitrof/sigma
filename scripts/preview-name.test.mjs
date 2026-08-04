// Unit tests for the ephemeral-preview naming rules. The property under test is not "the name looks
// right" but "two forks of midt-bg/sigma deploying the same PR number into one shared Cloudflare
// account can never produce the same worker name, and neither repo's cleanup can match the other's
// workers". Everything else here guards the edges that would break that property quietly.
//
// Run: node --test scripts/preview-name.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP,
  MAX_LABEL_LENGTH,
  sanitizeOwner,
  previewPrefix,
  previewPrefixFromEnv,
  previewWorkerName,
  ephemeralPreviewRe,
  previewPrNumber,
} from './preview-name.mjs';

test('sanitizeOwner folds case — github.repository_owner keeps the login casing, worker names must be lowercase', () => {
  assert.equal(sanitizeOwner('MidtBG'), 'midtbg');
  assert.equal(sanitizeOwner('ydimitrof'), 'ydimitrof');
  assert.equal(sanitizeOwner('lyubomir-bozhinov'), 'lyubomir-bozhinov');
});

test('sanitizeOwner produces a DNS-safe segment from hand-typed input', () => {
  assert.equal(sanitizeOwner('foo_bar'), 'foo-bar');
  assert.equal(sanitizeOwner('--foo--bar--'), 'foo-bar');
  assert.equal(sanitizeOwner('a b.c'), 'a-b-c');
});

test('sanitizeOwner throws when nothing usable survives', () => {
  for (const bad of ['', '   ', '---', '___', null, undefined]) {
    assert.throws(() => sanitizeOwner(bad), /cannot derive a preview prefix/);
  }
});

test('previewPrefix derives <app>-<owner>-pr with no configuration', () => {
  assert.equal(previewPrefix({ owner: 'ydimitrof' }), 'sigma-ydimitrof-pr');
  assert.equal(previewPrefix({ owner: 'ydimitrof' }).startsWith(`${APP}-`), true);
});

// The whole point of the change: same PR number, different forks, different workers.
test('previewPrefix isolates the forks that share one Cloudflare account', () => {
  const owners = ['ydimitrof', 'lyubomir-bozhinov', 'midt-bg'];
  const names = owners.map((o) => previewWorkerName(previewPrefix({ owner: o }), 12));
  assert.deepEqual(names, [
    'sigma-ydimitrof-pr-12',
    'sigma-lyubomir-bozhinov-pr-12',
    'sigma-midt-bg-pr-12',
  ]);
  assert.equal(new Set(names).size, owners.length);
});

test('previewPrefix honours an explicit PREVIEW_WORKER_PREFIX override', () => {
  assert.equal(previewPrefix({ owner: 'ydimitrof', override: 'sigma-yo' }), 'sigma-yo');
  assert.equal(previewPrefix({ owner: 'ydimitrof', override: '  sigma-yo  ' }), 'sigma-yo');
});

test('previewPrefix ignores a blank override rather than emitting an empty prefix', () => {
  assert.equal(previewPrefix({ owner: 'ydimitrof', override: '   ' }), 'sigma-ydimitrof-pr');
  assert.equal(previewPrefix({ owner: 'ydimitrof', override: '' }), 'sigma-ydimitrof-pr');
});

// Mangling an override silently would desync the deploy name from the teardown allowlist.
test('previewPrefix rejects an invalid override instead of rewriting it', () => {
  for (const bad of ['Sigma-Yo', 'sigma yo', 'sigma_yo', '-sigma', 'sigma-']) {
    assert.throws(
      () => previewPrefix({ owner: 'ydimitrof', override: bad }),
      /not a valid DNS label/,
    );
  }
});

test('previewPrefixFromEnv reads owner and override off an env object', () => {
  assert.equal(
    previewPrefixFromEnv({ GITHUB_REPOSITORY_OWNER: 'ydimitrof' }),
    'sigma-ydimitrof-pr',
  );
  assert.equal(
    previewPrefixFromEnv({ GITHUB_REPOSITORY_OWNER: 'ydimitrof', PREVIEW_WORKER_PREFIX: 'sig' }),
    'sig',
  );
  assert.throws(() => previewPrefixFromEnv({}), /cannot derive a preview prefix/);
});

test('previewWorkerName appends the PR number', () => {
  assert.equal(previewWorkerName('sigma-ydimitrof-pr', 12), 'sigma-ydimitrof-pr-12');
  assert.equal(previewWorkerName('sigma-ydimitrof-pr', '12'), 'sigma-ydimitrof-pr-12');
});

test('previewWorkerName rejects a non-positive-integer PR number', () => {
  for (const bad of [0, -1, 1.5, 'abc', '', null, undefined, '12abc']) {
    assert.throws(() => previewWorkerName('sigma-ydimitrof-pr', bad), /not a valid PR number/);
  }
});

// The ceiling is the workers.dev DNS label, not a Cloudflare limit. GitHub logins cap at 39 chars,
// so the derived form always fits; assert both the headroom and the guard.
test('previewWorkerName stays inside the DNS label limit for the longest possible login', () => {
  const maxLogin = 'a'.repeat(39);
  const name = previewWorkerName(previewPrefix({ owner: maxLogin }), 99999);
  assert.equal(name.length, 54);
  assert.ok(name.length <= MAX_LABEL_LENGTH);
});

test('previewWorkerName throws rather than emitting an unreachable host', () => {
  assert.throws(
    () => previewWorkerName(`sigma-${'a'.repeat(60)}-pr`, 1),
    /over the 63-char DNS label limit/,
  );
});

test('ephemeralPreviewRe matches only <prefix>-<digits>', () => {
  const re = ephemeralPreviewRe('sigma-ydimitrof-pr');
  assert.ok(re.test('sigma-ydimitrof-pr-12'));
  assert.ok(re.test('sigma-ydimitrof-pr-1'));
  assert.equal(re.test('sigma-ydimitrof-pr'), false);
  assert.equal(re.test('sigma-ydimitrof-pr-'), false);
  assert.equal(re.test('sigma-ydimitrof-pr-12a'), false);
  assert.equal(re.test('sigma-ydimitrof-pr-12-13'), false);
  assert.equal(re.test('xsigma-ydimitrof-pr-12'), false);
});

// The trailing -<digits> is the barrier that keeps long-lived workers out of any deletion allowlist.
test('ephemeralPreviewRe never matches a long-lived worker', () => {
  const re = ephemeralPreviewRe('sigma-ydimitrof-pr');
  for (const name of ['sigma', 'sigma-etl', 'sigma-stage', 'sigma-etl-stage', 'sigma-dev']) {
    assert.equal(re.test(name), false);
  }
});

// The safety property: this repo's cleanup must be blind to the other forks' previews.
test('ephemeralPreviewRe does not match another fork’s previews on the shared account', () => {
  const mine = ephemeralPreviewRe(previewPrefix({ owner: 'ydimitrof' }));
  assert.equal(mine.test('sigma-pr-12'), false);
  assert.equal(mine.test('sigma-lyubomir-bozhinov-pr-12'), false);
  assert.equal(mine.test('sigma-midt-bg-pr-12'), false);

  const theirs = ephemeralPreviewRe(previewPrefix({ owner: 'lyubomir-bozhinov' }));
  assert.equal(theirs.test('sigma-ydimitrof-pr-12'), false);
});

test('ephemeralPreviewRe escapes regex metacharacters in the prefix', () => {
  const re = ephemeralPreviewRe('sigma.pr');
  assert.ok(re.test('sigma.pr-12'));
  assert.equal(re.test('sigmaxpr-12'), false);
});

test('previewPrNumber recovers the PR number for our previews only', () => {
  assert.equal(previewPrNumber('sigma-ydimitrof-pr-12', 'sigma-ydimitrof-pr'), 12);
  assert.equal(previewPrNumber('sigma-ydimitrof-pr-4071', 'sigma-ydimitrof-pr'), 4071);
  assert.equal(previewPrNumber('sigma-pr-12', 'sigma-ydimitrof-pr'), null);
  assert.equal(previewPrNumber('sigma', 'sigma-ydimitrof-pr'), null);
  assert.equal(previewPrNumber(null, 'sigma-ydimitrof-pr'), null);
  assert.equal(previewPrNumber(12, 'sigma-ydimitrof-pr'), null);
});

// The reaper's PR-comment step derives the issue number from the worker name; a hardcoded
// /^sigma-pr-(\d+)$/ silently stops matching under any other prefix (workers deleted, PR never told).
test('previewPrNumber round-trips whatever previewWorkerName produced', () => {
  for (const owner of ['ydimitrof', 'lyubomir-bozhinov', 'midt-bg']) {
    const prefix = previewPrefix({ owner });
    assert.equal(previewPrNumber(previewWorkerName(prefix, 987), prefix), 987);
  }
  const override = previewPrefix({ owner: 'ydimitrof', override: 'sigma-yo' });
  assert.equal(previewPrNumber(previewWorkerName(override, 5), override), 5);
});
