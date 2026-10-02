import { useQuery } from "@tanstack/react-query";
import { Badge, Button, EmptyState, Notice, Section, Surface } from "@/components/ds";
import { crmHref } from "@/lib/crm-links";
import { fmtDateTime, fmtMoneyCents } from "@/lib/format";
import { useCrmInvalidation } from "@/lib/crm-client";
import type {
  CrmFinanceLink,
  CrmFinanceLinks,
  CrmFinanceStatus,
} from "../../../scripts/crm/finance";
import { ExternalLink } from "./controls";

const STATUS: Record<CrmFinanceStatus, string> = {
  draft: "Draft",
  open: "Open",
  paid: "Paid",
  uncollectible: "Uncollectible",
  void: "Void",
  unknown: "Unknown",
};

async function readFinanceLinks(companyId: string, signal: AbortSignal): Promise<CrmFinanceLinks> {
  const response = await fetch(`/__crm/finance?companyId=${encodeURIComponent(companyId)}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok)
    throw new Error(
      "Could not read this company's Finance links. Check your workspace connection and retry.",
    );
  const body = await response.json();
  if (!body || body.source !== "finance-stripe-snapshot" || !Array.isArray(body.links))
    throw new Error(
      "Finance returned an unreadable snapshot. Open Finance to check its invoice import, then retry.",
    );
  return body;
}

function InvoiceRow({ link }: { link: CrmFinanceLink }) {
  return (
    <li className="min-w-0 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <a
            className="ds-interactive break-words rounded font-medium underline decoration-border-strong underline-offset-4"
            href={crmHref({ kind: "document", id: link.documentId })}
          >
            {link.documentTitle}
          </a>
          {link.invoiceId && (
            <p className="mt-1 break-all text-xs text-muted-foreground">
              Finance invoice {link.invoiceNumber || link.invoiceId}
            </p>
          )}
        </div>
        <Badge
          tone={
            link.status === "unknown" || link.stale
              ? "warn"
              : link.status === "paid"
                ? "success"
                : "info"
          }
        >
          {link.stale && link.state === "linked" ? "Last recorded: " : "Finance status: "}
          {STATUS[link.status]}
        </Badge>
      </div>
      {link.state === "linked" && link.currency && (
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Recorded paid</dt>
            <dd className="mt-1">
              {fmtMoneyCents(link.amountPaidCents, { currency: link.currency })}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Recorded remaining</dt>
            <dd className="mt-1">
              {fmtMoneyCents(link.amountRemainingCents, { currency: link.currency })}
            </dd>
          </div>
        </dl>
      )}
      {link.requirement && <p className="mt-3 text-sm text-muted-foreground">{link.requirement}</p>}
      <p className="mt-3 text-xs text-muted-foreground">
        Existing Finance · Stripe snapshot ·{" "}
        {link.asOf
          ? `${link.stale ? "Stale · " : ""}As of ${fmtDateTime(link.asOf, { year: true, timeZone: "Australia/Sydney" })} Sydney`
          : "Snapshot time unknown"}
      </p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        {link.externalUrl && <ExternalLink href={link.externalUrl}>Saved invoice</ExternalLink>}
        {link.dealId && (
          <a
            className="ds-interactive rounded text-sm underline decoration-border-strong underline-offset-4"
            href={crmHref({ kind: "deal", id: link.dealId }, "deals")}
          >
            Linked deal
          </a>
        )}
      </div>
    </li>
  );
}

export function CrmFinancePanel({ companyId }: { companyId: string }) {
  const queryKey = ["crm", "finance", companyId] as const;
  useCrmInvalidation([queryKey]);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => readFinanceLinks(companyId, signal),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });
  return (
    <Section
      title="Invoice status"
      description="Read-only links to existing Finance. Paid is the recorded invoice status; it does not confirm a bank receipt or change a deal's stage."
      actions={
        <a
          className="ds-interactive rounded text-sm underline decoration-border-strong underline-offset-4"
          href="/finance"
        >
          Open Finance
        </a>
      }
    >
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reading saved Finance invoice status…
        </p>
      ) : query.isError ? (
        <Notice
          tone="warn"
          title="Payment status unavailable"
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          }
        >
          {query.error instanceof Error
            ? query.error.message
            : "Check your workspace connection, then retry."}
        </Notice>
      ) : query.data.links.length ? (
        <>
          <Surface padding="none">
            <ul className="divide-y divide-border">
              {query.data.links.map((link) => (
                <InvoiceRow key={link.documentId} link={link} />
              ))}
            </ul>
          </Surface>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Exact hosted invoice URL matches only. Snapshots over 24 hours old are marked stale.
            </p>
            <Button
              variant="ghost"
              size="sm"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              {query.isFetching ? "Reading…" : "Refresh saved status"}
            </Button>
          </div>
        </>
      ) : (
        <EmptyState
          variant="row"
          title="No invoice references linked"
          body={
            query.data.requirement ||
            "Add an invoice-reference document with the exact hosted invoice URL from existing Finance."
          }
        />
      )}
    </Section>
  );
}
