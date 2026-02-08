const axios = require('axios');
const cheerio = require('cheerio');
const { enhanceServerWithMedia: enhanceTurboVid } = require('../../../utils/iframe/turbovidhls');
const { enhanceServerWithMedia: enhanceHiCherri } = require('../../../utils/iframe/hicherri');

const BASE_URL = 'https://javtsunami.com';
const API_BASE = `${BASE_URL}/wp-json/wp/v2`;

// ==================== CONFIGURATION ====================

const axiosConfig = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    timeout: 8000
};

const DEFAULT_CONFIG = {
    perPage: 20,
    maxCacheSize: 500,
    taxonomyCacheSize: 200,
    imageConcurrency: 5,
    imageTimeout: 5000
};

// ==================== CACHING SYSTEM ====================

class LRUCache {
    constructor(maxSize = 500) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }

    get(key) {
        if (!this.cache.has(key)) return null;
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    clear() {
        this.cache.clear();
    }

    get size() {
        return this.cache.size;
    }
}

const imageCache = new LRUCache(DEFAULT_CONFIG.maxCacheSize);
const taxonomyCache = new LRUCache(DEFAULT_CONFIG.taxonomyCacheSize);

// ==================== UTILITY FUNCTIONS ====================

function buildQuery(params) {
    const query = new URLSearchParams();
    Object.keys(params).forEach(key => {
        if (params[key] !== undefined && params[key] !== null) {
            query.append(key, params[key]);
        }
    });
    return query.toString();
}

function cleanHTML(html) {
    if (!html) return '';
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#8211;/g, '–')
        .replace(/&#8217;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanURL(url) {
    if (!url) return null;
    let cleaned = url.replace(/^[;\s]+/, '').trim();
    if (cleaned && !cleaned.startsWith('http')) {
        cleaned = 'https://' + cleaned;
    }
    return cleaned || null;
}

function extractVideoCode(title) {
    const match = title.match(/([A-Z]+[-_\s]\d+)/i);
    if (match) {
        return match[1].toUpperCase().replace(/[_\s]/g, '-');
    }
    return null;
}

function extractSubtitleLanguages(tags) {
    const languages = [];
    tags.forEach(tag => {
        const slug = tag.slug || tag.id || '';
        if (slug.includes('english') || slug.includes('eng-sub')) {
            languages.push('English');
        }
        if (slug.includes('thai') || slug.includes('ซับไทย')) {
            languages.push('Thai');
        }
        if (slug.includes('indo') || slug.includes('indonesian')) {
            languages.push('Indonesian');
        }
        if (slug.includes('chinese') || slug.includes('中文')) {
            languages.push('Chinese');
        }
    });
    return [...new Set(languages)];
}

// ==================== RESPONSE BUILDERS ====================

function successResponse(data, pagination = null) {
    const response = {
        status: 'success',
        data
    };
    if (pagination) {
        response.pagination = pagination;
    }
    response.timestamp = new Date().toISOString();
    return response;
}

function errorResponse(message, code = 'UNKNOWN_ERROR') {
    return {
        status: 'error',
        error: {
            message,
            code
        },
        data: null,
        timestamp: new Date().toISOString()
    };
}

function buildPagination(currentPage, perPage, totalPages, totalItems) {
    return {
        currentPage: parseInt(currentPage),
        perPage: parseInt(perPage),
        totalPages: parseInt(totalPages),
        totalItems: parseInt(totalItems),
        hasNext: currentPage < totalPages,
        hasPrev: currentPage > 1,
        nextPage: currentPage < totalPages ? currentPage + 1 : null,
        prevPage: currentPage > 1 ? currentPage - 1 : null
    };
}

// ==================== IMAGE EXTRACTION ====================

function extractImageFromAPI(post) {
    try {
        if (post._embedded?.['wp:featuredmedia']?.[0]) {
            const media = post._embedded['wp:featuredmedia'][0];
            
            if (media.source_url) {
                return cleanURL(media.source_url);
            }
            
            if (media.media_details?.sizes) {
                const sizes = media.media_details.sizes;
                const sizeUrl = sizes.full?.source_url || 
                              sizes.large?.source_url || 
                              sizes.medium_large?.source_url ||
                              sizes.medium?.source_url || 
                              sizes.thumbnail?.source_url;
                if (sizeUrl) return cleanURL(sizeUrl);
            }
            
            if (media.guid?.rendered) {
                return cleanURL(media.guid.rendered);
            }
        }
        
        if (post.content?.rendered) {
            const imgMatch = post.content.rendered.match(/<img[^>]+src="([^">]+)"/);
            if (imgMatch && imgMatch[1]) {
                return cleanURL(imgMatch[1]);
            }
        }
        
        return null;
    } catch (error) {
        console.error('Error extracting image from API:', error.message);
        return null;
    }
}

async function fetchFeaturedImage(featuredMediaUrl) {
    try {
        const { data } = await axios.get(featuredMediaUrl, axiosConfig);
        return cleanURL(data.source_url || data.guid?.rendered);
    } catch (error) {
        console.error('Error fetching featured image:', error.message);
        return null;
    }
}

async function scrapeImageFromPage(videoPath) {
    let realPath = videoPath;
    if (realPath.startsWith('/watch/')) {
        realPath = realPath.replace(/^\/watch\//, '/');
    }
    if (!realPath.endsWith('.html')) {
        realPath += '.html';
    }
    
    const url = `${BASE_URL}${realPath}`;
    try {
        const { data } = await axios.get(url, axiosConfig);
        const $ = cheerio.load(data);
        
        const poster = $('meta[property="og:image"]').attr('content') || 
                      $('.featured-image img').attr('src') ||
                      $('.post-thumbnail img').attr('src') ||
                      $('.video-player img').first().attr('src') ||
                      $('.entry-content img').first().attr('src') ||
                      $('img[itemprop="image"]').attr('src') ||
                      $('article img').first().attr('src');
        
        return cleanURL(poster);
    } catch (error) {
        console.error('Error scraping image from', url, ':', error.message);
        return null;
    }
}

async function scrapeTaxonomyImage(taxonomyType, slug) {
    const urlMap = {
        'actors': `${BASE_URL}/actor/${slug}`,
        'categories': `${BASE_URL}/category/${slug}`,
        'tags': `${BASE_URL}/tag/${slug}`
    };
    
    const url = urlMap[taxonomyType] || `${BASE_URL}/${taxonomyType}/${slug}`;
    
    try {
        const { data } = await axios.get(url, { 
            ...axiosConfig, 
            timeout: DEFAULT_CONFIG.imageTimeout
        });
        const $ = cheerio.load(data);
        
        // Try og:image first (if it's not a known placeholder)
        let image = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');

        const isPlaceholder = src => {
            if (!src) return true;
            const s = String(src).toLowerCase();
            return s.includes('best%2bjav') || s.includes('best+jav') || s.includes('actors.jpg') || s.includes('no-image') || s.includes('placeholder') || s.includes('px.gif') || s.includes('default');
        };

        if (image && !isPlaceholder(image)) {
            return cleanURL(image);
        }

        // Look for common image containers on taxonomy pages
        const selectors = [
            'article.thumb-block img',
            '.category .thumb img',
            '.category-image img',
            '.term-thumbnail img',
            '.archive-header img',
            '.term-description img',
            '.site-content img',
            '.entry-content img'
        ];

        for (const sel of selectors) {
            const el = $(sel).first();
            if (el && el.length) {
                // prefer lazy/data attributes
                const candidates = [
                    el.attr('data-src'),
                    el.attr('data-lazy-src'),
                    el.attr('data-original'),
                    el.attr('data-srcset'),
                    el.attr('srcset'),
                    el.attr('src')
                ];

                for (const cand of candidates) {
                    if (!cand) continue;
                    // handle srcset by taking first URL
                    let urlCandidate = cand;
                    if (cand.includes(',')) {
                        urlCandidate = cand.split(',')[0].trim().split(' ')[0];
                    }
                    if (!isPlaceholder(urlCandidate)) {
                        return cleanURL(urlCandidate);
                    }
                }
            }
        }

        // Try to extract background-image from inline styles
        const bg = $('[style*="background-image"]').first().css('background-image');
        if (bg && bg !== 'none') {
            const m = String(bg).match(/url\(["']?(.*?)["']?\)/);
            if (m && m[1] && !isPlaceholder(m[1])) {
                return cleanURL(m[1]);
            }
        }

        return null;
    } catch (error) {
        return null;
    }
}

// ==================== CONCURRENT PROCESSING ====================

async function processConcurrently(items, processor, concurrency = 3) {
    const results = [];
    const executing = [];
    
    for (const item of items) {
        const promise = processor(item).then(result => {
            executing.splice(executing.indexOf(promise), 1);
            return result;
        });
        
        results.push(promise);
        executing.push(promise);
        
        if (executing.length >= concurrency) {
            await Promise.race(executing);
        }
    }
    
    return Promise.all(results);
}

// ==================== TAXONOMY ENHANCEMENT ====================

async function enhanceTaxonomyWithImage(term, taxonomyType, fetchImages = false) {
    if (!term || !term.slug) return term;
    
    const baseTerm = {
        name: term.name,
        slug: term.slug,
        count: term.count || 0
    };
    // Fetch images for categories and actors when requested
    if ((taxonomyType === 'categories' || taxonomyType === 'actors') && fetchImages) {
        const cacheKey = `${taxonomyType}:${term.slug}`;
        const cached = imageCache.get(cacheKey);

        if (cached !== null) {
            return { ...baseTerm, thumbnail: cached };
        }

        try {
            let imageUrl = null;

            if (term.description) {
                const imgMatch = term.description.match(/<img[^>]+src="([^">]+)"/);
                if (imgMatch && imgMatch[1]) {
                    imageUrl = cleanURL(imgMatch[1]);
                }
            }

            if (!imageUrl) {
                // scrapeTaxonomyImage supports actors/categories
                imageUrl = await scrapeTaxonomyImage(taxonomyType === 'actors' ? 'actors' : 'categories', term.slug);
            }

            imageCache.set(cacheKey, imageUrl);
            return { ...baseTerm, thumbnail: imageUrl };
        } catch (error) {
            return { ...baseTerm, thumbnail: null };
        }
    }

    return baseTerm;
}

async function enhanceTaxonomyList(terms, taxonomyType, fetchImages = false) {
    if (!Array.isArray(terms) || terms.length === 0) return [];
    // For categories and actors with images, process concurrently
    if ((taxonomyType === 'categories' || taxonomyType === 'actors') && fetchImages) {
        return processConcurrently(
            terms,
            term => enhanceTaxonomyWithImage(term, taxonomyType, true),
            DEFAULT_CONFIG.imageConcurrency
        );
    }

    // Default mapping for other taxonomy lists
    return terms.map(term => ({
        name: term.name,
        slug: term.slug,
        count: term.count || 0
    }));
}

// ==================== VIDEO DATA MAPPERS ====================

function mapToVideoListItem(post, imageUrl) {
    return {
        id: post.slug,
        title: cleanHTML(post.title.rendered),
        thumbnail: imageUrl,
        publishedAt: post.date,
        modifiedAt: post.modified
    };
}

async function mapToVideoDetails(post, slug) {
    const tagsRaw = post._embedded?.['wp:term']?.[1] || [];
    const tags = await enhanceTaxonomyList(
        tagsRaw.map(tag => ({
            name: tag.name,
            slug: tag.slug,
            count: tag.count || 0
        })),
        'tags',
        false
    );

    const actorsRaw = post._embedded?.['wp:term']?.[2] || [];
    const actors = await enhanceTaxonomyList(
        actorsRaw.map(actor => ({
            name: actor.name,
            slug: actor.slug,
            count: actor.count || 0
        })),
        'actors',
        false
    );

    const categoriesRaw = post._embedded?.['wp:term']?.[0] || [];
    const categories = await enhanceTaxonomyList(
        categoriesRaw.map(cat => ({
            name: cat.name,
            slug: cat.slug,
            count: cat.count || 0,
            description: cat.description || ''
        })),
        'categories',
        true  // Enable image fetching for categories
    );

    let thumbnail = extractImageFromAPI(post);
    
    if (!thumbnail && post._links?.['wp:featuredmedia']?.[0]?.href) {
        thumbnail = await fetchFeaturedImage(post._links['wp:featuredmedia'][0].href);
    }

    if (!thumbnail) {
        thumbnail = await scrapeImageFromPage(`/${slug}`);
    }

    const servers = await scrapeServersFromPage(`/${slug}`);
    const { related_actors, related } = await scrapeRelatedContent(`/${slug}`);

    return {
        id: post.slug,
        title: cleanHTML(post.title.rendered),
        thumbnail,
        thumbnailAlt: post._embedded?.['wp:featuredmedia']?.[0]?.alt_text || null,
        publishedAt: post.date,
        modifiedAt: post.modified,
        author: {
            id: post.author,
            name: post._embedded?.author?.[0]?.name || null,
            url: post._embedded?.author?.[0]?.link || null
        },
        fullUrl: `${BASE_URL}/${post.slug}.html`,
        servers: servers.map(server => {
            const { media, ...serverWithoutMedia } = server;
            return {
                ...serverWithoutMedia,
                quality: server.quality || 'HD',
                language: 'Japanese',
                hasSubtitles: tags.some(t => 
                    t.slug.includes('sub') || 
                    t.slug.includes('subtitle')
                )
            };
        }),
        tags,
        actors,
        categories,
        relatedActors: related_actors,
        relatedVideos: related,
        metadata: {
            videoCode: extractVideoCode(post.title.rendered),
            studio: categories.find(c => c.slug.includes('studio'))?.name || null,
            releaseDate: post.date,
            rating: post.meta?.rating || null,
            language: 'Japanese',
            subtitles: extractSubtitleLanguages(tags)
        }
    };
}

// ==================== SCRAPING FUNCTIONS ====================

async function scrapeServersFromPage(videoPath) {
    let realPath = videoPath;
    if (realPath.startsWith('/watch/')) {
        realPath = realPath.replace(/^\/watch\//, '/');
    }
    if (!realPath.endsWith('.html')) {
        realPath += '.html';
    }
    
    const url = `${BASE_URL}${realPath}`;
    try {
        const { data } = await axios.get(url, axiosConfig);
        const $ = cheerio.load(data);
        
        const servers = [];
        $('.responsive-player iframe, .video-container iframe, iframe[src*="player"]').each((_, el) => {
            const src = $(el).attr('src');
            if (src) {
                let serverType = 'Unknown';
                if (src.includes('fapsharing')) serverType = 'FapSharing';
                else if (src.includes('hicherri')) serverType = 'HiCherri';
                else if (src.includes('streamtape')) serverType = 'StreamTape';
                else if (src.includes('doodstream')) serverType = 'DoodStream';
                else if (src.includes('cloudrls')) serverType = 'CloudRLS';
                else if (src.includes('turbovid')) serverType = 'TurboVid';
                
                servers.push({
                    id: servers.length + 1,
                    name: `Server ${servers.length + 1}`,
                    type: serverType,
                    url: cleanURL(src),
                    embed: cleanURL(src)
                });
            }
        });
        
        if (servers.length === 0) {
            return [];
        }
        
        let enhancedServers = await enhanceTurboVid(servers);
        enhancedServers = await enhanceHiCherri(enhancedServers);
        enhancedServers = enhancedServers.filter(server => server && server.url);
        
        return enhancedServers;
    } catch (error) {
        console.error('Error scraping servers:', error.message);
        return [];
    }
}

async function scrapeRelatedContent(videoPath) {
    let realPath = videoPath;
    if (realPath.startsWith('/watch/')) {
        realPath = realPath.replace(/^\/watch\//, '/');
    }
    if (!realPath.endsWith('.html')) {
        realPath += '.html';
    }
    
    const url = `${BASE_URL}${realPath}`;
    try {
        const { data } = await axios.get(url, axiosConfig);
        const $ = cheerio.load(data);
        
        const related_actors = [];
        $('.under-video-block .widget-title:contains("Related Actors Videos")').next('div').find('article').each((_, el) => {
            const $el = $(el);
            const a = $el.find('a').first();
            const href = a.attr('href') || '';
            const imgSrc = $el.find('img').attr('data-src') || $el.find('img').attr('src');

            // derive slug/id from href
            let link = href ? cleanURL(href) : null;
            let slug = null;
            if (href) {
                try {
                    const path = href.replace(/https?:\/\/[\w\.-]+/i, '').split('?')[0];
                    const parts = path.split('/').filter(Boolean);
                    if (parts.length) {
                        slug = parts.pop().replace(/\.html$/i, '');
                    }
                } catch (e) {
                    slug = null;
                }
            }

            related_actors.push({
                title: a.attr('title') || $el.find('.entry-header span').text().trim(),
                thumbnail: cleanURL(imgSrc),
                id: slug
            });
        });
        
        const related = [];
        $('.under-video-block .widget-title:contains("Related Videos")').next('div').find('article').each((_, el) => {
            const $el = $(el);
            const a = $el.find('a').first();
            const href = a.attr('href') || '';
            const imgSrc = $el.find('img').attr('data-src') || $el.find('img').attr('src');

            let link = href ? cleanURL(href) : null;
            let slug = null;
            if (href) {
                try {
                    const path = href.replace(/https?:\/\/[\w\.-]+/i, '').split('?')[0];
                    const parts = path.split('/').filter(Boolean);
                    if (parts.length) {
                        // If last part looks like a slug (may end with .html)
                        slug = parts.pop().replace(/\.html$/i, '');
                    }
                } catch (e) {
                    slug = null;
                }
            }

            related.push({
                title: a.attr('title') || $el.find('.entry-header span').text().trim(),
                thumbnail: cleanURL(imgSrc),
                id: slug
            });
        });
        
        return { related_actors, related };
    } catch (error) {
        console.error('Error scraping related content:', error.message);
        return { related_actors: [], related: [] };
    }
}

// ==================== API FUNCTIONS ====================

async function getVideoDetails(slug) {
    try {
        const { data } = await axios.get(
            `${API_BASE}/posts?slug=${slug}&_embed=true`, 
            axiosConfig
        );

        if (!data || data.length === 0) {
            return errorResponse('Video not found', 'VIDEO_NOT_FOUND');
        }

        const videoData = await mapToVideoDetails(data[0], slug);
        return successResponse(videoData);
    } catch (error) {
        return errorResponse(error.message, 'API_ERROR');
    }
}

async function getVideoList(page = 1, perPage = 20, filter = 'latest', category = null, tag = null, actor = null) {
    try {
        const params = {
            page,
            per_page: perPage,
            orderby: filter === 'most-viewed' ? 'meta_value_num' : 'date',
            order: 'desc',
            _embed: true
        };

        if (category) {
            const { data: categories } = await axios.get(
                `${API_BASE}/categories?slug=${category}`, 
                axiosConfig
            );
            if (categories && categories.length > 0) {
                params.categories = categories[0].id;
            }
        }
        
        if (tag) {
            const { data: tags } = await axios.get(
                `${API_BASE}/tags?slug=${tag}`, 
                axiosConfig
            );
            if (tags && tags.length > 0) {
                params.tags = tags[0].id;
            }
        }
        
        if (actor) {
            const { data: actors } = await axios.get(
                `${API_BASE}/actors?slug=${actor}`, 
                axiosConfig
            );
            if (actors && actors.length > 0) {
                params.actors = actors[0].id;
            }
        }

        const { data, headers } = await axios.get(
            `${API_BASE}/posts?${buildQuery(params)}`, 
            axiosConfig
        );

        const totalPages = parseInt(headers['x-wp-totalpages'] || 1);
        const totalItems = parseInt(headers['x-wp-total'] || 0);

        const videos = await Promise.all(data.map(async post => {
            let imageUrl = extractImageFromAPI(post);
            
            if (!imageUrl && post._links?.['wp:featuredmedia']?.[0]?.href) {
                imageUrl = await fetchFeaturedImage(post._links['wp:featuredmedia'][0].href);
            }

            return mapToVideoListItem(post, imageUrl);
        }));

        return successResponse(
            videos,
            buildPagination(page, perPage, totalPages, totalItems)
        );
    } catch (error) {
        return errorResponse(error.message, 'API_ERROR');
    }
}

async function searchVideos(query, page = 1, perPage = 20) {
    try {
        const params = {
            page,
            per_page: perPage,
            search: query,
            _embed: true
        };

        const { data, headers } = await axios.get(
            `${API_BASE}/posts?${buildQuery(params)}`, 
            axiosConfig
        );

        const totalPages = parseInt(headers['x-wp-totalpages'] || 1);
        const totalItems = parseInt(headers['x-wp-total'] || 0);

        const videos = await Promise.all(data.map(async post => {
            let imageUrl = extractImageFromAPI(post);
            
            if (!imageUrl && post._links?.['wp:featuredmedia']?.[0]?.href) {
                imageUrl = await fetchFeaturedImage(post._links['wp:featuredmedia'][0].href);
            }

            return mapToVideoListItem(post, imageUrl);
        }));

        const response = successResponse(
            videos,
            buildPagination(page, perPage, totalPages, totalItems)
        );
        response.query = query;
        
        return response;
    } catch (error) {
        return errorResponse(error.message, 'SEARCH_ERROR');
    }
}

async function getTags(page = 1, perPage = 100) {
    try {
        const { data, headers } = await axios.get(
            `${API_BASE}/tags?page=${page}&per_page=${perPage}`, 
            axiosConfig
        );

        const totalPages = parseInt(headers['x-wp-totalpages'] || 1);
        const totalItems = parseInt(headers['x-wp-total'] || 0);

        const tags = await enhanceTaxonomyList(
            data.map(tag => ({
                name: tag.name,
                slug: tag.slug,
                count: tag.count || 0
            })),
            'tags',
            false
        );

        return successResponse(
            tags,
            buildPagination(page, perPage, totalPages, totalItems)
        );
    } catch (error) {
        return errorResponse(error.message, 'API_ERROR');
    }
}

async function getCategories(page = 1, perPage = 100) {
    try {
        const { data, headers } = await axios.get(
            `${API_BASE}/categories?page=${page}&per_page=${perPage}`, 
            axiosConfig
        );

        const totalPages = parseInt(headers['x-wp-totalpages'] || 1);
        const totalItems = parseInt(headers['x-wp-total'] || 0);

        const categories = await enhanceTaxonomyList(
            data.map(cat => ({
                name: cat.name,
                slug: cat.slug,
                count: cat.count || 0,
                description: cat.description || ''
            })),
            'categories',
            true  // Enable image fetching for categories
        );

        return successResponse(
            categories,
            buildPagination(page, perPage, totalPages, totalItems)
        );
    } catch (error) {
        return errorResponse(error.message, 'API_ERROR');
    }
}

async function getActors(page = 1, perPage = 20, search = null) {
    try {
        const params = { page, per_page: perPage };
        if (search) params.search = search;
        
        const { data, headers } = await axios.get(
            `${API_BASE}/actors?${buildQuery(params)}`, 
            axiosConfig
        );

        const totalPages = parseInt(headers['x-wp-totalpages'] || 1);
        const totalItems = parseInt(headers['x-wp-total'] || 0);

        const actors = await enhanceTaxonomyList(
            data.map(actor => ({
                name: actor.name,
                slug: actor.slug,
                count: actor.count || 0,
                description: actor.description || ''
            })),
            'actors',
            true // enable image/photo fetching for actors
        );

        return successResponse(
            actors,
            buildPagination(page, perPage, totalPages, totalItems)
        );
    } catch (error) {
        return errorResponse(error.message, 'API_ERROR');
    }
}

// ==================== EXPORTS ====================

module.exports = {
    // Primary API methods
    getVideoDetails,
    getVideoList,
    searchVideos,
    getTags,
    getCategories,
    getActors,
    
    // Cache management
    clearCache: () => {
        imageCache.clear();
        taxonomyCache.clear();
    },
    getCacheStats: () => ({
        imageCache: imageCache.size,
        taxonomyCache: taxonomyCache.size
    }),
    
    // Backward compatibility
    scrapeWatch: (slug) => getVideoDetails(slug.replace('/watch/', '').replace('.html', '')),
    scrapeLatest: (page, filter) => getVideoList(page, 20, filter),
    scrapeSearch: (query, page) => searchVideos(query, page),
    scrapeTagList: () => getTags(1, 100),
    getPostsByCategory: (category, page, perPage) => getVideoList(page, perPage || 20, 'latest', category),
    getPostsByTag: (tag, page, perPage) => getVideoList(page, perPage || 20, 'latest', null, tag),
    getPostsByActor: (actor, page, perPage) => getVideoList(page, perPage || 20, 'latest', null, null, actor)
};