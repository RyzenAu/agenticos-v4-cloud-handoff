// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { setVoiceScope, voiceLabels } from "./voice-scope";
import { useVoiceScope } from "./use-voice-scope";

// F-22: "Talk to Research" opened a panel that only ever said "Jarvis". The panel takes its words from voiceLabels(scope): the bot's name while a bot
// scope is active, Jarvis otherwise.
afterEach(() => setVoiceScope(null));

describe("who the voice panel says is listening", () => {
  test("a bot scope names the bot; no scope is Jarvis", () => {
    expect(voiceLabels(null)).toEqual({ who: "Jarvis", idle: "Jarvis", start: "Talk to Jarvis", scoped: false });
    expect(voiceLabels({ conversationId: "agent:usman:research", bot: "research", label: "Research" })).toEqual({ who: "Research", idle: "Talking to Research", start: "Talk to Research", scoped: true });
    expect(voiceLabels({ conversationId: "x", bot: "b", label: "  " }).who).toBe("Jarvis"); // a scope without a name never prints a blank
  });

  test("rendered with the live scope: the heading and the start button say Research while scoped, and go back to Jarvis when voice is released", async () => {
    const { window } = parseHTML("<html><body><main></main></body></html>");
    (globalThis as any).window = window;
    (globalThis as any).document = window.document;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    function Panel() {
      const w = voiceLabels(useVoiceScope());
      return (
        <div>
          <h2>{w.idle}</h2>
          <button>{w.start}</button>
        </div>
      );
    }
    const root = createRoot(window.document.querySelector("main")!);
    await act(async () => root.render(<Panel />));
    const text = () => window.document.querySelector("main")!.textContent;
    expect(text()).toBe("JarvisTalk to Jarvis");
    await act(async () => setVoiceScope({ conversationId: "agent:usman:research", bot: "research", label: "Research" }));
    expect(text()).toBe("Talking to ResearchTalk to Research");
    await act(async () => setVoiceScope(null));
    expect(text()).toBe("JarvisTalk to Jarvis");
    await act(async () => root.unmount());
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  });
});
