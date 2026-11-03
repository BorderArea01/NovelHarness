import { z } from 'zod';
export {
  applyStatePatch,
  createStatePatch,
  normalizeStateDocument,
  PatchPreconditionError,
} from './state-patch.js';
export type { StatePatchPacket } from './state-patch.js';

export const PIN_PATTERN = /^\d{4}$/;
export const projectStatusSchema = z.enum(['active', 'archived', 'trashed']);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).default('无题'),
  genre: z.string().trim().max(100).default(''),
  inspiration: z.string().trim().min(1).max(20_000).optional(),
});

export const projectPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  genre: z.string().trim().max(100).optional(),
  expectedRevision: z.number().int().nonnegative(),
});

const stringList = z.array(z.string().trim().max(200)).max(100).default([]);
const optionalText = z.string().max(100_000).default('');
const customFields = z.record(z.string().trim().min(1).max(100), z.string().max(20_000)).default({});
const aiEvidence = z.string().max(2_000).default('');
const aiConfidence = z.enum(['high', 'medium']).optional();
export const storyEntityTypeSchema = z.enum(['character', 'location', 'item', 'organization']);

export const characterInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  aliases: stringList,
  role: z.string().trim().max(200).default(''),
  basicInfo: optionalText,
  appearance: optionalText,
  personality: optionalText,
  speechStyle: optionalText,
  background: optionalText,
  motivation: optionalText,
  goals: optionalText,
  secrets: optionalText,
  currentStatus: optionalText,
  tags: stringList,
  notes: optionalText,
  customFields,
  evidence: aiEvidence,
  confidence: aiConfidence,
  trust: z.enum(['manual', 'auto', 'confirmed']).default('manual'),
  expectedRevision: z.number().int().nonnegative(),
});

export const locationInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  aliases: stringList,
  type: z.string().trim().max(200).default(''),
  description: optionalText,
  geography: optionalText,
  culture: optionalText,
  rules: optionalText,
  currentStatus: optionalText,
  tags: stringList,
  notes: optionalText,
  customFields,
  evidence: aiEvidence,
  confidence: aiConfidence,
  trust: z.enum(['manual', 'auto', 'confirmed']).default('manual'),
  expectedRevision: z.number().int().nonnegative(),
});

export const itemInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  aliases: stringList,
  type: z.string().trim().max(200).default(''),
  description: optionalText,
  owner: optionalText,
  abilities: optionalText,
  origin: optionalText,
  currentStatus: optionalText,
  tags: stringList,
  notes: optionalText,
  customFields,
  evidence: aiEvidence,
  confidence: aiConfidence,
  trust: z.enum(['manual', 'auto', 'confirmed']).default('manual'),
  expectedRevision: z.number().int().nonnegative(),
});

export const organizationInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  aliases: stringList,
  type: z.string().trim().max(200).default(''),
  description: optionalText,
  purpose: optionalText,
  culture: optionalText,
  rules: optionalText,
  leaders: optionalText,
  headquarters: optionalText,
  currentStatus: optionalText,
  tags: stringList,
  notes: optionalText,
  customFields,
  evidence: aiEvidence,
  confidence: aiConfidence,
  trust: z.enum(['manual', 'auto', 'confirmed']).default('manual'),
  expectedRevision: z.number().int().nonnegative(),
});

export const relationInputSchema = z.object({
  sourceType: storyEntityTypeSchema,
  sourceId: z.string().uuid(),
  targetType: storyEntityTypeSchema,
  targetId: z.string().uuid(),
  label: z.string().trim().min(1).max(200),
  description: optionalText,
  tags: stringList,
  customFields,
  evidence: aiEvidence,
  confidence: aiConfidence,
  trust: z.enum(['manual', 'auto', 'confirmed']).default('manual'),
  expectedRevision: z.number().int().nonnegative(),
});

export const projectStatePutSchema = z.object({
  revision: z.number().int().nonnegative(),
  state: z.record(z.string(), z.unknown()),
});

const pointerSchema = z.string().max(4096);
const valueOperation = (op: 'add' | 'replace' | 'test') =>
  z.object({ op: z.literal(op), path: pointerSchema, value: z.json() });
const patchOperationSchema = z.discriminatedUnion('op', [
  valueOperation('add'),
  valueOperation('replace'),
  valueOperation('test'),
  z.object({ op: z.literal('remove'), path: pointerSchema }),
  z.object({ op: z.literal('move'), path: pointerSchema, from: pointerSchema }),
  z.object({ op: z.literal('copy'), path: pointerSchema, from: pointerSchema }),
]);
export const projectStatePatchSchema = z.object({
  revision: z.number().int().nonnegative(),
  patch: z.object({
    operations: z.array(patchOperationSchema).max(100_000),
    arrays: z.array(z.object({ path: pointerSchema, length: z.number().int().nonnegative() })).max(50_000),
    missing: z.array(pointerSchema).max(50_000),
  }),
});

export const storyBibleGenerateSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
});

export const conflictCopySchema = z.object({
  state: z.record(z.string(), z.unknown()),
});

export const settingsSchema = z.object({
  apiConfigs: z.array(z.record(z.string(), z.unknown())).default([]),
  activeConfigId: z.string().nullable().default(null),
  models: z.array(z.unknown()).default([]),
  modelRoutes: z.record(z.string(), z.unknown()).default({}),
  modelRouteThinking: z.record(z.string(), z.unknown()).default({}),
  modelRouteThinkingEffort: z.record(z.string(), z.unknown()).default({}),
  ui: z.record(z.string(), z.unknown()).default({}),
});

export const DB_SCHEMA_VERSION = 3;

export type CharacterInput = z.infer<typeof characterInputSchema>;
export type LocationInput = z.infer<typeof locationInputSchema>;
export type ItemInput = z.infer<typeof itemInputSchema>;
export type OrganizationInput = z.infer<typeof organizationInputSchema>;
export type RelationInput = z.infer<typeof relationInputSchema>;
