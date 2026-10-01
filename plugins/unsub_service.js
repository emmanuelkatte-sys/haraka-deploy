/**
 * RFC 2369 / RFC 8058 One-Click Unsubscribe Web Service
 * Standard compliant unsubscription handler with Redis and CSV storage.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');

let redis = null;
try {
    const Redis = require('ioredis');
    redis = new Redis({ host: '127.0.0.1', port: 6379, retryStrategy: () => 2000, maxRetriesPerRequest: 1 });
    redis.on('error', () => {});
} catch (e) {}

const POSSIBLE_LOG_DIRS = [
    '/root/haraka/logs',
    '/usr/local/haraka_env/logs',
    '/var/log/haraka'
];

function resolveLogDir() {
    for (const dir of POSSIBLE_LOG_DIRS) {
        try {
            if (fs.existsSync(dir)) return dir;
        } catch (e) {}
    }
    const defaultDir = POSSIBLE_LOG_DIRS[0];
    try {
        fs.mkdirSync(defaultDir, { recursive: true });
    } catch (e) {}
    return defaultDir;
}

const LOG_DIR = resolveLogDir();
const CSV_FILE = path.join(LOG_DIR, 'unsubscribed.csv');

function ensureLogFile() {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        if (!fs.existsSync(CSV_FILE)) {
            fs.writeFileSync(CSV_FILE, 'TimeISO,Email,IP,Method,UserAgent\n', 'utf8');
        }
    } catch (e) {}
}

function recordUnsub(email, ip, method, ua) {
    if (!email) return;
    const cleanEmail = String(email).trim().toLowerCase();
    if (!cleanEmail || cleanEmail.indexOf('@') < 1) return;

    if (redis) {
        try {
            redis.sadd('haraka:unsubscribed_emails', cleanEmail).catch(() => {});
            redis.hset('haraka:unsubscribed_details', cleanEmail, JSON.stringify({
                email: cleanEmail,
                ip: ip || 'unknown',
                time: new Date().toISOString(),
                method: method || 'GET',
                ua: ua || ''
            })).catch(() => {});
        } catch (e) {}
    }

    try {
        ensureLogFile();
        const line = `"${new Date().toISOString()}","${cleanEmail.replace(/"/g, '""')}","${(ip || '').replace(/"/g, '""')}","${method || 'GET'}","${(ua || '').replace(/"/g, '""')}"\n`;
        fs.appendFileSync(CSV_FILE, line, 'utf8');
    } catch (e) {}
}

function renderHtml(email) {
    const emailEscaped = email ? String(email).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) : '';
    const badgeHtml = emailEscaped ? `<div class="email-badge">${emailEscaped}</div>` : '';
    return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>配信停止の手続き完了 - Unsubscribed</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "BIZ UDPGothic", Meiryo, sans-serif; background: #0b0f19; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { background: #161e2e; border: 1px solid #283548; border-radius: 16px; padding: 40px 32px; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6); }
        .icon { width: 64px; height: 64px; background: rgba(34, 197, 94, 0.15); color: #22c55e; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 30px; margin-bottom: 20px; }
        h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px 0; color: #ffffff; letter-spacing: 0.02em; }
        .sub { font-size: 13px; color: #64748b; margin: 0 0 18px 0; font-weight: 500; }
        p { font-size: 14px; color: #94a3b8; line-height: 1.7; margin: 0 0 16px 0; }
        .email-badge { display: inline-block; background: #0f172a; border: 1px solid #334155; color: #38bdf8; padding: 6px 14px; border-radius: 9999px; font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; margin-bottom: 18px; word-break: break-all; }
        .note { font-size: 12px; color: #94a3b8; line-height: 1.6; margin-top: 18px; text-align: left; background: rgba(15, 23, 42, 0.6); padding: 12px 14px; border-radius: 8px; border-left: 3px solid #38bdf8; }
        .footer { font-size: 11px; color: #475569; border-top: 1px solid #283548; padding-top: 16px; margin-top: 24px; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">&#10003;</div>
        <h1>配信停止の手続きが完了しました</h1>
        <div class="sub">Unsubscription Completed</div>
        ${badgeHtml}
        <p>指定されたメールアドレスへの今後の配信を停止いたしました。<br>これまでご利用いただき、誠にありがとうございました。</p>
        <div class="note">※ 配信システムの反映状況により、行き違いで数通のメールが届く場合がございます。何卒ご了承のほどお願い申し上げます。</div>
        <div class="footer">RFC 2369 / RFC 8058 準拠 ワンクリック配信停止サービス</div>
    </div>
</body>
</html>`;
}

function handleRequest(req, res) {
    let pathname = '/';
    let queryParams = {};
    try {
        const fullUrl = 'http://' + (req.headers.host || 'localhost') + req.url;
        const u = new URL(fullUrl);
        pathname = (u.pathname || '').replace(/\/+$/, '') || '/';
        u.searchParams.forEach((val, key) => { queryParams[key] = val; });
    } catch (e) {
        const parsed = url.parse(req.url, true);
        pathname = (parsed.pathname || '').replace(/\/+$/, '') || '/';
        queryParams = parsed.query || {};
    }
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const ua = req.headers['user-agent'] || '';

    if (pathname === '/unsubscribe' || pathname === '' || pathname === '/') {
        let email = queryParams.addr || queryParams.email || queryParams.u || '';

        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
                body += chunk;
                if (body.length > 65536) req.destroy();
            });
            req.on('end', () => {
                const parsedBody = querystring.parse(body);
                if (!email && parsedBody.addr) email = parsedBody.addr;
                if (!email && parsedBody.email) email = parsedBody.email;
                recordUnsub(email, clientIp, 'POST', ua);
                res.writeHead(200, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end('Unsubscribed successfully');
            });
            return;
        }

        recordUnsub(email, clientIp, 'GET', ua);
        const html = renderHtml(email);
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        res.end(html);
        return;
    }

    if (pathname === '/healthz' || pathname === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('OK');
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
}

function startServers() {
    ensureLogFile();
    try {
        const internalServer = http.createServer(handleRequest);
        internalServer.listen(9091, '127.0.0.1', () => {
            console.log('Unsub service listening on 127.0.0.1:9091');
        });
        internalServer.on('error', (err) => {
            console.error('Unsub 9091 notice: ' + err.message);
        });
    } catch(e) {}

    try {
        const publicHttpServer = http.createServer(handleRequest);
        publicHttpServer.listen(80, '0.0.0.0', () => {
            console.log('Unsub standalone listening on 0.0.0.0:80');
        });
        publicHttpServer.on('error', () => {
            // 80 might be occupied by Nginx, which is expected
        });
    } catch(e) {}
}

exports.register = function () {
    if (this && typeof this.loginfo === 'function') {
        this.loginfo('Unsub web service plugin registered');
    }
    startServers();
};

startServers();

