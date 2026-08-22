#!/usr/bin/env node

import {
    readFileSync,
    writeFileSync
} from 'node:fs';

const DASH = '/home/mattfor/relaxy/dashboard';
const OUT = '/home/mattfor/relaxy/error.html';

const css = readFileSync(`${DASH}/public/dashboard.css`, 'utf8');
const backgroundJs = readFileSync(`${DASH}/dist/background.js`, 'utf8').trim();
const themeInitJs = readFileSync(`${DASH}/dist/theme-init.js`, 'utf8').trim();

const topLevelRules = (source) =>
{
    const rules = [];
    let depth = 0;
    let buffer = '';

    for (const character of source)
    {
        buffer += character;

        if (character === '{')
        {
            depth += 1;
        }
        else if (character === '}')
        {
            depth -= 1;

            if (depth === 0)
            {
                rules.push(buffer.trim());
                buffer = '';
            }
        }
    }

    return rules;
};

const rules = topLevelRules(css);

const selectorOf = (rule) => rule
    .split('{')[0]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();

const ruleFor = (predicate) => rules.filter((rule) => predicate(selectorOf(rule)));

const rootRule = ruleFor((selector) => selector === ':root')[0] ?? '';
const lightRule = ruleFor((selector) => /\.light-mode\b/.test(selector) && selector.split(',').length < 3)[0] ?? '';

const backgroundCss = rules.filter((rule) =>
{
    const selector = selectorOf(rule);

    return /\bbg-fx\b/.test(selector) || selector === 'body::before' || /@keyframes\s+bg-fx-/.test(selector) || (/@media\s*\(prefers-reduced-motion/.test(selector) && /bg-fx/.test(rule)) || /@property\s+--halo/.test(selector);
}).join('\n\n');

const CHROME = [
    '.skip-link',
    '.btn',
    '.btn-ghost',
    '.shell',
    '.footer',
    '.footer-links',
    '.login-hero',
    '.eyebrow',
    '.tagline'
];

const chromeCss = ruleFor((selector) => selector.split(',').some((part) =>
{
    const trimmed = part.trim();

    return CHROME.some((wanted) => trimmed === wanted || trimmed.startsWith(`${wanted} `) || trimmed.startsWith(`${wanted}:`) || trimmed.startsWith(`${wanted}.`));
})).join('\n\n');

const MESSAGES = [
    [
        '404',
        'Page not found',
        'That page does not exist. It may have moved, or the link may have been wrong to begin with.'
    ],
    [
        '403',
        'Not allowed',
        'You do not have access to this. If you think you should, check you are signed in with the right account.'
    ],
    [
        '401',
        'Sign-in required',
        'This area needs credentials. If no login prompt appeared, reload the page.'
    ],
    [
        '429',
        'Slow down a moment',
        'Too many requests arrived too quickly, so this one was turned away. Wait a little and try again.'
    ],
    [
        '413',
        'That file is too large',
        'The upload exceeded the size this server accepts. Try something smaller.'
    ],
    [
        '400',
        'Malformed request',
        'The server could not make sense of that request. If you typed the address by hand, check it for typos.'
    ],
    [
        '405',
        'Not supported here',
        'This address does not accept that kind of request.'
    ],
    [
        '408',
        'Timed out',
        'The request took too long to arrive. That is usually a connection problem rather than a fault at this end.'
    ],
    [
        '500',
        'Server error',
        'An unexpected error occurred. This one is genuinely our fault, not yours, and it has been logged.'
    ],
    [
        '502',
        'Not answering',
        'The site is up, but the service behind this page is not responding. It may be restarting.'
    ],
    [
        '503',
        'Temporarily unavailable',
        'This service is down for the moment, most likely restarting or under maintenance. It should come back on its own.'
    ],
    [
        '504',
        'Took too long',
        'The service behind this page did not reply in time. It may be overloaded.'
    ]
];

const branches = MESSAGES.map(([code, title, message], index) => `    {{${index === 0
    ? 'if'
    : 'else if'} eq $code "${code}"}}
        <h1>${title}</h1>
        <p class="tagline">${message}</p>`).join('\n') + `
    {{else}}
        <h1>Something went wrong</h1>
        <p class="tagline">The server could not complete that request.</p>
    {{end}}`;

const MASCOT_SRC = 'https://cdn.relaxy.xyz/relaxy/website/img/mascot/relaxy_guy_nobg.webp';

const mascot = `<img class="mascot" id="mascotImg" src="${MASCOT_SRC}"
         width="210" height="210" alt="" decoding="async">
    <svg class="mascot" id="mascotSvg" viewBox="0 0 200 200" role="img" aria-label="Relaxy!" focusable="false" hidden>
        <defs>
            <linearGradient id="rx" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#ff69b4"/>
                <stop offset="100%" stop-color="#ff4069"/>
            </linearGradient>
        </defs>
        <rect width="200" height="200" rx="44" fill="url(#rx)"/>
        <path d="M62 88 q12 -11 24 0" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity="0.95"/>
        <path d="M114 88 q12 -11 24 0" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity="0.95"/>
        <path d="M78 120 q22 20 44 0" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity="0.95"/>
        <circle cx="52" cy="112" r="9" fill="#fff" opacity="0.22"/>
        <circle cx="148" cy="112" r="9" fill="#fff" opacity="0.22"/>
    </svg>`;

const html = `{{$code := placeholder "http.error.status_code"}}<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Error {{$code}} · Relaxy!</title>
<meta name="theme-color" content="#ff69b4">
<meta name="robots" content="noindex, nofollow">
<script>${themeInitJs}</script>
<style>
${rootRule}

${lightRule}

${backgroundCss}

${chromeCss}

* { box-sizing: border-box; }

body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    line-height: 1.6;
}

.shell { flex: 1; display: flex; align-items: center; justify-content: center; }

a { text-decoration: none; }

.mascot {
    width: clamp(150px, 24vw, 210px);
    height: auto;
    aspect-ratio: 1 / 1;
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    margin-bottom: var(--space-2);
    display: block;
}

.mascot[hidden] { display: none; }

h1 {
    font-size: clamp(1.6rem, 1.2rem + 2vw, 2.4rem);
    font-weight: 700;
    letter-spacing: -0.02em;
    margin: 0;
}

.actions { display: flex; flex-wrap: wrap; gap: var(--space-3); justify-content: center; margin-top: var(--space-3); }

.meta { margin-top: var(--space-6); color: var(--text-muted); font-size: 0.76rem; opacity: 0.75; }
.meta code { font-family: var(--mono); }
</style>
</head>
<body>
<main id="main-content" class="shell">
    <div class="login-hero">
        ${mascot}

        <p class="eyebrow">Error {{$code}}</p>

${branches}

        <div class="actions">
            <a class="btn" href="https://relaxy.xyz">Back to Relaxy!</a>
            <a class="btn btn-ghost" href="javascript:history.back()">Go back</a>
        </div>

        <p class="meta">
            <code>{{$code}} {{placeholder "http.error.status_text"}}</code>
            &nbsp;·&nbsp;
            <code>{{placeholder "http.request.host"}}</code>
        </p>
    </div>
</main>

<footer class="footer">
    <p>&copy; 2026 Relaxy! &middot; Made by MattFor &middot; All Rights Reserved</p>
    <p class="footer-links">
        <a href="https://relaxy.xyz">Home</a> &middot;
        <a href="https://discord.gg/xRAGVePxk6" target="_blank" rel="noopener">Support server</a> &middot;
        <a href="mailto:mattfor@relaxy.xyz">mattfor@relaxy.xyz</a>
    </p>
</footer>

<script>
${backgroundJs}
</script>
<script>
(function () {
    var img = document.getElementById('mascotImg');
    var svg = document.getElementById('mascotSvg');
    if (!img || !svg) { return; }

    img.addEventListener('error', function () {
        img.hidden = true;
        svg.hidden = false;
    });

    if (img.complete && img.naturalWidth === 0) {
        img.hidden = true;
        svg.hidden = false;
    }
})();
</script>
</body>
</html>
`;

writeFileSync(OUT, html, 'utf8');

console.log(`wrote ${OUT} (${Buffer.byteLength(html)} bytes)`);
console.log(`  tokens      ${rootRule.length} chars`);
console.log(`  background  ${backgroundCss.length} chars CSS + ${backgroundJs.length} chars JS`);
console.log(`  chrome      ${chromeCss.length} chars`);
console.log(`  codes       ${MESSAGES.length} mapped + fallback`);
