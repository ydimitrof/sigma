// Unit tests for the remote-teardown safety barriers. This script issues real `wrangler delete` calls,
// so the allowlist/denylist logic is exercised here rather than discovered in production: every case
// below is a worker that must NOT be deleted, plus the handful that may.
//
// Run: node --test scripts/teardown-remote.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTECTED,
  assertDeletable,
  deleteWorker,
  isEphemeralPreviewName,
  isProtected,
} from './teardown-remote.mjs';

const MINE = 'sigma-ydimitrof-pr';

// Run `fn` with a patched environment, always restoring it so test order can't leak a prefix into the
// explicit-argument suites.
function withEnv(patch, fn) {
  const prior = {};
  for (const [k, v] of Object.entries(patch)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('isProtected', () => {
  it('flags every long-lived worker', () => {
    for (const name of [
      'sigma',
      'sigma-etl',
      'sigma-stage',
      'sigma-etl-stage',
      'sigma-dev',
      'sigma-etl-dev',
    ]) {
      assert.equal(isProtected(name), true, name);
    }
  });

  it('does not flag ephemeral preview names', () => {
    assert.equal(isProtected('sigma-ydimitrof-pr-123'), false);
  });
});

describe('isEphemeralPreviewName', () => {
  it('matches <prefix>-<number>', () => {
    assert.equal(isEphemeralPreviewName('sigma-ydimitrof-pr-1', MINE), true);
    assert.equal(isEphemeralPreviewName('sigma-ydimitrof-pr-99999', MINE), true);
  });

  it('rejects anything that is not exactly <prefix>-<number>', () => {
    for (const name of [
      'sigma',
      'sigma-dev',
      'sigma-ydimitrof-pr-', // no number
      'sigma-ydimitrof-pr-abc', // non-numeric
      'sigma-ydimitrof-pr-12-x', // trailing junk
      'prod-sigma-ydimitrof-pr-1', // prefix
      'SIGMA-YDIMITROF-PR-1', // wrong case
      undefined,
      null,
      42,
    ]) {
      assert.equal(isEphemeralPreviewName(name, MINE), false, String(name));
    }
  });

  // The reason the owner is in the name at all: all forks of midt-bg/sigma deploy previews into one
  // shared Cloudflare account, and the daily reaper lists every worker on it.
  it("is blind to another fork's previews on the shared account", () => {
    assert.equal(isEphemeralPreviewName('sigma-pr-12', MINE), false);
    assert.equal(isEphemeralPreviewName('sigma-lyubomir-bozhinov-pr-12', MINE), false);
    assert.equal(isEphemeralPreviewName('sigma-midt-bg-pr-12', MINE), false);
  });
});

describe('assertDeletable', () => {
  it('allows an ephemeral preview worker', () => {
    assert.doesNotThrow(() => assertDeletable('sigma-ydimitrof-pr-42', MINE));
  });

  it('refuses every protected long-lived worker', () => {
    for (const name of PROTECTED) {
      assert.throws(
        () => assertDeletable(name, MINE),
        /refusing to delete protected long-lived worker/,
        name,
      );
    }
  });

  it('refuses a missing name', () => {
    assert.throws(() => assertDeletable(undefined, MINE), /a worker name is required/);
    assert.throws(() => assertDeletable('', MINE), /a worker name is required/);
  });

  it('refuses a non-preview worker name (allowlist)', () => {
    assert.throws(
      () => assertDeletable('some-random-worker', MINE),
      /not an ephemeral preview worker/,
    );
  });

  it("names the expected prefix when refusing another fork's preview", () => {
    assert.throws(
      () => assertDeletable('sigma-pr-42', MINE),
      /expected sigma-ydimitrof-pr-<number>/,
    );
  });
});

describe('deleteWorker', () => {
  it('never invokes wrangler in dry-run', () => {
    let called = false;
    const result = deleteWorker('sigma-ydimitrof-pr-7', {
      dryRun: true,
      prefix: MINE,
      exec: () => (called = true),
    });
    assert.equal(result, 'dry-run');
    assert.equal(called, false);
  });

  it('reports "deleted" on success', () => {
    assert.equal(deleteWorker('sigma-ydimitrof-pr-7', { prefix: MINE, exec: () => '' }), 'deleted');
  });

  it('treats a missing script (code 10007) as "already-gone"', () => {
    const exec = () => {
      const err = new Error('exit 1');
      err.stderr =
        'A request to the Cloudflare API failed. workers.api.error.script_not_found [code: 10007]';
      throw err;
    };
    assert.equal(deleteWorker('sigma-ydimitrof-pr-7', { prefix: MINE, exec }), 'already-gone');
  });

  it('rethrows a hard failure (e.g. auth) instead of masking a leak', () => {
    const exec = () => {
      const err = new Error('exit 1');
      err.stderr = 'Authentication error [code: 10000]';
      throw err;
    };
    assert.throws(() => deleteWorker('sigma-ydimitrof-pr-7', { prefix: MINE, exec }), /exit 1/);
  });

  it('refuses a protected worker even when handed a stub exec', () => {
    let called = false;
    assert.throws(
      () => deleteWorker('sigma-etl', { prefix: MINE, exec: () => (called = true) }),
      /refusing to delete protected long-lived worker/,
    );
    assert.equal(called, false);
  });

  it("refuses another fork's preview even when handed a stub exec", () => {
    let called = false;
    assert.throws(
      () => deleteWorker('sigma-pr-7', { prefix: MINE, exec: () => (called = true) }),
      /not an ephemeral preview worker of this repository/,
    );
    assert.equal(called, false);
  });
});

describe('prefix resolution from the environment', () => {
  it('derives the allowlist from GITHUB_REPOSITORY_OWNER with no configuration', () => {
    withEnv({ GITHUB_REPOSITORY_OWNER: 'ydimitrof', PREVIEW_WORKER_PREFIX: undefined }, () => {
      assert.equal(isEphemeralPreviewName('sigma-ydimitrof-pr-5'), true);
      assert.equal(isEphemeralPreviewName('sigma-pr-5'), false);
      assert.doesNotThrow(() => assertDeletable('sigma-ydimitrof-pr-5'));
    });
  });

  it('honours an explicit PREVIEW_WORKER_PREFIX override', () => {
    withEnv({ GITHUB_REPOSITORY_OWNER: 'ydimitrof', PREVIEW_WORKER_PREFIX: 'midt-pr' }, () => {
      assert.equal(isEphemeralPreviewName('midt-pr-5'), true);
      // Still requires the trailing -<digits>, so the app's own workers never match.
      assert.equal(isEphemeralPreviewName('midt-pr'), false);
      // The derived name no longer matches once a different prefix is configured.
      assert.equal(isEphemeralPreviewName('sigma-ydimitrof-pr-5'), false);
    });
  });

  // Fail loudly rather than fall back to a shared default: a silent fallback is precisely how two
  // forks end up deploying — and deleting — the same worker name.
  it('throws instead of guessing when neither owner nor override is available', () => {
    withEnv({ GITHUB_REPOSITORY_OWNER: undefined, PREVIEW_WORKER_PREFIX: undefined }, () => {
      assert.throws(
        () => isEphemeralPreviewName('sigma-ydimitrof-pr-5'),
        /cannot derive a preview prefix/,
      );
    });
  });
});
