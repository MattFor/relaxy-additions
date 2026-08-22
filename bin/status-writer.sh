#!/usr/bin/env bash
set -eu

OUT="${1:-/home/mattfor/relaxy/website/status.json}"
INTERVAL="${2:-10}"
HOST="$(hostname)"

os_name()
{
    ( . /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-Linux}" )
}

cpu_snapshot()
{
    local cpu user nice system idle iowait irq softirq steal rest
    read -r cpu user nice system idle iowait irq softirq steal rest < /proc/stat
    local total=$((user + nice + system + idle + iowait + irq + softirq + steal))
    printf '%s %s' "$idle" "$total"
}

while true; do
    read -r idle1 total1 <<< "$(cpu_snapshot)"
    sleep "$INTERVAL"
    read -r idle2 total2 <<< "$(cpu_snapshot)"

    ddiff=$((total2 - total1))
    load=0
    if [ "$ddiff" -gt 0 ]; then
        load=$(( (100 * (ddiff - (idle2 - idle1))) / ddiff ))
    fi

    cores="$(nproc)"
    kernel="$(uname -r)"
    arch="$(uname -m)"
    uptime="$(cut -d. -f1 /proc/uptime)"

    memtotal="$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
    memavail="$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)"
    memused=$((memtotal - memavail))
    totalgb="$(awk "BEGIN{printf \"%.1f\", $memtotal/1048576}")"
    usedgb="$(awk "BEGIN{printf \"%.1f\", $memused/1048576}")"
    mempct=$(( (100 * memused) / memtotal ))

    temp="null"
    if [ -r /sys/class/thermal/thermal_zone0/temp ]; then
        raw="$(cat /sys/class/thermal/thermal_zone0/temp)"
        temp="$(awk "BEGIN{printf \"%.1f\", $raw/1000}")"
    fi

    tmp="$(mktemp)"
    cat > "$tmp" <<EOF
{
  "host": "$HOST",
  "os": "$(os_name)",
  "kernel": "$kernel",
  "arch": "$arch",
  "uptimeSeconds": $uptime,
  "temperatureC": $temp,
  "cpu": { "cores": $cores, "load": $load },
  "memory": { "usedGb": $usedgb, "totalGb": $totalgb, "percent": $mempct }
}
EOF
    mv "$tmp" "$OUT"
done
