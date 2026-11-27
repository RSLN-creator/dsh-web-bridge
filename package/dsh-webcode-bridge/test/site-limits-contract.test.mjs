// site-limits-contract.test.mjs — measured adapter limits are validated, finite site facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SITES } from '../lib/providers.js';
import { assertSiteLimits } from '../lib/sites/limits-contract.js';

test('all registered adapters declare only evidence-backed delivery limits', () => {
  for (const site of SITES) {
    assert.equal(assertSiteLimits(site), true, site.id + ' limits metadata');
    if (site.limits) {
      assert.doesNotThrow(() => JSON.stringify(site.limits),
        site.id + ' limits must remain JSON-serializable for the adapter projection');
    }
  }

  const declared = Object.fromEntries(SITES.filter((site) => site.limits)
    .map((site) => [site.id, site.limits]));
  assert.deepEqual(declared, {
    deepseek: { attachInlineLimitChars: 8_000 },
    glm: { attachInlineLimitChars: 8_000 },
    kimi: { attachInlineLimitChars: 8_000, composerHardLimitChars: 200_000 },
  }, 'sites without direct evidence must not inherit another adapter\'s thresholds');
});

test('missing or null limits mean the shared defaults apply', () => {
  assert.equal(assertSiteLimits({ id: 'default-site' }), true);
  assert.equal(assertSiteLimits({ id: 'null-site', limits: null }), true);
});

test('both known measured limit fields accept positive safe integer values', () => {
  assert.equal(assertSiteLimits({
    id: 'valid-site',
    limits: { attachInlineLimitChars: 8_000, composerHardLimitChars: 200_000 },
  }), true);
});

test('malformed, zero, negative and unmeasured limit fields are rejected', () => {
  const invalidDeclarations = [
    [],
    { unknownLimit: 1_000 },
    { attachInlineLimitChars: 0 },
    { attachInlineLimitChars: -1 },
    { attachInlineLimitChars: 8_000.5 },
    { attachInlineLimitChars: '8000' },
    { attachInlineLimitChars: Number.POSITIVE_INFINITY },
    { composerHardLimitChars: Number.MAX_SAFE_INTEGER + 1 },
  ];

  for (const limits of invalidDeclarations) {
    assert.throws(
      () => assertSiteLimits({ id: 'invalid-fixture', limits }),
      /\[site-adapter-limits\] invalid-fixture:/,
      'invalid delivery-limit metadata must fail at adapter registry load',
    );
  }
});
