/**
 * Matches marketplace listings to website products by title (and SKU when
 * one lines up). Pure functions only — src/lib/channels.ts does the I/O.
 *
 * The rule that matters most: numbers are identity. "Pukka Tea 20 bags" and
 * "Pukka Tea 4 x 20 bags", or a 24-pack and a 96-pack, are different stock,
 * however similar the words. Any disagreement in pack size, weight or volume
 * caps the score below the auto-link threshold so a person decides.
 */

export const AUTO_LINK_SCORE = 0.85;
export const AUTO_LINK_MARGIN = 0.1;
/** Below this a product isn't worth suggesting at all. */
export const SUGGEST_SCORE = 0.35;
const NUMBER_CONFLICT_CAP = 0.6;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'for', 'with', 'in', 'on', 'to', 'by', 'new', 'uk', 'genuine', 'brand',
  'total', 'x', 'pack', 'pk', 'packs', 'pcs', 'pieces', 'piece', 'size', 'bbe', 'best', 'before',
]);

const UNIT_ALIASES: [RegExp, string][] = [
  [/\b(\d+(?:\.\d+)?)\s*(?:millilitres?|milliliters?|ml)\b/g, '$1ml'],
  [/\b(\d+(?:\.\d+)?)\s*(?:litres?|liters?|ltrs?|l)\b/g, '$1l'],
  [/\b(\d+(?:\.\d+)?)\s*(?:kilograms?|kilos?|kgs?)\b/g, '$1kg'],
  [/\b(\d+(?:\.\d+)?)\s*(?:grams?|grammes?|gr|g)\b/g, '$1g'],
  [/\b(\d+(?:\.\d+)?)\s*(?:centimetres?|cm)\b/g, '$1cm'],
  [/\b(\d+(?:\.\d+)?)\s*(?:metres?|meters?|m)\b/g, '$1m'],
  [/\b(\d+(?:\.\d+)?)\s*(?:pk|packs?|pcs|pieces|count|ct)\b/g, '$1'],
  [/\b(\d+)\s*x\s*(\d+)/g, '$1 $2'],
];

/** Lower-case, unify units ("50 Litre" → "50l"), drop punctuation and filler words. */
export function normaliseTitle(title: string): string[] {
  let t = title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/&/g, ' and ').replace(/[|,;:()[\]{}"'’!?/\\+*#]/g, ' ').replace(/-/g, ' ');
  for (const [re, to] of UNIT_ALIASES) t = t.replace(re, to);
  // Litres expressed in ml are the same size: 1000ml → 1l.
  t = t.replace(/\b(\d+)ml\b/g, (m, n: string) => (Number(n) % 1000 === 0 && Number(n) > 0 ? `${Number(n) / 1000}l` : m));
  t = t.replace(/\b(\d+)g\b/g, (m, n: string) => (Number(n) % 1000 === 0 && Number(n) > 0 ? `${Number(n) / 1000}kg` : m));
  return t
    .split(/\s+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w && !STOP_WORDS.has(w));
}

/** Tokens that carry a quantity: "20", "50l", "200g", "1.2kg". */
export function numberTokens(tokens: string[]): Set<string> {
  return new Set(tokens.filter((t) => /^\d/.test(t)));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

interface Prepared {
  words: Set<string>;
  numbers: Set<string>;
}

/**
 * Normalising a title is the expensive part (a dozen regexes), and the same
 * titles are compared many times in one run — so each is prepared once.
 * Workers Free allows ~10ms CPU per invocation; this keeps matching inside it.
 */
const prepared = new Map<string, Prepared>();

function prepare(title: string): Prepared {
  let p = prepared.get(title);
  if (!p) {
    const tokens = normaliseTitle(title);
    p = { words: new Set(tokens), numbers: numberTokens(tokens) };
    if (prepared.size > 5000) prepared.clear();
    prepared.set(title, p);
  }
  return p;
}

function similarityOf(a: Prepared, b: Prepared): number {
  if (!a.words.size || !b.words.size) return 0;
  let common = 0;
  for (const w of a.words) if (b.words.has(w)) common++;
  const dice = (2 * common) / (a.words.size + b.words.size);
  const conflict = (a.numbers.size > 0 || b.numbers.size > 0) && !sameSet(a.numbers, b.numbers);
  return Math.round((conflict ? Math.min(dice, NUMBER_CONFLICT_CAP) : dice) * 1000) / 1000;
}

/**
 * 0–1 similarity. Dice coefficient over the word sets, capped when the two
 * titles state different quantities.
 */
export function titleSimilarity(a: string, b: string): number {
  return similarityOf(prepare(a), prepare(b));
}

export interface MatchCandidate {
  id: number;
  title: string;
  sku?: string | null;
}

export interface MatchResult {
  /** Set only when the match is confident enough to link without asking. */
  autoLinkId: number | null;
  best: { id: number; score: number } | null;
  /** Up to three suggestions for the review screen, best first. */
  suggestions: { id: number; score: number }[];
}

function normSku(s: string | null | undefined): string {
  return (s ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Candidates indexed by word, so a listing is only scored against products
 * that share at least one (non-number) word with it.
 */
export class MatchIndex {
  readonly byWord = new Map<string, MatchCandidate[]>();
  readonly bySku = new Map<string, MatchCandidate[]>();
  constructor(readonly candidates: MatchCandidate[]) {
    for (const c of candidates) {
      for (const w of prepare(c.title).words) {
        if (/^\d/.test(w)) continue;
        const list = this.byWord.get(w) ?? [];
        list.push(c);
        this.byWord.set(w, list);
      }
      const sku = normSku(c.sku);
      if (sku.length >= 3) this.bySku.set(sku, [...(this.bySku.get(sku) ?? []), c]);
    }
  }

  near(title: string): MatchCandidate[] {
    const seen = new Set<MatchCandidate>();
    for (const w of prepare(title).words) for (const c of this.byWord.get(w) ?? []) seen.add(c);
    return [...seen];
  }
}

/**
 * Picks the product a listing belongs to. Exact SKU wins outright (if it
 * points at exactly one product); otherwise the best title, auto-linked only
 * when it is both strong and clearly ahead of the runner-up.
 */
export function matchListing(
  listing: { title: string; sku?: string | null },
  candidatesOrIndex: MatchCandidate[] | MatchIndex,
): MatchResult {
  const index = candidatesOrIndex instanceof MatchIndex ? candidatesOrIndex : new MatchIndex(candidatesOrIndex);
  const sku = normSku(listing.sku);
  if (sku.length >= 3) {
    const bySku = index.bySku.get(sku) ?? [];
    if (bySku.length === 1) {
      return { autoLinkId: bySku[0].id, best: { id: bySku[0].id, score: 1 }, suggestions: [{ id: bySku[0].id, score: 1 }] };
    }
  }
  const mine = prepare(listing.title);
  const scored = index
    .near(listing.title)
    .map((c) => ({ id: c.id, score: similarityOf(mine, prepare(c.title)) }))
    .filter((s) => s.score >= SUGGEST_SCORE)
    .sort((x, y) => y.score - x.score || x.id - y.id);
  const best = scored[0] ?? null;
  const runnerUp = scored[1]?.score ?? 0;
  const confident = best !== null && best.score >= AUTO_LINK_SCORE && best.score - runnerUp >= AUTO_LINK_MARGIN;
  return { autoLinkId: confident ? best.id : null, best, suggestions: scored.slice(0, 3) };
}

/**
 * Groups products that are the same item listed more than once (either eBay
 * shop). Only identical normalised titles are grouped automatically; the
 * lowest id in each group is the one kept.
 */
export function exactDuplicateGroups(products: MatchCandidate[]): number[][] {
  const byKey = new Map<string, number[]>();
  for (const p of products) {
    const key = normaliseTitle(p.title).join(' ');
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(p.id);
    byKey.set(key, list);
  }
  return [...byKey.values()].filter((ids) => ids.length > 1).map((ids) => ids.sort((a, b) => a - b));
}
