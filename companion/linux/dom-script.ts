/**
 * The one script a computer runs in its page to list what a person (or the hub's goal loop) could press or type into. It reads
 * labels and positions only: a password field's value is never read, and a value is reduced to "has one". Bounded (80 controls,
 * 80 characters each).
 */
export const PAGE_ELEMENTS_SCRIPT = `(() => {
  const sel = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= 80) break;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const tag = el.tagName.toLowerCase();
    const t = (el.getAttribute('type') || '').toLowerCase();
    let type = 'Button';
    if (tag === 'a' || el.getAttribute('role') === 'link') type = 'Hyperlink';
    else if (tag === 'select') type = 'ComboBox';
    else if (tag === 'textarea') type = 'Edit';
    else if (tag === 'input') type = (t === 'checkbox' || t === 'radio') ? 'CheckBox' : (t === 'submit' || t === 'button' || t === 'image' || t === 'reset') ? 'Button' : 'Edit';
    const name = (el.getAttribute('aria-label') || (el.innerText || '') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || (t === 'submit' ? el.value : '') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    out.push({ type, name, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), password: t === 'password', enabled: !el.disabled, focused: el === document.activeElement, hasValue: t !== 'password' && !!el.value });
  }
  return JSON.stringify({ w: innerWidth, h: innerHeight, elements: out });
})()`;

export type PageElement = { type: string; name: string; x: number; y: number; w: number; h: number; password: boolean; enabled: boolean; focused: boolean; hasValue: boolean };
export type PageElements = { w: number; h: number; elements: PageElement[] };

/**
 * The readable text of the page in front, for the hub's research reader: the main article if the page has one, else the body, with
 * blank runs collapsed, plus the page's own links (text and address, http(s) only). Reads text only: no field values, nothing hidden.
 * The caller names an offset and a length, so a long page is read in chunks and `total` says how much there is.
 */
export function pageTextScript(offset: number, limit: number): string {
  return `(() => {
  const pick = () => {
    for (const sel of ['main', 'article', '[role=main]', '#content', '#main-content', '.main-content']) {
      const e = document.querySelector(sel);
      if (e && (e.innerText || '').trim().length > 800) return e;
    }
    return document.body;
  };
  const el = pick();
  const text = (el.innerText || '').replace(/[\\t\\u00a0]+/g, ' ').replace(/ *\\n */g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  const links = [];
  const seen = new Set();
  for (const a of el.querySelectorAll('a[href]')) {
    if (links.length >= 40) break;
    const href = a.href || '';
    if (!/^https?:/i.test(href) || seen.has(href)) continue;
    const r = a.getBoundingClientRect();
    const label = (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
    if (!label) continue;
    seen.add(href);
    links.push({ text: label, href: href.slice(0, 300) });
  }
  return JSON.stringify({ title: document.title, url: location.href, total: text.length, offset: ${Math.max(0, Math.floor(offset))}, text: text.slice(${Math.max(0, Math.floor(offset))}, ${Math.max(0, Math.floor(offset))} + ${Math.max(200, Math.min(20000, Math.floor(limit)))}), links });
})()`;
}

export type PageText = { title: string; url: string; total: number; offset: number; text: string; links: { text: string; href: string }[] };
