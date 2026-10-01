/**
 * Haraka Local Sink & Blackhole Plugin for Null Bounces & Unsubscribes
 * Quietly consumes null sender bounces and List-Unsubscribe emails without loops.
 */
var constants = require('haraka-constants');
var fs = require('fs');
var path = require('path');

var unsubscribePrefix = 'unsubscribe';
var responseText = '250 Message accepted';

var POSSIBLE_LOG_DIRS = ['/root/haraka/logs', '/usr/local/haraka_env/logs', '/var/log/haraka'];
function getLogDir() {
    for (var i = 0; i < POSSIBLE_LOG_DIRS.length; i++) {
        try {
            if (fs.existsSync(POSSIBLE_LOG_DIRS[i])) return POSSIBLE_LOG_DIRS[i];
        } catch(e) {}
    }
    return POSSIBLE_LOG_DIRS[0];
}

function tx(connection) {
    return connection && connection.transaction ? connection.transaction : null;
}

function localPart(address) {
    if (!address) return '';
    if (typeof address === 'string') {
        var clean = address.replace(/^<|>$/g, '').trim().toLowerCase();
        var at = clean.lastIndexOf('@');
        return at >= 0 ? clean.substring(0, at) : clean;
    }
    return String(address.user || '').trim().toLowerCase();
}

function addressText(address) {
    if (!address) return '';
    if (typeof address === 'string') return address.replace(/^<|>$/g, '').trim().toLowerCase();
    if (address.address && typeof address.address === 'function') {
        try { return String(address.address() || '').trim().toLowerCase(); } catch(e) {}
    }
    return String(address.user || '') + (address.host ? '@' + address.host : '');
}

function isUnsubscribeAddress(address) {
    var user = localPart(address);
    return user === unsubscribePrefix ||
        user.indexOf(unsubscribePrefix + '+') === 0 ||
        user.indexOf(unsubscribePrefix + '-') === 0 ||
        user.indexOf(unsubscribePrefix + '.') === 0;
}

function recordMailUnsub(rcptAddr, mailFrom) {
    try {
        var logDir = getLogDir();
        var csvFile = path.join(logDir, 'unsubscribed.csv');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        if (!fs.existsSync(csvFile)) {
            fs.writeFileSync(csvFile, 'TimeISO,Email,IP,Method,UserAgent\n', 'utf8');
        }
        var targetEmail = mailFrom || rcptAddr;
        if (targetEmail) {
            var line = '"' + new Date().toISOString() + '","' + targetEmail.replace(/"/g, '""') + '","127.0.0.1","MAIL_SINK","Haraka Local Sink"\n';
            fs.appendFileSync(csvFile, line, 'utf8');
        }
    } catch(e) {}
}

exports.hook_rcpt = function(next, connection, params) {
    var rcpt = params && params[0];
    if (isUnsubscribeAddress(rcpt)) {
        var transaction = tx(connection);
        var mailFrom = transaction && transaction.mail_from ? addressText(transaction.mail_from) : '';
        recordMailUnsub(addressText(rcpt), mailFrom);
        if (transaction) {
            transaction.discard_data = true;
            if (!transaction.notes) transaction.notes = {};
            transaction.notes.local_sink = { reason: 'unsubscribe', detail: addressText(rcpt) };
        }
        connection.loginfo(this, 'Local sink accepted unsubscribe request for ' + addressText(rcpt));
        return next(constants.ok);
    }
    return next();
};

exports.hook_data = function(next, connection) {
    var transaction = tx(connection);
    if (transaction && transaction.notes && transaction.notes.local_sink) {
        transaction.discard_data = true;
    }
    return next();
};

function queueLocalSink(next, connection) {
    var transaction = tx(connection);
    if (transaction && transaction.notes && transaction.notes.local_sink) {
        connection.lognotice(this, 'Local sink completed: ' + transaction.notes.local_sink.reason);
        return next(constants.ok, responseText);
    }
    return next();
}

exports.hook_queue = queueLocalSink;
exports.hook_queue_outbound = queueLocalSink;
