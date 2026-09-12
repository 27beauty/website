/**
 * Category mapping for incoming eBay listings. Kept as pure functions over
 * plain data (no D1 access) so the matching logic is unit-testable; the sync
 * engine loads the rules once per run and calls mapCategory() per listing.
 */

import type { Env } from '../../types';
import type { CategoryRule } from './types';

/** Loads `ebay_category_map` rows in the shape mapCategory() expects. */
export async function loadCategoryRules(env: Env): Promise<CategoryRule[]> {
  const { results } = await env.DB.prepare(
    'SELECT match_type, match_value, category_id, priority FROM ebay_category_map ORDER BY priority DESC, id ASC',
  ).all<{ match_type: string; match_value: string; category_id: number; priority: number }>();
  return (results ?? []).map((r) => ({
    matchType: r.match_type === 'ebay_category' ? 'ebay_category' : 'keyword',
    matchValue: r.match_value,
    categoryId: r.category_id,
    priority: r.priority,
  }));
}

/**
 * Picks a category_id for a listing given the configured rules.
 *
 * - Rules are tried highest `priority` first (ties keep table order, which
 *   loadCategoryRules() already sorts by id as a stable tiebreak).
 * - `keyword` rules match case-insensitively against the listing title, on a
 *   word-ish boundary: "cat" matches "Cat Food 2kg" but not "category" or
 *   "concatenate", by requiring the match not be flanked by another letter or
 *   digit. Multi-word phrases ("board game") match as a substring with the
 *   same boundary check applied to the whole phrase.
 * - `ebay_category` rules match the listing's own eBay category id or name
 *   (exact, case-insensitive).
 * - Falls back to the account's `default_category_id`, then null.
 */
export function mapCategory(
  listing: { title: string; ebayCategoryId?: string | null; ebayCategoryName?: string | null },
  rules: CategoryRule[],
  defaultCategoryId: number | null,
): number | null {
  const title = listing.title ?? '';
  // Sort defensively rather than trusting caller order — loadCategoryRules()
  // already sorts by priority, but mapCategory is a pure function tested and
  // reused on its own, so it must not depend on that. Array#sort is stable,
  // so equal-priority rules keep their relative (table) order.
  const ordered = [...rules].sort((a, b) => b.priority - a.priority);
  for (const rule of ordered) {
    if (rule.matchType === 'keyword') {
      if (matchesKeyword(title, rule.matchValue)) return rule.categoryId;
    } else {
      const value = rule.matchValue.toLowerCase();
      if (
        (listing.ebayCategoryId && listing.ebayCategoryId.toLowerCase() === value) ||
        (listing.ebayCategoryName && listing.ebayCategoryName.toLowerCase() === value)
      ) {
        return rule.categoryId;
      }
    }
  }
  return defaultCategoryId ?? null;
}

const WORD_CHAR = /[a-z0-9]/;

/** Case-insensitive, word-ish-boundary substring match (see mapCategory doc). */
export function matchesKeyword(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase();
  const n = needle.trim().toLowerCase();
  if (!n) return false;
  let from = 0;
  for (;;) {
    const idx = h.indexOf(n, from);
    if (idx === -1) return false;
    const before = idx > 0 ? h[idx - 1] : '';
    const after = idx + n.length < h.length ? h[idx + n.length] : '';
    const boundaryBefore = !before || !WORD_CHAR.test(before);
    const boundaryAfter = !after || !WORD_CHAR.test(after);
    if (boundaryBefore && boundaryAfter) return true;
    from = idx + 1;
  }
}
