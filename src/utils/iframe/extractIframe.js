const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

const axiosConfig = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    },
    timeout: 10000
};

function resolveUrl(base, link) {
    try {
        if (!link) return null;
        // handle protocol-relative
        if (link.startsWith('//')) return new URL(link, 'https:').href;
        if (/^https?:\/\//i.test(link)) return link;
        if (!base) return link;
        return new URL(link, base).href;
    } catch (e) {
        return link;
    }
}

async function fetchHtml(url) {
    const res = await axios.get(url, axiosConfig);
    return res.data;
}

/**
 * Extract direct media sources (m3u8, mp4, etc.) from iframe HTML or URL
 * @param {String} urlOrHtml - either a full URL to fetch or raw HTML string
 * @param {Object} opts - { base } where base is used to resolve relative URLs
 * @returns {Array} [{ url, type }]
 */
async function extractSourcesFromIframe(urlOrHtml, opts = {}) {
    let html = '';
    let base = opts.base || null;

    if (typeof urlOrHtml !== 'string') return [];

    if (/^https?:\/\//i.test(urlOrHtml) || urlOrHtml.startsWith('//')) {
        const fetchUrl = urlOrHtml.startsWith('//') ? `https:${urlOrHtml}` : urlOrHtml;
        html = await fetchHtml(fetchUrl);
        base = base || fetchUrl;
    } else {
        html = urlOrHtml;
    }

    const $ = cheerio.load(html || '');
    const found = [];
    const seen = new Set();

    const push = (u) => {
        if (!u) return;
        const url = resolveUrl(base, u);
        if (!url) return;
        const key = url.trim();
        if (seen.has(key)) return;
        seen.add(key);
        const lower = url.toLowerCase();
        let type = 'unknown';
        if (lower.includes('.m3u8')) type = 'hls';
        else if (lower.includes('.mp4')) type = 'mp4';
        else if (lower.includes('.mkv')) type = 'video';
        found.push({ url, type });
    };

    // 1) meta tags (og:video, twitter:player)
    const metaOgVideo = $('meta[property="og:video"]').attr('content') || $('meta[name="og:video"]').attr('content');
    if (metaOgVideo) push(metaOgVideo);
    const metaTwitter = $('meta[name="twitter:player:stream"]').attr('content');
    if (metaTwitter) push(metaTwitter);

    // 2) <video> tag and <source>
    $('video').each((i, v) => {
        const src = $(v).attr('src');
        if (src) push(src);
        $(v).find('source').each((j, s) => {
            const ssrc = $(s).attr('src') || $(s).attr('data-src');
            if (ssrc) push(ssrc);
        });
    });

    // 3) plain <source> tags
    $('source').each((i, s) => {
        const ssrc = $(s).attr('src') || $(s).attr('data-src');
        if (ssrc) push(ssrc);
    });

    // 4) data-* attributes commonly used for players
    $('[data-src], [data-hls], [data-file], [data-video]').each((i, el) => {
        const $el = $(el);
        const attrs = ['data-src', 'data-hls', 'data-file', 'data-video', 'data-url'];
        for (const a of attrs) {
            const val = $el.attr(a);
            if (val) push(val);
        }
    });

    // 5) search script tags for urls (m3u8, mp4)
    const urlRegex = /(https?:)?\/\/[^\s'"<>]+?\.(m3u8|mp4|mkv)(?:[^\s'"\<\>]*)/ig;
    $('script').each((i, s) => {
        const txt = $(s).html() || '';
        let m;
        while ((m = urlRegex.exec(txt)) !== null) {
            let u = m[0];
            // fix protocol-relative
            if (u.startsWith('//')) u = 'https:' + u;
            // sometimes match returns leading ':' from (https?:)
            if (u.startsWith(':')) u = u.slice(1);
            push(u);
        }

        // look for jwplayer/file: pattern
        const jwMatch = txt.match(/file\s*[:=]\s*["']([^"']+\.(m3u8|mp4|mkv))/i);
        if (jwMatch && jwMatch[1]) push(jwMatch[1]);

        // look for sources: [{file: '...'}]
        const sourcesMatch = txt.match(/sources\s*[:=]\s*(\[\s*\{[\s\S]*?\}\s*\])/i);
        if (sourcesMatch && sourcesMatch[1]) {
            // extract urls inside
            let m2;
            const inner = sourcesMatch[1];
            const innerUrlRegex = /['"](https?:\/\/[^'"\]]+?\.(m3u8|mp4|mkv)[^'"\]]*)['"]/ig;
            while ((m2 = innerUrlRegex.exec(inner)) !== null) push(m2[1]);
        }
    });

    // 6) try to find plain links in anchor tags
    $('a').each((i, a) => {
        const href = $(a).attr('href');
        if (href && /(\.m3u8|\.mp4|\.mkv)/i.test(href)) push(href);
    });

    // 7) last-resort: look for any URL-like tokens in the whole HTML
    if (found.length === 0) {
        const whole = $.root().text();
        let m;
        while ((m = urlRegex.exec(whole)) !== null) {
            let u = m[0];
            if (u.startsWith('//')) u = 'https:' + u;
            if (u.startsWith(':')) u = u.slice(1);
            push(u);
        }
    }

    return found;
}

module.exports = {
    extractSourcesFromIframe
};
