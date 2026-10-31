import assert from 'node:assert/strict';
import test from 'node:test';
import { currentVersion, describeUpdateState, resolveWatchtowerEndpoint } from '../src/systemUpdate.js';

test('resolveWatchtowerEndpoint rejects missing, invalid, and credentialed URLs', () => {
  assert.equal(resolveWatchtowerEndpoint(undefined), null);
  assert.equal(resolveWatchtowerEndpoint('   '), null);
  assert.equal(resolveWatchtowerEndpoint('not a url'), null);
  assert.equal(resolveWatchtowerEndpoint('ftp://watchtower:8080'), null);
  assert.equal(resolveWatchtowerEndpoint('http://user:secret@watchtower:8080'), null);
});

test('resolveWatchtowerEndpoint normalizes the update path', () => {
  assert.equal(resolveWatchtowerEndpoint('http://watchtower:8080'), 'http://watchtower:8080/v1/update');
  assert.equal(resolveWatchtowerEndpoint('http://watchtower:8080/'), 'http://watchtower:8080/v1/update');
  assert.equal(resolveWatchtowerEndpoint('http://watchtower:8080/v1/update/'), 'http://watchtower:8080/v1/update');
  assert.equal(
    resolveWatchtowerEndpoint('https://example.com/base?token=x#frag'),
    'https://example.com/base/v1/update',
  );
});

test('describeUpdateState reports idle when there is no persisted request', () => {
  assert.deepEqual(describeUpdateState(null), {
    state: 'idle',
    requestedAt: null,
    requestedBy: null,
    message: null,
  });
});

test('describeUpdateState reports a failed request with its message', () => {
  const status = describeUpdateState({
    state: 'failed',
    requestedAt: '2026-01-01T00:00:00.000Z',
    requestedBy: 'admin',
    fromVersion: '1.0.0',
    message: 'boom',
  });
  assert.equal(status.state, 'failed');
  assert.equal(status.message, 'boom');
  assert.equal(status.requestedBy, 'admin');
});

test('describeUpdateState reports restarted when the process is newer than the request', () => {
  const requestedAt = '2026-01-01T00:00:00.000Z';
  const status = describeUpdateState(
    { state: 'requested', requestedAt, requestedBy: 'admin', fromVersion: '1.0.0' },
    Date.parse(requestedAt) + 30_000,
    Date.parse(requestedAt) + 1_000,
  );
  assert.equal(status.state, 'restarted');
});

test('describeUpdateState reports pending, then unknown after the timeout', () => {
  const requestedAt = '2026-01-01T00:00:00.000Z';
  const state = { state: 'requested' as const, requestedAt, requestedBy: 'admin', fromVersion: '1.0.0' };
  const requestedAtMs = Date.parse(requestedAt);

  assert.equal(describeUpdateState(state, requestedAtMs + 60_000, requestedAtMs - 60_000).state, 'pending');
  assert.equal(describeUpdateState(state, requestedAtMs + 16 * 60_000, requestedAtMs - 60_000).state, 'unknown');
});

test('currentVersion prefers APP_VERSION', () => {
  const previous = process.env.APP_VERSION;
  process.env.APP_VERSION = '9.9.9-test';
  try {
    assert.equal(currentVersion(), '9.9.9-test');
  } finally {
    if (previous === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = previous;
  }
});
