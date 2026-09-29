// PREVIEW TEMPLATE footer: verified details, the services list and the preview disclaimer.
import { site } from "@/data/site";
import { Wordmark } from "./Wordmark";
import { PreviewServiceLinks } from "@/components/PreviewServices";
import styles from "./Footer.module.css";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`container container--wide ${styles.top}`}>
        <div className={styles.brandCol}>
          <Wordmark tone="bone" />
          <p className={styles.tagline}>{site.tagline}</p>
          <address className={styles.address}>
            {site.office.street}
            <br />
            {site.office.suburb}
            <br />
            <a href={site.phoneHref}>{site.phone}</a>
            <br />
            <a href={site.emailHref}>{site.email}</a>
          </address>
        </div>
        <nav className={styles.col} aria-label="Services">
          <p className={styles.colHead}>Services</p>
          <PreviewServiceLinks />
        </nav>
      </div>
      <div className={`container container--wide ${styles.bottom}`}>
        <p>{site.disclaimer}</p>
      </div>
    </footer>
  );
}
