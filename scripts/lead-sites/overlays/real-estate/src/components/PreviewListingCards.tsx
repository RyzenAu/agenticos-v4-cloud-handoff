"use client";
// PREVIEW TEMPLATE: a short row of the business's own listings for one channel (rentals on the tenants page, results on the selling
// page). Empty until the listings load; an honest line when the business has supplied none.
import { Reveal } from "@/components/ui/Reveal";
import { PropertyCard } from "@/components/property/PropertyCard";
import { listingsByChannel, type Channel } from "@/lib/listings/queries";
import { useListings } from "@/lib/listings/store";

const NONE: Record<Channel, string> = {
  buy: "No properties for sale have been supplied for this preview.",
  rent: "No rentals have been supplied for this preview.",
  sold: "No sold results have been supplied for this preview.",
};

export function PreviewListingCards({ channel, max = 3, className }: { channel: Channel; max?: number; className?: string }) {
  const { ready } = useListings();
  if (!ready) return <p className="lede" aria-busy="true">Loading…</p>;
  const items = listingsByChannel(channel).slice(0, max);
  if (!items.length) return <p className="lede">{NONE[channel]}</p>;
  return (
    <div className={className}>
      {items.map((l, i) => (
        <Reveal key={l.slug} delay={i * 60}>
          <PropertyCard listing={l} />
        </Reveal>
      ))}
    </div>
  );
}
