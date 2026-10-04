// PREVIEW TEMPLATE footer: the practice's verified details, its services list and the preview
// disclaimer. The flagship's practice pages, team and hours columns are gone.
import { Wordmark } from "./Logo";
import { site } from "@/lib/site";
import { PreviewServiceLinks } from "./PreviewServices";
import s from "./Footer.module.css";

export function Footer({ hideHours = true }: { hideHours?: boolean }) {
  return (
    <footer className={s.footer}>
      <div className={`wrap ${s.grid} ${hideHours ? s.noHours : ""}`}>
        <div className={s.brand}>
          <Wordmark light />
          <p className={s.blurb}>{site.tagline}.</p>
          <a href={site.phoneHref} className={s.phone}>{site.phone}</a>
          <a href={site.emailHref} data-mu-optional="email" className={s.phone}>{site.email}</a>
          <p className="small" style={{ opacity: 0.75 }}>{site.address.line1}<br />{site.address.suburb}</p>
        </div>
        <div>
          <h2 className={s.h}>{site.servicesLabel}</h2>
          <ul className={s.list}><PreviewServiceLinks /></ul>
        </div>
      </div>
      <div className={`wrap ${s.legal}`}>
        <p>{site.demoNotice}</p>
      </div>
    </footer>
  );
}
