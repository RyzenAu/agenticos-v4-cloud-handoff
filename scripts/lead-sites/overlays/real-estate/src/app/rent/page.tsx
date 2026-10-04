import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "Rent" };
import { PreviewSearch } from "@/components/PreviewSearch";
export default function Page() { return <Suspense fallback={<div className="container pageTop" aria-busy="true"><h1 className="h-1">Property for lease</h1><p className="lede">Loading properties…</p></div>}><PreviewSearch channel="rent" /></Suspense>; }
