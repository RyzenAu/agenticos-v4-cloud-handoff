import type { ArtView, Listing } from "@/data/types";
import { PropertyArt } from "@/components/art/PropertyArt";
import { shortAddress } from "@/lib/format";
import { ListingPhoto } from "./ListingPhoto";
import styles from "./PropertyImage.module.css";

/**
 * The one place that decides what a listing looks like. Uses the listing's photograph for the requested view when one exists.
 * A listing the business supplied with no photograph gets a plain "photos not supplied" tile, never generated art that could be
 * mistaken for the property. Fills its parent, which sets the aspect ratio.
 */
export function PropertyImage({ listing, view = "exterior", index, priority = false, sizes = "(min-width: 1100px) 33vw, (min-width: 640px) 50vw, 100vw", className = "" }: { listing: Listing; view?: ArtView; index?: number; priority?: boolean; sizes?: string; className?: string }) {
  const photos = listing.photos ?? [];
  const photo = typeof index === "number" ? photos[index] : photos.find((p) => p.view === view) ?? (view === "exterior" ? photos[0] : undefined);
  if (photo) {
    return <ListingPhoto photo={photo} alt={photo.alt} sizes={sizes} priority={priority} className={`${styles.img} ${className}`} />;
  }
  if (listing.noPhotos) {
    return (
      <span className={`${styles.art} ${className}`} role="img" aria-label={`No photograph supplied for ${shortAddress(listing)}`} style={{ display: "grid", placeItems: "center", background: "#e9e4d8", color: "#4a463f", fontSize: ".85rem", letterSpacing: ".02em", textAlign: "center", padding: "1rem" }}>
        Photo not supplied
      </span>
    );
  }
  return <PropertyArt spec={listing.art} view={view} seed={listing.slug} label={shortAddress(listing)} className={`${styles.art} ${className}`} priority={priority} />;
}
