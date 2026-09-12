/**
 * eBay OAuth: the application (client-credentials) grant used by Browse mode,
 * and the user (refresh-token) grant used by Sell mode. Access tokens are
 * cached in KV so a sync run (and the many API calls within it) reuse one
 * token instead of minting a new one per request. Tokens are never logged.
 */

import type { Env, EbayAccount } from '../../types';
import type { EbayTokenResponse } from './types';
import { fetchWithRetry } from './http';

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SAFETY_MARGIN_SECONDS = 60;
const MIN_TTL_SECONDS = 60;

function kvKey(mode: 'browse' | 'sell', accountId: number): string {
  return `ebay:token:${mode}:${accountId}`;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function requestToken(env: Env, body: URLSearchParams): Promise<EbayTokenResponse> {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    throw new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET are not configured');
  }
  const res = await fetchWithRetry(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(env.EBAY_CLIENT_ID, env.EBAY_CLIENT_SECRET),
    },
    body: body.toString(),
  });
  if (!res.ok) {
    // Do not include the response body: on a bad grant eBay can echo back
    // request parameters, and we would rather under-report than ever log a
    // secret by accident.
    throw new Error(`eBay OAuth token request failed: HTTP ${res.status}`);
  }
  return (await res.json()) as EbayTokenResponse;
}

async function cacheToken(env: Env, key: string, token: EbayTokenResponse): Promise<void> {
  const ttl = Math.max(MIN_TTL_SECONDS, (token.expires_in || 7200) - SAFETY_MARGIN_SECONDS);
  await env.KV.put(key, token.access_token, { expirationTtl: ttl });
}

/**
 * Application access token for Browse-mode calls (client credentials grant).
 * Shared across accounts by id, since each account may have its own seller
 * username but the same app credentials are used to look them up.
 */
export async function getAppAccessToken(env: Env, account: EbayAccount): Promise<string> {
  const key = kvKey('browse', account.id);
  const cached = await env.KV.get(key);
  if (cached) return cached;

  const token = await requestToken(
    env,
    new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }),
  );
  await cacheToken(env, key, token);
  return token.access_token;
}

/**
 * User access token for Sell-mode calls (refresh token grant). Returns null
 * when the account has no refresh token configured, so callers can fall back
 * to browse mode cleanly rather than throwing.
 */
export async function getUserAccessToken(env: Env, account: EbayAccount): Promise<string | null> {
  if (!account.refresh_token_var) return null;
  const refreshToken = readSecret(env, account.refresh_token_var);
  if (!refreshToken) return null;

  const key = kvKey('sell', account.id);
  const cached = await env.KV.get(key);
  if (cached) return cached;

  const token = await requestToken(
    env,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'https://api.ebay.com/oauth/api_scope/sell.inventory',
    }),
  );
  await cacheToken(env, key, token);
  return token.access_token;
}

/** Reads a named Worker secret off `env` (e.g. "EBAY_REFRESH_TOKEN_2"). */
function readSecret(env: Env, varName: string): string | undefined {
  const bag = env as unknown as Record<string, string | undefined>;
  return bag[varName];
}
