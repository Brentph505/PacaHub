const axios = require('axios');
const cheerio = require('cheerio');

// ==================== CONFIGURATION ====================

const CONFIG = {
    timeout: 15000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    debug: false
};

// ==================== UTILITY FUNCTIONS ====================

function isDoodStreamURL(url) {
    if (!url) return false;
    return url.includes('doodstream.com') || 
           url.includes('dood.') || 
           url.includes('vide0.net') ||
           url.includes('playmogo.com') ||
           url.includes('dood');
}

function validateVideoURL(url) {
    if (!url) return null;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return null;
    }
    return url.trim();
}

function createSuccessResult(url, isM3U8 = false) {
    return {
        success: true,
        sources: [{
            quality: 'default',
            url: url,
            isM3U8: isM3U8
        }],
        media: url
    };
}

// ==================== DOODSTREAM-SPECIFIC EXTRACTION ====================

/**
 * Extract DoodStream video URL using their pass_md5 API pattern
 */
async function extractDoodStreamVideo(url) {
    try {
        if (CONFIG.debug) {
            console.log(`[DoodStream] Extracting from: ${url}`);
        }

        const headers = {
            'User-Agent': CONFIG.userAgent,
            'Referer': url,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Connection': 'keep-alive'
        };

        // Step 1: Get the embed page
        const { data: html } = await axios.get(url, { 
            headers, 
            timeout: CONFIG.timeout,
            validateStatus: () => true
        });

        if (!html) {
            return { success: false, error: 'No response data' };
        }

        const $ = cheerio.load(html);

        // Method 1: Look for pass_md5 endpoint pattern (highest priority for live sites)
        const scripts = $('script:not([src])');
        let passMd5Url = null;

        for (let i = 0; i < scripts.length; i++) {
            const scriptContent = $(scripts[i]).html();
            if (!scriptContent) continue;

            // Look for pass_md5 API endpoint
            const passMd5Match = scriptContent.match(/\/pass_md5\/[^'"]+/);
            if (passMd5Match) {
                passMd5Url = passMd5Match[0];
                if (CONFIG.debug) console.log('[DoodStream] Found pass_md5 URL:', passMd5Url);
                break;
            }

            // Look for token in $.get() calls
            const tokenMatch = scriptContent.match(/\$\.get\(['"](\/pass_md5\/[^'"]+)['"]/);
            if (tokenMatch) {
                passMd5Url = tokenMatch[1];
                if (CONFIG.debug) console.log('[DoodStream] Found token URL:', passMd5Url);
                break;
            }
        }

        // Step 2: If we found the pass_md5 endpoint, call it
        if (passMd5Url) {
            try {
                const fullUrl = passMd5Url.startsWith('http') 
                    ? passMd5Url 
                    : `${new URL(url).origin}${passMd5Url}`;

                if (CONFIG.debug) console.log('[DoodStream] Calling pass_md5 endpoint:', fullUrl);

                const { data: tokenData } = await axios.get(fullUrl, {
                    headers: {
                        ...headers,
                        'X-Requested-With': 'XMLHttpRequest',
                        'Referer': url
                    },
                    timeout: CONFIG.timeout
                });

                if (tokenData) {
                    // The response is typically the video URL or a token to construct it
                    const videoUrl = typeof tokenData === 'string' 
                        ? tokenData.trim() 
                        : tokenData.url || tokenData.download_url;

                    if (videoUrl && validateVideoURL(videoUrl)) {
                        if (CONFIG.debug) console.log('[DoodStream] Successfully extracted video URL from pass_md5');
                        return createSuccessResult(videoUrl, false);
                    }
                }
            } catch (apiError) {
                if (CONFIG.debug) console.log('[DoodStream] pass_md5 API call failed:', apiError.message);
            }
        }

        // Method 2: Look for direct video src in HTML (fallback)
        const videoSrcMatch = html.match(/<video[^>]*src=["']([^"']+)["'][^>]*>/i);
        if (videoSrcMatch) {
            const videoUrl = videoSrcMatch[1];
            if (CONFIG.debug) console.log('[DoodStream] Found video src in HTML:', videoUrl);
            const cleanUrl = validateVideoURL(videoUrl);
            if (cleanUrl) {
                if (CONFIG.debug) console.log('[DoodStream] Successfully extracted from HTML src');
                return createSuccessResult(cleanUrl, videoUrl.includes('.m3u8'));
            } else {
                if (CONFIG.debug) console.log('[DoodStream] Video URL failed validation:', videoUrl);
            }
        }

        // Method 3: Extract from data attributes and src attribute
        const videoElement = $('video, source, [data-src], [data-url]');
        if (CONFIG.debug) console.log('[DoodStream] Found', videoElement.length, 'video elements');

        if (videoElement.length) {
            const videoUrl = videoElement.attr('src') ||
                           videoElement.attr('data-src') ||
                           videoElement.attr('data-url');

            if (CONFIG.debug) console.log('[DoodStream] Video element src:', videoUrl);

            if (videoUrl) {
                const cleanUrl = validateVideoURL(videoUrl);
                if (cleanUrl) {
                    if (CONFIG.debug) console.log('[DoodStream] Found video in element attributes');
                    return createSuccessResult(cleanUrl, videoUrl.includes('.m3u8'));
                }
            }
        }

        return {
            success: false,
            error: 'Could not extract video URL - may require captcha completion or headless browser',
            requiresCaptcha: true,
            embedUrl: url,
            suggestion: 'Use Puppeteer or Playwright to handle captcha and JavaScript rendering'
        };

    } catch (error) {
        if (CONFIG.debug) {
            console.error('[DoodStream] Error:', error.message);
        }
        return { success: false, error: error.message };
    }
}

// ==================== MAIN EXTRACTION FUNCTION ====================

async function extractDoodStream(url) {
    try {
        if (!isDoodStreamURL(url)) {
            return { success: false, error: 'Not a DoodStream/vide0.net URL' };
        }

        return await extractDoodStreamVideo(url);
    } catch (error) {
        if (CONFIG.debug) {
            console.error('[DoodStream] Extraction failed:', error.message);
        }
        return { success: false, error: error.message };
    }
}

// ==================== ENHANCED WITH PUPPETEER SUPPORT ====================

/**
 * Extract DoodStream video using Puppeteer (headless browser)
 * This bypasses captcha and JavaScript rendering issues
 */
async function extractWithPuppeteer(url) {
    try {
        const puppeteer = require('puppeteer');
        
        if (CONFIG.debug) {
            console.log('[DoodStream-Puppeteer] Launching browser...');
        }

        const browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security'
            ]
        });

        const page = await browser.newPage();
        
        // Set user agent
        await page.setUserAgent(CONFIG.userAgent);

        // Intercept network requests to capture video URLs
        let videoUrl = null;
        
        await page.setRequestInterception(true);
        page.on('request', request => {
            const url = request.url();
            
            // Capture video file requests
            if (url.includes('.mp4') || 
                url.includes('.m3u8') || 
                url.includes('dstorage') ||
                url.includes('/download/') ||
                url.includes('/stream/')) {
                
                if (!url.includes('doubleclick') && !url.includes('analytics')) {
                    videoUrl = url;
                    if (CONFIG.debug) console.log('[DoodStream-Puppeteer] Intercepted video URL:', url);
                }
            }
            
            request.continue();
        });

        // Navigate to page
        await page.goto(url, { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });

        // Wait a bit for video to load
        await page.waitForTimeout(3000);

        // Try to find video element
        const extractedUrl = await page.evaluate(() => {
            const video = document.querySelector('video');
            if (video && video.src) {
                return video.src;
            }
            
            const source = document.querySelector('source');
            if (source && source.src) {
                return source.src;
            }
            
            return null;
        });

        await browser.close();

        // Use intercepted URL or extracted URL
        const finalUrl = videoUrl || extractedUrl;

        if (finalUrl) {
            if (CONFIG.debug) console.log('[DoodStream-Puppeteer] Successfully extracted video URL');
            return createSuccessResult(finalUrl, finalUrl.includes('.m3u8'));
        }

        return {
            success: false,
            error: 'Could not extract video URL even with headless browser',
            suggestion: 'Video may require manual captcha solving'
        };

    } catch (error) {
        if (CONFIG.debug) {
            console.error('[DoodStream-Puppeteer] Error:', error.message);
        }
        return { success: false, error: error.message };
    }
}

// ==================== SERVER ENHANCEMENT ====================

async function enhanceServerWithMedia(servers) {
    if (!Array.isArray(servers) || servers.length === 0) {
        return servers;
    }

    const doodServers = servers.filter(server => 
        server && isDoodStreamURL(server.url)
    );

    if (doodServers.length === 0) {
        return servers;
    }

    const enhancedServers = await Promise.all(
        servers.map(async (server) => {
            if (!server || !isDoodStreamURL(server.url)) {
                return server;
            }

            try {
                const extraction = await extractDoodStream(server.url);

                if (extraction.success && extraction.media) {
                    return {
                        ...server,
                        media: extraction.media,
                        sources: extraction.sources,
                        type: 'DoodStream',
                        quality: 'HD',
                        isExtracted: true
                    };
                }

                // Return with error info
                return {
                    ...server,
                    media: server.url,
                    sources: [{
                        quality: 'default',
                        url: server.url,
                        isM3U8: false,
                        note: 'DoodStream embed - requires captcha or headless browser'
                    }],
                    type: 'DoodStream',
                    isExtracted: false,
                    requiresCaptcha: extraction.requiresCaptcha,
                    error: extraction.error
                };
            } catch (error) {
                return {
                    ...server,
                    media: server.url,
                    type: 'DoodStream',
                    isExtracted: false,
                    error: error.message
                };
            }
        })
    );

    return enhancedServers;
}

// ==================== DEBUG UTILITIES ====================

function enableDebug() {
    CONFIG.debug = true;
}

function disableDebug() {
    CONFIG.debug = false;
}

// ==================== EXPORTS ====================

module.exports = {
    extractDoodStream,
    extractWithPuppeteer,
    isDoodStreamURL,
    enhanceServerWithMedia,
    enableDebug,
    disableDebug
};