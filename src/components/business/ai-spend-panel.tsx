// Business → Finance → AI. Shows the same AUD figures as /usage (the /__ai_usage snapshot):
// real plan prices, live limits for every subscription account, and metered API spend. The old
// version summed locally-detected plan guesses in USD and only saw one ChatGPT account.
import { AiUsageSummary } from "@/components/ai-usage/ai-usage-summary";

export function AiSpendPanel(_props: { money?: (value: number, compact?: boolean) => string }) {
  return <AiUsageSummary title="A clear view of your AI costs" />;
}
