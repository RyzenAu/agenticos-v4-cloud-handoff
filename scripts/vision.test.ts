import { describe, expect, test } from "bun:test";
import { parseVisionRequest, screenIntent } from "./vision";
import { floatToWav, frameDifference } from "../src/lib/screen-share";

describe("screen vision", () => {
  test("request validation", () => {
    expect(parseVisionRequest({ image: "data:image/jpeg;base64,QUJD", question: " what's this? " })).toEqual({ image: "QUJD", mime: "image/jpeg", question: "what's this?", context: undefined });
    expect(parseVisionRequest({ image: "QUJD" }).question).toBe("What's on my screen?");
    expect(() => parseVisionRequest({ image: "not base64!!" })).toThrow();
    expect(() => parseVisionRequest({ question: "hi" })).toThrow();
    expect(() => parseVisionRequest({ image: "A".repeat(6_000_000) })).toThrow("too large");
    expect(parseVisionRequest({ image: "QUJD", mime: "text/html" }).mime).toBe("image/jpeg");
  });
  test("change detection and audio encoding", () => {
    const a = new Uint8ClampedArray([10, 10, 10, 10]);
    expect(frameDifference(a, new Uint8ClampedArray([10, 10, 10, 10]))).toBe(0);
    expect(frameDifference(a, new Uint8ClampedArray([30, 30, 30, 30]))).toBe(20);
    const wav = floatToWav(new Float32Array([0, 0.5, -0.5, 1]), 16000);
    expect(Buffer.from(wav.slice(0, 4)).toString()).toBe("RIFF");
    expect(wav.length).toBe(44 + 8);
  });
});

describe("screen questions route to the eyes", () => {
  test("look and listen", () => {
    expect(screenIntent("Jarvis, what's on my screen?")).toEqual({ question: "Jarvis, what's on my screen?", listen: false });
    expect(screenIntent("what's wrong with this page")?.listen).toBe(false);
    expect(screenIntent("where do I click to publish")?.listen).toBe(false);
    expect(screenIntent("what did they just say")?.listen).toBe(true);
    expect(screenIntent("summarise this video")?.listen).toBe(true);
  });
  test("everything else is left alone", () => {
    expect(screenIntent("open my inbox")).toBeNull();
    expect(screenIntent("click the first video")).toBeNull();
    expect(screenIntent("what's on my calendar")).toBeNull();
  });
});