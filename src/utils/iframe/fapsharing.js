const axios = require('axios');
const cheerio = require('cheerio');

// ==================== CONFIGURATION ====================

const CONFIG = {
    timeout: 10000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    debug: false // Set to true for detailed logging
};

// ==================== UTILITY FUNCTIONS ====================

/**
 * Check if URL is a FapSharing URL
 */
function isFapSharingURL(url) {
    if (!url) return false;
    return url.includes('fapsharing.com');
}

/**
 * Validate and clean video URL
 */
function validateVideoURL(url) {
    if (!url) return null;
    
    // Ensure URL is complete
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return null;
    }
    
    return url.trim();
}

/**
 * Create success result object
 */
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

// ==================== OBFUSCATION HANDLING ====================

/**
 * Extract video URLs from FapSharing's packed/obfuscated JavaScript
 * FapSharing uses a packer that encodes the video configuration
 */
function extractFromPackedJS(html) {
    try {
        if (CONFIG.debug) {
            console.log('[FapSharing] Attempting to extract from packed JavaScript');
        }

        // Pattern 1: Look for direct HLS URLs in packed strings
        // The packed format contains encoded video URLs and configurations
        const hlsPatterns = [
            /https?:\/\/[^\s"'<>]*cdn[^\s"'<>]*\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*stream[^\s"'<>]*\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*hls[^\s"'<>]*\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+\/.*\.m3u8[^\s"'<>]*/gi
        ];

        for (const pattern of hlsPatterns) {
            const matches = html.match(pattern);
            if (matches && matches.length > 0) {
                if (CONFIG.debug) {
                    console.log('[FapSharing] Found HLS URLs in packed JS:', matches.slice(0, 3));
                }
                // Return the first valid match
                for (const url of matches) {
                    if (validateVideoURL(url)) {
                        return {
                            success: true,
                            url: url,
                            mediaType: 'm3u8',
                            source: 'packed_js'
                        };
                    }
                }
            }
        }

        // Pattern 2: Extract configuration object with URLs
        // var o={"16":"https://...","1f":"https://..."}
        const configMatch = html.match(/var\s+o\s*=\s*\{[\s\S]*?\};/);
        if (configMatch) {
            if (CONFIG.debug) {
                console.log('[FapSharing] Found config object');
            }
            // Extract all URLs from the config
            const urlMatches = configMatch[0].match(/(https?:\/\/[^"'<>]+)/g);
            if (urlMatches && urlMatches.length > 0) {
                // Filter for video URLs (m3u8, mp4, etc.)
                const videoUrls = urlMatches.filter(u => 
                    u.match(/\.(m3u8|mp4|mkv|flv|webm)(?:[?#]|$)/i)
                );
                if (videoUrls.length > 0) {
                    if (CONFIG.debug) {
                        console.log('[FapSharing] Found video URLs in config:', videoUrls.slice(0, 2));
                    }
                    return {
                        success: true,
                        url: videoUrls[0],
                        mediaType: videoUrls[0].includes('.m3u8') ? 'm3u8' : 'video',
                        alternateUrls: videoUrls,
                        source: 'config_object'
                    };
                }
            }
        }

        // Pattern 3: Look for stream identifiers that might indicate playlist location
        // stream:233999|232000|202999|202000 - these could be stream IDs
        const streamMatch = html.match(/stream[":]\s*["']?([^"'<>\s]+)/i);
        if (streamMatch && CONFIG.debug) {
            console.log('[FapSharing] Found stream identifier:', streamMatch[1]);
        }

        return null;
    } catch (err) {
        if (CONFIG.debug) {
            console.log('[FapSharing] Error extracting from packed JS:', err.message);
        }
        return null;
    }
}

/**
 * Extract video configuration from HTML scripts
 */
function extractVideoConfigFromScripts(html) {
    try {
        const $ = cheerio.load(html);
        const scripts = $('script');

        for (let i = 0; i < scripts.length; i++) {
            const scriptContent = $(scripts[i]).html();
            if (!scriptContent) continue;

            // Look for M3U8/HLS URLs
            const m3u8Matches = scriptContent.match(/https?:\/\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi);
            if (m3u8Matches && m3u8Matches.length > 0) {
                if (CONFIG.debug) {
                    console.log('[FapSharing] Found M3U8 in script tags');
                }
                for (const url of m3u8Matches) {
                    if (validateVideoURL(url)) {
                        return {
                            success: true,
                            url: url,
                            mediaType: 'm3u8',
                            source: 'script_tags'
                        };
                    }
                }
            }

            // Look for other video formats
            const videoMatches = scriptContent.match(/https?:\/\/[^\s"'<>]*\.(?:mp4|mkv|flv|webm)[^\s"'<>]*/gi);
            if (videoMatches && videoMatches.length > 0) {
                // Skip ad/tracking URLs
                const cleanUrls = videoMatches.filter(u => 
                    !u.includes('doubleclick') && 
                    !u.includes('google') && 
                    !u.includes('fbcdn')
                );
                
                if (cleanUrls.length > 0) {
                    if (CONFIG.debug) {
                        console.log('[FapSharing] Found video URLs in script');
                    }
                    return {
                        success: true,
                        url: cleanUrls[0],
                        mediaType: 'video',
                        source: 'script_tags'
                    };
                }
            }

            // Look for JSON configurations with URLs
            const jsonPatterns = [
                /"(?:url|src|file|sources|hls[2-4]?)"\s*:\s*"([^"]+\.(?:m3u8|mp4|mkv|flv)[^"]*)"/gi,
                /(?:url|src|file|sources)\s*:\s*["']([^\s"']+\.(?:m3u8|mp4|mkv|flv)[^\s"']*)/gi
            ];

            for (const pattern of jsonPatterns) {
                let match;
                while ((match = pattern.exec(scriptContent)) !== null) {
                    if (match[1]) {
                        const cleanUrl = validateVideoURL(match[1]);
                        if (cleanUrl && !cleanUrl.includes('doubleclick')) {
                            if (CONFIG.debug) {
                                console.log('[FapSharing] Found URL in JSON pattern');
                            }
                            return {
                                success: true,
                                url: match[1],
                                mediaType: match[1].includes('.m3u8') ? 'm3u8' : 'video',
                                source: 'json_config'
                            };
                        }
                    }
                }
            }
        }

        return null;
    } catch (err) {
        if (CONFIG.debug) {
            console.log('[FapSharing] Error extracting from scripts:', err.message);
        }
        return null;
    }
}


// ==================== OBFUSCATION HANDLING ====================

/**
 * Extract video URLs from FapSharing's packed/obfuscated JavaScript
 * FapSharing uses a packer that encodes the video configuration
 */
function extractFromPackedJS(html) {
    try {
        if (CONFIG.debug) {
            console.log('[FapSharing] Attempting to extract from packed JavaScript');
        }

        // Pattern 1: Look for direct HLS URLs in packed strings
        // The packed format contains encoded video URLs and configurations
        const hlsPatterns = [
            /https?:\/\/[^\s"'<>]*cdn[^\s"'<>]*\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*stream[^\s"'<>]*\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*hls[^\s"'<>]*\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+\/.*\.m3u8[^\s"'<>]*/gi
        ];

        for (const pattern of hlsPatterns) {
            const matches = html.match(pattern);
            if (matches && matches.length > 0) {
                if (CONFIG.debug) {
                    console.log('[FapSharing] Found HLS URLs in packed JS:', matches.slice(0, 3));
                }
                // Return the first valid match
                for (const url of matches) {
                    if (validateVideoURL(url)) {
                        return {
                            success: true,
                            url: url,
                            mediaType: 'm3u8',
                            source: 'packed_js'
                        };
                    }
                }
            }
        }

        // Pattern 2: Extract configuration object with URLs
        // var o={"16":"https://...","1f":"https://..."}
        const configMatch = html.match(/var\s+o\s*=\s*\{[\s\S]*?\};/);
        if (configMatch) {
            if (CONFIG.debug) {
                console.log('[FapSharing] Found config object');
            }
            // Extract all URLs from the config
            const urlMatches = configMatch[0].match(/(https?:\/\/[^"'<>]+)/g);
            if (urlMatches && urlMatches.length > 0) {
                // Filter for video URLs (m3u8, mp4, etc.)
                const videoUrls = urlMatches.filter(u => 
                    u.match(/\.(m3u8|mp4|mkv|flv|webm)(?:[?#]|$)/i)
                );
                if (videoUrls.length > 0) {
                    if (CONFIG.debug) {
                        console.log('[FapSharing] Found video URLs in config:', videoUrls.slice(0, 2));
                    }
                    return {
                        success: true,
                        url: videoUrls[0],
                        mediaType: videoUrls[0].includes('.m3u8') ? 'm3u8' : 'video',
                        alternateUrls: videoUrls,
                        source: 'config_object'
                    };
                }
            }
        }

        // Pattern 3: Look for stream identifiers that might indicate playlist location
        // stream:233999|232000|202999|202000 - these could be stream IDs
        const streamMatch = html.match(/stream[":]\s*["']?([^"'<>\s]+)/i);
        if (streamMatch && CONFIG.debug) {
            console.log('[FapSharing] Found stream identifier:', streamMatch[1]);
        }

        return null;
    } catch (err) {
        if (CONFIG.debug) {
            console.log('[FapSharing] Error extracting from packed JS:', err.message);
        }
        return null;
    }
}

/**
 * Extract video configuration from HTML scripts
 */
function extractVideoConfigFromScripts(html) {
    try {
        const $ = cheerio.load(html);
        const scripts = $('script');

        for (let i = 0; i < scripts.length; i++) {
            const scriptContent = $(scripts[i]).html();
            if (!scriptContent) continue;

            // Look for M3U8/HLS URLs
            const m3u8Matches = scriptContent.match(/https?:\/\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi);
            if (m3u8Matches && m3u8Matches.length > 0) {
                if (CONFIG.debug) {
                    console.log('[FapSharing] Found M3U8 in script tags');
                }
                for (const url of m3u8Matches) {
                    if (validateVideoURL(url)) {
                        return {
                            success: true,
                            url: url,
                            mediaType: 'm3u8',
                            source: 'script_tags'
                        };
                    }
                }
            }

            // Look for other video formats
            const videoMatches = scriptContent.match(/https?:\/\/[^\s"'<>]*\.(?:mp4|mkv|flv|webm)[^\s"'<>]*/gi);
            if (videoMatches && videoMatches.length > 0) {
                // Skip ad/tracking URLs
                const cleanUrls = videoMatches.filter(u => 
                    !u.includes('doubleclick') && 
                    !u.includes('google') && 
                    !u.includes('fbcdn')
                );
                
                if (cleanUrls.length > 0) {
                    if (CONFIG.debug) {
                        console.log('[FapSharing] Found video URLs in script');
                    }
                    return {
                        success: true,
                        url: cleanUrls[0],
                        mediaType: 'video',
                        source: 'script_tags'
                    };
                }
            }

            // Look for JSON configurations with URLs
            const jsonPatterns = [
                /"(?:url|src|file|sources|hls[2-4]?)"\s*:\s*"([^"]+\.(?:m3u8|mp4|mkv|flv)[^"]*)"/gi,
                /(?:url|src|file|sources)\s*:\s*["']([^\s"']+\.(?:m3u8|mp4|mkv|flv)[^\s"']*)/gi
            ];

            for (const pattern of jsonPatterns) {
                let match;
                while ((match = pattern.exec(scriptContent)) !== null) {
                    if (match[1]) {
                        const cleanUrl = validateVideoURL(match[1]);
                        if (cleanUrl && !cleanUrl.includes('doubleclick')) {
                            if (CONFIG.debug) {
                                console.log('[FapSharing] Found URL in JSON pattern');
                            }
                            return {
                                success: true,
                                url: match[1],
                                mediaType: match[1].includes('.m3u8') ? 'm3u8' : 'video',
                                source: 'json_config'
                            };
                        }
                    }
                }
            }
        }

        return null;
    } catch (err) {
        if (CONFIG.debug) {
            console.log('[FapSharing] Error extracting from scripts:', err.message);
        }
        return null;
    }
}

// ==================== EXTRACTION METHODS ====================

/**
 * Extract video URL from FapSharing embed page
 * Note: FapSharing uses blob URLs created by JavaScript runtime.
 */
async function extractFapSharingVideo(url) {
    try {
        if (CONFIG.debug) {
            console.log(`[FapSharing] Extracting from: ${url}`);
        }

        const options = {
            headers: {
                'User-Agent': CONFIG.userAgent,
                'Referer': url,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'DNT': '1',
                'Connection': 'keep-alive'
            },
            timeout: CONFIG.timeout,
            validateStatus: () => true,
            maxRedirects: 5
        };

        const { data } = await axios.get(url, options);
        
        if (!data) {
            if (CONFIG.debug) console.log('[FapSharing] No response data');
            return { success: false, error: 'No response data' };
        }

        const $ = cheerio.load(data);

        // Method 1: Try extracting from packed/obfuscated JavaScript
        const packedExtraction = extractFromPackedJS(data);
        if (packedExtraction && packedExtraction.success) {
            if (CONFIG.debug) {
                console.log(`[FapSharing] Method 1 (Packed JS): Found ${packedExtraction.mediaType}`);
            }
            return createSuccessResult(packedExtraction.url, packedExtraction.mediaType === 'm3u8');
        }

        // Method 2: Extract from script tags
        const scriptExtraction = extractVideoConfigFromScripts(data);
        if (scriptExtraction && scriptExtraction.success) {
            if (CONFIG.debug) {
                console.log(`[FapSharing] Method 2 (Scripts): Found ${scriptExtraction.mediaType}`);
            }
            return createSuccessResult(scriptExtraction.url, scriptExtraction.mediaType === 'm3u8');
        }

        // Method 3: Try extracting from video/source elements
        let videoElement = $('video');
        if (videoElement.length) {
            let videoUrl = videoElement.attr('src');
            
            // If no direct src, check for source tags
            if (!videoUrl) {
                const sourceTag = videoElement.find('source').first();
                videoUrl = sourceTag.attr('src');
            }
            
            if (videoUrl) {
                if (CONFIG.debug) console.log(`[FapSharing] Method 3: Found video element src: ${videoUrl}`);
                
                // If it's a blob URL, note it but continue searching
                if (videoUrl.includes('blob:')) {
                    if (CONFIG.debug) console.log('[FapSharing] Method 3: Blob URL detected - searching for fallback');
                } else {
                    // Otherwise validate and return the direct URL
                    const cleanUrl = validateVideoURL(videoUrl);
                    if (cleanUrl) {
                        if (CONFIG.debug) console.log('[FapSharing] Method 3: Direct video URL - Success');
                        return createSuccessResult(cleanUrl, videoUrl.includes('.m3u8'));
                    }
                }
            }
        }

        // Method 4: Search for any HTTPS URLs in script content (last resort)
        const allScripts = $('script');
        for (let script of allScripts) {
            const scriptContent = $(script).html();
            if (!scriptContent) continue;

            // Look for full M3U8 URLs (most likely to be video streaming)
            const m3u8Urls = scriptContent.match(/https?:\/\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi);
            if (m3u8Urls && m3u8Urls.length > 0) {
                for (const url of m3u8Urls) {
                    const cleanUrl = validateVideoURL(url);
                    if (cleanUrl && !cleanUrl.includes('doubleclick')) {
                        if (CONFIG.debug) console.log('[FapSharing] Method 4: M3U8 URL found');
                        return createSuccessResult(cleanUrl, true);
                    }
                }
            }
        }

        // Fallback: Return the embed URL itself
        // FapSharing embed URLs can often be played directly
        if (CONFIG.debug) {
            console.log(`[FapSharing] All methods failed - using embed URL as fallback`);
        }

        return { 
            success: false, 
            error: 'Could not extract M3U8 URL',
            fallback: true,
            embedUrl: url,
            suggestion: 'Use embed URL directly or consider using headless browser (Puppeteer)'
        };

    } catch (error) {
        if (CONFIG.debug) {
            console.error('[FapSharing] Error:', error.message);
        }
        return { success: false, error: error.message };
    }
}

// ==================== MAIN EXTRACTION FUNCTION ====================

/**
 * Extract media from FapSharing URL
 */
async function extractFapSharing(url) {
    try {
        if (!isFapSharingURL(url)) {
            return { success: false, error: 'Not a FapSharing URL' };
        }

        return await extractFapSharingVideo(url);
    } catch (error) {
        if (CONFIG.debug) {
            console.error('[FapSharing] Extraction failed:', error.message);
        }
        return { success: false, error: error.message };
    }
}

// ==================== SERVER ENHANCEMENT ====================

/**
 * Enhance server objects with FapSharing media extraction
 */
async function enhanceServerWithMedia(servers) {
    if (!Array.isArray(servers) || servers.length === 0) {
        return servers;
    }

    // Filter only FapSharing servers
    const fapSharingServers = servers.filter(server => 
        server && server.type === 'FapSharing' && server.url
    );

    if (fapSharingServers.length === 0) {
        return servers;
    }

    // Process each FapSharing server
    const enhancedServers = await Promise.all(
        servers.map(async (server) => {
            if (!server || server.type !== 'FapSharing' || !server.url) {
                return server;
            }

            try {
                const extraction = await extractFapSharing(server.url);

                if (extraction.success && extraction.media) {
                    return {
                        ...server,
                        media: extraction.media,
                        sources: extraction.sources,
                        type: 'FapSharing',
                        quality: 'HD',
                        isExtracted: true
                    };
                }

                // Fallback: Return the embed URL itself as playable media
                if (CONFIG.debug) {
                    console.log(`[FapSharing] Using fallback: embed URL as media source`);
                }

                return {
                    ...server,
                    media: server.url,
                    sources: [{
                        quality: 'default',
                        url: server.url,
                        isM3U8: false,
                        isFapSharingEmbed: true,
                        note: 'FapSharing embed URL - player will handle JavaScript streams'
                    }],
                    type: 'FapSharing',
                    isExtracted: false,
                    hasWarning: true,
                    warning: 'Direct M3U8 extraction not available. Using embed URL.'
                };
            } catch (error) {
                if (CONFIG.debug) {
                    console.error(`[FapSharing] Exception:`, error.message);
                }
                
                // Still return a working server with the embed URL as fallback
                return {
                    ...server,
                    media: server.url,
                    sources: [{
                        quality: 'default',
                        url: server.url,
                        isFapSharingEmbed: true
                    }],
                    hasWarning: true
                };
            }
        })
    );

    return enhancedServers;
}

// ==================== DEBUG FUNCTIONS ====================

/**
 * Enable debug logging
 */
function enableDebug() {
    CONFIG.debug = true;
}

/**
 * Disable debug logging
 */
function disableDebug() {
    CONFIG.debug = false;
}

// ==================== EXPORTS ====================

module.exports = {
    extractFapSharing,
    isFapSharingURL,
    enhanceServerWithMedia,
    enableDebug,
    disableDebug
};
