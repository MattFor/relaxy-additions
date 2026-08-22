'use strict';

const {
    readFile,
    writeFile,
    rename,
    mkdir,
    open,
    unlink,
    stat
} = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');

const API = process.env.OUTAGE_API_BASE ?? 'https://discord.com/api/v10';

const DEFAULTS = {
    channelId: '1127006596988420156',
    pageUrl:   'https://uptime.relaxy.xyz/',
    stateFile: '/home/mattfor/relaxy/additions/var/discord-outages.json',

    tokenFile: '/home/mattfor/relaxy/bot/.env',

    statusFile: '/home/mattfor/relaxy/website/status.json'
};

const VERSION_MAX_AGE_MS = Number(process.env.OUTAGE_VERSION_MAX_AGE_MS ?? 3600000);

const versionLabel = (version) =>
{
    const value = String(version ?? '').trim();

    if (!value)
    {
        return '';
    }

    return /^\d/.test(value)
        ? `v${value}`
        : value;
};

const footerText = (label) => process.env.OUTAGE_FOOTER ?? `Relaxy!${label
    ? ` ${label}`
    : ''} • relaxy.xyz • by MattFor`;

const FOOTER_ICON = process.env.OUTAGE_FOOTER_ICON ?? 'https://cdn.relaxy.xyz/relaxy/bot/common/relaxy.png';

const SETTLE_MS = Number(process.env.OUTAGE_SETTLE_MS ?? 180000);

const MAX_BACKFILL_MS = Number(process.env.OUTAGE_MAX_BACKFILL_MS ?? 21600000);

const MAX_CALLS_PER_SYNC = Number(process.env.OUTAGE_MAX_CALLS ?? 8);

const CROSSPOST = process.env.OUTAGE_CROSSPOST !== '0';

const CROSSPOST_UPDATES = process.env.OUTAGE_CROSSPOST_UPDATES === '1';

const ALREADY_CROSSPOSTED = 40033;

const REQUEST_TIMEOUT_MS = 8000;

const MERGE_WITHIN_MS = 120000;

const PRUNE_AFTER_MS = 2592000000;

const LOCK_STALE_MS = 60000;

const COLOUR = {
    critical:    0xB4202A,
    major:       0xED4245,
    minor:       0xFEE75C,
    degraded:    0xE67E22,
    maintenance: 0x5865F2,
    resolved:    0x57F287,
    closed:      0x99AAB5
};

const MARK = {
    critical:    '🔴',
    major:       '🔴',
    minor:       '🟡',
    degraded:    '📉',
    maintenance: '🛠️',
    resolved:    '✅',
    closed:      '⚪'
};

const CHANNEL_REFUSALS = new Set([
    50001,
    50013,
    50024
]);

const PUBLISH_MAX_TRIES = 3;

const PUBLISH_RETRY_WINDOW_MS = Number(process.env.OUTAGE_PUBLISH_WINDOW_MS ?? 21600000);

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

const writeJson = async (file, payload) =>
{
    const temporary = `${file}.tmp`;

    await mkdir(path.dirname(file), { recursive: true }).catch(() => {});
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode:     0o600
    });
    await rename(temporary, file);
};

const clip = (text, limit) =>
{
    const value = String(text ?? '').trim();

    return value.length > limit
        ? `${value.slice(0, limit - 1)}…`
        : value;
};

const stamp = (iso, style) => `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;

const newestUpdate = (updates) => (Array.isArray(updates)
    ? updates
    : [])
    .reduce((newest, update) => (!newest || Date.parse(update.at) > Date.parse(newest.at)
        ? update
        : newest), null);

const readTokenFile = async (file, name) =>
{
    const body = await readFile(file, 'utf8').catch(() => null);

    if (!body)
    {
        return null;
    }

    const match = body.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm'));

    return match
        ? match[1].trim().replace(/^["']|["']$/g, '') || null
        : null;
};

const resolveFooter = async (statusFile, now) =>
{
    const status = await readJson(statusFile, null);

    if (!status)
    {
        return footerText('');
    }

    const generatedAt = Date.parse(status.generatedAt);

    if (Number.isFinite(generatedAt) && now - generatedAt > VERSION_MAX_AGE_MS)
    {
        return footerText('');
    }

    const machines = Array.isArray(status.bot?.machines)
        ? status.bot.machines
        : [];
    const withVersion = machines.filter((machine) => machine?.version);

    const primary = withVersion.find((machine) => machine.id === status.bot?.primary);

    const newest = [...withVersion].sort((a, b) => (Date.parse(b.lastSeen) || 0) - (Date.parse(a.lastSeen) || 0))[0];

    return footerText(versionLabel((primary ?? newest)?.version));
};

const resolveTransport = async ({
    channelId,
    tokenFile
}) =>
{

    if (process.env.OUTAGE_ANNOUNCE === '0')
    {
        return null;
    }

    const webhook = process.env.OUTAGE_DISCORD_WEBHOOK?.trim();

    if (webhook)
    {
        return {
            kind: 'webhook',

            create:  `${webhook}?wait=true`,
            edit:    (messageId) => `${webhook}/messages/${messageId}`,
            headers: { 'content-type': 'application/json' },
            replies: false,

            crosspost: null
        };
    }

    const token = process.env.OUTAGE_DISCORD_TOKEN?.trim() || await readTokenFile(tokenFile, 'DISCORD_TOKEN');

    if (!token || !channelId)
    {
        return null;
    }

    return {
        kind:      'bot',
        create:    `${API}/channels/${channelId}/messages`,
        edit:      (messageId) => `${API}/channels/${channelId}/messages/${messageId}`,
        crosspost: (messageId) => `${API}/channels/${channelId}/messages/${messageId}/crosspost`,
        headers:   {
            'content-type': 'application/json',
            authorization:  `Bot ${token}`,
            'user-agent':   'RelaxyOutages (https://uptime.relaxy.xyz, 1.0)'
        },
        replies:   true
    };
};

const severityOf = (incident) =>
{
    if (!incident.ongoing)
    {
        return 'resolved';
    }

    if (incident.impact === 'maintenance')
    {
        return 'maintenance';
    }

    return incident.degraded
        ? 'degraded'
        : incident.impact ?? 'minor';
};

const headline = (incident) =>
{
    const severity = severityOf(incident);

    const state = incident.ongoing
        ? (incident.impact === 'maintenance'
            ? 'Maintenance'
            : incident.degraded
                ? 'Unstable'
                : 'Ongoing')
        : incident.degraded
            ? 'Settled'
            : 'Resolved';

    return `${MARK[severity] ?? MARK.minor} **${state}:** ${clip(incident.serviceName ?? 'Relaxy', 80)}`;
};

const updatesField = (updates) =>
{
    if (!updates?.length)
    {
        return null;
    }

    const ordered = [...updates].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const shown = ordered.slice(0, 4);

    const lines = shown.map((update) =>
    {
        const label = update.status && update.status !== 'update'
            ? `**${update.status}** · `
            : '';

        return `${label}${stamp(update.at, 't')}\n${clip(update.body, 240)}`;
    });

    if (ordered.length > shown.length)
    {
        lines.push(`*${ordered.length - shown.length} earlier update${ordered.length - shown.length === 1
            ? ''
            : 's'} on the page.*`);
    }

    return {
        name:   'Updates',
        value:  clip(lines.join('\n\n'), 1024),
        inline: false
    };
};

const childrenField = (children) =>
{
    if (!children?.length)
    {
        return null;
    }

    const lines = children.slice(0, 8).map((child) => `• ${child.name ?? child.key}: ${child.ongoing
        ? 'still down'
        : child.durationText}`);

    if (children.length > 8)
    {
        lines.push(`• …and ${children.length - 8} more`);
    }

    return {
        name:   'Affected',
        value:  clip(lines.join('\n'), 1024),
        inline: false
    };
};

const periodsField = (periods) =>
{
    if (!periods?.length)
    {
        return null;
    }

    const shown = periods.slice(-8);

    const lines = shown.map((period) => `• ${stamp(period.startedAt, 'f')} - ${period.ongoing
        ? 'still down'
        : period.durationText}`);

    if (periods.length > shown.length)
    {
        lines.unshift(`• …${periods.length - shown.length} earlier, on the page`);
    }

    return {
        name:   `Outages (${periods.length})`,
        value:  clip(lines.join('\n'), 1024),
        inline: false
    };
};

const buildMessage = (incident, pageUrl, footer) =>
{
    const severity = severityOf(incident);
    const fields = [];

    fields.push({
        name:   'Started',
        value:  `${stamp(incident.startedAt, 'f')}\n${stamp(incident.startedAt, 'R')}`,
        inline: true
    });

    if (incident.degraded)
    {
        const newest = incident.periods?.[incident.periods.length - 1];

        fields.push({
            name:   'Down for',
            value:  `${incident.durationText} across ${incident.outages} outages\n` + (incident.ongoing
                ? `Down again since ${stamp(newest?.startedAt ?? incident.startedAt, 'R')}`
                : `Over ${incident.spanText}, last ${stamp(incident.endedAt, 'R')}`),
            inline: true
        });
    }
    else
    {
        fields.push(incident.ongoing
            ? {
                name:   'Duration',
                value:  `Ongoing since ${stamp(incident.startedAt, 'R')}`,
                inline: true
            }
            : {
                name:   'Lasted',
                value:  `${incident.durationText}\nEnded ${stamp(incident.endedAt, 'R')}`,
                inline: true
            });
    }

    fields.push({
        name:   'Impact',
        value:  `${incident.degraded
            ? 'degraded · '
            : ''}${incident.impact ?? 'minor'}` + `${incident.manual
            ? ' · declared'
            : ' · detected'}`,
        inline: true
    });

    const affected = childrenField(incident.children);

    if (affected)
    {
        fields.push(affected);
    }

    const periods = periodsField(incident.periods);

    if (periods)
    {
        fields.push(periods);
    }

    if (incident.note)
    {
        fields.push({
            name:   'What happened',
            value:  clip(incident.note, 1024),
            inline: false
        });
    }

    const updates = updatesField(incident.updates);

    if (updates)
    {
        fields.push(updates);
    }

    if (incident.resolution)
    {
        fields.push({
            name:   'Resolution',
            value:  clip(incident.resolution, 1024),
            inline: false
        });
    }

    return {
        content: headline(incident),
        embeds:  [
            {
                title: clip(incident.title ?? 'Service incident', 256),

                url:         pageUrl,
                color:       COLOUR[severity] ?? COLOUR.minor,
                description: clip(incident.cause ?? '', 2048) || undefined,
                fields,

                footer:    {
                    text:     clip(footer, 2048),
                    icon_url: FOOTER_ICON
                },
                timestamp: incident.startedAt
            }
        ],

        allowed_mentions: { parse: [] }
    };
};

const buildClosure = (entry, successor, pageUrl, footer) => ({
    content:          `${MARK.closed} **No longer listed:** ${clip(entry.serviceName ?? 'Relaxy', 80)}`,
    embeds:           [
        {
            title:       clip(entry.title ?? 'Service incident', 256),
            url:         pageUrl,
            color:       COLOUR.closed,
            description: successor
                             ? `This entry was folded into **${clip(successor.title, 200)}**, which carries it now.`
                             : 'This incident is no longer listed on the status page. It was withdrawn or superseded.',
            footer:      {
                text:     clip(footer, 2048),
                icon_url: FOOTER_ICON
            }
        }
    ],
    allowed_mentions: { parse: [] }
});

const fingerprint = (incident) => createHash('sha1')
    .update(JSON.stringify([
        incident.title,
        incident.serviceName,
        incident.impact,
        incident.ongoing,
        incident.endedAt,
        incident.ongoing
            ? null
            : incident.durationText,
        incident.cause,
        incident.note,
        incident.resolution,
        (incident.children ?? []).map((child) => [
            child.key,
            child.ongoing,
            child.durationText
        ]),
        (incident.periods ?? []).map((period) => [
            period.startedAt,
            period.ongoing,
            period.durationText
        ]),
        (incident.updates ?? []).map((update) => [
            update.at,
            update.status,
            update.body
        ])
    ]))
    .digest('hex')
    .slice(0, 16);

const findSuccessor = (entry, incidents) =>
{
    if (!entry.service || !entry.startedAt)
    {
        return null;
    }

    const startedAt = Date.parse(entry.startedAt);

    const near = (candidate) => Math.abs(Date.parse(candidate) - startedAt) <= MERGE_WITHIN_MS;

    return incidents.find((incident) => (incident.children ?? []).some((child) => child.key === entry.service && near(child.startedAt)) || (incident.service === entry.service && (incident.periods ?? []).some((period) => near(period.startedAt)))) ?? null;
};

const createAnnouncer = ({
    channelId = process.env.OUTAGE_DISCORD_CHANNEL ?? DEFAULTS.channelId,
    pageUrl = process.env.UPTIME_PAGE_URL ?? DEFAULTS.pageUrl,
    stateFile = process.env.OUTAGE_STATE_FILE ?? DEFAULTS.stateFile,
    tokenFile = process.env.OUTAGE_TOKEN_FILE ?? DEFAULTS.tokenFile,
    statusFile = process.env.OUTAGE_STATUS_FILE ?? DEFAULTS.statusFile,
    log = (message) => console.error(`[outages] ${message}`)
} = {}) =>
{
    const lockFile = `${stateFile}.lock`;

    let transport;
    let announcedUnavailable = false;

    let crosspostUnsupported = false;

    const acquire = async () =>
    {
        for (let attempt = 0; attempt < 2; attempt += 1)
        {
            try
            {
                const handle = await open(lockFile, 'wx');

                await handle.writeFile(`${process.pid}\n`);
                await handle.close();

                return true;
            }
            catch (error)
            {
                if (error.code !== 'EEXIST')
                {
                    return false;
                }

                const info = await stat(lockFile).catch(() => null);

                if (!info || Date.now() - info.mtimeMs > LOCK_STALE_MS)
                {
                    await unlink(lockFile).catch(() => {});

                    continue;
                }

                return false;
            }
        }

        return false;
    };

    const release = () => unlink(lockFile).catch(() => {});

    const call = async (method, url, body) =>
    {

        const send = async () =>
        {
            try
            {
                return await fetch(url, {
                    method,
                    headers: transport.headers,
                    body:    JSON.stringify(body),
                    signal:  AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                });
            }
            catch (error)
            {
                return {
                    ok:     false,
                    status: 0,
                    json:   async () => ({}),
                    text:   async () => error.message
                };
            }
        };

        let response = await send();

        if (response.status === 429)
        {
            const payload = await response.json().catch(() => ({}));
            const waitMs = Math.min(10000, Math.round((Number(payload.retry_after) || 1) * 1000));

            await new Promise((resolve) => setTimeout(resolve, waitMs));

            response = await send();
        }

        return response;
    };

    const post = async (body) =>
    {
        const response = await call('POST', transport.create, body);

        if (!response.ok)
        {
            log(`post failed: ${response.status} ${clip(await response.text().catch(() => ''), 200)}`);

            return null;
        }

        const message = await response.json().catch(() => null);

        return message?.id ?? null;
    };

    const edit = async (messageId, body) =>
    {
        const response = await call('PATCH', transport.edit(messageId), body);

        if (response.status === 404)
        {
            return 'gone';
        }

        if (!response.ok)
        {
            log(`edit failed: ${response.status} ${clip(await response.text().catch(() => ''), 200)}`);

            return 'failed';
        }

        return 'ok';
    };

    const publish = async (messageId) =>
    {
        if (!CROSSPOST || crosspostUnsupported || !messageId)
        {
            return false;
        }

        if (!transport.crosspost)
        {
            crosspostUnsupported = true;
            log('publishing needs a bot token - a webhook can post into an announcement ' + 'channel but cannot publish. Set OUTAGE_DISCORD_TOKEN, or drop ' + 'OUTAGE_DISCORD_WEBHOOK to use the bot transport.');

            return false;
        }

        const response = await call('POST', transport.crosspost(messageId));

        if (response.ok)
        {
            return true;
        }

        const payload = await response.json().catch(() => ({}));

        if (payload?.code === ALREADY_CROSSPOSTED)
        {
            return true;
        }

        if (response.status === 403 || CHANNEL_REFUSALS.has(payload?.code))
        {
            crosspostUnsupported = true;
            log(`publishing switched off: ${response.status} ${clip(JSON.stringify(payload), 160)}` + ' - is this an announcement channel, and may the bot publish in it?');

            return false;
        }

        if (response.status >= 400 && response.status < 500 && response.status !== 429)
        {
            log(`this message will not publish: ${response.status} ${clip(JSON.stringify(payload), 160)}`);

            return false;
        }

        log(`publish failed: ${response.status || 'network'} - will retry`);

        return false;
    };

    const postFollowUp = async (text, replyTo) =>
    {
        const body = {
            content:          clip(text, 1900),
            allowed_mentions: { parse: [] }
        };

        if (replyTo && transport.replies)
        {
            body.message_reference = {
                message_id:         replyTo,
                fail_if_not_exists: false
            };
        }

        return post(body);
    };

    const sync = async (published, now = Date.now()) =>
    {
        const incidents = Array.isArray(published?.incidents)
            ? published.incidents
            : null;

        if (!incidents)
        {
            return 0;
        }

        transport ??= await resolveTransport({
            channelId,
            tokenFile
        });

        if (!transport)
        {

            if (!announcedUnavailable)
            {
                announcedUnavailable = true;
                log(`${reason()} - outages will not be mirrored to Discord.`);
            }

            return 0;
        }

        if (!await acquire())
        {
            return 0;
        }

        try
        {
            return await reconcile(incidents, now);
        }
        catch (error)
        {
            log(`sync failed: ${error.message}`);

            return 0;
        }
        finally
        {
            await release();
        }
    };

    const shouldAnnounce = (incident, state, now) =>
    {
        const startedAt = Date.parse(incident.startedAt);

        if (!Number.isFinite(startedAt))
        {
            return false;
        }

        const declaredAt = Date.parse(incident.declaredAt ?? incident.startedAt);
        const clock = incident.manual && Number.isFinite(declaredAt)
            ? Math.max(startedAt, declaredAt)
            : startedAt;

        if (!incident.ongoing && clock < Date.parse(state.since))
        {
            return false;
        }

        if (now - clock > MAX_BACKFILL_MS)
        {
            return false;
        }

        return incident.manual || now - startedAt >= SETTLE_MS;
    };

    const reconcile = async (incidents, now) =>
    {
        const state = await readJson(stateFile, null) ?? {};

        state.version = 1;
        state.since ??= new Date(now - SETTLE_MS).toISOString();
        state.messages ??= {};

        const byId = new Map(incidents.map((incident) => [
            incident.id,
            incident
        ]));

        const footer = await resolveFooter(statusFile, now);

        let calls = 0;
        let changes = 0;

        for (const incident of incidents)
        {
            if (calls >= MAX_CALLS_PER_SYNC)
            {
                break;
            }

            const entry = state.messages[incident.id];
            const current = fingerprint(incident);

            if (!entry)
            {
                if (!shouldAnnounce(incident, state, now))
                {
                    continue;
                }

                calls += 1;

                const messageId = await post(buildMessage(incident, pageUrl, footer));

                if (!messageId)
                {
                    continue;
                }

                let published = false;

                if (CROSSPOST && !crosspostUnsupported && calls < MAX_CALLS_PER_SYNC)
                {
                    calls += 1;
                    published = await publish(messageId);
                }

                state.messages[incident.id] = {
                    messageId,
                    fingerprint: current,
                    title:       incident.title,
                    serviceName: incident.serviceName,
                    service:     incident.service ?? null,
                    startedAt:   incident.startedAt,
                    ongoing:     incident.ongoing,

                    lastUpdateAt:   newestUpdate(incident.updates)?.at ?? null,
                    resolvedPosted: !incident.ongoing,

                    periodCount:  (incident.periods ?? []).length,
                    published,
                    publishTries: 1,
                    postedAt:     new Date(now).toISOString()
                };

                changes += 1;

                continue;
            }

            const publishable = entry.messageId && !entry.published && (entry.publishTries ?? 0) < PUBLISH_MAX_TRIES && now - Date.parse(entry.postedAt ?? 0) <= PUBLISH_RETRY_WINDOW_MS;

            if (publishable && CROSSPOST && !crosspostUnsupported && calls < MAX_CALLS_PER_SYNC)
            {
                calls += 1;
                entry.publishTries = (entry.publishTries ?? 0) + 1;
                entry.published = await publish(entry.messageId);
            }

            if (entry.fingerprint === current)
            {
                continue;
            }

            if (!entry.messageId)
            {
                entry.fingerprint = current;
                entry.ongoing = incident.ongoing;

                continue;
            }

            calls += 1;

            const result = await edit(entry.messageId, buildMessage(incident, pageUrl, footer));

            if (result === 'failed')
            {
                continue;
            }

            if (result === 'gone')
            {

                entry.messageId = null;
            }

            entry.fingerprint = current;
            entry.title = incident.title;
            entry.serviceName = incident.serviceName;
            entry.ongoing = incident.ongoing;
            changes += 1;

            if (!entry.messageId)
            {
                continue;
            }

            const latest = newestUpdate(incident.updates);
            const seenAt = entry.lastUpdateAt
                ? Date.parse(entry.lastUpdateAt)
                : 0;
            const fresh = Boolean(latest) && Date.parse(latest.at) > seenAt;

            if (incident.ongoing)
            {
                entry.resolvedPosted = false;
            }

            const periods = incident.periods ?? [];
            const newestPeriod = periods[periods.length - 1];

            const recurred = periods.length > (entry.periodCount ?? 0) && now - Date.parse(newestPeriod?.startedAt ?? 0) <= MAX_BACKFILL_MS;

            const resolving = !incident.ongoing && !entry.resolvedPosted;

            if (recurred && calls < MAX_CALLS_PER_SYNC)
            {
                calls += 1;

                const newest = periods[periods.length - 1] ?? {};

                const recurrenceId = await postFollowUp(`${MARK.degraded} **${clip(incident.serviceName ?? 'Relaxy', 80)}** went down again` + ` - outage ${periods.length} in ${incident.spanText ?? incident.durationText}.` + (newest.ongoing
                    ? ' Still down.'
                    : ` Back after ${newest.durationText}.`));

                if (recurrenceId && calls < MAX_CALLS_PER_SYNC)
                {
                    calls += 1;
                    await publish(recurrenceId);
                }

                entry.resolvedPosted = !incident.ongoing;
            }

            entry.periodCount = periods.length;

            if (fresh && !resolving && calls < MAX_CALLS_PER_SYNC)
            {
                calls += 1;

                const label = latest.status && latest.status !== 'update'
                    ? ` · ${latest.status}`
                    : '';

                const pingId = await postFollowUp(`📣 **${clip(incident.serviceName ?? 'Relaxy', 80)}**${label}: ${clip(latest.body, 600)}`,
                    CROSSPOST_UPDATES
                        ? null
                        : entry.messageId);

                if (CROSSPOST_UPDATES && pingId && calls < MAX_CALLS_PER_SYNC)
                {
                    calls += 1;
                    await publish(pingId);
                }

                entry.lastUpdateAt = latest.at;
            }

            if (resolving && calls < MAX_CALLS_PER_SYNC)
            {
                calls += 1;

                const resolvedId = await postFollowUp(`${MARK.resolved} **${clip(incident.serviceName ?? 'Relaxy', 80)}** resolved after ${incident.durationText}.` + `${incident.resolution
                    ? ` ${clip(incident.resolution, 600)}`
                    : ''}`);

                if (resolvedId && calls < MAX_CALLS_PER_SYNC)
                {
                    calls += 1;
                    await publish(resolvedId);
                }

                entry.resolvedPosted = true;
                entry.lastUpdateAt = latest?.at ?? entry.lastUpdateAt;
            }
        }

        for (const [id, entry] of Object.entries(state.messages))
        {
            if (byId.has(id))
            {
                continue;
            }

            const successor = findSuccessor(entry, incidents);

            if (!entry.closed && entry.messageId && (entry.ongoing || successor) && calls < MAX_CALLS_PER_SYNC)
            {
                calls += 1;

                await edit(entry.messageId, buildClosure(entry, successor, pageUrl, footer));

                entry.ongoing = false;
                entry.closed = true;
                changes += 1;
            }

            const age = now - Date.parse(entry.postedAt ?? state.since);

            if (!entry.ongoing && age > PRUNE_AFTER_MS)
            {
                delete state.messages[id];
            }
        }

        await writeJson(stateFile, state);

        return changes;
    };

    const reason = () => (process.env.OUTAGE_ANNOUNCE === '0'
        ? 'announcing is switched off (OUTAGE_ANNOUNCE=0)'
        : 'no webhook and no bot token');

    return {
        sync,
        reason,

        available: async () =>
                   {
                       transport ??= await resolveTransport({
                           channelId,
                           tokenFile
                       });

                       return Boolean(transport);
                   }
    };
};

module.exports = { createAnnouncer };
