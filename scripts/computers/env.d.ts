// What the type-check of this folder needs from the Bun runtime (the repo's own tsconfig does not include Bun's types).
declare module "bun:sqlite" {
  export class Database {
    constructor(...args: any[]);
    [key: string]: any;
  }
}
interface ImportMeta {
  dir: string;
  main: boolean;
}
