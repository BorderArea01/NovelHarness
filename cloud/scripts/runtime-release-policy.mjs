// This release changes only the existing manuscript protocol, never native
// storage/auth/network owners or schema. Other backend upgrades need review.
export const WRITING_RUNTIME_FILES = new Set([
  'worker/novel-documents.mjs',
  'worker/proposal-tools.mjs',
  'worker/novel-role.mjs',
  'worker/prompt-templates.mjs',
  'worker/shared/writing-context.mjs',
  'worker/shared/writing-prompts.mjs',
]);
// Prompt-only code changes are reviewed separately from host/plugin installation
// and never authorize native, PIN, storage schema, or network modifications.
export const PROMPT_RUNTIME_FILES = new Set([
  'worker/novel-role.mjs',
  'worker/legacy-default-prompts.mjs',
  'worker/prompt-templates.mjs',
  'worker/purge-plugin.mjs',
  'worker/shared/writing-context.mjs',
  'worker/shared/writing-prompts.mjs',
]);
export function isPromptRuntimeRelease(receipt) {
  return (
    receipt?.format === 'novel-local-runtime-release-v1' &&
    receipt.feature === 'prompt-policy' &&
    receipt.backendUnchanged === false &&
    receipt.databaseChanged === false &&
    Array.isArray(receipt.backendChanges) &&
    receipt.backendChanges.length > 0 &&
    receipt.backendChanges.every(
      (change) =>
        PROMPT_RUNTIME_FILES.has(change.path) &&
        /^[a-f0-9]{64}$/.test(change.previousSha256 ?? '') &&
        /^[a-f0-9]{64}$/.test(change.sha256 ?? ''),
    )
  );
}
export const CONTENT_RUNTIME_FILES = new Set([
  'worker/novel-documents.mjs',
  'worker/document-storage.mjs',
  'worker/novel-gateway.mjs',
]);
export const PURGE_RUNTIME_FILES = new Set([
  'worker/entry.mjs',
  'worker/novel-gateway.mjs',
  'worker/purge-plugin.mjs',
]);
export const PURGE_RUNTIME_ADDITIONS = new Set(['worker/purge-plugin.mjs']);
export function isPurgeRuntimeRelease(receipt) {
  return (
    receipt?.format === 'novel-local-runtime-release-v1' &&
    receipt.feature === 'dsh-purge-novel' &&
    receipt.backendUnchanged === false &&
    receipt.databaseChanged === false &&
    Array.isArray(receipt.backendChanges) &&
    receipt.backendChanges.length > 0 &&
    receipt.backendChanges.every(
      (c) =>
        PURGE_RUNTIME_FILES.has(c.path) &&
        (c.previousSha256 === null
          ? PURGE_RUNTIME_ADDITIONS.has(c.path)
          : /^[a-f0-9]{64}$/.test(c.previousSha256 ?? '')) &&
        /^[a-f0-9]{64}$/.test(c.sha256 ?? ''),
    )
  );
}
export function isContentRuntimeRelease(receipt) {
  return (
    receipt?.format === 'novel-local-runtime-release-v1' &&
    receipt.feature === 'manual-content' &&
    receipt.backendUnchanged === false &&
    receipt.databaseChanged === false &&
    Array.isArray(receipt.backendChanges) &&
    receipt.backendChanges.length > 0 &&
    receipt.backendChanges.every(
      (change) =>
        CONTENT_RUNTIME_FILES.has(change.path) &&
        /^[a-f0-9]{64}$/.test(change.previousSha256 ?? '') &&
        /^[a-f0-9]{64}$/.test(change.sha256 ?? ''),
    )
  );
}
export function isWritingRuntimeRelease(receipt) {
  return (
    receipt?.format === 'novel-local-runtime-release-v1' &&
    receipt.feature === 'unified-writing' &&
    receipt.backendUnchanged === false &&
    receipt.databaseChanged === false &&
    Array.isArray(receipt.backendChanges) &&
    receipt.backendChanges.length > 0 &&
    receipt.backendChanges.every(
      (change) =>
        WRITING_RUNTIME_FILES.has(change.path) &&
        /^[a-f0-9]{64}$/.test(change.previousSha256 ?? '') &&
        /^[a-f0-9]{64}$/.test(change.sha256 ?? ''),
    )
  );
}
