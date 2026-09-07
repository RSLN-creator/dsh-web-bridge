// 站点契约集中维护；未知模型必须拒绝，不能静默切回默认模型。
export const DEEPSEEK = Object.freeze({
  id: 'deepseek', origin: 'https://chat.deepseek.com',
  completionPath: '/api/v0/chat/completion',
  input: 'textarea.ds-scroll-area',
  models: [
    { id: 'flash', name: 'DeepSeek Flash · 快速模式', labels: ['快速模式', 'Flash'] },
    { id: 'vision', name: 'DeepSeek Vision · 识图模式', labels: ['识图模式', 'Vision'] },
    { id: 'deepseek', name: 'DeepSeek · 专家模式', labels: ['专家模式', 'DeepSeek'] },
  ],
});
export function resolveWebModel(value = 'flash') {
  const id = typeof value === 'object' ? value?.id : value;
  const aliases = { 'deepseek-web': 'flash', 'deepseek-reasoner': 'deepseek' };
  const model = DEEPSEEK.models.find(m => m.id === (aliases[id] || id));
  if (!model) throw new Error('不支持的网页模型：' + id);
  return model;
}
