// Validate the adapter-to-local-settings UI contract before it is exposed by /status.
// Keep this deliberately narrow: only controls with a verified renderer are accepted.
const BOOLEAN_SETTINGS = Object.freeze([
  'globalThinkMode',
  'searchMode',
  'siteThinkMode',
]);
const SETTINGS_UI_KEYS = new Set([...BOOLEAN_SETTINGS, 'siteMode']);
const SITE_MODE_KEYS = new Set(['label', 'title', 'options']);

function invalid(siteId, detail) {
  throw new TypeError('[site-adapter-settings-ui] ' + siteId + ': ' + detail);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Assert that one site's settingsUi metadata is safe for the shared Web UI.
 *
 * Absence means the site has no locally exposed site-specific settings. Unknown
 * controls are rejected instead of silently rendering an incomplete or invented UI.
 *
 * @param {object} site Site adapter declaration
 * @returns {true} when the declaration is valid
 */
export function assertSiteSettingsUi(site) {
  const siteId = typeof site?.id === 'string' && site.id.trim() ? site.id : '<unknown>';
  const ui = site?.settingsUi;
  if (ui === undefined || ui === null) return true;
  if (!isPlainRecord(ui)) invalid(siteId, 'settingsUi must be a plain object or null');

  for (const key of Object.keys(ui)) {
    if (!SETTINGS_UI_KEYS.has(key)) invalid(siteId, 'unsupported settingsUi control: ' + key);
  }

  for (const key of BOOLEAN_SETTINGS) {
    if (Object.hasOwn(ui, key) && ui[key] !== true) {
      invalid(siteId, key + ' must be declared as true or omitted');
    }
  }

  if (Object.hasOwn(ui, 'siteMode')) {
    const mode = ui.siteMode;
    if (!isPlainRecord(mode)) invalid(siteId, 'siteMode must be a plain object');
    for (const key of Object.keys(mode)) {
      if (!SITE_MODE_KEYS.has(key)) invalid(siteId, 'unsupported siteMode field: ' + key);
    }

    if (typeof mode.label !== 'string' || !mode.label.trim() || mode.label.length > 80) {
      invalid(siteId, 'siteMode.label must be a non-empty string of at most 80 characters');
    }
    if (Object.hasOwn(mode, 'title')
      && (typeof mode.title !== 'string' || mode.title.length > 240)) {
      invalid(siteId, 'siteMode.title must be a string of at most 240 characters');
    }
    if (!Array.isArray(mode.options) || mode.options.length === 0 || mode.options.length > 32) {
      invalid(siteId, 'siteMode.options must contain between 1 and 32 options');
    }

    const seen = new Set();
    for (const option of mode.options) {
      if (typeof option !== 'string' || !option.trim() || option.length > 80) {
        invalid(siteId, 'siteMode options must be non-empty strings of at most 80 characters');
      }
      if (seen.has(option)) invalid(siteId, 'siteMode options must be unique');
      seen.add(option);
    }
  }

  return true;
}
