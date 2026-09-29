# Lead source: what we use and why

## Decision
**Primary:** the CRM's existing Open-data (OpenStreetMap) discovery plus **manual verification of each practice's own website** before it goes on a call list. That's how the 16 practices in `prospects.csv` were produced.
**Google Places API:** use **only at call time, to look up a practice live** (hours, current phone), storing nothing but the `place_id`. **Don't import Places data into the CRM.**
**Never:** scrape Google Maps, bulk-harvest directories, or mark a business "no website" because an automated search found nothing.

## Why (evidence in `research/pricing-and-sources.md`)
- Google Maps Platform Service Specific Terms (Places, §5.3–5.4; archived 2024-04-22 wording, **re-check the live page before relying on it**) allow storing **place_id indefinitely** and caching lat/lng for **30 days**. Other content must not be pre-fetched, cached or stored, and Places content must not be used with a non-Google map. A permanent CRM of Places names, phones and ratings falls outside those exceptions.
- OpenStreetMap data is ODbL. It's fine to use with attribution, but if we ever *publish* a derived database, share-alike applies. An internal CRM isn't a published database.
- Automated absence is unreliable. On 27 Sep, 74 of the 95 dental "audit pending" leads turned out to be real sites the crawler couldn't load (bot protection or timeout). Only 21 were genuine "nothing found", and those still need a human Google check.

## Current CRM state (verified read-only 27 Sep)
- 963 leads total; 379 dental (24 excluded as chains or duplicates).
- 95 dental in the audit queue: 21 "no website found", 74 unreachable real sites. 76 bot-protected overall (36 dental). *(The handoff's "140" and "20" are out of date.)*
- **Lead #252** ("Dental Surgery"): the website on file, `dental.com.au`, is a **dental-research charity**, not the practice. **Wrong. Fix it before any call.**
- **Lead #285** (Golden Smile Denture Clinic, St Marys): the website on file is **correct**. It's priority 1 in the call list.

## The manual check (2 minutes per practice)
1. Open the practice's site. Do the name and address match? Is it an independent practice, not a chain?
2. Note one specific, visible thing (no callback form, phone-only after hours, a broken HTTPS padlock, no mobile layout, a copyright of 2015).
3. Note the public business number and contact route. No personal mobiles.
4. Record the source and date in the CRM.

## Paid alternatives considered
- **Places API at scale:** not needed; the storage terms block the CRM use anyway.
- **Licensed Australian B2B lists:** none with a published price found; there's no case for buying one at our volume.
- **ABN Lookup (government, free):** useful to confirm that a practice is a real, registered entity. Consider it later.
