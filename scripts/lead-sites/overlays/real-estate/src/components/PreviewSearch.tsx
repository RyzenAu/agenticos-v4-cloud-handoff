"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { SearchPage } from "@/components/search/SearchPage";
import { listingsByChannel, parseFilters, searchListings, type Channel } from "@/lib/listings/queries";
import { useListings } from "@/lib/listings/store";
import { site } from "@/data/site";

const HEAD: Record<Channel, { eyebrow: string; title: string; none: string }> = {
  buy: { eyebrow: "Buy", title: "Property for sale", none: "has not supplied any properties for sale for this preview." },
  rent: { eyebrow: "Rent", title: "Property for lease", none: "has not supplied any rentals for this preview." },
  sold: { eyebrow: "Sold", title: "Sold and leased", none: "has not supplied any sold or leased results for this preview." },
};

// Static exports cannot read request searchParams on the server. Derive BOTH the displayed
// filters and their results in the browser, including direct URLs and back/forward navigation.
// The listings are the business's own, read in the browser (lib/listings/store.ts); when it has none for this channel the
// page says so plainly instead of showing filters with nothing to filter.
export function PreviewSearch({ channel }: { channel: Channel }) {
  const { ready } = useListings();
  const filters = parseFilters(useSearchParams());
  if (!ready) return <div className="pageTop container" aria-busy="true"><h1 className="h-1">{HEAD[channel].title}</h1><p className="lede">Loading properties…</p></div>;
  if (!listingsByChannel(channel).length) {
    const h = HEAD[channel];
    return (
      <div className="pageTop container">
        <p className="eyebrow">{h.eyebrow}</p>
        <h1 className="h-1">{h.title}</h1>
        <p className="lede">{site.name} {h.none} Properties appear here when the business supplies them; nothing on this page is another agency’s stock.</p>
        <p>
          <Link href="/contact" className="btn btn--ink">Contact the office</Link>{" "}
          <Link href="/" className="btn btn--outline">Back to the home page</Link>
        </p>
      </div>
    );
  }
  return <SearchPage channel={channel} filters={filters} results={searchListings(channel, filters)} />;
}
