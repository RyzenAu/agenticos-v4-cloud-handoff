"use client";
// PREVIEW TEMPLATE: the lists a lead preview can't bake into markup (its verified services) are
// read after hydration from <script id="mu-preview-data" type="application/json">, which fill.ts
// writes into every page. The server renders an empty list, so hydration always matches.
import { useEffect, useState } from "react";

export type PreviewService = { name: string; note: string };
export type PreviewData = { services: PreviewService[] };

export function usePreviewData(): PreviewData | null {
  const [data, setData] = useState<PreviewData | null>(null);
  useEffect(() => {
    try {
      const el = document.getElementById("mu-preview-data");
      setData(el?.textContent ? (JSON.parse(el.textContent) as PreviewData) : { services: [] });
    } catch {
      setData({ services: [] });
    }
  }, []);
  return data;
}
