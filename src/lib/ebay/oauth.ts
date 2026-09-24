/**
 * eBay OAuth: the application (client-credentials) grant used by Browse mode,
 * and the user (refresh-token) grant used by Sell mode. Access tokens are
 * cached in KV so a sync run (and the many API calls within it) reuse one
 * token instead of minting a new one per request. Tokens are never logged.
 */

import type { Env, EbayAccount } from '../../types';
import type { EbayTokenResponse } from './types';
import { fetchWithRetry } from './http';
import { decryptSecret, encryptSecret } from '../crypto';

/**
 * What the seller consents to when connecting a shop: read/write listings
 * (Trading API accepts the base scope), inventory, and reading orders so
 * eBay sales can come off the central stock count.
 */
export const SELLER_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
];
const CONSENT_URL = 'https://auth.ebay.com/oauth2/authorize';

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
  const refreshToken = await refreshTokenFor(env, account);
  if (!refreshToken) return null;

  const key = kvKey('sell', account.id);
  const cached = await env.KV.get(key);
  if (cached) return cached;

  const token = await requestToken(
    env,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      // A shop connected through the admin consented to SELLER_SCOPES; an
      // older env-var token was only ever issued for sell.inventory.
      scope: account.refresh_token_enc ? SELLER_SCOPES.join(' ') : 'https://api.ebay.com/oauth/api_scope/sell.inventory',
    }),
  );
  await cacheToken(env, key, token);
  return token.access_token;
}

/** The seller's refresh token: from the admin "Connect" flow first, else a named Worker secret. */
async function refreshTokenFor(env: Env, account: EbayAccount): Promise<string | null> {
  if (account.refresh_token_enc) {
    return decryptSecret(account.refresh_token_enc, env.SESSION_SECRET);
  }
  if (!account.refresh_token_var) return null;
  return readSecret(env, account.refresh_token_var) ?? null;
}

export function sellerConnected(account: EbayAccount): boolean {
  return Boolean(account.refresh_token_enc || account.refresh_token_var);
}

/** Where to send the owner to grant access. `prompt=login` makes eBay ask which shop to sign in as. */
export function consentUrl(env: Env, state: string): string {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_RUNAME) throw new Error('EBAY_CLIENT_ID / EBAY_RUNAME are not configured');
  const params = new URLSearchParams({
    client_id: env.EBAY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: env.EBAY_RUNAME,
    scope: SELLER_SCOPES.join(' '),
    state,
    prompt: 'login',
  });
  return `${CONSENT_URL}?${params.toString()}`;
}

/** Swaps the one-time consent code for a refresh token, encrypted ready to store. */
export async function exchangeConsentCode(env: Env, code: string): Promise<{ encryptedRefreshToken: string; accessToken: string }> {
  if (!env.EBAY_RUNAME) throw new Error('EBAY_RUNAME is not configured');
  const token = (await requestToken(
    env,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: env.EBAY_RUNAME }),
  )) as EbayTokenResponse & { refresh_token?: string };
  if (!token.refresh_token) throw new Error('eBay did not return a refresh token');
  return {
    encryptedRefreshToken: await encryptSecret(token.refresh_token, env.SESSION_SECRET),
    accessToken: token.access_token,
  };
}

/** Drops a cached user token, e.g. after reconnecting a shop. */
export async function forgetUserToken(env: Env, account: EbayAccount): Promise<void> {
  await env.KV.delete(kvKey('sell', account.id));
}

/** Reads a named Worker secret off `env` (e.g. "EBAY_REFRESH_TOKEN_2"). */
function readSecret(env: Env, varName: string): string | undefined {
  const bag = env as unknown as Record<string, string | undefined>;
  return bag[varName];
}
