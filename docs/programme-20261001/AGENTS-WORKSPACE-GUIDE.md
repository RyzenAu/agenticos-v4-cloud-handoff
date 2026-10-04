# Agents workspace: how to use it (2 Oct 2026)

Open **Jarvis → Agents** (`/agents/workspace`). Pick a bot at the top: **Research** or **Builder**. The line under its name says what
it is doing right now: Ready, Working on …, Needs you, or Offline with the reason and the fix.

## Ask a bot to do something

- **Type** in the box at the bottom of any tab, or **speak**: press the mic in the workspace, or say "Ask Research to …" anywhere in
  the OS. Either way the request lands in *your* conversation with that bot. Mehroz has his own conversation with the same bot.
- The bot answers in the same conversation: "On it", then progress, then the result. You don't need to change page to follow it.
  A completion is announced once; reopening the page doesn't replay it.
- **Stop** on a running task cancels it. Steps that haven't started yet won't run.

## Watch and take over

- **Show computer** (top right of the conversation) opens the bot's computer beside the chat; drag the divider to resize it, or expand it to full width. On a tablet or phone, switch between Conversation and Computer. Press **Watch** to see the bot's live desktop. **Take over** gives you the mouse and keyboard (the bot pauses at a safe
  point). Only one person controls a shared bot computer at a time; the other sees who has it. **Return to agent** hands control back
  and the bot carries on.
- Your own personal desktop is owner-only. Mehroz can't control it, and you can't control his.
- macOS desktop control is unavailable until a companion app is enrolled on the Mac. Viewing, chat and files work from the MacBook.

## Tasks & Files

- **Tasks**: everything the bot has done or is doing. For Builder this includes Claude/Codex coding jobs with the account, model,
  tests and review result.
- **Files**: saved results from the bot's computer and coding outputs. When "save results" is on, a result is also saved to shared
  memory once per task.

## Setup

Each setting says what it changes. The useful ones:

| Setting | Effect |
|---|---|
| Instructions | Added to every computer task the bot runs (up to 8,000 characters). |
| Model route | Which existing router route its computer tasks use (Auto, Free only, or a named route). |
| Recall | Up to 5 relevant facts from shared memory go into each computer task. Coding jobs don't use this. |
| Save results | Each finished result is saved to shared memory once. |
| Routines | Existing routines that run as this bot. |
| Coding (Builder) | Which Claude/Codex account slot and model the coding jobs use. |
| Skills | Shown read-only for now. |

Two people editing at once: the second save is refused with "Changed elsewhere — reload to see the latest" instead of overwriting.

## Managing bots

- **New bot** (next to the bot names): a name, a purpose, and the computer it works on. It points at a shared computer that already exists, or none
  yet. Making a bot never makes a computer, and several bots can share one: they use that computer's one control lease, so it runs one task at a time and refuses another (there is no queue): the second bot is told to ask again when the first finishes.
  Setup > Computer names who else uses it. "Can run coding jobs" is chosen here (it needs a configured coding account) and can't be changed later.
- **Duplicate** (Setup > Copy or archive): "<name> copy" with the same purpose, instructions, computer, coding, model and memory settings. No routines,
  conversations, tasks or results come with it.
- **Archive**: hides the bot and refuses new requests ("Ask X to ..." says it is archived). Its tasks, results and conversations stay readable, and
  you can unarchive it from **Show archived** or its Setup. If it has running or waiting jobs, archiving is refused with the list; choose
  **Archive after current work** and new requests stop at once while the running jobs finish on their own. Archiving also releases the routines the bot ran as (the confirmation lists them): they stay in Automations and can be linked to another bot, and unarchiving does not link them again. The last active bot can't be archived.
- Ids and names are never reused, even by an archived bot. Only a confirmed sign-in, or the owner at the hub, can make, copy or archive a bot; the
  hub records who did it and when.
- **Skills stay read-only.** No job loads a bot's skills yet, so there is nothing to pick. "What this bot can do" is worked out from its computer and
  coding set-up each time (coding only with coding on and a configured account).

## When something's wrong

- **Offline: computer not running** → open Computer and start it, or check `\MU\MU Hub Supervisor` on Ryzen.
- **Needs you** → the bot is waiting for an approval or a sign-in; the conversation says which.
- **Can't talk to this bot** → this browser isn't paired. Pair it from the pairing page with a code from the Ryzen console
  (`bun scripts/identity/pair-code.ts --for usman --port 8081`).

## CRM

Dot owns the CRM. A CRM record can send work to a bot: the task carries the record as a subject, the bot's result links back to it, and
the record's activity shows it once (`AGENTS-CRM-CONTRACTS.md`).
