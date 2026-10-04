// Minimal ambient types for Bun's built-in SQLite module, used by scripts/leads/crm.ts and
// scripts/leads/engine.ts (reused by src/../scripts/leads/api.ts, now reachable from vite.config.ts's
// tsc graph). There's no @types/bun package installed; this covers only the surface those
// files actually use, so `tsc --noEmit` can resolve "bun:sqlite" without adding a dependency.
// The real module (github.com/oven-sh/bun) has a much larger API than this.
declare module "bun:sqlite" {
  export class Statement {
    all(...params: any[]): any[];
    get(...params: any[]): any;
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  }

  export class Database {
    constructor(filename?: string, options?: { create?: boolean; readonly?: boolean; readwrite?: boolean });
    exec(sql: string): void;
    query(sql: string): Statement;
    prepare(sql: string): Statement;
    transaction<T extends (...args: any[]) => any>(fn: T): T & { deferred: T; immediate: T; exclusive: T };
    close(): void;
  }
}
