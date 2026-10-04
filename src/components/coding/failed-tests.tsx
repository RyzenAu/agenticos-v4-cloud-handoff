// The meaningful part of a failing test run: each failing test's name and the assertion it printed, up front. The full
// output stays one click away behind "Show output" (the Tests tab), never in the way.
import { bareTestName } from "../../../scripts/coding/pause-reason";

export type FailureRow = { name: string; assertion: string | null };

/** At most `max` rows, name without the `file :: ` prefix, and how many more there are. Pure (the page and the tests share it). */
export function failureRows(failures: readonly FailureRow[] | null | undefined, names: readonly string[] | null | undefined, max = 5): { rows: { title: string; file: string | null; assertion: string | null }[]; more: number } {
  const source: FailureRow[] = failures?.length ? [...failures] : (names ?? []).map((name) => ({ name, assertion: null }));
  const rows = source.slice(0, max).map((f) => {
    const m = /^(.*?) :: /.exec(f.name);
    return { title: bareTestName(f.name), file: m ? m[1] : null, assertion: f.assertion };
  });
  return { rows, more: Math.max(0, source.length - rows.length) };
}

export function FailedTests({ failures, names, total }: { failures?: readonly FailureRow[] | null; names?: readonly string[] | null; total?: number | null }) {
  const { rows, more } = failureRows(failures, names);
  if (!rows.length) return null;
  const extra = Math.max(more, (total ?? 0) - rows.length);
  return (
    <ul className="mt-1.5 flex flex-col gap-1.5" aria-label="Failing tests">
      {rows.map((r) => (
        <li key={`${r.file ?? ""}${r.title}`} className="rounded-lg bg-inset px-3 py-2 text-xs">
          <span className="block font-medium text-foreground">{r.title}</span>
          {r.assertion ? <span className="block text-muted-foreground">{r.assertion}</span> : <span className="block text-muted-foreground">The runner printed no assertion for this one; open the output below.</span>}
          {r.file && <span className="block text-muted-foreground">{r.file}</span>}
        </li>
      ))}
      {extra > 0 && <li className="text-xs text-muted-foreground">and {extra} more failing. The full output is under Show output.</li>}
    </ul>
  );
}
