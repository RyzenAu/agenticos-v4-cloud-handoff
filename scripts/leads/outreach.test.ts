import { describe, expect, test } from "bun:test";
import { callOpener, humaniseOpenerHook } from "./outreach";

describe("outreach: humaniseOpenerHook (25 Sep 2026 owner correction — the opener read like a screen, not a sentence)", () => {
  test("strips the 'Redesign + receptionist:' prefix and naturalises up to two findings", () => {
    const hook = humaniseOpenerHook(["Redesign + receptionist: not mobile-friendly, no HTTPS", "the site isn't mobile-friendly (no viewport meta tag)", "the site isn't on HTTPS"]);
    expect(hook).toBe("your site isn't set up for phones and it doesn't have a secure https connection");
    expect(hook).not.toContain("Redesign");
    expect(hook).not.toContain(":");
  });

  test("strips a plain 'Redesign:' prefix (no receptionist combo)", () => {
    const hook = humaniseOpenerHook(["Redesign: not mobile-friendly, © 2016, LCP 7.8 s"]);
    expect(hook).toBe("your site isn't set up for phones and the copyright says 2016 — looks like it hasn't been updated in a while");
  });

  test("strips a '(maybe)' redesign prefix", () => {
    const hook = humaniseOpenerHook(["Redesign (maybe): 4.2 s load, © 2022"]);
    expect(hook).toBe("it took about 4.2 seconds to load and the copyright says 2022 — looks like it hasn't been updated in a while");
  });

  test("mentions at most 2 findings even when the verdict lists three", () => {
    const hook = humaniseOpenerHook(["Redesign: not mobile-friendly, no HTTPS, © 2016"]);
    expect(hook.split(" and ")).toHaveLength(2);
    expect(hook).not.toContain("2016");
  });

  test("naturalises a confirmed-broken homepage without repeating the raw HTTP error", () => {
    const hook = humaniseOpenerHook(["Redesign: homepage down (502 Bad Gateway)"]);
    expect(hook).toBe("your homepage was showing an error when I checked");
  });

  test("naturalises a receptionist-only verdict", () => {
    expect(humaniseOpenerHook(["Receptionist: no online booking"])).toBe("there's no way to book online");
  });

  test("a verdict with no colon-separated fragment list (no website / audit pending / not a prospect) is left as its own plain sentence", () => {
    expect(humaniseOpenerHook(["No website found"])).toBe("No website found");
    expect(humaniseOpenerHook(["Not a website prospect — decent, modern site"])).toBe("Not a website prospect — decent, modern site");
  });

  test("an unmapped fragment is still said, just plainly lowercased — never silently dropped", () => {
    expect(humaniseOpenerHook(["Redesign: some new severe signal not in the phrase table"])).toBe("some new severe signal not in the phrase table");
  });

  test("empty reasons produce an empty hook", () => {
    expect(humaniseOpenerHook([])).toBe("");
  });
});

describe("outreach: callOpener uses the humanised hook, not the raw verdict", () => {
  test("reads as a sentence a founder would actually say, never the raw 'Redesign + receptionist:' screen text", () => {
    const opener = callOpener({ name: "Dundas Dental", vertical: "dental", reasons: ["Redesign + receptionist: not mobile-friendly, no HTTPS"] });
    expect(opener).toContain("I noticed your site isn't set up for phones and it doesn't have a secure https connection.");
    expect(opener).not.toContain("Redesign");
    expect(opener).not.toMatch(/receptionist:/i);
  });

  test("no hook line at all when there are no reasons", () => {
    const opener = callOpener({ name: "Dundas Dental", vertical: "dental", reasons: [] });
    expect(opener).not.toContain("I noticed");
  });
});
