/**
 * Scrolling a page the way a person does: find the thing that actually scrolls, move it, and check by measurement that it moved.
 *
 * The old executor sent a wheel event at a fixed point and read window.scrollY. On a page whose content lives in an inner panel (an app shell,
 * a modal, a virtualised list, a news site with a scrolling article column) the window never moves, so about 4 scrolls in 10 honestly reported
 * "did not scroll". These scripts run IN the page and choose the container:
 *
 *   1. a true modal (:modal or aria-modal=true) owns the scroll: the page behind it is locked, so only the
 *      dialog's own scrollers are candidates;
 *   2. otherwise the scrollable ancestors of the element under the pointer (the middle of the screen), then of the focused element,
 *      innermost first, that still have room in the asked direction (overflow auto/scroll/overlay, scrollHeight > clientHeight);
 *   3. then the largest visible scroller anywhere on the page that covers at least a quarter of the screen (a small side list is never
 *      "the page scrolling");
 *   4. then the document itself (unless the page has locked it with overflow hidden).
 *
 * A container with no room left in that direction is skipped (so "the panel is at its bottom but the page can still scroll" scrolls the
 * page), and when EVERY scroller is at that edge the answer is a genuine boundary, not a failure. The chosen element is remembered on the
 * page (a Symbol-free window property) so the before and after readings are of the same element even if a virtualised list re-renders its rows.
 */

const COMMON = `
  const root = document.scrollingElement || document.documentElement;
  const vw = innerWidth, vh = innerHeight;
  const vis = (el) => { const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const rectOf = (el) => {
    if (el === root) return { l: 0, t: 0, r: vw, b: vh };
    const r = el.getBoundingClientRect();
    return { l: Math.max(0, r.left), t: Math.max(0, r.top), r: Math.min(vw, r.right), b: Math.min(vh, r.bottom) };
  };
  const area = (r) => Math.max(0, r.r - r.l) * Math.max(0, r.b - r.t);
  const topOf = (el) => (el === root ? Math.round(window.scrollY) : Math.round(el.scrollTop));
  const maxOf = (el) => (el === root ? Math.max(0, Math.round(root.scrollHeight - innerHeight)) : Math.max(0, Math.round(el.scrollHeight - el.clientHeight)));
  const describe = (el) => {
    if (el === root) return 'the page';
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    const role = el.getAttribute('role') ? '[' + el.getAttribute('role') + ']' : '';
    return (el.tagName.toLowerCase() + id + cls + role).slice(0, 60);
  };
`;

/** Choose the container for a scroll of `dy` pixels. Returns JSON: {kind:'move'|'edge'|'none', ...}. Remembers the element on the page. */
export function pickScrollScript(dy: number): string {
  return `(() => {
  const dy = ${Number(dy)};
  const down = dy > 0;
  ${COMMON}
  const lockedRoot = (() => {
    const h = getComputedStyle(document.documentElement).overflowY;
    const b = document.body ? getComputedStyle(document.body).overflowY : 'visible';
    const eff = h !== 'visible' ? h : b;
    return eff === 'hidden' || eff === 'clip';
  })();
  const canY = (el) => {
    if (el === root) return !lockedRoot && maxOf(root) > 1;
    const cs = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight - el.clientHeight > 1;
  };
  const room = (el) => (down ? maxOf(el) - topOf(el) > 1 : topOf(el) > 1);

  // 1. a modal owns the scroll
  const modals = [...document.querySelectorAll('dialog[open],[aria-modal="true"],[role=dialog],[role=alertdialog]')].filter((el) => {
    if (!vis(el)) return false;
    const a = area(rectOf(el));
    if (a <= 0) return false;
    let isModal = el.getAttribute('aria-modal') === 'true';
    try { isModal = isModal || el.matches(':modal'); } catch (e) {}
    return isModal; // only a TRUE modal locks the page; a big non-modal role=dialog (a cookie banner, a chat panel) leaves it scrollable
  });
  const modal = modals.length ? modals[modals.length - 1] : null;
  const scope = modal || document.body || document.documentElement;

  const all = [];
  let n = 0;
  const walk = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
  let cur = scope;
  while (cur && n < 8000) {
    n++;
    if (cur instanceof Element && cur !== root && canY(cur) && vis(cur)) {
      const r = rectOf(cur);
      if (area(r) >= 1500) all.push({ el: cur, r, a: area(r) });
    }
    cur = walk.nextNode();
  }
  const inScope = (el) => !modal || modal.contains(el);
  const chain = (start) => {
    const out = [];
    for (let e = start; e && e !== document.documentElement; e = e.parentElement) if (inScope(e) && canY(e) && vis(e)) out.push(e);
    return out;
  };
  const pe = document.elementFromPoint(Math.round(vw / 2), Math.round(vh / 2));
  const ae = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  const ordered = [];
  const add = (el) => { if (el && !ordered.includes(el) && canY(el)) ordered.push(el); };
  chain(pe).forEach(add);
  chain(ae).forEach(add);
  // Elsewhere on the page only a big scroller counts (a quarter of the screen): scrolling a small side list would look like progress it isn't.
  all.filter((x) => x.a >= 0.25 * vw * vh).sort((x, y) => y.a - x.a).forEach((x) => add(x.el));
  if (!modal) add(root);
  if (modal) add(modal);

  const pickEl = ordered.find(room);
  if (!pickEl) {
    return JSON.stringify({ kind: ordered.length ? 'edge' : 'none', scrollers: ordered.length, modal: !!modal, container: ordered[0] ? describe(ordered[0]) : null, top: ordered[0] ? topOf(ordered[0]) : 0, max: ordered[0] ? maxOf(ordered[0]) : 0 });
  }
  window.__muScrollEl = pickEl;
  const r = rectOf(pickEl);
  return JSON.stringify({
    kind: 'move', container: describe(pickEl), isRoot: pickEl === root, modal: !!modal, scrollers: ordered.length,
    top: topOf(pickEl), max: maxOf(pickEl), x: Math.round((r.l + r.r) / 2), y: Math.round((r.t + r.b) / 2),
  });
})()`;
}

/** The remembered container's position now. */
export const MEASURE_SCROLL_SCRIPT = `(() => {
  ${COMMON}
  const el = window.__muScrollEl;
  if (!el || (el !== root && !el.isConnected)) return JSON.stringify({ lost: true });
  return JSON.stringify({ top: topOf(el), max: maxOf(el) });
})()`;

/** Move the remembered container by script (a real scroll, not a synthetic wheel) when the wheel did nothing. */
export function forceScrollScript(dy: number): string {
  return `(() => {
  ${COMMON}
  const el = window.__muScrollEl;
  if (!el || (el !== root && !el.isConnected)) return JSON.stringify({ lost: true });
  if (el === root) window.scrollBy({ top: ${Number(dy)}, behavior: 'instant' });
  else el.scrollBy({ top: ${Number(dy)}, behavior: 'instant' });
  return JSON.stringify({ top: topOf(el), max: maxOf(el) });
})()`;
}

export type ScrollPick =
  | { kind: "move"; container: string; isRoot: boolean; modal: boolean; scrollers: number; top: number; max: number; x: number; y: number }
  | { kind: "edge"; scrollers: number; modal: boolean; container: string | null; top: number; max: number }
  | { kind: "none"; scrollers: number; modal: boolean; container: null; top: number; max: number };

export type ScrollMeasure = { top: number; max: number } | { lost: true };

/** What one scroll did, measured on the page. */
export type ScrollResult =
  | { kind: "moved"; container: string; before: number; after: number; max: number; via: "wheel" | "script"; modal: boolean }
  | { kind: "edge"; container: string | null; at: number; max: number; modal: boolean }
  | { kind: "none" }
  | { kind: "stuck"; container: string; before: number; after: number; max: number; modal: boolean }
  | { kind: "lost"; container: string };
