const crypto = require('crypto');
const QRCode = require('qrcode');
const { config } = require('../config');
const { postgres } = require('../postgres');
const {
    isAuthorizedOpenCodeGatewayRequest,
    resolveOpenCodeGatewayApiKey,
} = require('../opencode/gateway');

function base64UrlEncode(input) {
    return Buffer.from(input)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function base64UrlDecode(input) {
    const normalized = String(input || '')
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    const padded = normalized + '==='.slice((normalized.length + 3) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
}

function signJwt(payload, secret) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signature = crypto
        .createHmac('sha256', secret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

    return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyJwt(token, secret) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) {
        throw new Error('Invalid token format');
    }

    const [encodedHeader, encodedPayload, signature] = parts;
    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest();
    const providedSignature = Buffer.from(
        signature.replace(/-/g, '+').replace(/_/g, '/').padEnd(signature.length + ((4 - signature.length % 4) % 4), '='),
        'base64',
    );

    if (
        providedSignature.length !== expectedSignature.length
        || !crypto.timingSafeEqual(providedSignature, expectedSignature)
    ) {
        throw new Error('Invalid token signature');
    }

    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (payload.exp && Date.now() >= payload.exp * 1000) {
        throw new Error('Token expired');
    }

    return payload;
}

function parseCookies(cookieHeader = '') {
    return String(cookieHeader || '')
        .split(';')
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .reduce((acc, chunk) => {
            const separator = chunk.indexOf('=');
            if (separator === -1) {
                return acc;
            }
            const key = decodeURIComponent(chunk.slice(0, separator).trim());
            const value = decodeURIComponent(chunk.slice(separator + 1).trim());
            acc[key] = value;
            return acc;
        }, {});
}

function getRequestPath(req = {}) {
    const candidates = [
        req.originalUrl,
        req.baseUrl && req.path ? `${req.baseUrl}${req.path}` : '',
        req.url,
        req.path,
    ];

    for (const candidate of candidates) {
        const routePath = String(candidate || '').trim();
        if (!routePath) {
            continue;
        }

        try {
            return new URL(routePath, 'http://localhost').pathname;
        } catch (_error) {
            const pathname = routePath.split(/[?#]/, 1)[0];
            if (pathname.startsWith('/')) {
                return pathname;
            }
        }
    }

    return '';
}

function extractPreviewRouteToken(routePath = '') {
    const normalizedPath = String(routePath || '').trim();
    const match = normalizedPath.match(/^\/api\/(?:artifacts|sandbox-workspaces)\/[^/]+\/(?:sandbox-access|preview-access)\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : '';
}

function isPreviewQueryTokenRoute(req = {}) {
    const routePath = getRequestPath(req);
    if (/^\/api\/(?:artifacts|sandbox-workspaces)\/[^/]+\/(?:sandbox|preview)(?:\/|$)/.test(routePath)) {
        return true;
    }

    if (!/^\/api\/artifacts\/[^/]+\/download$/.test(routePath)) {
        return false;
    }

    try {
        const parsedUrl = new URL(String(req.url || routePath), 'http://localhost');
        return ['1', 'true', 'yes'].includes(String(parsedUrl.searchParams.get('inline') || '').toLowerCase());
    } catch (_error) {
        return false;
    }
}

function serializeCookie(name, value, options = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`];

    if (options.maxAge != null) {
        parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
    }
    if (options.path) {
        parts.push(`Path=${options.path}`);
    }
    if (options.httpOnly) {
        parts.push('HttpOnly');
    }
    if (options.sameSite) {
        parts.push(`SameSite=${options.sameSite}`);
    }
    if (options.secure) {
        parts.push('Secure');
    }

    return parts.join('; ');
}

function isAuthEnabled() {
    return Boolean(
        config.auth.username
        && config.auth.password
        && config.auth.jwtSecret,
    );
}

function safeEqualString(left, right) {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

const MFA_SETTING_PREFIX = 'auth.mfa.';
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const mfaChallenges = new Map();

function base32Encode(buffer) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += alphabet[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
    return output;
}

function base32Decode(input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const character of String(input || '').toUpperCase().replace(/=|\s/g, '')) {
        const index = alphabet.indexOf(character);
        if (index === -1) throw new Error('Invalid TOTP secret');
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function encryptMfaSecret(secret) {
    const key = crypto.createHash('sha256').update(config.auth.jwtSecret).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((value) => value.toString('base64url')).join('.');
}

function decryptMfaSecret(encrypted) {
    const [iv, tag, ciphertext] = String(encrypted || '').split('.').map((value) => Buffer.from(value, 'base64url'));
    if (!iv || !tag || !ciphertext) throw new Error('Invalid encrypted MFA secret');
    const key = crypto.createHash('sha256').update(config.auth.jwtSecret).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function generateTotp(secret, timestamp = Date.now()) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30000)));
    const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
    const offset = digest[digest.length - 1] & 15;
    const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    return String(value).padStart(6, '0');
}

function verifyTotp(secret, code, timestamp = Date.now()) {
    const normalized = String(code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(normalized)) return false;
    return [-1, 0, 1].some((window) => safeEqualString(generateTotp(secret, timestamp + (window * 30000)), normalized));
}

async function getMfaRecord(username) {
    const result = await postgres.query('SELECT value FROM app_settings WHERE key = $1', [`${MFA_SETTING_PREFIX}${username}`]);
    return result.rows[0]?.value || null;
}

async function saveMfaRecord(username, record) {
    await postgres.query(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [`${MFA_SETTING_PREFIX}${username}`, JSON.stringify(record)]);
}

async function beginMfaChallenge(username) {
    let record = await getMfaRecord(username);
    let secret;
    let enrollmentRequired = !record?.enrolled;
    if (!record?.secret) {
        secret = base32Encode(crypto.randomBytes(20));
        record = { enrolled: false, secret: encryptMfaSecret(secret) };
        await saveMfaRecord(username, record);
        enrollmentRequired = true;
    } else {
        secret = decryptMfaSecret(record.secret);
    }

    const challengeId = crypto.randomBytes(32).toString('base64url');
    mfaChallenges.set(challengeId, { username, expiresAt: Date.now() + MFA_CHALLENGE_TTL_MS });
    const response = { challengeId, enrollmentRequired };
    if (enrollmentRequired) {
        const issuer = String(config.auth.totpIssuer || 'KimiBuilt').trim();
        const label = `${issuer}:${username}`;
        const uri = `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
        response.qrCodeDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2, width: 240 });
        response.manualKey = secret;
    }
    return response;
}

async function completeMfaChallenge(challengeId, code) {
    const challenge = mfaChallenges.get(String(challengeId || ''));
    mfaChallenges.delete(String(challengeId || ''));
    if (!challenge || challenge.expiresAt < Date.now()) return null;
    const record = await getMfaRecord(challenge.username);
    if (!record?.secret || !verifyTotp(decryptMfaSecret(record.secret), code)) return null;
    if (!record.enrolled) await saveMfaRecord(challenge.username, { ...record, enrolled: true });
    return { username: challenge.username };
}

function getSafeReturnTo(value = '/') {
    const normalized = String(value || '/').trim();
    if (!normalized.startsWith('/') || normalized.startsWith('//') || normalized.startsWith('/login')) {
        return '/';
    }
    return normalized;
}

function createAuthToken(username) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + config.auth.tokenTtlSeconds;

    return {
        token: signJwt({
            sub: username,
            role: 'admin',
            iat: issuedAt,
            exp: expiresAt,
        }, config.auth.jwtSecret),
        expiresAt,
    };
}

function getQueryTokenFromRequest(req, options = {}) {
    try {
        const parsedUrl = new URL(String(req.url || ''), 'http://localhost');
        const parameterNames = options.parameterNames || ['access_token', 'api_key', 'token'];
        for (const parameterName of parameterNames) {
            const queryToken = parsedUrl.searchParams.get(parameterName);
            if (queryToken) {
                return String(queryToken).trim();
            }
        }
    } catch (_error) {
        // Ignore malformed request URLs and continue as unauthenticated.
    }

    return '';
}

function getTokenFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    const cookieToken = cookies[config.auth.cookieName];
    if (cookieToken) {
        return cookieToken;
    }

    const authHeader = req.headers.authorization || '';
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        return authHeader.slice(7).trim();
    }

    const apiKeyHeader = req.headers['x-api-key'];
    const apiKey = Array.isArray(apiKeyHeader)
        ? apiKeyHeader.find(Boolean)
        : apiKeyHeader;
    if (apiKey) {
        return String(apiKey).trim();
    }

    const pathToken = extractPreviewRouteToken(getRequestPath(req));
    if (pathToken) {
        return pathToken;
    }

    if (config.security.allowQueryTokens || isPreviewQueryTokenRoute(req)) {
        return getQueryTokenFromRequest(req);
    }

    if (getRequestPath(req) === '/ws') {
        return getQueryTokenFromRequest(req, { parameterNames: ['access_token'] });
    }

    return '';
}

function resolveFrontendApiKey() {
    const explicit = String(
        process.env.KIMIBUILT_FRONTEND_API_KEY
        || process.env.FRONTEND_API_KEY
        || '',
    ).trim();

    if (explicit) {
        return explicit;
    }

    return resolveOpenCodeGatewayApiKey();
}

function resolveFrontendApiUsername() {
    return 'frontend-api';
}

function isOpenAICompatRoutePath(routePath = '') {
    return routePath === '/v1'
        || routePath.startsWith('/v1/')
        || routePath === '/openai/v1'
        || routePath.startsWith('/openai/v1/');
}

function isFrontendTokenRoute(req) {
    const routePath = getRequestPath(req);
    if (!routePath) {
        return false;
    }

    if (routePath === '/ws' || routePath.startsWith('/ws/')) {
        return true;
    }

    if (isOpenAICompatRoutePath(routePath)) {
        return true;
    }

    if (routePath.startsWith('/api/admin/')) {
        return routePath.startsWith('/api/admin/provider-')
            || routePath.startsWith('/api/admin/remote-agent-');
    }

    if (routePath.startsWith('/admin/')) {
        return routePath.startsWith('/admin/provider-')
            || routePath.startsWith('/admin/remote-agent-');
    }

    return routePath.startsWith('/api/');
}

function isAuthorizedFrontendApiRequest(req = {}) {
    if (!isFrontendTokenRoute(req)) {
        return false;
    }

    const expected = resolveFrontendApiKey();
    const provided = getTokenFromRequest(req);
    if (!expected || !provided) {
        return false;
    }

    return safeEqualString(provided, expected);
}

function getAuthenticatedUser(req) {
    if (!isAuthEnabled()) {
        return { authenticated: true, user: { username: 'anonymous', role: 'open' } };
    }

    const token = getTokenFromRequest(req);
    if (!token) {
        return { authenticated: false, reason: 'missing_token' };
    }

    try {
        const payload = verifyJwt(token, config.auth.jwtSecret);
        return {
            authenticated: true,
            user: {
                username: payload.sub,
                role: payload.role || 'admin',
                exp: payload.exp,
            },
        };
    } catch (error) {
        return { authenticated: false, reason: error.message };
    }
}

function getAuthCookieOptions(req) {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const secure = config.nodeEnv === 'production' || forwardedProto === 'https' || req.secure;

    return {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure,
        maxAge: config.auth.tokenTtlSeconds,
    };
}

function setAuthCookie(res, token, req) {
    res.setHeader('Set-Cookie', serializeCookie(config.auth.cookieName, token, getAuthCookieOptions(req)));
}

function clearAuthCookie(res, req) {
    res.setHeader('Set-Cookie', serializeCookie(config.auth.cookieName, '', {
        ...getAuthCookieOptions(req),
        maxAge: 0,
    }));
}

function isApiRequest(req) {
    const routePath = getRequestPath(req);
    return routePath.startsWith('/api/') || isOpenAICompatRoutePath(routePath) || routePath === '/ws';
}

function requireAuth(req, res, next) {
    if (!isAuthEnabled()) {
        req.user = { username: 'anonymous', role: 'open' };
        return next();
    }

    const authState = getAuthenticatedUser(req);
    if (authState.authenticated) {
        req.user = authState.user;
        return next();
    }

    if (isOpenAICompatRoutePath(getRequestPath(req)) && isAuthorizedOpenCodeGatewayRequest(req)) {
        req.user = { username: 'opencode', role: 'internal-gateway' };
        return next();
    }

    if (isAuthorizedFrontendApiRequest(req)) {
        req.user = { username: resolveFrontendApiUsername(), role: 'frontend-api' };
        return next();
    }

    const isBrowserNavigation = (req.method === 'GET' || req.method === 'HEAD') && !isApiRequest(req) && !req.xhr;

    if (!isBrowserNavigation) {
        return res.status(401).json({
            error: {
                message: 'Authentication required',
                code: authState.reason || 'unauthorized',
            },
        });
    }

    const returnTo = encodeURIComponent(getSafeReturnTo(req.originalUrl || req.url || '/'));
    return res.redirect(`/login?returnTo=${returnTo}`);
}

module.exports = {
    beginMfaChallenge,
    clearAuthCookie,
    createAuthToken,
    completeMfaChallenge,
    getAuthenticatedUser,
    generateTotp,
    getSafeReturnTo,
    isAuthorizedFrontendApiRequest,
    isAuthEnabled,
    parseCookies,
    requireAuth,
    resolveFrontendApiUsername,
    resolveFrontendApiKey,
    safeEqualString,
    setAuthCookie,
    verifyTotp,
};
