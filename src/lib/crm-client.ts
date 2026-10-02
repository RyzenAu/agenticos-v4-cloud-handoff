/** Browser transport for the same typed CRM operations used by Jarvis. No mutation retry
 * after a network failure: persistence may have succeeded even if its receipt was lost. */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CrmSnapshot } from "../../scripts/crm/types";
import type { CrmOperationInputMap } from "../../scripts/crm/ops";
export type { CrmOperationInputMap } from "../../scripts/crm/ops";
export type CrmOperationName = keyof CrmOperationInputMap;
import { useStreamInvalidate } from "./use-activity";

export class CrmRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CrmRequestError";
  }
}
export type CrmReceipt<T = unknown> = { ok: boolean; text: string; href?: string; data?: T };
let tokenRequest: Promise<string> | null = null;
async function pageToken(): Promise<string> {
  tokenRequest ??= fetch("/__token", { credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok)
        throw new CrmRequestError(
          "Could not verify this browser session. Refresh and try again.",
          response.status,
        );
      const result = await response.json();
      if (typeof result.token !== "string" || !result.token)
        throw new CrmRequestError("Your browser session could not be verified.", 403);
      return result.token;
    })
    .catch((error) => {
      tokenRequest = null;
      throw error;
    });
  return tokenRequest;
}
export function resetCrmToken() {
  tokenRequest = null;
}
async function readResponse<T>(response: Response): Promise<T> {
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new CrmRequestError(
      "The CRM returned an unreadable response. Refresh to check the saved record before retrying.",
      response.status,
    );
  }
  const body = result as { error?: string; text?: string; code?: string; ok?: boolean };
  if (!response.ok || body.ok === false)
    throw new CrmRequestError(
      body.error || body.text || `CRM request failed (${response.status}).`,
      response.status,
      body.code,
    );
  return result as T;
}
export async function getCrmSnapshot(signal?: AbortSignal): Promise<CrmSnapshot> {
  const response = await fetch("/__crm/snapshot", {
    signal,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  return readResponse<CrmSnapshot>(response);
}
export async function crmOperation<T = unknown, N extends CrmOperationName = CrmOperationName>(
  name: N,
  input: CrmOperationInputMap[N],
): Promise<CrmReceipt<T>> {
  const send = async (token: string) =>
    fetch("/__crm/ops", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
      body: JSON.stringify({ name, input }),
    });
  let response: Response;
  try {
    response = await send(await pageToken());
  } catch (error) {
    if (error instanceof CrmRequestError) throw error;
    throw new CrmRequestError(
      "The connection was interrupted. Your change may have saved. Refresh and check the record before retrying; your form is still here.",
      0,
      "uncertain",
    );
  }
  // This exact rejection is before the operation runs. Only that case is safe to retry.
  if (response.status === 403) {
    const body = await response
      .clone()
      .json()
      .catch(() => null);
    if (body?.error === "Refresh this page and try again.") {
      tokenRequest = null;
      response = await send(await pageToken());
    }
  }
  return readResponse<CrmReceipt<T>>(response);
}
export const CRM_QUERY_KEY = ["crm", "snapshot"] as const;
export function useCrmSnapshot() {
  const queryClient = useQueryClient();
  useStreamInvalidate([CRM_QUERY_KEY], ["crm"]);
  const query = useQuery({
    queryKey: CRM_QUERY_KEY,
    queryFn: ({ signal }) => getCrmSnapshot(signal),
    staleTime: 15_000,
    retry: (count, error) =>
      !(error instanceof CrmRequestError && error.status >= 400 && error.status < 500) && count < 1,
  });
  useEffect(() => {
    // Other tabs and Jarvis use the same store. A visible page refreshes quietly; it
    // never replaces an open form's draft or silently updates its expected version.
    const refresh = () => {
      if (document.visibilityState === "visible")
        void queryClient.invalidateQueries({ queryKey: CRM_QUERY_KEY });
    };
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [queryClient]);
  return query;
}
export function crmErrorMessage(error: unknown): string {
  if (error instanceof CrmRequestError && (error.status === 409 || error.code === "conflict"))
    return `${error.message} Your draft has been kept. Close and reopen the editor to compare with the latest record before saving again.`;
  return error instanceof Error
    ? error.message
    : "Could not save this change. Your draft has been kept; please try again.";
}
export function downloadCsv(csv: string, filename: string) {
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
