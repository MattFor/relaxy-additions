#!/usr/bin/env node

'use strict';

import path from 'node:path';
import fs   from 'node:fs/promises';

const COMMANDS_DIR = '/home/mattfor/relaxy/bot/bot/commands';
const OUTPUT_PATH = '/home/mattfor/cdn/relaxy/website/scripts/commands.js';
const OUTPUT_MIN_PATH = '/home/mattfor/cdn/relaxy/website/scripts/commands.min.js';

const CATEGORY_ORDER = [
    'fun',
    'image',
    'miscellaneous',
    'moderation',
    'music',
    'administrator'
];

const IDENT_START = /[A-Za-z_$]/;
const IDENT_RE = /[A-Za-z_$][\w$]*/y;
const NUMBER_RE = /(?:0[xXoObB][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)n?/y;
const OPENERS = '{[(';
const CLOSERS = '}])';

const KEYWORDS_BEFORE_REGEX = new Set([
    'return',
    'typeof',
    'instanceof',
    'in',
    'of',
    'new',
    'delete',
    'void',
    'case',
    'do',
    'else',
    'yield',
    'await',
    'throw'
]);

function regexAllowed(previous)
{
    if (!previous)
    {
        return true;
    }
    if (previous.type === 'punct')
    {
        return !CLOSERS.includes(previous.value);
    }
    if (previous.type === 'ident')
    {
        return KEYWORDS_BEFORE_REGEX.has(previous.value);
    }
    return false;
}

function readQuoted(source, i)
{
    const quote = source[i];
    for (let j = i + 1; j < source.length; j++)
    {
        const ch = source[j];
        if (ch === '\\')
        {
            j++;
            continue;
        }
        if (ch === quote)
        {
            return j + 1;
        }

        if (ch === '\n' && quote !== '`')
        {
            return j;
        }
    }
    return source.length;
}

function readRegex(source, i)
{
    let inClass = false;
    for (let j = i + 1; j < source.length; j++)
    {
        const ch = source[j];
        if (ch === '\\')
        {
            j++;
            continue;
        }
        if (ch === '\n')
        {
            return -1;
        }
        if (ch === '[')
        {
            inClass = true;
        }
        else if (ch === ']')
        {
            inClass = false;
        }
        else if (ch === '/' && !inClass)
        {
            let k = j + 1;
            while (k < source.length && /[a-z]/.test(source[k]))
            {
                k++;
            }
            return k;
        }
    }
    return -1;
}

function tokenize(source)
{
    const tokens = [];
    const stack = [];
    let template = null;
    let previous = null;
    let buried = 0;
    let i = 0;

    const push = token =>
    {
        if (buried === 0)
        {
            tokens.push(token);
        }
        previous = token;
    };

    while (i < source.length)
    {

        if (template)
        {
            const ch = source[i];

            if (ch === '\\')
            {
                i += 2;
                continue;
            }

            if (ch === '`')
            {
                i++;
                stack.pop();
                push({
                    type:  'template',
                    value: source.slice(template.start, i),
                    start: template.start,
                    end:   i
                });
                template = null;
                continue;
            }

            if (ch === '$' && source[i + 1] === '{')
            {
                stack.push({
                    kind: 'interpolation',
                    template
                });
                template = null;
                buried++;
                i += 2;
                continue;
            }

            i++;
            continue;
        }

        const ch = source[i];

        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '﻿')
        {
            i++;
            continue;
        }

        if (ch === '/')
        {
            if (source[i + 1] === '/')
            {
                const newline = source.indexOf('\n', i + 2);
                i = newline === -1
                    ? source.length
                    : newline;
                continue;
            }

            if (source[i + 1] === '*')
            {
                const end = source.indexOf('*/', i + 2);
                i = end === -1
                    ? source.length
                    : end + 2;
                continue;
            }

            if (regexAllowed(previous))
            {
                const end = readRegex(source, i);
                if (end !== -1)
                {
                    push({
                        type:  'regex',
                        value: source.slice(i, end),
                        start: i,
                        end
                    });
                    i = end;
                    continue;
                }
            }

            push({
                type:  'punct',
                value: '/',
                start: i,
                end:   i + 1
            });
            i++;
            continue;
        }

        if (ch === '"' || ch === '\'')
        {
            const end = readQuoted(source, i);
            push({
                type:  'string',
                value: source.slice(i, end),
                start: i,
                end
            });
            i = end;
            continue;
        }

        if (ch === '`')
        {
            template = {
                kind:  'template',
                start: i
            };
            stack.push(template);
            i++;
            continue;
        }

        if (ch === '}')
        {
            const frame = stack.pop();

            if (frame && frame.kind === 'interpolation')
            {
                template = frame.template;
                buried--;
                i++;
                continue;
            }

            push({
                type:  'punct',
                value: '}',
                start: i,
                end:   i + 1
            });
            i++;
            continue;
        }

        if (ch === '{')
        {
            stack.push({ kind: 'brace' });
            push({
                type:  'punct',
                value: '{',
                start: i,
                end:   i + 1
            });
            i++;
            continue;
        }

        if (IDENT_START.test(ch))
        {
            IDENT_RE.lastIndex = i;
            const match = IDENT_RE.exec(source);
            push({
                type:  'ident',
                value: match[0],
                start: i,
                end:   IDENT_RE.lastIndex
            });
            i = IDENT_RE.lastIndex;
            continue;
        }

        if ((ch >= '0' && ch <= '9') || (ch === '.' && source[i + 1] >= '0' && source[i + 1] <= '9'))
        {
            NUMBER_RE.lastIndex = i;
            const match = NUMBER_RE.exec(source);
            const end = match
                ? NUMBER_RE.lastIndex
                : i + 1;
            push({
                type:  'number',
                value: source.slice(i, end),
                start: i,
                end
            });
            i = end;
            continue;
        }

        push({
            type:  'punct',
            value: ch,
            start: i,
            end:   i + 1
        });
        i++;
    }

    return tokens;
}

function isPunct(token, value)
{
    return Boolean(token) && token.type === 'punct' && token.value === value;
}

function isIdent(token, value)
{
    return Boolean(token) && token.type === 'ident' && token.value === value;
}

function matchBracket(tokens, open)
{
    let depth = 0;

    for (let i = open; i < tokens.length; i++)
    {
        const token = tokens[i];
        if (token.type !== 'punct')
        {
            continue;
        }

        if (OPENERS.includes(token.value))
        {
            depth++;
        }
        else if (CLOSERS.includes(token.value))
        {
            depth--;
            if (depth === 0)
            {
                return i;
            }
        }
    }

    return -1;
}

function findCommandObject(tokens)
{
    let depth = 0;

    for (let i = 0; i < tokens.length; i++)
    {
        const token = tokens[i];

        if (token.type === 'punct')
        {
            if (OPENERS.includes(token.value))
            {
                depth++;
            }
            else if (CLOSERS.includes(token.value))
            {
                depth--;
            }
            continue;
        }

        if (depth !== 0 || token.type !== 'ident')
        {
            continue;
        }

        let open = -1;

        if (token.value === 'export' && isIdent(tokens[i + 1], 'default') && isPunct(tokens[i + 2], '{'))
        {
            open = i + 2;
        }
        else if (token.value === 'module' && isPunct(tokens[i + 1], '.') && isIdent(tokens[i + 2], 'exports') && isPunct(tokens[i + 3], '=') && isPunct(tokens[i + 4], '{'))
        {
            open = i + 4;
        }

        if (open === -1)
        {
            continue;
        }

        const close = matchBracket(tokens, open);
        if (close !== -1)
        {
            return {
                open,
                close
            };
        }
    }

    return null;
}

function readProperties(tokens, open, close, source)
{
    const properties = new Map();
    let depth = 0;
    let i = open + 1;

    while (i < close)
    {
        const token = tokens[i];

        if (token.type === 'punct')
        {
            if (OPENERS.includes(token.value))
            {
                depth++;
                i++;
                continue;
            }
            if (CLOSERS.includes(token.value))
            {
                depth--;
                i++;
                continue;
            }
        }

        if (depth !== 0)
        {
            i++;
            continue;
        }

        const key = propertyKey(token);

        if (key === null || !isPunct(tokens[i + 1], ':'))
        {
            i++;
            continue;
        }

        let j = i + 2;
        let valueDepth = 0;
        const start = tokens[j]
            ? tokens[j].start
            : token.end;
        let end = start;

        while (j < close)
        {
            const value = tokens[j];

            if (value.type === 'punct')
            {
                if (OPENERS.includes(value.value))
                {
                    valueDepth++;
                }
                else if (CLOSERS.includes(value.value))
                {
                    if (valueDepth === 0)
                    {
                        break;
                    }
                    valueDepth--;
                }
                else if (value.value === ',' && valueDepth === 0)
                {
                    break;
                }
            }

            end = value.end;
            j++;
        }

        if (!properties.has(key))
        {
            properties.set(key, source.slice(start, end).trim());
        }

        i = j;
    }

    return properties;
}

function propertyKey(token)
{
    if (token.type === 'ident' || token.type === 'number')
    {
        return token.value;
    }
    if (token.type === 'string')
    {
        return decodeString(token.value);
    }
    return null;
}

const SIMPLE_ESCAPES = {
    n: '\n',
    t: '\t',
    r: '\r',
    b: '\b',
    f: '\f',
    v: '\v',
    0: '\0'
};

function unescape(body)
{
    let out = '';

    for (let i = 0; i < body.length; i++)
    {
        const ch = body[i];

        if (ch !== '\\')
        {
            out += ch;
            continue;
        }

        const next = body[++i];
        if (next === undefined)
        {
            break;
        }

        if (next === '\n')
        {
            continue;
        }
        if (next === '\r')
        {
            if (body[i + 1] === '\n')
            {
                i++;
            }
            continue;
        }

        if (next === 'x')
        {
            const hex = body.slice(i + 1, i + 3);
            if (/^[\da-fA-F]{2}$/.test(hex))
            {
                out += String.fromCharCode(parseInt(hex, 16));
                i += 2;
                continue;
            }
        }

        if (next === 'u')
        {
            if (body[i + 1] === '{')
            {
                const end = body.indexOf('}', i + 2);
                const hex = end === -1
                    ? ''
                    : body.slice(i + 2, end);
                if (/^[\da-fA-F]{1,6}$/.test(hex))
                {
                    out += String.fromCodePoint(parseInt(hex, 16));
                    i = end;
                    continue;
                }
            }
            else
            {
                const hex = body.slice(i + 1, i + 5);
                if (/^[\da-fA-F]{4}$/.test(hex))
                {
                    out += String.fromCharCode(parseInt(hex, 16));
                    i += 4;
                    continue;
                }
            }
        }

        out += Object.hasOwn(SIMPLE_ESCAPES, next)
            ? SIMPLE_ESCAPES[next]
            : next;
    }

    return out;
}

function decodeString(raw)
{
    const quote = raw[0];
    if (raw.length < 2 || (quote !== '"' && quote !== '\''))
    {
        return null;
    }
    return unescape(raw.slice(1,
        raw.endsWith(quote)
            ? -1
            : undefined));
}

function hasInterpolation(raw)
{
    const body = raw.slice(1, -1);

    for (let i = 0; i < body.length; i++)
    {
        if (body[i] === '\\')
        {
            i++;
            continue;
        }
        if (body[i] === '$' && body[i + 1] === '{')
        {
            return true;
        }
    }

    return false;
}

function stripInterpolations(body)
{
    let out = '';
    let i = 0;

    while (i < body.length)
    {
        const ch = body[i];

        if (ch === '\\')
        {
            out += body.slice(i, i + 2);
            i += 2;
            continue;
        }

        if (ch === '$' && body[i + 1] === '{')
        {
            let depth = 1;
            let j = i + 2;

            while (j < body.length && depth > 0)
            {
                const inner = body[j];

                if (inner === '\\')
                {
                    j += 2;
                    continue;
                }
                if (inner === '"' || inner === '\'' || inner === '`')
                {
                    j = readQuoted(body, j);
                    continue;
                }
                if (inner === '{')
                {
                    depth++;
                }
                else if (inner === '}')
                {
                    depth--;
                }

                j++;
            }

            i = j;
            continue;
        }

        out += ch;
        i++;
    }

    return out;
}

function tidy(text)
{
    return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

const UNSAFE_IN_CONSTANT = new Set([
    'new',
    'require',
    'import',
    'await',
    'eval',
    'Function',
    'process',
    'globalThis',
    'fs',
    'child_process'
]);

const UNSAFE_TEXT = /\b(?:new|require|import|await|eval|Function|process|globalThis|fs|child_process)\b/;

function looksUnsafe(tokens)
{
    return tokens.some(token => (token.type === 'ident' && UNSAFE_IN_CONSTANT.has(token.value)) || (token.type === 'template' && UNSAFE_TEXT.test(token.value)));
}

function collectModuleConstants(tokens, source, limit)
{
    const constants = [];
    let depth = 0;
    let i = 0;

    while (i < limit)
    {
        const token = tokens[i];

        if (token.type === 'punct')
        {
            if (OPENERS.includes(token.value))
            {
                depth++;
            }
            else if (CLOSERS.includes(token.value))
            {
                depth--;
            }
            i++;
            continue;
        }

        if (depth !== 0 || !isIdent(token, 'const') || tokens[i + 1]?.type !== 'ident' || !isPunct(tokens[i + 2], '='))
        {
            i++;
            continue;
        }

        let j = i + 3;
        let valueDepth = 0;
        const start = tokens[j]
            ? tokens[j].start
            : tokens[i + 2].end;
        let end = start;
        const body = [];

        while (j < limit)
        {
            const value = tokens[j];

            if (value.type === 'punct')
            {
                if (OPENERS.includes(value.value))
                {
                    valueDepth++;
                }
                else if (CLOSERS.includes(value.value))
                {
                    if (valueDepth === 0)
                    {
                        break;
                    }
                    valueDepth--;
                }
                else if ((value.value === ';' || value.value === ',') && valueDepth === 0)
                {
                    break;
                }
            }

            body.push(value);
            end = value.end;
            j++;
        }

        constants.push({
            name:       tokens[i + 1].value,
            expression: source.slice(start, end).trim(),
            tokens:     body
        });

        i = j;
    }

    return constants;
}

function makeTemplateReader(constants)
{
    let names = null;
    let values = null;

    const buildScope = () =>
    {
        names = [];
        values = [];

        for (const constant of constants)
        {
            if (names.includes(constant.name))
            {
                continue;
            }
            if (looksUnsafe(constant.tokens))
            {
                continue;
            }

            try
            {
                const read = new Function(...names, `"use strict"; return (${constant.expression});`);
                const value = read(...values);
                names.push(constant.name);
                values.push(value);
            }
            catch
            {

            }
        }
    };

    return raw =>
    {
        if (names === null)
        {
            buildScope();
        }

        try
        {
            const read = new Function(...names, `"use strict"; return (${raw});`);
            const value = read(...values);
            return typeof value === 'string'
                ? value
                : null;
        }
        catch
        {
            return null;
        }
    };
}

function decodeTemplateToken(raw, readTemplate, unresolved, key)
{
    const body = raw.slice(1, -1);

    if (!hasInterpolation(raw))
    {
        return unescape(body);
    }

    const evaluated = readTemplate(raw);
    if (evaluated !== null)
    {
        return evaluated;
    }

    unresolved.push(key);
    return tidy(unescape(stripInterpolations(body)));
}

function decodeLiteralExpression(tokens, from, to, readTemplate, unresolved, key)
{
    let out = '';
    let wantLiteral = true;

    for (let i = from; i < to; i++)
    {
        const token = tokens[i];

        if (!wantLiteral)
        {
            if (!isPunct(token, '+'))
            {
                return null;
            }
            wantLiteral = true;
            continue;
        }

        let value = null;

        if (token.type === 'string')
        {
            value = decodeString(token.value);
        }
        else if (token.type === 'template')
        {
            value = decodeTemplateToken(token.value, readTemplate, unresolved, key);
        }

        if (value === null)
        {
            return null;
        }

        out += value;
        wantLiteral = false;
    }

    return wantLiteral
        ? null
        : out;
}

function readText(properties, key, readTemplate, unresolved)
{
    const raw = properties.get(key);
    if (raw === undefined)
    {
        return null;
    }

    const tokens = tokenize(raw);
    return decodeLiteralExpression(tokens, 0, tokens.length, readTemplate, unresolved, key);
}

function readBoolean(properties, key)
{
    return properties.get(key) === 'true';
}

function readStringArray(properties, key, readTemplate, unresolved)
{
    const raw = properties.get(key);
    if (raw === undefined || raw[0] !== '[')
    {
        return [];
    }

    const tokens = tokenize(raw);
    const close = matchBracket(tokens, 0);
    if (close === -1)
    {
        return [];
    }

    const out = [];
    let depth = 0;
    let start = 1;

    for (let i = 1; i <= close; i++)
    {
        const token = tokens[i];
        const last = i === close;

        if (!last && token.type === 'punct')
        {
            if (OPENERS.includes(token.value))
            {
                depth++;
                continue;
            }
            if (CLOSERS.includes(token.value))
            {
                depth--;
                continue;
            }
        }

        if (!last && !(depth === 0 && isPunct(token, ',')))
        {
            continue;
        }

        const value = decodeLiteralExpression(tokens, start, i, readTemplate, unresolved, key);
        if (value !== null)
        {
            out.push(value);
        }

        start = i + 1;
    }

    return out;
}

function extractCommand(source)
{
    const tokens = tokenize(source);
    const object = findCommandObject(tokens);

    if (!object)
    {
        return null;
    }

    const properties = readProperties(tokens, object.open, object.close, source);
    const readTemplate = makeTemplateReader(collectModuleConstants(tokens, source, object.open));
    const unresolved = [];

    const name = readText(properties, 'name', readTemplate, unresolved);
    if (!name)
    {
        return null;
    }

    return {
        name,
        usage:       readText(properties, 'usage', readTemplate, unresolved) ?? '',
        description: readText(properties, 'description', readTemplate, unresolved) ?? '',
        aliases:     readStringArray(properties, 'aliases', readTemplate, unresolved),
        owner:       readBoolean(properties, 'owner'),
        unresolved
    };
}

async function walkCommandFiles(dir)
{
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];

    for (const entry of entries)
    {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory())
        {
            files.push(...await walkCommandFiles(full));
        }
        else if (entry.isFile() && entry.name.endsWith('.js'))
        {
            files.push(full);
        }
    }

    return files.sort();
}

async function writeAtomic(target, content)
{
    const temporary = `${target}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, target);
}

async function main()
{
    const includeAll = process.argv.includes('all');

    let files;
    try
    {
        files = await walkCommandFiles(COMMANDS_DIR);
    }
    catch (e)
    {
        console.error(`Failed to read commands directory (${COMMANDS_DIR}): ${e.message}`);
        process.exit(1);
    }

    const byCategory = {};
    const seen = new Map();
    const warnings = [];
    let skipped = 0;

    for (const filePath of files)
    {
        const relative = path.relative(COMMANDS_DIR, filePath);
        const segments = relative.split(path.sep);
        const source = await fs.readFile(filePath, 'utf8');
        const command = extractCommand(source);

        if (!command)
        {
            warnings.push(`no command object found in ${relative}`);
            skipped++;
            continue;
        }

        if (segments.length < 2)
        {
            warnings.push(`${relative} sits outside a category folder, filed under miscellaneous`);
        }

        const category = (segments.length > 1
            ? segments[0]
            : 'miscellaneous').toLowerCase();

        if (seen.has(command.name))
        {
            warnings.push(`duplicate command name "${command.name}" in ${relative}, already taken by ${seen.get(command.name)}`);
            continue;
        }
        seen.set(command.name, relative);

        for (const field of command.unresolved)
        {
            warnings.push(`${relative}: could not resolve the template in "${field}", kept the fixed text only`);
        }

        if (!includeAll && (command.owner || category === 'administrator'))
        {
            continue;
        }

        (byCategory[category] ??= []).push({
            name:        command.name,
            usage:       command.usage,
            description: command.description,
            aliases:     command.aliases.filter(alias => alias && alias.toLowerCase() !== command.name.toLowerCase())
        });
    }

    const categories = Object.keys(byCategory).sort((a, b) =>
    {
        const ia = CATEGORY_ORDER.indexOf(a);
        const ib = CATEGORY_ORDER.indexOf(b);
        return (ia === -1
            ? CATEGORY_ORDER.length
            : ia) - (ib === -1
            ? CATEGORY_ORDER.length
            : ib) || a.localeCompare(b);
    });

    const catalogue = {};
    let total = 0;
    let body = '';

    for (const category of categories)
    {
        const list = byCategory[category].sort((a, b) => a.name.localeCompare(b.name));
        body += `\n    // ===== ${category.toUpperCase()} =====\n`;

        for (const cmd of list)
        {
            const entry = {
                c: category,
                a: cmd.aliases.length
                       ? cmd.aliases
                       : null,
                u: cmd.usage,
                d: cmd.description
            };

            catalogue[cmd.name] = entry;

            body += `    ${JSON.stringify(cmd.name)}: { "c": ${JSON.stringify(entry.c)}, "a": ${JSON.stringify(entry.a)}, "u": ${JSON.stringify(entry.u)}, "d": ${JSON.stringify(entry.d)} },\n`;
            total++;
        }
    }

    const header = '// Auto-generated - do not edit.' + ` Generated ${new Date().toISOString()}, ${total} commands.`;

    const content = `${header}

const RELAXY_COMMANDS = {${body}};

if (typeof window !== 'undefined')
{
    window.RELAXY_COMMANDS = RELAXY_COMMANDS;
}

if (typeof module !== 'undefined' && module.exports)
{
    module.exports = RELAXY_COMMANDS;
}
`;

    const minified = `const RELAXY_COMMANDS=${JSON.stringify(catalogue)};` + 'typeof window!=="undefined"&&(window.RELAXY_COMMANDS=RELAXY_COMMANDS);' + 'typeof module!=="undefined"&&module.exports&&(module.exports=RELAXY_COMMANDS);\n';

    await writeAtomic(OUTPUT_PATH, content);
    await writeAtomic(OUTPUT_MIN_PATH, minified);

    for (const warning of warnings)
    {
        console.warn(`  ! ${warning}`);
    }

    const saved = Math.round((1 - minified.length / content.length) * 100);
    console.log(`Exported ${total} commands to ${OUTPUT_PATH}${skipped
        ? ` (${skipped} files skipped, no command object found)`
        : ''}`);
    console.log(`Minified ${OUTPUT_MIN_PATH} (${minified.length} bytes, ${saved}% smaller)`);
}

main().catch(e =>
{
    console.error('Fatal error:', e);
    process.exit(1);
});
