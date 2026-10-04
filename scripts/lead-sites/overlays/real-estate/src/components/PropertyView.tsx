"use client";
// PREVIEW TEMPLATE: one property page, rendered in the browser from the business's own supplied listings (lib/listings/store.ts).
// The generator writes one copy of the exported placeholder page per supplied listing; the slug is read from the address bar.
import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { listingBySlug, similarListings, channelOf } from "@/lib/listings/queries";
import { useListings } from "@/lib/listings/store";
import { spec } from "@/lib/listings/spec";
import type { Agent } from "@/data/types";
import { agentBySlug } from "@/data/agents";
import { suburbBySlug } from "@/data/suburbs";
import { site } from "@/data/site";
import { Gallery } from "@/components/property/Gallery";
import { StickyBar } from "@/components/property/StickyBar";
import { SaveButton } from "@/components/property/SaveButton";
import { ShareButton } from "@/components/property/ShareButton";
import { PropertyCard } from "@/components/property/PropertyCard";
import { Portrait } from "@/components/art/Portrait";
import { AreaMap } from "@/components/art/AreaMap";
import { Floorplan } from "@/components/art/PropertyArt";
import { EnquiryForm } from "@/components/forms/EnquiryForm";
import { Assistant } from "@/components/assistant/Assistant";
import { Reveal } from "@/components/ui/Reveal";
import { Bed, Bath, Car, Land, Calendar, Pin, Arrow } from "@/components/ui/Icons";
import { fullAddress, shortAddress, statusChipClass, statusText, typeLabel, fmtLongDay, fmtDateTime, fmtDate } from "@/lib/format";
import styles from "@/app/property/[slug]/property.module.css";

/** The business itself, standing in for a listing agent: a supplied listing names no agent of its own. */
function agencyContact(): Agent {
  const initials = site.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return { slug: "agency", name: site.name, role: "The agency", team: "sales", phone: site.phone, email: site.email, bio: [], expertise: [], suburbs: [], initials, tint: "#7b2d2a" };
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "the portal";
  }
}

export function PropertyView() {
  const { ready } = useListings();
  const slug = usePathname().split("/").filter(Boolean).pop() ?? "";
  const l = ready ? listingBySlug(slug) : undefined;
  useEffect(() => {
    if (l) document.title = `${l.address.street}, ${l.address.suburb} — ${site.name} preview (not the official website)`;
  }, [l]);
  if (!ready)
    return (
      <div className="pageTop container" aria-busy="true">
        <h1 className="h-1">Property</h1>
        <p className="lede">Loading property…</p>
      </div>
    );
  if (!l || l.status === "withdrawn")
    return (
      <div className="pageTop container">
        <p className="eyebrow">Property</p>
        <h1 className="h-1">This property is not listed.</h1>
        <p className="lede">It may have been withdrawn, or it was not supplied for this preview.</p>
        <p>
          <Link href="/buy" className="btn btn--ink">Search properties</Link>{" "}
          <Link href="/contact" className="btn btn--outline">Contact the office</Link>
        </p>
      </div>
    );

  const supplied = Boolean(l.supplied);
  const agent: Agent = (l.agentSlugs[0] ? agentBySlug(l.agentSlugs[0]) : undefined) ?? agencyContact();
  const agentHref = agent.slug === "agency" ? "/contact" : `/agents/${agent.slug}`;
  const second = l.agentSlugs[1] ? agentBySlug(l.agentSlugs[1]) : undefined;
  const suburb = suburbBySlug(l.address.suburb.toLowerCase());
  const similar = similarListings(l, 3);
  const channel = channelOf(l);
  const isResult = l.status === "sold" || l.status === "leased";
  const price = l.resultDisplay ?? l.priceDisplay;

  return (
    <article className={styles.page}>
      <div className={`container container--wide ${styles.top}`}>
        <nav className={styles.crumbs} aria-label="Breadcrumb">
          <Link href="/">Home</Link>
          <span aria-hidden="true">/</span>
          <Link href={`/${channel}`}>{channel === "buy" ? "Buy" : channel === "rent" ? "Rent" : "Sold"}</Link>
          <span aria-hidden="true">/</span>
          <span>{l.address.suburb}</span>
        </nav>

        <Reveal>
          <Gallery listing={l} floorplan={l.floorplan} />
        </Reveal>

        <div className={styles.layout}>
          <div className={styles.main}>
            <header className={styles.header}>
              <div className={styles.chips}>
                <span className={statusChipClass(l)}>{statusText(l)}</span>
                <span className="chip">{typeLabel(l.type)}</span>
                {l.auctionAt && !isResult && <span className="chip">{fmtLongDay(l.auctionAt.slice(0, 10))}</span>}
              </div>
              <p className={`serif ${styles.price}`}>{price}</p>
              {l.priceNote && <p className={styles.muted}>{l.priceNote}</p>}
              <h1 className={styles.address}>
                {l.address.street}
                <span>
                  {l.address.suburb} {l.address.state} {l.address.postcode}
                </span>
              </h1>
              <ul className={styles.meta}>
                <li>
                  <Bed /> <b>{spec(l, "beds")}</b> bed
                </li>
                <li>
                  <Bath /> <b>{spec(l, "baths")}</b> bath
                </li>
                <li>
                  <Car /> <b>{spec(l, "cars")}</b> car
                </li>
                {l.landSqm && (
                  <li>
                    <Land /> <b>{l.landSqm}</b> m² land
                  </li>
                )}
                {l.internalSqm && (
                  <li>
                    <b>{l.internalSqm}</b> m² internal
                  </li>
                )}
              </ul>
              <div className={styles.actions}>
                <SaveButton slug={l.slug} label />
                <ShareButton title={`${l.address.street}, ${l.address.suburb}`} path={`/property/${l.slug}`} />
                <Assistant listing={l} agent={agent} suburb={suburb} others={similar} />
              </div>
              {l.portalUrl && (
                <p className={styles.muted}>
                  <a href={l.portalUrl} target="_blank" rel="noopener nofollow noreferrer" className="arrowLink">
                    View this listing on {host(l.portalUrl)} <Arrow />
                  </a>
                </p>
              )}
            </header>

            <section className={styles.block}>
              <h2 className="h-3">{l.headline}</h2>
              <div className={`prose ${styles.desc}`}>
                {l.description.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </section>

            {l.features.length > 0 && (
              <section className={styles.block}>
                <h2 className={`h-3 ${styles.blockTitle}`}>Features</h2>
                <ul className={styles.features}>
                  {l.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </section>
            )}

            {l.rental && !isResult && (
              <section className={styles.block}>
                <h2 className={`h-3 ${styles.blockTitle}`}>Lease details</h2>
                <dl className={styles.dl}>
                  <div>
                    <dt>Available</dt>
                    <dd>{fmtDate(l.rental.availableFrom)}</dd>
                  </div>
                  <div>
                    <dt>Bond</dt>
                    <dd>{l.rental.bondWeeks} weeks&rsquo; rent</dd>
                  </div>
                  <div>
                    <dt>Furnished</dt>
                    <dd>{l.rental.furnished ? "Yes" : "No"}</dd>
                  </div>
                  <div>
                    <dt>Pets</dt>
                    <dd>{l.rental.petsConsidered ? "Considered on application" : "Not accepted"}</dd>
                  </div>
                </dl>
              </section>
            )}

            {!isResult && (
              <section className={styles.block} id="inspection">
                <h2 className={`h-3 ${styles.blockTitle}`}>
                  <Calendar /> Inspections
                </h2>
                {l.inspections.length === 0 ? (
                  <p className={styles.muted}>{l.status === "under-offer" ? "Inspections are paused while the property is under offer." : "No open inspections are scheduled. Request a private inspection below."}</p>
                ) : (
                  <ul className={styles.inspections}>
                    {l.inspections.map((i) => (
                      <li key={`${i.date}${i.start}`}>
                        <b>{fmtLongDay(i.date)}</b>
                        <span>
                          {i.start} – {i.end}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {l.auctionAt && (
                  <p className={styles.auction}>
                    <b>Auction</b> {fmtDateTime(l.auctionAt)}, on site.
                  </p>
                )}
                <details className={styles.inspectForm}>
                  <summary>Register for an inspection or request a private viewing</summary>
                  <EnquiryForm
                    kind="inspection"
                    tone="bone"
                    submitLabel="Register"
                    successTitle="Preview only."
                    successBody="This is a preview — enquiries aren't sent yet."
                    context={{ property: fullAddress(l), agent: agent.name }}
                    fields={[
                      { name: "name", label: "Name", required: true, autoComplete: "name", half: true },
                      { name: "phone", label: "Phone", type: "tel", required: true, autoComplete: "tel", half: true },
                      { name: "email", label: "Email", type: "email", required: true, autoComplete: "email" },
                      { name: "inspection", label: "Which inspection?", type: "select", options: [...l.inspections.map((i) => `${fmtLongDay(i.date)} ${i.start}`), "Request a private inspection"], defaultValue: l.inspections[0] ? `${fmtLongDay(l.inspections[0].date)} ${l.inspections[0].start}` : "Request a private inspection" },
                      { name: "message", label: "Anything we should know?", type: "textarea", rows: 2 },
                    ]}
                  />
                </details>
              </section>
            )}

            {l.floorplan.length > 0 && (
              <section className={styles.block}>
                <h2 className={`h-3 ${styles.blockTitle}`}>Floor plan</h2>
                <div className={styles.planWrap}>
                  <Floorplan rooms={l.floorplan} label={shortAddress(l)} />
                </div>
              </section>
            )}

            <section className={styles.block}>
              <h2 className={`h-3 ${styles.blockTitle}`}>
                <Pin /> Location
              </h2>
              <div className={styles.location}>
                {!suburb && <p className={styles.muted}>{fullAddress(l)}</p>}
                {suburb && <AreaMap highlight={suburb.slug} pin={{ x: suburb.map.x + 4, y: suburb.map.y - 3, label: shortAddress(l) }} compact />}
                {suburb && (
                  <div className={styles.locationText}>
                    <p className="serif">{suburb.name}</p>
                    <p>{suburb.overview[0]}</p>
                    <Link href={`/suburbs/${suburb.slug}`} className="arrowLink">
                      {suburb.name} guide <Arrow />
                    </Link>
                  </div>
                )}
              </div>
            </section>

            <section className={styles.block}>
              <h2 className={`h-3 ${styles.blockTitle}`}>{l.events.length ? "Listing history" : "About this listing"}</h2>
              {l.events.length > 0 && (
                <ol className={styles.history}>
                  {[...l.events].reverse().map((e) => (
                    <li key={`${e.type}${e.at}`}>
                      <span>{fmtDate(e.at)}</span>
                      <b>{{ listed: "Listed", "price-updated": "Price guide updated", "under-offer": "Under offer", sold: "Sold", leased: "Leased", withdrawn: "Withdrawn", "inspection-added": "Inspection added" }[e.type]}</b>
                      {e.note && <em>{e.note}</em>}
                    </li>
                  ))}
                </ol>
              )}
              <p className={styles.demo}>
                {supplied
                  ? `Listing details as supplied for this preview. Confirm availability, price and inspection times with ${site.name}.`
                  : `Demonstration listing ${l.id}. Not a real property; details are illustrative and internally consistent for this showcase.`}
              </p>
            </section>
          </div>

          <aside className={styles.side} id="enquire">
            <div className={styles.sticky}>
              <div className={styles.agentCard}>
                <Link href={agentHref} className={styles.agentRow}>
                  <Portrait agent={agent} size="sm" />
                  <span>
                    <b>{agent.name}</b>
                    <em>{agent.role}</em>
                  </span>
                </Link>
                {second && (
                  <Link href={`/agents/${second.slug}`} className={styles.agentRow}>
                    <Portrait agent={second} size="sm" />
                    <span>
                      <b>{second.name}</b>
                      <em>{second.role}</em>
                    </span>
                  </Link>
                )}
                <a href={site.phoneHref} className={styles.agentPhone}>
                  {site.phone}
                </a>
              </div>
              <EnquiryForm
                kind={isResult ? "agent" : "property"}
                submitLabel={isResult ? "Ask about similar properties" : "Send enquiry"}
                successTitle="Preview only."
                successBody="This is a preview — enquiries aren't sent yet."
                context={{ property: fullAddress(l), agent: agent.name, listing: l.id }}
                fields={[
                  { name: "name", label: "Name", required: true, autoComplete: "name" },
                  { name: "phone", label: "Phone", type: "tel", required: true, autoComplete: "tel", half: true },
                  { name: "email", label: "Email", type: "email", required: true, autoComplete: "email", half: true },
                  { name: "interest", label: "I'd like to", type: "select", options: isResult ? ["Hear about similar properties", "Get an appraisal on my own home", "Something else"] : channel === "rent" ? ["Register for an inspection", "Ask a question", "Apply for this property"] : ["Ask a question", "Request the contract of sale", "Arrange a private inspection", "Get a price update"], defaultValue: isResult ? "Hear about similar properties" : channel === "rent" ? "Register for an inspection" : "Ask a question" },
                  { name: "message", label: "Message", type: "textarea", rows: 3 },
                ]}
              />
            </div>
          </aside>
        </div>
      </div>

      {similar.length > 0 && (
        <section className="section section--paper">
          <div className="container container--wide">
            <Reveal className={styles.similarHead}>
              <p className="eyebrow">Similar properties</p>
              <h2 className="h-2">You might also look at</h2>
            </Reveal>
            <div className={styles.similar}>
              {similar.map((s, i) => (
                <Reveal key={s.slug} delay={i * 60}>
                  <PropertyCard listing={s} />
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      )}

      <StickyBar price={price} phoneHref={site.phoneHref} agentName={agent.name} />
    </article>
  );
}
