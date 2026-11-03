// Embedded into the hash-pinned native layout adapter. These helpers own only
// focus/keyboard presentation; original layout.narrowExpanded owns visibility.
// Never inspect editor text, input values, session data or model state.
export function drawerFocusables(sidebar) {
  return [...sidebar.querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex]')].filter(
    (node) =>
      node.tabIndex >= 0 &&
      !node.disabled &&
      !node.matches(':disabled') &&
      !node.closest('[hidden],[inert]') &&
      node.getClientRects().length > 0,
  );
}

export function focusNativeDrawer(frame, open, wasOpen) {
  if (!frame) return;
  const sidebar = frame.querySelector('.novel-native-sidebar-column');
  if (!sidebar) return;
  if (open) {
    const target = sidebar.querySelector('.novel-sidebar-toggle') ?? drawerFocusables(sidebar)[0] ?? sidebar;
    target.focus({ preventScroll: true });
    // Only drawer ancestors scroll; the manuscript is a sibling. A retained
    // short-screen scroll position must not hide the focused close control.
    target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    return;
  }
  if (!wasOpen) return;
  const active = frame.ownerDocument.activeElement;
  // Native settings/approval dialogs own their own focus. Do not take it back
  // when a navigation action has just opened one outside this sidebar.
  if (
    active !== frame.ownerDocument.body &&
    !sidebar.contains(active) &&
    active !== frame.querySelector('.novel-navigation-scrim')
  )
    return;
  const launcher =
    frame.querySelector('.novel-mobile-navigation-toggle') ?? sidebar.querySelector('.novel-sidebar-toggle');
  if (launcher?.getClientRects().length) launcher.focus({ preventScroll: true });
}

export function handleNativeDrawerKey(event, frame, close) {
  if (event.defaultPrevented || !frame) return;
  const sidebar = frame.querySelector('.novel-native-sidebar-column');
  if (
    !sidebar ||
    (!sidebar.contains(event.target) && event.target !== frame.querySelector('.novel-navigation-scrim'))
  )
    return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
  } else if (event.key === 'Tab') {
    const nodes = drawerFocusables(sidebar),
      active = frame.ownerDocument.activeElement;
    const atBoundary = event.shiftKey ? active === nodes[0] : active === nodes.at(-1);
    if (!nodes.length || atBoundary || !nodes.includes(active)) {
      event.preventDefault();
      event.stopPropagation();
      (event.shiftKey ? nodes.at(-1) : nodes[0])?.focus({ preventScroll: true });
      if (!nodes.length) sidebar.focus({ preventScroll: true });
    }
  }
}
