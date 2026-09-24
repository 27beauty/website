/**
 * The project type-checks against Cloudflare's Workers types, not Node's
 * (they clash). The test-only SQLite helper (d1.ts) runs under Node, so it
 * declares just the few Node APIs it touches.
 */
declare module 'node:module' {
  export function createRequire(url: string): (id: string) => unknown;
}
declare module 'node:fs' {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
}
declare module 'node:sqlite' {
  export class StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
interface ImportMeta {
  url: string;
}
declare const __dirname: string;
