"use client";
// PREVIEW TEMPLATE: the verified services; the motion layer staggers them in as a list (data-mu-stagger).
import { usePreviewData } from "@/lib/preview";

export function PreviewServices() {
  const data = usePreviewData();
  return (
    <ul aria-busy={data ? undefined : true} data-mu-stagger="" style={{ listStyle: "none", margin: "2rem 0 0", padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "0 2rem" }}>
      {(data?.services ?? []).map((s) => (
        <li key={s.name} style={{ padding: "1.1rem 0", borderTop: "1px solid var(--line, rgba(0,0,0,.14))" }}>
          <b className="serif" style={{ display: "block", fontSize: "1.25rem", fontWeight: 500 }}>{s.name}</b>
          <span style={{ display: "block", opacity: 0.7, fontSize: ".92rem", marginTop: ".25rem" }}>{s.note}</span>
        </li>
      ))}
    </ul>
  );
}

/** Plain links to the services section (footer). */
export function PreviewServiceLinks() {
  const data = usePreviewData();
  return <>{(data?.services ?? []).map((s) => <a key={s.name} href="/#services">{s.name}</a>)}</>;
}
