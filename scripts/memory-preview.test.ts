// Memory cards show words, not markup (display only). Synthetic notes; nothing here is a real memory.
import { describe, expect, test } from "bun:test";
import { previewSnippet } from "../src/lib/memory-preview";

describe("previewSnippet", () => {
  test("drops YAML front-matter and shows the body", () => {
    const text = "---\nname: synthetic-note\ndescription: a fixture\ntype: reference\n---\n# Finance summary\n\nRevenue is **up** this week.";
    expect(previewSnippet(text)).toBe("Finance summary Revenue is up this week.");
  });
  test("front-matter with no body falls back to its description, then its name", () => {
    expect(previewSnippet("---\nname: jarvis-notes\ndescription: How the synthetic router picks a model\n---\n")).toBe("How the synthetic router picks a model");
    expect(previewSnippet("---\nname: only-a-name\n---")).toBe("only-a-name");
  });
  test("CRLF front-matter and a BOM are handled", () => {
    expect(previewSnippet("﻿---\r\nname: x\r\n---\r\nBody line one\r\nBody line two")).toBe("Body line one Body line two");
  });
  test("markdown markers go, the words stay", () => {
    expect(previewSnippet("## Plan\n- [ ] call **Sam**\n- see [the doc](https://example.test/x) and [[Vault note|alias]]\n> quoted `code`\n---\n1. done")).toBe(
      "Plan call Sam see the doc and alias quoted code done",
    );
  });
  test("a leading transcript label is dropped; ordinary text with a colon is kept", () => {
    expect(previewSnippet("User: Reply: ok")).toBe("Reply: ok");
    expect(previewSnippet("Note: keep this")).toBe("Note: keep this");
  });
  test("plain text is untouched, long text is cut, empty is empty", () => {
    expect(previewSnippet("Just a sentence.")).toBe("Just a sentence.");
    expect(previewSnippet("word ".repeat(200), 50).length).toBeLessThanOrEqual(51);
    expect(previewSnippet(undefined)).toBe("");
    expect(previewSnippet("")).toBe("");
  });
  test("it never throws on a lone --- and returns text it can't classify", () => {
    expect(previewSnippet("---")).toBe("");
    expect(previewSnippet("--- not front matter")).toBe("--- not front matter");
  });
  test("a leading heading that repeats the card's title is dropped from the preview (display only)", () => {
    const body = "# Finance summary\n\nRevenue is **up** this week.";
    expect(previewSnippet(body, 240, "Finance summary")).toBe("Revenue is up this week.");
    // Case, emphasis, end punctuation and heading level do not matter; front-matter is stripped first.
    expect(previewSnippet("---\nname: x\n---\n### **Finance Summary:** ##\nRevenue is up.", 240, "finance summary")).toBe("Revenue is up.");
    // Without a title (or with another one) the heading stays: nothing is dropped that isn't a repeat.
    expect(previewSnippet(body)).toBe("Finance summary Revenue is up this week.");
    expect(previewSnippet(body, 240, "Something else")).toBe("Finance summary Revenue is up this week.");
    // Only a leading heading counts: the same words later in the body, or as plain text, stay.
    expect(previewSnippet("Intro line\n# Finance summary\nMore", 240, "Finance summary")).toBe("Intro line Finance summary More");
    expect(previewSnippet("Finance summary is the topic.", 240, "Finance summary")).toBe("Finance summary is the topic.");
    // A note that is only its title keeps it (there is nothing else to show).
    expect(previewSnippet("# Finance summary", 240, "Finance summary")).toBe("Finance summary");
    // The input string itself is never modified.
    const stored = "# Finance summary\nBody";
    previewSnippet(stored, 240, "Finance summary");
    expect(stored).toBe("# Finance summary\nBody");
  });
});
