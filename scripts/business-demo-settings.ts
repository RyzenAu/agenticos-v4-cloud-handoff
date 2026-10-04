import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDirFor } from "./cloud/data-dir";
export function businessDemoSettings(root: string) {
  const dir = join(dataDirFor(root)), file = join(dir, "business-demo.json");
  const read = () => ({ enabled: existsSync(file) && JSON.parse(readFileSync(file, "utf8")).enabled === true });
  return { read, save(value: unknown) {
    if (typeof value !== "boolean") throw new Error("Choose whether demo numbers are enabled.");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}`;
    writeFileSync(temp, JSON.stringify({ enabled: value }), { mode: 0o600 });
    renameSync(temp, file);
    return read();
  } };
}
