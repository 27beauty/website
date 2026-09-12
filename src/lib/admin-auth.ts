/**
 * Admin session handling: signed session cookie + KV-backed session record,
 * CSRF tokens, and login rate-limiting. No node modules — Web Crypto only,
 * same as src/lib/crypto.ts, so it runs unchanged on Workers.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AdminSession, AppBindings, Env } from '../types';
import { randomToken, secretsMatch, signPayload, verifyPayload, verifyPassword } from './crypto';

/** What we actually store in KV: the public AdminSession plus a CSRF secret. */
export interface AdminSessionRecord extends AdminSession {
  csrf: string;
}

const SESSION_COOKIE = 'admin_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const LOGIN_WINDOW_SECONDS = 60 * 15; // 15 minutes
const LOGIN_MAX_ATTEMPTS = 10;

/**
 * A valid-format PBKDF2 hash of a password nobody knows. Verifying against it
 * keeps a login attempt for a non-existent email taking the same time as one
 * for a real email with the wrong password, so timing can't reveal which.
 */
const DUMMY_HASH =
  'pbkdf2$150000$NmlhFgP_C9p82u8tlTj5Jw$GgA9v6msCUpOluMYjB3xfKP77Do-dkx80tu7KTU0lqM';

function sessionKey(token: string): string {
  return `admin:session:${token}`;
}

function loginFailKey(ip: string): string {
  return `admin:loginfail:${ip}`;
}

function isHttps(c: Context<AppBindings>): boolean {
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Best-effort client IP for rate-limiting (Cloudflare sets cf-connecting-ip). */
export function clientIp(c: Context<AppBindings>): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

export async function adminUserCount(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_users').first<{ n: number }>();
  return row?.n ?? 0;
}

/** Verifies a password, taking a constant path whether or not a hash exists. */
export async function verifyLoginPassword(password: string, storedHash: string | null | undefined): Promise<boolean> {
  if (!storedHash) {
    await verifyPassword(password, DUMMY_HASH);
    return false;
  }
  return verifyPassword(password, storedHash);
}

export interface LoginUser {
  id: number;
  email: string;
  name: string | null;
  role: string;
}

/** Creates a session in KV and sets the signed cookie on the response. */
export async function createSession(c: Context<AppBindings>, user: LoginUser): Promise<void> {
  const token = randomToken(24);
  const record: AdminSessionRecord = {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    issuedAt: Date.now(),
    csrf: randomToken(16),
  };
  await c.env.KV.put(sessionKey(token), JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  const signedToken = await signPayload(token, c.env.SESSION_SECRET);
  setCookie(c, SESSION_COOKIE, signedToken, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps(c),
    path: '/admin',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Loads the current session (if any) without requiring one to exist. */
export async function loadSession(c: Context<AppBindings>): Promise<AdminSessionRecord | null> {
  const cookieValue = getCookie(c, SESSION_COOKIE);
  if (!cookieValue) return null;
  const token = await verifyPayload<string>(cookieValue, c.env.SESSION_SECRET);
  if (!token) return null;
  const raw = await c.env.KV.get(sessionKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AdminSessionRecord;
  } catch {
    return null;
  }
}

/** Clears the KV session record and the cookie. Safe to call with no session. */
export async function destroySession(c: Context<AppBindings>): Promise<void> {
  const cookieValue = getCookie(c, SESSION_COOKIE);
  if (cookieValue) {
    const token = await verifyPayload<string>(cookieValue, c.env.SESSION_SECRET);
    if (token) await c.env.KV.delete(sessionKey(token));
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/admin' });
}

/**
 * Protects every admin route except the ones mounted before this middleware
 * in src/routes/admin/index.tsx (/login, /setup). Redirects anonymous
 * visitors to /login with a `next` back-link.
 */
export const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const session = await loadSession(c);
  if (!session) {
    const search = (() => {
      try {
        return new URL(c.req.url).search;
      } catch {
        return '';
      }
    })();
    const back = encodeURIComponent(c.req.path + search);
    return c.redirect(`/admin/login?next=${back}`, 302);
  }
  c.set('admin', session);
  await next();
};

/**
 * Typed accessor for the session set by requireAdmin. The Variables type in
 * src/types.ts only declares the public AdminSession shape; this casts back
 * to the fuller record (with the CSRF secret) that requireAdmin actually set.
 */
export function getAdmin(c: Context<AppBindings>): AdminSessionRecord {
  return c.get('admin') as AdminSessionRecord;
}

/** Constant-time check of a submitted `_csrf` field against the session's token. */
export function verifyCsrf(c: Context<AppBindings>, submitted: string | undefined | null): boolean {
  const session = getAdmin(c);
  return secretsMatch(session?.csrf, submitted ?? undefined);
}

interface LoginAttempts {
  count: number;
}

/** True once an IP has failed 10 logins inside the current 15-minute window. */
export async function isLoginRateLimited(env: Env, ip: string): Promise<boolean> {
  const raw = await env.KV.get(loginFailKey(ip));
  if (!raw) return false;
  try {
    return ((JSON.parse(raw) as LoginAttempts).count ?? 0) >= LOGIN_MAX_ATTEMPTS;
  } catch {
    return false;
  }
}

export async function recordLoginFailure(env: Env, ip: string): Promise<void> {
  const raw = await env.KV.get(loginFailKey(ip));
  let count = 1;
  if (raw) {
    try {
      count = ((JSON.parse(raw) as LoginAttempts).count ?? 0) + 1;
    } catch {
      count = 1;
    }
  }
  await env.KV.put(loginFailKey(ip), JSON.stringify({ count } satisfies LoginAttempts), {
    expirationTtl: LOGIN_WINDOW_SECONDS,
  });
}

export async function clearLoginFailures(env: Env, ip: string): Promise<void> {
  await env.KV.delete(loginFailKey(ip));
}

/** Shared rule for both /setup and the change-password form. */
export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters.';
  if (password !== confirm) return 'Those passwords do not match.';
  return null;
}

const ANON_TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * Self-contained, signed CSRF token for the /login and /setup forms, which
 * are submitted before any session exists. No KV round trip: the token
 * carries its own expiry and is verified against its HMAC signature alone.
 */
export async function createAnonFormToken(env: Env): Promise<string> {
  return signPayload({ n: randomToken(8), exp: Date.now() + ANON_TOKEN_TTL_MS }, env.SESSION_SECRET);
}

export async function verifyAnonFormToken(env: Env, token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const payload = await verifyPayload<{ n: string; exp: number }>(token, env.SESSION_SECRET);
  return Boolean(payload && payload.exp > Date.now());
}
