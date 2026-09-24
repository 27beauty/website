/**
 * A real SQLite database (Node's built-in node:sqlite) behind the slice of
 * the D1 API the app uses, with every migration applied — so tests exercise
 * the actual SQL (window functions, changes(), UNIQUE guards) rather than a
 * hand-written fake. Test-only; never bundled into the Worker.
 */

import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Loaded at runtime so the bundler doesn't try to resolve the (newer) builtin.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

type Row = Record<string, unknown>;

function toSqlite(v: unknown): null | number | bigint | string | Uint8Array {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' || v instanceof Uint8Array) return v;
  return String(v);
}

const READS = /^\s*(select|with|pragma)\b/i;

export function createTestD1(): { db: D1Database; exec: (sql: string) => void; all: (sql: string, ...args: unknown[]) => Row[] } {
  const sqlite = new DatabaseSync(':memory:');
  const dir = join(__dirname, '..', '..', 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(dir, file), 'utf8'));
  }

  const makeStatement = (sql: string, args: unknown[] = []) => {
    const exec = () => {
      const st = sqlite.prepare(sql);
      const params = args.map(toSqlite);
      if (READS.test(sql)) {
        const rows = st.all(...params) as Row[];
        return { results: rows, success: true, meta: { changes: 0, last_row_id: 0 } };
      }
      const r = st.run(...params);
      return { results: [] as Row[], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    };
    const stmt = {
      __exec: exec,
      bind: (...a: unknown[]) => makeStatement(sql, a),
      first: async <T,>(col?: string) => {
        const rows = exec().results;
        const row = rows[0] ?? null;
        return (col && row ? (row[col] as T) : (row as T)) ?? null;
      },
      all: async <T,>() => ({ ...exec(), results: exec().results as T[] }),
      run: async () => exec(),
      raw: async () => exec().results.map((r) => Object.values(r)),
    };
    return stmt;
  };

  const db = {
    prepare: (sql: string) => makeStatement(sql),
    // D1 runs a batch as one transaction, statement by statement on one connection.
    batch: async (stmts: Array<{ __exec: () => unknown }>) => {
      sqlite.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.__exec());
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;

  return {
    db,
    exec: (sql) => sqlite.exec(sql),
    all: (sql, ...args) => sqlite.prepare(sql).all(...args.map(toSqlite)) as Row[],
  };
}

/** In-memory stand-in for a KV namespace (get/put/delete only). */
export function createTestKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  } as unknown as KVNamespace;
}
