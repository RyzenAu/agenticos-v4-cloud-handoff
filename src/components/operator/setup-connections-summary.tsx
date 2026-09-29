import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import {
  operatorRequest,
  type ConnectionDiscovery,
  type ExistingAppConnection,
} from "@/lib/operator";

export function SetupConnectionsSummary() {
  const [ready, setReady] = useState(false);
  const [, setClock] = useState(0);
  const [checking, setChecking] = useState(false);
  const qc = useQueryClient();
  useEffect(() => setReady(true), []);
  // The GET only reads the last answer (it never starts Codex or Claude, T8c); asking them is this click.
  async function check() {
    setChecking(true);
    try {
      qc.setQueryData(["setup-connections"], await operatorRequest<ConnectionDiscovery>("/setup/connections/check", {}));
    } catch {
      /* the last answer stays; the button can be pressed again */
    } finally {
      setChecking(false);
    }
  }
  const discovery = useQuery<ConnectionDiscovery>({
    queryKey: ["setup-connections"],
    enabled: ready,
    queryFn: () => operatorRequest("/setup/connections"),
    staleTime: 30000,
    retry: false,
  });
  const data = discovery.data;
  useEffect(() => {
    const remaining = Date.parse(data?.expiresAt || "") - Date.now();
    if (!Number.isFinite(remaining) || remaining < 0) return;
    const timer = window.setTimeout(
      () => setClock(Date.now()),
      Math.min(remaining + 10, 2147483647),
    );
    return () => window.clearTimeout(timer);
  }, [data?.expiresAt]);
  const fresh =
    data?.status === "available" && data.runtimeFresh && Date.parse(data.expiresAt ?? "") > Date.now();
  const available = (app: ExistingAppConnection) =>
    fresh &&
    app.callable === true &&
    app.isEnabled !== false &&
    app.runtimeEnabled !== false &&
    app.isAccessible !== false;
  const apps = (data?.apps || []).filter(app => app.harness !== "claude" && (app.observed || app.isAccessible === true)).sort((a, b) => Number(available(b)) - Number(available(a)));
  const count = apps.filter(available).length;
  return (
    <details className="ws-details ws-codex-connections">
      <summary>
        Apps through Codex{" "}
        <span>
          {discovery.isPending || checking
            ? "Checking…"
            : count
              ? `${count} available`
              : data?.status === "unchecked"
                ? "Not checked"
                : "Optional"}
        </span>
        <ChevronDown size={14} />
      </summary>
      <p className="ws-muted">
        These apps belong to Codex. Direct inbox or calendar sync needs its own connection. Other
        chat models do not inherit this access.
      </p>
      {!!apps.length && (
        <ul>
          {apps.slice(0, 6).map((app) => (
            <li key={app.id}>
              <strong>{app.name}</strong>
              <span>
                {app.isEnabled === false || app.runtimeEnabled === false
                  ? "Disabled in Codex"
                  : app.isAccessible === false
                    ? "Access unavailable"
                    : available(app)
                      ? "Available through Codex"
                      : !fresh
                        ? "Availability needs a fresh check"
                        : app.callable === false
                          ? "Not callable in this session"
                          : "Availability not checked"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!apps.length && !discovery.isPending && !checking && (
        <p className="ws-muted">
          {data?.status === "unchecked"
            ? "Not checked yet. Check now asks Codex which apps it can use."
            : discovery.isError || !fresh
            ? "Codex app availability couldn’t be checked. You can continue setup."
            : "No Codex apps were found. Connect only what you use, whenever you need it."}
        </p>
      )}
      {!!data?.detail && data.status !== "available" && data.status !== "unchecked" && <p className="ws-muted">{data.detail}</p>}
      {(apps.length > 6 || data?.truncated) && (
        <p className="ws-muted">Showing a few apps. Choose the connections you want to use below.</p>
      )}
      <button
        type="button"
        className="ws-text-button"
        onClick={() => window.dispatchEvent(new CustomEvent("agentic:accounts", { detail: { group: "work" } }))}
      >
        Choose existing connections
      </button>
      <button
        type="button"
        className="ws-text-button"
        disabled={checking}
        onClick={() => void check()}
      >
        {checking ? "Checking…" : data?.status === "unchecked" ? "Check now" : "Check again"}
      </button>
    </details>
  );
}
