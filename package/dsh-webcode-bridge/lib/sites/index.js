// sites/index.js — the complete registry of per-site declarations.
// Each website owns its DOM, login, model, transport and navigation facts in one module.
// Shared execution algorithms stay in the common driver, decoders and protocol engine.

import { deepseekSite } from './deepseek.js';
import { glmSite } from './glm.js';
import { chatgptSite } from './chatgpt.js';
import { kimiSite } from './kimi.js';
import { qwenSite } from './qwen.js';
import { doubaoSite } from './doubao.js';
import { grokSite } from './grok.js';
import { claudeSite } from './claude.js';
import { geminiSite } from './gemini.js';
import { zaiSite } from './zai.js';
import { zaiCnSite } from './zai-cn.js';

export const SITE_MODULES = Object.freeze({
  deepseek: deepseekSite,
  glm: glmSite,
  chatgpt: chatgptSite,
  kimi: kimiSite,
  qwen: qwenSite,
  doubao: doubaoSite,
  grok: grokSite,
  claude: claudeSite,
  gemini: geminiSite,
  zai: zaiSite,
  'zai-cn': zaiCnSite,
});

export function migratedSiteIds() {
  return Object.keys(SITE_MODULES);
}

export function siteModuleFor(siteId) {
  return SITE_MODULES[siteId] || null;
}
