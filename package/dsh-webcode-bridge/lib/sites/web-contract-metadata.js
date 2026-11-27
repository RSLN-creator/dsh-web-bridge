// Validate site-owned web-contract metadata before it is projected by lib/contract.js.
// The accepted fields describe verified behavior; they do not allow adapters to inject code.
const ALLOWED_KEYS = new Set([
  'searchTogglePattern',
  'requestMetadataKeys',
  'strictModelType',
  'alwaysOptionals',
]);

function invalid(siteId, detail) {
  throw new TypeError('[site-adapter-web-contract] ' + siteId + ': ' + detail);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Validate the optional contract metadata owned by a site adapter.
 *
 * Omitted metadata means the shared conservative contract. The compatibility
 * flag defaults to the historic generic shape; adapters may opt out only when
 * preserving that shape would add keys absent from their established contract.
 *
 * @param {object} site Site adapter declaration
 * @returns {true} when the descriptor is valid
 */
export function assertSiteWebContract(site) {
  const siteId = typeof site?.id === 'string' && site.id.trim() ? site.id : '<unknown>';
  const contract = site?.contract;
  if (contract === undefined || contract === null) return true;
  if (!isPlainRecord(contract)) invalid(siteId, 'contract must be a plain object or null');

  for (const key of Object.keys(contract)) {
    if (!ALLOWED_KEYS.has(key)) invalid(siteId, 'unsupported contract field: ' + key);
  }

  if (Object.hasOwn(contract, 'searchTogglePattern')
    && !(contract.searchTogglePattern instanceof RegExp)) {
    invalid(siteId, 'searchTogglePattern must be a RegExp');
  }

  if (Object.hasOwn(contract, 'requestMetadataKeys')) {
    const keys = contract.requestMetadataKeys;
    if (!Array.isArray(keys) || keys.length > 32) {
      invalid(siteId, 'requestMetadataKeys must be an array of at most 32 keys');
    }
    const seen = new Set();
    for (const key of keys) {
      if (typeof key !== 'string' || !key.trim() || key.length > 80) {
        invalid(siteId, 'requestMetadataKeys must contain non-empty strings of at most 80 characters');
      }
      if (seen.has(key)) invalid(siteId, 'requestMetadataKeys must be unique');
      seen.add(key);
    }
  }

  if (Object.hasOwn(contract, 'strictModelType') && contract.strictModelType !== true) {
    invalid(siteId, 'strictModelType must be true or omitted');
  }

  if (Object.hasOwn(contract, 'alwaysOptionals') && typeof contract.alwaysOptionals !== 'boolean') {
    invalid(siteId, 'alwaysOptionals must be a boolean');
  }

  if (contract.strictModelType === true
    && (!Array.isArray(contract.requestMetadataKeys) || contract.requestMetadataKeys.length === 0)) {
    invalid(siteId, 'strictModelType requires at least one requestMetadataKey');
  }

  return true;
}
