// J-fix: M&U's own site from the known list; screen hands never explores a window-focus goal or a drifting click.
import { describe, expect, test } from "bun:test";
import { ownSiteIn, ownSiteUrl } from "../../src/lib/own-sites";
import { driftClick, vagueScreenGoal } from "../screen-hands/refusals";
import { openedWhereLine } from "./windows";

describe("our own site is muventures.com.au", () => {
  test("by the names he uses", () => {
    for (const s of ["Can you go to MU Ventures main website?", "open our website", "pull up muventures", "go to the M&U Ventures site", "open M and U Ventures website please", "open the mu ventures website"])
      expect(ownSiteIn(s)?.url).toBe("https://muventures.com.au/");
    for (const s of ["go to our website and change the pricing", "what's on our website", "open YouTube", "open muventures dot com slash careers and apply"]) expect(ownSiteIn(s)).toBeNull();
  });
  test("a guessed .com is corrected, path kept; anything else unchanged", () => {
    expect(ownSiteUrl("https://muventures.com/")).toBe("https://muventures.com.au/");
    expect(ownSiteUrl("https://www.muventures.com/about?x=1")).toBe("https://muventures.com.au/about?x=1");
    expect(ownSiteUrl("https://example.com/")).toBe("https://example.com/");
  });
  test("the opened line says where", () => {
    expect(openedWhereLine("muventures.com.au", "Google Chrome is on your main screen now, sir.")).toBe("Opened muventures.com.au in Chrome on your main screen.");
    expect(openedWhereLine("muventures.com.au", "Google Chrome is up on your main screen, sir.")).toBe("Opened muventures.com.au in Chrome on your main screen.");
    expect(openedWhereLine("muventures.com.au", "Google Chrome is up on your main screen, sir, but Windows wouldn't put it in front: it's flashing in the taskbar.")).toMatch(/wouldn't bring it to the front/);
    expect(openedWhereLine("muventures.com.au", null)).toBe("Opened muventures.com.au in Chrome, but I couldn't bring its window to the front.");
  });
});

describe("screen hands: no exploring for window focus, no drifting clicks", () => {
  test("vague goals ask instead of running", () => {
    for (const g of ["focus muventures.com", "bring up the MU Ventures site", "bring it to the front", "switch to Spotify", "go to example.com", "show me Chrome", "pull up the website"]) expect(vagueScreenGoal(g)).not.toBeNull();
    for (const g of ["click Submit", "type hello in the Name field", "open the File menu", "go to settings and turn on dark mode", "scroll down", "show me how to export"]) expect(vagueScreenGoal(g)).toBeNull();
  });
  test("a result about something else is drift; a matching result or a plain button isn't", () => {
    expect(driftClick("focus muventures.com", { type: "Hyperlink", name: "Gary Benerofe, GP at Mu Ventures, on th…" })).toBe(true);
    expect(driftClick("play the lo-fi mix", { type: "Hyperlink", name: "Cooking pasta at home - YouTube 1.2M views 3 weeks ago" })).toBe(true);
    expect(driftClick("play the lo-fi mix", { type: "Hyperlink", name: "lo-fi mix to study - YouTube 3M views" })).toBe(false);
    expect(driftClick("submit the form", { type: "Button", name: "Search" })).toBe(false);
  });
});
