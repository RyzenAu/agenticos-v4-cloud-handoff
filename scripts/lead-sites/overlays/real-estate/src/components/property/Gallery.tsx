"use client";

import { useEffect, useState } from "react";
import { ListingPhoto } from "./ListingPhoto";
import type { ArtView, FloorplanRoom, Listing } from "@/data/types";
import { PropertyArt, Floorplan } from "@/components/art/PropertyArt";
import { ArrowBack, Arrow } from "@/components/ui/Icons";
import styles from "./Gallery.module.css";

const viewLabel: Record<ArtView, string> = {
  exterior: "Exterior",
  living: "Living",
  kitchen: "Kitchen",
  bedroom: "Bedroom",
  outdoor: "Outdoors",
  floorplan: "Floor plan",
};

type Slide = { kind: "none"; label: string } | { kind: "photo"; index: number; label: string } | { kind: "art"; view: ArtView; label: string } | { kind: "plan"; label: string };

/** Editorial gallery with crossfade, thumbnails and keyboard control. */
export function Gallery({ listing, floorplan }: { listing: Listing; floorplan: FloorplanRoom[] }) {
  const label = `${listing.address.street}, ${listing.address.suburb}`;
  const photos = listing.photos ?? [];
  const slides: Slide[] = photos.length
    ? photos.map((p, index) => ({ kind: "photo" as const, index, label: (viewLabel as Record<string, string>)[p.view] ?? "Photo" }))
    : listing.noPhotos
    ? [{ kind: "none" as const, label: "No photo" }]
    : listing.art.views.filter((v) => v !== "floorplan").map((view) => ({ kind: "art" as const, view, label: viewLabel[view] }));
  if (floorplan.length) slides.push({ kind: "plan", label: "Floor plan" });
  const [i, setI] = useState(0);
  const go = (n: number) => setI((c) => (c + n + slides.length) % slides.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides.length]);

  const render = (s: Slide, active: boolean, thumb = false) => {
    if (s.kind === "plan") return thumb ? <span className={styles.thumbPlan}>Plan</span> : <div className={styles.plan}><Floorplan rooms={floorplan} label={label} /></div>;
    if (s.kind === "none") return thumb ? <span className={styles.thumbPlan}>No photo</span> : <div className={styles.plan} style={{ display: "grid", placeItems: "center", textAlign: "center", padding: "2rem" }}><p>Photographs of this property have not been supplied for this preview.</p></div>;
    if (s.kind === "photo") {
      const p = photos[s.index];
      return <ListingPhoto photo={p} alt={thumb ? "" : p.alt} sizes={thumb ? "120px" : "(min-width: 900px) 60vw, 100vw"} priority={!thumb && s.index === 0} className={styles.photo} />;
    }
    return <PropertyArt spec={listing.art} view={s.view} seed={listing.slug} label={label} className={styles.art} priority={active && !thumb} />;
  };

  return (
    <figure className={styles.gallery} aria-label={`Gallery for ${label}`}>
      <div className={styles.stage}>
        {slides.map((s, idx) => (
          <div key={s.kind + (s.kind === "photo" ? s.index : s.kind === "art" ? s.view : "")} className={`${styles.slide} ${idx === i ? styles.slideActive : ""}`} aria-hidden={idx !== i}>
            {render(s, idx === i)}
          </div>
        ))}
        {slides.length > 1 && (
          <>
            <button type="button" className={`${styles.nav} ${styles.prev}`} onClick={() => go(-1)} aria-label="Previous image">
              <ArrowBack />
            </button>
            <button type="button" className={`${styles.nav} ${styles.next}`} onClick={() => go(1)} aria-label="Next image">
              <Arrow />
            </button>
          </>
        )}
        <span className={styles.counter} aria-live="polite">
          {slides[i].label} · {i + 1} / {slides.length}
        </span>
      </div>
      {slides.length > 1 && (
      <div className={styles.thumbs} role="tablist" aria-label="Gallery images">
        {slides.map((s, idx) => (
          <button key={idx} type="button" role="tab" aria-selected={idx === i} className={`${styles.thumb} ${idx === i ? styles.thumbActive : ""}`} onClick={() => setI(idx)} aria-label={s.label}>
            {render(s, idx === i, true)}
          </button>
        ))}
      </div>
      )}
      <figcaption className="visuallyHidden">{listing.supplied ? `Images supplied for this preview for ${label}.` : `Demonstration imagery for ${label}.`}</figcaption>
    </figure>
  );
}
