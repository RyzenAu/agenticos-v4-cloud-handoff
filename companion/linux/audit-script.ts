/**
 * The in-page read for the website audit (page.audit): ONE expression, run in the page, that returns a JSON string. It only READS: it never
 * clicks, types, submits or follows a link, and it never returns what a person typed into a field. Forms are counted, not touched.
 *
 * What it measures (all in the viewport the audit set, so desktop and mobile are separate reads):
 *   - the page: title, language, viewport meta, heading outline, horizontal overflow (a page wider than the screen is a mobile defect)
 *   - links: visible links (text, absolute address, size, same-site or not) and the tel: and mailto: ones
 *   - controls: tap targets under 32 px on a side (the smaller of width and height), buttons or links with no readable name
 *   - images: how many, how many have no alt text, how many failed to load
 *   - text: the smallest text in use (under 12 px is hard to read on a phone) and how much of it is that small
 *   - forms: how many, and fields that have no label or aria-label (placeholder text alone is not a label)
 *   - the call to action: is there a visible "book / contact / call / quote / enquire" control, and is it on the first screen
 * Contrast and keyboard order are NOT measured here; the report says so.
 */
export const AUDIT_SCRIPT = String.raw`(() => {
  const out = { ok: true };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;
  };
  const clean = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const vw = window.innerWidth, vh = window.innerHeight;
  out.title = clean(document.title, 160);
  out.lang = clean(document.documentElement.lang, 12);
  const vp = document.querySelector('meta[name="viewport"]');
  out.viewportMeta = vp ? clean(vp.getAttribute("content"), 80) : "";
  out.url = location.href.slice(0, 160);
  out.viewport = { w: vw, h: vh };
  out.scrollWidth = document.documentElement.scrollWidth;
  out.overflowX = Math.max(0, document.documentElement.scrollWidth - vw);
  out.pageHeight = document.documentElement.scrollHeight;
  out.h1 = document.querySelectorAll("h1").length;
  out.headings = [...document.querySelectorAll("h1,h2,h3")].filter(vis).slice(0, 14).map((h) => h.tagName.toLowerCase() + ": " + clean(h.textContent, 60));
  const links = [...document.querySelectorAll("a[href]")];
  const origin = location.origin;
  out.links = [];
  let noName = 0;
  for (const a of links) {
    if (!vis(a)) continue;
    let href = "";
    try { href = new URL(a.getAttribute("href"), location.href).href; } catch { continue; }
    const text = clean(a.innerText || a.getAttribute("aria-label") || a.title || (a.querySelector("img") && a.querySelector("img").alt) || "", 50);
    if (!text) noName++;
    const r = a.getBoundingClientRect();
    out.links.push({ text, href: href.slice(0, 120), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top + window.scrollY), sameSite: (() => { try { return new URL(href).origin === origin; } catch { return false; } })() || (location.protocol === "file:" && href.startsWith("file:")) });
    if (out.links.length >= 30) break;
  }
  out.linksWithoutName = noName;
  out.tel = links.some((a) => /^tel:/i.test(a.getAttribute("href") || ""));
  // tap targets: interactive controls whose smaller side is under 32 px
  const controls = [...document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,[role=button],summary")].filter(vis);
  const small = controls.filter((el) => { const r = el.getBoundingClientRect(); return Math.min(r.width, r.height) < 32; });
  out.controls = controls.length;
  out.smallTargets = small.length;
  out.smallTargetSamples = small.slice(0, 5).map((el) => { const r = el.getBoundingClientRect(); return clean(el.innerText || el.getAttribute("aria-label") || el.tagName, 40) + " (" + Math.round(r.width) + "x" + Math.round(r.height) + ")"; });
  const noNameControls = controls.filter((el) => !clean(el.innerText || el.getAttribute("aria-label") || el.title || el.value || (el.querySelector && el.querySelector("img") && el.querySelector("img").alt) || "", 5) && el.tagName !== "INPUT" && el.tagName !== "SELECT" && el.tagName !== "TEXTAREA");
  out.controlsWithoutName = noNameControls.length;
  // images
  const imgs = [...document.querySelectorAll("img")];
  out.images = imgs.length;
  out.imagesNoAlt = imgs.filter((i) => !i.hasAttribute("alt")).length;
  out.imagesBroken = imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute("src")).length;
  out.brokenImageSamples = imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute("src")).slice(0, 3).map((i) => clean(i.getAttribute("src"), 80));
  // text size
  let smallest = 999, smallCount = 0, textEls = 0;
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let n = 0;
  while (walker.nextNode() && n++ < 4000) {
    const t = walker.currentNode;
    if (!t.nodeValue || t.nodeValue.trim().length < 3) continue;
    const el = t.parentElement;
    if (!el || seen.has(el) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName) || !vis(el)) continue;
    seen.add(el);
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (!fs) continue;
    textEls++;
    if (fs < smallest) smallest = fs;
    if (fs < 12) smallCount++;
  }
  out.smallestText = smallest === 999 ? null : Math.round(smallest * 10) / 10;
  out.smallTextElements = smallCount;
  out.textElements = textEls;
  // forms (counted, never touched)
  const forms = [...document.querySelectorAll("form")];
  out.forms = forms.length;
  const fields = [...document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea")].filter(vis);
  out.fields = fields.length;
  out.fieldsNoLabel = fields.filter((f) => !(f.getAttribute("aria-label") || f.getAttribute("aria-labelledby") || (f.id && document.querySelector('label[for="' + CSS.escape(f.id) + '"]')) || f.closest("label"))).length;
  // call to action
  const cta = controls.filter((el) => /\b(book|appointment|contact|call|quote|enquir|get started|request|schedule|visit)/i.test(clean(el.innerText || el.getAttribute("aria-label") || "", 60)));
  out.cta = cta.slice(0, 4).map((el) => { const r = el.getBoundingClientRect(); return { text: clean(el.innerText || el.getAttribute("aria-label"), 40), top: Math.round(r.top), aboveFold: r.top >= 0 && r.top < vh }; });
  out.ctaAboveFold = out.cta.some((c) => c.aboveFold);
  out.hasNav = !!document.querySelector("nav, [role=navigation]");
  return JSON.stringify(out);
})()`;
