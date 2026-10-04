"use client";
import Link from "next/link";
import Image from "next/image";
import { homepage, credibility, site } from "@/data/site";
import { agents } from "@/data/agents";
import { suburbs } from "@/data/suburbs";
import { articles } from "@/data/articles";
import { stock } from "@/data/stock";
import { listingsBySuburb, listingsByChannel, recentActivity } from "@/lib/listings/queries";
import { useListings } from "@/lib/listings/store";
import { spec } from "@/lib/listings/spec";
import { PropertyImage } from "@/components/property/PropertyImage";
import { AreaMap } from "@/components/art/AreaMap";
import { PropertyCard } from "@/components/property/PropertyCard";
import { AgentCard } from "@/components/agents/AgentCard";
import { SectionHead } from "@/components/ui/SectionHead";
import { Reveal } from "@/components/ui/Reveal";
import { PreviewServices } from "@/components/PreviewServices";
import { HeroSearch } from "@/components/home/HeroSearch";
import { ArticleLead } from "@/components/insights/ArticleLead";
import { Arrow, Bed, Bath, Car } from "@/components/ui/Icons";
import { fmtDay, statusChipClass, statusText, fmtDate } from "@/lib/format";
import styles from "./home.module.css";

const eventLabel: Record<string, string> = {
  listed: "Just listed",
  "price-updated": "Guide revised",
  "under-offer": "Under offer",
  sold: "Sold",
  leased: "Leased",
  withdrawn: "Withdrawn",
  "inspection-added": "New inspection",
};

export default function HomePage() {
  // The business's own listings load in the browser after hydration (lib/listings/store.ts); until then, and when it supplied none,
  // the page shows an honest empty state. No property on this page is the template's own example stock.
  const { ready, items } = useListings();
  const onMarket = listingsByChannel("buy");
  const results = listingsByChannel("sold");
  const rentals = listingsByChannel("rent");
  const shown = items.filter((l) => l.status !== "withdrawn");
  const hero = ready ? shown.find((l) => l.photos?.length) ?? shown[0] : undefined;
  const featured = (onMarket.length ? onMarket : shown).slice(0, 4);
  const featuredAgents = homepage.featuredAgentSlugs.map((s) => agents.find((a) => a.slug === s)!).filter(Boolean);
  const featuredSuburbs = homepage.featuredSuburbSlugs.map((s) => suburbs.find((x) => x.slug === s)!).filter(Boolean);
  const featuredArticles = homepage.featuredArticleSlugs.map((s) => articles.find((a) => a.slug === s)!).filter(Boolean);
  const activity = ready ? recentActivity(6).filter((a) => a.listing.status !== "withdrawn") : [];
  const ask = shown[0];
  const stats = [
    { n: onMarket.length, label: "Homes for sale" },
    { n: rentals.length, label: "Rentals" },
    { n: results.length, label: "Sold and leased" },
  ].filter((st) => st.n > 0);

  return (
    <div data-mu-property-experience="v3" data-mu-reference-layout="public-reference-9f374eb">
      {/* Hero */}
      <section className={styles.hero}>
        <div className={styles.heroMedia}>
          <Image src={stock.hero.src} alt={stock.hero.alt} fill priority sizes="100vw" className={styles.heroArt} style={{ objectFit: "cover" }} />
          <div className={styles.heroShade} aria-hidden="true" />
        </div>
        <div className={`container container--wide ${styles.heroInner}`}>
          <Reveal className={styles.heroCopy}>
            <p className={`eyebrow ${styles.heroEyebrow}`}>{site.name} · {site.suburb}</p>
            <h1 className={`h-display ${styles.heroTitle}`}>
              Real estate in {site.suburb}, <em>read closely.</em>
            </h1>
            <p className={styles.heroLede}>
              {site.name}. The agency’s own properties, services and contact details, laid out in the complete website. The photograph is illustrative.
            </p>
            <HeroSearch />
          </Reveal>
          {hero && (
            <Reveal className={styles.heroCard} delay={200}>
              <Link href={`/property/${hero.slug}`}>
                <span className={styles.heroCardLabel}>Pictured · {statusText(hero)}</span>
                <b>
                  {hero.address.street}, {hero.address.suburb}
                </b>
                <span>{hero.headline}</span>
                <span className={styles.heroCardMeta}>
                  <Bed /> {spec(hero, "beds")} <Bath /> {spec(hero, "baths")} <Car /> {spec(hero, "cars")}
                </span>
                <span className={styles.heroCardPrice}>{hero.resultDisplay ?? hero.priceDisplay}</span>
                <Arrow />
              </Link>
            </Reveal>
          )}
        </div>
        {stats.length > 0 && (
          <div className={`container container--wide ${styles.heroStrip}`}>
            <Reveal delay={300}>
              <ul>
                {stats.map((st) => (
                  <li key={st.label}>
                    <b>{st.n}</b>
                    <span>{st.label}</span>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        )}
      </section>

      {/* Featured properties */}
      <section className="section" id="properties">
        <div className="container container--wide">
          <SectionHead eyebrow="For sale" title={featured.length ? "Current properties." : "Properties."} lede={featured.length ? "Photographs, features, price and inspection times, as the agency supplied them." : undefined} link={{ label: "All properties for sale", href: "/buy" }} />
          {!ready ? (
            <p className="lede" aria-busy="true">Loading properties…</p>
          ) : featured.length ? (
            <div className={styles.grid4}>
              {featured.map((l, i) => (
                <Reveal key={l.slug} delay={i * 60}>
                  <PropertyCard listing={l} />
                </Reveal>
              ))}
            </div>
          ) : (
            <p className="lede">No properties have been supplied for this preview yet. {site.name} would list its current sales and rentals here; nothing on this page is another agency’s stock.</p>
          )}
        </div>
      </section>

      {/* Sell / Manage */}
      <section className="section section--paper">
        <div className={`container container--wide ${styles.split}`}>
          <Reveal className={styles.panel}>
            <span className={styles.panelMedia}>
              <Image src={stock.terraces.src} alt={stock.terraces.alt} fill sizes="(min-width: 900px) 45vw, 100vw" />
            </span>
            <div className={styles.panelBody}>
            <p className="eyebrow">Selling</p>
            <h2 className="h-2">Know what your home is worth before you decide anything.</h2>
            <p className="lede">
              Explore the selling and appraisal pages. Contact the agency to confirm the process for your own property.
            </p>
            <div className={styles.panelActions}>
              <Link href="/sell#appraisal" className="btn btn--oxblood">
                Request an appraisal
              </Link>
              <Link href="/sell" className="arrowLink">
                How we sell <Arrow />
              </Link>
            </div>
            </div>
          </Reveal>
          <Reveal className={`${styles.panel} ${styles.panelSage}`} delay={100}>
            <span className={styles.panelMedia}>
              <Image src={stock.keys.src} alt={stock.keys.alt} fill sizes="(min-width: 900px) 45vw, 100vw" />
            </span>
            <div className={styles.panelBody}>
            <p className="eyebrow">Property management</p>
            <h2 className="h-2">Your property management, clearly presented.</h2>
            <p className="lede">
              See how a management service can be presented. The agency confirms its services and process before launch.
            </p>
            <div className={styles.panelActions}>
              <Link href="/property-management#appraisal" className="btn btn--ink">
                Rental appraisal
              </Link>
              <Link href="/property-management" className="arrowLink">
                How we manage <Arrow />
              </Link>
            </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* The business's own verified services */}
      <section className="section" id="services">
        <div className="container container--wide">
          <SectionHead eyebrow="Services" title={site.servicesLabel} lede={site.servicesNote} />
          <PreviewServices />
        </div>
      </section>

      {/* Activity */}
      {activity.length > 0 && (
        <section className="section">
          <div className="container container--wide">
            <SectionHead eyebrow="Recent activity" title="Listed, revised, sold and leased." lede="From the listings supplied for this preview." link={{ label: "Sold results", href: "/sold" }} />
            <ol className={styles.activity}>
              {activity.map((a, i) => (
                <Reveal as="li" key={`${a.listing.slug}-${a.at}-${a.type}`} delay={i * 50} className={styles.activityItem}>
                  <Link href={`/property/${a.listing.slug}`}>
                    <span className={styles.activityArt}>
                      <PropertyImage listing={a.listing} view="exterior" sizes="120px" />
                    </span>
                    <span className={styles.activityBody}>
                      <span className={styles.activityDate}>{fmtDay(a.at)}</span>
                      <span className={statusChipClass(a.listing)}>{eventLabel[a.type]}</span>
                      <b>{a.listing.address.street}</b>
                      <span>{a.listing.address.suburb}{a.note ? ` · ${a.note}` : ""}</span>
                      <span className={`serif ${styles.activityPrice}`}>{a.listing.resultDisplay ?? a.listing.priceDisplay}</span>
                    </span>
                  </Link>
                </Reveal>
              ))}
            </ol>
          </div>
        </section>
      )}

      {/* Walkthrough assistant */}
      {ask && (
        <section className={`section section--ink ${styles.assistant}`}>
          <div className={`container container--wide ${styles.assistantInner}`}>
            <Reveal>
              <p className="eyebrow">On every listing</p>
              <h2 className="h-2">Ask the property, not the brochure.</h2>
              <p className="lede">
                Try the listing-specific walkthrough with the details supplied for this preview. It answers locally; no details are sent and no inspection is booked.
              </p>
              <Link href={`/property/${ask.slug}?ask=1`} className={`btn btn--paper ${styles.assistantCta}`}>
                Try it on {ask.address.street}
              </Link>
            </Reveal>
            <Reveal className={styles.assistantChat} delay={100} aria-hidden="true">
              <span className={styles.chatUser}>When are the inspections?</span>
              <span className={styles.chatBot}>Scheduled inspections are listed on the property page. If there are none, the agency can arrange one. The preview form sends nothing.</span>
              <span className={styles.chatUser}>Is it a good investment?</span>
              <span className={styles.chatBot}>I can&rsquo;t give financial or investment advice, and I&rsquo;m not a substitute for a licensed agent. I can share what&rsquo;s published and point you to the agency's contact details.</span>
            </Reveal>
          </div>
        </section>
      )}

      {/* Agents */}
      <section className="section section--paper">
        <div className="container container--wide">
          <SectionHead eyebrow="Agents" title="Meet the team — example profiles." lede="Fictional profiles demonstrate the team layout. The agency’s actual people replace them before launch." link={{ label: "All agents", href: "/agents" }} />
          <div className={styles.grid3}>
            {featuredAgents.map((a, i) => (
              <Reveal key={a.slug} delay={i * 70}>
                <AgentCard agent={a} />
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Suburbs */}
      <section className="section">
        <div className="container container--wide">
          <SectionHead eyebrow="Suburbs" title="Neighbourhoods, street by street." lede="Example suburb guides, listing links and clearly labelled demonstration market figures." link={{ label: "All suburb guides", href: "/suburbs" }} />
          <div className={styles.suburbs}>
            <Reveal className={styles.suburbMap}>
              <AreaMap />
            </Reveal>
            <div className={styles.suburbList}>
              {featuredSuburbs.map((s, i) => (
                <Reveal as="div" key={s.slug} delay={i * 60}>
                  <Link href={`/suburbs/${s.slug}`} className={styles.suburbRow}>
                    <span>
                      <b className="serif">{s.name}</b>
                      <em>{s.tagline}</em>
                    </span>
                    <span className={styles.suburbCount}>{listingsBySuburb(s.slug).length} listings</span>
                    <Arrow />
                  </Link>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Insights */}
      <section className="section section--paper">
        <div className="container container--wide">
          <SectionHead eyebrow="Insights" title="Notes from the office." lede="Example editorial content for the journal. Client-approved articles replace it before launch." link={{ label: "All insights", href: "/insights" }} />
          <div className={styles.grid3}>
            {featuredArticles.map((a, i) => (
              <Reveal as="article" key={a.slug} delay={i * 70} className={styles.article}>
                <Link href={`/insights/${a.slug}`}>
                  <ArticleLead article={a} className={styles.articleTint}>
                    <span className={styles.articleCat}>{a.category}</span>
                  </ArticleLead>
                  <h3 className="h-3">{a.title}</h3>
                  <p>{a.excerpt}</p>
                  <span className={styles.articleMeta}>
                    {fmtDate(a.publishedAt)} · {a.readMinutes} min read
                  </span>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Credibility */}
      <section className="section section--ink">
        <div className="container container--wide">
          <SectionHead eyebrow="Why Aldergate" title="A clear property experience." />
          <ul className={styles.cred}>
            {credibility.map((c, i) => (
              <Reveal as="li" key={c.title} delay={i * 70}>
                <h3 className="h-3">{c.title}</h3>
                <p>{c.body}</p>
              </Reveal>
            ))}
          </ul>
        </div>
      </section>

      {/* Final CTA */}
      <section className={`section ${styles.finalCta}`}>
        <div className={`container ${styles.finalInner}`}>
          <Reveal>
            <p className="eyebrow">Get in touch</p>
            <h2 className="h-1">Tell us what you&rsquo;re trying to do.</h2>
            <p className="lede">Buying, selling, renting or leasing out: start with what you need. Contact {site.name} directly for a real enquiry.</p>
          </Reveal>
          <Reveal className={styles.finalActions} delay={100}>
            <Link href="/contact" className="btn btn--oxblood btn--lg">
              Contact the office
            </Link>
            <a href={site.phoneHref} className="btn btn--outline btn--lg">
              {site.phone}
            </a>
            <span className={styles.finalMeta}>
              <Bed /> Buyers · <Car /> Sellers · <Bath /> Landlords &amp; tenants
            </span>
          </Reveal>
        </div>
      </section>
    </div>
  );
}
