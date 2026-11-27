# Install the Luady Cloudflare Tunnel (locally managed)

> [!WARNING]
> This is an example of how the maintainers run a remote install: one server behind Cloudflare Access. It is not a
> supported way to run Luady yet. The supported way to reach a hub from elsewhere is the SSH tunnel described in
> [Security](../../docs/security.md#reaching-the-hub-from-another-machine). The voice part (§8) needs a Twilio account and
> is not described anywhere else.

Every command runs as root on the server (a VPS) unless it is marked **(local)**, which means on the computer you deploy
from. Open the root shell with key auth only: `ssh -t -i "$LUADY_VPS_KEY" "$LUADY_VPS"` (the same variables as `deploy/lib/common.sh`).

The examples use the hostname `luady.example.com`. Replace `example.com` with your own zone everywhere below and in `deploy/cloudflared/config.yml.template`.

**Heads-up**
- §7 restarts cloudflared, causing a website blip of about 10 seconds.

**Variable**
- `LUADY_TUNNEL_ID`: the UUID that §2 prints. `cloudflared tunnel list` also shows it, in the row named `luady`.

## §1 Log in to Cloudflare

```bash
cloudflared tunnel login
```

cloudflared prints a URL. Open it in a browser, sign in, select your zone and click **Authorize**.
Expected: `You have successfully logged in`, and `/root/.cloudflared/cert.pem` exists.

## §2 Create the tunnel (idempotent)

```bash
cloudflared tunnel list | awk '$2 == "luady"'
```

If this prints a row, reuse its ID (the first column) and skip the next command. Otherwise:

```bash
cloudflared tunnel create luady
```

Expected: `Created tunnel luady with id <UUID>` and the credentials file `/root/.cloudflared/<UUID>.json`. Set `LUADY_TUNNEL_ID=<UUID>` in this root shell and on your local computer.

## §3 Route the hostname

```bash
cloudflared tunnel route dns luady luady.example.com
```

Expected: `Added CNAME luady.example.com which will route to this tunnel`, or a notice that the record already exists.

## §4 Install and validate the config (local)

```bash
[[ "$LUADY_TUNNEL_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] && echo "id ok"
sed "s/\${LUADY_TUNNEL_ID}/$LUADY_TUNNEL_ID/g" deploy/cloudflared/config.yml.template | ssh -i "$LUADY_VPS_KEY" "$LUADY_VPS" 'install -d -m 0755 /etc/cloudflared && cat > /etc/cloudflared/config.yml && chmod 0644 /etc/cloudflared/config.yml'
ssh -i "$LUADY_VPS_KEY" "$LUADY_VPS" "install -m 0600 /root/.cloudflared/$LUADY_TUNNEL_ID.json /etc/cloudflared/$LUADY_TUNNEL_ID.json && cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate && cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://luady.example.com"
```

Expected:
- The regex check prints `id ok`.
- The validate command prints `OK`.
- The rule check shows the matched rule with `hostname: luady.example.com` and `service: http://127.0.0.1:7410`.

## §5 Run it as a service

```bash
systemctl is-enabled cloudflared 2>/dev/null || cloudflared --config /etc/cloudflared/config.yml service install
systemctl --no-pager status cloudflared
journalctl -u cloudflared -n 30 --no-pager -o cat | grep -i 'registered tunnel connection'
```

Expected:
- The service is `active (running)`.
- The unit's ExecStart ends in `--config /etc/cloudflared/config.yml tunnel run`.
- The journal shows up to four `Registered tunnel connection` lines.

`service install` enables and starts the unit itself. After later config edits, run `systemctl restart cloudflared`; that never touches luady-hub.

## §6 Remove the account certificate

```bash
shred -u /root/.cloudflared/cert.pem "/root/.cloudflared/$LUADY_TUNNEL_ID.json"
```

The service uses `/etc/cloudflared/$LUADY_TUNNEL_ID.json`. `cert.pem` can create and delete tunnels and DNS routes for the whole account, so it does not stay on a server that also runs other things. Run §1 again only when the tunnel must be managed (§8, §9).

## §7 Hub independence check (needs luady-hub running)

```bash
before=$(systemctl show -p MainPID --value luady-hub); systemctl restart cloudflared; sleep 15; after=$(systemctl show -p MainPID --value luady-hub); echo "luady-hub pid $before -> $after"; systemctl is-active luady-hub cloudflared
```

Expected:
- The same PID twice.
- `active` and `active`.

`luady-hub.service` has no dependency on cloudflared; `tests/integration/deploy/units.test.ts` pins this.

## §8 The voice hostname (optional, for phone calls)

1. Log in again (§1).
2. Run `cloudflared tunnel route dns luady voice.example.com`.
3. In `/etc/cloudflared/config.yml`, uncomment the two voice lines, keeping the 404 rule last. Validate as in §4, then run `systemctl restart cloudflared`.
4. In Zero Trust, add an Access application for `voice.example.com` with a **Bypass** policy, because Twilio cannot log in. The hub checks `X-Twilio-Signature` on every request.
5. Remove the account certificate again (§6).

## §9 Remove the tunnel (rollback)

```bash
systemctl disable --now cloudflared
cloudflared service uninstall
cloudflared tunnel login
cloudflared tunnel delete luady
rm -rf /etc/cloudflared
shred -u /root/.cloudflared/cert.pem
```

Then delete the `luady` CNAME in Cloudflare → DNS. The website becomes unreachable; luady-hub keeps running locally.
