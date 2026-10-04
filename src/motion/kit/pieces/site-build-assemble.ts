import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

// Every leaf <i> is one block of the page. JS walks them in DOM order: first they appear as dashed
// wireframe outlines, then fill in as the finished page.
const b = (cls: string, extra = "") => `<i class="mu-site__b ${cls}"${extra ? ` style="${extra}"` : ""}></i>`;

export const piece: KitPiece = {
  id: "site-build-assemble",
  name: "Website assembly",
  tagline: "A wireframe builds block by block into a page",
  category: "Showcase",
  move: "Dashed wireframe blocks drop in one by one down the page, then fill with black, ink and gold from the top, finishing as a complete site. It holds, clears and rebuilds every lap.",
  reduced: "The finished page is shown, filled and still. No wireframe stage and no building.",
  useFor:
    "The websites offer: 'a page built around your business'. Works as a section graphic or a short film scene. It is a generic layout, not any client's site.",
  html: `
<figure class="mu-site" data-mu-kit="site-build-assemble" role="img" aria-label="A website wireframe assembling into a finished page">
  <div class="mu-site__chrome"><span></span><span></span><span></span><em>yourbusiness.com.au</em></div>
  <div class="mu-site__page">
    <div class="mu-site__nav">${b("mu-site__f-gold", "width:26px;height:12px")}<span class="mu-site__links">${b("mu-site__f-mut")}${b("mu-site__f-mut")}${b("mu-site__f-mut")}</span>${b("mu-site__f-gold mu-site__pill")}</div>
    <div class="mu-site__hero">
      <div class="mu-site__copy">${b("mu-site__f-gold", "width:30%;height:5px")}${b("mu-site__f-ink", "width:92%;height:15px")}${b("mu-site__f-ink", "width:64%;height:15px")}${b("mu-site__f-mut", "width:80%;height:6px")}${b("mu-site__f-mut", "width:58%;height:6px")}${b("mu-site__f-gold", "width:34%;height:16px;border-radius:99px;margin-top:4px")}</div>
      ${b("mu-site__f-img mu-site__img")}
    </div>
    <div class="mu-site__cards">${b("mu-site__f-card")}${b("mu-site__f-card")}${b("mu-site__f-card")}</div>
    ${b("mu-site__f-gold mu-site__band")}
    <div class="mu-site__foot">${b("mu-site__f-mut", "width:22%;height:6px")}${b("mu-site__f-mut", "width:14%;height:6px")}</div>
  </div>
</figure>`,
  css: `
${rootRule(
  ".mu-site",
  `  margin: 0;
  width: min(100%, 520px);
  border-radius: 14px;
  overflow: hidden;
  background: var(--mu-bg);
  box-shadow: 0 0 0 1px var(--mu-line), 0 24px 48px rgba(0, 0, 0, 0.45);
  font-family: var(--mu-sans);`,
)}
.mu-site__chrome { display: flex; align-items: center; gap: 6px; padding: 9px 12px; background: var(--mu-surface); border-bottom: 1px solid var(--mu-line); }
.mu-site__chrome span { width: 8px; height: 8px; border-radius: 50%; background: var(--mu-line); }
.mu-site__chrome em { margin-left: 10px; padding: 3px 12px; border-radius: 99px; background: var(--mu-bg); color: var(--mu-muted); font-size: 0.68rem; font-style: normal; }
.mu-site__page { display: flex; flex-direction: column; gap: 14px; padding: 16px 18px 14px; }
.mu-site__nav { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.mu-site__links { display: flex; gap: 10px; flex: 1; justify-content: center; }
.mu-site__links .mu-site__b { width: 34px; height: 6px; }
.mu-site__pill { width: 54px; height: 16px; border-radius: 99px; }
.mu-site__hero { display: grid; grid-template-columns: 1.1fr 1fr; gap: 16px; align-items: center; }
.mu-site__copy { display: flex; flex-direction: column; gap: 8px; }
.mu-site__img { height: 110px; border-radius: 10px; }
.mu-site__cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.mu-site__cards .mu-site__b { height: 46px; border-radius: 8px; }
.mu-site__band { height: 26px; border-radius: 8px; }
.mu-site__foot { display: flex; gap: 14px; }
.mu-site__b { display: block; border-radius: 4px; background: var(--f, var(--mu-line)); }
.mu-site__f-gold { --f: var(--mu-gold); }
.mu-site__f-ink { --f: var(--mu-ink); }
.mu-site__f-mut { --f: var(--mu-muted); opacity: 0.55; }
.mu-site__f-card { --f: var(--mu-raised); box-shadow: inset 0 0 0 1px var(--mu-line); }
.mu-site__f-img { --f: linear-gradient(135deg, var(--mu-gold) 0%, var(--mu-raised) 70%); }
.mu-site[data-armed] .mu-site__b {
  background: transparent;
  box-shadow: none;
  outline: 1px dashed rgba(199, 163, 90, 0.55);
  outline-offset: -1px;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 0.4s var(--mu-ease), transform 0.5s var(--mu-ease), background 0.5s var(--mu-ease), outline-color 0.5s var(--mu-ease);
}
.mu-site[data-armed] .mu-site__b[data-on] { opacity: 1; transform: none; }
.mu-site[data-armed] .mu-site__b[data-done] { background: var(--f, var(--mu-line)); outline-color: transparent; }
.mu-site[data-armed] .mu-site__f-mut[data-on] { opacity: 0.55; }
.mu-site[data-armed] .mu-site__f-card[data-done] { box-shadow: inset 0 0 0 1px var(--mu-line); }
@media (prefers-reduced-motion: reduce) {
  .mu-site[data-armed] .mu-site__b {
    background: var(--f, var(--mu-line)); outline: 0; opacity: 1; transform: none; transition: none;
  }
  .mu-site[data-armed] .mu-site__f-mut { opacity: 0.55; }
}
${PAUSE_CSS}`,
  init: IN_VIEW + `
const blocks = Array.from(root.querySelectorAll(".mu-site__b"));
if (!blocks.length) return;
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
root.setAttribute("data-armed", "");
const STEP = 200;
const FILL = 150;
const wireEnd = 500 + blocks.length * STEP + 500;
const events = [];
blocks.forEach((el, i) => events.push([500 + i * STEP, () => el.setAttribute("data-on", "")]));
blocks.forEach((el, i) => events.push([wireEnd + i * FILL, () => el.setAttribute("data-done", "")]));
const seq = muSeq(() => blocks.forEach((el) => {
  el.removeAttribute("data-on");
  el.removeAttribute("data-done");
}), events, wireEnd + blocks.length * FILL + 3000);
seq.start();
const watch = muInView(root, (on) => {
  if (on) seq.resume();
  else seq.pause();
});
if (!watch.running()) seq.pause();
return () => {
  seq.stop();
  watch.stop();
};`,
  tags: ["website", "wireframe", "build", "assemble", "page", "web design", "showcase", "websites offer"],
};
