// PREVIEW TEMPLATE: the persistent "not the official website" banner, rendered by React itself so
// hydration keeps it (a banner injected outside the tree would be wiped). Text and expiry are
// tokens filled per lead; the expiry and height behaviour comes from the safeguard script fill.ts
// adds to <head>.
export function PreviewBanner() {
  return (
    <div className="mu-preview-banner" role="note" aria-label="Preview notice" data-mu-expires="{{EXPIRES}}">
      {"{{BANNER}}"}
      <a href="https://muventures.com.au" rel="noopener">About M&amp;U Ventures</a>
    </div>
  );
}
