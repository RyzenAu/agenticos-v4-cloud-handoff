# Staging acceptance checklist (before production cutover)

Run on the VM, instance `staging`, against a restored COPY of production data. Tick every line; stop at the first failure and use the rollback in `deploy/README.md`. Nothing here needs a secret pasted anywhere. Staging holds no live payment, phone or messaging credentials.

## A. The package
- [ ] On the PC: `bun run cloud:package -- --sha <sha> --out <dir>` printed "Verified"; three files exist (`mu-hub-<sha12>.tar.gz`, `.manifest.json`, `SHA256SUMS`). Tarball sha256: `________`
- [ ] Manifest: `secretScan.hits` is `0`; excluded rules include `env-file` and `docs-media`; no `.operator-data`.
- [ ] Copied over the tailnet (Tailscale SSH or `scp`), all three together.
- [ ] `deploy/bin/rollout.sh staging <sha> --package <tar.gz>` finished "healthy on <sha>" (it verifies SHA256SUMS first and runs `bun install --frozen-lockfile`).

## B. Identity and network
- [ ] `tailscale serve status` shows only the staging and production Serve ports; `tailscale funnel status` is empty; no public firewall port.
- [ ] From Usman's phone on the tailnet: `https://<vm>.<tailnet>.ts.net:8444` opens the OS signed in as Usman; a device NOT on the tailnet cannot reach it.
- [ ] Mehroz signs in from his own device and sees his own devices only (not Usman's).
- [ ] Owner admin path: `ssh -L 8082:127.0.0.1:8082 <vm>`, then the loopback URL works as owner (the open question in CLOUD-ARCHITECTURE section 4).

## C. Health and role
- [ ] `deploy/bin/smoke.sh staging` is ok or degraded (degraded only for Hindsight off).
- [ ] `/__health` shows `hubRole: cloud`, the right `gitSha`, `dataDir.path` = `/var/lib/mu-hub/staging`, every store ok.
- [ ] The device list has no "Usman's PC"; the hub is not a target.

## D. Companions (outbound connection)
- [ ] On the PC: `bun companion/main.ts pair --hub https://<vm>.<tailnet>.ts.net:8444 --code <code from Profile>`, then `bun companion/main.ts run` (or the autostart installer). The PC shows online in the OS.
- [ ] A PC-bound action with that PC stopped fails honestly ("no device ... nothing ran"); with it running, it runs on that PC only.
- [ ] A shared computer that does not exist is refused by name.

## E. Restart safety
- [ ] `systemctl restart mu-hub@staging`: the same jobs and pairings are there; an interrupted job reads "unknown", never re-run; the companion reconnects without re-pairing.
- [ ] `kill -9` the hub process during a job: same result after systemd restarts it.

## F. Backups
- [ ] `systemctl start mu-hub-backup@staging.service` made a backup; `backup-cli verify` passes.
- [ ] Restore drill into an empty folder: row counts equal the manifest; a hub started on it is healthy.

## G. Data, memory, pricing
- [ ] Leads and CRM row counts equal the PC's (printed by the restore). Memory writes are OFF on staging.
- [ ] Pricing shown anywhere equals the catalogue (A$699 / 1,099 / 1,999 ex GST); no setup or pilot price appears.

## H. Rollback
- [ ] `deploy/bin/rollback.sh staging` returns to the previous release; run it again to return to this one.
- [ ] A rollout of a package with a changed byte (checksum mismatch) is refused before anything unpacks.

Sign-off: staging passed on `<sha>` by `______` on `____`. Only then roll the SAME sha to production (`deploy/README.md`; cutover plan in CLOUD-ARCHITECTURE section 5).
