/**
 * A local fixture for the website audit: a tiny SYNTHETIC clinic site (three pages) written into the computer's own working folder and opened from
 * there, so the audit can be run without any network and on a site that is not a real business. It plants known problems, so a test can say what the
 * audit must find (and a run can show it finding them):
 *
 *   index.html     no viewport meta and a fixed-width banner (a phone shows it at desktop width and scrolls sideways), a small-print navigation with
 *                  tiny tap targets, an image without alt text, and a "Book a visit" link that points at a page that does not exist (book.html)
 *   services.html  fine on purpose (so the audit does not cry wolf)
 *   contact.html   a form whose fields have no labels (placeholder text only); the form is never filled or submitted
 */
export const FIXTURE_NAME = "demo-clinic";
export const FIXTURE_ENTRY = "index.html";

const DOT = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='60'><rect width='120' height='60' fill='%232f6f5e'/></svg>";

export const FIXTURE_PAGES: Record<string, string> = {
  "index.html": `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><title>Harbour Street Clinic (synthetic demo)</title>
<style>body{margin:0;font-family:system-ui,sans-serif;color:#1d1d1b}.banner{width:1100px;background:#e7f1ed;padding:24px}
nav a{font-size:10px;margin-right:6px;color:#2f6f5e}.hero{height:1100px;padding:24px}.cta{display:inline-block;padding:12px 20px;background:#2f6f5e;color:#fff;text-decoration:none}</style></head>
<body><div class="banner"><h1>Harbour Street Clinic</h1><p>A synthetic practice site used to test the website audit.</p></div>
<nav><a href="services.html">Services</a><a href="contact.html">Contact</a><a href="book.html">Book a visit</a></nav>
<div class="hero"><img src="${DOT}" width="120" height="60"><h2>Friendly local care</h2><p>Opening hours and services are listed on the other pages.</p></div>
<p><a class="cta" href="contact.html">Contact us</a></p></body></html>
`,
  "services.html": `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Services - Harbour Street Clinic (synthetic demo)</title>
<style>body{margin:0;padding:16px;font-family:system-ui,sans-serif;font-size:16px;line-height:1.5}a.btn{display:inline-block;padding:12px 18px;background:#2f6f5e;color:#fff;text-decoration:none;border-radius:8px;margin:4px 0}</style></head>
<body><header><h1>Services</h1><nav><a class="btn" href="index.html">Home</a> <a class="btn" href="contact.html">Contact</a></nav></header>
<main><h2>Check-ups</h2><p>A standard 30 minute consultation.</p><img src="${DOT}" alt="Clinic colour block" width="120" height="60"><a class="btn" href="contact.html">Book a visit</a></main></body></html>
`,
  "contact.html": `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Contact - Harbour Street Clinic (synthetic demo)</title>
<style>body{margin:0;padding:16px;font-family:system-ui,sans-serif;font-size:16px}input,textarea{display:block;margin:8px 0;padding:10px;width:90%}button{padding:12px 18px}</style></head>
<body><h1>Contact</h1><form action="contact.html" method="post"><input type="text" placeholder="Your name"><input type="text" placeholder="Phone"><textarea placeholder="How can we help?"></textarea><button type="submit">Send</button></form><p><a href="index.html">Home</a></p></body></html>
`,
};
