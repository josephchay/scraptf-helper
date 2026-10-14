// zod schemas for RPC params that more than one service module validates with
// (rpcHandlers.ts and priceSheetIo.ts's rule import), so both accept exactly
// the same rules.

import { z } from 'zod';
import { CATEGORIES, type Category } from '../shared/types';

export const finite = z.number().refine(Number.isFinite, 'must be a finite number');
export const nonNeg = finite.refine((n) => n >= 0, 'must be zero or more');
export const id = z.number().int().positive();
export const categoryEnum = z.enum(CATEGORIES as unknown as [Category, ...Category[]]);

export const ruleFilterSchema = z.object({
  categories: z.array(categoryEnum).max(20).optional(),
  qualities: z.array(z.number().int()).max(30).optional(),
  craftable: z.boolean().nullable().optional(),
  australium: z.boolean().nullable().optional(),
  killstreak: z.array(z.number().int().min(0).max(3)).max(4).optional(),
  hasEffect: z.boolean().nullable().optional(),
  defindexes: z.array(z.number().int().min(0)).max(500).optional(),
  nameContains: z.string().max(200).nullable().optional(),
});

/** 'rules.upsert' params; also every rule in a 'rules.importJson' backup. */
export const ruleInputSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1, 'a rule needs a name').max(120),
  filter: ruleFilterSchema,
  costKeys: nonNeg.optional(),
  costScrap: nonNeg,
  observedAt: finite.optional(),
  enabled: z.boolean().optional(),
});
