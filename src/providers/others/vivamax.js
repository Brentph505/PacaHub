const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://vivamaxstream.com';

const axiosConfig = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    },
    timeout: 10000
};

const iframeAxiosConfig = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': BASE_URL
    },
    timeout: 10000
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Clean and normalize text
 */
function cleanText(s) {
    if (!s) return '';
    return s.replace(/\s+/g, ' ').trim();
}

/**
 * Extract slug from URL
 * Examples:
 * - https://vivamaxstream.com/movies/vivamax-sagaran-2026 -> vivamax-sagaran-2026
 * - /movies/vivamax-sagaran-2026 -> vivamax-sagaran-2026
 * - /genre/drama -> drama
 */
function extractSlug(url) {
    if (!url) return null;
    
    try {
        // Remove base URL if present
        let path = url.replace(BASE_URL, '');
        
        // Remove query params and hash
        path = path.split('?')[0].split('#')[0];
        
        // Remove leading/trailing slashes
        path = path.replace(/^\/+|\/+$/g, '');
        
        // Get the last segment (the actual slug)
        const segments = path.split('/').filter(Boolean);
        return segments.length > 0 ? segments[segments.length - 1] : null;
    } catch (err) {
        return null;
    }
}

/**
 * Extract category type from URL path
 * /movies/... -> 'movie'
 * /genre/... -> 'genre'
 * /category/... -> 'category'
 */
function extractType(url) {
    if (!url) return 'movie';
    
    const path = url.replace(BASE_URL, '').toLowerCase();
    if (path.includes('/genre/')) return 'genre';
    if (path.includes('/category/')) return 'category';
    if (path.includes('/actor/') || path.includes('/cast/')) return 'actor';
    return 'movie';
}

/**
 * Build full URL from slug and type
 */
function buildUrl(slug, type = 'movie') {
    if (!slug) return null;
    
    // If already a full URL, return as-is
    if (slug.startsWith('http')) return slug;
    
    // Remove leading slash
    slug = slug.replace(/^\/+/, '');
    
    // Build based on type
    switch (type) {
        case 'genre':
            return `${BASE_URL}/genre/${slug}`;
        case 'category':
            return `${BASE_URL}/category/${slug}`;
        case 'actor':
            return `${BASE_URL}/actor/${slug}`;
        case 'movie':
        default:
            return `${BASE_URL}/movies/${slug}`;
    }
}

/**
 * Fetch HTML from URL or path
 */
async function fetchHtml(path = '/') {
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    const res = await axios.get(url, axiosConfig);
    return res.data;
}

/**
 * Parse duration from various formats
 */
function parseDuration(durationStr) {
    if (!durationStr) return null;
    
    const str = String(durationStr);
    
    // Try to parse as number (seconds)
    const num = parseInt(str.replace(/[^0-9]/g, ''), 10);
    if (!Number.isNaN(num) && str.length < 10) return num;
    
    // Try ISO 8601 format: PT1H30M15S
    const isoMatch = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
    if (isoMatch) {
        const h = parseInt(isoMatch[1] || '0', 10);
        const m = parseInt(isoMatch[2] || '0', 10);
        const s = parseInt(isoMatch[3] || '0', 10);
        return h * 3600 + m * 60 + s;
    }
    
    return null;
}

/**
 * Parse runtime from text (e.g., "75 min" or "1h 58m")
 */
function parseRuntime(runtimeText) {
    if (!runtimeText) return null;
    
    const text = cleanText(runtimeText);
    const minMatch = text.match(/(\d+)\s*(?:min|m)/i);
    const hourMatch = text.match(/(\d+)\s*(?:h|hour)/i);
    
    const hours = hourMatch ? parseInt(hourMatch[1], 10) : 0;
    const minutes = minMatch ? parseInt(minMatch[1], 10) : 0;
    
    return hours * 60 + minutes || null;
}

/**
 * Normalize thumbnail URL to absolute
 */
function normalizeImageUrl(url) {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    return url.startsWith('/') ? `${BASE_URL}${url}` : `${BASE_URL}/${url}`;
}

// ============================================================================
// PARSING FUNCTIONS
// ============================================================================

/**
 * Parse a video item from HTML element
 */
function parseVideoItem($, el) {
    const $el = $(el);
    const $a = $el.is('a') ? $el : $el.find('a').first();
    
    const href = $a.attr('href');
    if (!href) return null;
    
    const slug = extractSlug(href);
    const type = extractType(href);
    const title = cleanText(
        $a.attr('title') || 
        $a.find('img').attr('alt') || 
        $a.find('.title').text() ||
        $a.text()
    );
    
    const thumbnail = normalizeImageUrl(
        $a.find('img').attr('src') || 
        $a.find('img').attr('data-src')
    );
    
    return {
        id: slug,
        slug,
        type,
        title,
        thumbnail
    };
}

/**
 * Parse list page (search results, category pages, etc.)
 */
function parseListPage($) {
    const items = [];
    const selectors = [
        '.movie-card',
        '.post',
        '.thumb-block',
        '.genre-featured-grid a'
    ];
    
    selectors.forEach(selector => {
        $(selector).each((i, el) => {
            const item = parseVideoItem($, el);
            if (item && !items.some(existing => existing.id === item.id)) {
                items.push(item);
            }
        });
    });
    
    return items;
}

/**
 * Extract servers/streaming sources from page
 */
function extractServers($) {
    const servers = [];
    const seen = new Set();
    
    const addServer = (url, type, label = null) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        servers.push({ type, url, label: label ? cleanText(label) : null });
    };
    
    // 1. og:video meta tag
    const ogVideo = $('meta[property="og:video"]').attr('content');
    if (ogVideo) addServer(ogVideo, 'embed', 'og:video');
    
    // 2. Video player iframes (priority)
    $('.video-player-wrap .video-player iframe').each((i, el) => {
        const src = $(el).attr('src');
        if (src) addServer(src, 'iframe', `Player ${i + 1}`);
    });
    
    // 3. Fallback iframes
    if (servers.filter(s => s.type === 'iframe').length === 0) {
        $('.video-player iframe, iframe.player, .single-movie-layout iframe').each((i, el) => {
            const src = $(el).attr('src');
            if (src) addServer(src, 'iframe');
        });
    }
    
    // 4. Video sources
    $('video source').each((i, el) => {
        const src = $(el).attr('src');
        const type = $(el).attr('type') || 'video';
        if (src) addServer(src, type);
    });
    
    // 5. Server control buttons
    $('.vivamax-server-controls button, .vivamax-server-controls a, .server-link').each((i, el) => {
        const $el = $(el);
        const url = $el.attr('data-src') || $el.attr('data-iframe') || $el.attr('data-href') || $el.attr('href');
        const label = $el.text() || $el.attr('title');
        
        if (url) {
            const fullUrl = url.startsWith('http') || url.startsWith('/') 
                ? (url.startsWith('http') ? url : `${BASE_URL}${url}`)
                : url;
            addServer(fullUrl, 'server', label);
        }
    });
    
    // 6. Server list links
    $('.servers a, .server-list a').each((i, el) => {
        const $a = $(el);
        const href = $a.attr('href');
        const label = $a.text();
        
        if (href) {
            const fullUrl = href.startsWith('http') || href.startsWith('/')
                ? (href.startsWith('http') ? href : `${BASE_URL}${href}`)
                : href;
            addServer(fullUrl, 'link', label);
        }
    });
    
    // 7. All remaining iframes (last resort)
    if (servers.length === 0) {
        $('iframe').each((i, el) => {
            const src = $(el).attr('src');
            if (src) addServer(src, 'iframe');
        });
    }
    
    return servers;
}

/**
 * Extract actors/cast from page
 */
function extractActors($) {
    const actors = [];
    const seen = new Set();
    
    const addActor = (name, url = null) => {
        if (!name || seen.has(name)) return;
        seen.add(name);
        
        actors.push({
            name,
            slug: url ? extractSlug(url) : null,
            id: url ? extractSlug(url) : null
        });
    };
    
    // Try cast members (span elements)
    $('.movie-cast .cast-member').each((i, el) => {
        const name = cleanText($(el).text());
        const url = $(el).attr('href');
        if (name) addActor(name, url);
    });
    
    // Fallback to actor links
    if (actors.length === 0) {
        $('.actors a, .cast a, .movie-cast a').each((i, el) => {
            const name = cleanText($(el).text());
            const url = $(el).attr('href');
            if (name) addActor(name, url);
        });
    }
    
    return actors;
}

/**
 * Extract genres from page
 */
function extractGenres($) {
    const genres = [];
    const seen = new Set();
    
    const addGenre = (name, url = null) => {
        if (!name || seen.has(name)) return;
        seen.add(name);
        
        const slug = url ? extractSlug(url) : name.toLowerCase().replace(/\s+/g, '-');
        genres.push({
            name,
            slug,
            id: slug
        });
    };
    
    // Primary genre badge
    $('.single-movie-layout .movie-genre-badge').each((i, el) => {
        const $el = $(el);
        const name = cleanText($el.text());
        const url = $el.find('a').attr('href') || $el.attr('href');
        if (name) addGenre(name, url);
    });
    
    // Fallback to genre links
    if (genres.length === 0) {
        $('.genre a, .genres a, .movie-category a').each((i, el) => {
            const $a = $(el);
            const name = cleanText($a.text());
            const url = $a.attr('href');
            if (name) addGenre(name, url);
        });
    }
    
    return genres;
}

/**
 * Extract categories from page
 */
function extractCategories($) {
    const categories = [];
    const seen = new Set();
    
    $('.categories a, .category a').each((i, el) => {
        const $a = $(el);
        const name = cleanText($a.text());
        const url = $a.attr('href');
        
        if (name && !seen.has(name)) {
            seen.add(name);
            const slug = extractSlug(url) || name.toLowerCase().replace(/\s+/g, '-');
            categories.push({
                name,
                slug,
                id: slug
            });
        }
    });
    
    return categories;
}

/**
 * Extract related videos
 */
function extractRelated($) {
    const related = [];
    const seen = new Set();
    
    $('.you-may-also-like .related-posts-list a, .related-posts a').each((i, el) => {
        const $a = $(el);
        const url = $a.attr('href');
        const title = cleanText($a.text() || $a.find('img').attr('alt'));
        
        if (url && title) {
            const slug = extractSlug(url);
            if (slug && !seen.has(slug)) {
                seen.add(slug);
                related.push({
                    id: slug,
                    slug,
                    title,
                    type: extractType(url),
                    thumbnail: normalizeImageUrl($a.find('img').attr('src'))
                });
            }
        }
    });
    
    return related;
}

// ============================================================================
// M3U8 EXTRACTION FUNCTIONS
// ============================================================================

/**
 * Resolve URL with proper protocol handling
 */
function resolveUrl(base, link) {
    try {
        if (!link) return null;
        // handle protocol-relative
        if (link.startsWith('//')) return `https:${link}`;
        if (/^https?:\/\//i.test(link)) return link;
        if (!base) return link;
        return new URL(link, base).href;
    } catch (e) {
        return link;
    }
}

/**
 * Extract direct media sources (m3u8, mp4, etc.) from iframe HTML
 */
async function extractSourcesFromIframe(urlOrHtml, opts = {}) {
    let html = '';
    let base = opts.base || null;

    if (typeof urlOrHtml !== 'string') return [];

    // If it's a URL, fetch it
    if (/^https?:\/\//i.test(urlOrHtml) || urlOrHtml.startsWith('//')) {
        try {
            const fetchUrl = urlOrHtml.startsWith('//') ? `https:${urlOrHtml}` : urlOrHtml;
            const config = {
                ...iframeAxiosConfig,
                headers: {
                    ...iframeAxiosConfig.headers,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            };
            
            const res = await axios.get(fetchUrl, config);
            html = res.data;
            base = base || fetchUrl;
        } catch (err) {
            console.error(`Error fetching iframe from ${urlOrHtml}:`, err.message);
            return [];
        }
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
        else if (lower.includes('.mp4') || lower.includes('.mkv')) type = 'mp4';
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
            if (u.startsWith('//')) u = `https:${u}`;
            // sometimes match returns leading ':' from (https?:)
            if (u.startsWith(':')) u = u.substring(1);
            push(u);
        }

        // look for jwplayer/file: pattern
        const jwMatch = txt.match(/file\s*[:=]\s*["']([^"']+\.(m3u8|mp4|mkv))/i);
        if (jwMatch && jwMatch[1]) push(jwMatch[1]);

        // look for sources: [{file: '...'}]
        const sourcesMatch = txt.match(/sources\s*[:=]\s*(\[\s*\{[\s\S]*?\}\s*\])/i);
        if (sourcesMatch && sourcesMatch[1]) {
            const inner = sourcesMatch[1];
            const innerUrlRegex = /["']([^"']*\.(m3u8|mp4|mkv)[^"']*)/gi;
            let m2;
            while ((m2 = innerUrlRegex.exec(inner)) !== null) push(m2[1]);
        }

        // look for HLS playlist patterns in script
        const hlsPatterns = [
            /["']url["']\s*:\s*["']([^"']*\.m3u8[^"']*)/gi,
            /hls\s*[:{]\s*["{']?url["{']?\s*:\s*["']([^"']*\.m3u8[^"']*)/gi,
            /playback\s*:\s*["']([^"']*\.m3u8[^"']*)/gi
        ];
        
        hlsPatterns.forEach(pattern => {
            let m3;
            while ((m3 = pattern.exec(txt)) !== null) {
                if (m3[1]) push(m3[1]);
            }
        });
    });

    // 6) try to find plain links in anchor tags
    $('a').each((i, a) => {
        const href = $(a).attr('href');
        if (href && /\.(m3u8|mp4|mkv)/i.test(href)) push(href);
    });

    // 7) look for m3u8 in iframe src or data attributes
    $('iframe').each((i, frame) => {
        const $frame = $(frame);
        const src = $frame.attr('src') || $frame.attr('data-src');
        if (src && /\.(m3u8|mp4|mkv)/i.test(src)) push(src);
    });

    // 8) last-resort: look for any URL-like tokens in the whole HTML
    if (found.length === 0) {
        const whole = html;
        let m;
        urlRegex.lastIndex = 0;
        while ((m = urlRegex.exec(whole)) !== null) {
            let u = m[0];
            if (u.startsWith('//')) u = `https:${u}`;
            if (u.startsWith(':')) u = u.substring(1);
            push(u);
        }
    }

    return found;
}

/**
 * Extract m3u8 from iframe URL with vivamaxstream.com domain context
 * Includes retry logic and better error handling
 */
async function extractM3U8FromIframe(iframeUrl, maxRetries = 2) {
    if (!iframeUrl) return [];
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Extracting m3u8 from ${iframeUrl} (attempt ${attempt + 1}/${maxRetries + 1})`);
            const sources = await extractSourcesFromIframe(iframeUrl, { base: iframeUrl });
            const hls = sources.filter(s => s.type === 'hls');
            
            if (hls.length > 0) {
                console.log(`Found ${hls.length} m3u8 stream(s) from ${iframeUrl}`);
                return hls;
            }
            
            // If no streams found on first attempt, wait before retry
            if (attempt < maxRetries) {
                console.log(`No m3u8 found, retrying... (${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
            }
        } catch (err) {
            console.warn(`Attempt ${attempt + 1} failed for ${iframeUrl}: ${err.message}`);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
            }
        }
    }
    
    console.log(`Failed to extract m3u8 from ${iframeUrl} after ${maxRetries + 1} attempts`);
    return [];
}

/**
 * Extract all streams from a video page
 */
async function extractFromVideoPage(videoUrl) {
    if (!videoUrl) return [];
    try {
        const html = await fetchHtml(videoUrl);
        const sources = await extractSourcesFromIframe(html, { base: videoUrl });
        return sources;
    } catch (err) {
        console.error('Error extracting from video page:', err.message);
        return [];
    }
}

/**
 * Proxy m3u8 with vivamaxstream.com headers to bypass restrictions
 */
async function proxyM3U8(m3u8Url, opts = {}) {
    if (!m3u8Url) return null;
    try {
        const config = {
            headers: {
                'User-Agent': iframeAxiosConfig.headers['User-Agent'],
                'Referer': opts.referer || BASE_URL
            },
            timeout: 10000
        };
        const res = await axios.get(m3u8Url, config);
        return res.data;
    } catch (err) {
        console.error('Error proxying m3u8:', err.message);
        return null;
    }
}

/**
 * Extract m3u8 in parallel with timeout and fallbacks
 */
async function extractM3U8Parallel(servers, timeout = 10000) {
    const m3u8Streams = [];
    
    if (!servers || servers.length === 0) return m3u8Streams;
    
    // Extract from iframe/embed servers in parallel with timeout
    const extractPromises = servers
        .filter(s => s.type === 'iframe' || s.type === 'embed')
        .map(server =>
            Promise.race([
                (async () => {
                    try {
                        console.log(`Extracting from server: ${server.label || server.url}`);
                        const streams = await extractM3U8FromIframe(server.url, 1);
                        return { server, streams };
                    } catch (err) {
                        console.error(`Failed to extract from ${server.url}:`, err.message);
                        return { server, streams: [] };
                    }
                })(),
                new Promise(resolve => {
                    setTimeout(() => {
                        console.warn(`Timeout extracting from ${server.url}`);
                        resolve({ server, streams: [] });
                    }, timeout);
                })
            ])
        );
    
    try {
        const results = await Promise.all(extractPromises);
        results.forEach(({ server, streams }) => {
            if (streams.length > 0) {
                m3u8Streams.push({
                    from: server.label || 'Server',
                    serverUrl: server.url,
                    streams
                });
            }
        });
    } catch (err) {
        console.error('Error in parallel extraction:', err.message);
    }
    
    return m3u8Streams;
}

// ============================================================================
// PUBLIC API FUNCTIONS
// ============================================================================

/**
 * Get homepage sections with video items
 */
async function getHome() {
    try {
        const html = await fetchHtml('/');
        const $ = cheerio.load(html);
        
        const sections = [];
        
        $('.genre-section').each((i, el) => {
            const $section = $(el);
            
            // Get section name
            const classes = ($section.attr('class') || '').split(/\s+/);
            const genreClass = classes.find(c => c.startsWith('genre-'));
            const sectionName = cleanText(
                $section.find('h2, .section-title').first().text() ||
                (genreClass ? genreClass.replace('genre-', '') : '')
            );
            
            // Get items in section
            const items = [];
            $section.find('.genre-featured-grid a, .movie-card a, .thumb a').each((j, a) => {
                const item = parseVideoItem($, a);
                if (item && !items.some(existing => existing.id === item.id)) {
                    items.push(item);
                }
            });
            
            if (items.length && sectionName) {
                const slug = sectionName.toLowerCase().replace(/\s+/g, '-');
                sections.push({
                    id: slug,
                    name: sectionName,
                    slug,
                    items
                });
            }
        });
        
        return { status: 'success', sections };
    } catch (err) {
        return { status: 'error', message: err.message };
    }
}

/**
 * Get video list from a path (category, genre, etc.)
 */
async function getVideoList(pathOrSlug, page = 1) {
    try {
        let path = pathOrSlug;
        
        // If it's just a slug, try to determine the type
        if (!path.startsWith('/') && !path.startsWith('http')) {
            path = `/${path}`;
        }
        
        // Add pagination
        if (page && page > 1) {
            path = `${path}${path.includes('?') ? '&' : '?'}paged=${page}`;
        }
        
        const html = await fetchHtml(path);
        const $ = cheerio.load(html);
        const items = parseListPage($);
        
        return {
            status: 'success',
            page,
            items
        };
    } catch (err) {
        return { status: 'error', message: err.message };
    }
}

/**
 * Get video details by slug or ID
 */
async function getVideoDetails(slugOrId) {
    try {
        if (!slugOrId) {
            return { status: 'error', message: 'Slug or ID is required' };
        }
        
        // Build URL from slug
        let url;
        if (slugOrId.startsWith('http')) {
            url = slugOrId;
        } else {
            // Remove leading slash if present
            const cleanSlug = slugOrId.replace(/^\/+/, '');
            
            // Auto-prepend /movies/ if needed
            if (!cleanSlug.includes('/')) {
                url = buildUrl(cleanSlug, 'movie');
            } else {
                url = `${BASE_URL}/${cleanSlug}`;
            }
        }
        
        const html = await fetchHtml(url);
        const $ = cheerio.load(html);
        
        // Basic metadata
        const title = cleanText(
            $('meta[property="og:title"]').attr('content') ||
            $('h1.entry-title').text() ||
            $('title').text()
        );
        
        const description = cleanText(
            $('meta[property="og:description"]').attr('content') ||
            $('.entry-content p').first().text()
        );
        
        const thumbnail = normalizeImageUrl(
            $('meta[property="og:image"]').attr('content') ||
            $('.featured-image img').attr('src')
        );
        
        const canonical = $('link[rel="canonical"]').attr('href') || 
                         $('meta[property="og:url"]').attr('content') || 
                         url;
        
        const slug = extractSlug(canonical);
        
        // Duration
        let duration = null;
        const durMeta = $('meta[property="video:duration"]').attr('content') ||
                       $('meta[name="duration"]').attr('content');
        if (durMeta) {
            duration = parseDuration(durMeta);
        }
        
        // Try JSON-LD for additional data
        $('script[type="application/ld+json"]').each((i, el) => {
            try {
                const json = JSON.parse($(el).html() || '{}');
                if (json && json['@type'] && String(json['@type']).toLowerCase().includes('video')) {
                    if (!duration && json.duration) {
                        duration = parseDuration(json.duration);
                    }
                }
            } catch (e) {
                // Ignore malformed JSON
            }
        });
        
        // Runtime
        const runtimeText = cleanText($('.meta-runtime').text() || $('.duration').text());
        const runtime = parseRuntime(runtimeText);
        
        // Rating
        let rating = null;
        const ratingText = cleanText($('.rating-value').text());
        if (ratingText) {
            const ratingMatch = ratingText.match(/[\d.]+/);
            if (ratingMatch) rating = parseFloat(ratingMatch[0]);
        }
        
        // Year
        const year = cleanText($('.meta-year').text()) || null;
        
        // Extract complex data
        const servers = extractServers($);
        const actors = extractActors($);
        const genres = extractGenres($);
        const categories = extractCategories($);
        const related = extractRelated($);
        
        // Extract m3u8 from iframe servers in parallel with timeout
        const m3u8Streams = await extractM3U8Parallel(servers, 8000);
        
        return {
            status: 'success',
            video: {
                id: slug,
                slug,
                type: extractType(canonical),
                title,
                description,
                thumbnail,
                canonical,
                duration,
                runtime,
                rating,
                year,
                servers,
                m3u8Streams,
                actors,
                genres,
                categories,
                related
            }
        };
    } catch (err) {
        return { status: 'error', message: err.message };
    }
}

/**
 * Search for videos
 */
async function search(query, page = 1) {
    if (!query) {
        return { status: 'error', message: 'Search query is required' };
    }
    
    try {
        const path = `/?s=${encodeURIComponent(query)}`;
        const html = await fetchHtml(path + (page > 1 ? `&paged=${page}` : ''));
        const $ = cheerio.load(html);
        const items = parseListPage($);
        
        return {
            status: 'success',
            query,
            page,
            items
        };
    } catch (err) {
        return { status: 'error', message: err.message };
    }
}

/**
 * Get site information
 */
async function getSiteInfo() {
    try {
        const html = await fetchHtml('/');
        const $ = cheerio.load(html);
        
        const title = cleanText(
            $('meta[property="og:site_name"]').attr('content') ||
            $('title').text() ||
            $('meta[property="og:title"]').attr('content')
        );
        
        const description = cleanText(
            $('meta[property="og:description"]').attr('content') ||
            $('meta[name="description"]').attr('content')
        );
        
        const thumbnail = normalizeImageUrl(
            $('meta[property="og:image"]').attr('content') ||
            $('link[rel="icon"]').attr('href')
        );
        
        return {
            status: 'success',
            site: {
                name: title,
                description,
                logo: thumbnail,
                baseUrl: BASE_URL
            }
        };
    } catch (err) {
        return { status: 'error', message: err.message };
    }
}

/**
 * Helper to build URL from slug/ID (useful for clients)
 */
function getVideoUrl(slugOrId, type = 'movie') {
    return buildUrl(slugOrId, type);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    // Main API functions
    getHome,
    getVideoList,
    getVideoDetails,
    search,
    getSiteInfo,
    
    // M3U8 extraction functions
    extractM3U8FromIframe,
    extractFromVideoPage,
    proxyM3U8,
    extractSourcesFromIframe,
    extractM3U8Parallel,
    
    // Helper functions
    getVideoUrl,
    extractSlug,
    buildUrl,
    
    // Constants
    BASE_URL
};