// Editor for the remaining task templates only.
export const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const PROMPT_LABELS = {
  outline: '大纲',
  write: '正文',
  outlineContinue: '扩展大纲',
  deai: '润色去套路',
  ending: '收尾',
};
export function parseRules(text) {
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!record(value)) throw new Error('规则文件不是对象，请在源文件中检查；不会自动转换。');
  return value;
}
export function serializeRules(value, original = '') {
  return (
    (original.startsWith('\uFEFF') ? '\uFEFF' : '') +
    JSON.stringify(value, null, 2) +
    (original.endsWith('\n') ? '\n' : '')
  );
}
const own = (v, key) => Object.hasOwn(v, key);
function container(value, key, array = false) {
  if (value[key] === undefined) value[key] = array ? [] : {};
  if (array ? !Array.isArray(value[key]) : !record(value[key]))
    throw new Error('旧字段格式不同，请在源文件中编辑；未覆盖。');
  return value[key];
}
function setTyped(value, key, next, type) {
  if (typeof next !== type || (own(value, key) && typeof value[key] !== type))
    throw new Error('字段格式不同，原值已保留。');
  Object.defineProperty(value, key, { value: next, writable: true, enumerable: true, configurable: true });
}
export function editRules(input, op) {
  if (!record(input)) throw new Error('规则根格式不兼容。');
  const value = structuredClone(input);
  if (op.kind === 'prompt') {
    const prompts = container(value, 'savedPrompts');
    if (typeof op.key !== 'string' || !op.key) throw new Error('请选择提示词。');
    if (op.remove === true) delete prompts[op.key];
    else setTyped(prompts, op.key, op.value, 'string');
  } else throw new Error('不支持的规则编辑操作。');
  return value;
}
