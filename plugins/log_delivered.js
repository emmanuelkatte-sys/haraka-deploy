// log_delivered.js - Haraka Local Delivered Logger (Safe clean edition - Telegram disabled)
// Maintains local delivery counters for monitor_http dashboard. Zero external network calls.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const dataDir = '/root/haraka/plugins/data';
const counterFile = path.join(dataDir, 'counter.txt');
const counterTotalFile = path.join(dataDir, 'counter_total.txt');
const SKIP_TG_HEADER = 'X-Internal-CcBcc-Skip-Tg';
const FLUSH_INTERVAL_MS = 5000;

let memCounter = 0;
let memCounterTotal = 0;
let isFlushInProgress = false;
let flushTimer = null;

// Startup initialization
try {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    if (fs.existsSync(counterFile)) {
        const raw = fs.readFileSync(counterFile, 'utf8');
        memCounter = parseInt(raw, 10) || 0;
    }
    if (fs.existsSync(counterTotalFile)) {
        const rawTotal = fs.readFileSync(counterTotalFile, 'utf8');
        memCounterTotal = parseInt(rawTotal, 10) || 0;
    }
} catch (e) {}

async function flushToDisk() {
    if (isFlushInProgress) return;
    isFlushInProgress = true;
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    const snapTotal = memCounterTotal;
    const snapCounter = memCounter;
    try {
        await fsp.writeFile(counterTotalFile, String(snapTotal));
        await fsp.writeFile(counterFile, String(snapCounter));
    } catch (e) {
    } finally {
        isFlushInProgress = false;
    }
}

function scheduleFlush() {
    if (flushTimer || isFlushInProgress) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushToDisk().catch(() => {});
    }, FLUSH_INTERVAL_MS);
    if (flushTimer && typeof flushTimer.unref === 'function') {
        flushTimer.unref();
    }
}

if (!process.__logdelivered_clean_registered__) {
    process.__logdelivered_clean_registered__ = true;
    process.on('exit', () => {
        try {
            fs.writeFileSync(counterTotalFile, String(memCounterTotal));
            fs.writeFileSync(counterFile, String(memCounter));
        } catch (e) {}
    });
    process.on('SIGTERM', () => { flushToDisk().catch(() => {}); });
    process.on('SIGINT', () => { flushToDisk().catch(() => {}); });
}

// Strip internal CC/BCC marker header from outgoing mail
exports.hook_data_post = function (next, connection) {
    try {
        const txn = connection && connection.transaction;
        if (txn && txn.header) {
            txn.remove_header(SKIP_TG_HEADER);
            txn.remove_header('x-internal-ccbcc-skip-tg');
        }
    } catch (e) {}
    next();
};

// Increment local counters on delivery
exports.hook_delivered = function (next, hmail) {
    try {
        memCounterTotal++;
        memCounter++;
        if (memCounterTotal % 100 === 0) {
            flushToDisk().catch(() => {});
        } else {
            scheduleFlush();
        }
    } catch (err) {}
    next();
};
