import { expect, test } from "bun:test";
import { receptionistIntent } from "./jarvis-intent";
test.each([
  "receptionist status",
  "how's the receptionist",
  "is the receptionist ok",
  "is the receptionist healthy",
  "is the receptionist working",
  "is the receptionist ready to sell",
  "any receptionist calls today",
  "Hey Jarvis, receptionist status please?",
])("matches %s", (u: string) =>
  expect(receptionistIntent(u)).toEqual({ skill: "receptionist", action: "status" }),
);
test.each([
  "tell me about receptionist status and delete calls",
  "email receptionist status to Bob",
  "receptionist",
  "is the receptionist ready to sell my house",
])("anchored: %s", (u: string) => expect(receptionistIntent(u)).toBeNull());
