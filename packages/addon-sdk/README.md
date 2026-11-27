# @luady/addon-sdk

Luady has no chat app built in. An **add-on** is a small program of its own that connects to the hub and gives it
something extra: a **channel** (a chat app the owner talks to Luady through) or **tools** (things the manager can
do). This package is a client for the protocol they speak, **Add-on Protocol v1**, and an example add-on you can copy.

## What an add-on can do

- **A channel add-on** passes the owner's messages to the hub and the hub's messages to the owner. It says in `hello`
  what it can do (`capabilities`: text, files, edits, pins, typing, voice notes and so on). The hub uses only what the
  add-on declared; anything else is skipped.
- It can show a **panel** on the website's Settings page: text, a QR code, a code to copy, an input field and buttons.
  The panel is data, never code: every string is shown as plain text, and a button only sends its `action` name back
  to the add-on. A button marked `pin` asks the owner for their PIN first.
- **Any add-on** can offer the manager up to 20 **tools** and a short note for the manager (`brainNotes`, written into
  the manager's `ADDONS.auto.md`). A tool call reaches the add-on as `tool.call`; it answers with `tool.result`. The
  manager sees new tools after it restarts.
- It can hand the hub a file or text for the owner with `deliver`. The hub sends it on the owner's chat channel, or,
  when no channel is up, keeps it on the website, where the owner downloads it.

## What an add-on cannot do

- It cannot use another add-on's connection, see another add-on's messages or answer another add-on's tool calls.
- Its token works only on its own route, `/internal/addon/<id>`. The hub refuses it on the manager's tool API and on
  the website's API.
- It cannot run code or HTML in the browser. Panel strings are text.
- It cannot send the hub a file from anywhere: a file path must point inside `<dataDir>/addons/<id>/files/` (the real
  path, after links are followed); anything else is refused.
- A `tools` add-on cannot send owner messages (`incoming`) or a channel status.
- A tool cannot take the name of one of the hub's own tools.
- Frames are size-limited and rate-limited, and every frame is checked against the protocol's schemas
  (`packages/shared/src/addon.ts`). An invalid frame is dropped and logged without its content.

## What you trust an add-on with

An add-on runs on the hub machine as the hub's Unix user. The token is how the hub knows **which** add-on is talking; it
does not fence the add-on in. That user can read the hub's database, its secrets file and the fleet key. A channel
add-on speaks as you, and sees whatever you type in that chat, a PIN included. Tool descriptions and `brainNotes`
become text the manager reads. **Install only add-ons you would run as yourself.**

## Setting one up

1. Declare it in the hub's `config.json`:

   ```json
   {
     "addons": [{
       "id": "echo", "kind": "channel", "name": "Echo (terminal)",
       "owner": "me", "primary": true
     }]
   }
   ```

   - `id`: 2 to 24 characters, lower-case letters, digits and `-`, a letter first. These are taken by the hub:
     `web`, `phone`, `event`, `scheduled`, `remote_control`, `chat`, `manager`, `hub`.
   - `kind`: `channel` or `tools`.
   - `owner` (channels only): the owner's address in that chat app. Messages from anyone else are dropped, by the
     add-on and again by the hub.
   - `primary`: the channel the hub uses to reach the owner. At most one; with a single channel it is the primary.
2. Start the hub once. It writes the add-on's token to `<dataDir>/addons/<id>.token` (mode 0600) and creates
   `<dataDir>/addons/<id>/files/` for the files the add-on hands over.
3. Start the add-on with the hub socket (`<runDir>/hub.sock`) and that token file.

## The example

`src/examples/echo.ts` is a complete channel add-on: a terminal. Each line you type is a message from the owner, and
the hub's answers are printed. It also offers the tool `echo_back` and a panel with one button.

```sh
npm run build
LUADY_HUB_SOCKET=~/.local/share/luady/run/hub.sock \
LUADY_ADDON_TOKEN_FILE=~/.local/share/luady/data/addons/echo.token \
node packages/addon-sdk/dist/examples/echo-main.js
```

## Using the SDK in your own project

The SDK is not published on npm. You use it from a clone of this repository:

1. In the clone, install and build everything once:

   ```sh
   npm ci
   npm run build
   ```

   The built SDK is in `packages/addon-sdk/dist`. It carries its own copy of the protocol's schemas, so it needs
   nothing else from this repository.
2. Still in the clone's top folder, pack it into one file:

   ```sh
   npm pack --workspace @luady/addon-sdk
   ```

   This writes `luady-addon-sdk-0.1.0.tgz`.
3. In your add-on's own project, install that file:

   ```sh
   npm install /path/to/luady-addon-sdk-0.1.0.tgz
   ```

   npm installs the SDK's two dependencies, `ws` and `zod`, from the registry as usual.
4. Import it as `@luady/addon-sdk`, as below.

When you update your clone, build and pack again, then install the new file.

## Writing your own

```ts
import { createAddonClient, readAddonToken } from '@luady/addon-sdk';

const client = createAddonClient({
  id: 'mychat',
  token: await readAddonToken('/path/to/data/addons/mychat.token'),
  socketPath: '/path/to/run/hub.sock',
  hello: { kind: 'channel', version: '1.0.0',
    capabilities: { /* what your chat app can do */ } },
  handlers: {
    onConnected: () => client.status('up', null),
    onSend: async (frame) => {
      const id = await myChat.send(frame.text, frame.replyTo);
      client.sent(frame.ref, id, null);
    },
  },
});
client.start();
myChat.onMessage((m) =>
  client.incoming({ msgId: m.id, from: m.sender, text: m.text, ts: m.time }));
```

The client:

- connects over the hub socket and reconnects by itself, waiting 1 s, then 2, 4, 8, 16 and at most 30 s;
- on every connection sends `hello` first, then what it kept while the hub was away (up to 500 frames, oldest dropped
  first), then your last `status` again (a status and the hello are never kept);
- checks every frame with the shared schemas, both ways, and hands each hub frame to its typed handler, one at a time;
- answers `tool.call` with your handler's `{ ok, text }` (a throw becomes `ok: false`);
- stops for good when the hub closes with 4001 (another protocol version) or 4000 (a newer copy of the same add-on
  connected).

## The protocol in short

One JSON object per WebSocket frame, at `/internal/addon/<id>` on the hub socket, with
`Authorization: Bearer <token>`. An unknown id gets 404, a wrong token 401.

| From the add-on | Meaning |
|---|---|
| `hello` | `protocol: 1`, `kind`, `version`, `capabilities` (channels), `panel`, `tools`, `brainNotes` (≤ 4000) |
| `status` | `starting`, `linking`, `up`, `down` or `unlinked`, a short `detail`, and the panel's current blocks |
| `incoming` | a message from the owner: `msgId`, `from`, `text`, `ts`, and maybe `replyTo` and `media` (with `voice.transcript` for a voice note the add-on transcribed) |
| `sent` | the answer to `send`, `send_file` or `edit`: the chat's message id, or an error |
| `tool.result` | `callId`, `ok`, `text` |
| `deliver` | text or a file for the owner |

| From the hub | Meaning |
|---|---|
| `welcome` | the hub's version, the manager's name and the owner's address |
| `send`, `send_file`, `edit` | answer with `sent` |
| `typing`, `pin`, `revoke`, `played`, `profile` | best effort; sent only when the capability is declared |
| `unlink` | the owner unlinked the channel on the website |
| `ui.action` | a panel button or input |
| `tool.call` | a tool call from the manager; the hub gives up after 15 minutes |
| `delivered` | whether a `deliver` reached the owner |

The schemas are in `packages/shared/src/addon.ts`. Limits: tool names `^[a-z][a-z0-9_]{2,40}$`, descriptions up to 1,000
characters, input schemas up to 16 KB, tool arguments up to 64 KB of JSON. **Your add-on validates a tool's
arguments itself**: the hub checks only their size.

## Licence

Apache-2.0, like the rest of Luady.
