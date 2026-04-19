'use strict';

const express = require('express');
const router = express.Router();
const hentaitv = require('../providers/hentai/hentaitv');
const hentaicity = require('../providers/hentai/hentaicity');
const mangakakalot = require('../providers/manga/mangakakalot/controler/mangaKakalotController');
const javgg = require('../providers/jav/javgg/javggscraper');
const javggvidlink = require('../providers/jav/javgg/javggvidlink');
const hentaimama = require('../providers/hentai/hentaimama');
const javtsunami = require('../providers/jav/javtsunami/javtsunamiscraper');
const { Hentai20 } = require('../providers/manga/hentai20/hentai20');
const { Hentairead: Hentai2Read } = require('../providers/manga/hentai2read/hentai2read');

// ── Hentairead: instantiate the class and bind methods ──
const { Hentairead } = require('../providers/manga/hentairead/hentairead');
const _htrInstance    = new Hentairead();
const htrLatest         = (...a) => _htrInstance.getLatestManga(...a);
const htrSearch         = (...a) => _htrInstance.searchManga(...a);
const htrGenreList      = (...a) => _htrInstance.getGenres(...a);
const htrByGenre        = (...a) => _htrInstance.getMangaByGenre(...a);
const htrSearchFilters  = (...a) => _htrInstance.getSearchFilters(...a);
const htrInfo           = (...a) => _htrInstance.getMangaDetails(...a);
const htrChapter        = (...a) => _htrInstance.getChapterImages(...a);
const htrTop            = (...a) => _htrInstance.getTopManga(...a);
const htrTopRankings    = (...a) => _htrInstance.getTopRankings(...a);
const htrClearCaches    = (...a) => _htrInstance.clearCaches(...a);

// Others
const vivamax = require('../providers/others/vivamax');

const hentai20   = new Hentai20();
const hentai2read = new Hentai2Read();

// ==================== IMPROVED RESPONSE HANDLER ====================

/**
 * Universal response handler that properly handles different response formats
 * @param {Object} res - Express response object
 * @param {Promise} promise - Promise from scraper function
 * @param {Object} options - Optional configuration
 */
const handleResponse = (res, promise, options = {}) => {
    promise
        .then(result => {
            // If result is an object, handle known standardized formats to avoid double-wrapping.
            if (result && typeof result === 'object') {
                // Old format: { success: true/false, data, pagination?, error? }
                if ('success' in result) {
                    if (result.success) {
                        const response = {
                            status: 'success',
                            data: result.data,
                            timestamp: new Date().toISOString()
                        };
                        if (result.pagination) response.pagination = result.pagination;
                        res.json(response);
                        return;
                    } else {
                        res.status(500).json({
                            status: 'error',
                            error: result.error || { message: 'Unknown error', code: 'UNKNOWN_ERROR' },
                            timestamp: new Date().toISOString()
                        });
                        return;
                    }
                }

                // New format used by scrapers: { status: 'success'|'error', data?, pagination?, error? }
                if (result.status === 'success' || result.status === 'error') {
                    if (!result.timestamp) result.timestamp = new Date().toISOString();
                    if (result.status === 'error') {
                        res.status(500).json(result);
                    } else {
                        res.json(result);
                    }
                    return;
                }
            }

            // Fallback: wrap raw data into the standard response
            res.json({
                status: 'success',
                data: result,
                timestamp: new Date().toISOString()
            });
        })
        .catch(error => {
            console.error('API Error:', error);
            res.status(500).json({
                status: 'error',
                error: {
                    message: error.message || 'Internal server error',
                    code: 'API_ERROR'
                },
                timestamp: new Date().toISOString()
            });
        });
};

/**
 * Transform handler for list results (adds slug extraction)
 * @param {Array} items - Array of items to transform
 */
const transformWithSlug = (items = []) => {
    return (items || []).map(it => {
        const link = it.link || '';
        const parts = String(link).split('/').filter(Boolean);
        const slug = parts.length ? parts.pop() : null;
        const { link: _ignore, excerpt: _ignore2, datePublished: _ignore3, ...rest } = it;
        return { ...rest, slug };
    });
};

// ==================== ROOT ENDPOINT ====================

router.get('/', (req, res) => {
    res.json({
        status: 'success',
        message: 'API is running',
        version: '2.0.0',
        endpoints: {
            hentaitv: {
                lists: [
                    'GET /api/hen/tv/brand-list',
                    'GET /api/hen/tv/genre-list'
                ],
                browse: [
                    'GET /api/hen/tv/recent',
                    'GET /api/hen/tv/trending',
                    'GET /api/hen/tv/random'
                ],
                content: [
                    'GET /api/hen/tv/info/:id',
                    'GET /api/hen/tv/watch/:id'
                ],
                filter: [
                    'GET /api/hen/tv/search/:query/:page?',
                    'GET /api/hen/tv/genre/:genre/:page?',
                    'GET /api/hen/tv/brand/:brand/:page?'
                ]
            },
            hentai20: {
                browse: [
                    'GET /api/manga/h20/latest/:page?',
                    'GET /api/manga/h20/popular/:page?',
                    'GET /api/manga/h20/updated/:page?',
                    'GET /api/manga/h20/random'
                ],
                content: [
                    'GET /api/manga/h20/details/:slug',
                    'GET /api/manga/h20/chapter/:slug',
                    'GET /api/manga/h20/read/:slug',
                    'GET /api/manga/h20/read-first/:slug'
                ],
                taxonomies: [
                    'GET /api/manga/h20/tags?page=1&per_page=100',
                    'GET /api/manga/h20/categories?page=1&per_page=100',
                    'GET /api/manga/h20/tag/:tag/:page?',
                    'GET /api/manga/h20/category/:category/:page?'
                ],
                search: [
                    'GET /api/manga/h20/search?q=query&page=1'
                ],
                cache: [
                    'POST /api/manga/h20/cache/clear',
                    'GET /api/manga/h20/cache/stats'
                ]
            },
            hentai2read: {
                browse: [
                    'GET /api/manga/h2r/recent/:page?'
                ],
                content: [
                    'GET /api/manga/h2r/details/:id',
                    'GET /api/manga/h2r/read/:slug',
                    'GET /api/manga/h2r/read/*   (any path segments)',
                    'GET /api/manga/h2r/read?url=chapter-url'
                ],
                taxonomies: [
                    'GET /api/manga/h2r/tags?page=1&per_page=100',
                    'GET /api/manga/h2r/categories?page=1&per_page=100',
                    'GET /api/manga/h2r/tag/:slug/:page?',
                    'GET /api/manga/h2r/category/:slug/:page?'
                ],
                search: [
                    'GET /api/manga/h2r/search?q=query&page=1'
                ],
                cache: [
                    'POST /api/manga/h2r/cache/clear'
                ]
            },
            hentairead: {
                browse: [
                    'GET /api/manga/htr/latest/:page?',
                    'GET /api/manga/htr/top?type=monthly&page=1',
                    'GET /api/manga/htr/top10'
                ],
                content: [
                    'GET /api/manga/htr/details/:slug',
                    'GET /api/manga/htr/read/:slug   (manga slug or chapter identifier)',
                    'GET /api/manga/htr/read/*   (full chapter path)',
                    'GET /api/manga/htr/read?url=chapter-url'
                ],
                taxonomies: [
                    'GET /api/manga/htr/genres',
                    'GET /api/manga/htr/genre/:slug/:page?'
                ],
                search: [
                    'GET /api/manga/htr/search?q=query&page=1'
                ],
                cache: [
                    'POST /api/manga/htr/cache/clear'
                ]
            },
            javtsunami: {
                browse: [
                    'GET /api/jav/tsunami/latest/:page?',
                    'GET /api/jav/tsunami/featured/:page?'
                ],
                content: [
                    'GET /api/jav/tsunami/watch/:id'
                ],
                taxonomies: [
                    'GET /api/jav/tsunami/categories',
                    'GET /api/jav/tsunami/category/:category/:page?',
                    'GET /api/jav/tsunami/tag-list',
                    'GET /api/jav/tsunami/tag/:tag/:page?',
                    'GET /api/jav/tsunami/actors?page=1&per_page=20&images=true',
                    'GET /api/jav/tsunami/actors/search?q=name&page=1'
                ],
                search: [
                    'GET /api/jav/tsunami/search?q=query&page=1'
                ],
                other: [
                    'GET /api/jav/tsunami/random'
                ]
            },
            hentaimama: {
                browse: [
                    'GET /api/hen/mama/home',
                    'GET /api/hen/mama/series/:page?',
                    'GET /api/hen/mama/recent-episodes/:page?',
                    'GET /api/hen/mama/new-monthly/:page?',
                    'GET /api/hen/mama/tvshows/:page?'
                ],
                content: [
                    'GET /api/hen/mama/info/:id',
                    'GET /api/hen/mama/watch/:id'
                ],
                taxonomies: [
                    'GET /api/hen/mama/genres',
                    'GET /api/hen/mama/studios',
                    'GET /api/hen/mama/genre/:genre/:page?',
                    'GET /api/hen/mama/studio/:studio/:page?'
                ],
                search: [
                    'GET /api/hen/mama/search/:query/:page?',
                    'GET /api/hen/mama/advance-search?query=...&genre=...&studio=...&status=...&page=1'
                ]
            }
        }
    });
});

// ==================== HENTAITV ENDPOINTS ====================

router.get('/hen/tv/brand-list', (req, res) => {
    handleResponse(res, hentaitv.scrapeBrandList());
});

router.get('/hen/tv/genre-list', (req, res) => {
    handleResponse(res, hentaitv.scrapeGenreList());
});

router.get('/hen/tv/watch/:id', (req, res) => {
    handleResponse(res, hentaitv.scrapeWatch(req.params.id));
});

router.get('/hen/tv/info/:id', (req, res) => {
    handleResponse(res, hentaitv.scrapeInfo(req.params.id));
});

router.get('/hen/tv/search/:query/:page?', (req, res) => {
    const query = req.params.query;
    const page = req.params.page || req.query.page || 1;
    handleResponse(res, hentaitv.scrapeSearch(query, page));
});

router.get('/hen/tv/search', (req, res) => {
    const query = req.query.q || req.query.query;
    const page = req.query.page || 1;

    if (!query) {
        return res.status(400).json({
            status: 'error',
            error: {
                message: 'Missing query parameter. Use ?q=searchterm or ?query=searchterm',
                code: 'MISSING_PARAMETER'
            },
            timestamp: new Date().toISOString()
        });
    }

    handleResponse(res, hentaitv.scrapeSearch(query, page));
});

router.get('/hen/tv/genre/:genre/:page?', (req, res) => {
    const genre = req.params.genre;
    const page = req.params.page || req.query.page || 1;
    handleResponse(res, hentaitv.scrapeGenre(genre, page));
});

router.get('/hen/tv/recent', (req, res) => {
    handleResponse(res, hentaitv.scrapeRecent());
});

router.get('/hen/tv/trending', (req, res) => {
    handleResponse(res, hentaitv.scrapeTrending());
});

router.get('/hen/tv/random', (req, res) => {
    handleResponse(res, hentaitv.scrapeRandom());
});

router.get('/hen/tv/brand/:brand/:page?', (req, res) => {
    const brand = req.params.brand;
    const page = req.params.page || req.query.page || 1;
    handleResponse(res, hentaitv.scrapeBrand(brand, page));
});

router.post('/hen/tv/cache/clear', (req, res) => {
    try {
        hentaitv.clearCache();
        res.json({
            status: 'success',
            message: 'Cache cleared successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: {
                message: error.message,
                code: 'CACHE_CLEAR_ERROR'
            },
            timestamp: new Date().toISOString()
        });
    }
});

// ==================== HENTAICITY ENDPOINTS ====================

router.get('/hen/city/info/:id', (req, res) => {
    handleResponse(res, hentaicity.scrapeInfo(req.params.id));
});

router.get('/hen/city/watch/:id', (req, res) => {
    handleResponse(res, hentaicity.scrapeWatch(req.params.id));
});

router.get('/hen/city/recent', (req, res) => {
    handleResponse(res, hentaicity.scrapeRecent());
});

router.get('/hen/city/popular/:page?', (req, res) => {
    const page = req.params.page ? parseInt(req.params.page, 10) : 1;
    handleResponse(res, hentaicity.scrapePopular(page));
});

router.get('/hen/city/top/:page?', (req, res) => {
    const page = req.params.page ? parseInt(req.params.page, 10) : 1;
    handleResponse(res, hentaicity.scrapeTop(page));
});

// ==================== HENTAIMAMA ENDPOINTS ====================

router.get('/hen/mama/home', (req, res) => {
    handleResponse(res, hentaimama.scrapeHome());
});

router.get('/hen/mama/info/:id', (req, res) => {
    handleResponse(res, hentaimama.scrapeInfo(req.params.id));
});

router.get('/hen/mama/watch/:id', (req, res) => {
    handleResponse(res, hentaimama.scrapeEpisode(req.params.id));
});

router.get('/hen/mama/series/:page?', (req, res) => {
    const page = req.params.page ? parseInt(req.params.page, 10) : (parseInt(req.query.page, 10) || 1);
    handleResponse(res, hentaimama.scrapeSeries(page));
});

router.get('/hen/mama/search/:query/:page?', (req, res) => {
    const query = req.params.query;
    const page = req.params.page ? parseInt(req.params.page, 10) : (parseInt(req.query.page, 10) || 1);
    handleResponse(res, hentaimama.searchHentaimama(query, page));
});

router.get('/hen/mama/genres', (req, res) => {
    handleResponse(res, hentaimama.scrapeGenreList());
});

router.get('/hen/mama/studios', (req, res) => {
    handleResponse(res, hentaimama.scrapeStudioList());
});

router.get('/hen/mama/genre/:genre/:page?', (req, res) => {
    const genre = req.params.genre;
    const page = req.params.page ? parseInt(req.params.page, 10) : (parseInt(req.query.page, 10) || 1);
    handleResponse(res, hentaimama.scrapeGenrePage(genre, page));
});

router.get('/hen/mama/studio/:studio/:page?', (req, res) => {
    const studio = req.params.studio;
    const page = req.params.page ? parseInt(req.params.page, 10) : (parseInt(req.query.page, 10) || 1);
    handleResponse(res, hentaimama.scrapeStudio(studio, page));
});

router.get('/hen/mama/new-monthly/:page?', (req, res) => {
    const page = req.params.page ? parseInt(req.params.page, 10) : (parseInt(req.query.page, 10) || 1);
    handleResponse(res, hentaimama.scrapeNewMonthlyHentai(page));
});

router.get('/hen/mama/recent-episodes/:page?', (req, res) => {
    const page = req.params.page ? parseInt(req.params.page, 10) : (parseInt(req.query.page, 10) || 1);
    handleResponse(res, hentaimama.scrapeRecentEpisodes(page));
});

router.get('/hen/mama/tvshows/:page?', (req, res) => {
    const page = req.params.page ? parseInt(req.params.page, 10) : (parseInt(req.query.page, 10) || 1);
    handleResponse(res, hentaimama.scrapeTVShowsArchive(page));
});

router.get('/hen/mama/advance-search', (req, res) => {
    const filters = {
        query:  req.query.query || req.query.q,
        genre:  req.query.genre,
        studio: req.query.studio,
        status: req.query.status,
        page:   parseInt(req.query.page, 10) || 1
    };
    handleResponse(res, hentaimama.advanceSearch(filters));
});

// ==================== MANGAKAKALOT ENDPOINTS ====================

router.get('/manga/kakalot/read/:mangaId?/:chapterId?', mangakakalot.getMangaChapterImages);
router.get('/manga/kakalot/details/:id',                mangakakalot.getMangaDetails);
router.get('/manga/kakalot/search/:query?/:page?',      mangakakalot.getMangaSearch);
router.get('/manga/kakalot/latest/:page?',              mangakakalot.getLatestMangas);
router.get('/manga/kakalot/popular/:page?',             mangakakalot.getPopularMangas);
router.get('/manga/kakalot/newest/:page?',              mangakakalot.getNewestMangas);
router.get('/manga/kakalot/completed/:page?',           mangakakalot.getCompletedMangas);
router.get('/manga/kakalot/popular-now',                mangakakalot.getPopularNowMangas);
router.get('/manga/kakalot/home',                       mangakakalot.getHomePage);

// ==================== HENTAI20 ENDPOINTS ====================

router.get('/manga/h20/details/:slug', (req, res) => {
    handleResponse(res, hentai20.getMangaDetails(req.params.slug));
});

router.get('/manga/h20/popular', (req, res) => {
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 20, 100);

    handleResponse(res, hentai20.getPopularPeriods(perPage).then(result => {
        return {
            weekly:  transformWithSlug(result.weekly),
            monthly: transformWithSlug(result.monthly),
            all:     transformWithSlug(result.all)
        };
    }));
});

router.get('/manga/h20/search', (req, res) => {
    const query   = req.query.q || req.query.query;
    const page    = parseInt(req.query.page, 10) || 1;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 20, 100);

    if (!query) {
        return res.status(400).json({
            status: 'error',
            error: {
                message: 'Missing query parameter. Use ?q=searchterm',
                code: 'MISSING_PARAMETER'
            },
            timestamp: new Date().toISOString()
        });
    }

    handleResponse(res, hentai20.searchManga(query, page, perPage).then(result => {
        return {
            items:       transformWithSlug(result.items),
            totalPages:  result.totalPages,
            currentPage: result.currentPage,
            perPage
        };
    }));
});

router.get('/manga/h20/read/:slug', (req, res) => {
    handleResponse(res, hentai20.getChapterImages('https://hentai20.io/' + req.params.slug));
});

router.post('/manga/h20/cache/clear', (req, res) => {
    try {
        hentai20.clearCaches();
        res.json({
            status: 'success',
            message: 'Hentai20 cache cleared successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: { message: error.message, code: 'CACHE_CLEAR_ERROR' },
            timestamp: new Date().toISOString()
        });
    }
});

router.get('/manga/h20/genres', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    handleResponse(res, hentai20.getGenres(limit));
});

router.get('/manga/h20/genre/:genre/:page?', (req, res) => {
    const genre   = req.params.genre;
    const page    = parseInt(req.params.page || req.query.page, 10) || 1;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 20, 100);

    handleResponse(res, hentai20.getMangaByGenre(genre, page, perPage).then(result => {
        return {
            items:       transformWithSlug(result.items),
            totalPages:  result.totalPages,
            currentPage: result.currentPage,
            perPage
        };
    }));
});

// ==================== HENTAI2READ ENDPOINTS ====================

router.get('/manga/h2r/recent/:page?', (req, res) => {
    const page    = parseInt(req.params.page || req.query.page, 10) || 1;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 20, 100);
    handleResponse(res, hentai2read.getRecentManga(page, perPage));
});

router.get('/manga/h2r/details/:id', (req, res) => {
    handleResponse(res, hentai2read.getMangaDetails(req.params.id));
});

router.get('/manga/h2r/search', (req, res) => {
    const query   = req.query.q || req.query.query;
    const page    = parseInt(req.query.page, 10) || 1;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 20, 100);

    if (!query) {
        return res.status(400).json({
            status: 'error',
            error: {
                message: 'Missing query parameter. Use ?q=searchterm',
                code: 'MISSING_PARAMETER'
            },
            timestamp: new Date().toISOString()
        });
    }

    handleResponse(res, hentai2read.searchManga(query, page, perPage));
});

router.get('/manga/h2r/tags', (req, res) => {
    const page    = parseInt(req.query.page, 10) || 1;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 100, 200);
    handleResponse(res, hentai2read.getTags(page, perPage));
});

router.get('/manga/h2r/categories', (req, res) => {
    const page    = parseInt(req.query.page, 10) || 1;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 100, 200);
    handleResponse(res, hentai2read.getCategories(page, perPage));
});

router.get('/manga/h2r/category/:slug/:page?', (req, res) => {
    const slug    = req.params.slug;
    const page    = parseInt(req.params.page || req.query.page, 10) || 1;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 20, 100);
    handleResponse(res, hentai2read.getPostsByCategory(slug, page, perPage));
});

router.get('/manga/h2r/tag/:slug/:page?', (req, res) => {
    const slug    = req.params.slug;
    const page    = parseInt(req.params.page || req.query.page, 10) || 1;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 20, 100);
    handleResponse(res, hentai2read.getPostsByTag(slug, page, perPage));
});

router.get('/manga/h2r/read/:slug', (req, res) => {
    const chapterUrl = req.query.url || req.params.slug;
    handleResponse(res, hentai2read.getChapterImages(chapterUrl));
});

router.get('/manga/h2r/read/*', (req, res) => {
    if (req.query.url) {
        return handleResponse(res, hentai2read.getChapterImages(req.query.url));
    }
    const rest = req.params[0];
    if (!rest) {
        return res.status(400).json({
            status: 'error',
            error: { message: 'Missing chapter path', code: 'MISSING_PARAMETER' },
            timestamp: new Date().toISOString()
        });
    }
    let chapterUrl = rest;
    if (!/^https?:\/\//i.test(chapterUrl)) {
        chapterUrl = 'https://hentai2read.com/' + chapterUrl;
    }
    handleResponse(res, hentai2read.getChapterImages(chapterUrl));
});

router.get('/manga/h2r/read', (req, res) => {
    const chapterUrl = req.query.url;
    if (!chapterUrl) {
        return res.status(400).json({
            status: 'error',
            error: {
                message: 'Missing url query parameter for chapter',
                code: 'MISSING_PARAMETER'
            },
            timestamp: new Date().toISOString()
        });
    }
    handleResponse(res, hentai2read.getChapterImages(chapterUrl));
});

router.post('/manga/h2r/cache/clear', (req, res) => {
    try {
        hentai2read.clearCaches();
        res.json({
            status: 'success',
            message: 'Hentai2Read cache cleared successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: { message: error.message, code: 'CACHE_CLEAR_ERROR' },
            timestamp: new Date().toISOString()
        });
    }
});

// ==================== HENTAIREAD ENDPOINTS ====================

router.get('/manga/htr/latest/:page?', (req, res) => {
    const page    = parseInt(req.params.page || req.query.page, 10) || 1;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 24, 100);
    handleResponse(res, htrLatest(page, perPage));
});

router.get('/manga/htr/details/:slug', (req, res) => {
    handleResponse(res, htrInfo(req.params.slug));
});

router.get('/manga/htr/search', (req, res) => {
    const query   = req.query.q || req.query.query;
    const page    = parseInt(req.query.page, 10) || 1;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 24, 100);
    const status  = req.query.status || 'all';
    const sortBy  = req.query.sortBy || req.query.sortby || 'lastest-manga';

    if (!query) {
        return res.status(400).json({
            status: 'error',
            error: {
                message: 'Missing query parameter. Use ?q=searchterm',
                code: 'MISSING_PARAMETER'
            },
            timestamp: new Date().toISOString()
        });
    }

    handleResponse(res, htrSearch(query, page, perPage, status, sortBy));
});

router.get('/manga/htr/top', (req, res) => {
    const typeAliases = new Map([
        ['month', 'month'],
        ['monthly', 'month'],
        ['week', 'week'],
        ['weekly', 'week'],
        ['day', 'day'],
        ['daily', 'day']
    ]);

    let type = String(req.query.type || req.query.t || 'day').toLowerCase();
    type = typeAliases.get(type) || 'day';

    const page    = parseInt(req.query.page, 10) || 1;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 24, 100);

    handleResponse(res, htrTop(type, page, perPage));
});

router.get('/manga/htr/top10', (req, res) => {
    handleResponse(res, htrTopRankings());
});

router.get('/manga/htr/filters', (req, res) => {
    handleResponse(res, htrSearchFilters());
});

router.get('/manga/htr/status/:status/:page?', (req, res) => {
    const status = req.params.status;
    const page   = parseInt(req.params.page || req.query.page, 10) || 1;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 24, 100);
    const sortBy  = req.query.sortBy || req.query.sortby || 'lastest-manga';

    handleResponse(res, htrLatest(page, perPage, status, sortBy));
});

router.get('/manga/htr/genres', (req, res) => {
    handleResponse(res, htrGenreList());
});

router.get('/manga/htr/genre/:slug/:page?', (req, res) => {
    const slug    = req.params.slug;
    const page    = parseInt(req.params.page || req.query.page, 10) || 1;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 24, 100);
    handleResponse(res, htrByGenre(slug, page, perPage));
});

// Single-segment chapter slug or manga slug (resolves to first chapter)
router.get('/manga/htr/read/:slug', (req, res) => {
    const identifier = req.query.url || req.params.slug;
    handleResponse(res, htrChapter(identifier));
});

// Multi-segment chapter path  e.g. /read/manga-slug/chapter-1/
router.get('/manga/htr/read/*', (req, res) => {
    if (req.query.url) {
        return handleResponse(res, htrChapter(req.query.url));
    }
    const rest = req.params[0];
    if (!rest) {
        return res.status(400).json({
            status: 'error',
            error: { message: 'Missing chapter path', code: 'MISSING_PARAMETER' },
            timestamp: new Date().toISOString()
        });
    }
    // Pass as-is; htrChapter / getChapterImages handles relative or absolute URLs
    handleResponse(res, htrChapter(rest));
});

// Explicit URL form: /read?url=https://...
router.get('/manga/htr/read', (req, res) => {
    const chapterUrl = req.query.url;
    if (!chapterUrl) {
        return res.status(400).json({
            status: 'error',
            error: {
                message: 'Missing url query parameter for chapter',
                code: 'MISSING_PARAMETER'
            },
            timestamp: new Date().toISOString()
        });
    }
    handleResponse(res, htrChapter(chapterUrl));
});

router.post('/manga/htr/cache/clear', (req, res) => {
    try {
        htrClearCaches();
        res.json({
            status: 'success',
            message: 'Hentairead cache cleared successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: { message: error.message, code: 'CACHE_CLEAR_ERROR' },
            timestamp: new Date().toISOString()
        });
    }
});

// ==================== JAVTSUNAMI ENDPOINTS ====================

router.get('/jav/tsunami/latest/:page?', (req, res) => {
    const page   = req.params.page ? parseInt(req.params.page, 10) : (parseInt(req.query.page, 10) || 1);
    const filter = req.query.filter || 'latest';
    handleResponse(res, javtsunami.getVideoList(page, 20, filter));
});

router.get('/jav/tsunami/featured/:page?', (req, res) => {
    const page   = req.params.page ? parseInt(req.params.page, 10) : (parseInt(req.query.page, 10) || 1);
    const filter = req.query.filter || 'latest';
    handleResponse(res, javtsunami.getVideoList(page, 20, filter, 'featured'));
});

router.get('/jav/tsunami/categories', (req, res) => {
    const includeImages = req.query.images === 'true' || req.query.images === '1';
    const page    = parseInt(req.query.page, 10) || 1;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 100, 200);
    handleResponse(res, javtsunami.getCategories(page, perPage, includeImages));
});

router.get('/jav/tsunami/category/:category/:page?', (req, res) => {
    const page   = req.params.page ? parseInt(req.params.page, 10) : (parseInt(req.query.page, 10) || 1);
    const filter = typeof req.query.filter === 'string' ? req.query.filter : 'latest';
    handleResponse(res, javtsunami.getVideoList(page, 20, filter, req.params.category));
});

router.get('/jav/tsunami/actor/:actor/:page?', (req, res) => {
    const actor   = req.params.actor;
    const page    = req.params.page ? parseInt(req.params.page, 10) : (parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 20, 100);
    handleResponse(res, javtsunami.getPostsByActor(actor, page, perPage));
});

router.get('/jav/tsunami/watch/:id', (req, res) => {
    let id = req.params.id.replace(/\.html$/, '');
    handleResponse(res, javtsunami.getVideoDetails(id));
});

router.get('/jav/tsunami/tag-list', (req, res) => {
    const includeImages = req.query.images === 'true' || req.query.images === '1';
    handleResponse(res, javtsunami.getTags(1, 100, includeImages));
});

router.get('/jav/tsunami/tag/:tag/:page?', (req, res) => {
    const page   = req.params.page ? parseInt(req.params.page, 10) : (parseInt(req.query.page, 10) || 1);
    const filter = req.query.filter || 'latest';
    handleResponse(res, javtsunami.getVideoList(page, 20, filter, null, req.params.tag));
});

router.get('/jav/tsunami/actors/search', (req, res) => {
    const query = (req.query.q || req.query.search || '').trim();

    if (!query) {
        return res.status(400).json({
            status: 'error',
            error: {
                message: 'Missing search query. Use ?q=searchterm or ?search=searchterm',
                code: 'MISSING_PARAMETER'
            },
            timestamp: new Date().toISOString()
        });
    }

    const page    = parseInt(req.query.page, 10) || 1;
    const perPage = parseInt(req.query.per_page, 10) || 20;
    handleResponse(res, javtsunami.getActors(page, perPage, query));
});

router.get('/jav/tsunami/actors', (req, res) => {
    const page   = parseInt(req.query.page, 10) || 1;
    const perPage = parseInt(req.query.per_page, 10) || 20;
    const search  = (req.query.q || req.query.search || '').trim() || null;
    handleResponse(res, javtsunami.getActors(page, perPage, search));
});

router.get('/jav/tsunami/search', (req, res) => {
    const query = req.query.q || '';
    const page  = parseInt(req.query.page, 10) || 1;

    if (!query) {
        return res.status(400).json({
            status: 'error',
            error: {
                message: 'Missing query parameter ?q=',
                code: 'MISSING_PARAMETER'
            },
            timestamp: new Date().toISOString()
        });
    }

    handleResponse(res, javtsunami.searchVideos(query, page));
});

router.get('/jav/tsunami/random', (req, res) => {
    handleResponse(
        res,
        javtsunami.getVideoList(1, 1, 'random').then(result => {
            if (result.success && result.data && result.data.length > 0) {
                return { success: true, data: result.data[0] };
            }
            return {
                success: false,
                error: { message: 'No videos found', code: 'NO_RESULTS' },
                data: null
            };
        })
    );
});

// ==================== VIVAMAX ENDPOINTS ====================

router.get('/others/vivamax/home', (req, res) => {
    handleResponse(res, vivamax.getHome());
});

router.get('/others/vivamax/list', (req, res) => {
    const path = req.query.path || '/';
    const page = parseInt(req.query.page, 10) || 1;
    handleResponse(res, vivamax.getVideoList(path, page));
});

router.get('/others/vivamax/watch/:id?', (req, res) => {
    const queryPath = req.query.path || req.query.url;
    if (queryPath) {
        return handleResponse(res, vivamax.getVideoDetails(queryPath));
    }

    let id = req.params.id || '';
    if (!id) {
        return res.status(400).json({
            status: 'error',
            error: { message: 'Missing id parameter or path query param', code: 'MISSING_PARAMETER' },
            timestamp: new Date().toISOString()
        });
    }
    handleResponse(res, vivamax.getVideoDetails(id));
});

router.get('/others/vivamax/search', (req, res) => {
    const q    = (req.query.q || req.query.query || '').trim();
    const page = parseInt(req.query.page, 10) || 1;
    if (!q) {
        return res.status(400).json({
            status: 'error',
            error: { message: 'Missing query parameter. Use ?q=searchterm', code: 'MISSING_PARAMETER' },
            timestamp: new Date().toISOString()
        });
    }
    handleResponse(res, vivamax.search(q, page));
});

router.get('/others/vivamax/site', (req, res) => {
    handleResponse(res, vivamax.getSiteInfo());
});

module.exports = router;