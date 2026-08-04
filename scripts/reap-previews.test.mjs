// Unit tests for the scheduled preview reaper. It runs unattended against a Cloudflare account SHARED
// with the other forks of midt-bg/sigma, so the tests that matter most are the ones asserting what it
// refuses to touch: long-lived workers, and previews belonging to a different fork.
//
// Run: node --test scripts/reap-previews.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listWorkerScripts, reapStale, reapedPullRequests, selectStale } from './reap-previews.mjs';

const silent = () => {};
const MINE = 'sigma-ydimitrof-pr';

// Fixed reference instant so the test is deterministic (no Date.now()).
const NOW = Date.parse('2026-06-24T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

describe('selectStale', () => {
  it('selects only previews older than the max age', () => {
    const scripts = [
      { id: 'sigma-ydimitrof-pr-1', modified_on: daysAgo(6) }, // stale
      { id: 'sigma-ydimitrof-pr-2', modified_on: daysAgo(4) }, // fresh
      { id: 'sigma-ydimitrof-pr-3', modified_on: daysAgo(10) }, // stale
    ];
    const stale = selectStale(scripts, { maxAgeDays: 5, nowMs: NOW, prefix: MINE });
    assert.deepEqual(
      stale.map((s) => s.name),
      ['sigma-ydimitrof-pr-1', 'sigma-ydimitrof-pr-3'],
    );
  });

  it('never selects long-lived / non-preview workers, however old', () => {
    const scripts = [
      { id: 'sigma', modified_on: daysAgo(400) },
      { id: 'sigma-etl', modified_on: daysAgo(400) },
      { id: 'sigma-dev', modified_on: daysAgo(400) },
      { id: 'sigma-ydimitrof-pr-9', modified_on: daysAgo(400) }, // only this one qualifies
    ];
    const stale = selectStale(scripts, { maxAgeDays: 5, nowMs: NOW, prefix: MINE });
    assert.deepEqual(
      stale.map((s) => s.name),
      ['sigma-ydimitrof-pr-9'],
    );
  });

  // The reaper lists EVERY worker on the shared account. Reaping a sibling fork's live preview would
  // be indistinguishable, from that fork's side, from a random outage.
  it("never selects another fork's previews from the shared account", () => {
    const scripts = [
      { id: 'sigma-pr-1', modified_on: daysAgo(400) },
      { id: 'sigma-lyubomir-bozhinov-pr-1', modified_on: daysAgo(400) },
      { id: 'sigma-midt-bg-pr-1', modified_on: daysAgo(400) },
      { id: 'sigma-ydimitrof-pr-1', modified_on: daysAgo(400) },
    ];
    const stale = selectStale(scripts, { maxAgeDays: 5, nowMs: NOW, prefix: MINE });
    assert.deepEqual(
      stale.map((s) => s.name),
      ['sigma-ydimitrof-pr-1'],
    );
  });

  it('leaves previews with an unparseable timestamp alone', () => {
    const scripts = [{ id: 'sigma-ydimitrof-pr-1', modified_on: 'not-a-date' }];
    assert.deepEqual(selectStale(scripts, { maxAgeDays: 5, nowMs: NOW, prefix: MINE }), []);
  });

  it('treats exactly-at-the-boundary as not yet stale', () => {
    const scripts = [{ id: 'sigma-ydimitrof-pr-1', modified_on: daysAgo(5) }];
    assert.deepEqual(selectStale(scripts, { maxAgeDays: 5, nowMs: NOW, prefix: MINE }), []);
  });
});

describe('listWorkerScripts', () => {
  it('returns the result array on success', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ success: true, result: [{ id: 'sigma-ydimitrof-pr-1' }] }),
    });
    const out = await listWorkerScripts({ accountId: 'a', token: 't', fetchImpl });
    assert.deepEqual(out, [{ id: 'sigma-ydimitrof-pr-1' }]);
  });

  it('follows the cursor across pages and concatenates every result', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      const onFirstPage = !url.includes('cursor=');
      return {
        ok: true,
        json: async () =>
          onFirstPage
            ? {
                success: true,
                result: [{ id: 'sigma-ydimitrof-pr-1' }],
                result_info: { cursor: 'next-page' },
              }
            : {
                success: true,
                result: [{ id: 'sigma-ydimitrof-pr-2' }],
                result_info: { cursor: '' },
              },
      };
    };
    const out = await listWorkerScripts({ accountId: 'a', token: 't', fetchImpl });
    assert.deepEqual(out, [{ id: 'sigma-ydimitrof-pr-1' }, { id: 'sigma-ydimitrof-pr-2' }]);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /cursor=next-page/);
  });

  it('throws with the API error on failure', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ success: false, errors: [{ message: 'bad token' }] }),
    });
    await assert.rejects(
      () => listWorkerScripts({ accountId: 'a', token: 't', fetchImpl }),
      /list scripts failed \(403\).*bad token/,
    );
  });

  it('terminates instead of looping on a stable/repeating cursor', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          success: true,
          result: [{ id: 'sigma-ydimitrof-pr-1' }],
          result_info: { cursor: 'stuck' },
        }),
      };
    };
    const out = await listWorkerScripts({ accountId: 'a', token: 't', fetchImpl });
    assert.equal(calls, 2);
    assert.deepEqual(out, [{ id: 'sigma-ydimitrof-pr-1' }, { id: 'sigma-ydimitrof-pr-1' }]);
  });
});

describe('reapStale', () => {
  const stale = [
    { name: 'sigma-ydimitrof-pr-1', ageDays: 6, modifiedOn: 'x' },
    { name: 'sigma-ydimitrof-pr-2', ageDays: 7, modifiedOn: 'y' },
  ];

  it('does not delete anything in dry-run', () => {
    let called = 0;
    const result = reapStale(stale, {
      apply: false,
      del: () => (called += 1),
      log: silent,
      errLog: silent,
    });
    assert.equal(called, 0);
    assert.deepEqual(result, { reaped: [], hardFailures: 0 });
  });

  it('counts only actual deletes as reaped, excluding already-gone', () => {
    const del = (name) => (name === 'sigma-ydimitrof-pr-1' ? 'deleted' : 'already-gone');
    const result = reapStale(stale, { apply: true, del, log: silent, errLog: silent });
    assert.deepEqual(result, { reaped: ['sigma-ydimitrof-pr-1'], hardFailures: 0 });
  });

  it('tallies a hard failure without aborting the rest of the run', () => {
    const del = (name) => {
      if (name === 'sigma-ydimitrof-pr-1') throw new Error('auth');
      return 'deleted';
    };
    const result = reapStale(stale, { apply: true, del, log: silent, errLog: silent });
    assert.deepEqual(result, { reaped: ['sigma-ydimitrof-pr-2'], hardFailures: 1 });
  });
});

// Regression guard: the workflow's comment step used to re-derive the PR number with a hardcoded
// /^sigma-pr-(\d+)$/, which silently stops matching under any other prefix — workers get deleted and
// the PR is never told. The pairing is computed here, from the same module that builds the name.
describe('reapedPullRequests', () => {
  it('pairs each reaped worker with its PR number', () => {
    assert.deepEqual(reapedPullRequests(['sigma-ydimitrof-pr-12', 'sigma-ydimitrof-pr-7'], MINE), [
      { worker: 'sigma-ydimitrof-pr-12', pr: 12 },
      { worker: 'sigma-ydimitrof-pr-7', pr: 7 },
    ]);
  });

  it('works for any prefix, including an override', () => {
    assert.deepEqual(reapedPullRequests(['midt-pr-3'], 'midt-pr'), [
      { worker: 'midt-pr-3', pr: 3 },
    ]);
  });

  it('drops a name that does not belong to this prefix', () => {
    assert.deepEqual(reapedPullRequests(['sigma-pr-12', 'sigma'], MINE), []);
  });

  it('is empty for an empty reap', () => {
    assert.deepEqual(reapedPullRequests([], MINE), []);
  });
});
