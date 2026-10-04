"use client";
// PREVIEW TEMPLATE: the verified services list, in the flagship's own "needs" row styling.
import { usePreviewData } from "@/lib/preview";

export function PreviewServices({ listClass, itemClass, labelClass, answerClass }: { listClass: string; itemClass: string; labelClass: string; answerClass: string }) {
  const data = usePreviewData();
  return (
    <ul className={listClass} aria-busy={data ? undefined : true} data-mu-stagger="">
      {(data?.services ?? []).map((s) => (
        <li key={s.name} className={itemClass}>
          <span className={labelClass}>{s.name}</span>
          <span className={answerClass}>{s.note}</span>
        </li>
      ))}
    </ul>
  );
}

/** Plain links to the services section (header menu, drawer, footer). */
export function PreviewServiceLinks({ onPick }: { onPick?: () => void }) {
  const data = usePreviewData();
  return (
    <>
      {(data?.services ?? []).map((s) => (
        <li key={s.name}><a href="#services" onClick={onPick}>{s.name}</a></li>
      ))}
    </>
  );
}
