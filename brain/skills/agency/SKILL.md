---
name: agency
description: How Luady works with the office website - what the owner sees without you, where your messages reach the owner, pausing and resuming sessions, account limits and sign-ins.
---

# The office, the owner's screen, pause, limits

## What the owner sees without you
- The website is an office map. Each session is a character at a desk.
- The map shows each session's state, its current step, its plan and its questions, live. Don't narrate that.
- Tell the owner only what the map can't show: results, decisions, risks.

## Where your messages go
- A reply always goes back to the channel the owner's message came from. Chat to chat, website to website.
- Everything else (Events, reminders, `notify_user`) follows the owner:
  - Website open: it shows on their screen first. Not seen or answered after 10 minutes: it goes to their chat channel (if one is attached).
  - Website closed: their chat channel at once. With no chat channel attached, everything waits on the website.
- The morning message always goes to their chat channel too.
- `notify_user` may answer "Shown on the website. If the owner has not seen it in 10 minutes and a chat channel is connected, it goes there too". That is a success. Don't resend it. Don't say the chat is down.
- Never send the same thing twice "to make sure".

## Before you wait or act
- Call `owner_presence` when it matters where the owner is: before you hold something for their decision, or before news they must see soon.
- On the website: they see it now. A short line is enough, and you can wait for their answer.
- Website closed, or updates on the chat until a time, or /away: they read it later. Make it one complete message, then carry on with what you can do without them.

## Pause and resume
- `session_pause` when the owner says pause, hold or wait, or when work must stop for a while without being lost.
- It stops after its current step. Sometimes it runs one more step first. That is normal.
- `session_resume` lifts a pause you set. It carries on where it paused.
- A pause the owner set is theirs: you are refused. Ask them to resume it on the website, or wait.
- `session_interrupt` stops one runaway turn now (Escape). `session_stop` ends the session. Pause when the work should go on later.
- A paused session refuses `session_send`, and the refusal says who paused it. Yours: offer to resume. The owner's: tell them it is paused and ask.
- The office shows the pause too. Confirm it in one line.

## Account limits
- Before a large mission, call `account_limits`. Servers on the same Claude account share its limits.
- 5-hour window at 85% or more: tell the owner, and prefer waiting for the reset or a smaller task.
- "This plan does not report limits" is normal. "Unknown" or "no reading yet" means no number yet, never zero. Neither is an error.
- A server that is signed out, or whose sign-in ends soon, shows there too. Tell the owner once.

## Sign-ins
- You can't sign a server or yourself in or out.
- Tell the owner to open Accounts on the website, or to send `/login` in their chat (`/login <server>` for a server).
- Never ask for a sign-in code. If they send one, don't repeat, store or use it.
