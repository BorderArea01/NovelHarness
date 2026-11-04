import { makeWorkspaceClient } from './workspace.mjs';
import { collectReadingEdition, renderReadingEdition } from './reading-edition.mjs';
export function createReadingExport(React) {
  const h = React.createElement;
  return function ReadingExport({ api, hasLocalDraft }) {
    const [format, setFormat] = React.useState('txt'),
      [running, setRunning] = React.useState(false),
      [message, setMessage] = React.useState('');
    const controller = React.useRef(null);
    const localDraft = React.useRef(hasLocalDraft);
    localDraft.current = hasLocalDraft;
    const client = React.useMemo(() => makeWorkspaceClient(), []);
    React.useEffect(
      () => () => {
        controller.current?.abort();
      },
      [api],
    );
    async function download() {
      if (controller.current) return;
      const abort = new AbortController();
      controller.current = abort;
      setRunning(true);
      setMessage('正在读取正式正文…');
      try {
        const edition = await collectReadingEdition(api, client.readFile, {
          includeImages: format !== 'txt',
          signal: abort.signal,
          onProgress: (p) =>
            setMessage((p.phase === 'read' ? '读取' : '校验') + ' ' + p.done + '/' + p.total),
        });
        const output = renderReadingEdition(edition, format);
        abort.signal.throwIfAborted();
        if (localDraft.current) throw new Error('导出期间产生了未保存修改，未下载旧稿；请保存后重试。');
        const url = URL.createObjectURL(new Blob([output.text], { type: output.type })),
          a = document.createElement('a');
        a.href = url;
        a.download = output.filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage(
          '已导出 ' +
            edition.chapters.length +
            ' 章' +
            (edition.skipped ? '，跳过 ' + edition.skipped + ' 个空章' : '') +
            '。',
        );
      } catch (error) {
        if (!abort.signal.aborted) setMessage(error.message);
      } finally {
        if (controller.current === abort) controller.current = null;
        if (!abort.signal.aborted) setRunning(false);
      }
    }
    return h(
      'details',
      { className: 'novel-reading-export' },
      h('summary', null, '导出成稿'),
      h(
        'div',
        { className: 'novel-reading-export-options' },
        h(
          'label',
          null,
          '格式',
          h(
            'select',
            {
              'aria-label': '成稿格式',
              value: format,
              disabled: running,
              onChange: (e) => setFormat(e.target.value),
            },
            h('option', { value: 'txt' }, 'TXT'),
            h('option', { value: 'markdown' }, 'Markdown'),
            h('option', { value: 'html' }, 'HTML 阅读版'),
          ),
        ),
        h(
          'button',
          { type: 'button', disabled: running || hasLocalDraft, onClick: download },
          running ? '正在导出…' : '下载成稿',
        ),
        running
          ? h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  controller.current?.abort();
                  setRunning(false);
                  setMessage('已取消，未下载文件。');
                },
              },
              '取消导出',
            )
          : null,
      ),
      h(
        'p',
        null,
        hasLocalDraft
          ? '先保存当前本机修改，避免成稿遗漏它们。'
          : '按当前章节目录导出正式正文，不含未接受候选；完整备份仍在小说库。',
      ),
      message ? h('p', { role: 'status', 'aria-live': 'polite' }, message) : null,
    );
  };
}
