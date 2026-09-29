import { site } from "@/data/site";
import styles from "./Wordmark.module.css";

// PREVIEW TEMPLATE: the business's own name as plain logo text.
export function Wordmark({ tone = "ink" }: { tone?: "ink" | "bone" }) {
  return (
    <span className={`${styles.mark} ${tone === "bone" ? styles.bone : ""}`}>
      {site.name}<span className={styles.stop} aria-hidden="true" />
    </span>
  );
}
