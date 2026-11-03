// A full-width, inline book-management page. No floating dialog or hidden AI
// prompt; the original server transaction owns move/restore/restart.
import { makeBookBundle } from './bundle.mjs';

export function bookManagement(root, { client, setBusy, status, refresh, archiveSessions, openBook }) {
  const doc = root.ownerDocument;
  const panel = doc.createElement('section');
  panel.className = 'novel-book-management';
  panel.setAttribute('aria-label', '管理小说');
  panel.hidden = true;
  root.querySelector('#books').before(panel);
  let owner,
    submitting = false,
    disposed = false;
  function element(tag, text) {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function close() {
    if (submitting) return;
    const previous = owner;
    owner = null;
    panel.hidden = true;
    panel.replaceChildren();
    previous?.launcher?.focus();
  }
  async function show(book, action, launcher) {
    if (submitting || disposed) return;
    const token = { book, action, launcher };
    owner = token;
    panel.replaceChildren();
    panel.hidden = false;
    const heading = element('h2', { delete: '删除整本书', restart: '重新开始', restore: '恢复小说' }[action]);
    heading.tabIndex = -1;
    const cancel = element('button', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', close);
    const progress = element('p', '正在核对本书所有文件…');
    progress.setAttribute('role', 'status');
    panel.append(heading, element('h3', book.title), progress, cancel);
    heading.focus();
    panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    try {
      const preview = await client.lifecycle(book.id, { action: 'inspect', trashed: action === 'restore' });
      if (owner !== token || disposed) return;
      progress.textContent = `${preview.files} 个文件 · 正文 ${preview.counts.chapters} · 草稿 ${preview.counts.drafts} · 笔记 ${preview.counts.notes} · 历史文件 ${preview.counts.histories}`;
      panel.insertBefore(
        element(
          'p',
          action === 'restart'
            ? '旧书完整移入回收站，打开一本同名空白新书。只保留书名和全局 API 配置，不沿用旧正文、大纲、方向、记忆、设定、草稿、模板或聊天。'
            : action === 'delete'
              ? '整本书移入回收站，可恢复。正文、设定、记忆、草稿和版本历史一并移动；原生聊天归档保留。不影响其他小说、PIN 或 API 配置。'
              : '恢复原书的所有文件。旧聊天仍在归档中，可主动打开；不会覆盖另一本书。',
        ),
        cancel,
      );
      let seed;
      if (action === 'restart') {
        const label = element('label', '新灵感（可留空，不会带入旧内容）');
        seed = element('textarea');
        seed.setAttribute('aria-label', '重新开始的新灵感');
        seed.rows = 4;
        label.append(seed);
        panel.insertBefore(label, cancel);
      }
      if (preview.generating)
        panel.insertBefore(
          element('p', '本书 AI 正在生成；请结束或停止后重新核对。此次操作不会中断生成。'),
          cancel,
        );
      const confirm = element(
        'button',
        action === 'restart' ? '确认重新开始' : action === 'delete' ? '确认删除整本书' : '确认恢复小说',
      );
      confirm.type = 'button';
      confirm.dataset.variant = action === 'restore' ? 'primary' : 'danger';
      confirm.disabled = preview.generating;
      panel.insertBefore(confirm, cancel);
      confirm.addEventListener('click', async () => {
        if (submitting || owner !== token) return;
        submitting = true;
        setBusy(true);
        confirm.disabled = cancel.disabled = true;
        let committed = false;
        try {
          const bundle =
            action === 'restart'
              ? await makeBookBundle({
                  creationId: crypto.randomUUID(),
                  state: {
                    project: { title: book.title },
                    seed: seed.value.trim(),
                    outline: [],
                    chapters: [],
                  },
                })
              : undefined;
          const value = await client.lifecycle(book.id, {
            action,
            expectedRevision: preview.revision,
            ...(bundle ? { bundle } : {}),
          });
          if (action === 'restore' ? value.restored !== true : value.deleted !== true)
            throw new Error('服务未确认操作完成，请刷新书库核对，不自动重复提交。');
          committed = true;
          let warning = '',
            navigationHandled = false;
          if (action !== 'restore') {
            try {
              const result = await archiveSessions?.(book, action === 'restart' ? value.book : null);
              warning = result?.warning ?? '';
              navigationHandled = result?.handled === true;
            } catch {
              warning = '旧聊天归档未完全完成，历史仍保留；新书不会继承它。';
            }
          }
          if (disposed) return;
          panel.hidden = true;
          owner = null;
          await refresh();
          status(
            (action === 'restore'
              ? '小说已恢复。'
              : action === 'restart'
                ? '已打开全新创作空间，旧书保留在回收站。'
                : '整本书已移入回收站。') + warning,
          );
          if (action === 'restart' && !navigationHandled) await openBook(value.book);
        } catch (error) {
          if (!disposed) {
            if (committed) {
              status(
                '书库操作已保存，但刷新或打开失败；请刷新书库查看，不要重复确认。' + error.message,
                true,
              );
              return;
            }
            const message = element('p', error.message);
            message.setAttribute('role', 'alert');
            panel.append(message);
            // Stale-version or uncertain delivery must be freshly inspected,
            // never silently re-use a destructive-operation confirmation.
            confirm.disabled = true;
            const retry = element('button', '重新核对');
            retry.type = 'button';
            retry.addEventListener('click', () => show(book, action, launcher));
            panel.append(retry);
          }
        } finally {
          submitting = false;
          if (!disposed) {
            setBusy(false);
            cancel.disabled = false;
          }
        }
      });
    } catch (error) {
      if (owner === token && !disposed) {
        progress.textContent = error.message;
        progress.setAttribute('role', 'alert');
      }
    }
  }
  return {
    show,
    dispose() {
      disposed = true;
      owner = null;
      panel.remove();
    },
  };
}
