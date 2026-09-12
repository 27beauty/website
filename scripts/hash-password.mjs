#!/usr/bin/env node
/**
 * Hashes a password in the exact format src/lib/crypto.ts expects:
 *   pbkdf2$<iterations>$<saltB64url>$<hashB64url>
 * PBKDF2-SHA256, 150000 iterations, 16-byte salt, 256-bit key, base64url
 * (no padding). Uses the platform Web Crypto API only — no dependencies —
 * so the owner can run it with plain `node` to seed the first admin account
 * straight into D1 without needing the app running:
 *
 *   node scripts/hash-password.mjs owner@27beauty.co.uk 'a-strong-password'
 *
 * ...then paste the printed SQL into:
 *   wrangler d1 execute DB --remote --command "<the printed SQL>"
 */

const PBKDF2_ITERATIONS = 150_000;
const encoder = new TextEncoder();

function base64UrlEncode(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function deriveBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
}

/** Same algorithm and format as src/lib/crypto.ts's hashPassword(). */
export async function hashPasswordPbkdf2(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, iterations);
  return `pbkdf2$${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(bits)}`;
}

function escapeSqlString(value) {
  return value.replace(/'/g, "''");
}

async function main() {
  const [, , emailArg, passwordArg] = process.argv;

  let email = emailArg;
  let password = passwordArg;

  if (!email || !password) {
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    email = email || (await rl.question('Owner email: ')).trim();
    password = password || (await rl.question('Password (min 12 characters): '));
    rl.close();
  }

  if (!email || !email.includes('@')) {
    console.error('Enter a valid email address.');
    process.exitCode = 1;
    return;
  }
  if (!password || password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exitCode = 1;
    return;
  }

  const hash = await hashPasswordPbkdf2(password);

  console.log('\nPassword hash:');
  console.log(hash);
  console.log('\nSeed the first owner account with:\n');
  console.log(
    `wrangler d1 execute DB --remote --command "INSERT INTO admin_users (email, password_hash, name, role) VALUES ('${escapeSqlString(
      email,
    )}', '${hash}', NULL, 'owner');"`,
  );
  console.log('\n(Use --local instead of --remote to seed your local dev database.)');
}

// Only run the CLI when this file is executed directly — not when imported
// (e.g. by test/admin.test.ts, which checks hashPasswordPbkdf2 round-trips
// against src/lib/crypto.ts's verifyPassword).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
