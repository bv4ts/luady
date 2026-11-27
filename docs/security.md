# Security

Luady steers Claude Code sessions that can change code and run commands on your servers. This page says what the hub
protects, how, and what it leaves to you. The full details are in the [security notes](security-notes.md). To report a
vulnerability, follow [SECURITY.md](../SECURITY.md); please do not open a public issue.

## In short

- **Local by default.** The hub listens on `127.0.0.1:7410` and answers only to `localhost`. Nothing listens on a public
  address unless you set it up on purpose.
- **Signing in.** A passkey, or, on the hub machine or through an SSH tunnel to it, a login link from the command line.
  Every request from the website also carries a **page key** that another program on the hub machine cannot borrow.
- **A PIN for risky actions.** Stopping a session, adding or removing a server, writing files, opening a terminal and
  the manager's risky actions ask for it. Wrong guesses lock it. Starting a session or sending it a message yourself
  needs no PIN, and a started session runs with permissions bypassed (see "Your servers" below).
- **A fixed list of commands.** The commands the hub builds itself over SSH are the kit's fixed verbs and three fixed
  setup scripts, with text passed on standard input, never spliced into a command line. The hub speaks SSH itself and
  calls no `ssh` program. A shell command that you or the manager type reaches a server in three ways only: the
  terminal you open yourself, which asks for your PIN; a command you run from the website, which runs at once when the
  hub judges it read-only and otherwise asks for your PIN; and the manager's command action, which asks for it unless
  the hub judges the command read-only. On this computer every command asks, yours and the manager's. All three stop
  asking if you turn off **Ask for my PIN before the manager's risky actions** in Settings, which itself needs the PIN.
- **The manager is off by default.** Switched on, it acts with the rights of the user on each of your hosts, and your
  PIN is a brake on its risky actions only. [The manager](manager.md#what-it-can-do) lists what needs the PIN and what
  does not.

## Signing in

The first sign-in claims the hub with a one-time **setup code** printed in the terminal, then creates a passkey. On a
hub that stays on the hub machine you can instead sign in with a login link from `npm run luady -- login`: it works
once, for 5 minutes, only from the hub machine (an SSH tunnel to it counts), and asks for the PIN once one is set. A
login link on its own never claims the hub: the first PIN still needs a setup code. A setup code works for 30 minutes,
and a new one ends the one before it.

The session cookie is `Secure`, `HttpOnly` and `SameSite=Strict`. On top of it, the website holds a **page key** that
every request must carry. Browsers send a `localhost` cookie to every port on `localhost`, so another local web server
could replay it; it cannot get the page key. The [security notes](security-notes.md#the-page-key) explain how.

## The PIN

![Needs your PIN, in the Inbox: Luady wants to send a two-line message to meadow-hr on cedar. The card names the action, gives the text's size, line count and SHA-256, shows its first lines with a Show the full text button, and asks for the PIN, with Approve and Deny.](assets/pin-confirm.png)

Each PIN prompt names the action it confirms. Three wrong tries in a row lock the PIN for 15 minutes, and every new lock
lasts twice as long. `npm run luady -- pin reset` on the hub machine clears it and signs every browser out;
a new PIN then needs a new setup code.

## Your servers

- The hub signs in with its own key, the fleet key (ed25519). The line you paste on a server forbids port, agent and
  X11 forwarding.
- The hub never trusts a server's host key by itself: you compare the fingerprint, and a changed key later stops the
  connection.
- Over SSH it runs only fixed commands (above). Addresses such as link-local and multicast are refused, and checked
  again at every connection.
- Adding, changing and removing servers are written to the audit log in **Settings**.

> [!WARNING]
> The sessions themselves are Claude Code running as the server's user. Sessions started from Luady run with
> permissions bypassed (`--permission-mode bypassPermissions`), so they act without asking. Questions they ask still
> reach you. Give each server a user that may only touch what those sessions should.

## The manager

Off on a new hub. When you switch it on it runs Claude Code under its own home folder, with its own sign-in, kit and tmux
server, apart from your sessions. With the default `"managerFiles": "own-folder"`, its own file tools (Read, Write,
Edit) may read and change files only in its own folder, and never its settings there (`.manager/`). It can rewrite its
own manual (`CLAUDE.md`), its skills and `LOCAL.md`, where its instructions come from.

Through the hub's tools it reaches your servers and, if you added it, this computer, as the user each of them uses: on
this computer, the hub's own user. Without your PIN it reads files there, sends you files, runs commands the hub judges
read-only (never on this computer), and starts sessions, types into them and answers their questions while it answers
a message from you or a Run or Give you pressed on the website. With your PIN it does those in any other turn, runs
every other command, writes files, and stops, restarts or deletes sessions. On this computer the hub's own folders
(config, secrets, data, run folder, the manager's home and its `.manager/` settings, the hub token, the fleet key), and
the old ChatGPT sign-ins (`~/.codex` and the `.codex` folder beside the data folder), are refused to its file tools,
with or without the PIN, and writes into the local kit and the folder Luady is installed in are refused too. A
command you approve on this computer, or a session there, can still read and write those folders.

What the PIN does not stop: whatever steers the manager while it answers you counts as yours (what it reads in that
turn, what it read earlier in the conversation, and what it stored for itself); sessions run without permission
prompts, and a session on this computer can read the hub's files; its picture tool is a Codex agent that can read any
file the hub's user can; and with PIN confirmations switched off nothing asks. Switch the manager on only if you would
give it your servers' users yourself. The full list is in [The manager](manager.md#what-it-can-do).

## Add-ons

An add-on runs as the hub's Unix user, so it can read what the hub can. Its token is identity, not isolation. Install
only add-ons you would run as yourself. See [Add-ons](addons.md#what-you-trust-an-add-on-with).

## One user per machine

The hub, its website and the sessions on this computer run as one Unix user: you. The hub creates its folders at mode
0700 and its database, secrets, keys and tokens at 0600, tightens wider modes at start, and refuses to start if they
belong to another user. On Windows, run the hub in WSL2: Windows itself has no such modes.

## Reaching the hub from another machine

In this version the supported way is an SSH tunnel. The hub stays on `localhost`, and your laptop reaches it as if it
were local:

```sh
ssh -N -L 7410:127.0.0.1:7410 dev@oak.example.invalid
```

Then open <http://localhost:7410> on the laptop. Passkeys, the cookie and the page key all keep working.

Other setups, such as a public address or a reverse proxy, are not supported in this version. The hub refuses to start
in one unless it has HTTPS, at least one passkey and `"allowRemote": true` in its config, and even then the login link
is refused. The [security notes](security-notes.md#what-remote-means) define "remote" exactly.
