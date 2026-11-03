import { IMPORT_LIMIT, makeBookBundle, writingPrompt } from './bundle.mjs';
import { makeWorkspaceClient } from './workspace.mjs';
import { BACKUP_FORMAT, BACKUP_JSON_LIMIT, restoreBackup } from './backup.mjs';
import { conversationTitle } from './conversation-title.mjs';
import { bookManagement } from './book-management.mjs';

export function mountLibrary(
  root,
  {
    navigateBook,
    renameBook,
    decorateBook = (book) => book,
    subscribeBooks,
    getActivity,
    subscribeActivity,
    navigateSession,
    stopActivity,
    refreshActivity,
    archiveBookSessions,
  } = {},
) {
  const $ = (id) => root.querySelector('#' + id);
  const client = makeWorkspaceClient();
  let pending = null,
    controller = null,
    busy = false,
    disposed = false,
    trashView = false;
  const cards = new Map();
  const creationId = crypto.randomUUID();
  const management = bookManagement(root, {
    client,
    setBusy,
    status,
    refresh: loadBooks,
    archiveSessions: archiveBookSessions,
    openBook,
  });

  function renderActivity(card) {
    if (!getActivity || disposed) return;
    const value = getActivity(card.book),
      signature = JSON.stringify([value, card.stopping, card.error]);
    if (card.signature === signature) return; // Native token deltas do not reset focus/disclosure.
    card.signature = signature;
    const owner = root.ownerDocument ?? root,
      area = card.activity;
    const focused = area.contains(owner.activeElement) ? owner.activeElement : null;
    const focusedId = focused?.closest('.book-session')?.dataset.sessionId;
    const focusedAction = focused?.dataset.action;
    const expanded = area.querySelector('details')?.open ?? false;
    card.node.querySelector('.open-book').hidden = false;
    area.replaceChildren();
    area.hidden = !value.notice && !value.rows.some((row) => row.kind !== 'idle');
    if (value.notice) {
      const notice = owner.createElement('p');
      notice.setAttribute('role', 'status');
      notice.textContent = value.notice;
      area.append(notice);
    }
    function rowNode(row) {
      const node = owner.createElement('div');
      node.className = 'book-session';
      node.dataset.sessionId = row.id;
      node.dataset.state = row.kind;
      const label = owner.createElement('div'),
        title = owner.createElement('strong'),
        state = owner.createElement('span');
      title.textContent = conversationTitle(row.title);
      state.textContent = row.text;
      label.append(title, state);
      node.append(label);
      const actions = owner.createElement('div');
      actions.className = 'book-session-actions';
      const view = owner.createElement('button');
      view.type = 'button';
      view.dataset.action = 'view';
      view.textContent = row.canStop ? '查看过程' : '查看对话';
      view.setAttribute('aria-label', '查看对话：' + conversationTitle(row.title));
      view.addEventListener('click', () => {
        if (busy) return;
        try {
          navigateSession(card.book, row.id);
        } catch (error) {
          card.error = error.message;
          card.signature = '';
          renderActivity(card);
        }
      });
      actions.append(view);
      if (row.canStop) {
        const stop = owner.createElement('button');
        stop.type = 'button';
        stop.dataset.action = 'stop';
        stop.textContent = card.stopping === row.id ? '正在停止…' : '停止 AI';
        stop.disabled = !!card.stopping;
        stop.addEventListener('click', async () => {
          if (card.stopping) return;
          card.stopping = row.id;
          card.error = '';
          renderActivity(card);
          try {
            await stopActivity(card.book, row.id);
          } catch (error) {
            card.error = error.message;
          } finally {
            card.stopping = null;
            renderActivity(card);
          }
        });
        actions.append(stop);
      }
      node.append(actions);
      return node;
    }
    const important = value.rows.filter((row) => row.kind !== 'idle');
    const visible = important.slice(0, 3);
    for (const row of visible) area.append(rowNode(row));
    const visibleIds = new Set(visible.map((row) => row.id));
    const rest = value.rows.filter((row) => row.kind !== 'idle' && !visibleIds.has(row.id));
    if (rest.length) {
      const details = owner.createElement('details'),
        summary = owner.createElement('summary');
      details.open = expanded;
      summary.textContent = '其他对话 · ' + rest.length;
      details.append(summary);
      let shown = 0;
      const more = owner.createElement('button');
      more.type = 'button';
      more.textContent = '显示更多对话';
      const append = (size = 10) => {
        for (const row of rest.slice(shown, shown + size)) details.insertBefore(rowNode(row), more);
        shown += size;
        card.shownOther = shown;
        more.hidden = shown >= rest.length;
      };
      more.addEventListener('click', () => append());
      details.append(more);
      append(card.shownOther ?? 10);
      area.append(details);
    }
    if (card.error) {
      const error = owner.createElement('p');
      error.setAttribute('role', 'alert');
      error.textContent = card.error;
      area.append(error);
    }
    if (focusedId) {
      const row = [...area.querySelectorAll('.book-session')].find(
        (node) => node.dataset.sessionId === focusedId,
      );
      const target =
        row?.querySelector('[data-action="' + focusedAction + '"]:not(:disabled)') ??
        row?.querySelector('[data-action="view"]');
      target?.focus({ preventScroll: true });
    }
  }

  function updatePresentation() {
    for (const card of cards.values()) {
      card.node.querySelector('h3').textContent = decorateBook(card.book).title;
      renderActivity(card);
    }
  }

  function status(message, error = false) {
    $('status').textContent = message;
    $('status').classList.toggle('error', error);
  }
  function setBusy(value, cancelable = false) {
    busy = value;
    for (const id of [
      'create-book',
      'upload',
      'dismiss',
      'refresh',
      'project-file',
      'new-book',
      'create-next',
      'create-back',
      'create-dismiss',
    ])
      if ($(id)) $(id).disabled = value;
    $('cancel').hidden = !value || !cancelable;
  }
  function counts(book) {
    const s = book.stats;
    return `${s.chapters} 章 · ${s.chats} 个聊天窗口 · ${s.snapshots} 个快照 · ${s.operationLogs} 条日志 · ${s.agentHistory} 条 Agent 历史`;
  }
  async function openBook(book) {
    writingPrompt(book); // Validate the book identity before constructing navigation.
    if (navigateBook) {
      status('正在打开小说…');
      return navigateBook(book);
    }
    window.location.assign(`/?novel=${encodeURIComponent(book.id)}`);
  }
  async function loadBooks() {
    const books = trashView ? await client.trash() : await client.list();
    if (disposed) return 0;
    $('books').replaceChildren();
    cards.clear();
    for (const book of books) {
      const owner = root.ownerDocument ?? root,
        node = owner.createElement('article');
      node.className = 'book';
      node.dataset.bookId = book.id;
      for (const [tag, className, text] of [
        ['h3', '', ''],
        ['p', 'book-stats', ''],
        ['div', 'actions', ''],
      ]) {
        const child = owner.createElement(tag);
        child.className = className;
        child.textContent = text;
        node.append(child);
      }
      for (const [className, label] of [
        ['open-book', '进入创作'],
        ['backup-book quiet', '备份'],
      ]) {
        const button = owner.createElement('button');
        button.className = className;
        button.textContent = label;
        node.querySelector('.actions').append(button);
      }
      if (trashView) {
        node.querySelector('.actions').replaceChildren();
        const restore = owner.createElement('button');
        restore.type = 'button';
        restore.textContent = '恢复小说';
        restore.addEventListener('click', () => {
          if (!busy) management.show({ ...book, title: decorateBook(book).title }, 'restore', restore);
        });
        node.querySelector('.actions').append(restore);
        node.querySelector('h3').textContent = decorateBook(book).title;
        $('books').append(node);
        continue;
      }
      node.querySelector('h3').textContent = decorateBook(book).title;
      // The import receipt is not a live word-count/progress source.
      node.querySelector('.book-stats').hidden = true;
      const activity = owner.createElement('section');
      activity.className = 'book-activity';
      activity.setAttribute('aria-label', '本书对话状态');
      activity.hidden = true;
      node.insertBefore(activity, node.querySelector('.actions'));
      const card = { book, node, activity, stopping: null, error: '' };
      cards.set(book.id, card);
      renderActivity(card);
      node.querySelector('.open-book').addEventListener('click', () => {
        if (!busy) openBook(book).catch((error) => status(error.message, true));
      });
      node.querySelector('.backup-book').addEventListener('click', () => backupBook(book));
      for (const [action, label] of [
        ['restart', '重新开始'],
        ['delete', '删除整本书'],
      ]) {
        const button = owner.createElement('button');
        button.type = 'button';
        button.dataset.variant = action === 'delete' ? 'danger' : 'secondary';
        button.textContent = label;
        button.addEventListener('click', () => {
          if (!busy) management.show({ ...book, title: decorateBook(book).title }, action, button);
        });
        node.querySelector('.actions').append(button);
      }
      if (renameBook) {
        const toggle = owner.createElement('button');
        toggle.type = 'button';
        toggle.textContent = '改名';
        const form = owner.createElement('form');
        form.className = 'novel-book-rename';
        form.hidden = true;
        const input = owner.createElement('input');
        input.setAttribute('aria-label', '小说新书名');
        input.maxLength = 120;
        input.required = true;
        const save = owner.createElement('button');
        save.type = 'submit';
        save.textContent = '保存书名';
        const cancel = owner.createElement('button');
        cancel.type = 'button';
        cancel.textContent = '取消改名';
        form.append(input, save, cancel);
        node.append(form);
        node.querySelector('.actions').append(toggle);
        toggle.addEventListener('click', () => {
          if (!busy) {
            form.hidden = false;
            input.value = decorateBook(book).title;
            input.focus();
          }
        });
        cancel.addEventListener('click', () => {
          if (!busy) {
            form.hidden = true;
            toggle.focus();
          }
        });
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const title = input.value.trim();
          if (busy || !title) return;
          if (/[\u0000-\u001f\u007f]/.test(title)) {
            status('书名不能包含控制字符。', true);
            return;
          }
          setBusy(true);
          save.disabled = true;
          cancel.disabled = true;
          try {
            await renameBook(book, title);
            if (!disposed) {
              form.hidden = true;
              updatePresentation();
              status('书名已更新，书稿与对话未改动。');
            }
          } catch (error) {
            if (!disposed) status(error.message, true);
          } finally {
            if (!disposed) {
              setBusy(false);
              save.disabled = false;
              cancel.disabled = false;
            }
          }
        });
      }
      $('books').append(node);
    }
    return books.length;
  }
  async function backupBook(book) {
    if (busy) return;
    controller = new AbortController();
    setBusy(true, true);
    status('正在读取本书最新文件；请先停止本书生成或其他设备编辑。备份不含 DSH 对话与全局配置。');
    try {
      const snapshot = await client.backup(book.id, {
        signal: controller.signal,
        onProgress: ({ phase, done, total }) =>
          status(
            `${phase === 'read' ? '读取' : '复核'}备份 ${done} / ${total}；请勿同时编辑本书，可随时停止。`,
          ),
      });
      const blob = new Blob([JSON.stringify(snapshot)], { type: 'application/json' });
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = `${String(snapshot.title || '小说')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .slice(0, 80)}-本书备份.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      status(
        `已将 ${snapshot.files.length} 个最新文件交给浏览器下载。此为非原子校验备份，不含 DSH 对话或全局凭证；请妥善保管。`,
      );
    } catch (error) {
      status(
        error.name === 'AbortError' ? '备份已停止，未修改云端文件，也未下载不完整档案。' : error.message,
        true,
      );
    } finally {
      setBusy(false);
      controller = null;
    }
  }
  async function refresh() {
    if (busy) return;
    status('正在读取书库…');
    try {
      const [count] = await Promise.all([loadBooks(), refreshActivity?.()]);
      status(count ? `${count} 本小说` : '还没有小说。新建一本，或导入已有作品。');
    } catch (error) {
      status(error.message, true);
    }
  }
  async function upload(bundle, { created = false } = {}) {
    if (busy) return;
    controller = new AbortController();
    setBusy(true, true);
    let imported = null;
    try {
      if (created) status('正在创建小说…');
      const result = await (created ? client.create : client.import)(bundle, {
        signal: controller.signal,
        onProgress: ({ done, total }) =>
          status(`正在上传并校验 ${done} / ${total} 个文件，可随时停止；原项目不会改动。`),
      });
      imported = result.book;
      pending = null;
      $('import-preview').hidden = true;
      status(
        created
          ? '作品已创建。设定与提示词可以在书内继续完善。'
          : result.alreadyImported
            ? bundle.backup
              ? '这份备份已恢复过，未覆盖副本中的新改动。'
              : '这份内容已经导入，未覆盖已有小说。'
            : bundle.backup
              ? '已逐文件校验并恢复为独立副本，原书未覆盖。DSH 对话和全局配置不在此备份范围内。'
              : '已导入并逐文件校验；旧对话、快照与修改记录可在书内“设定 → 导入记录”阅读。',
      );
      if (!created) {
        try {
          await loadBooks();
        } catch {
          status('导入已完成，但书库刷新失败。请点刷新，不需要重新导入。', true);
        }
      }
    } catch (error) {
      status(
        error.name === 'AbortError'
          ? created
            ? '创建请求已停止。若保存已完成会出现在书库；原信息重试不会重复创建或覆盖。'
            : '上传已停止，原文件未改动；用同一文件重试可继续校验已上传内容。'
          : error.message,
        true,
      );
    } finally {
      setBusy(false);
      controller = null;
    }
    return imported;
  }
  let createStep = 1;
  function showCreateStep(step) {
    createStep = step;
    $('create-identity').hidden = step !== 1;
    $('create-premise').hidden = step !== 2;
    $('create-back').hidden = step !== 2;
    $('create-next').hidden = step !== 1;
    $('create-book').hidden = step !== 2;
    $('create-step-title').textContent = step === 1 ? '1 / 2 · 为作品命名' : '2 / 2 · 留下故事起点';
    (step === 1 ? $('book-title') : $('seed')).focus();
  }
  $('new-book')?.addEventListener('click', () => {
    if (busy) return;
    $('create-guide').hidden = false;
    showCreateStep(1);
  });
  $('create-next')?.addEventListener('click', () => {
    if ($('book-title').reportValidity() && $('book-title').value.trim()) showCreateStep(2);
  });
  $('create-back')?.addEventListener('click', () => showCreateStep(1));
  $('create-dismiss')?.addEventListener('click', () => {
    if (busy) return;
    $('create-guide').hidden = true;
    $('new-book').focus();
  });
  $('seed-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    if ($('book-title') && !$('book-title').value.trim()) {
      showCreateStep(1);
      return;
    }
    if ($('create-guide') && createStep === 1) {
      if ($('book-title').reportValidity()) showCreateStep(2);
      return;
    }
    try {
      setBusy(true);
      const bundle = $('book-title')
        ? await makeBookBundle({
            creationId,
            state: {
              project: {
                title: $('book-title').value.trim(),
                genre: $('book-genre').value.trim(),
                setting: '',
                characters: '',
              },
              seed: $('seed').value,
              outline: [],
              chapters: [],
            },
          })
        : await makeBookBundle(null, { seed: $('seed').value });
      setBusy(false);
      const book = await upload(bundle, { created: !!$('book-title') });
      if (book && !disposed) await openBook(book);
    } catch (error) {
      status(error.message, true);
    } finally {
      if (!controller) setBusy(false);
    }
  });
  $('project-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy) return;
    setBusy(true);
    try {
      pending = null;
      $('import-preview').hidden = true;
      if (file.size > BACKUP_JSON_LIMIT) throw new Error('文件超过 90 MiB 备份文件读取上限，原文件未改动。');
      status('正在本地检查项目，不会调用 AI…');
      const text = await file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('文件不是有效 JSON。');
      }
      const isBackup = data?.format === BACKUP_FORMAT;
      if (!isBackup && file.size > IMPORT_LIMIT)
        throw new Error('旧项目超过本轮 32 MiB 导入上限，原文件未改动。');
      pending = isBackup ? await restoreBackup(data) : await makeBookBundle(data);
      $('preview-heading').textContent = isBackup ? '恢复预览' : '导入预览';
      $('upload').textContent = isBackup ? '恢复为副本' : '确认导入';
      $('preview-title').textContent = pending.manifest.title;
      $('preview-counts').textContent = isBackup
        ? `${pending.files.length} 个文件 · ${(pending.totalBytes / 1024).toFixed(1)} KiB；原书保留`
        : counts(pending.manifest);
      $('preview-warning').textContent = isBackup
        ? '恢复到独立小说目录，不覆盖原书。正文与资料逐字节校验；原 book.json 更换为副本收据，正文中的旧绝对路径不会自动改写。此备份不含 DSH 原生对话和全局配置。'
        : '章节正文单独保存；旧聊天、快照和历史完整保留在迁移归档中。凭证字段不会上传；原 JSON 请在本机保留备份。迁移不调用 AI、不重生成正文。';
      $('import-preview').hidden = false;
      status('检查完成，确认后才上传。');
    } catch (error) {
      status(error.message, true);
    } finally {
      setBusy(false);
    }
  });
  $('upload').addEventListener('click', () => {
    if (pending) upload(pending);
  });
  $('dismiss').addEventListener('click', () => {
    pending = null;
    $('import-preview').hidden = true;
    status('已取消，未上传。');
  });
  $('cancel').addEventListener('click', () => controller?.abort());
  $('refresh').addEventListener('click', refresh);
  $('show-trash')?.addEventListener('click', async () => {
    if (busy) return;
    trashView = !trashView;
    $('show-trash').textContent = trashView ? '返回书库' : '回收站';
    await refresh();
  });
  refresh();
  const unsubscribe = subscribeBooks?.(updatePresentation);
  const unsubscribeActivity = subscribeActivity?.(updatePresentation);
  return () => {
    disposed = true;
    management.dispose();
    controller?.abort();
    unsubscribe?.();
    unsubscribeActivity?.();
    cards.clear();
  };
}
