import { describe, expect, test } from "bun:test";
import { browserIntent, parseActRequest, parseTarget, pickCandidate, type Candidate } from "./browser-hands";

const page: Candidate[] = [
  { i: 0, kind: "button", label: "Sign in", x: 1200, y: 20 },
  { i: 1, kind: "video", label: "Movement Only: Road to Apex Predator (The Movie)", x: 300, y: 250 },
  { i: 2, kind: "video", label: "Movement Only: Road to Apex Predator (The Movie)", x: 500, y: 250 },
  { i: 3, kind: "video", label: "Apex Predator training vlog", x: 300, y: 450 },
  { i: 4, kind: "video", label: "Parkour highlights 2026", x: 300, y: 650 },
  { i: 5, kind: "link", label: "Shorts", x: 40, y: 200 },
];

describe("what he meant", () => {
  test("ordinals and kinds", () => {
    expect(parseTarget("the first video on my screen")).toEqual({ ordinal: 1, words: "", kind: "video" });
    expect(parseTarget("second one")).toMatchObject({ ordinal: 2 });
    expect(parseTarget("the last video")).toMatchObject({ ordinal: -1, kind: "video" });
  });
  test("first video is the first distinct video, not its thumbnail twin", () => {
    expect(pickCandidate(page, "first video")?.i).toBe(1);
    expect(pickCandidate(page, "second video")?.i).toBe(3);
    expect(pickCandidate(page, "last video")?.i).toBe(4);
  });
  test("by words", () => {
    expect(pickCandidate(page, "Movement Only Road to Apex Predator")?.i).toBe(1);
    expect(pickCandidate(page, "sign in button")?.i).toBe(0);
    expect(pickCandidate(page, "parkour video")?.i).toBe(4);
    expect(pickCandidate(page, "something that isn't there")).toBeNull();
  });
  test("request validation", () => {
    expect(parseActRequest({ action: "click", target: "first video" })).toMatchObject({ action: "click", target: "first video" });
    expect(() => parseActRequest({ action: "rm -rf" })).toThrow();
    expect(parseActRequest({ action: "click", ordinal: 999 }).ordinal).toBeUndefined();
  });
});

describe("plain browser commands skip Jev (24 Sep: they went to Hermes)", () => {
  test("his phrases", () => {
    expect(browserIntent("can you navigate to the first video on my screen and click it")).toMatchObject({ action: "click" });
    expect(browserIntent("Jarvis, pause the video")).toEqual({ action: "pause" });
    expect(browserIntent("pause")).toEqual({ action: "pause" });
    expect(browserIntent("resume the video please")).toEqual({ action: "play" });
    expect(browserIntent("go back")).toEqual({ action: "back" });
    expect(browserIntent("scroll down")).toEqual({ action: "scroll_down" });
    expect(browserIntent("close this tab")).toEqual({ action: "close_tab" });
    expect(browserIntent("click the second video")).toMatchObject({ action: "click", target: "click the second video" });
    expect(browserIntent("click sign in")).toEqual({ action: "click", target: "sign in" });
  });
  test("everything else still goes through Jev and the brain", () => {
    expect(browserIntent("play some lo-fi music on YouTube")).toBeNull();
    expect(browserIntent("send Mehroz a WhatsApp saying I'm running late")).toBeNull();
    expect(browserIntent("open my inbox")).toBeNull();
    expect(browserIntent("what's on my calendar")).toBeNull();
    expect(browserIntent("stop the gateway and restart Hermes")).toBeNull();
    expect(browserIntent("go back to the dashboard")).toBeNull();
  });
});
