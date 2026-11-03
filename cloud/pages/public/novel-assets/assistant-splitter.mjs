// Resize only the panes. The native conversation/editor remain mounted, so a
// drag cannot discard a streaming response, selection or an unsent message.
const STORAGE_KEY = 'novel-assistant-width-v1';
const MIN_ASSISTANT = 330;
const MIN_WRITING = 420;
const HANDLE = 10;
const BREAKPOINT = 1050;

export function createAssistantSplitter(React) {
  return function AssistantSplitter({ panes, assistantId }) {
    const drag = React.useRef(null);
    const preference = React.useRef(undefined);
    const [size, setSize] = React.useState({ wide: false, width: 0, total: 1 });
    const measure = () => panes.current?.getBoundingClientRect().width ?? 0;
    const apply = (width, total = measure()) => {
      const bounded = Math.round(Math.max(MIN_ASSISTANT, Math.min(total - MIN_WRITING - HANDLE, width)));
      panes.current?.style.setProperty('--novel-assistant-width', bounded + 'px');
      setSize({ wide: total > BREAKPOINT, width: bounded, total: Math.max(1, total) });
      return bounded;
    };
    const save = (width) => {
      preference.current = width / measure();
      try {
        localStorage.setItem(STORAGE_KEY, String(preference.current));
      } catch {
        /* Optional preference. */
      }
    };
    const reset = () => {
      preference.current = undefined;
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* Optional preference. */
      }
      apply(Math.min(460, Math.max(MIN_ASSISTANT, measure() * 0.32)));
    };
    const cancel = () => {
      if (!drag.current) return;
      const previous = drag.current;
      drag.current = null;
      panes.current?.removeAttribute('data-resizing');
      apply(previous.width);
      if (previous.handle.hasPointerCapture(previous.id)) previous.handle.releasePointerCapture(previous.id);
    };
    React.useEffect(() => {
      try {
        const stored = Number(localStorage.getItem(STORAGE_KEY));
        if (Number.isFinite(stored) && stored > 0 && stored < 1) preference.current = stored;
      } catch {
        /* Browser storage can be disabled. */
      }
      const update = () => {
        const total = measure();
        if (total <= BREAKPOINT) cancel();
        apply(
          preference.current === undefined ? Math.min(460, total * 0.32) : total * preference.current,
          total,
        );
      };
      const observer = new ResizeObserver(update);
      observer.observe(panes.current);
      update();
      return () => {
        observer.disconnect();
        // No persistent drag state or global document listeners survive unmount.
        const previous = drag.current;
        drag.current = null;
        panes.current?.removeAttribute('data-resizing');
        if (previous?.handle.hasPointerCapture(previous.id))
          previous.handle.releasePointerCapture(previous.id);
      };
    }, [panes]);
    const finish = (event) => {
      const previous = drag.current;
      if (!previous || previous.id !== event.pointerId) return;
      const width = apply(previous.width + previous.x - event.clientX);
      drag.current = null;
      panes.current?.removeAttribute('data-resizing');
      save(width);
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    };
    return React.createElement('div', {
      className: 'novel-assistant-splitter',
      role: 'separator',
      tabIndex: 0,
      hidden: !size.wide,
      'aria-label': '调整书稿与助手宽度',
      'aria-orientation': 'vertical',
      'aria-controls': assistantId,
      'aria-valuemin': Math.floor((MIN_ASSISTANT / size.total) * 100),
      'aria-valuemax': Math.ceil(((size.total - MIN_WRITING - HANDLE) / size.total) * 100),
      'aria-valuenow': Math.round((size.width / size.total) * 100),
      'aria-valuetext': `助手宽度 ${size.width} 像素`,
      title: '拖动调整宽度；双击恢复默认；左右方向键微调',
      onDoubleClick: reset,
      onPointerDown(event) {
        if (event.button !== 0 || !size.wide) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          id: event.pointerId,
          x: event.clientX,
          width: size.width,
          handle: event.currentTarget,
        };
        panes.current.setAttribute('data-resizing', '');
      },
      onPointerMove(event) {
        const previous = drag.current;
        if (previous?.id === event.pointerId) apply(previous.width + previous.x - event.clientX);
      },
      onPointerUp: finish,
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
      onKeyDown(event) {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', 'Escape'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Escape') return cancel();
        if (event.key === 'Enter') return reset();
        const step = event.shiftKey ? 60 : 24;
        const width =
          event.key === 'Home'
            ? MIN_ASSISTANT
            : event.key === 'End'
              ? measure() - MIN_WRITING - HANDLE
              : size.width + (event.key === 'ArrowLeft' ? step : -step);
        save(apply(width));
      },
    });
  };
}
