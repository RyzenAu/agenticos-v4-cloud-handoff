import { ChevronDown, Coins } from "lucide-react";
import { CURRENCIES } from "@/lib/currency";

/**
 * The Business currency, as one small chip that shows the current code. The full list opens on
 * click: a native select laid invisibly over the chip, so the keyboard, screen readers and phones
 * get their own picker. Every currency stays in the list.
 */
export function CurrencyChip({ selected, showing, onChange }: { selected: string; showing: string; onChange: (code: string) => void }) {
  const name = CURRENCIES.find((c) => c.code === selected)?.name ?? selected;
  return (
    <label className="biz-currency" title={`Currency: ${name}`}>
      <Coins size={14} aria-hidden="true" />
      <span className="biz-currency-code" aria-hidden="true">{selected}</span>
      <ChevronDown size={14} aria-hidden="true" />
      <select aria-label="Business currency" value={selected} onChange={(e) => onChange(e.target.value)}>
        {CURRENCIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.code} · {c.name}
          </option>
        ))}
      </select>
      {showing !== selected && <small>Showing {showing} while rates load</small>}
    </label>
  );
}
