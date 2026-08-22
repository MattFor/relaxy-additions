#!/usr/bin/env node

import os              from 'node:os';
import {
    readFile,
    writeFile,
    rename
}                      from 'node:fs/promises';
import { MongoClient } from 'mongodb';

try
{
    os.setPriority(0, 19);
}
catch
{

}

const MONGODB_URI = process.env.MONGODB_URI;

const OUTPUT = process.env.STATUS_OUTPUT ?? process.argv[2] ?? '/home/mattfor/relaxy/website/status.json';

const INTERVAL_MS = Number(process.env.STATUS_INTERVAL_MS ?? 30000);
const ONCE = process.argv.includes('--once');

const HOST_STALE_AFTER = 90 * 1000;

const FLEET_FORGET_AFTER = Number(process.env.STATUS_FLEET_FORGET_MS ?? 7 * 24 * 60 * 60 * 1000);

const round = (value, digits = 0) =>
{
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
};

const readOsName = async () =>
{
    try
    {
        const release = await readFile('/etc/os-release', 'utf8');
        const pretty = release.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1];

        if (pretty)
        {
            return pretty;
        }
    }
    catch
    {

    }

    return `${os.type()} ${os.release()}`;
};

const readTemperature = async () =>
{
    for (const path of [
        '/sys/class/thermal/thermal_zone0/temp',
        '/sys/devices/virtual/thermal/thermal_zone0/temp'
    ])
    {
        try
        {
            const raw = Number((await readFile(path, 'utf8')).trim());

            if (Number.isFinite(raw) && raw > 0)
            {

                return round(raw > 1000
                    ? raw / 1000
                    : raw, 1);
            }
        }
        catch
        {

        }
    }

    return null;
};

const cpuSnapshot = async () =>
{
    const first = (await readFile('/proc/stat', 'utf8')).split('\n')[0];
    const [, ...fields] = first.trim().split(/\s+/);

    const [user, nice, system, idle, iowait, irq, softirq, steal] = fields.map(Number);

    return {
        idle,
        total: user + nice + system + idle + iowait + irq + softirq + steal
    };
};

const cpuLoadBetween = (previous, current) =>
{
    if (!previous || !current)
    {
        return null;
    }

    const total = current.total - previous.total;

    if (total <= 0)
    {
        return null;
    }

    return Math.round((100 * (total - (current.idle - previous.idle))) / total);
};

const readSelf = async (load) =>
{
    const totalBytes = os.totalmem();

    const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '');
    const kb = (key) => Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]);

    const totalKb = kb('MemTotal') || totalBytes / 1024;
    const availableKb = kb('MemAvailable') ?? (os.freemem() / 1024);
    const usedKb = totalKb - availableKb;

    return {
        host:   os.hostname(),
        os:     await readOsName(),
        kernel: os.release(),

        arch:          typeof os.machine === 'function'
                           ? os.machine()
                           : os.arch(),
        uptimeSeconds: Math.floor(os.uptime()),
        temperatureC:  await readTemperature(),
        cpu:           {
            cores: os.cpus().length,
            load
        },
        memory:        {
            usedGb:  round(usedKb / 1048576, 1),
            totalGb: round(totalKb / 1048576, 1),
            percent: totalKb
                         ? Math.round((100 * usedKb) / totalKb)
                         : null
        }
    };
};

const measured = (value) => (Number.isFinite(value) && value >= 0
    ? value
    : null);

const readDatabase = async (client) =>
{
    const started = Date.now();

    try
    {
        await client.db().admin().command({ ping: 1 });

        return {
            online:    true,
            latencyMs: Date.now() - started,
            reason:    null
        };
    }
    catch (error)
    {
        const text = String(error?.message ?? error).toLowerCase();

        return {
            online: false,

            latencyMs: Date.now() - started,
            reason:    text.includes('timed out') || text.includes('timeout')
                           ? 'timeout'
                           : text.includes('econnrefused') || text.includes('refused')
                    ? 'refused'
                    : text.includes('auth')
                        ? 'auth'
                        : 'error'
        };
    }
};

const readFleet = async (client) =>
{
    try
    {
        const now = Date.now();

        const rows = await client.db().collection('hosts')
                                 .find({ lastSeen: { $gte: now - FLEET_FORGET_AFTER } })
                                 .toArray();

        const staleAfter = (row) => Math.max(HOST_STALE_AFTER, (row.reportEvery ?? 0) * 3);

        const silentMs = (row) => Math.max(0, now - (row.lastSeen ?? 0));

        const live = rows.filter(row => silentMs(row) <= staleAfter(row));

        const hosts = live.map(row => ({
            id:                 row._id,
            hostname:           row.hostname ?? row._id,
            shards:             row.shards ?? [],
            clusters:           row.clusters ?? 0,
            guilds:             row.guilds ?? 0,
            users:              row.users ?? 0,
            players:            row.players ?? 0,
            cpuCount:           row.cpuCount ?? 0,
            cpuLoad:            round((row.cpuLoad ?? 0) * 100),
            memUsedGb:          round((row.memUsed ?? 0) / 1024 ** 3, 1),
            memTotalGb:         round((row.memTotal ?? 0) / 1024 ** 3, 1),
            uptimeSeconds:      Math.floor((row.uptime ?? 0) / 1000),
            version:            row.version ?? null,
            bridged:            Boolean(row.bridged),
            lastSeenAgoSeconds: Math.floor(silentMs(row) / 1000)
        }));

        const machines = rows.map(row =>
                             {
                                 const online = silentMs(row) <= staleAfter(row);

                                 return {
                                     id:       row._id,
                                     hostname: row.hostname ?? row._id,
                                     online,

                                     startedAt:          row.startedAt
                                                             ? new Date(row.startedAt).toISOString()
                                                             : null,
                                     lastSeen:           row.lastSeen
                                                             ? new Date(row.lastSeen).toISOString()
                                                             : null,
                                     lastSeenAgoSeconds: Math.floor(silentMs(row) / 1000),
                                     reportEverySeconds: Math.round((row.reportEvery ?? 0) / 1000) || null,

                                     shards:        row.shards ?? [],
                                     clusters:      row.clusters ?? 0,
                                     clustersReady: row.clustersReady ?? null,
                                     guilds:        row.guilds ?? 0,
                                     version:       row.version ?? null,
                                     bridged:       Boolean(row.bridged),

                                     latency: online
                                                  ? {
                                             gatewayMs:       measured(row.gatewayPing),
                                             worstShardMs:    measured(row.gatewayWorstPing),
                                             databaseMs:      measured(row.dbPing),
                                             databaseWriteMs: measured(row.dbWrite),
                                             heartbeatMs:     measured(row.heartbeatPing)
                                         }
                                                  : null
                                 };
                             })

                             .sort((a, b) => Number(b.online) - Number(a.online) || b.shards.length - a.shards.length || String(a.id).localeCompare(String(b.id)));

        const primary = [...hosts].sort((a, b) => b.shards.length - a.shards.length || b.clusters - a.clusters || b.guilds - a.guilds)[0] ?? null;

        const timed = machines.filter(machine => machine.latency?.gatewayMs != null);
        const weight = timed.reduce((total, machine) => total + Math.max(1, machine.shards.length), 0);

        const latencyMs = weight
            ? round(timed.reduce((total, machine) => total + (machine.latency.gatewayMs * Math.max(1, machine.shards.length)), 0) / weight)
            : null;

        const stamps = timed
            .map(machine => Date.parse(machine.lastSeen))
            .filter(Number.isFinite);

        const measuredAt = stamps.length
            ? new Date(Math.max(...stamps)).toISOString()
            : null;

        return {
            online:        hosts.length > 0,
            primary:       primary?.id ?? null,
            hostCount:     hosts.length,
            totalShards:   hosts.reduce((total, host) => total + host.shards.length, 0),
            totalClusters: hosts.reduce((total, host) => total + host.clusters, 0),
            totalGuilds:   hosts.reduce((total, host) => total + host.guilds, 0),
            totalUsers:    hosts.reduce((total, host) => total + host.users, 0),
            totalPlayers:  hosts.reduce((total, host) => total + host.players, 0),
            latencyMs,
            worstShardMs:  timed.length
                               ? Math.max(...timed.map(machine => machine.latency.worstShardMs ?? machine.latency.gatewayMs))
                               : null,
            measuredAt,
            hosts,
            machines
        };
    }
    catch (error)
    {
        console.error(`[relaxy-status] fleet read failed: ${error.message}`);
        return null;
    }
};

const publish = async (payload) =>
{
    const temporary = `${OUTPUT}.tmp`;

    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(temporary, OUTPUT);
};

const main = async () =>
{
    if (!MONGODB_URI)
    {
        console.error('[relaxy-status] MONGODB_URI is not set. Aborting!');
        process.exit(1);
    }

    const client = new MongoClient(MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,

        maxPoolSize: 1
    });

    await client.connect();
    console.log(`[relaxy-status] connected. Writing ${OUTPUT} every ${INTERVAL_MS}ms.`);

    let previousCpu = await cpuSnapshot().catch(() => null);

    const tick = async () =>
    {
        try
        {
            const currentCpu = await cpuSnapshot().catch(() => null);
            const load = cpuLoadBetween(previousCpu, currentCpu);
            previousCpu = currentCpu ?? previousCpu;

            const database = await readDatabase(client);
            const [self, bot] = await Promise.all([
                readSelf(load),
                readFleet(client)
            ]);

            await publish({
                ...self,
                generatedAt: new Date().toISOString(),

                database,

                bot
            });
        }
        catch (error)
        {
            console.error(`[relaxy-status] tick failed: ${error.stack ?? error}`);
        }
    };

    await new Promise(resolve => setTimeout(resolve, 500));
    await tick();

    if (ONCE)
    {
        await client.close();
        return;
    }

    setInterval(tick, INTERVAL_MS);

    for (const signal of [
        'SIGINT',
        'SIGTERM'
    ])
    {
        process.on(signal, async () =>
        {
            console.log(`[relaxy-status] ${signal} - shutting down.`);
            await client.close().catch(() => {});
            process.exit(0);
        });
    }
};

main().catch(error =>
{
    console.error(`[relaxy-status] fatal: ${error.stack ?? error}`);
    process.exit(1);
});
