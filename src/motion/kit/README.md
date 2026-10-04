# M&U motion kit

31 ready-to-use web motion pieces in M&U black and gold, built in code: plain HTML, CSS and a few lines of DOM JavaScript where a piece needs them. No frameworks, no external fonts or images, no network calls, no randomness: a piece looks and behaves the same every time and works offline. Each piece has one source file in `pieces/`, registered in `index.ts`.

Nothing in the kit imports React, a router or any server module.

## What each piece gives you

One source (`html` + `css` + optional `init`) produces three outputs, all pure string builders in `snippet.ts`:

- `htmlSnippet(piece)`: paste-anywhere HTML. A `<style>` block, the markup, and (only when the piece needs it) a small `<script>` that runs `init` on every `[data-mu-kit="<id>"]` element.
- `reactSnippet(piece)`: a Next.js `"use client"` component with the same CSS, markup and DOM code (injected with `dangerouslySetInnerHTML`, DOM code started in `useEffect` and cleaned up on unmount).
- `previewDoc(piece, { reduced })`: a locked-down preview page for a sandboxed iframe, with motion forced to Full or Reduced. Used by the Motion library's M&U kit tab.

```ts
import { KIT, kitPieceById, htmlSnippet, reactSnippet, previewDoc } from "@/motion/kit";

const piece = kitPieceById("call-flow")!;
const html = htmlSnippet(piece);     // paste into a client page
const tsx = reactSnippet(piece);     // or save as a component
const doc = previewDoc(piece, { reduced: false }); // iframe srcdoc
```

## Pasting a piece into a client site

1. Pick the piece in the Motion library (M&U kit tab) and press **Copy HTML** (or **Copy React**), or call `htmlSnippet` as above.
2. Paste where it should appear. It is self-contained: styles are scoped under the piece's own class names (`.mu-…`), so it will not restyle the rest of the page.
3. Replace the copy (see the table below). Anything marked **sample copy** is placeholder text and MUST be replaced with sourced copy (or the label removed only when the content is real and approved) before it goes on a client site.
4. Keep the reduced-motion block: every piece honours `prefers-reduced-motion: reduce` in CSS, and in script where the script animates.
5. Wire real links: buttons in the kit (e.g. `cta-pulse`, `cursor-demo-cta`) are visual. Point them at the real booking link.

## Brand tokens and recolouring

Every piece declares its own palette on its root element, from `MU_TOKENS` in `snippet.ts`, so a copied piece carries the palette with it:

| Token | Default |
|---|---|
| `--mu-bg` | `#080808` |
| `--mu-surface` | `#131313` |
| `--mu-raised` | `#1b1a18` |
| `--mu-ink` | `#f3efe6` |
| `--mu-muted` | `#a8a294` |
| `--mu-gold` | `#c7a35a` |
| `--mu-gold-hi` | `#e4c887` |
| `--mu-line` | `rgba(243, 239, 230, 0.12)` |
| `--mu-display` | `"Fraunces", Georgia, "Times New Roman", serif` |
| `--mu-sans` | `"Inter", system-ui, -apple-system, "Segoe UI", sans-serif` |
| `--mu-ease`, `--mu-ease-in-out` | the easing curves |

To recolour a piece for a client, override the variables on the piece's root (the root rule sets them, so use a more specific selector or an inline `style` on the root element):

```css
[data-mu-kit="stat-ring"] { --mu-gold: #3a7d6b; --mu-gold-hi: #6fb5a1; }
```

Some pieces use hard-coded translucent gold glows (`rgba(199, 163, 90, …)`) for soft shadows; recolouring the tokens leaves those slightly warm, so check them on the new colour.

**Fonts.** The kit loads no fonts. It names Fraunces and Inter first and falls back to Georgia and the system sans stack. Load the two fonts on the host page if you want the exact look; otherwise the fallbacks are intended and look right. The preview page loads Google Fonts for convenience only; the pieces do not.

## Playback rules every piece follows

- No `Math.random`, network, `eval` or storage. Looks identical on every load.
- `init` bodies return a cleanup function (it also disconnects the observers and removes the listeners).
- The 20 newer pieces (`call-waveform` through `cursor-demo-cta`) only run while they are on screen and the tab is visible. A shared helper (`in-view.ts`, `muInView`) is included in each piece's `init`: an `IntersectionObserver` on the root sets `data-mu-paused` when it scrolls out of view, and the CSS rule `[data-mu-kit][data-mu-paused], [data-mu-kit][data-mu-paused] *, [data-mu-kit][data-mu-paused] *::before, [data-mu-kit][data-mu-paused] *::after { animation-play-state: paused !important; }` (included in each piece's CSS) pauses every CSS animation inside it. JS loops (frames, intervals, timeout chains) stop, and restart or continue when it returns. Without `IntersectionObserver` the pieces run as before. Reduced motion is unchanged. `minutes-meter` also stops ticking when it reaches its allowance.
- Play-once pieces arm themselves with `data-armed` from script, so with JavaScript off they show their finished state.
- Sample copy is labelled on the piece itself (for example "Sample figures", "Sample review", "Illustration") and stays visible in the reduced state.

## The pieces

Loop = how long one cycle takes. "Preview replays" means the piece plays once on a real page, and the Motion library preview replays it so you keep seeing it.

| id | Category | Editable copy and values | Loop | Reduced motion | Sample copy | Browser features relied on |
|---|---|---|---|---|---|---|
| `kinetic-headline` | Type | The headline text inside the markup (one block of words). | Plays once when scrolled into view; preview replays every 4.2 s. | The words simply fade in together; no rise and no rule animation. | No | `IntersectionObserver`, `max()` / `min()` in CSS |
| `logo-sting` | Brand | The wordmark text (M &amp; U) and the word under it, in the markup. | Plays once; preview replays every 4.2 s. | The finished mark is shown at once: no draw, no tracking and no sheen. | No | `aspect-ratio` |
| `stat-ring` | Data | `data-value` and `data-max` on the root; the unit (%) and the caption in the markup. | Counts up once on scroll-in (1.4 s); preview replays every 3.8 s. | The ring and number show their final value straight away. | **Yes: replace before client use** | `aspect-ratio`, `IntersectionObserver`, `max()` / `min()` in CSS |
| `cta-pulse` | Conversion | The button label in the markup. | Continuous soft pulse (no JS). | No halo and no lean: a still button with a clear focus ring. | No | plain CSS only |
| `map-pin-drop` | Local | The business name and the walking-distance line in the card. | Plays once on scroll-in; preview replays every 5.2 s. | The map, pin and card are shown in place: no drawing, drop, bounce or ripple. | **Yes: replace before client use** | `aspect-ratio`, `IntersectionObserver`, `max()` / `min()` in CSS |
| `before-after` | Showcase | Panels hold wireframes: put your own `<img>` tags inside the two panels. | Intro glide once on scroll-in; then follows the drag. | No intro glide: it starts in the middle and still drags. | No | `clip-path`, `aspect-ratio`, `IntersectionObserver`, `max()` / `min()` in CSS |
| `testimonial-flip` | Proof | The quote, the initials, name and source in the two faces. | No loop: nudges once on scroll-in, turns on click or tap. | The faces cross-fade instead of turning, and there is no nudge. | **Yes: replace before client use** | 3D transforms (`perspective`, `preserve-3d`), `IntersectionObserver`, `max()` / `min()` in CSS |
| `device-pan` | Showcase | The screens inside the device frames: swap in your own page screenshots. | Continuous slow pan (CSS). | The screens show the top of the page, still; no pan and no tilt. | No | 3D transforms (`perspective`, `preserve-3d`), `aspect-ratio`, `max()` / `min()` in CSS |
| `lower-third` | Video | The name and the role line; `data-hold` (ms) on the root sets how long it holds. | Preview replays every 6.8 s; hold defaults to 4 s. | It fades in, holds and fades out: no growing bar and no wipes. | **Yes: replace before client use** | `clip-path`, `backdrop-filter` |
| `proof-marquee` | Proof | The proof points, one per item in the markup. | Continuous scroll (CSS). | The row doesn't move: the points wrap onto as many lines as they need. | **Yes: replace before client use** | `max()` / `min()` in CSS |
| `reveal-stagger` | Type | The three card titles and lines. | Plays once on scroll-in; preview replays every 3.6 s. | The cards are simply there: no rise, no fade and no ring drawing. | **Yes: replace before client use** | `IntersectionObserver`, `max()` / `min()` in CSS |
| `call-waveform` | Showcase | `Answered in 2 rings`, `Ringing` and the caption in the markup. Bar heights and timings are inline `--h`, `--d`, `--w` on each `<span>`. | 7 s CSS loop. | No ring flashing or breathing: the label reads Answered in 2 rings and the waveform shows as a still, shaped gold wave. | **Yes: replace before client use** | `@property`, `IntersectionObserver`, `max()` / `min()` in CSS |
| `call-flow` | Showcase | The five stage names and one-line subtitles in the `<li>` items. Stage timing is in the CSS (`mu-flow-n0..4`, 8 + 16 i % of 10 s). | 10 s CSS loop. | All five stages sit lit with the line filled and no travelling dot. | No | `IntersectionObserver`, `max()` / `min()` in CSS |
| `always-on-clock` | Data | `data-period` (ms per 24 h lap, default 16000) and `data-start-hour` (default 7) on the root; the band arcs are `<circle>` dash values in the SVG; the legend text in the markup. | Continuous JS sweep, one lap per `data-period`. | No sweep: the dial is still, with every band visible and the centre reading Front desk on, around the clock. | **Yes: replace before client use** | `aspect-ratio`, `IntersectionObserver`, `max()` / `min()` in CSS |
| `minutes-meter` | Data | `data-used` and `data-allow` (seconds) on the root, plus the static text `204:00`, `of 300 included`, `95:59 left` (the script rewrites the numbers). | Sweeps once on scroll-in (1.4 s), then ticks every second; preview replays every 9 s. | The gauge shows its used share and the figure, still: no sweep and no ticking. | **Yes: replace before client use** | `aspect-ratio`, `IntersectionObserver`, `max()` / `min()` in CSS |
| `sms-thread` | Conversion | The contact name, the three message texts and the calendar chip text in the markup. | 12 s CSS loop. | No typing dots or arrivals: the whole thread and the ticked calendar chip are shown at once. | **Yes: replace before client use** | `IntersectionObserver`, `max()` / `min()` in CSS |
| `calendar-slot-fill` | Data | Which slots fill is set by `data-n` (arrival order) on the gold slots; day and hour labels in the markup; the `12` start text. | 7.4 s JS loop (700 ms + 340 ms per slot + 2.6 s hold). | The week is shown already filled, with the final count. Nothing animates. | **Yes: replace before client use** | `IntersectionObserver`, `max()` / `min()` in CSS |
| `lead-card-stack` | Conversion | Each card's title and detail line; column is the `--c` and row `--r` custom property, arrival order `data-n`. | 7.2 s JS loop (900 ms + 650 ms per card + 3 s hold). | The cards are already sorted into their three trays. Nothing flies. | **Yes: replace before client use** | `IntersectionObserver`, `max()` / `min()` in CSS |
| `site-build-assemble` | Showcase | The URL text in the browser bar. Blocks are plain `<i>` elements; add or remove them freely. | ~10 s JS loop (wireframe 200 ms per block, fill 150 ms per block, 3 s hold). | The finished page is shown, filled and still. No wireframe stage and no building. | No | `IntersectionObserver`, `max()` / `min()` in CSS |
| `gold-foil-wordmark` | Brand | The wordmark letters, the `VENTURES` line and the `aria-label` in the markup. | 5.5 s CSS loop. | The foil is still, lit from the middle: no sweep and no drift. | No | `background-clip: text`, `color-mix()`, `IntersectionObserver`, `max()` / `min()` in CSS |
| `pricing-tier-rise` | Conversion | The three column names and the `Book a demo` label. Neutral skeleton lines carry no prices or inclusions: add approved copy only. | 8 s CSS loop. | All three columns sit in place, the middle one outlined in gold. No rising and no sweep. | **Yes: replace before client use** | `IntersectionObserver`, `max()` / `min()` in CSS |
| `missed-call-counter` | Data | `data-value` (final tally) and `data-start` on the root; the title, the per-digit `<b>` text and the note in the markup. | Ticks every 1.4 s from `data-start` to `data-value`; preview replays every 11 s. | The tally shows its final figure, still. No flipping. | **Yes: replace before client use** | 3D transforms (`perspective`, `preserve-3d`), `aspect-ratio`, `IntersectionObserver`, `max()` / `min()` in CSS |
| `voice-to-text` | Showcase | The caller line is `data-full` on `.mu-v2t__text`; the three field values in the `<dd>` items. | ~9.3 s JS loop (typing 34 ms per character, 5.2 s hold). | The transcript line and the completed message card are shown together, still. | **Yes: replace before client use** | `IntersectionObserver`, `max()` / `min()` in CSS |
| `postcode-radar` | Local | The caption. Blocks, roads and ping positions are in the SVG and the ping `left` / `top` percentages (each ping's delay is `--d`). | 6 s CSS loop (one sweep). | The radar is still: the grid, a fixed sweep wedge and every ping dot lit, with no rings. | No | `conic-gradient`, `aspect-ratio`, `IntersectionObserver`, `max()` / `min()` in CSS |
| `before-after-phone` | Showcase | The `Before` / `After`, `No answer`, `Missed call` and `Answered` labels in the markup. | 9 s CSS loop. | No ringing or morphing: the phone shows the Answered state and the After tag. | No | `aspect-ratio`, `IntersectionObserver`, `max()` / `min()` in CSS |
| `handoff-baton` | Showcase | The two node names, the caption and the three note lines in the markup. Keep the caption saying a MESSAGE is handed over. | 8 s CSS loop. | The baton rests at your team's end with the summary note and caption shown. No travel. | No | `IntersectionObserver`, `max()` / `min()` in CSS |
| `sector-carousel` | Showcase | Each card's sector name and one-line use; the `--i` index sets its place on the ring. | 10 s CSS loop (three holds). | No turning: the three cards sit side by side, flat, each with its one-line use. | No | 3D transforms (`perspective`, `preserve-3d`), `IntersectionObserver`, `max()` / `min()` in CSS |
| `checklist-tick` | Proof | The five step labels, the title and the last line in the markup. Describe your own setup process truthfully. | 11 s CSS loop. | Every step is ticked and the list shows Then we go live. Nothing animates. | **Yes: replace before client use** | `IntersectionObserver`, `max()` / `min()` in CSS |
| `review-stars-fill` | Proof | The tag text and the two skeleton lines in the markup. Add a real quote only with permission. | 7 s CSS loop. | All five stars are filled gold and still. | **Yes: replace before client use** | `clip-path`, `aspect-ratio`, `IntersectionObserver`, `max()` / `min()` in CSS |
| `night-to-day` | Showcase | The badge text `Front desk: on`. Towers and windows are `<rect>`s in the SVG. | 12 s CSS loop. | A still dusk: a gold sky, lit windows and the same Front desk: on badge. No crossing and no fade. | No | `aspect-ratio`, `IntersectionObserver`, `max()` / `min()` in CSS |
| `cursor-demo-cta` | Conversion | The button label (and make it a real link). | 6 s CSS loop. | The button sits still with no cursor and no ripple. | No | `IntersectionObserver`, `max()` / `min()` in CSS |

## Browser support notes

- `@property`: Chromium, Safari 16.4+, Firefox 128+. Without it the waveform stays fully raised for the whole loop instead of flattening while ringing.
- `clip-path`: All current browsers. Without it the shape shows as a plain box.
- 3D transforms (`perspective`, `preserve-3d`): All current browsers. Without them cards would flatten, so rely on the reduced-motion layout.
- `background-clip: text`: All current browsers (with the `-webkit-` prefix, included). Without it the letters would show as solid gold text.
- `color-mix()`: Chrome 111+, Safari 16.2+, Firefox 113+. Without it the darker foil stops are dropped and the gradient shows only the lighter golds.
- `conic-gradient`: All current browsers. Without it the radar sweep wedge is not drawn.
- `aspect-ratio`: All current browsers (2021+). Without it frames collapse to content height.
- `backdrop-filter`: Optional blur; without it the panel is simply more opaque.
- `IntersectionObserver`: All current browsers. Used to start pieces on scroll-in and (newer pieces) to pause them off-screen via `data-mu-paused`; without it they keep running.
- `max()` / `min()` in CSS: All current browsers (2020+).

All pieces were played in Microsoft Edge (Chromium) headless, full motion and reduced motion, at 375, 768 and 1280 px widths. Safari and Firefox were not tested in this pass: the notes above come from the CSS features each piece uses, not from running them there.

## Adding a piece

Create `pieces/<id>.ts` exporting `piece` (see `types.ts`), import it in `index.ts`, and run `bun --no-env-file test scripts/motion-kit.test.tsx`. File name, `id` and the `data-mu-kit` value must be the same kebab-case string. The tests enforce the brand tokens, a reduced-motion block, no network or randomness, a valid `init`, and a cleanup function wherever there are timers, observers or listeners. Use `minmax(0, 1fr)` for equal columns and keep moving elements clear of text.
