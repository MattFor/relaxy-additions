#!/usr/bin/env bash
set -Eeuo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m==> FAILED:\033[0m %s\n' "$*" >&2; exit 1; }

trap 'die "aborted on line $LINENO"' ERR

[ "$(id -u)" -eq 0 ] || die "must run as root: sudo $0"

say "Preflight"

bash -n "$SRC/bin/zram-swap" || die "zram-swap has a syntax error"
sh -n "$SRC/sv/zram-swap/run" || die "the run script has a syntax error"
sh -n "$SRC/sv/zram-swap/finish" || die "the finish script has a syntax error"
ok "syntax clean"

modinfo zram >/dev/null 2>&1 || die "the zram kernel module is not available on this kernel"
ok "zram module available"

if swapon --show=NAME --noheadings 2>/dev/null | grep -q .; then
    warn "swap is already active:"
    swapon --show
fi

mem_gb=$(awk '/^MemTotal:/{printf "%.1f", $2/1048576}' /proc/meminfo)
ok "physical memory: ${mem_gb} GB (zram will be sized at 50% of it)"

say "Installing the service"

install -d -m 0755 /etc/sv/zram-swap /etc/sv/zram-swap/log
install -m 0755 "$SRC/sv/zram-swap/run" /etc/sv/zram-swap/run
install -m 0755 "$SRC/sv/zram-swap/finish" /etc/sv/zram-swap/finish

cat > /etc/sv/zram-swap/log/run <<'EOF'
#!/bin/sh
exec svlogd -tt /var/log/zram-swap
EOF
chmod 0755 /etc/sv/zram-swap/log/run
install -d -m 0755 /var/log/zram-swap
chmod 0755 "$SRC/bin/zram-swap"
ok "installed /etc/sv/zram-swap"

say "Enabling"

if [ ! -L /var/service/zram-swap ]; then
    ln -s /etc/sv/zram-swap /var/service/
    ok "enabled zram-swap"
else
    warn "already enabled"
fi

say "Waiting for the device to come up..."
sleep 6

if sv status zram-swap 2>/dev/null | grep -q '^run:'; then
    ok "service is running"
else
    warn "service is NOT running; check /var/log/zram-swap/current"
fi

echo
if "$SRC/bin/zram-swap" status; then
    echo
    ok "zram swap is live"
else
    die "the service started but no zram swap is active; check /var/log/zram-swap/current"
fi

echo
ok "compressed swap is live."
say "Status: $SRC/bin/zram-swap status"
