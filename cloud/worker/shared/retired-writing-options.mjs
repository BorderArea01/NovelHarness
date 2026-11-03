// Retired product features, not model instructions. Keep original bytes in
// migration backups/import archives, never automatically reactivate them.
export const RETIRED_WRITING_OPTIONS = Object.freeze([
  'creativeRules',
  'methodologyCards',
  'activeMethodologyCardId',
  'referenceText',
]);
export function withoutRetiredWritingOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('创作配置不是对象，原值未改动。');
  const next = structuredClone(value);
  for (const key of RETIRED_WRITING_OPTIONS) delete next[key];
  return next;
}
