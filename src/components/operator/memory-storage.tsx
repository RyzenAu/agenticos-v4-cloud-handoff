import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Folder, RefreshCw } from "lucide-react";
import { operatorRequest } from "@/lib/operator";
import { Button, Notice } from "@/components/ds";

type Storage = {
  path: string;
  mirrored: number;
  pending: boolean | number;
  conflicts: number;
  error?: string;
};
export function MemoryStorage() {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const storage = useQuery<Storage>({
    queryKey: ["memory-storage"],
    queryFn: () => operatorRequest("/memory/storage"),
    refetchInterval: 15000,
    retry: false,
  });
  async function copyPath() {
    try {
      await navigator.clipboard.writeText(storage.data!.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Copy the folder path shown below.");
    }
  }
  return (
    <details className="memory-storage-note">
      <summary>
        <Folder size={14} />
        <span>Saved on this computer</span>
        <small>Works with Obsidian</small>
      </summary>
      <div className="memory-storage-detail">
        <p>
          Your notes and extracted text stay in this workspace. A readable Markdown copy is kept in
          the folder below. No Obsidian account or setup is required.
        </p>
        <p>
          To use Obsidian, choose <strong>Open folder as vault</strong> and select this folder. Edit
          memories in Agentic OS; changes made in Obsidian are not imported automatically.
        </p>
        {storage.data ? (
          <>
            <code>{storage.data.path}</code>
            <div className="memory-storage-actions">
              <Button type="button" variant="outline" size="sm" onClick={copyPath}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "Copied" : "Copy folder path"}
              </Button>
              <Button
                type="button"
                variant="link"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await operatorRequest("/memory/storage/export", {});
                    await storage.refetch();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
                {busy ? "Updating…" : "Update vault"}
              </Button>
              <small>
                {storage.data.mirrored.toLocaleString()} saved
                {storage.data.pending
                  ? typeof storage.data.pending === "number"
                    ? ` · ${storage.data.pending} pending`
                    : " · Updating copies"
                  : ""}
              </small>
            </div>
            {!!storage.data.conflicts && (
              <Notice tone="info">
                {storage.data.conflicts} files were edited outside the app. Those edits are
                preserved; use the original memory in the app to compare.
              </Notice>
            )}
            {storage.data.error && <Notice tone="danger">{storage.data.error}</Notice>}
          </>
        ) : (
          <p>
            {storage.isError
              ? "Folder details could not load. Your memories remain saved in this workspace."
              : "Loading your local folder…"}
          </p>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </details>
  );
}
