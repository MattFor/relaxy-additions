#!/usr/bin/env bash
set -Eeuo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="/var/backups/relaxy-ops/$(date +%Y%m%d-%H%M%S)"

SERVICE_USER=mattfor
STATS_DIR=/home/mattfor/stats
STATS_GROUP=caddyread

TARGET_ARM_FREQ=1700
TARGET_OVER_VOLTAGE=4

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m==> FAILED:\033[0m %s\n' "$*" >&2; exit 1; }

trap 'die "aborted on line $LINENO"' ERR

[ "$(id -u)" -eq 0 ] || die "must run as root: sudo $0"

say "Preflight"

for file in \
    "$SRC/bin/relaxy-health" "$SRC/bin/relaxy-watchdog" "$SRC/bin/ssh-priority" \
    "$SRC/sv/relaxy-health/run" "$SRC/sv/relaxy-watchdog/run" "$SRC/sv/ssh-priority/run" \
    "$SRC/etc/relaxy-watchdog.conf" "$SRC/etc/nftables-ssh-prio.nft" \
    "$SRC/etc/sudoers-relaxy-health" "$SRC/web/pi.html" "$SRC/web/stats-index.html" \
    "$SRC/bin/incident" "$SRC/lib/uptime-history.js" "$SRC/lib/discord-outages.js"
do
    [ -r "$file" ] || die "missing source file: $file"
done
ok "all source files present"

bash -n "$SRC/bin/relaxy-watchdog" || die "relaxy-watchdog has a syntax error"
bash -n "$SRC/bin/ssh-priority"    || die "ssh-priority has a syntax error"
sh   -n "$SRC/sv/relaxy-health/run"    || die "relaxy-health run script has a syntax error"
sh   -n "$SRC/sv/relaxy-watchdog/run"  || die "relaxy-watchdog run script has a syntax error"
sh   -n "$SRC/sv/ssh-priority/run"     || die "ssh-priority run script has a syntax error"
ok "shell syntax clean"

NODE=$(ls -d /home/mattfor/.config/nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)
[ -x "$NODE" ] || NODE=$(command -v node || true)
[ -x "$NODE" ] || die "no node interpreter found - the health service needs one"
"$NODE" --check "$SRC/bin/relaxy-health" || die "relaxy-health has a syntax error"

for script in "$SRC/bin/incident" "$SRC/lib/uptime-history.js" "$SRC/lib/discord-outages.js"; do
    "$NODE" --check "$script" || die "$(basename "$script") has a syntax error"
done
ok "node syntax clean ($("$NODE" -v))"

visudo -cf "$SRC/etc/sudoers-relaxy-health" >/dev/null || die "the sudoers snippet is malformed - refusing to install it"
ok "sudoers snippet validates"

nft -c -f "$SRC/etc/nftables-ssh-prio.nft" >/dev/null || die "the nftables rules do not parse"
ok "nftables rules parse"

[ -c /dev/watchdog ] || warn "/dev/watchdog is missing - the watchdog service will not start"

mkdir -p "$BACKUP_DIR"
ok "backups will be written to $BACKUP_DIR"

say "Installing configuration"

for _enc in "$SRC"/etc/*; do
    if head -c 10 "$_enc" 2>/dev/null | grep -qa GITCRYPT; then
        die "$_enc is still git-crypt encrypted - run 'git-crypt unlock <keyfile>' in $SRC first"
    fi
done
unset _enc

if [ -f /etc/relaxy-watchdog.conf ]; then
    warn "/etc/relaxy-watchdog.conf already exists - keeping your version"
    cp -a /etc/relaxy-watchdog.conf "$BACKUP_DIR/"
else
    install -m 0644 "$SRC/etc/relaxy-watchdog.conf" /etc/relaxy-watchdog.conf
    ok "installed /etc/relaxy-watchdog.conf (ARM_REBOOT=0, observe mode)"
fi

install -m 0644 "$SRC/etc/nftables-ssh-prio.nft" /etc/nftables-ssh-prio.nft
ok "installed /etc/nftables-ssh-prio.nft"

[ -f /etc/sudoers.d/relaxy-health ] && cp -a /etc/sudoers.d/relaxy-health "$BACKUP_DIR/"
install -m 0440 -o root -g root "$SRC/etc/sudoers-relaxy-health" /etc/sudoers.d/relaxy-health

if ! visudo -c >/dev/null; then
    rm -f /etc/sudoers.d/relaxy-health
    die "installing the sudoers snippet broke the sudoers tree - it has been removed"
fi
ok "installed /etc/sudoers.d/relaxy-health (sv status, read-only)"

say "Installing binaries"

install -d -m 0755 /home/mattfor/relaxy/additions/var
chown "$SERVICE_USER":"$SERVICE_USER" /home/mattfor/relaxy/additions/var
for binary in relaxy-health relaxy-watchdog ssh-priority; do
    chmod 0755 "$SRC/bin/$binary"
done
ok "binaries marked executable (they run from $SRC/bin)"

say "Installing runit services"

install_service()
{
    local name="$1"

    install -d -m 0755 "/etc/sv/$name" "/etc/sv/$name/log"
    install -m 0755 "$SRC/sv/$name/run" "/etc/sv/$name/run"

    cat > "/etc/sv/$name/log/run" <<EOF
#!/bin/sh
exec svlogd -tt /var/log/$name
EOF
    chmod 0755 "/etc/sv/$name/log/run"
    install -d -m 0755 "/var/log/$name"

    ok "installed /etc/sv/$name"
}

install_service relaxy-health
install_service relaxy-watchdog
install_service ssh-priority

say "Installing web pages"

install -m 0644 "$SRC/web/pi.html" "$STATS_DIR/pi.html"
chown "$SERVICE_USER":"$STATS_GROUP" "$STATS_DIR/pi.html"
ok "installed $STATS_DIR/pi.html"

if [ -f "$STATS_DIR/index.html" ]; then
    cp -a "$STATS_DIR/index.html" "$BACKUP_DIR/stats-index.html"
fi
install -m 0644 "$SRC/web/stats-index.html" "$STATS_DIR/index.html"
chown "$SERVICE_USER":"$STATS_GROUP" "$STATS_DIR/index.html"
ok "updated $STATS_DIR/index.html (backed up)"

ok "no Caddyfile change required"

say "Reducing the overclock"

CONFIG_TXT=/boot/config.txt

if [ -f "$CONFIG_TXT" ]; then
    cp -a "$CONFIG_TXT" "$BACKUP_DIR/config.txt"

    current_freq=$(grep -oP '^\s*arm_freq=\K\d+' "$CONFIG_TXT" | tail -1 || true)
    current_volt=$(grep -oP '^\s*over_voltage=\K\d+' "$CONFIG_TXT" | tail -1 || true)

    changed=0

    if [ -n "$current_freq" ] && [ "$current_freq" -gt "$TARGET_ARM_FREQ" ]; then
        sed -i "s/^\s*arm_freq=.*/arm_freq=$TARGET_ARM_FREQ/" "$CONFIG_TXT"
        ok "arm_freq: $current_freq -> $TARGET_ARM_FREQ MHz"
        changed=1
    else
        warn "arm_freq is ${current_freq:-unset} - leaving it alone"
    fi

    if [ -n "$current_volt" ] && [ "$current_volt" -gt "$TARGET_OVER_VOLTAGE" ]; then
        sed -i "s/^\s*over_voltage=.*/over_voltage=$TARGET_OVER_VOLTAGE/" "$CONFIG_TXT"
        ok "over_voltage: $current_volt -> $TARGET_OVER_VOLTAGE"
        changed=1
    else
        warn "over_voltage is ${current_volt:-unset} - leaving it alone"
    fi

    [ "$changed" = "1" ] && warn "these take effect on the NEXT REBOOT"
else
    warn "$CONFIG_TXT not found - skipping the overclock change"
fi

say "Enabling services"

enable_service()
{
    local name="$1"

    if [ ! -L "/var/service/$name" ]; then
        ln -s "/etc/sv/$name" /var/service/
        ok "linked $name"

        local waited=0
        while [ ! -d "/etc/sv/$name/supervise" ] && [ "$waited" -lt 20 ]; do
            sleep 1
            waited=$((waited + 1))
        done
    fi

    rm -f "/etc/sv/$name/down"

    if sv status "$name" 2>/dev/null | grep -q '^run:'; then
        if sv restart "$name" >/dev/null 2>&1; then
            ok "restarted $name (running the newly installed version)"
        else
            warn "could not restart $name"
        fi
    else
        if sv up "$name" >/dev/null 2>&1; then
            ok "started $name"
        else
            warn "could not start $name"
        fi
    fi
}

enable_service ssh-priority
enable_service relaxy-health

if [ -c /dev/watchdog ]; then
    enable_service relaxy-watchdog
else
    warn "skipping relaxy-watchdog - no /dev/watchdog on this system"
fi

say "Waiting for services to come up..."
sleep 8

for name in ssh-priority relaxy-health relaxy-watchdog; do
    [ -L "/var/service/$name" ] || continue

    if sv status "$name" 2>/dev/null | grep -q '^run:'; then
        ok "$name is running"
    else
        warn "$name is NOT running; check /var/log/$name/current"
    fi
done

echo
ok "installed! Now reboot."
