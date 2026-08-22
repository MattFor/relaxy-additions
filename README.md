# Relaxy! Additions

A collection of scripts / websites and more including but not limited to: health monitoring, hang detection, an uptime
ledger with a public status feed, and SSH priority for a single-board Linux host that make the Relaxy ecosystem possible
and self-sufficient. Written for a Raspberry Pi running [runit](http://smarden.org/runit/) (on Void).

## Disclaimer

These scripts are purpose-built for my specific use case, the paths are hardcoded and this is of no use on other
machines. I simply wanted to be transparent with what I built and current run on my server. Also, to be honest, wanted
to show off how well the entire ecosystem makes sure that nothing remains broken for long!

## Components

| Path                            | What it does                                                                                                                |
|---------------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| `bin/relaxy-health`             | Probes all 20 services, publishes three JSON feeds.                                                                         |
| `bin/relaxy-watchdog`           | Pets `/dev/watchdog`; runs health gates. (root)                                                                             |
| `bin/ssh-priority`              | Keeps sshd at top CPU/IO/OOM priority; loads the nft table. (root)                                                          |
| `lib/uptime-history.js`         | The uptime ledger: day buckets, incident detection, cause inference.                                                        |
| `lib/discord-outages.js`        | Mirrors every published incident into the Discord outages channel.                                                          |
| `bin/incident`                  | Declares / annotates an outage. Symlinked to `/usr/local/bin/incident`.                                                     |
| `bin/relaxy-uptime-seed`        | One-time backfill of history from existing `since` timestamps.                                                              |
| `bin/zram-swap`                 | Creates and reports the compressed RAM swap device. (root)                                                                  |
| `bin/apply-crash-fixes.sh`      | Boot config: reduced overclock, panic timeouts, shutdown watchdog arming.                                                   |
| `bin/build-error-page.mjs`      | Builds `error.html` from the dashboard's own CSS. (In case I change something and don't want to rewite the whole page again |
| `status/main.mjs`               | Reads the bot fleet out of MongoDB into `status.json`.                                                                      |
| `generate-website-commands.mjs` | Exports the bot's command catalogue to the website.                                                                         |
| `web/pi.html`                   | The Raspberry Pi stats page. This is for my personal use.                                                                   |
| `web/stats-index.html`          | The index beside it. This is also, for my personal use.                                                                     |
| `etc/nftables-ssh-prio.nft`     | Self-contained nft table, DSCP CS6 + band 0 for SSH.                                                                        |
| `etc/relaxy-watchdog.conf`      | Every tunable, for the watchdog and the announcer.                                                                          |

## License

MIT [LICENSE](LICENSE).

By MattFor
