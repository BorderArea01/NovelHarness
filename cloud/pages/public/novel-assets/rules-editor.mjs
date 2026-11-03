import { record, parseRules, serializeRules, editRules, PROMPT_LABELS } from './rules-core.mjs';
const scalar = (v) => typeof v === 'string' || v === undefined;
export function createRulesEditor(React) {
  const h = React.createElement;
  function Fold({ title, initial = false, children }) {
    const [open, setOpen] = React.useState(initial);
    return h(
      'details',
      {
        className: 'novel-rules-section',
        open,
        onToggle: (e) => {
          if (e.target === e.currentTarget) setOpen(e.currentTarget.open);
        },
      },
      h('summary', null, title),
      children,
    );
  }
  function Text({ label, value, change, rows = 3 }) {
    return h(
      'label',
      { className: 'novel-rules-field' },
      h('span', null, label),
      scalar(value)
        ? h('textarea', {
            'aria-label': label,
            rows,
            value: value ?? '',
            onChange: (e) => change(e.target.value),
          })
        : h('pre', null, '旧字段格式不同，保留在源文件中。\n' + JSON.stringify(value, null, 2)),
    );
  }
  function ConfirmDelete({ name, remove, reset = false }) {
    const [asked, setAsked] = React.useState(false);
    return asked
      ? h(
          'span',
          { className: 'novel-rules-actions' },
          h(
            'button',
            {
              type: 'button',
              onClick: () => {
                remove();
                setAsked(false);
              },
            },
            (reset ? '确认恢复默认' : '确认删除') + name,
          ),
          h('button', { type: 'button', onClick: () => setAsked(false) }, reset ? '取消恢复' : '取消删除'),
        )
      : h('button', { type: 'button', onClick: () => setAsked(true) }, (reset ? '恢复默认' : '删除') + name);
  }
  function PromptTemplates({ value, emit, direct = false }) {
    const [defaults, setDefaults] = React.useState(null),
      [error, setError] = React.useState(''),
      [retry, setRetry] = React.useState(0);
    React.useEffect(() => {
      const abort = new AbortController();
      setError('');
      fetch('/api/novel-prompt-templates', {
        credentials: 'same-origin',
        redirect: 'error',
        signal: abort.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error('默认模板读取失败（' + response.status + '），自定义内容保留。');
          const result = await response.json();
          if (
            result.version !== 1 ||
            !record(result.defaults) ||
            Object.keys(PROMPT_LABELS).some((key) => typeof result.defaults[key] !== 'string')
          )
            throw new Error('默认模板格式无效，自定义内容保留。');
          if (!abort.signal.aborted) {
            setDefaults(result.defaults);
          }
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(e.message);
        });
      return () => abort.abort();
    }, [retry]);
    if (value.savedPrompts !== undefined && !record(value.savedPrompts))
      return h('p', { role: 'alert' }, '旧提示词格式不同，保留在源文件中；不会自动转换。');
    const saved = value.savedPrompts ?? {},
      keys = [
        ...Object.keys(PROMPT_LABELS),
        ...Object.keys(saved).filter((key) => !Object.hasOwn(PROMPT_LABELS, key)),
      ];
    return h(
      React.Fragment,
      null,
      h(
        'p',
        { className: 'novel-reference-hint' },
        '按需修改对应任务模板，保存后用于新任务。进行中的任务保留原模板。',
      ),

      error
        ? h(
            'p',
            { role: 'alert' },
            error,
            h('button', { type: 'button', onClick: () => setRetry(retry + 1) }, '重试读取模板'),
          )
        : null,
      ...keys.map((key) => {
        const known = Object.hasOwn(PROMPT_LABELS, key),
          custom = Object.hasOwn(saved, key) && saved[key] !== '';
        return h(
          Fold,
          { key, title: known ? PROMPT_LABELS[key] : key, initial: direct && key === 'write' },
          h('p', { className: 'novel-reference-hint' }, custom ? '本书自定义' : '使用工作台默认模板'),
          !custom && !defaults
            ? h('p', null, error ? '默认模板未载入，不能编辑空白替代它。' : '正在读取默认模板…')
            : h(Text, {
                label: '提示词 ' + key,
                value: custom ? saved[key] : (defaults?.[key] ?? saved[key]),
                rows: 12,
                change: (v) => emit({ kind: 'prompt', key, value: v }),
              }),
          custom
            ? h(ConfirmDelete, {
                name: known ? PROMPT_LABELS[key] + '模板' : '提示词 ' + key,
                reset: known,
                remove: () => emit({ kind: 'prompt', key, remove: true }),
              })
            : null,
        );
      }),
      h(
        'details',
        null,
        h('summary', null, '占位符说明'),
        h(
          'p',
          null,
          '{title}、{chapterNumber}、{chapterTitle}、{chapterSummary}、{plotPoints} 使用当前已知信息；{wordCount} 是最低目标，不是上限，超出仍继续完成，不要求确认。{setting}、{characters}、{prevChapters}、{memory} 展开为本书原生文件读取位置，不重复塞入整本书。未知占位符保留并报告，不猜值。',
        ),
      ),
    );
  }
  return function RulesEditor({ text, onChange, onStatus, disabled, promptsOnly = false }) {
    const parsed = React.useMemo(() => {
      try {
        return { value: parseRules(text) };
      } catch (error) {
        return { error: error.message };
      }
    }, [text]);
    if (parsed.error) return h('p', { role: 'alert' }, parsed.error);
    function emit(op) {
      if (disabled) return false;
      try {
        onChange(serializeRules(editRules(parsed.value, op), text));
        return true;
      } catch (error) {
        onStatus(error.message);
        return false;
      }
    }
    return h(
      'fieldset',
      {
        disabled,
        className: 'novel-rules-editor',
        'aria-label': '提示词编辑器',
      },
      h(PromptTemplates, { value: parsed.value, emit, direct: promptsOnly }),
    );
  };
}
