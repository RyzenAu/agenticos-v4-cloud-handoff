/**
 * Agentic OS design-system primitives. Tokens live in src/styles.css; rules
 * and recipes in docs/DESIGN-SYSTEM.md. Import from "@/components/ds".
 *
 * Buttons: use the shadcn Button from "@/components/ui/button" (re-exported
 * here) — `accent` for the one primary action, `outline`/`ghost` for the rest.
 */
export { PageHeader } from "./page-header";
export { Section } from "./section";
export { Surface } from "./surface";
export { StatTile } from "./stat-tile";
export { Sparkline } from "./sparkline";
export { Badge, StatusDot, type Tone } from "./status";
export { EmptyState } from "./empty-state";
export { Notice } from "./notice";
export { KeyValueList } from "./key-value";
export { Segmented } from "./segmented";
export { BrandMark, type Agent } from "./brand-mark";
export { fmtCount, fmtCompact, fmtPercent, fmtDate, fmtRelative } from "./format";
export { PageSkeleton } from "./page-skeleton";
export { ProgressRing, type RingTone } from "./progress-ring";
export { Disclosure } from "./disclosure";
export { ChecklistRow, type ChecklistStatus } from "./checklist-row";
export { VerdictCard, type VerdictTone } from "./verdict-card";
export { AttentionCard, type AttentionSeverity } from "./attention-card";
export { InfoTip } from "./info-tip";
export { SummaryTile, type SummaryTone } from "./summary-tile";
export { Tabs, TabPanel, type TabItem } from "./tabs";
export { NextStep } from "./next-step";
export { WidgetGrid, Widget, WidgetList, WidgetRow, WidgetEmpty, PageFoot, type WidgetSpan, type WidgetTone } from "./widget-grid";
export { Skeleton } from "@/components/ui/skeleton";
export { Button, buttonVariants } from "@/components/ui/button";
