# Meeting mode (25 Sep 2026)

Jarvis listens to a sales call or meeting **that everyone has agreed to**, says nothing during
it, then gives you clean notes, a CRM update and a coaching session: the 100-point scorecard,
what went well, and the three fixes that matter most, with the exact better lines to say. The
same coaching runs on a post-call debrief in your own words and on Granola notes from Zoom or
Meet, so every call is coached the same way whichever tool captured it.

## Say it

| You want | Say to Jarvis (voice) | Or |
|---|---|---|
| Arm it (before you dial) | "Jarvis, meeting mode" / "meeting mode for Smile Dental" | header **Meeting** → Arm |
| They agreed | "they agreed" / "she's happy with that" | **They agreed** |
| They said no | "they said no" | **They said no** → debrief afterwards |
| Hear the consent line again | "read me the consent line" | shown on screen |
| Finish and get the notes | "Jarvis, end meeting" (heard in the call audio) | **End meeting** |
| Stop now, keep nothing | "Jarvis, stop" | **Stop (keep nothing)**, or the ■ on the red pill |
| Cue cards on/off (off by default) | "Jarvis, cue cards on" | tick **Cue cards** |
| Keep this one transcript | "Jarvis, keep the transcript" | tick **Keep transcript** |
| Debrief (no capture) | "debrief for Smile Dental: spoke to Sarah…" | Meeting panel → debrief box; Telegram (below) |
| Coach a Zoom/Meet call | "**Jarvis, coach my last Granola meeting**" (or "…with Smile Dental") | panel → **Coach last Granola meeting** |
| Last call's notes | "notes from my last call" | panel → **Last call's notes** |

## How it behaves

1. **Consent gate.** "Meeting mode" arms it and **starts nothing**: the mic isn't opened and the
   server refuses audio. The panel shows the line to say:
   > Just so you know, I use an AI note-taker so I don't miss anything. Are you happy with that?

   Jarvis doesn't read it aloud unless you ask (on speakerphone they'd hear him). You answer
   "they agreed" or "they said no". Every answer is logged to
   `.operator-data/meeting-mode/consent.jsonl`: time, lead, your confirmation, channel, and
   `audioStored: false`. "No" means no capture, and the post-call debrief is offered instead. An
   unanswered consent question lapses after 15 minutes.
2. **During the call** Jarvis is silent: no speech; the voice session and the "Hey Jarvis" wake
   word stand down. You get a red **listening · 12:34** pill in the header and panel, a start
   chime, a soft pip every minute (switchable) and an end chime. Cue cards (1–3, local keyword
   rules from the playbook, e.g. "They raised price: anchor to the cost of missed calls") are off
   unless you switch them on. If anyone says "stop the recording" / "I don't want to be recorded",
   capture stops at once, as it does for "Jarvis, stop". After 90 s of quiet he asks once whether
   the call has finished.
3. **At the end** ("Jarvis, end meeting" or **End**) you get a spoken recap of about 20 seconds
   and the full notes in the panel:
   - **Summary:** who, what they need, objections, decisions, and next steps with dates.
   - **CRM:** one `log` entry plus a `coach` row on the matched lead, through the lead engine's
     own functions with the event id `meeting:<id>`, so re-applying never duplicates. The lead
     is matched from the lead you named or the business the coach heard. If neither matches, it
     isn't logged and the panel asks which lead.
   - **Coaching:** the 100-point rubric (Opener 15, Discovery 25, Value 15, Objections 20, Next
     step 20, Delivery 5; unevidenced categories show "not observed"), what went well, the 3
     highest-impact fixes with exact better lines, and which framework applies (value equation,
     CLOSER, objection handling, next step).
   - **Follow-ups:** draft tasks and messages with a copy button. **Nothing is sent.**

   On Telegram, "notes from my last call" returns the same notes (`mu-call-coach` skill → `cli.ts last`).

## Privacy

- **Local transcription.** faster-whisper `large-v3-turbo` runs on the RTX 4070 Ti (float16),
  falling back to `small.en` on the CPU. It's in a venv on `D:\meeting-mode` (models in
  `D:\meeting-mode\models`). The OS starts it the first time you arm meeting mode (loading the
  model captures nothing), and it exits after 20 idle minutes. There's **no cloud fallback**: if
  the local model can't run, meeting mode says so.
- **Audio is never written to disk.** The page keeps ~8–18 s buffers in RAM, sends only chunks
  with speech in them to the local server over loopback, then zeroes them. The server decodes
  them into a numpy array and drops them. There's no MediaRecorder, file or browser storage for
  audio, and tests check this (`scripts/meeting-mode/meeting-mode.test.ts`).
- **The raw transcript is discarded after the summary.** It exists only in the OS server's
  memory during the call. "Keep the transcript" keeps it for that one call, as
  `notes/<id>.transcript.txt`. If the summary fails, the transcript stays in RAM so you can
  retry; "stop" still wipes it.
- **Only the structured notes and coaching are saved:** `.operator-data/meeting-mode/notes/<id>.json`
  and `.md`, which are git-ignored.
- **The summary runs on your subscriptions only:** Claude Sonnet via the `/__claude` bridge
  (`claude -p` under your claude.ai login), falling back to Hermes (GPT-6 on the ChatGPT
  accounts). No paid API is used.

## iPhone

**Recommended: phone on speaker, next to the PC mic, with meeting mode running on the PC.**
- Arm meeting mode on the PC **before you dial**. Say the consent line, then tap **They agreed**
  or say it.
- Put the iPhone flat on the desk **15–30 cm from the mic**, speaker end facing it, with call
  volume at about 70%. Keep it off the same surface as a laptop fan or keyboard.
- Use the desk mic (HyperX SoloCast), not the headset mic: the headset's noise suppression
  removes the phone's voice.
- **Echo** isn't a problem here. The PC plays nothing during the call, and meeting mode turns
  browser echo cancellation and noise suppression off so the far voice survives. Leave auto-gain
  on. If the other person sounds faint, move the phone closer rather than turning it up, because
  iPhone speakerphone distorts at full volume.
- Don't wear headphones connected to the PC for the call. The phone's own earpiece mode won't
  reach the mic, so it has to be on speaker.

**Also supported: the OS web app on the iPhone** (`https://<pc>:8443`, over Tailscale). Mobile
Safari can use the microphone on an HTTPS page (getUserMedia, iOS 14.3+), so meeting mode works
there for an **in-person meeting** with the phone on the table: Meeting (in the menu sheet) →
Arm → They agreed. **It can't capture a phone call made on the same iPhone.** iOS gives an active
call exclusive use of the audio, so Safari's mic is interrupted, and no web page can hear the
call itself. For calls, use the PC setup above. (Not yet tested on a physical iPhone; the
Safari behaviour is from Apple's platform rules.)

## Online meetings (Zoom / Meet)

Use Granola as usual, then say **"Jarvis, coach my last Granola meeting"** (or "…with Smile
Dental"). That runs the same `mu-call-coach` method and the same idempotent CRM update as meeting
mode, keyed on the Granola meeting id, so coaching the same meeting twice logs it once. From
Claude Code, the `meeting-wrap-up` skill still files decisions into the wiki. Its output can be
coached with `bun scripts/meeting-mode/cli.ts granola --query "<title>"`.

**The same consent rule applies to Granola.** It doesn't store audio, but it still listens to a
private conversation with a device and transcribes it, so the Surveillance Devices Act applies
just the same. Say the same consent line at the start of every Zoom or Meet call you run Granola
on.

## Two-channel capture (computer calls)

On a Zoom, Meet, Teams or softphone call made from the PC, meeting mode records two streams separately. The microphone is labelled **me**, and a WASAPI loopback of the default output device is labelled **prospect** (`scripts/meeting-mode/dual_capture.py` and `capture.ts`). Each chunk goes through the same local whisper server. The Jev objection cues act only on `prospect` chunks, so they need this mode.

- **Use headphones.** If you're on speakers, the mic also picks up the prospect. A bleed guard drops a `me` chunk that closely matches a `prospect` chunk from within 3 s, but headphones are more reliable.
- **Consent is unchanged.** The streams only open after the consent answer is `agreed`. While consent is pending, only the device list is read.
- **Fallback.** With no loopback device, or on an iPhone-speaker call, meeting mode keeps the original single-channel mode with speaker `unknown`. The HUD then warns that cloud cues won't fire.
- **Tested with synthetic audio only** (TTS through loopback): "that's too expensive for us right now" came back as `prospect`, and the price cue showed about 1.2 s after the speech ended.

## Telegram: the `mu-call-coach` skill

This skill is available in Hermes (`%LOCALAPPDATA%\hermes\skills\business\mu-call-coach`) and in
Claude Code (`~/.claude/skills/mu-call-coach`). Paste notes, or send a voice-note debrief, and it
runs `bun scripts/meeting-mode/cli.ts debrief --text - [--lead N] --by usman`. You get the same
notes, scorecard and fixes, and the same CRM log. `cli.ts granola`, `last`, `list` and
`consents` round it out.

## Set-up (done 25 Sep)

```
uv venv --python 3.11 D:\meeting-mode\venv
uv pip install --python D:\meeting-mode\venv\Scripts\python.exe faster-whisper nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*" numpy sounddevice
uv pip install --python D:\meeting-mode\venv\Scripts\python.exe soundcard==0.4.6   # two-channel capture
```
The OS starts `scripts/meeting-mode/whisper_server.py` itself (127.0.0.1:8765, loopback only),
with `HF_HOME=D:\meeting-mode\hf` so nothing lands on C:.

Code: `scripts/meeting-mode/{session,coach,crm-sync,cues,store,transcriber,llm,api,service,cli}.ts`,
`src/lib/meeting-{mode,words}.ts`, `src/components/operator/meeting-mode-hud.tsx`, the `meeting`
voice rule in `scripts/free-voice.ts`, and routes at `/__operator/meeting/*`.

## Verification

- `bun test scripts/meeting-mode`: the consent gate (no capture without a yes, "no" goes to the
  debrief, "stop" and a mid-call withdrawal stop at once, an in-flight chunk is dropped, consent
  expires), no audio on disk, the transcript discarded by default and kept only on request, and
  idempotent CRM logging (meeting, debrief and Granola).
- `bun scripts/meeting-mode/live-test.ts --in 1 --out 24`: a **synthetic** two-voice cold call
  (Groq Orpheus voices, a fictional practice) is played out of a monitor speaker into the desk mic
  and runs through the real gate, transcriber and coach. Results are in
  `Downloads\meeting-mode-sample.md`.
  On 25 Sep, over a 99 s call (242 words), the speaker-to-mic word error rate was 12–16% on a
  quiet room (9.5–10.7% for the same audio fed in directly). Most of the errors are formatting,
  such as "$499" for "four hundred and ninety nine dollars" and "M&U Adventures", plus the
  spelled-out email address. The local model takes about 0.2–0.3 s per 8–18 s chunk on the 4070
  Ti, and each chunk reaches text about 0.3 s after it's cut. The model loads in 14–30 s from
  cold. From the end of the call, the notes take about 50–55 s, which is Claude Sonnet via the
  bridge. "Jarvis, end meeting" was heard in 4 of 5 runs. One run picked up other sound in the
  room (WER 42%), so keep the room quiet. The HyperX headset can't be heard by the desk mic at
  all; the test used the VG252Q monitor speaker.

## Legal notes

This is not legal advice.

- **NSW, Surveillance Devices Act 2007 s 7.** It's an offence to use a listening device to
  record or listen to a private conversation you're a party to without the consent of the other
  parties, apart from narrow exceptions such as protecting your lawful interests. A phone on
  speaker next to a PC microphone, and Granola on a video call, both count. That's why consent is
  asked for and logged before anything is captured, and why a "no" or a mid-call "stop recording"
  ends capture.
- **Telecommunications (Interception and Access) Act 1979 (Cth).** It prohibits intercepting a
  call as it passes over the telecommunications system. Meeting mode never taps the line: it
  hears the room through a microphone, like a person sitting beside you. That puts it under the
  state surveillance-devices laws rather than the interception regime, but only if you use it that
  way. Never connect it to the phone line or a call-recording feed.
- **Other states and countries differ.** Victoria, Queensland and the NT allow a party to record
  their own conversation without everyone's consent; NSW, SA, WA, Tasmania and the ACT generally
  don't. Overseas rules vary, and some require notice for every call. Asking everyone every time
  meets the strictest standard. **Confirm with a lawyer before relying on this for calls with
  interstate or overseas parties.**
- **Privacy Act / APPs.** The notes contain personal information about the person you spoke to.
  Keep them to what you need for the sales relationship, don't reuse them outside it, and delete
  a lead's notes if they ask.
