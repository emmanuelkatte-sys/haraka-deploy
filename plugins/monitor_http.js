// monitor_http.js [v77] - async I/O, limits error.log read to last 4KB
// v76: async I/O rewrite
// v77: prefer counter_total.txt (cumulative, never resets) over counter.txt.
//      This lets the dashboard show a forever-growing Delivered count.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const COUNTER_TOTAL_FILE = '/root/haraka/plugins/data/counter_total.txt';
const COUNTER_FILE = '/root/haraka/plugins/data/counter.txt';
const QUEUE_DIR = '/root/haraka/queue';
const DKIM_INI = '/root/haraka/config/dkim.ini';
const ERROR_LOG = '/root/haraka/logs/error.log';
const ERROR_LOG_TAIL_BYTES = 4096;

// Read the cumulative counter. Prefer counter_total.txt (never resets).
// Falls back to counter.txt for safety during the very first moments after
// deployment when counter_total.txt does not yet exist.
async function readCounter() {
    try {
        const content = await fsp.readFile(COUNTER_TOTAL_FILE, 'utf8');
        const n = parseInt(content, 10);
        if (!isNaN(n)) return n;
    } catch (e) {
        // fall through to fallback
    }
    try {
        const content = await fsp.readFile(COUNTER_FILE, 'utf8');
        const n = parseInt(content, 10);
        if (!isNaN(n)) return n;
    } catch (e) {
        // ignore
    }
    return 0;
}

async function countQueue() {
    try {
        const files = await fsp.readdir(QUEUE_DIR);
        return files.length;
    } catch (e) {
        return 0;
    }
}

async function readDkimInfo() {
    try {
        const content = await fsp.readFile(DKIM_INI, 'utf8');
        let selector = '';
        let domain = '';
        for (const line of content.split('\n')) {
            if (line.startsWith('selector=')) selector = line.split('=')[1].trim();
            if (line.startsWith('domain=')) domain = line.split('=')[1].trim();
        }
        if (selector && domain) return selector + '._domainkey.' + domain;
        return 'N/A';
    } catch (e) {
        return 'N/A';
    }
}

async function readLastErrors() {
    // Only read the last 4KB of error.log to avoid blocking on huge files
    let fh = null;
    try {
        const stat = await fsp.stat(ERROR_LOG);
        if (!stat || stat.size === 0) return '';
        const start = Math.max(0, stat.size - ERROR_LOG_TAIL_BYTES);
        const length = stat.size - start;
        fh = await fsp.open(ERROR_LOG, 'r');
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, start);
        const text = buf.toString('utf8');
        // Keep last 20 non-empty lines
        const lines = text.split('\n').filter(function (l) { return l.trim(); });
        return lines.slice(-20).join('\n');
    } catch (e) {
        return '';
    } finally {
        if (fh) {
            try { await fh.close(); } catch (e) {}
        }
    }
}

function getServerIP() {
    try {
        const ifaces = os.networkInterfaces();
        for (const name of Object.keys(ifaces)) {
            for (const info of ifaces[name]) {
                if (!info.internal && (info.family === 'IPv4' || info.family === 4)) {
                    return info.address;
                }
            }
        }
    } catch (e) {}
    return 'Unknown';
}

function escapeHtml(s) {
    if (typeof s !== 'string') return '';
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function buildHtml(data) {
    const uptime = os.uptime();
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const queueClass = data.queueCount > 100 ? 'warn' : 'ok';
    const errorsHtml = data.recentErrors ? escapeHtml(data.recentErrors) : 'None';
    return '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
        '<title>Haraka SMTP Monitor</title>' +
        '<meta http-equiv="refresh" content="30">' +
        '<style>body{font-family:monospace;background:#1a1a2e;color:#e0e0e0;max-width:900px;margin:0 auto;padding:20px}' +
        'h1{color:#00d4ff;border-bottom:2px solid #00d4ff;padding-bottom:10px}' +
        '.card{background:#16213e;border-radius:8px;padding:15px;margin:10px 0;border-left:4px solid #00d4ff}' +
        '.label{color:#7f8c8d;font-size:0.9em}' +
        '.value{color:#2ecc71;font-size:1.2em;font-weight:bold}' +
        '.error-log{background:#0f3460;padding:10px;border-radius:4px;max-height:300px;overflow-y:auto;font-size:0.8em;white-space:pre-wrap}' +
        '.ok{color:#2ecc71}.warn{color:#f39c12}</style></head><body>' +
        '<h1>Haraka SMTP Monitor</h1>' +
        '<div class="card"><span class="label">Server IP:</span> <span class="value">' + escapeHtml(data.serverIP) + '</span></div>' +
        '<div class="card"><span class="label">Uptime:</span> <span class="value">' + days + 'd ' + hours + 'h ' + mins + 'm</span></div>' +
        '<div class="card"><span class="label">Delivered:</span> <span class="value">' + data.totalSent.toLocaleString() + '</span></div>' +
        '<div class="card"><span class="label">Queue:</span> <span class="value ' + queueClass + '">' + data.queueCount + '</span></div>' +
        '<div class="card"><span class="label">DKIM:</span> <span class="value">' + escapeHtml(data.dkimInfo) + '</span></div>' +
        '<div class="card"><span class="label">Recent Errors:</span><div class="error-log">' + errorsHtml + '</div></div>' +
        '<p style="color:#555;font-size:0.8em;text-align:center">Auto-refresh: 30s | Haraka SMTP Monitor by @MaiDong</p>' +
        '</body></html>';
}

exports.register = function () {
    const plugin = this;
    plugin.loginfo('Monitor HTTP plugin [v77] loaded');
    const port = 49800;

    const server = http.createServer(async function (req, res) {
        try {
            // Read 4 sources in parallel, each with its own error handling
            const results = await Promise.all([
                readCounter(),
                countQueue(),
                readDkimInfo(),
                readLastErrors()
            ]);
            const html = buildHtml({
                serverIP: getServerIP(),
                totalSent: results[0],
                queueCount: results[1],
                dkimInfo: results[2],
                recentErrors: results[3]
            });
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } catch (e) {
            try {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Error');
            } catch (e2) {}
        }
    });

    server.listen(port, '0.0.0.0', function () {
        plugin.loginfo('Monitor on port ' + port);
    });
    server.on('error', function (err) {
        plugin.logwarn('Monitor error: ' + err.message);
    });
};