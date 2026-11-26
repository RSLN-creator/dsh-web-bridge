// sites/zai-cn.js — the China Z.ai endpoint, derived from the shared Z.ai shape.
import { zaiSite } from './zai.js';

const {
  answerSelector: _cnAnswerSelector,
  efforts: _cnEfforts,
  effortControl: _cnEffortControl,
  ...zaiBase
} = zaiSite;

export const zaiCnSite = {
  ...zaiBase,
  id: 'zai-cn',
  name: 'Z.ai 中国站',
  origin: 'https://zchat.z.ai',
  shortKey: 'zchat.z.ai',
};
