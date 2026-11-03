import { createMergePlan } from './merge-core.mjs';
self.onmessage = async ({ data }) => {
  try {
    for (const name of ['base', 'remote']) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data[name]));
      const hash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
      if (hash !== data[name + 'Hash'])
        throw new Error(
          name === 'base'
            ? '共同基线校验失败，未进行自动合并；请保留本机稿并手工比较。'
            : '云端快照校验失败，请重新读取后比较。',
        );
    }
    self.postMessage({ plan: createMergePlan(data) });
  } catch (error) {
    self.postMessage({ error: error.message || '合并计算失败，原文仍保留。' });
  }
};
