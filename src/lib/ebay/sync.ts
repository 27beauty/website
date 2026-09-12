import type { Env } from '../../types';

export interface SyncResult {
  created: number;
  updated: number;
  ended: number;
  errors: string[];
  runId?: number;
}

/** Pulls listings from every active eBay account into the catalogue. */
export async function runEbaySync(_env: Env, _trigger: 'cron' | 'manual' | 'api'): Promise<SyncResult> {
  return { created: 0, updated: 0, ended: 0, errors: ['eBay sync not configured'] };
}
