import {
  EditorState,
  EditorView,
  Transaction,
  keymap,
  drawSelection,
  defaultKeymap,
  history,
  historyKeymap,
} from './editor-vendor.mjs';
import { editorText, editorValue, editorRange, editorChange } from './editor-text.mjs';
import { illustrationExtension, prepareIllustration } from './illustration-editor.mjs';
import {
  insertIllustration,
  illustrationMarker,
  illustrationEntries,
} from '../../../worker/shared/illustrations.mjs';
// EditorView is an ephemeral rendering/undo view of the EXISTING manuscript
// draft. No second persisted body, API, autosave loop or task lifecycle.
export function createProseEditor(React) {
  return function ProseEditor({
    value,
    onChange,
    onSelection,
    onSave,
    readOnly = false,
    label = '书稿正文',
    revealLine = null,
    illustrationApi = null,
  }) {
    const host = React.useRef(null),
      view = React.useRef(null),
      applying = React.useRef(false);
    const latest = React.useRef({});
    const [hidden, setHidden] = React.useState(false),
      [toolsOpen, setToolsOpen] = React.useState(false),
      [caption, setCaption] = React.useState(''),
      [uploading, setUploading] = React.useState(false),
      [message, setMessage] = React.useState(''),
      [album, setAlbum] = React.useState(null);
    const fileInput = React.useRef(null),
      replacement = React.useRef(null),
      mounted = React.useRef(true),
      illustrations = React.useRef(null),
      insertionPoint = React.useRef(null),
      uploadingNow = React.useRef(false);
    latest.current = { value, onChange, onSelection, onSave, illustrationApi, hidden, readOnly };
    React.useEffect(() => {
      if (!toolsOpen || !illustrationApi) return;
      let alive = true;
      illustrationApi('illustrations')
        .then((value) => {
          if (alive) setAlbum(value);
        })
        .catch((error) => {
          if (alive) setMessage(error.message);
        });
      return () => {
        alive = false;
      };
    }, [toolsOpen, illustrationApi]);
    function insertSaved(imagePath, label) {
      const editor = view.current,
        source = latest.current.value;
      if (!editor || latest.current.readOnly) return;
      const range = editorRange(
        editor.state.doc.toString(),
        insertionPoint.current === null ? editor.state.doc.length : editor.state.selection.main.to,
        insertionPoint.current === null ? editor.state.doc.length : editor.state.selection.main.to,
        source,
      );
      editor.dispatch({
        changes: editorChange(
          editor.state.doc.toString(),
          editorValue(insertIllustration(source, imagePath, label, range.end)),
        ),
        userEvent: 'input',
      });
      setMessage('已插入；随正文保存。');
      setToolsOpen(false);
    }
    async function upload(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file || uploadingNow.current) return;
      const editor = view.current,
        source = latest.current.value,
        ownerApi = latest.current.illustrationApi,
        before = editor?.state.doc.toString(),
        at = insertionPoint.current === null ? editor?.state.doc.length : editor?.state.selection.main.to,
        target = replacement.current;
      if (!editor || !ownerApi || latest.current.readOnly) return;
      uploadingNow.current = true;
      setUploading(true);
      setMessage('正在处理插图…');
      try {
        const content = await prepareIllustration(file, caption || file.name.replace(/\.[^.]+$/, ''));
        if (!mounted.current) return;
        setMessage('正在保存插图…');
        const result = await ownerApi('illustrations', { action: 'upload', content });
        if (!mounted.current) return;
        if (
          view.current !== editor ||
          ownerApi !== latest.current.illustrationApi ||
          before !== editor.state.doc.toString() ||
          source !== latest.current.value
        )
          throw new Error('插图已存入本书，期间正文或位置发生变化；请重新选择位置插入。');
        const label = caption || file.name.replace(/\.[^.]+$/, '');
        if (target) {
          if (before.slice(target.from, target.to) !== target.marker)
            throw new Error('原插图位置已变化，请重新选择。');
          editor.dispatch({
            changes: {
              from: target.from,
              to: target.to,
              insert: illustrationMarker(result.imagePath, label),
            },
            userEvent: 'input',
          });
        } else {
          const range = editorRange(before, at, at, source);
          editor.dispatch({
            changes: editorChange(
              before,
              editorValue(insertIllustration(source, result.imagePath, label, range.end)),
            ),
            userEvent: 'input',
          });
        }
        setMessage('已插入；随正文保存。');
        setCaption('');
        setToolsOpen(false);
      } catch (error) {
        if (mounted.current) setMessage(error.message);
      } finally {
        uploadingNow.current = false;
        replacement.current = null;
        if (mounted.current) setUploading(false);
      }
    }
    React.useLayoutEffect(() => {
      mounted.current = true;
      const editor = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: editorValue(latest.current.value),
          extensions: [
            ...(illustrationApi
              ? [
                  (() => {
                    const addon = illustrationExtension({
                      hidden: () => latest.current.hidden,
                      readOnly: () => latest.current.readOnly,
                      read: (imagePath) =>
                        latest.current.illustrationApi('illustrations', null, { action: 'read', imagePath }),
                      replace: (entry) => {
                        replacement.current = entry;
                        setCaption(entry.caption);
                        fileInput.current?.click();
                      },
                    });
                    illustrations.current = addon;
                    return addon.extension;
                  })(),
                ]
              : []),
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            drawSelection(),
            EditorView.lineWrapping,
            EditorView.contentAttributes.of({
              'aria-label': label,
              spellcheck: 'false',
              autocorrect: 'off',
              autocapitalize: 'off',
            }),
            EditorView.domEventHandlers({
              keydown(event) {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                  event.preventDefault();
                  event.stopPropagation();
                  latest.current.onSave?.();
                  return true;
                }
                return false;
              },
            }),
            EditorView.updateListener.of((update) => {
              if (applying.current || (!update.docChanged && !update.selectionSet)) return;
              const props = latest.current,
                normalized = update.state.doc.toString();
              const source = update.docChanged ? editorText(normalized, props.value) : props.value;
              if (update.docChanged) props.onChange(source);
              const selection = update.state.selection.main;
              if (update.view.hasFocus) insertionPoint.current = selection.to;
              props.onSelection?.(editorRange(normalized, selection.from, selection.to, source));
            }),
          ],
        }),
      });
      view.current = editor;
      // Keep the ORIGINAL focused selection visible when keyboard/viewport
      // geometry changes. The editor owns scrolling; no document/selection
      // rewrite, draft copy or independent caret controller.
      let viewportFrame;
      const viewport = globalThis.visualViewport;
      const canReveal = () => editor.hasFocus && (!viewport || viewport.scale === 1);
      const revealCaret = () => {
        if (!canReveal() || viewportFrame !== undefined) return;
        viewportFrame = requestAnimationFrame(() => {
          viewportFrame = undefined;
          if (canReveal())
            editor.dispatch({
              effects: EditorView.scrollIntoView(editor.state.selection.main.head, { y: 'nearest' }),
            });
        });
      };
      viewport?.addEventListener('resize', revealCaret);
      window.addEventListener('resize', revealCaret);
      return () => {
        mounted.current = false;
        viewport?.removeEventListener('resize', revealCaret);
        window.removeEventListener('resize', revealCaret);
        if (viewportFrame !== undefined) cancelAnimationFrame(viewportFrame);
        view.current = null;
        editor.destroy();
      };
    }, []);
    React.useLayoutEffect(() => {
      if (view.current && illustrations.current)
        view.current.dispatch({ effects: illustrations.current.refresh.of(null) });
    }, [hidden]);
    React.useLayoutEffect(() => {
      const editor = view.current,
        normalized = editorValue(value);
      if (!editor) return;
      const change = editorChange(editor.state.doc.toString(), normalized);
      if (!change) return;
      applying.current = true;
      try {
        editor.dispatch({
          changes: change,
          annotations: Transaction.addToHistory.of(false),
        });
      } finally {
        applying.current = false;
      }
    }, [value]);
    React.useLayoutEffect(() => {
      const editor = view.current;
      if (!editor || !readOnly || !revealLine) return;
      const line = Math.max(1, Math.min(editor.state.doc.lines, revealLine.line));
      editor.dispatch({
        effects: EditorView.scrollIntoView(editor.state.doc.line(line).from, { y: 'start' }),
      });
    }, [revealLine?.line, revealLine?.request, readOnly]);
    const h = React.createElement;
    return h(
      React.Fragment,
      null,
      illustrationApi && !readOnly
        ? h(
            'div',
            { className: 'novel-illustration-toolbar' },
            h(
              'button',
              { type: 'button', 'aria-expanded': toolsOpen, onClick: () => setToolsOpen(!toolsOpen) },
              '▧ 插图',
            ),
            illustrationEntries(value).length
              ? h(
                  'button',
                  { type: 'button', 'aria-pressed': hidden, onClick: () => setHidden(!hidden) },
                  hidden ? '展开插图' : '收起插图',
                )
              : null,
            h('input', {
              type: 'file',
              ref: fileInput,
              accept: 'image/png,image/jpeg,image/webp',
              hidden: true,
              onChange: upload,
              'aria-label': '上传章节插图',
            }),
            toolsOpen
              ? h(
                  'div',
                  { className: 'novel-illustration-options' },
                  h('input', {
                    value: caption,
                    maxLength: 160,
                    'aria-label': '新插图图注',
                    placeholder: '图注（选填）',
                    onChange: (e) => setCaption(e.target.value),
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: uploading,
                      onClick: () => {
                        replacement.current = null;
                        fileInput.current?.click();
                      },
                    },
                    uploading ? '上传中…' : '选图插入',
                  ),
                  h('small', null, '在光标所在段落后插入；未选位置则在章末。'),
                  album?.images?.length
                    ? h(
                        'div',
                        {
                          className: 'novel-illustration-album',
                          role: 'group',
                          'aria-label': '本书已有插图',
                        },
                        ...album.images.map((image) =>
                          h(
                            'button',
                            {
                              key: image.imagePath,
                              type: 'button',
                              onClick: () => insertSaved(image.imagePath, image.label || ''),
                            },
                            image.label || '未命名插图',
                          ),
                        ),
                        album.nextCursor
                          ? h(
                              'button',
                              {
                                type: 'button',
                                onClick: async () => {
                                  try {
                                    const next = await latest.current.illustrationApi('illustrations', null, {
                                      cursor: album.nextCursor,
                                    });
                                    if (mounted.current)
                                      setAlbum((previous) => ({
                                        images: [...previous.images, ...next.images],
                                        nextCursor: next.nextCursor,
                                      }));
                                  } catch (error) {
                                    if (mounted.current) setMessage(error.message);
                                  }
                                },
                              },
                              '更多插图',
                            )
                          : null,
                      )
                    : null,
                )
              : null,
            message ? h('small', { role: 'status' }, message) : null,
          )
        : null,
      h('div', { className: 'novel-prose-editor', ref: host }),
    );
  };
}
