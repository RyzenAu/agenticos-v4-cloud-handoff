import { providerJson, type ProviderOptions } from "./retell";
import type { Source } from "./types";
export type TwilioFacts = {
  connected: boolean;
  trunkSid: string | null;
  balanceUsd: number | null;
  month: Source<{ usd: number; balanceUsd: number | null }>;
};
export async function fetchTwilio(
  options: ProviderOptions & { number: string },
): Promise<Source<TwilioFacts>> {
  const sid = options.providerKey("TWILIO_ACCOUNT_SID"),
    token = options.providerKey("TWILIO_AUTH_TOKEN");
  if (!sid || !token) return { ok: false, reason: "Twilio not configured" };
  const get = (url: string) =>
    providerJson(
      "Twilio",
      url,
      {
        method: "GET",
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
      },
      options.fetch ?? fetch,
    );
  const account = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}`;
  const [trunks, balance, usage] = await Promise.all([
    get("https://trunking.twilio.com/v1/Trunks"),
    get(`${account}/Balance.json`),
    get(`${account}/Usage/Records/ThisMonth.json?Category=totalprice`),
  ]);
  const numeric = (v: unknown) =>
    ((typeof v === "string" && v.trim()) || typeof v === "number") && Number.isFinite(Number(v))
      ? Number(v)
      : null;
  const balanceUsd =
    balance.ok && balance.data?.currency === "USD" ? numeric(balance.data.balance) : null;
  const prices =
    usage.ok && Array.isArray(usage.data?.usage_records)
      ? usage.data.usage_records.map((r: any) => numeric(r.price))
      : [];
  const month: TwilioFacts["month"] =
    prices.length && prices.every((p: number | null) => p !== null)
      ? { ok: true, usd: prices.reduce((a: number, b: number) => a + b, 0), balanceUsd }
      : { ok: false, reason: usage.ok ? "Twilio usage unavailable" : usage.reason };
  if (!trunks.ok) return trunks;
  if (!Array.isArray(trunks.data?.trunks))
    return { ok: false, reason: "Twilio trunk response invalid" };
  const trunk = trunks.data.trunks.find(
    (t: any) => typeof t.domain_name === "string" && t.domain_name.includes("retell"),
  );
  if (!trunk?.sid) return { ok: true, connected: false, trunkSid: null, balanceUsd, month };
  const base = `https://trunking.twilio.com/v1/Trunks/${encodeURIComponent(trunk.sid)}`;
  const [origins, numbers] = await Promise.all([
    get(`${base}/OriginationUrls`),
    get(`${base}/PhoneNumbers`),
  ]);
  if (!origins.ok) return origins;
  if (!numbers.ok) return numbers;
  if (!Array.isArray(origins.data?.origination_urls) || !Array.isArray(numbers.data?.phone_numbers))
    return { ok: false, reason: "Twilio routing response invalid" };
  const connected =
    origins.data.origination_urls.some(
      (o: any) =>
        o.enabled === true &&
        /^sips?:[^@\s]*@?sip\.retellai\.com(?::\d+)?(?:;.*)?$/i.test(o.sip_url),
    ) && numbers.data.phone_numbers.some((n: any) => n.phone_number === options.number);
  return { ok: true, connected, trunkSid: trunk.sid, balanceUsd, month };
}
