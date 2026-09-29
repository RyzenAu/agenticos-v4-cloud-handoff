// The motion layer every one-click lead preview ships with (all three verticals), written into
// the preview as _mu/motion.js (async, so it never delays DOMContentLoaded, which the banner-offset
// safeguard waits on) with its small CSS inlined in each page's <head> by generate.ts.
//
// Modelled on the approved Bianca Brown Realty motion (brooke-draft/motion.js): scroll followed
// with inertia (about GSAP `scrub: 1`), transform/opacity/clip-path only, no library, and the
// default state is the FINAL frame, so no-JS and prefers-reduced-motion visitors get a complete,
// still page. It adds, wherever a template carries the hook:
//   data-mu-hero / data-mu-push / data-mu-lift  hero photo push-in while the copy lifts faster
//   data-mu-reveal                              one-shot rise for a heading or block
//   data-mu-stagger                             its children rise as a list (delay capped)
//   data-mu-wipe                                a photo opens with a clip-path wipe and settles
//   data-mu-drift                               a photo drifts inside its frame (inner parallax)
//   data-mu-count                               an integer counts up once, in tabular numerals
//   data-mu-marquee                             a slow band of the business's VERIFIED service names
// The marquee takes the place of the "testimonials marquee" the owner asked for: previews carry no
// reviews (none are verified, and AHPRA bars testimonials on dental sites), so it only ever shows
// services the business itself published. Its height is reserved from first paint (no layout
// shift) and fill-time CSS hides it when there are fewer than three verified services.
//
// Rules it follows (impeccable animate.md + craft-floor.md, mu-killer-site step 5): only elements
// that start below the fold are ever hidden, and only once JS is running; exponential ease-out;
// sibling stagger capped; loops stop offscreen and on hover; will-change only while scrubbing;
// React-rendered templates are never mutated through className (state lives in data-mu-s), so
// hydration and later re-renders can't fight the layer.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreviewFacts } from "./fill";

export const MOTION_DIR = "_mu";
/** Present in every page that carries the layer; generate.ts refuses a preview without it. */
export const MOTION_MARKER = "data-mu-motion";

export const MOTION_CSS = `/* M&U lead-preview motion layer. Default state = final frame. */
[data-mu-count]{font-variant-numeric:tabular-nums;display:inline-block;text-align:right}
.mu-count-line{margin:0 0 .25rem;font-size:.95rem;opacity:.78}
.mu-count-line [data-mu-count]{font-size:1.15em;font-weight:600;opacity:1}
[data-mu-marquee]{display:flex;align-items:center;height:clamp(68px,8vw,108px);overflow:hidden;position:relative;border-block:1px solid color-mix(in srgb,currentColor 14%,transparent);contain:layout paint}
html.mu-motion [data-mu-s="pre"]{opacity:0;transform:translate3d(0,28px,0)}
html.mu-motion [data-mu-s="in"]{opacity:1;transform:none;transition:opacity .7s cubic-bezier(.16,1,.3,1),transform .95s cubic-bezier(.16,1,.3,1);transition-delay:var(--mu-d,0ms)}
html.mu-motion [data-mu-wipe][data-mu-s="pre"]{opacity:1;transform:none;clip-path:inset(0 0 100% 0)}
html.mu-motion [data-mu-wipe][data-mu-s="in"]{clip-path:inset(0);transition:clip-path 1.15s cubic-bezier(.16,1,.3,1)}
html.mu-motion [data-mu-wipe][data-mu-s="pre"] img{transform:scale(1.1)}
html.mu-motion [data-mu-wipe][data-mu-s="in"] img{transform:none;transition:transform 1.8s cubic-bezier(.16,1,.3,1)}
html.mu-motion [data-mu-drift]{overflow:hidden}
@media (prefers-reduced-motion:reduce){
  [data-mu-s]{opacity:1!important;transform:none!important;clip-path:none!important}
}
`;

export const MOTION_JS = `// M&U lead-preview motion layer (scripts/lead-sites/motion.ts). Transform/opacity/clip-path only.
(function () {
  var doc = document.documentElement;
  var reduce = matchMedia("(prefers-reduced-motion: reduce)");
  var data = {};
  try { var el = document.getElementById("mu-motion-data"); data = el ? JSON.parse(el.textContent || "{}") : {}; } catch (e) { data = {}; }

  // Next.js templates hydrate after load, in interruptible slices and Suspense boundary by
  // boundary (not strictly in document order): touching React-rendered text or children before
  // React has claimed them is a hydration mismatch (React #418). Wait until EVERY hooked element
  // carries React's props key; an element gets it once its own subtree has been hydrated.
  function hydrated(cb) {
    if (!document.querySelector('script[src*="/_next/"]')) return cb();
    var hooks = Array.prototype.slice.call(document.querySelectorAll("[data-mu-marquee],[data-mu-count],[data-mu-reveal],[data-mu-hero],[data-mu-stagger],[data-mu-drift]"));
    var owned = function (el) { return Object.keys(el).some(function (k) { return k.indexOf("__reactProps") === 0; }); };
    var t0 = Date.now();
    (function wait() {
      if (hooks.every(owned) || Date.now() - t0 > 8000) setTimeout(cb, 30);
      else setTimeout(wait, 60);
    })();
  }

  // Marquee: built from the verified service names only, sized to loop seamlessly. The track
  // lives in a shadow root: React's hydration never looks inside one, so a Next template can't
  // trip over nodes it didn't render (and the band's styles can't leak into the page).
  var MQ = ".t{display:flex;flex:none;white-space:nowrap}.t.run{animation:mq var(--mu-mq-dur,50s) linear infinite}" +
    ":host([data-mu-s=off]) .t,:host(:hover) .t{animation-play-state:paused}" +
    ".i{font-size:clamp(1.35rem,3vw,2.5rem);line-height:1;letter-spacing:-.01em;padding-inline:.85em;display:inline-flex;align-items:center;gap:1.7em}" +
    ".i::after{content:'';width:.3em;height:.3em;border-radius:50%;background:currentColor;opacity:.3}" +
    "@keyframes mq{to{transform:translate3d(-50%,0,0)}}@media (prefers-reduced-motion:reduce){.t.run{animation:none}}";
  function marquees() {
    var names = (data.services || []).filter(Boolean);
    document.querySelectorAll("[data-mu-marquee]").forEach(function (box) {
      if (box.shadowRoot || names.length < 3 || !box.attachShadow) return;
      var h = document.querySelector("main h2, h2");
      if (h) { var cs = getComputedStyle(h); box.style.fontFamily = cs.fontFamily; box.style.fontWeight = cs.fontWeight; }
      var root = box.attachShadow({ mode: "open" });
      var style = document.createElement("style");
      style.textContent = MQ;
      var track = document.createElement("div");
      track.className = reduce.matches ? "t" : "t run";
      root.appendChild(style);
      root.appendChild(track);
      var half = [];
      var fill = function () { names.forEach(function (n) { var s = document.createElement("span"); s.className = "i"; s.textContent = n; track.appendChild(s); half.push(s); }); };
      fill();
      for (var guard = 0; track.scrollWidth < box.clientWidth * 1.2 && guard < 8; guard++) fill();
      var width = track.scrollWidth;
      half.slice().forEach(function (s) { track.appendChild(s.cloneNode(true)); });
      box.style.setProperty("--mu-mq-dur", Math.max(24, Math.round(width / 42)) + "s");
      if ("IntersectionObserver" in window) new IntersectionObserver(function (es) { es.forEach(function (e) { box.setAttribute("data-mu-s", e.isIntersecting ? "on" : "off"); }); }).observe(box);
    });
  }

  if (reduce.addEventListener) reduce.addEventListener("change", function () { location.reload(); });
  if (reduce.matches) { var still = function () { hydrated(marquees); }; if (document.readyState === "complete") still(); else addEventListener("load", still); return; }
  doc.classList.add("mu-motion");

  var clamp = function (v, a, b) { return Math.min(b === undefined ? 1 : b, Math.max(a || 0, v)); };
  var sine = function (t) { return 0.5 - Math.cos(Math.PI * t) / 2; };
  var TAU = 0.3; // inertia time constant, about GSAP scrub: 1
  var tracks = [];
  var cache = new Map();
  var set = function (el, prop, value) { var c = cache.get(el) || {}; if (c[prop] !== value) { el.style[prop] = value; c[prop] = value; cache.set(el, c); } };

  // One-shot reveals. Only what starts below the fold is ever hidden.
  var io = "IntersectionObserver" in window ? new IntersectionObserver(function (entries) {
    var batch = 0;
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var t = e.target;
      if (t.hasAttribute("data-mu-i")) t.style.setProperty("--mu-d", Math.min(480, batch++ * 70) + "ms");
      t.setAttribute("data-mu-s", "in");
      io.unobserve(t);
    });
  }, { rootMargin: "0px 0px -10% 0px" }) : null;
  // Counts start the moment their first pixel shows (the server-rendered number stays until then).
  var countIo = "IntersectionObserver" in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { countIo.unobserve(e.target); countUp(e.target); } });
  }) : null;

  function arm(el, listItem) {
    if (el.hasAttribute("data-mu-s")) return;
    if (listItem) el.setAttribute("data-mu-i", "");
    if (!io) return el.setAttribute("data-mu-s", "in");
    var r = el.getBoundingClientRect();
    el.setAttribute("data-mu-s", r.top > innerHeight * 0.9 ? "pre" : "in");
    io.observe(el);
  }

  function countUp(el) {
    var to = parseInt(el.getAttribute("data-mu-to") || el.textContent, 10);
    if (!(to > 0)) return;
    el.setAttribute("data-mu-to", String(to));
    el.style.minWidth = String(to).length + "ch";
    var start = 0;
    var step = function (now) {
      if (!start) start = now;
      var p = clamp((now - start) / 1100);
      el.textContent = String(Math.round(to * (1 - Math.pow(2, -10 * p))));
      if (p < 1) requestAnimationFrame(step); else el.textContent = String(to);
    };
    requestAnimationFrame(step);
  }

  function scan() {
    document.querySelectorAll("[data-mu-reveal], [data-mu-wipe]").forEach(function (el) { arm(el, false); });
    document.querySelectorAll("[data-mu-stagger]").forEach(function (list) { Array.prototype.forEach.call(list.children, function (c) { arm(c, true); }); });
    document.querySelectorAll("[data-mu-count]").forEach(function (el) {
      if (el.hasAttribute("data-mu-to")) return;
      var to = parseInt(el.textContent, 10);
      el.setAttribute("data-mu-to", String(to > 0 ? to : 0));
      if (!(to > 0) || !countIo) return;
      el.style.minWidth = String(to).length + "ch";
      if (el.getBoundingClientRect().top > innerHeight) countIo.observe(el);
    });
    marquees();
  }

  // Scroll-linked: hero push-in (photo scales in while the copy lifts faster) and photo drift.
  // Registered at start(): this script is async and may run before the body is parsed.
  function register() {
    var hero = document.querySelector("[data-mu-hero]");
    if (hero) {
      var push = hero.querySelector("[data-mu-push]");
      var lift = hero.querySelector("[data-mu-lift]");
      if (push) push.style.transformOrigin = "50% 40%";
      tracks.push({ el: hero, run: function (y, t) {
        var p = clamp((y - t.top) / Math.max(1, t.h));
        if (push) set(push, "transform", "translate3d(0," + (p * 7).toFixed(2) + "%,0) scale(" + (1 + 0.14 * sine(p)).toFixed(4) + ")");
        if (lift) { set(lift, "transform", "translate3d(0," + (-p * 18).toFixed(2) + "vh,0)"); set(lift, "opacity", (1 - clamp((p - 0.25) / 0.5)).toFixed(3)); }
      } });
    }
    document.querySelectorAll("[data-mu-drift]").forEach(function (frame) {
      var img = frame.querySelector("img");
      if (!img) return;
      tracks.push({ el: frame, run: function (y, t) {
        var p = clamp((y + innerHeight - t.top) / (t.h + innerHeight));
        set(img, "transform", "translate3d(0," + ((0.5 - p) * 10).toFixed(2) + "%,0) scale(1.12)");
      } });
    });
  }

  var measure = function () { tracks.forEach(function (t) { var r = t.el.getBoundingClientRect(); t.top = r.top + scrollY; t.h = t.el.offsetHeight; }); };
  var shown = scrollY, last = 0, raf = 0;
  var tick = function (now) {
    raf = 0;
    var dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    var goal = scrollY;
    shown += (goal - shown) * (1 - Math.exp(-dt / TAU));
    if (Math.abs(goal - shown) < 0.5) shown = goal;
    for (var i = 0; i < tracks.length; i++) tracks[i].run(shown, tracks[i]);
    if (shown !== goal) raf = requestAnimationFrame(tick); else last = 0;
  };
  var kick = function () { if (!raf && tracks.length) raf = requestAnimationFrame(tick); };

  var queued = 0;
  var start = function () {
    register();
    scan();
    measure();
    tracks.forEach(function (t) { t.run(shown, t); });
    addEventListener("scroll", kick, { passive: true });
    addEventListener("resize", function () { measure(); kick(); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { measure(); kick(); });
    // React templates render their verified services after hydration: arm them as they arrive.
    new MutationObserver(function () { if (!queued) queued = requestAnimationFrame(function () { queued = 0; scan(); measure(); }); })
      .observe(document.body, { childList: true, subtree: true });
  };
  var go = function () { hydrated(start); };
  if (document.readyState === "complete") go(); else addEventListener("load", go);
})();
`;

/** Writes _mu/motion.js into a preview (or template) folder. */
export function writeMotionAssets(dir: string) {
  mkdirSync(join(dir, MOTION_DIR), { recursive: true });
  writeFileSync(join(dir, MOTION_DIR, "motion.js"), MOTION_JS, "utf8");
}

/** The <head> additions: the layer's inline CSS and async JS (relative, so a sub-path preview works), the
 *  verified service names for the marquee, and fill-time rules that hide the marquee and the count
 *  line when there isn't enough verified content to carry them. */
export function motionHead(facts: Pick<PreviewFacts, "services">): string {
  const names = facts.services.map((s) => s.name.replace(/[<>]/g, "").trim()).filter(Boolean);
  const hide: string[] = [];
  if (names.length < 3) hide.push("[data-mu-marquee]");
  if (names.length < 1) hide.push(".mu-count-line");
  const data = JSON.stringify({ services: names }).replace(/</g, "\\u003c");
  return [
    `<style ${MOTION_MARKER}>${MOTION_CSS}</style>`,
    hide.length ? `<style data-mu-motion-fill>${hide.join(",")}{display:none!important}</style>` : "",
    `<script id="mu-motion-data" type="application/json">${data}</script>`,
    `<script src="${MOTION_DIR}/motion.js" async></script>`,
  ].join("");
}

/** Adds the motion head to one HTML page (idempotent). */
export function withMotion(html: string, facts: Pick<PreviewFacts, "services">): string {
  if (html.includes(MOTION_MARKER)) return html;
  if (!html.includes("</head>")) throw new Error("Page has no </head> to add the motion layer to.");
  return html.replace("</head>", `${motionHead(facts)}</head>`);
}
