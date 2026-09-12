import { Hono } from 'hono';
import type { AppBindings } from '../../types';
import { isEmail } from '../../lib/util';
import { secretsMatch } from '../../lib/crypto';
import {
  adminUserCount,
  clearLoginFailures,
  clientIp,
  createAnonFormToken,
  createSession,
  destroySession,
  isLoginRateLimited,
  loadSession,
  recordLoginFailure,
  validateNewPassword,
  verifyAnonFormToken,
  verifyLoginPassword,
} from '../../lib/admin-auth';
import { hashPassword } from '../../lib/crypto';

/**
 * Auth routes, mounted BEFORE requireAdmin in index.tsx so they work with no
 * session: /login, /setup (first-run only), /logout.
 */
export const auth = new Hono<AppBindings>();

function AuthPage(props: { title: string; children: unknown }) {
  return (
    <html lang="en-GB">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · 27beauty admin</title>
        <meta name="robots" content="noindex,nofollow" />
        <link rel="stylesheet" href="/assets/styles.css" />
        <link rel="stylesheet" href="/assets/admin.css" />
      </head>
      <body class="admin-page admin-auth-page">
        <div class="admin-auth-card">
          <span class="admin-auth-wordmark">
            27<span style="color:var(--accent)">beauty</span>
          </span>
          {props.children}
        </div>
      </body>
    </html>
  );
}

function safeNext(next: string | undefined): string {
  if (next && next.startsWith('/admin') && !next.startsWith('//')) return next;
  return '/admin';
}

auth.get('/login', async (c) => {
  const session = await loadSession(c);
  if (session) return c.redirect(safeNext(c.req.query('next')), 302);

  const err = c.req.query('err');
  const msg = c.req.query('msg');
  const next = c.req.query('next') ?? '';
  const token = await createAnonFormToken(c.env);

  return c.html(
    <AuthPage title="Log in">
      <h1>Log in</h1>
      <p class="admin-auth-sub">Sign in to manage 27beauty.</p>
      {err ? <div class="notice notice-bad admin-flash">{err}</div> : null}
      {msg ? <div class="notice notice-ok admin-flash">{msg}</div> : null}
      <form method="post" action="/admin/login" class="stack">
        <input type="hidden" name="_csrf" value={token} />
        <input type="hidden" name="next" value={next} />
        <div class="field">
          <label for="email">Email</label>
          <input id="email" type="email" name="email" required autofocus autocomplete="username" />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" type="password" name="password" required autocomplete="current-password" />
        </div>
        <button class="btn btn-block" type="submit">
          Log in
        </button>
      </form>
    </AuthPage>,
  );
});

auth.post('/login', async (c) => {
  const ip = clientIp(c);
  const body = await c.req.parseBody();
  const next = safeNext(typeof body.next === 'string' ? body.next : undefined);
  const csrfOk = await verifyAnonFormToken(c.env, typeof body._csrf === 'string' ? body._csrf : undefined);
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const fail = (message: string) =>
    c.redirect(`/admin/login?err=${encodeURIComponent(message)}&next=${encodeURIComponent(next)}`, 303);

  if (!csrfOk) return fail('Your session expired — please try again.');
  if (await isLoginRateLimited(c.env, ip, email)) {
    return fail('Too many attempts. Please wait 15 minutes and try again.');
  }
  if (!email || !password) return fail('Enter your email and password.');

  const user = await c.env.DB.prepare(
    'SELECT id, email, name, role, password_hash FROM admin_users WHERE lower(email) = lower(?)',
  )
    .bind(email)
    .first<{ id: number; email: string; name: string | null; role: string; password_hash: string }>();

  const ok = await verifyLoginPassword(password, user?.password_hash);
  if (!ok || !user) {
    await recordLoginFailure(c.env, ip, email);
    return fail('Invalid email or password.');
  }

  await clearLoginFailures(c.env, ip, email);
  await c.env.DB.prepare("UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?")
    .bind(user.id)
    .run();
  await createSession(c, user);
  return c.redirect(next, 303);
});

auth.post('/logout', async (c) => {
  const session = await loadSession(c);
  const body = await c.req.parseBody();
  if (session && !secretsMatch(session.csrf, typeof body._csrf === 'string' ? body._csrf : '')) {
    return c.redirect('/admin', 303);
  }
  await destroySession(c);
  return c.redirect(`/admin/login?msg=${encodeURIComponent('Logged out.')}`, 303);
});

/**
 * First-run setup: the only way the owner gets an account without a D1
 * console. Works only while admin_users is empty; 404s otherwise so it can
 * never be used to create a second, unauthenticated owner account.
 */
auth.get('/setup', async (c) => {
  if ((await adminUserCount(c.env)) > 0) return c.text('Not found', 404);
  const err = c.req.query('err');
  const token = await createAnonFormToken(c.env);
  return c.html(
    <AuthPage title="Set up your account">
      <h1>Welcome to 27beauty</h1>
      <p class="admin-auth-sub">Create the first owner account to finish setup.</p>
      {err ? <div class="notice notice-bad admin-flash">{err}</div> : null}
      <form method="post" action="/admin/setup" class="stack">
        <input type="hidden" name="_csrf" value={token} />
        <div class="field">
          <label for="email">Email</label>
          <input id="email" type="email" name="email" required autofocus autocomplete="username" />
        </div>
        <div class="field">
          <label for="name">Your name (optional)</label>
          <input id="name" type="text" name="name" autocomplete="name" />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" type="password" name="password" required minlength={12} autocomplete="new-password" />
          <p class="field-hint">At least 12 characters.</p>
        </div>
        <div class="field">
          <label for="confirm">Confirm password</label>
          <input id="confirm" type="password" name="confirm" required minlength={12} autocomplete="new-password" />
        </div>
        <button class="btn btn-block" type="submit">
          Create account
        </button>
      </form>
    </AuthPage>,
  );
});

auth.post('/setup', async (c) => {
  if ((await adminUserCount(c.env)) > 0) return c.text('Not found', 404);
  const body = await c.req.parseBody();
  const csrfOk = await verifyAnonFormToken(c.env, typeof body._csrf === 'string' ? body._csrf : undefined);
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const confirm = typeof body.confirm === 'string' ? body.confirm : '';

  const fail = (message: string) => c.redirect(`/admin/setup?err=${encodeURIComponent(message)}`, 303);

  if (!csrfOk) return fail('Your session expired — please try again.');
  if (!isEmail(email)) return fail('Enter a valid email address.');
  const passwordError = validateNewPassword(password, confirm);
  if (passwordError) return fail(passwordError);

  // Re-check right before writing to close the race between two concurrent setups.
  if ((await adminUserCount(c.env)) > 0) return c.text('Not found', 404);

  const passwordHash = await hashPassword(password);
  const result = await c.env.DB.prepare(
    "INSERT INTO admin_users (email, password_hash, name, role, last_login_at) VALUES (?, ?, ?, 'owner', datetime('now'))",
  )
    .bind(email, passwordHash, name || null)
    .run();
  const userId = result.meta.last_row_id as number;

  await createSession(c, { id: userId, email, name: name || null, role: 'owner' });
  return c.redirect(`/admin?msg=${encodeURIComponent('Your admin account is ready.')}`, 303);
});
