# Call forwarding guide: connecting a practice's phone to the receptionist

For M&U staff and, once tidied to remove internal notes, for clients. Explains how a practice
points calls at the receptionist **without changing their number or porting it**. The cover is
set per practice, and every option is reversible in minutes:

- **After hours** — calls outside opening hours go to the receptionist. Nothing else changes.
- **Overflow (busy / no answer)** — calls the desk can't pick up in a few rings go to the
  receptionist. The desk still answers everything it can.
- **All calls, alongside the team** (where the package includes it) — every call is answered by
  the receptionist first during the hours the practice chooses.

Each business's booking, routing and texts are set up and tested before they go live, so we
recommend starting on after-hours or overflow forwarding, then moving to all calls (where the
package includes it) once the practice is happy. We never port or change anyone's number. Every
code below is entered on the practice's own handset or online portal; nothing needs M&U's access
to their phone account.

**Where these codes come from (merged 28 Sep 2026).** This guide now uses one table, the same one
the receptionist product publishes: `D:/MU-Receptionist-wt-prompt/src/components/marketing/carrier-data.ts`
(transcribed from that repo's `docs/research/australia.md` §4). Every code was quoted from the
**carrier's own support page, checked 16 September 2026**. Nothing is derived from the GSM
standard, converted between carriers or taken from third-party sites. A code a carrier doesn't
document itself is not listed, and cases nobody could confirm are shown as unverified rather than
dropped. **A wrong code silently loses calls**: if a line isn't in these tables, don't guess —
use the handset's Settings → Call forwarding menu or the carrier's own portal, and test it with a
call before go-live. Re-check the carrier page if this guide is more than three months old.

**Not published:** `##002#` ("cancel every diversion"). It is a real GSM code and widely repeated
online, but none of Telstra, Optus or Vodafone/TPG documents it on their own Australian pages.
Cancel each diversion with that carrier's own code below.

---

## 1. Australian mobiles

Dial from the phone being forwarded, exactly as written, then press call. `<number>` is the
receptionist's number, e.g. `0485011208`.

| Carrier | No answer (overflow) | Busy (overflow) | All calls (where the package includes it) | Cancel | Ring time before forwarding | Source (checked 16 Sep 2026) |
|---|---|---|---|---|---|---|
| **Telstra mobile** | `**61*<number>*11#` | `**67*<number>*11#` | `**21*<number>*11#` | `##61#` / `##67#` / `##21#` | `**61*101*<seconds>#` (15, 20, 25 or 30); default 15 s | [Telstra: forward calls on your mobile](https://www.telstra.com.au/small-business/online-support/mobiles-devices/forward-calls-on-mobile) |
| **Optus mobile** | `**61*<number>**<ring time>#` | `**67*<number>**<ring time>#` | `**21*<number>**<ring time>#` | `##61#` / `##67#` / `##21#` | Inside the code: 05, 10, 15, 20, 25 or 30. Check a diversion with `#61#` | [Optus: manage call diversions on your mobile](https://www.optus.com.au/support/answer/manage_call_diversions_on_your_mobile_phone_1764) |
| **Vodafone mobile** | `**61*<number>#` | `**67*<number>#` | `**21*<number>#` | `#61#` / `#67#` / `#21#` | Not stated on Vodafone's page | [Vodafone Australia: managing call forwarding](https://www.vodafone.com.au/support/device/call-forwarding) |
| **TPG mobile** | `**61*<number>#` | `**67*<number>#` | `**21*<number>#` | `#61#` / `#67#` / `#21#` | `**61*121*<seconds>#` (20, 25 or 30). Check with `*#61#` | [TPG: mobile features](https://support.tpg.com.au/tpg-mobile-features) |

Note the cancel codes differ: **Telstra and Optus use a double hash (`##61#`), Vodafone and TPG a
single hash (`#61#`)**. The busy codes come from the same carrier pages and research table
(`docs/research/australia.md` §4); `carrier-data.ts` shows only the no-answer and all-calls
columns on the product site.

Recommend a **15–20 second** ring time for no answer, so the desk gets a fair chance to pick up
before overflow starts.

**Overflow setup:** set both "no answer" and "busy", pointed at the receptionist number.

**After-hours-only setup, no diversion codes needed:** many practices don't want calls diverting
during opening hours at all. If the practice's phone system already stops ringing (night mode,
closes the line) outside hours, point that "closed" behaviour at the receptionist number instead
of voicemail. This is usually a setting in their phone system or carrier portal, not a dial code.

## 2. Landlines and business phone systems

Fixed-line codes are **not** the mobile codes above, and the mobile codes won't work on a fixed
line. Dial from the line's own handset.

| Carrier and product | No answer | Busy | All calls | Cancel | Source (checked 16 Sep 2026) |
|---|---|---|---|---|---|
| **Telstra home or office line** (PSTN or NBN voice) | `*61*<number>#` | `*24*<number>#` | `*21*<number>#` | `#61#` / `#24#` / `#21#` | [Telstra: set up call forwarding on a home phone](https://www.telstra.com.au/support/internet-and-home-phone/set-up-call-forwarding-on-home-phone) |
| **Optus home or office phone** | Not documented | Not documented | Dial `*78` then the number; wait for two beeps | `#78`; wait for two beeps | [Optus: manage home phone call diversions](https://www.optus.com.au/support/answer/manage_home_phone_call_diversions_1428) |

Optus documents forwarding of **all calls only** for this product, so it suits after-hours cover
(switched on at close, off at open) or all-calls cover, not overflow.

**Unverified: direct the client to their carrier or administrator.** Don't assume any code above
carries across:
- **Telstra Business SIP, Cloud PBX or Liberate:** Telstra documents no keypad code. Forwarding is
  set in the Business SIP portal by whoever administers the plan.
- **Optus Multiline office phones:** Optus directs this to the customer's PABX maintainer. No
  self-service code is documented.
- **Vodafone and TPG fixed or business lines:** no carrier-published forwarding page was found.
- **Hosted VoIP / cloud PBX** (e.g. 3CX, RingCentral, MyNetFone): conditional forwarding is
  normally set in the provider's web admin portal ("Call Forwarding", "Answering Rules" or
  "Time-based routing"). The exact steps differ by provider: check that provider's own help pages.

## 3. What we tell the client (script)

> "You don't change your number and you don't port anything. On your phone, you set the carrier's
> forwarding so that calls in the cover you chose (after hours, or if nobody answers in [15–20]
> seconds, or the line's busy) go to our receptionist number instead. It's the same feature your
> phone already has for voicemail. If you ever want it off, you dial your carrier's cancel code
> and you're back to exactly what you have today. We'll test it together with a call before
> anything goes live."

**Never say** it changes their number, requires a SIM swap, or needs carrier approval — none of
that is true for standard conditional forwarding. **Do say** that business phone systems vary,
and that we confirm the exact steps for their line during onboarding
(`client-setup-checklist.docx` §B) rather than promising a code sight-unseen. **Always test** the
forwarding with a real call in the agreed cover before Acceptance: routing is one of the go-live
tests.

## 4. Rollback (any time, by the client, no M&U action needed)

Dial the cancel code for each condition they turned on, from the tables above for their carrier
and line type (for example `##61#` on Telstra or Optus mobile, `#61#` on Vodafone or TPG mobile,
`#21#` on a Telstra line, `#78` on an Optus home or office phone), or switch it off in the
handset menu or portal where it was set. Their phone returns to exactly what it did before,
including their own voicemail if that's what it did before. This is the same rollback described
in `01-offer.md` §"How a practice starts" and `12-closing.md`: switching forwarding off is always
the client's own, unassisted, immediate action.
