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
  }) {
    const host = React.useRef(null),
      view = React.useRef(null),
      applying = React.useRef(false);
    const latest = React.useRef({});
    latest.current = { value, onChange, onSelection, onSave };
    React.useLayoutEffect(() => {
      const editor = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: editorValue(latest.current.value),
          extensions: [
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
        viewport?.removeEventListener('resize', revealCaret);
        window.removeEventListener('resize', revealCaret);
        if (viewportFrame !== undefined) cancelAnimationFrame(viewportFrame);
        view.current = null;
        editor.destroy();
      };
    }, []);
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
    return React.createElement('div', { className: 'novel-prose-editor', ref: host });
  };
}
