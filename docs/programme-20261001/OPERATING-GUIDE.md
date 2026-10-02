# AgenticOS: operating guide for Usman and Mehroz (1 Oct 2026)

## The shape

- **One workspace, shared:** leads, jobs, decisions, memory, receptionist, finance and shared agent computers are the same for both of you.
- **Your own PC is yours:** Jarvis only controls the PC of the person asking. "Here" and "my computer" mean your enrolled PC. If that PC is offline, Jarvis says so and nothing runs anywhere else.
- **Shared agent computers** ("research", "builder"…) can be used and taken over by either of you. One controller at a time.
- **Jarvis** is the one assistant, typed or spoken. **Jev** decides what to do. Every request becomes a job you can watch, stop or resume.

## Everyday use

| You want | Say or do |
|---|---|
| Open something on your PC | "Open PowerPoint here" · "Open a new Chrome tab, go to YouTube and search for …" |
| Go back | "Switch back to the website we were using" · "Back to PowerPoint" |
| Stop | While Jarvis is talking: "quiet" stops the speech only. "Stop that task" cancels the job. A bare "stop" while both are happening asks "Stop the task too?" |
| Use a shared computer | "Use the research computer to …" · "Show me the research bot" · "Continue that job on its cloud computer" |
| Watch or take over a computer | System → Computers → Preview / Take control → do your part → Return to agent (the agent re-reads the screen and carries on the same job) |
| Coding | "Assign this fix to Claude Max 2" or Coding → describe → repo → accept the plan → Start. The job page shows the account and model that actually ran, the diff, the tests and the review |
| Leads | Leads → open a lead → Edit lead. Your edits survive refreshes and later imports |

## What each status means

- **Verified:** the PC or computer checked the result itself (for example, the window or page title it read back).
- **Unknown:** the device dropped mid-action, so nobody can say whether it happened. Jarvis never retries it on its own. Look, then ask again if needed.
- **Offline:** the device's heartbeat stopped. A sleeping PC is normal.
- **Needs the companion:** this runs on a PC, and that PC's companion isn't connected.

## Enrolling a PC (once per PC)

See `docs/MEHROZ-ENROL.md`. In short:

1. Sign in to the OS in your browser, then open Profile → Pair another device → Code for a companion.
2. On the PC, run `mu-companion pair --hub <OS address> --code <code> --label "<Name>'s PC"`.
3. Run `install-autostart.ps1 -Exe <path>` so it starts at logon.

Each PC can only be enrolled by its owner's own signed-in session.

## When something is wrong

- **System → health** (`/__health`) names the failed part and the fix.
- A PC shows offline: check the companion is running (`mu-companion status`) and that Tailscale is connected.
- A computer shows failed: Computers → Start. Its files are kept.
- Backups: `bun run cloud:backup`. Restore into a separate folder with `bun run cloud:restore`. The restore refuses a folder that isn't empty. See `deploy/README.md`.
