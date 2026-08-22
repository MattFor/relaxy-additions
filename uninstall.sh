#!/usr/bin/env bash
set -Eeuo pipefail

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m==> FAILED:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root: sudo $0"

say "Stopping services"

if [ -L /var/service/relaxy-watchdog ]; then
    sv down relaxy-watchdog 2>/dev/null || true

    for _ in $(seq 1 15); do
        sv status relaxy-watchdog 2>/dev/null | grep -q '^down:' && break
        sleep 1
    done

    if sv status relaxy-watchdog 2>/dev/null | grep -q '^down:'; then
        ok "watchdog stopped cleanly (disarmed)"
    else
        warn "watchdog did not confirm a clean stop - do NOT reboot until you have checked it"
    fi
fi

for name in relaxy-health ssh-priority relaxy-watchdog; do
    if [ -L "/var/service/$name" ]; then
        sv down "$name" 2>/dev/null || true
        rm -f "/var/service/$name"
        ok "disabled $name"
    fi
done

sleep 2

say "Removing the SSH priority firewall table"

if nft list table inet ssh_prio >/dev/null 2>&1; then
    nft delete table inet ssh_prio && ok "removed table inet ssh_prio"
else
    warn "table inet ssh_prio was not loaded"
fi

say "Removing files"

for name in relaxy-health relaxy-watchdog ssh-priority; do
    rm -rf "/etc/sv/$name" && ok "removed /etc/sv/$name"
done

rm -f /etc/sudoers.d/relaxy-health && ok "removed the sudoers snippet"
rm -f /etc/nftables-ssh-prio.nft
rm -f /run/relaxy-watchdog.json
rm -f /home/mattfor/stats/pi.html && ok "removed pi.html"

warn "keeping /etc/relaxy-watchdog.conf and /var/log/relaxy-* (remove by hand if you want them gone)"

say "Restoring backups"

LATEST=$(ls -1d /var/backups/relaxy-ops/*/ 2>/dev/null | sort | tail -1 || true)

if [ -n "$LATEST" ]; then
    ok "most recent backup: $LATEST"

    if [ -f "$LATEST/config.txt" ]; then
        cp -a "$LATEST/config.txt" /boot/config.txt
        ok "restored /boot/config.txt (original overclock; takes effect on reboot)"
    fi

    if [ -f "$LATEST/stats-index.html" ]; then
        cp -a "$LATEST/stats-index.html" /home/mattfor/stats/index.html
        ok "restored the stats index page"
    fi
else
    warn "no backups found under /var/backups/relaxy-ops - nothing to restore"
fi

echo
ok "uninstalled. The watchdog was disarmed cleanly - nothing will reset."
say "Priorities already applied to running processes clear on reboot."
