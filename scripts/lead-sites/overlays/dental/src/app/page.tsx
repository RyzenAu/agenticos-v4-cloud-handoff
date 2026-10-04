// PREVIEW TEMPLATE home page: the flagship's opening scene, the "how a visit goes" scroll story
// (neutral wording), the verified services, where to find the practice, and the closing scene.
// Removed from the flagship: sample fees, example appointment times and every practice policy.
// data-mu-* are hooks for the preview motion layer (motion.ts): a marquee of the verified
// treatments, the services count-up and list stagger, and the practice details rising in.
import { site } from "@/lib/site";
import { Phone } from "@/components/Icons";
import { PreviewServices } from "@/components/PreviewServices";
import { FlagshipOpening } from "@/components/flagship/FlagshipOpening";
import { FlagshipVisit } from "@/components/flagship/FlagshipVisit";
import { FlagshipClose } from "@/components/flagship/FlagshipClose";
import s from "./page.module.css";

export default function Home() {
  return (
    <>
      <FlagshipOpening />
      <FlagshipVisit />

      <div data-mu-marquee="" aria-hidden="true" />

      <section id="services" className={s.start} aria-labelledby="start-here">
        <div className={`wrap ${s.careLayout}`}>
          <h2 id="start-here" className={`h-support ${s.startHead}`} data-mu-reveal="">{site.servicesLabel}</h2>
          <div>
            <p className="mu-count-line"><span data-mu-count="">{site.servicesCount}</span> {site.servicesNoun} listed</p>
            <PreviewServices listClass={s.needs} itemClass={s.need} labelClass={s.needLabel} answerClass={s.needAnswer} />
          </div>
        </div>
      </section>

      <section className={s.facts} aria-labelledby="find-us">
        <div className={`wrap ${s.factsGrid}`}>
          <div className={s.factsWhere} data-mu-reveal="">
            <h2 id="find-us" className="h-support">Where to find us</h2>
            <address className={s.address}>
              {site.address.line1}<br />
              {site.address.suburb}
            </address>
            <p className={s.findNote}>{site.hoursNote}</p>
            <p className={s.findActions}>
              <a href={site.phoneHref} className="textlink"><Phone size={15} /> {site.phone}</a>
            </p>
            <p className={s.findActions}>
              <a href={site.emailHref} data-mu-optional="email" className="textlink">{site.email}</a>
            </p>
          </div>
        </div>
      </section>

      <FlagshipClose openDays={0} />
    </>
  );
}
