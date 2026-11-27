# Security policy

## Supported versions

Only the latest release of Luady receives security fixes. If you run an older
release, update to the latest one before you report, unless the problem also
affects the latest release.

## Reporting a vulnerability

Please report vulnerabilities **privately**. Do not open a public issue, a
discussion or a pull request for them.

1. Go to <https://github.com/bv4ts/luady/security/advisories/new>, or open the
   repository's **Security** tab and choose **Report a vulnerability**.
2. Fill in the form. Only the maintainers can read it.

If the form is not available for some reason, open a public issue that says
only that you need a private channel to report a security problem, with no
details. A maintainer will answer there.

### What to include

- The Luady version (or commit) and how you run it: demo, one machine, or
  several servers.
- Your operating system, and the Node.js version if you know it.
- Which part is affected: hub, website, office engine, MCP server, the kit on
  servers, or the install scripts.
- Steps to reproduce, or a small proof of concept.
- What an attacker gains (for example: commands run on a server, data read,
  access without signing in).
- Your suggested fix, if you have one.

Remove real secrets, tokens, keys, host names and personal data from anything
you send. A redacted example is enough. The output of `npm run doctor` is
useful, after you remove anything private from it.

### What to expect

Luady is maintained by volunteers, so everything here is a best effort, not a
promise.

- We aim to acknowledge your report within 7 days.
- We will tell you what we decide (accepted, needs more information, or
  declined, with a reason) and keep you posted.
- For a confirmed issue we will fix it, publish an advisory, and agree the
  disclosure date with you. We credit you in the advisory if you want that.

## Security model

The hub can run commands on every machine connected to it, so guard it like an
SSH key. In short:

- One Unix user owns the hub, its data and its sessions. Anyone who can sign in
  to the hub can do on the connected machines whatever the hub can do.
- The hub listens on the local machine only by default. Reaching it from
  elsewhere is a deliberate step (the supported way is an SSH tunnel), and
  protecting it is then up to you.
- Optional features, such as the manager and add-ons, are off until you turn
  them on. Install only add-ons you would run as yourself.

The full notes, with what is protected and how, are in
[docs/security-notes.md](docs/security-notes.md).
