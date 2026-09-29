// PREVIEW TEMPLATE home page: the flagship's hero (with its image drift and reveals), the
// verified services, a visit/contact split in the flagship's panel style, and the closing call.
// Removed from the flagship: listings, prices, sales activity, agents, suburb guides, insights,
// the listing assistant demo, the search box and every "why us" claim. No eyebrow labels
// (impeccable bans them). data-mu-* are hooks for the preview motion layer (motion.ts): the hero
// photo pushes in as the copy lifts away, a marquee of the verified services, the services
// count-up and list stagger, and the panel photos drift inside their frames.
import Image from "next/image";
import { site } from "@/data/site";
import { stock } from "@/data/stock";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHead } from "@/components/ui/SectionHead";
import { PreviewServices } from "@/components/PreviewServices";
import styles from "./home.module.css";

export default function HomePage() {
  return (
    <>
      <section className={styles.hero} data-mu-hero="">
        <div className={styles.heroMedia}>
          <Image src="/photos/stock/hero-01.jpg" alt="" fill priority sizes="100vw" className={styles.heroArt} data-mu-push="" />
          <div className={styles.heroShade} aria-hidden="true" />
        </div>
        <div className={`container container--wide ${styles.heroInner}`} data-mu-lift="">
          <Reveal className={styles.heroCopy}>
            <h1 className={`h-display ${styles.heroTitle}`}>
              Real estate in {site.suburb}, <em>{site.name}.</em>
            </h1>
            <p className={styles.heroLede}>{site.office.street}, {site.office.suburb}.</p>
            <p><a href="#services" className="btn btn--oxblood">See services</a></p>
          </Reveal>
        </div>
      </section>

      <div data-mu-marquee="" aria-hidden="true" />

      <section id="services" className="section">
        <div className="container container--wide">
          <SectionHead title={site.servicesLabel} lede={site.servicesNote} />
          <p className="mu-count-line"><span data-mu-count="">{site.servicesCount}</span> {site.servicesNoun} listed</p>
          <PreviewServices />
        </div>
      </section>

      <section id="visit" className="section section--paper">
        <div className={`container container--wide ${styles.split}`}>
          <Reveal className={styles.panel}>
            <span className={styles.panelMedia} data-mu-drift="">
              <Image src={stock.terraces.src} alt={stock.terraces.alt} fill sizes="(min-width: 900px) 45vw, 100vw" />
            </span>
            <div className={styles.panelBody}>
              <h2 className="h-2">Find {site.name} at {site.office.street}.</h2>
              <p className="lede">{site.office.street}, {site.office.suburb}. {site.hoursNote}</p>
              <div className={styles.panelActions}>
                <a href={site.phoneHref} className="btn btn--oxblood">Call {site.phone}</a>
              </div>
            </div>
          </Reveal>
          <Reveal className={`${styles.panel} ${styles.panelSage}`} delay={100}>
            <span className={styles.panelMedia} data-mu-drift="">
              <Image src={stock.keys.src} alt={stock.keys.alt} fill sizes="(min-width: 900px) 45vw, 100vw" />
            </span>
            <div className={styles.panelBody}>
              <h2 className="h-2">Start with one conversation.</h2>
              <p className="lede">Buying, selling, renting or leasing out, the first conversation is the same: what do you need, and what would help.</p>
              <div className={styles.panelActions}>
                <a href="#contact" className="btn btn--ink">Contact {site.name}</a>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <section id="contact" className={`section ${styles.finalCta}`}>
        <div className={`container ${styles.finalInner}`}>
          <Reveal>
            <h2 className="h-1">Talk to {site.name}.</h2>
            <p className="lede">{site.office.street}, {site.office.suburb}.</p>
          </Reveal>
          <Reveal className={styles.finalActions} delay={100}>
            <a href={site.phoneHref} className="btn btn--oxblood btn--lg">Call {site.phone}</a>
            <a href={site.emailHref} className="btn btn--outline btn--lg" data-mu-optional="email">Email {site.email}</a>
          </Reveal>
        </div>
      </section>
    </>
  );
}
