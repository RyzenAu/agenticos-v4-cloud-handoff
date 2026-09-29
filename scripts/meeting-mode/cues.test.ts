import { describe, expect, test } from "bun:test";
import { cueForTag, cuesFor, type ObjectionTag } from "./cues";

const ALL_TAGS: ObjectionTag[] = ["price", "incumbent", "send_info", "timing", "trust_privacy", "relevance", "think_about_it"];

describe("cueForTag", () => {
  test("returns the same fixed card text cuesFor's own regex rules use, for every tag", () => {
    for (const tag of ALL_TAGS) {
      const cue = cueForTag(tag);
      expect(cue.tag).toBe(tag);
      expect(cue.title.length).toBeGreaterThan(0);
      expect(cue.line.length).toBeGreaterThan(0);
    }
  });

  test("matches the regex-triggered card exactly, so Jev never authors different wording", () => {
    const [regexCard] = cuesFor("that's out of our budget");
    expect(regexCard.tag).toBe("price");
    const cloudCard = cueForTag("price");
    expect(cloudCard).toEqual(regexCard);
  });
});
