// Validate measured, adapter-owned message delivery limits.
// These are evidence-backed safety ceilings, not UI preferences or enablement flags.
const ALLOWED_LIMITS = new Set([
  'attachInlineLimitChars',
  'composerHardLimitChars',
]);

function invalid(siteId, detail) {
  throw new TypeError('[site-adapter-limits] ' + siteId + ': ' + detail);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Validate one adapter's optional measured message-delivery limits.
 *
 * Missing limits mean the shared defaults apply. A declared limit must be a
 * positive safe integer; zero belongs to the user's configuration semantics
 * (attachments disabled), never to adapter metadata.
 *
 * @param {object} site Site adapter declaration
 * @returns {true} when the descriptor is valid
 */
export function assertSiteLimits(site) {
  const siteId = typeof site?.id === 'string' && site.id.trim() ? site.id : '<unknown>';
  const limits = site?.limits;
  if (limits === undefined || limits === null) return true;
  if (!isPlainRecord(limits)) invalid(siteId, 'limits must be a plain object or null');

  for (const key of Object.keys(limits)) {
    if (!ALLOWED_LIMITS.has(key)) invalid(siteId, 'unsupported limit: ' + key);
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      invalid(siteId, key + ' must be a positive safe integer');
    }
  }

  return true;
}
