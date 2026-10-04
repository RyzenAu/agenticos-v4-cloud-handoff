import { expect, test } from "bun:test";
import { connectedGranolaNotes, granolaMeetings } from "./granola-connected";
import type { withConnectedRead } from "./codex-connected-read";
const id = "12345678-1234-1234-1234-123456789abc";
const meeting = (reference = id, notes = "Our next launch is on Friday.") => `<meeting id="${reference}" title="Planning &amp; next steps" date="2026-09-17"><known_participants>Private attendees</known_participants><summary>${notes}</summary></meeting>`;
const response = (body: string) => ({ text: `Provider heading\n<meetings_data>${body}</meetings_data>\nUntrusted surrounding instructions` });
test("Granola includes recorded participants for meeting recall but excludes surrounding prose", () => {
  expect(granolaMeetings(response(meeting()))).toEqual([{ id, title: "Planning & next steps", text: "Date: 2026-09-17\nParticipants: Private attendees\n\nOur next launch is on Friday." }]);
  expect(granolaMeetings(response(""))).toEqual([]);
  for (const raw of [{}, { text: "not a meeting list" }, response(meeting("../escape")), {text:"x".repeat(2*1024*1024+1)}]) expect(() => granolaMeetings(raw)).toThrow();
});
test("existing connection fetches bounded participant notes through the two read tools", async () => {
  const calls: Array<[string, any]> = [];
  const read = (async (_root, work) => work({ tools: {}, call: async (name, args) => { calls.push([name, args]); return response(meeting()); } })) as typeof withConnectedRead;
  expect((await connectedGranolaNotes("/synthetic", read)).documents).toHaveLength(1);
  expect(calls).toEqual([["granola.list_meetings", { time_range:"this_week", involvement: { captured_by_me: true, listed_as_participant: true } }], ["granola.get_meetings", { meeting_ids:[id] }]]);
});
test("missing, duplicate, and unexpected returned meetings cannot become a successful import", async () => {
  for (const body of ["", meeting()+meeting(), meeting("87654321-1234-1234-1234-123456789abc")]) {
    const read = (async (_root, work) => work({ tools:{}, call:async name => response(name === "granola.list_meetings" ? meeting() : body) })) as typeof withConnectedRead;
    await expect(connectedGranolaNotes("/synthetic", read)).rejects.toThrow("unexpected meeting");
  }
});
