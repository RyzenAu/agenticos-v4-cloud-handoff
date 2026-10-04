import { useId, useState } from "react";
import { EconomicsWorkbench } from "./economics-workbench";
import { NabConnection } from "../finance/nab-connection";
import { NabLedgerStatus } from "../finance/nab-ledger-status";
import { pageName } from "@/components/shell/destinations";
import { ExecutionReceipts } from "./execution-receipts";
import { ModelReceipts } from "./model-receipts";
import "./mu-operations.css";

export const OPERATIONS_SECTIONS = [
  { id: "packages", label: "Packages & margins" },
  { id: "nab", label: "NAB ledger" },
  { id: "receipts", label: "Execution receipts" },
  { id: "delivery", label: "Delivery checks" },
] as const;
export type OperationsSection = (typeof OPERATIONS_SECTIONS)[number]["id"];
/** When the hand-written Delivery checks below were last reviewed against their sources (F1-10). */
export const DELIVERY_CHECKS_AS_OF = "27 Sept 2026";

/** Catalogue, calculations, the NAB CSV ledger's status (source, as-of, row count: never rows),
 * a synthetic bank-connection demo and explicitly requested local execution metadata. */
export function MuOperations({ section: fromUrl, onSection }: { section?: OperationsSection; onSection?: (next: OperationsSection) => void } = {}) {
  const uid = useId();
  const [local, setLocal] = useState<OperationsSection>("packages");
  const section = fromUrl ?? local;
  const setSection = (next: OperationsSection) => { setLocal(next); onSection?.(next); };
  return (
    <div className="mu-operations">
      <header className="mu-operations-header">
        <div>
          <h1>{pageName("/operations")}</h1>
        </div>
        <nav aria-label="Operations links" className="mu-operations-links">
          {/* Static page built from tools/deal-desk (bun tools/deal-desk/serve.ts --build --out public/deal-desk). */}
          <a href="/deal-desk/index.html">Deal desk: price a deal and draft a quote</a>
          <a href="/receptionist">Back to Receptionist</a>
        </nav>
      </header>
      <div className="mu-operations-tabs" role="tablist" aria-label="Operations views">
        {OPERATIONS_SECTIONS.map(({ id, label }) => (
          <button
            type="button"
            role="tab"
            id={`${uid}-tab-${id}`}
            aria-controls={`${uid}-panel`}
            aria-selected={section === id}
            tabIndex={section === id ? 0 : -1}
            key={id}
            onClick={() => setSection(id)}
            onKeyDown={(e) => {
              const i = OPERATIONS_SECTIONS.findIndex((s) => s.id === section);
              const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? OPERATIONS_SECTIONS.length - 1 : null;
              if (to === null) return;
              e.preventDefault();
              const next = OPERATIONS_SECTIONS[(to + OPERATIONS_SECTIONS.length) % OPERATIONS_SECTIONS.length].id;
              setSection(next);
              document.getElementById(`${uid}-tab-${next}`)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mu-operations-content" role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${section}`}>
        {section === "packages" && <EconomicsWorkbench />}
        {section === "nab" && (
          <>
            <NabLedgerStatus />
            <details className="mu-sample-demo">
              <summary>Sample permissions demo (synthetic, not your bank)</summary>
              <NabConnection />
            </details>
          </>
        )}
        {section === "receipts" && (
          <>
            <ExecutionReceipts />
            <ModelReceipts />
          </>
        )}
        {section === "delivery" && (
          <section aria-labelledby="delivery-title">
            <h2 id="delivery-title">Before offering a service</h2>
            <p>
              Hand-written notes, last reviewed {DELIVERY_CHECKS_AS_OF}. They are not live checks: confirm
              current readiness in the linked workflow before making a promise.
            </p>
            <dl className="mu-delivery-list">
              <div>
                <dt>AI receptionist</dt>
                <dd>
                  Internal testing. Patient calls require observed booking-truth, emergency,
                  disclosure and handoff acceptance. Transfer configuration must be reviewed before
                  activation. <a href="/receptionist">Review receptionist gates</a>
                </dd>
              </div>
              <div>
                <dt>Jarvis voice</dt>
                <dd>
                  Hermes execution is blocked until its history and logging can be disabled.
                  Physical microphone, speaker, interruption and desktop checks remain pending.{" "}
                  <a href="/jarvis">Open Jarvis</a>
                </dd>
              </div>
              <div>
                <dt>Models</dt>
                <dd>
                  DeepSeek, MiMo and Muse Spark completed bounded text reviews through AgenticOS and
                  Cline on 27 September. Remaining quota is unverified; the bridge does not execute
                  tools. <a href="/usage">Check usage</a>
                </dd>
              </div>
              <div>
                <dt>Website releases</dt>
                <dd>
                  Marketing, dental, property and legal design branches need their reviewed release
                  and deployment decision. <a href="/websites">Open websites</a>
                </dd>
              </div>
              <div>
                <dt>Video narration</dt>
                <dd>
                  As of {DELIVERY_CHECKS_AS_OF}: 36 originals were available and 0 of 24 planned voice
                  editions had narration. The local video gallery (127.0.0.1:3417) only opens while its
                  server is running; Work shows whether it is.{" "}
                  <a href="/work">Check on Work</a>
                </dd>
              </div>
              <div>
                <dt>NAB</dt>
                <dd>
                  Bank data comes from a NAB CSV export imported on the Finance page, into one
                  shared ledger shown as "NAB CSV imported, as of" its date. It is not a live bank
                  feed: a live connection (Basiq) is deferred by owner decision and would need
                  provider eligibility, scoped owner approval and bank-hosted consent.{" "}
                  <a href="/finance">Open Finance</a>
                </dd>
              </div>
              <div>
                <dt>Leads and follow-up</dt>
                <dd>
                  The dated 28 September call plan needs current readiness and contact checks before
                  use. Prepared client drafts remain unsent until explicitly approved.{" "}
                  <a href="/leads">Review leads and evidence</a> ·{" "}
                  <a href="/business">Review business tasks</a>
                </dd>
              </div>
            </dl>
          </section>
        )}
      </div>
    </div>
  );
}
