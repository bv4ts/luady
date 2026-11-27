# FAQ

## Is it a game?

No. It looks like one. The office is a view of real Claude Code sessions: each creature is a session that is running on
one of your machines right now, and what you do on the website happens there.

## Does it simulate agents?

No. Luady does not make agents of its own. It shows the Claude Code sessions you run, and the manager if you switch it
on. The demo and the live demo are the only places with pretend sessions.

## Is it made by Anthropic?

No. Luady is not affiliated with Anthropic. "Claude" and "Claude Code" are Anthropic's names. Luady uses Claude Code as
you have it installed, with your own sign-in and plan.

## What does it cost?

Nothing; it is open source under the Apache-2.0 licence. The Claude Code sessions use your own Claude plan, as they
would without Luady. The manager, when on, uses a Claude plan too.

## How many servers and rooms can I have?

There is no set limit. The map grows in rings around HQ as you add rooms. Every server needs SSH access from the hub.

## Which operating systems?

The hub runs on Linux, or on Windows inside WSL2. Servers are Linux. The demo (`npm run demo`) runs on Linux and also on
Windows as it is. It has not been tried on macOS yet, and running the hub on macOS is not supported in this version.

## Do I need the manager?

No. The office, the rooms and everything you do with sessions work without it. It is off until you switch it on. See
[The manager](manager.md).

## Can I talk to it from a chat app?

Through a channel add-on, yes. No chat app is built in: channels come as [add-ons](addons.md), and you can write one
with the SDK.

## Does anything leave my machine?

The hub talks to your servers over SSH, and your browser talks to the hub. The kit on each server sends the hub short
previews of your prompts and of Claude's messages, with common secret shapes replaced first (see
[What the kit changes](servers.md#what-the-kit-changes)). When you open a session, the hub also reads its whole
transcript from the server, as it is. The sessions and the manager talk to Anthropic as Claude Code
always does. Luady itself has no analytics and no crash reporting.

Other services are reached only when you connect them or switch them on:

- **Google, Wispr Flow, Jira or a mailbox over IMAP**: the hub talks to the service you connected.
- **Pictures**: the manager's picture tool runs the Codex CLI with your ChatGPT sign-in, so its prompts and reference
  pictures go to OpenAI. A reference can be a web link, which the hub then fetches. The nightly **Tools update**, once
  you switch it on, installs the newest Codex CLI from the npm registry.
- **Claude Code update**: the nightly job, once you switch it on, runs `claude update` on each server.
- **Phone calls**: the hub can phone you through Twilio, but only when you add a Twilio account to `secrets.env` and a
  phone number and a public voice address to `config.json`. These docs do not set that up, and phone notifications
  are not in this version.
- **Add-ons** talk to their own services.

## Can more than one person use it?

Not in this version. One hub has one owner.

## Can I open it on my phone?

The website works at phone sizes. There is no app: the phone needs an SSH client that can forward a port, and you open
the hub through that tunnel as from any other machine (see
[Security](security.md#reaching-the-hub-from-another-machine)). Phone notifications are not in this version.

## How do I update?

See [Update](getting-started.md#update). There is no update button yet.

## How do I remove it?

1. In **Settings → Servers**, choose **Remove** for each server and for **This computer**, with **Remove the kit from …**
   and (for a server) **Remove the hub's key line from …** ticked.
2. If you set up the service: `systemctl --user disable --now luady.service`, then delete
   `~/.config/systemd/user/luady.service`.
3. Stop the hub.
4. On each server and on the hub machine, once no Claude Code session runs there any more, delete `~/.luady` (removing
   the kit leaves stand-in files and its state there, so that running sessions do not break) and `~/luady-kb`.
5. Delete the repository folder, `~/.config/luady` and `~/.local/share/luady`.

## Where do I report a bug or a security problem?

Bugs: the [issues](https://github.com/bv4ts/luady/issues). Security problems: privately, as
[SECURITY.md](../SECURITY.md) explains.
