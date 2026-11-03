// Presentation routing only. Books, sessions, documents and tasks remain owned
// by the original native catalogs/VFS. No parallel conversation or editor store.
let navigator;
export function bindWorkspaceNavigator(value) {
  navigator = value;
  return () => {
    if (navigator === value) navigator = undefined;
  };
}
export function revealWorkspace(bookId, params = {}) {
  return navigator?.reveal(bookId, params) ?? false;
}
export function revealDialogue() {
  navigator?.dialogue();
}
