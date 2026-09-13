#!/usr/bin/env node
/**
 * One-shot Cloudflare setup for 27beauty.
 *
 * Creates the D1 database, KV namespace and R2 bucket if they don't exist yet,
 * then writes their ids into wrangler.toml so `wrangler deploy` can bind them.
 * Safe to run repeatedly: existing resources are reused, never recreated.
 *
 * Needs CLOUDFLARE_API_TOKEN (and usually CLOUDFLARE_ACCOUNT_ID) in the
 * environment, or a `wrangler login` session on your own machine.
 *
 *   node scripts/bootstrap-cloudflare.mjs            # create + write ids
 *   node scripts/bootstrap-cloudflare.mjs --dry-run  # show what it would do
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const DRY_RUN = process.argv.includes('--dry-run');
const D1_NAME = '27beauty';
const KV_BINDING = 'KV';
const R2_BUCKET = '27beauty-media';
const WRANGLER_TOML = 'wrangler.toml';

function wrangler(args, { allowFailure = false } = {}) {
  if (DRY_RUN && !args.includes('list')) {
    console.log(`   [dry-run] wrangler ${args.join(' ')}`);
    return '';
  }
  try {
    return execFileSync('npx', ['wrangler', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (allowFailure) return output;
    console.error(`\n✘ wrangler ${args.join(' ')} failed:\n${output}`);
    process.exit(1);
  }
}

/** wrangler prints human text around its JSON; pull out the first array/object. */
function parseJson(output) {
  const start = output.search(/[[{]/);
  if (start === -1) return null;
  try {
    return JSON.parse(output.slice(start));
  } catch {
    return null;
  }
}

function findD1() {
  const list = parseJson(wrangler(['d1', 'list', '--json'])) ?? [];
  return list.find((db) => db.name === D1_NAME) ?? null;
}

function findKv() {
  const list = parseJson(wrangler(['kv', 'namespace', 'list'])) ?? [];
  // wrangler titles a namespace "<worker-name>-<binding>", e.g. 27beauty-KV.
  return list.find((ns) => ns.title?.endsWith(`-${KV_BINDING}`) || ns.title === KV_BINDING) ?? null;
}

console.log('27beauty — Cloudflare bootstrap\n');

// ---- D1 -------------------------------------------------------------------
let d1 = findD1();
if (d1) {
  console.log(`✓ D1 "${D1_NAME}" already exists (${d1.uuid})`);
} else {
  console.log(`• creating D1 database "${D1_NAME}"…`);
  wrangler(['d1', 'create', D1_NAME]);
  d1 = findD1();
  if (!d1 && !DRY_RUN) {
    console.error('✘ created the D1 database but could not read its id back');
    process.exit(1);
  }
  if (d1) console.log(`✓ D1 created (${d1.uuid})`);
}

// ---- KV -------------------------------------------------------------------
let kv = findKv();
if (kv) {
  console.log(`✓ KV namespace "${kv.title}" already exists (${kv.id})`);
} else {
  console.log(`• creating KV namespace "${KV_BINDING}"…`);
  wrangler(['kv', 'namespace', 'create', KV_BINDING]);
  kv = findKv();
  if (!kv && !DRY_RUN) {
    console.error('✘ created the KV namespace but could not read its id back');
    process.exit(1);
  }
  if (kv) console.log(`✓ KV created (${kv.id})`);
}

// ---- R2 -------------------------------------------------------------------
// R2 has no stable JSON listing across wrangler versions, so just try to create
// it and treat "already exists" as success.
console.log(`• ensuring R2 bucket "${R2_BUCKET}"…`);
const r2Out = wrangler(['r2', 'bucket', 'create', R2_BUCKET], { allowFailure: true });
if (/already exists|10004|already owned/i.test(r2Out)) {
  console.log(`✓ R2 bucket "${R2_BUCKET}" already exists`);
} else if (/error|✘/i.test(r2Out) && !DRY_RUN) {
  console.error(`✘ could not create the R2 bucket:\n${r2Out}`);
  console.error('  R2 must be enabled once in the Cloudflare dashboard before it can be used.');
  process.exit(1);
} else {
  console.log(`✓ R2 bucket ready`);
}

// ---- wrangler.toml --------------------------------------------------------
if (DRY_RUN) {
  console.log('\n[dry-run] wrangler.toml left untouched.');
  process.exit(0);
}

let toml = readFileSync(WRANGLER_TOML, 'utf8');
const before = toml;

if (d1?.uuid) {
  toml = toml.replace(/database_id = "[^"]*"/, `database_id = "${d1.uuid}"`);
}
if (kv?.id) {
  // Only the kv_namespaces id line, which is the one bare `id = "..."`.
  toml = toml.replace(/(\[\[kv_namespaces\]\][\s\S]*?)id = "[^"]*"/, `$1id = "${kv.id}"`);
}

if (toml !== before) {
  writeFileSync(WRANGLER_TOML, toml);
  console.log('\n✓ wrangler.toml updated with the resource ids');
} else {
  console.log('\n✓ wrangler.toml already had the right ids');
}

console.log('\nNext: wrangler d1 migrations apply DB --remote, then wrangler deploy.');
