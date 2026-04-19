'use strict';

const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://hentairead.to';
const FALLBACK_URL = 'https://hentairead.io';

const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif)$/i;
const LANDING_RE = /window\.location\.href\s*=\s*['"]\/lander['"?]/i;

// ─── LRU Cache ───────────────────────────────────────────────────────────────

class LRUCache {
    constructor(maxSize = 300) {
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
        if (this.cache.has(key)) this.cache.delete(key);
        else if (this.cache.size >= this.maxSize) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, value);
    }

    clear() { this.cache.clear(); }
}

const caches = {
    page:    new LRUCache(120),
    details: new LRUCache(80),
    genres:  new LRUCache(40),
    chapter: new LRUCache(120),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cleanHTML(html) {
    if (!html) return '';
    return String(html)
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&#8217;/gi, "'")
        .replace(/&#8211;/gi, '–')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanURL(url, base = BASE_URL) {
    if (!url) return null;
    let s = String(url).trim().replace(/\s+/g, '');
    if (!s) return null;
    if (s.startsWith('//')) return `https:${s}`;
    if (!/^https?:\/\//i.test(s)) return `${base}${s.startsWith('/') ? '' : '/'}${s}`;
    return s;
}

function slugFromUrl(url, base = BASE_URL) {
    try {
        const parts = new URL(url, base).pathname.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : null;
    } catch {
        const parts = String(url).split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : null;
    }
}

function normalizeImages(urls, base = BASE_URL) {
    const seen = new Set();
    return (urls || []).reduce((acc, raw) => {
        if (!raw) return acc;
        let s = String(raw).trim().replace(/\s+/g, '');
        if (s.startsWith('//')) s = `https:${s}`;
        else if (!/^https?:\/\//i.test(s)) s = `${base}${s.startsWith('/') ? '' : '/'}${s}`;
        s = s.replace(/\?[^?#]*$/, '');
        if (!seen.has(s) && IMAGE_EXT_RE.test(s)) {
            seen.add(s);
            acc.push(s);
        }
        return acc;
    }, []);
}

function extractPagination($, currentPage) {
    let lastPage = currentPage;
    $('ul.pagination li a.page-link').each((_, el) => {
        const m = ($(el).attr('href') || '').match(/[?&]pageNum=(\d+)/);
        if (m) lastPage = Math.max(lastPage, parseInt(m[1], 10));
    });
    return { page: currentPage, totalPages: lastPage };
}

function errorResult(message, code, data = null) {
    return { status: 'error', error: { message, code }, data };
}

// ─── Main Class ───────────────────────────────────────────────────────────────

class Hentairead {
    constructor() {
        this.baseUrl = BASE_URL;
        this.http = axios.create({
            headers: DEFAULT_HEADERS,
            timeout: 12000,
            maxRedirects: 5,
        });
    }

    async fetchPage(url, usedFallback = false) {
        const resolved = cleanURL(url, this.baseUrl);
        const { data: html } = await this.http.get(resolved, {
            headers: { ...DEFAULT_HEADERS, Referer: this.baseUrl },
        });

        if (typeof html !== 'string') throw new Error('Expected HTML string from server');

        if (LANDING_RE.test(html)) {
            if (!usedFallback && this.baseUrl === BASE_URL) {
                this.baseUrl = FALLBACK_URL;
                const fallback = resolved.replace(BASE_URL, FALLBACK_URL);
                return this.fetchPage(fallback, true);
            }
            throw new Error('Received landing redirect page');
        }

        return cheerio.load(html);
    }

    // ─── Card Parser ───────────────────────────────────────────────────────

    parseMangaCards($) {
        const items = [];
        const seen = new Set();

        $('.row .video .card').each((_, card) => {
            const $card = $(card);
            const $titleAnchor = $card.find('p.title-manga a').first();
            const link = cleanURL(
                $titleAnchor.attr('href') || $card.find('a:has(img.card-img-top)').first().attr('href'),
                this.baseUrl
            );
            const title = cleanHTML($titleAnchor.text() || $card.find('img.card-img-top').attr('alt'));
            const slug = slugFromUrl(link, this.baseUrl);

            if (!link || !title || !slug || seen.has(slug)) return;
            seen.add(slug);

            const $img = $card.find('img.card-img-top');
            const $chapter = $card.find('ul.list-group a.list-2-chap').first();

            items.push({
                slug,
                title,
                imageUrl: cleanURL($img.attr('src') || $img.attr('data-src'), this.baseUrl) || null,
                latestChapter:     cleanHTML($chapter.text()) || null,
                latestChapterDate: cleanHTML($card.find('ul.list-group li').eq(1).find('cite').text()) || null,
            });
        });

        return items;
    }

    // ─── Latest Manga ──────────────────────────────────────────────────────

    /**
     * Get the latest manga releases.
     * @param {number} [page=1]
     * @param {number} [perPage=24]
     * @returns {Promise<Object>}
     */
    async getLatestManga(page = 1, perPage = 24) {
        const key = `latest:${page}:${perPage}`;
        if (caches.page.get(key)) return caches.page.get(key);

        const $ = await this.fetchPage(
            `${this.baseUrl}/?act=search&f[status]=all&f[sortby]=lastest-manga&pageNum=${page}`
        );
        return this._pageResult($, page, perPage, key);
    }

    // ─── Search ────────────────────────────────────────────────────────────

    /**
     * Search manga by keyword.
     * @param {string} query
     * @param {number} [page=1]
     * @param {number} [perPage=24]
     * @returns {Promise<Object>}
     */
    async searchManga(query, page = 1, perPage = 24) {
        if (!query?.trim()) return errorResult('Query is required', 'MISSING_QUERY', []);

        const key = `search:${query}:${page}:${perPage}`;
        if (caches.page.get(key)) return caches.page.get(key);

        const $ = await this.fetchPage(
            `${this.baseUrl}/?act=search&f[status]=all&f[sortby]=lastest-manga&f[keyword]=${encodeURIComponent(query)}&pageNum=${page}`
        );

        const items = this.parseMangaCards($).slice(0, perPage);
        const { totalPages } = extractPagination($, page);

        const result = {
            provider: 'hentairead',
            type: 'search',
            data: {
                query,
                results: items,
                pagination: {
                    currentPage: page,
                    totalPages,
                    hasNextPage: page < totalPages,
                    hasPreviousPage: page > 1,
                },
            },
        };
        caches.page.set(key, result);
        return result;
    }

    // ─── Internal page result builder ──────────────────────────────────────

    _pageResult($, page, perPage, cacheKey, extraFields = {}) {
        const items = this.parseMangaCards($).slice(0, perPage);
        const { totalPages } = extractPagination($, page);
        const result = {
            provider: 'hentairead',
            type: 'manga-list',
            data: {
                ...extraFields,
                results: items,
                pagination: {
                    currentPage: page,
                    totalPages,
                    hasNextPage: page < totalPages,
                    hasPreviousPage: page > 1,
                },
            },
        };
        caches.page.set(cacheKey, result);
        return result;
    }

    // ─── Genres ────────────────────────────────────────────────────────────

    /**
     * Get all available genre slugs.
     * @returns {Promise<Object>}
     */
    async getGenres() {
        const key = 'genres';
        if (caches.genres.get(key)) return caches.genres.get(key);

        const $ = await this.fetchPage(`${this.baseUrl}/genres/`);
        const seen = new Set();
        const slugs = [];

        $('.list-group-item-action-menu').each((_, el) => {
            const $el = $(el);
            const href = cleanURL($el.attr('href'), this.baseUrl);
            const slug = slugFromUrl(href, this.baseUrl);
            if (!slug || seen.has(slug)) return;
            seen.add(slug);
            slugs.push(slug);
        });

        slugs.sort((a, b) => a.localeCompare(b));

        const result = {
            provider: 'hentairead',
            type: 'genre-list',
            data: {
                totalCount: slugs.length,
                genres: slugs,
            },
        };
        caches.genres.set(key, result);
        return result;
    }

    // ─── Manga by Genre ────────────────────────────────────────────────────

    /**
     * Get manga listings filtered by genre slug.
     * @param {string} genreSlug
     * @param {number} [page=1]
     * @param {number} [perPage=24]
     * @returns {Promise<Object>}
     */
    async getMangaByGenre(genreSlug, page = 1, perPage = 24) {
        if (!genreSlug) return errorResult('Genre slug is required', 'MISSING_GENRE', []);

        const key = `genre:${genreSlug}:${page}:${perPage}`;
        if (caches.page.get(key)) return caches.page.get(key);

        const url = `${this.baseUrl}/genres/${genreSlug}/${page > 1 ? `?pageNum=${page}` : ''}`;
        const $ = await this.fetchPage(url);
        return this._pageResult($, page, perPage, key, { genre: genreSlug });
    }

    // ─── Manga Details ─────────────────────────────────────────────────────

    /**
     * Get full details for a manga by slug or URL.
     * @param {string} identifier - Manga slug or full URL
     * @returns {Promise<Object>}
     */
    async getMangaDetails(identifier) {
        if (!identifier) return errorResult('Identifier is required', 'MISSING_IDENTIFIER');

        const slug = slugFromUrl(identifier, this.baseUrl) || String(identifier).trim();
        const key = `details:${slug}`;
        if (caches.details.get(key)) return caches.details.get(key);

        const url = identifier.startsWith('http') ? identifier : `${this.baseUrl}/${slug}/`;
        const $ = await this.fetchPage(url);

        const title = cleanHTML(
            $('h1.entry-title, h1.post-title, .title-manga, .detail-title, .title').first().text() ||
            $('meta[property="og:title"]').attr('content')
        );

        const posterUrl = cleanURL(
            $('meta[property="og:image"]').attr('content') ||
            $('.thumb img, .summary_image img, .cover img').first().attr('src'),
            this.baseUrl
        ) || null;

        const description = cleanHTML(
            $('.description-summary, .desc, .content, .summary-content, .story, #synopsis, #summary_shortened').first().text() ||
            $('meta[property="og:description"]').attr('content') ||
            $('meta[name="description"]').attr('content')
        ) || null;

        // Genres — array of slug strings to match hentaimama's genre format
        const genres = [];
        const genresSeen = new Set();
        $('.list-group.list-group-flush')
            .filter((_, el) => $(el).find('a[href*="/genres/"]').length > 0)
            .first()
            .find('a[href*="/genres/"]')
            .each((_, el) => {
                const $el = $(el);
                const gSlug = slugFromUrl(cleanURL($el.attr('href'), this.baseUrl), this.baseUrl);
                if (!gSlug || gSlug === 'genres' || genresSeen.has(gSlug)) return;
                genresSeen.add(gSlug);
                genres.push(gSlug);
            });

        const status = cleanHTML(
            $('.status.row, li.status.row').first().find('p.col-8').first().text()
        ) || null;

        // Chapters — ordered as listed on the page (newest first typically)
        const chapters = [];
        const chaptersSeen = new Set();

        const addChapter = ($anchor) => {
            const link = cleanURL($anchor.attr('href'), this.baseUrl);
            const cSlug = slugFromUrl(link, this.baseUrl);
            if (!link || !cSlug || chaptersSeen.has(cSlug)) return;
            chaptersSeen.add(cSlug);
            chapters.push({
                slug: cSlug,
                title: cleanHTML($anchor.text() || $anchor.attr('title')) || null,
                releaseDate: cleanHTML($anchor.closest('li').find('cite').text()) || null,
            });
        };

        const selectors = [
            '#nt_listchapter a[href*="/chapter-"]',
            '.list-chapter a[href*="/chapter-"]',
            'a[href*="/chapter-"]',
        ];
        for (const sel of selectors) {
            $(sel).each((_, el) => addChapter($(el)));
            if (chapters.length) break;
        }

        const result = {
            provider: 'hentairead',
            type: 'manga-info',
            data: {
                id: slug,
                slug,
                title: title || slug,
                posterUrl,
                description,
                status,
                genres,
                totalChapters: chapters.length,
                chapters,
            },
        };
        caches.details.set(key, result);
        return result;
    }

    // ─── Chapter Images ────────────────────────────────────────────────────

    /**
     * Get all page images for a chapter.
     * @param {string} identifier - Chapter slug, full chapter URL, or manga slug (resolves to first chapter)
     * @returns {Promise<Object>}
     */
    async getChapterImages(identifier) {
        if (!identifier) return errorResult('Chapter identifier is required', 'MISSING_CHAPTER_IDENTIFIER', []);

        let chapterUrl = identifier.startsWith('http') ? identifier : cleanURL(identifier, this.baseUrl);

        // If identifier is a manga slug (no "chapter-"), resolve to first chapter
        if (!/chapter-/i.test(identifier)) {
            const details = await this.getMangaDetails(identifier);
            const firstChapter = details?.data?.chapters?.[0];
            if (!firstChapter) return errorResult('No chapter found for manga slug', 'NO_CHAPTER_FOR_SLUG', []);
            chapterUrl = cleanURL(`${details.data.id}/${firstChapter.slug}/`, this.baseUrl);
        }

        const key = `chapter:${chapterUrl}`;
        if (caches.chapter.get(key)) return caches.chapter.get(key);

        const $ = await this.fetchPage(chapterUrl);
        const raw = [];

        const addImage = (src) => {
            const url = cleanURL(src, this.baseUrl);
            if (url && !(/logo_|logo\.|logo\//i.test(url)) && IMAGE_EXT_RE.test(url)) raw.push(url);
        };

        $('.page-chapter img, .reading-detail img, .comic-content img, .chapter-content img').each((_, el) => {
            const $el = $(el);
            addImage($el.attr('data-src') || $el.attr('src') || $el.attr('data-original'));
        });

        if (!raw.length) {
            $('img[src*="/manga/"]').each((_, el) => addImage($(el).attr('src')));
        }

        if (!raw.length) {
            const re = /(https?:\/\/ht\.hentairead\.io\/manga\/[\w\-/]+\.(?:webp|jpe?g|png|gif))/ig;
            for (const [, match] of $.html().matchAll(re)) addImage(match);
        }

        const images = normalizeImages(raw, this.baseUrl);
        if (!images.length) return errorResult('No chapter images found', 'NO_IMAGES', []);

        const title = cleanHTML($('h1, title, .title').first().text()) || chapterUrl;

        const result = {
            provider: 'hentairead',
            type: 'chapter',
            data: {
                slug: slugFromUrl(chapterUrl, this.baseUrl),
                title,
                url: chapterUrl,
                pageCount: images.length,
                pages: images,
            },
        };
        caches.chapter.set(key, result);
        return result;
    }

    // ─── Cache Management ──────────────────────────────────────────────────

    clearCaches() {
        Object.values(caches).forEach(c => c.clear());
    }
}

// ─── Module Exports (functional interface matching hentaimama style) ───────────

const _instance = new Hentairead();

/**
 * Get the latest manga releases.
 * @param {number} [page=1]
 * @param {number} [perPage=24]
 */
const getLatestManga = (page = 1, perPage = 24) =>
    _instance.getLatestManga(page, perPage);

/**
 * Search manga by keyword.
 * @param {string} query
 * @param {number} [page=1]
 * @param {number} [perPage=24]
 */
const searchManga = (query, page = 1, perPage = 24) =>
    _instance.searchManga(query, page, perPage);

/**
 * Get all available genre slugs.
 */
const getGenreList = () =>
    _instance.getGenres();

/**
 * Get manga listings filtered by genre slug.
 * @param {string} genreSlug
 * @param {number} [page=1]
 * @param {number} [perPage=24]
 */
const getMangaByGenre = (genreSlug, page = 1, perPage = 24) =>
    _instance.getMangaByGenre(genreSlug, page, perPage);

/**
 * Get full details for a manga (title, description, genres, chapters, etc.).
 * @param {string} identifier - Manga slug or full URL
 */
const getMangaInfo = (identifier) =>
    _instance.getMangaDetails(identifier);

/**
 * Get all page images for a specific chapter.
 * @param {string} identifier - Chapter slug, full chapter URL, or manga slug (resolves to first chapter)
 */
const getChapterPages = (identifier) =>
    _instance.getChapterImages(identifier);

/**
 * Clear all internal LRU caches.
 */
const clearCaches = () =>
    _instance.clearCaches();

module.exports = {
    // Functional API
    getLatestManga,
    searchManga,
    getGenreList,
    getMangaByGenre,
    getMangaInfo,
    getChapterPages,
    clearCaches,
    // Class export for advanced use
    Hentairead,
};