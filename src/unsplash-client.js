const UNSPLASH_API_BASE = 'https://api.unsplash.com';

let cachedFetch = null;

function getFetch() {
    if (!cachedFetch) {
        cachedFetch = typeof globalThis.fetch === 'function'
            ? globalThis.fetch.bind(globalThis)
            : require('node-fetch');
    }
    return cachedFetch;
}

/**
 * Get Unsplash Access Key from environment variables.
 * @returns {string|null} The access key or null if not set.
 */
function getAccessKey() {
    return process.env.UNSPLASH_ACCESS_KEY || null;
}

/**
 * Check if Unsplash client is configured (has access key).
 * @returns {boolean} True if configured, false otherwise.
 */
function isConfigured() {
    return !!getAccessKey();
}

/**
 * Search for images on Unsplash.
 *
 * @param {string} query - The search query.
 * @param {Object} options - Search options.
 * @param {number} [options.page=1] - Page number for pagination.
 * @param {number} [options.perPage=10] - Number of results per page (max 30).
 * @param {string} [options.orderBy='relevant'] - Sort order: 'relevant' or 'latest'.
 * @param {string} [options.orientation] - Filter by orientation: 'landscape', 'portrait', or 'squarish'.
 * @returns {Promise<Object>} Search results with images and metadata.
 * @throws {Error} If UNSPLASH_ACCESS_KEY is not set or API request fails.
 */
async function searchImages(query, options = {}) {
    const accessKey = getAccessKey();
    if (!accessKey) {
        throw new Error('UNSPLASH_ACCESS_KEY is not configured');
    }

    const {
        page = 1,
        perPage = 10,
        orderBy = 'relevant',
        orientation,
    } = options;

    const params = new URLSearchParams({
        query,
        page: String(page),
        per_page: String(Math.min(perPage, 30)),
        order_by: orderBy,
    });

    if (orientation) {
        params.append('orientation', orientation);
    }

    const url = `${UNSPLASH_API_BASE}/search/photos?${params.toString()}`;

    try {
        const response = await getFetch()(url, {
            headers: {
                'Authorization': `Client-ID ${accessKey}`,
                'Accept-Version': 'v1',
            },
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
                `Unsplash API error: ${response.status} ${response.statusText}` +
                (errorData.errors ? ` - ${errorData.errors.join(', ')}` : '')
            );
        }

        const data = await response.json();

        return {
            total: data.total,
            totalPages: data.total_pages,
            results: data.results.map(normalizeImage),
        };
    } catch (err) {
        console.error('[Unsplash] Search error:', err.message);
        throw err;
    }
}

/**
 * Get a random image from Unsplash.
 *
 * @param {string} [query] - Optional search query to filter random images.
 * @param {Object} options - Options for random image.
 * @param {string} [options.orientation] - Filter by orientation: 'landscape', 'portrait', or 'squarish'.
 * @param {number} [options.count=1] - Number of images to return (max 30).
 * @returns {Promise<Object|Array<Object>>} Random image(s) with metadata.
 * @throws {Error} If UNSPLASH_ACCESS_KEY is not set or API request fails.
 */
async function getRandomImage(query, options = {}) {
    const accessKey = getAccessKey();
    if (!accessKey) {
        throw new Error('UNSPLASH_ACCESS_KEY is not configured');
    }

    const { orientation, count = 1 } = options;

    const params = new URLSearchParams({
        count: String(Math.min(count, 30)),
    });

    if (query) {
        params.append('query', query);
    }

    if (orientation) {
        params.append('orientation', orientation);
    }

    const url = `${UNSPLASH_API_BASE}/photos/random?${params.toString()}`;

    try {
        const response = await getFetch()(url, {
            headers: {
                'Authorization': `Client-ID ${accessKey}`,
                'Accept-Version': 'v1',
            },
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
                `Unsplash API error: ${response.status} ${response.statusText}` +
                (errorData.errors ? ` - ${errorData.errors.join(', ')}` : '')
            );
        }

        const data = await response.json();

        // API returns an array when count > 1, single object when count = 1
        if (Array.isArray(data)) {
            return data.map(normalizeImage);
        }

        return normalizeImage(data);
    } catch (err) {
        console.error('[Unsplash] Random image error:', err.message);
        throw err;
    }
}

/**
 * Normalize Unsplash image data to a consistent format.
 *
 * @param {Object} image - Raw Unsplash image object.
 * @returns {Object} Normalized image object.
 */
function normalizeImage(image) {
    return {
        id: image.id,
        description: image.description,
        altDescription: image.alt_description,
        urls: {
            raw: image.urls.raw,
            full: image.urls.full,
            regular: image.urls.regular,
            small: image.urls.small,
            thumb: image.urls.thumb,
        },
        links: {
            html: image.links.html,
            download: image.links.download,
            downloadLocation: image.links.download_location,
        },
        author: image.user ? {
            id: image.user.id,
            name: image.user.name,
            username: image.user.username,
            portfolioUrl: image.user.portfolio_url,
            profileImage: image.user.profile_image?.small,
            link: image.user.links?.html,
        } : null,
        // Keep raw-style compatibility for clients that still expect Unsplash's user shape.
        user: image.user ? {
            id: image.user.id,
            name: image.user.name,
            username: image.user.username,
            portfolio_url: image.user.portfolio_url,
            profile_image: image.user.profile_image,
            links: image.user.links,
        } : null,
        width: image.width,
        height: image.height,
        color: image.color,
        likes: image.likes,
        createdAt: image.created_at,
        updatedAt: image.updated_at,
    };
}

module.exports = {
    isConfigured,
    searchImages,
    getRandomImage,
    getFetch,
};

