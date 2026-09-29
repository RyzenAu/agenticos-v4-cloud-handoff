import Image from "next/image";
import { site } from "@/lib/site";
import { Arrow, Phone } from "@/components/Icons";
import { ScrollScene } from "./ScrollScene";
import s from "./FlagshipClose.module.css";

/* PREVIEW TEMPLATE: the flagship's closing scene with the practice's own name and number. */
export function FlagshipClose({ openDays }: { openDays: number }) {
  void openDays;
  return (
    <ScrollScene as="section" mode="view" className={s.close} aria-labelledby="last">
      <div className={s.media} aria-hidden="true">
        <div className={s.layer} data-m='{"scale":[1.14,1,0,0.85],"y":[-30,0,0,0.85]}'>
          <Image src="/img/generated/r15/lantern-oral-care.webp" alt="" fill sizes="100vw" className={s.img} />
        </div>
      </div>
      <div className={`wrap ${s.inner}`}>
        <h2 id="last" className={s.title}>Talk to {site.name}.</h2>
        <div className={s.actions}>
          <a href="#find-us" className="btn btn--lg">Find the practice <span className="arrow"><Arrow /></span></a>
          <a href={site.phoneHref} className={s.phone}><Phone size={17} /> {site.phone}</a>
        </div>
        <p className={s.cap}>Illustrative image, AI-generated for this preview. Not {site.namePossessive} premises, staff or patients.</p>
      </div>
    </ScrollScene>
  );
}
