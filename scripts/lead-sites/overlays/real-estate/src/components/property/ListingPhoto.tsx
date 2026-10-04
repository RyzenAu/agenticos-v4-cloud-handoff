// PREVIEW TEMPLATE: a photograph the business supplied for one of its own listings. The generator copies the file into the
// preview under /listing-photos/ (there is no image optimiser in a static export, so it is shown as supplied); the template's own
// stock photographs keep going through next/image and its pre-rendered widths.
import Image from "next/image";
import type { Photo } from "@/data/types";

export function ListingPhoto({ photo, alt, sizes, priority, className }: { photo: Photo; alt: string; sizes?: string; priority?: boolean; className?: string }) {
  if (photo.src.startsWith("/listing-photos/")) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={photo.src} alt={alt} loading={priority ? "eager" : "lazy"} decoding="async" className={className} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />;
  }
  return <Image src={photo.src} alt={alt} fill sizes={sizes} priority={priority} className={className} />;
}
