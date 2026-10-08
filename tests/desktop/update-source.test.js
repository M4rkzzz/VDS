const assert = require('node:assert/strict');
const { test } = require('node:test');
const { TRUSTED_UPDATE_FEED_URL, getUpdateFeedBaseUrl } = require('../../desktop/update-source');

test('packaged update source is independent of custom LAN signaling and environment overrides', () => {
  assert.equal(getUpdateFeedBaseUrl(true, {
    SERVER_URL: 'http://192.168.5.193:3000',
    VDS_UPDATE_URL: 'http://attacker.invalid/updates/'
  }), TRUSTED_UPDATE_FEED_URL);
});

test('development HTTPS update source remains explicitly configurable', () => {
  assert.equal(getUpdateFeedBaseUrl(false, { VDS_UPDATE_URL: 'https://updates.test/release' }), 'https://updates.test/release/');
  assert.equal(getUpdateFeedBaseUrl(false, { SERVER_URL: 'http://localhost:3000' }), TRUSTED_UPDATE_FEED_URL);
});

test('update source rejects HTTP, credentials, query and fragment', () => {
  for (const url of ['http://updates.test/', 'https://user:pass@updates.test/', 'https://updates.test/?x=1', 'https://updates.test/#x']) {
    assert.throws(() => getUpdateFeedBaseUrl(false, { VDS_UPDATE_URL: url }), /update-feed-must-use-https/);
  }
});
