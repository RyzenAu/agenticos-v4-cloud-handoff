import type { MemoryApi } from "../memory/api";
import type { Principal } from "../memory/types";
import type { MemoryPort } from "./brief";

/**
 * The shared memory pool as the Agents workspace uses it: the EXISTING recall and remember paths of the memory API (the same ones Jarvis's voice turns and the MCP
 * tools use), called as the person whose bot it is, as a program ("process"). Recall returns the pool's own source-linked facts; remember is screened
 * like every save and honours MU_MEMORY_WRITES. Nothing here reads or writes the CRM.
 */
export function memoryPortFrom(api: () => Pick<MemoryApi, "recall" | "remember">): MemoryPort {
  const as = (person: string): Principal => ({ id: person, name: person.charAt(0).toUpperCase() + person.slice(1), via: "system", actor: "process" });
  return {
    async recall(person, query, limit) {
      const r = await api().recall(as(person), query, { limit });
      if (r.off) return { facts: [], note: null, off: r.off };
      const facts = r.facts.map((f) => ({ text: f.text, source: f.source.kind === "vault" ? `vault note ${f.source.path}` : `Jarvis memory ${f.source.id}` }));
      const note = !r.index_built ? "the memory index isn't built yet" : r.hindsight === "unavailable" || r.hindsight === "auth-failed" ? "Hindsight isn't reachable, so only the local index was searched" : null;
      return { facts, note };
    },
    async remember(person, input) {
      const r = await api().remember(as(person), { text: input.text, title: input.title, channel: "agent" });
      return { ok: r.ok === true, message: r.message };
    },
  };
}
