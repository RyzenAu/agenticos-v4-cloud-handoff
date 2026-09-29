import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowUpRight, Blocks, CalendarDays, Mail, Radio, Video, Wallet } from "lucide-react";
import { operatorRequest, useOperator, type OperatorSettings } from "@/lib/operator";
import { Notice, Panel } from "./ui";
import { drilldownFor, pageName } from "@/components/shell/destinations";
export function OperatorPreferences() {
  const { state, refresh } = useOperator(),
    [error, setError] = useState("");
  async function toggle(key: keyof OperatorSettings) {
    try {
      await operatorRequest("/settings", { [key]: !state.settings[key] });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="op-page" style={{ marginBottom: 35 }}>
      {error && <Notice error>{error}</Notice>}
      <div className="op-settings-grid">
        <Panel>
          <div className="op-panel-title">
            <div>
              <h2>Make it your workspace.</h2>
              <small>Keep the useful things. Tuck everything else away.</small>
            </div>
            <Blocks size={18} className="op-muted" />
          </div>
          {(
            [
              // Name and description come from the sidebar's own table (one label, one description).
              { id: "mission", title: drilldownFor("/dashboard")!.label, text: drilldownFor("/dashboard")!.purpose },
              { id: "openclaw", title: drilldownFor("/agents/openclaw")!.label, text: drilldownFor("/agents/openclaw")!.purpose },
            ] as const
          ).map((t) => (
            <div className="op-setting" key={t.id}>
              <div>
                <h3>{t.title}</h3>
                <p>{t.text}</p>
              </div>
              <button
                className="op-switch"
                role="switch"
                aria-label={t.title}
                aria-checked={state.settings[t.id]}
                onClick={() => toggle(t.id)}
              >
                <span />
              </button>
            </div>
          ))}
          <div className="op-setting-links">
            <Link to="/dashboard">{pageName("/dashboard")} ↗</Link>
            <Link to="/usage">{pageName("/usage")} ↗</Link>
            <Link to="/skills">{pageName("/skills")} ↗</Link>
            <Link to="/codegraph">{pageName("/codegraph")} ↗</Link>
          </div>
        </Panel>

      </div>
    </div>
  );
}
