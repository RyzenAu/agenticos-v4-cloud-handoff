import Link from "next/link";
import { site, footerColumns } from "@/data/site";
import { Wordmark } from "./Wordmark";
import styles from "./Footer.module.css";

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className={styles.footer}>
      <div className={`container container--wide ${styles.top}`}>
        <div className={styles.brandCol}>
          <Wordmark tone="bone" />
          <p className={styles.tagline}>{site.tagline}</p>
          <address className={styles.address}>
            {site.office.street}
            <br />
            {site.office.suburb} NSW {site.office.postcode}
            <br />
            <a href={site.phoneHref}>{site.phone}</a>
            <br />
            <a href={site.emailHref} data-mu-optional="email">{site.email}</a>
          </address>
        </div>
        {footerColumns.map((col) => (
          <nav key={col.heading} className={styles.col} aria-label={col.heading}>
            <p className={styles.colHead}>{col.heading}</p>
            {col.links.map((l) => (
              <Link key={l.href} href={l.href}>
                {l.label}
              </Link>
            ))}
          </nav>
        ))}
      </div>
      <div className={`container container--wide ${styles.bottom}`}>
        <p>
          © {year} {site.name}. {site.legalLine}
        </p>
        <p className={styles.studio}>
          Designed and developed by{" "}
          <a href={site.disclosure.studio.url} target="_blank" rel="noopener noreferrer">
            {site.disclosure.studio.name}
          </a>{" "}
          as a demonstration.
        </p>
      </div>
    </footer>
  );
}
