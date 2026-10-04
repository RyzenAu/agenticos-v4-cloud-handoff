import { useEffect, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { MemorySculpture } from "./memory-sculpture";
import "./memory-studio.css";

/**
 * `plain` (L2, 29 Sep): a widget in the Memory grid. The decorative sculpture gives way to the
 * widget's icon-and-title row; the capture and its drop target are unchanged.
 */
export function MemoryStudio({ capture, plain = false }: { capture: ReactNode; plain?: boolean }) {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const glow = () => {
      setSaved(true);
      clearTimeout(timer);
      timer = setTimeout(() => setSaved(false), 1800);
    };
    window.addEventListener("memory:saved", glow);
    return () => {
      window.removeEventListener("memory:saved", glow);
      clearTimeout(timer);
    };
  }, []);
  return (
    <section
      className={`memory-studio${plain ? " is-plain" : ""}${saved ? " is-memory-saved" : ""}`}
      aria-label="Add to memory"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        if ((event.target as Element).closest(".memory-capture-v5")) return;
        event.preventDefault();
        if (!event.dataTransfer.files.length) return;
        const input = event.currentTarget.querySelector<HTMLInputElement>('input[type="file"]');
        if (input && !input.disabled) {
          input.files = event.dataTransfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }}
    >
      {plain ? (
        <div className="memory-studio-head">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-inset text-muted-foreground">
            <Plus className="size-4" />
          </span>
          <h2 className="text-base font-medium text-foreground">Add to memory</h2>
        </div>
      ) : (
        <div className="memory-studio-art ds-stage">
          <MemorySculpture />
          <div className="memory-studio-caption">
            <h2>
              Add to
              <br />
              memory
            </h2>
          </div>
        </div>
      )}
      <div className="memory-studio-main">{capture}</div>
    </section>
  );
}
