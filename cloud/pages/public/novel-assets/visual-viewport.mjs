// Presentation only. The browser owns keyboard/zoom state; never retain text,
// infer a task, change the user's zoom, or create another input controller.
const NATIVE_SETTINGS_NAV = '[data-shortcut-modal="settings"] > nav > div:last-child > button';
const NATIVE_SETTINGS_BODY = '[data-shortcut-modal="settings"] > div > div:last-child';
const NATIVE_FIELD = 'textarea, input:not([type="checkbox"]), select';

// Scroll only the control's existing owner. The original native modal keeps
// focus, form values and commit/cancel; no focus call or document scrolling.
export function revealFocusedControl(window) {
  if (window.innerWidth >= 1024 || window.visualViewport?.scale !== 1) return;
  const field = window.document.activeElement;
  if (!field) return;
  if (field.matches?.(NATIVE_SETTINGS_NAV)) {
    const nav = field.parentElement,
      bounds = nav.getBoundingClientRect(),
      rect = field.getBoundingClientRect();
    if (rect.right > bounds.right) nav.scrollLeft += rect.right - bounds.right;
    else if (rect.left < bounds.left) nav.scrollLeft += rect.left - bounds.left;
  } else if (field.matches?.(NATIVE_FIELD)) {
    const manuscript = field.closest('.novel-ms-body');
    if (manuscript && !visibleViewport(window)) return;
    const body = manuscript ?? field.closest(NATIVE_SETTINGS_BODY);
    if (!body) return;
    const bounds = body.getBoundingClientRect(),
      rect = field.getBoundingClientRect(),
      style = window.getComputedStyle?.(body),
      top = bounds.top + (parseFloat(style?.scrollPaddingTop) || 0),
      bottom = bounds.bottom - (parseFloat(style?.scrollPaddingBottom) || 0);
    if (rect.bottom > bottom) body.scrollTop += rect.bottom - bottom;
    else if (rect.top < top) body.scrollTop += rect.top - top;
  }
}

export function visibleViewport(window) {
  const viewport = window?.visualViewport;
  if (!viewport || viewport.scale !== 1 || window.innerWidth >= 1024) return null;
  if (!Number.isFinite(window.innerHeight) || window.innerHeight <= 0) return null;
  if (!Number.isFinite(viewport.height) || viewport.height <= 0) return null;
  const height = Math.min(window.innerHeight, viewport.height);
  const top = Math.min(Math.max(0, viewport.offsetTop || 0), Math.max(0, window.innerHeight - height));
  return height < window.innerHeight || top ? { height, top } : null;
}

export function bindVisibleViewport(window = globalThis.window) {
  const root = window?.document?.documentElement;
  if (!root || !window.visualViewport) return () => {};
  let frame,
    revealFrame,
    disposed = false;
  const clear = () => {
    root.style.removeProperty('--novel-visible-height');
    root.style.removeProperty('--novel-visible-top');
    root.removeAttribute('data-novel-visible-viewport');
  };
  const scheduleReveal = () => {
    if (disposed) return;
    if (revealFrame !== undefined) window.cancelAnimationFrame(revealFrame);
    const field = window.document.activeElement;
    if (!field?.matches?.(NATIVE_FIELD) && !field?.matches?.(NATIVE_SETTINGS_NAV)) return;
    revealFrame = window.requestAnimationFrame(() => {
      revealFrame = undefined;
      if (!disposed) revealFocusedControl(window);
    });
  };
  const update = () => {
    frame = undefined;
    if (disposed) return;
    const value = visibleViewport(window);
    if (!value) return clear();
    root.style.setProperty('--novel-visible-height', value.height + 'px');
    root.style.setProperty('--novel-visible-top', value.top + 'px');
    root.setAttribute('data-novel-visible-viewport', '');
    // A native field may have been focused before the frame was resized.
    // Reveal it after CSS layout, without reading text, changing selection,
    // scrolling the whole page or duplicating the editor's caret controller.
    scheduleReveal();
  };
  const schedule = () => {
    frame ??= window.requestAnimationFrame(update);
  };
  const sources = [
    [window.visualViewport, 'resize'],
    [window.visualViewport, 'scroll'],
    [window, 'resize'],
  ];
  sources.forEach(([source, event]) => source.addEventListener(event, schedule));
  const focus = (event) => {
    if (event.target?.closest?.('[data-shortcut-modal="settings"]')) scheduleReveal();
  };
  window.document.addEventListener('focusin', focus);
  update();
  return () => {
    disposed = true;
    sources.forEach(([source, event]) => source.removeEventListener(event, schedule));
    window.document.removeEventListener('focusin', focus);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    if (revealFrame !== undefined) window.cancelAnimationFrame(revealFrame);
    clear();
  };
}
