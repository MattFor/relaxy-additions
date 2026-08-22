'use strict';

const {
    readFile,
    writeFile,
    rename,
    mkdir
} = require('node:fs/promises');
const path = require('node:path');

const WINDOW_DAYS = 90;

const STALE_AFTER_MS = 60000;

const LATENCY_SAMPLES = 60;

const IMPACT_RANK = {
    maintenance: 0,
    minor:       1,
    major:       2,
    critical:    3
};

const IMPACTS = Object.keys(IMPACT_RANK);

const UPDATE_STATUSES = [
    'investigating',
    'identified',
    'monitoring',
    'update',
    'resolved'
];

const INCIDENT_AFTER_MS = 60000;

const DAY_PARTIAL_LIMIT_SECONDS = 300;

const FRESH_BOOT_SECONDS = 180;

const HOST_WIDE_THRESHOLD = 3;

const CLOCK_FLOOR_MS = Date.parse('2026-01-01T00:00:00Z');
const CLOCK_BACKSTEP_MS = 300000;

const RESTART_WINDOW_MS = 600000;

const RESTART_CREDIT_MAX_MS = 1800000;

const GROUP_WITHIN_MS = 120000;

const REPEAT_WITHIN_MS = Number(process.env.UPTIME_REPEAT_WITHIN_MS ?? 3600000);

const DEGRADE_SPAN_MS = Number(process.env.UPTIME_DEGRADE_SPAN_MS ?? 21600000);

const repeatRuns = (list, now, describe) =>
{
    const runs = [];
    const open = new Map();

    const ordered = [...list].sort((a, b) => Date.parse(describe(a).startedAt) - Date.parse(describe(b).startedAt));

    for (const incident of ordered)
    {
        const info = describe(incident);

        if (!info.repeatable)
        {
            runs.push({ members: [incident] });

            continue;
        }

        const key = `${info.service} ${info.causeCode}`;
        const startedAt = Date.parse(info.startedAt);
        const endedAt = info.endedAt
            ? Date.parse(info.endedAt)
            : now;
        const run = open.get(key);

        if (run && !info.annotated && (startedAt - run.endedAt <= REPEAT_WITHIN_MS || (run.members.length > 1 && endedAt - run.startedAt <= DEGRADE_SPAN_MS)))
        {
            run.members.push(incident);
            run.endedAt = Math.max(run.endedAt, endedAt);

            continue;
        }

        const fresh = {
            startedAt,
            endedAt,
            members: [incident]
        };

        runs.push(fresh);
        open.set(key, fresh);
    }

    return runs;
};

const MEMORY_PRESSURE_PERCENT = 92;
const THERMAL_LIMIT_C = 80;

const readJson = async (file, fallback) =>
{
    try
    {
        return JSON.parse(await readFile(file, 'utf8'));
    }
    catch
    {
        return fallback;
    }
};

const writeJson = async (file, payload, {
    mode = 0o644,
    pretty = true
} = {}) =>
{
    const temporary = `${file}.tmp`;
    const body = pretty
        ? JSON.stringify(payload, null, 2)
        : JSON.stringify(payload);

    await mkdir(path.dirname(file), { recursive: true }).catch(() => {});
    await writeFile(temporary, `${body}\n`, {
        encoding: 'utf8',
        mode
    });
    await rename(temporary, file);
};

const round = (value, places = 2) =>
{
    const factor = 10 ** places;

    return Math.round(value * factor) / factor;
};

const dayKey = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

const shiftDay = (key, days) =>
{
    const date = new Date(`${key}T00:00:00Z`);

    date.setUTCDate(date.getUTCDate() + days);

    return date.toISOString().slice(0, 10);
};

const formatDuration = (seconds) =>
{
    if (seconds < 60)
    {
        return `${Math.max(1, Math.round(seconds))}s`;
    }

    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0)
    {
        return `${days}d ${hours}h`;
    }

    return hours > 0
        ? `${hours}h ${minutes}m`
        : `${minutes}m`;
};

const normalizeNotes = (raw) =>
{
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    {
        return {
            version: 2,
            notes:   {},
            manual:  []
        };
    }

    if (raw.version === 2 || raw.notes || raw.manual)
    {
        return {
            version: 2,
            notes:   raw.notes && typeof raw.notes === 'object'
                         ? raw.notes
                         : {},
            manual:  Array.isArray(raw.manual)
                         ? raw.manual
                         : []
        };
    }

    return {
        version: 2,
        notes:   raw,
        manual:  []
    };
};

const sanitiseUpdates = (list, resolution = null) =>
{
    const closing = typeof resolution === 'string'
        ? resolution.trim()
        : '';

    return (Array.isArray(list)
        ? list
        : [])
        .filter((update) => update && typeof update.body === 'string' && update.body.trim())
        .map((update) => ({
            at:     typeof update.at === 'string' && !Number.isNaN(Date.parse(update.at))
                        ? update.at
                        : new Date().toISOString(),
            status: UPDATE_STATUSES.includes(update.status)
                        ? update.status
                        : 'update',
            body:   update.body.trim()
        }))
        .filter((update) => !(update.status === 'resolved' && update.body === closing))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
};

const lastFieldWrite = (record) =>
{
    const written = Date.parse(record.updatedAt);

    if (!Number.isFinite(written))
    {
        return null;
    }

    const newestUpdate = (Array.isArray(record.updates)
        ? record.updates
        : [])
        .reduce((newest, update) => Math.max(newest, Date.parse(update?.at) || 0), 0);

    return written > newestUpdate
        ? record.updatedAt
        : null;
};

const noteWrittenAt = (record) =>
{
    if (typeof record.noteAt === 'string')
    {
        return record.noteAt;
    }

    return record.resolution
        ? null
        : lastFieldWrite(record);
};

const resolutionWrittenAt = (record) =>
{
    if (typeof record.resolutionAt === 'string')
    {
        return record.resolutionAt;
    }

    const closing = typeof record.resolution === 'string'
        ? record.resolution.trim()
        : '';

    const echo = (Array.isArray(record.updates)
        ? record.updates
        : [])
        .find((update) => update && update.status === 'resolved' && typeof update.body === 'string' && update.body.trim() === closing && typeof update.at === 'string' && !Number.isNaN(Date.parse(update.at)));

    return echo
        ? echo.at
        : lastFieldWrite(record);
};

const CAUSE_TEXT = {
    'host-reboot':   'The server rebooted. Everything on it restarted together.',
    'host-wide':     'Several services failed at the same moment, which points at server issues rather than at any one of them.',
    'watchdog':      'The hardware watchdog reset the board after it stopped responding.',
    'out-of-memory': 'The server ran out of memory and the kernel started reclaiming it from running processes.',
    'undervoltage':  'The power supply dipped below the voltage the board needs to run reliably.',
    'thermal':       'The board got hot enough to throttle.',
    'process-exit':  'The service process exited and was restarted by its supervisor.',
    'unresponsive':  'The process was still running but stopped answering, so it was treated as down.',
    'unreachable':   'The service stopped answering its health check.',

    'database-unreachable': 'The database stopped answering.',
    'bot-offline':          'No machine in the fleet was running the bot.',
    'offsite':              'This service does not run on the machine that watches it, so no local cause could be determined.',

    'unknown': 'Cause not determined automatically.'
};

const inferCause = ({
    service,
    simultaneous,
    system,
    watchdog
}) =>
{
    const supervisor = service.supervisor ?? null;
    const memoryPercent = system?.memory?.percent ?? null;
    const uptimeSeconds = system?.uptimeSeconds ?? null;
    const temperature = system?.temperatureC ?? null;

    const at = (code, confidence) => ({
        code,
        confidence,
        summary: CAUSE_TEXT[code],

        evidence: {
            detail:       service.detail ?? null,
            remote:       Boolean(service.remote),
            supervisor,
            simultaneous,
            memoryPercent,
            temperatureC: temperature,
            uptimeSeconds,
            undervoltage: system?.undervoltage ?? null
        }
    });

    if (service.remote)
    {
        return at(CAUSE_TEXT[service.causeHint]
            ? service.causeHint
            : 'offsite', 'low');
    }

    if (watchdog?.resetPending === true || watchdog?.tripped === true)
    {
        return at('watchdog', 'high');
    }

    if (uptimeSeconds != null && uptimeSeconds < FRESH_BOOT_SECONDS)
    {
        return at('host-reboot', 'high');
    }

    if (system?.undervoltage === true)
    {
        return at('undervoltage', 'high');
    }

    if (memoryPercent != null && memoryPercent >= MEMORY_PRESSURE_PERCENT)
    {
        return at('out-of-memory', 'medium');
    }

    if (temperature != null && temperature >= THERMAL_LIMIT_C)
    {
        return at('thermal', 'medium');
    }

    if (simultaneous >= HOST_WIDE_THRESHOLD)
    {
        return at('host-wide', 'medium');
    }

    if (supervisor && supervisor.state && supervisor.state !== 'run' && supervisor.state !== 'running')
    {
        return at('process-exit', 'high');
    }

    if (supervisor && (supervisor.state === 'run' || supervisor.state === 'running'))
    {
        return at('unresponsive', 'high');
    }

    return at(service.detail
        ? 'unreachable'
        : 'unknown', 'low');
};

const autoImpact = (durationSeconds, ongoing) =>
{
    if (ongoing || durationSeconds >= 3600)
    {
        return 'critical';
    }

    if (durationSeconds >= 300)
    {
        return 'major';
    }

    return 'minor';
};

const autoTitle = (serviceName, cause, ongoing) =>
{
    if (cause.code === 'host-reboot' || cause.code === 'watchdog')
    {
        return `${serviceName} restarted with the host`;
    }

    if (cause.code === 'host-wide')
    {
        return `${serviceName} affected by a host-wide failure`;
    }

    return ongoing
        ? `${serviceName} is not responding`
        : `${serviceName} outage`;
};

const HOST_TITLE = {
    'host-reboot': 'The host restarted',
    watchdog:      'The hardware watchdog reset the host'
};

const GROUPABLE_CAUSES = new Set([
    'host-reboot',
    'watchdog',
    'host-wide',
    'out-of-memory',
    'undervoltage',
    'thermal'
]);

const GROUP_TITLE = {
    'host-reboot':   'The host restarted',
    watchdog:        'The hardware watchdog reset the host',
    'host-wide':     'Several services failed together',
    'out-of-memory': 'The host ran out of memory',
    undervoltage:    'The power supply dipped',
    thermal:         'The board overheated'
};

const createLedger = ({
    stateFile,
    notesFile,
    publicFile,
    windowDays = WINDOW_DAYS,
    incidentAfterMs = INCIDENT_AFTER_MS
}) =>
{
    let state = {
        version:    4,
        days:       {},
        incidents:  [],
        pending:    {},
        samples:    {},
        sampledAt:  {},
        lastDown:   {},
        lastTickAt: null,
        bootAt:     null
    };

    let notes = {
        version: 2,
        notes:   {},
        manual:  []
    };
    let notesReadAt = 0;
    let dirty = false;

    const clockUsable = (now) => Number.isFinite(now) && now >= CLOCK_FLOOR_MS && now >= (state.lastTickAt ?? 0) - CLOCK_BACKSTEP_MS;

    const purgeUntimed = () =>
    {
        const before = state.incidents.length;

        state.incidents = state.incidents.filter((incident) => Date.parse(incident.startedAt) >= CLOCK_FLOOR_MS);

        let removed = before - state.incidents.length;
        const floorDay = dayKey(CLOCK_FLOOR_MS);

        for (const key of Object.keys(state.days))
        {
            for (const day of Object.keys(state.days[key]))
            {
                if (day < floorDay)
                {
                    delete state.days[key][day];
                    removed += 1;
                }
            }
        }

        for (const [key, pending] of Object.entries(state.pending))
        {
            if (!(pending?.since >= CLOCK_FLOOR_MS))
            {
                delete state.pending[key];
                removed += 1;
            }
        }

        for (const [key, at] of Object.entries(state.lastDown))
        {
            if (!(at >= CLOCK_FLOOR_MS))
            {
                delete state.lastDown[key];
                removed += 1;
            }
        }

        if (!(state.lastTickAt >= CLOCK_FLOOR_MS))
        {
            removed += state.lastTickAt == null
                ? 0
                : 1;
            state.lastTickAt = null;
        }

        if (!(state.bootAt >= CLOCK_FLOOR_MS))
        {
            state.bootAt = null;
        }

        if (removed)
        {
            dirty = true;
        }

        return removed;
    };

    const load = async () =>
    {
        const loaded = await readJson(stateFile, null);

        if (loaded && typeof loaded === 'object')
        {

            state = {
                version:   4,
                days:      loaded.days ?? {},
                incidents: Array.isArray(loaded.incidents)
                               ? loaded.incidents
                               : [],

                pending: loaded.pending ?? {},

                samples: loaded.samples ?? {},

                sampledAt: loaded.sampledAt ?? {},

                lastDown:   loaded.lastDown ?? {},
                lastTickAt: loaded.lastTickAt ?? null,

                bootAt: loaded.bootAt ?? null
            };
        }

        const purged = purgeUntimed();

        if (purged)
        {
            console.error(`[uptime-history] dropped ${purged} record(s) written before the clock was set`);
        }

        notes = normalizeNotes(await readJson(notesFile, null));
        notesReadAt = Date.now();
    };

    const prune = (now) =>
    {
        const cutoff = shiftDay(dayKey(now), -(windowDays - 1));

        for (const key of Object.keys(state.days))
        {
            for (const day of Object.keys(state.days[key]))
            {
                if (day < cutoff)
                {
                    delete state.days[key][day];
                }
            }

            if (!Object.keys(state.days[key]).length)
            {
                delete state.days[key];
                delete state.samples[key];
                delete state.sampledAt[key];
                delete state.lastDown[key];
            }
        }

        state.incidents = state.incidents.filter((incident) => !incident.endedAt || dayKey(incident.endedAt) >= cutoff);
    };

    const bucketFor = (key, day) =>
    {
        state.days[key] ??= {};

        const bucket = state.days[key][day] ??= {
            up:      0,
            down:    0,
            unknown: 0
        };

        bucket.restart ??= 0;
        bucket.latSum ??= 0;
        bucket.latN ??= 0;
        bucket.latMin ??= null;
        bucket.latMax ??= null;

        return bucket;
    };

    const creditLatency = (key, day, ms) =>
    {
        const bucket = bucketFor(key, day);

        bucket.latSum += ms;
        bucket.latN += 1;
        bucket.latMin = bucket.latMin == null
            ? ms
            : Math.min(bucket.latMin, ms);
        bucket.latMax = bucket.latMax == null
            ? ms
            : Math.max(bucket.latMax, ms);
    };

    const pushSample = (key, ms) =>
    {
        if (ms == null && !state.samples[key])
        {
            return;
        }

        const ring = state.samples[key] ??= [];

        ring.push(ms);

        if (ring.length > LATENCY_SAMPLES)
        {
            ring.splice(0, ring.length - LATENCY_SAMPLES);
        }
    };

    const freshLatency = (service, now) =>
    {
        if (service.online !== true || typeof service.latencyMs !== 'number' || !Number.isFinite(service.latencyMs) || service.latencyMs < 0)
        {
            return null;
        }

        const at = Number.isFinite(service.latencyAt)
            ? service.latencyAt
            : now;

        if (state.sampledAt[service.key] === at)
        {
            return null;
        }

        return {
            ms: Math.round(service.latencyMs),
            at
        };
    };

    const credit = (key, bucket, fromMs, toMs) =>
    {
        let cursor = fromMs;

        while (cursor < toMs)
        {
            const day = dayKey(cursor);
            const midnight = Date.parse(`${shiftDay(day, 1)}T00:00:00Z`);
            const slice = Math.min(toMs, midnight) - cursor;

            bucketFor(key, day)[bucket] += slice / 1000;
            cursor += slice;
        }
    };

    const record = ({
        now,
        services,
        system,
        watchdog
    }) =>
    {

        if (!clockUsable(now))
        {
            return;
        }

        const previous = state.lastTickAt;
        const elapsedMs = previous
            ? now - previous
            : 0;

        const observedMs = Math.min(Math.max(elapsedMs, 0), STALE_AFTER_MS);
        const unobservedMs = Math.max(elapsedMs - observedMs, 0);

        const bootAt = Number.isFinite(system?.uptimeSeconds)
            ? now - (system.uptimeSeconds * 1000)
            : null;

        const rebooted = previous != null && bootAt != null && bootAt > previous && bootAt <= now && bootAt !== state.bootAt;

        const restartUntil = rebooted
            ? Math.min(now, bootAt + RESTART_CREDIT_MAX_MS)
            : null;

        const justFailed = services.filter((service) => service.online === false && !state.pending[service.key] && !state.incidents.some((incident) => incident.service === service.key && !incident.endedAt));

        const today = dayKey(now);

        if (rebooted)
        {
            const tripped = watchdog?.resetPending === true || watchdog?.tripped === true;
            const code = tripped
                ? 'watchdog'
                : 'host-reboot';

            state.incidents.push({
                id: `host-restart-${new Date(bootAt).toISOString().replace(/[:.]/g, '-')}`,

                scope:           'host',
                service:         null,
                serviceName:     'The host',
                startedAt:       new Date(bootAt).toISOString(),
                endedAt:         null,
                durationSeconds: null,
                cause:           {
                    code,
                    confidence: 'high',
                    summary:    CAUSE_TEXT[code],
                    evidence:   {
                        uptimeSeconds: system?.uptimeSeconds ?? null,
                        undervoltage:  system?.undervoltage ?? null,
                        memoryPercent: system?.memory?.percent ?? null,
                        temperatureC:  system?.temperatureC ?? null,
                        gapSeconds:    Math.round((now - previous) / 1000)
                    }
                },

                affected: services
                              .filter((service) => !service.remote)
                              .map((service) => ({
                                  key:      service.key,
                                  name:     service.name,
                                  downFrom: bootAt,
                                  downTo:   service.online === true
                                                ? now
                                                : null
                              }))
            });

            state.bootAt = bootAt;
            dirty = true;
        }

        const hostOpen = state.incidents.find((incident) => incident.scope === 'host' && !incident.endedAt);

        for (const service of services)
        {
            if (rebooted)
            {

                credit(service.key, 'unknown', previous, bootAt);

                if (service.remote)
                {

                    credit(service.key, 'unknown', bootAt, now);
                }
                else
                {
                    credit(service.key, 'down', bootAt, restartUntil);
                    credit(service.key, 'restart', bootAt, restartUntil);

                    if (restartUntil < now)
                    {
                        credit(service.key, 'unknown', restartUntil, now);
                    }
                }
            }
            else
            {
                if (previous && unobservedMs > 0)
                {
                    credit(service.key, 'unknown', previous, previous + unobservedMs);
                }

                if (previous && observedMs > 0)
                {
                    const bucket = service.online === true
                        ? 'up'
                        : service.online === false
                            ? 'down'
                            : 'unknown';

                    credit(service.key, bucket, now - observedMs, now);
                }
            }

            const fresh = freshLatency(service, now);

            if (fresh)
            {
                creditLatency(service.key, today, fresh.ms);
                state.sampledAt[service.key] = fresh.at;
                pushSample(service.key, fresh.ms);
            }
            else if (service.online !== true)
            {

                pushSample(service.key, null);
            }

            if (service.online === false)
            {
                state.lastDown[service.key] = now;
            }

            const open = state.incidents.find((incident) => incident.service === service.key && !incident.endedAt);

            if (hostOpen && !service.remote)
            {
                const entry = hostOpen.affected.find((item) => item.key === service.key);

                if (entry && entry.downTo == null && service.online === true)
                {
                    entry.downTo = now;
                    dirty = true;
                }

                if (state.pending[service.key])
                {
                    delete state.pending[service.key];
                    dirty = true;
                }

                if (open && service.online === true)
                {
                    open.endedAt = new Date(now).toISOString();
                    open.durationSeconds = round((now - Date.parse(open.startedAt)) / 1000, 0);
                    dirty = true;
                }

                continue;
            }

            if (service.online === false && !open)
            {
                const pending = state.pending[service.key];

                if (!pending)
                {

                    state.pending[service.key] = {
                        since: now,
                        cause: inferCause({
                            service,
                            simultaneous: justFailed.length,
                            system,
                            watchdog
                        })
                    };

                    dirty = true;
                }
                else if (now - pending.since >= incidentAfterMs)
                {
                    state.incidents.push({
                        id:          `${new Date(pending.since).toISOString().replace(/[:.]/g, '-')}-${service.key}`,
                        service:     service.key,
                        serviceName: service.name,

                        startedAt:       new Date(pending.since).toISOString(),
                        endedAt:         null,
                        durationSeconds: null,
                        cause:           pending.cause
                    });

                    delete state.pending[service.key];
                    dirty = true;
                }
            }
            else if (service.online === true)
            {

                if (state.pending[service.key])
                {
                    delete state.pending[service.key];
                    dirty = true;
                }

                if (open)
                {
                    open.endedAt = new Date(now).toISOString();
                    open.durationSeconds = round((now - Date.parse(open.startedAt)) / 1000, 0);
                    dirty = true;
                }
            }
        }

        if (hostOpen)
        {
            const startedAt = Date.parse(hostOpen.startedAt);
            const settled = hostOpen.affected.every((entry) => entry.downTo != null);
            const expired = now - startedAt >= RESTART_WINDOW_MS;

            if (settled || expired)
            {

                const endedAt = settled
                    ? hostOpen.affected.reduce((latest, entry) => Math.max(latest, entry.downTo), startedAt)
                    : now;

                hostOpen.endedAt = new Date(endedAt).toISOString();
                hostOpen.durationSeconds = round((endedAt - startedAt) / 1000, 0);
                dirty = true;
            }
        }

        state.lastTickAt = now;
        prune(now);
    };

    const uptimeOver = (key, today, days) =>
    {
        const buckets = state.days[key] ?? {};
        let up = 0;
        let down = 0;
        let unknown = 0;

        for (let offset = 0; offset < days; offset += 1)
        {
            const bucket = buckets[shiftDay(today, -offset)];

            if (!bucket)
            {
                continue;
            }

            up += bucket.up;
            down += bucket.down;
            unknown += bucket.unknown ?? 0;
        }

        const observed = up + down;

        return {
            upSeconds:       Math.round(up),
            downSeconds:     Math.round(down),
            unknownSeconds:  Math.round(unknown),
            observedSeconds: Math.round(observed),

            uptimePercent: observed > 0
                               ? round((100 * up) / observed, 10)
                               : null,

            observedPercent: observed + unknown > 0
                                 ? round((100 * observed) / (observed + unknown), 2)
                                 : null
        };
    };

    const uptimeSpans = (key, today) =>
    {
        const spans = {
            today:  uptimeOver(key, today, 1),
            days7:  uptimeOver(key, today, Math.min(7, windowDays)),
            days30: uptimeOver(key, today, Math.min(30, windowDays)),
            window: uptimeOver(key, today, windowDays)
        };

        return spans;
    };

    const outageStats = (key, now) =>
    {

        const mine = state.incidents.flatMap((incident) =>
        {
            if (incident.service === key)
            {
                return [incident];
            }

            const entry = incident.scope === 'host'
                ? (incident.affected ?? []).find((item) => item.key === key)
                : null;

            return entry
                ? [
                    {
                        startedAt:       new Date(entry.downFrom).toISOString(),
                        endedAt:         entry.downTo
                                             ? new Date(entry.downTo).toISOString()
                                             : null,
                        durationSeconds: entry.downTo
                                             ? Math.round((entry.downTo - entry.downFrom) / 1000)
                                             : null
                    }
                ]
                : [];
        });

        const durations = mine.map((incident) => (incident.endedAt
            ? incident.durationSeconds ?? 0
            : Math.round((now - Date.parse(incident.startedAt)) / 1000)));

        const ended = mine.filter((incident) => incident.endedAt);

        return {
            count:          mine.length,
            longestSeconds: durations.length
                                ? Math.max(...durations)
                                : 0,
            lastAt:         mine.length
                                ? mine.map((incident) => incident.startedAt).sort().at(-1)
                                : null,

            lastEndedAt: ended.length
                             ? ended.map((incident) => incident.endedAt).sort().at(-1)
                             : null,

            meanRecoverySeconds: ended.length
                                     ? Math.round(ended.reduce((total, incident) => total + (incident.durationSeconds ?? 0), 0) / ended.length)
                                     : null
        };
    };

    const currentStreak = (key, now, lastEndedAt) =>
    {
        const marker = state.lastDown[key];

        const since = Number.isFinite(marker)
            ? marker
            : lastEndedAt
                ? Date.parse(lastEndedAt)
                : null;

        return Number.isFinite(since)
            ? Math.max(0, Math.round((now - since) / 1000))
            : null;
    };

    const windowLatency = (key) =>
    {
        const days = state.days[key] ?? {};
        let sum = 0;
        let count = 0;
        let min = null;
        let max = null;

        for (const bucket of Object.values(days))
        {
            if (!bucket.latN)
            {
                continue;
            }

            sum += bucket.latSum;
            count += bucket.latN;
            min = min == null
                ? bucket.latMin
                : Math.min(min, bucket.latMin ?? min);
            max = max == null
                ? bucket.latMax
                : Math.max(max, bucket.latMax ?? max);
        }

        return count
            ? {
                avgMs:   round(sum / count, 1),
                minMs:   min,
                maxMs:   max,
                samples: count
            }
            : null;
    };

    const percentile = (values, p) =>
    {
        if (!values.length)
        {
            return null;
        }

        const sorted = [...values].sort((a, b) => a - b);
        const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));

        return sorted[index];
    };

    const jitter = (ring) =>
    {
        let total = 0;
        let pairs = 0;

        for (let index = 1; index < ring.length; index += 1)
        {
            if (typeof ring[index] === 'number' && typeof ring[index - 1] === 'number')
            {
                total += Math.abs(ring[index] - ring[index - 1]);
                pairs += 1;
            }
        }

        return pairs
            ? round(total / pairs, 1)
            : null;
    };

    const recentLatency = (key) =>
    {
        const ring = state.samples[key];

        if (!Array.isArray(ring) || !ring.length)
        {
            return null;
        }

        const answered = ring.filter((sample) => typeof sample === 'number');

        if (!answered.length)
        {

            return {
                samples:      ring,
                avgMs:        null,
                p50Ms:        null,
                p95Ms:        null,
                p99Ms:        null,
                jitterMs:     null,
                samplesCount: 0
            };
        }

        return {
            samples: ring,
            avgMs:   round(answered.reduce((sum, value) => sum + value, 0) / answered.length, 1),

            p50Ms: percentile(answered, 50),
            p95Ms: percentile(answered, 95),

            p99Ms:        answered.length >= 20
                              ? percentile(answered, 99)
                              : null,
            jitterMs:     jitter(ring),
            samplesCount: answered.length
        };
    };

    const dayStrip = (key, today) =>
    {
        const strip = [];

        for (let offset = windowDays - 1; offset >= 0; offset -= 1)
        {
            const date = shiftDay(today, -offset);
            const bucket = state.days[key]?.[date];
            const total = bucket
                ? bucket.up + bucket.down
                : 0;

            if (!bucket || total <= 0)
            {

                strip.push({
                    date,
                    state: 'nodata'
                });

                continue;
            }

            const percent = (100 * bucket.up) / total;

            strip.push({
                date,

                state:         bucket.down === 0
                                   ? 'up'
                                   : bucket.restart > 0 && bucket.restart >= bucket.down - 1
                        ? 'restart'
                        : bucket.down < DAY_PARTIAL_LIMIT_SECONDS
                            ? 'partial'
                            : 'down',
                uptimePercent: round(percent, 6),
                downSeconds:   Math.round(bucket.down), ...bucket.restart > 0
                    ? { restartSeconds: Math.round(bucket.restart) }
                    : {}, ...bucket.latN
                    ? { avgLatencyMs: round(bucket.latSum / bucket.latN, 1) }
                    : {}
            });
        }

        return strip;
    };

    const groupSimultaneous = (list, now) =>
    {
        const out = [];
        const groups = [];

        for (const incident of [...list]
            .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)))
        {
            if (incident.scope === 'host' || incident.annotated || !GROUPABLE_CAUSES.has(incident.causeCode))
            {
                out.push(incident);

                continue;
            }

            const at = Date.parse(incident.startedAt);

            const group = groups.find((candidate) => candidate.causeCode === incident.causeCode && at - candidate.at <= GROUP_WITHIN_MS);

            if (group)
            {
                group.members.push(incident);
            }
            else
            {
                groups.push({
                    causeCode: incident.causeCode,
                    at,
                    members:   [incident]
                });
            }
        }

        for (const group of groups)
        {

            if (group.members.length < 2)
            {
                out.push(group.members[0]);

                continue;
            }

            const members = group.members;
            const first = members[0];
            const ongoing = members.some((member) => member.ongoing);
            const startedAt = Math.min(...members.map((member) => Date.parse(member.startedAt)));

            const endedAt = ongoing
                ? null
                : Math.max(...members.map((member) => Date.parse(member.endedAt)));

            const durationSeconds = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000));

            out.push({
                id:           `group-${first.causeCode}-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}`,
                manual:       false,
                service:      null,
                scope:        'group',
                serviceName:  `${members.length} services`,
                startedAt:    new Date(startedAt).toISOString(),
                endedAt:      endedAt
                                  ? new Date(endedAt).toISOString()
                                  : null,
                durationSeconds,
                durationText: formatDuration(durationSeconds),
                ongoing,

                impact:          members.reduce((worst, member) => ((IMPACT_RANK[member.impact] ?? 1) > (IMPACT_RANK[worst] ?? 1)
                    ? member.impact
                    : worst), first.impact),
                title:           GROUP_TITLE[first.causeCode] ?? 'Several services failed together',
                cause:           first.cause,
                causeCode:       first.causeCode,
                causeConfidence: first.causeConfidence,
                note:            null,
                noteAt:          null,
                resolution:      null,
                resolutionAt:    null,
                updates:         [],
                annotated:       false,
                children:        members
                                     .map((member) => ({
                                         key:             member.service,
                                         name:            member.serviceName,
                                         startedAt:       member.startedAt,
                                         endedAt:         member.endedAt,
                                         durationSeconds: member.durationSeconds,
                                         durationText:    member.durationText,
                                         ongoing:         member.ongoing
                                     }))
                                     .sort((a, b) => (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0))
            });
        }

        return out;
    };

    const groupRepeats = (list, now) =>
    {
        const out = [];

        const runs = repeatRuns(list, now, (incident) => ({
            repeatable: incident.scope === 'service' && Boolean(incident.service),
            service:    incident.service,
            causeCode:  incident.causeCode,
            startedAt:  incident.startedAt,
            endedAt:    incident.endedAt,
            annotated:  incident.annotated
        }));

        for (const run of runs)
        {
            const members = run.members;

            if (members.length < 2)
            {
                out.push(members[0]);

                continue;
            }

            const first = members[0];
            const last = members[members.length - 1];
            const note = notes.notes[first.id] ?? {};
            const ongoing = members.some((member) => member.ongoing);

            const periods = members.map((member) => ({
                startedAt:       member.startedAt,
                endedAt:         member.endedAt,
                durationSeconds: member.durationSeconds,
                durationText:    member.durationText,
                ongoing:         member.ongoing
            }));

            const downSeconds = members.reduce((sum, member) => sum + (member.durationSeconds ?? 0), 0);
            const spanSeconds = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000));

            const worst = members.reduce((highest, member) => ((IMPACT_RANK[member.impact] ?? 1) > (IMPACT_RANK[highest] ?? 1)
                ? member.impact
                : highest), first.impact);

            const impact = worst === 'minor' && members.length >= 3
                ? 'major'
                : worst;

            out.push({
                id:              first.id,
                manual:          false,
                scope:           'service',
                service:         first.service,
                serviceName:     first.serviceName,
                degraded:        true,
                outages:         members.length,
                periods,
                startedAt:       first.startedAt,
                endedAt:         ongoing
                                     ? null
                                     : last.endedAt,
                durationSeconds: downSeconds,
                durationText:    formatDuration(downSeconds),
                spanSeconds,
                spanText:        formatDuration(spanSeconds),
                ongoing,
                impact:          note.impact ?? impact,
                title:           note.title ?? (ongoing
                    ? `${first.serviceName} keeps dropping out`
                    : `${first.serviceName} was unstable`),
                cause:           `${first.cause} It did this ${members.length} times over ${formatDuration(spanSeconds)}.`,
                causeCode:       first.causeCode,
                causeConfidence: first.causeConfidence,
                note:            first.note,
                noteAt:          first.noteAt,
                resolution:      first.resolution,
                resolutionAt:    first.resolutionAt,
                updates:         first.updates,
                annotated:       first.annotated
            });
        }

        return out;
    };

    const publish = async ({
        now,
        publicServices
    }) =>
    {

        if (!clockUsable(now))
        {
            return;
        }

        if (Date.now() - notesReadAt > 30000)
        {
            notes = normalizeNotes(await readJson(notesFile, null));
            notesReadAt = Date.now();
        }

        const today = dayKey(now);
        const cutoff = shiftDay(today, -(windowDays - 1));
        const keys = new Set(publicServices.map((service) => service.key));
        const names = new Map(publicServices.map((service) => [
            service.key,
            service.name
        ]));

        const restartOpen = state.incidents.find((incident) => incident.scope === 'host' && !incident.endedAt);

        const restarting = new Set((restartOpen?.affected ?? [])
            .filter((entry) => entry.downTo == null)
            .map((entry) => entry.key));

        const services = publicServices.map((service) =>
        {
            const window = windowLatency(service.key);
            const recent = recentLatency(service.key);
            const days = dayStrip(service.key, today);
            const todayBucket = days[days.length - 1];
            const spans = uptimeSpans(service.key, today);
            const outages = outageStats(service.key, now);
            const streak = currentStreak(service.key, now, outages.lastEndedAt);

            return {
                key:      service.key,
                name:     service.name,
                category: service.category,
                online:   service.online,

                ...restarting.has(service.key)
                    ? { restarting: true }
                    : {},
                since:         service.since,
                uptimePercent: spans.window.uptimePercent,

                uptime: spans,

                availability: {
                    downtimeSeconds:      spans.window.downSeconds,
                    downtimeTodaySeconds: spans.today.downSeconds,
                    observedPercent:      spans.window.observedPercent,
                    outages:              outages.count,
                    longestOutageSeconds: outages.longestSeconds,
                    lastOutageAt:         outages.lastAt,
                    meanRecoverySeconds:  outages.meanRecoverySeconds,

                    streakSeconds: service.online === false
                                       ? 0
                                       : streak
                },

                latency: window || recent
                             ? {
                        currentMs: service.online === true && service.latencyMs != null
                                       ? Math.round(service.latencyMs)
                                       : null,

                        measuredAt:     service.latencyAt
                                            ? new Date(service.latencyAt).toISOString()
                                            : null,
                        avgTodayMs:     todayBucket?.avgLatencyMs ?? null,
                        avgWindowMs:    window?.avgMs ?? null,
                        minWindowMs:    window?.minMs ?? null,
                        maxWindowMs:    window?.maxMs ?? null,
                        avgRecentMs:    recent?.avgMs ?? null,
                        p50RecentMs:    recent?.p50Ms ?? null,
                        p95RecentMs:    recent?.p95Ms ?? null,
                        p99RecentMs:    recent?.p99Ms ?? null,
                        jitterRecentMs: recent?.jitterMs ?? null,
                        windowSamples:  window?.samples ?? 0,
                        samples:        recent?.samples ?? []
                    }
                             : null,

                ...service.meta
                    ? { meta: service.meta }
                    : {},
                days
            };
        });

        const detected = state.incidents
                              .filter((incident) => (incident.scope === 'host'
                                  ? (incident.affected ?? []).some((entry) => keys.has(entry.key))
                                  : keys.has(incident.service)))
                              .map((incident) =>
                              {
                                  const note = notes.notes[incident.id] ?? {};
                                  const ongoing = !incident.endedAt;
                                  const durationSeconds = ongoing
                                      ? Math.round((now - Date.parse(incident.startedAt)) / 1000)
                                      : incident.durationSeconds;

                                  const host = incident.scope === 'host';

                                  const children = host
                                      ? (incident.affected ?? [])
                                          .filter((entry) => keys.has(entry.key))
                                          .map((entry) =>
                                          {
                                              const until = entry.downTo ?? (incident.endedAt
                                                  ? Date.parse(incident.endedAt)
                                                  : now);
                                              const seconds = Math.max(0, Math.round((until - entry.downFrom) / 1000));

                                              return {
                                                  key:             entry.key,
                                                  name:            names.get(entry.key) ?? entry.name,
                                                  startedAt:       new Date(entry.downFrom).toISOString(),
                                                  endedAt:         entry.downTo
                                                                       ? new Date(entry.downTo).toISOString()
                                                                       : null,
                                                  durationSeconds: seconds,
                                                  durationText:    formatDuration(seconds),
                                                  ongoing:         entry.downTo == null && ongoing
                                              };
                                          })
                                          .sort((a, b) => b.durationSeconds - a.durationSeconds)
                                      : [];

                                  return {
                                      id:           incident.id,
                                      manual:       false,
                                      scope:        host
                                                        ? 'host'
                                                        : 'service',
                                      service:      host
                                                        ? null
                                                        : incident.service,
                                      serviceName:  host
                                                        ? `${children.length} ${children.length === 1
                                              ? 'service'
                                              : 'services'}`
                                                        : incident.serviceName, ...children.length
                                          ? { children }
                                          : {},
                                      startedAt:    incident.startedAt,
                                      endedAt:      incident.endedAt,
                                      durationSeconds,
                                      durationText: formatDuration(durationSeconds ?? 0),
                                      ongoing,
                                      impact:       note.impact ?? autoImpact(durationSeconds ?? 0, ongoing),
                                      title:        note.title ?? (host
                                          ? HOST_TITLE[incident.cause?.code] ?? HOST_TITLE['host-reboot']
                                          : autoTitle(incident.serviceName, incident.cause, ongoing)),

                                      cause:           incident.cause?.summary ?? CAUSE_TEXT.unknown,
                                      causeCode:       incident.cause?.code ?? 'unknown',
                                      causeConfidence: incident.cause?.confidence ?? 'low',
                                      note:            note.note ?? null,

                                      noteAt:       note.note
                                                        ? noteWrittenAt(note)
                                                        : null,
                                      resolution:   note.resolution ?? null,
                                      resolutionAt: note.resolution
                                                        ? resolutionWrittenAt(note)
                                                        : null,
                                      updates:      sanitiseUpdates(note.updates, note.resolution),
                                      annotated:    Boolean(note.title || note.note || note.resolution || (note.updates ?? []).length)
                                  };
                              });

        const declared = notes.manual
                              .filter((incident) => incident && incident.id && incident.startedAt)

                              .filter((incident) => !incident.service || keys.has(incident.service))
                              .filter((incident) => !incident.endedAt || dayKey(incident.endedAt) >= cutoff)
                              .map((incident) =>
                              {
                                  const ongoing = !incident.endedAt;
                                  const durationSeconds = Math.round(((ongoing
                                      ? now
                                      : Date.parse(incident.endedAt)) - Date.parse(incident.startedAt)) / 1000);

                                  return {
                                      id:          incident.id,
                                      manual:      true,
                                      service:     incident.service ?? null,
                                      serviceName: incident.service
                                                       ? names.get(incident.service) ?? incident.serviceName ?? incident.service
                                                       : incident.serviceName ?? 'Multiple services',
                                      startedAt:   incident.startedAt,

                                      declaredAt:      incident.createdAt ?? incident.startedAt,
                                      endedAt:         incident.endedAt ?? null,
                                      durationSeconds,
                                      durationText:    formatDuration(Math.max(0, durationSeconds)),
                                      ongoing,
                                      impact:          IMPACTS.includes(incident.impact)
                                                           ? incident.impact
                                                           : 'minor',
                                      title:           incident.title ?? 'Service incident',
                                      cause:           incident.cause ?? null,
                                      causeCode:       'declared',
                                      causeConfidence: 'stated',
                                      note:            incident.note ?? null,
                                      noteAt:          incident.note
                                                           ? noteWrittenAt(incident)
                                                           : null,
                                      resolution:      incident.resolution ?? null,
                                      resolutionAt:    incident.resolution
                                                           ? resolutionWrittenAt(incident)
                                                           : null,
                                      updates:         sanitiseUpdates(incident.updates, incident.resolution),
                                      annotated:       true
                                  };
                              });

        const incidents = [
            ...groupRepeats(groupSimultaneous(detected, now), now),
            ...declared
        ]
            .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

        const active = incidents.filter((incident) => incident.ongoing);

        const measured = services.filter((service) => service.uptimePercent != null);
        const overallUptime = measured.length
            ? round(measured.reduce((sum, service) => sum + service.uptimePercent, 0) / measured.length, 10)
            : null;

        const overallSpan = (span) =>
        {
            const rows = services
                .map((service) => service.uptime?.[span]?.uptimePercent)
                .filter((value) => value != null);

            return rows.length
                ? round(rows.reduce((sum, value) => sum + value, 0) / rows.length, 10)
                : null;
        };

        const timed = services.filter((service) => service.latency?.avgWindowMs != null);
        const overallLatency = timed.length
            ? round(timed.reduce((sum, service) => sum + service.latency.avgWindowMs, 0) / timed.length, 1)
            : null;

        const down = services.filter((service) => service.online === false).length;

        const worst = measured.length
            ? measured.reduce((lowest, service) => (service.uptimePercent < lowest.uptimePercent
                ? service
                : lowest))
            : null;

        const watched = services
            .map((service) => service.uptime?.window?.observedPercent)
            .filter((value) => value != null);

        const STATUS_BY_RANK = [
            'operational',
            'maintenance',
            'partial',
            'major'
        ];
        let statusRank = down === 0
            ? 0
            : down >= HOST_WIDE_THRESHOLD
                ? 3
                : 2;

        for (const incident of active)
        {
            const impact = IMPACT_RANK[incident.impact] ?? 1;

            statusRank = Math.max(statusRank,
                impact === 0
                    ? 1
                    : impact >= 3
                        ? 3
                        : 2);
        }

        const payload = {
            generatedAt: new Date(now).toISOString(),
            windowDays,
            overall:     {
                status:          STATUS_BY_RANK[statusRank],
                servicesTotal:   services.length,
                servicesDown:    down,
                servicesUnknown: services.filter((service) => service.online == null).length,
                uptimePercent:   overallUptime,
                uptime:          {
                    today:  overallSpan('today'),
                    days7:  overallSpan('days7'),
                    days30: overallSpan('days30'),
                    window: overallUptime
                },

                observedPercent:      watched.length
                                          ? round(watched.reduce((sum, value) => sum + value, 0) / watched.length, 2)
                                          : null,
                avgLatencyMs:         overallLatency,
                worstService:         worst
                                          ? {
                        key:           worst.key,
                        name:          worst.name,
                        uptimePercent: worst.uptimePercent
                    }
                                          : null,
                totalDowntimeSeconds: services.reduce((total, service) => total + (service.availability?.downtimeSeconds ?? 0), 0),
                incidentsWindow:      incidents.length,
                activeIncidents:      active.length
            },
            services,
            incidents
        };

        await writeJson(publicFile, payload, { pretty: false });

        return payload;
    };

    const flush = async ({ force = false } = {}) =>
    {
        if (!dirty && !force)
        {
            return;
        }

        await writeJson(stateFile, state).catch(() => {});
        dirty = false;
    };

    return {
        load,
        record,
        publish,
        flush,
        hasPendingIncidentChange: () => dirty,

        hasOngoing: () => state.incidents.some((incident) => !incident.endedAt) || notes.manual.some((incident) => incident && !incident.endedAt),

        snapshot: () => state
    };
};

module.exports = {
    createLedger,
    repeatRuns,
    REPEAT_WITHIN_MS,
    DEGRADE_SPAN_MS,
    CAUSE_TEXT,
    WINDOW_DAYS,
    IMPACTS,
    IMPACT_RANK,
    UPDATE_STATUSES,
    formatDuration,
    normalizeNotes,
    sanitiseUpdates,
    noteWrittenAt,
    resolutionWrittenAt,
    readJson,
    writeJson
};
