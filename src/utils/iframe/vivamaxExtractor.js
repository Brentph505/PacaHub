const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

/**
 * Vivavmax-specific extractor that uses vivamaxstream.com as referrer
 * to bypass embedding restrictions
 */

const VIVAVAX_BASE = 'https://vivamaxstream.com';

const axiosConfig = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': VIVAVAX_BASE,
        'Origin': VIVAVAX_BASE
    },
    timeout: 15000
};

function resolveUrl(base, link) {
    try {
        if (!link) return null;
        if (link.startsWith('//')) return new URL(link, 'https:').href;
        if (/^https?:\/\//i.test(link)) return link;
        if (!base) return link;
        return new URL(link, base).href;
    } catch (e) {
        return link;
    }
}

/**
 * Fetch HTML with Vivavmax context (headers)
 */
async function fetchHtmlWithVivaMaxContext(url) {
    const config = {
        ...axiosConfig,
        headers: {
            ...axiosConfig.headers,
            'Referer': url || VIVAVAX_BASE
        }
    };
    const res = await axios.get(url, config);
    return res.data;
}

/**
 * Extract m3u8 and other sources from iframe with Vivavmax domain context
 */
async function extractM3U8FromIframe(iframeUrl, opts = {}) {
    try {
        if (!iframeUrl) return [];

        let html = '';
        let base = iframeUrl;

        // Fetch iframe content with Vivavmax referrer
        html = await fetchHtmlWithVivaMaxContext(iframeUrl);

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

        // 1) Meta tags
        const metaOgVideo = $('meta[property="og:video"]').attr('content') || 
                           $('meta[name="og:video"]').attr('content');
        if (metaOgVideo) push(metaOgVideo);

        const metaTwitter = $('meta[name="twitter:player:stream"]').attr('content');
        if (metaTwitter) push(metaTwitter);

        // 2) Video tag and sources
        $('video').each((i, v) => {
            const src = $(v).attr('src');
            if (src) push(src);
            $(v).find('source').each((j, s) => {
                const ssrc = $(s).attr('src') || $(s).attr('data-src');
                if (ssrc) push(ssrc);
            });
        });

        // 3) Standalone source tags
        $('source').each((i, s) => {
            const ssrc = $(s).attr('src') || $(s).attr('data-src');
            if (ssrc) push(ssrc);
        });

        // 4) Data attributes
        $('[data-src], [data-hls], [data-file], [data-video], [data-playlist]').each((i, el) => {
            const $el = $(el);
            const attrs = ['data-src', 'data-hls', 'data-file', 'data-video', 'data-url', 'data-playlist'];
            for (const a of attrs) {
                const val = $el.attr(a);
                if (val) push(val);
            }
        });

        // 5) Script tags for URLs (m3u8, mp4, etc.)
        const urlRegex = /(https?:)?\/\/[^\s'"<>]+?\.(m3u8|mp4|mkv)(?:[^\s'"\<\>]*)/ig;
        $('script').each((i, s) => {
            const txt = $(s).html() || '';
            let m;
            while ((m = urlRegex.exec(txt)) !== null) {
                let u = m[0];
                if (u.startsWith('//')) u = 'https:' + u;
                if (u.startsWith(':')) u = u.slice(1);
                push(u);
            }

            // JWPlayer pattern
            const jwMatch = txt.match(/file\s*[:=]\s*["']([^"']+\.(m3u8|mp4|mkv))/i);
            if (jwMatch && jwMatch[1]) push(jwMatch[1]);

            // Sources array pattern
            const sourcesMatch = txt.match(/sources\s*[:=]\s*(\[\s*\{[\s\S]*?\}\s*\])/i);
            if (sourcesMatch && sourcesMatch[1]) {
                let m2;
                const inner = sourcesMatch[1];
                const innerUrlRegex = /['"](https?:\/\/[^'"\]]+?\.(m3u8|mp4|mkv)[^'"\]]*)['"]/ig;
                while ((m2 = innerUrlRegex.exec(inner)) !== null) push(m2[1]);
            }
        });

        // 6) Links
        $('a').each((i, a) => {
            const href = $(a).attr('href');
            if (href && /(\.m3u8|\.mp4|\.mkv)/i.test(href)) push(href);
        });

        // 7) Last resort: text content
        if (found.length === 0) {
            const whole = $.root().text();
            let m;
            const textRegex = /(https?:\/\/[^\s]+\.(m3u8|mp4|mkv))/ig;
            while ((m = textRegex.exec(whole)) !== null) {
                push(m[1]);
            }
        }

        return found;
    } catch (err) {
        console.error('Error extracting m3u8 from iframe:', err.message);
        return [];
    }
}

/**
 * Extract all streams from a video page
 */
async function extractFromVideoPage(videoUrl) {
    try {
        const html = await fetchHtmlWithVivaMaxContext(videoUrl);
        const $ = cheerio.load(html);

        const streams = [];
        const seen = new Set();

        // Find all iframes
        const iframes = [];
        $('iframe').each((i, el) => {
            const src = $(el).attr('src');
            if (src) iframes.push(src);
        });

        console.log(`Found ${iframes.length} iframes in page`);

        // Extract from each iframe
        for (const iframeUrl of iframes) {
            const sources = await extractM3U8FromIframe(iframeUrl);
            for (const source of sources) {
                if (!seen.has(source.url)) {
                    seen.add(source.url);
                    streams.push({
                        ...source,
                        from: iframeUrl
                    });
                }
            }
        }

        return streams;
    } catch (err) {
        console.error('Error extracting from video page:', err.message);
        return [];
    }
}

/**
 * Proxy m3u8 with Vivavmax headers
 * Useful for bypassing CORS or embedding restrictions
 */
async function proxyM3U8(m3u8Url, opts = {}) {
    try {
        const config = {
            ...axiosConfig,
            headers: {
                ...axiosConfig.headers,
                'Referer': opts.referer || VIVAVAX_BASE
            }
        };
        const res = await axios.get(m3u8Url, config);
        return res.data;
    } catch (err) {
        console.error('Error proxying m3u8:', err.message);
        return null;
    }
}

module.exports = {
    extractM3U8FromIframe,
    extractFromVideoPage,
    proxyM3U8,
    VIVAVAX_BASE
};
