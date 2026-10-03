/**
 * Haraka Metadata Normalization & List-Unsubscribe Body Injection Plugin
 * Handles RFC 2369 / RFC 8058 headers and polite Japanese HTML footnote injection.
 */
var crypto = require('crypto');

function formatRfc2822Date(d) {
    if (!d) d = new Date();
    var jstMs = d.getTime() + (9 * 60 * 60 * 1000);
    var jstDate = new Date(jstMs);

    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var pad = function(n) { return (n < 10 ? '0' : '') + n; };

    return days[jstDate.getUTCDay()] + ', ' +
           pad(jstDate.getUTCDate()) + ' ' +
           months[jstDate.getUTCMonth()] + ' ' +
           jstDate.getUTCFullYear() + ' ' +
           pad(jstDate.getUTCHours()) + ':' +
           pad(jstDate.getUTCMinutes()) + ':' +
           pad(jstDate.getUTCSeconds()) + ' +0900';
}

function getAddressString(addr) {
    if (!addr) return '';
    if (typeof addr === 'string') return addr;
    if (typeof addr.address === 'string' && addr.address) return addr.address;
    if (typeof addr.address === 'function') {
        try {
            var res = addr.address();
            if (typeof res === 'string' && res) return res;
        } catch(e) {}
    }
    if (addr.user && addr.host) return addr.user + '@' + addr.host;
    return String(addr || '');
}

function extractDomain(addr, fallback) {
    if (!addr) return fallback || 'example.com';
    var str = String(addr).trim();
    var atIdx = str.lastIndexOf('@');
    if (atIdx >= 0) {
        var dom = str.substring(atIdx + 1).replace(/[>\s;,]/g, '').trim().toLowerCase();
        if (dom && dom.indexOf('.') > 0) return dom;
    }
    return fallback || 'example.com';
}

function setupBodyUnsubscribe(next, connection) {
    try {
        if (!connection || !connection.transaction) return next();
        var tx = connection.transaction;

        tx.parse_body = true;
        tx.add_body_filter('text/html', function(ct, enc, buf, cd) {
            if (!buf || !ct) return buf;
            var ctLower = String(ct).toLowerCase();
            if (ctLower.indexOf('text/html') === -1) return buf;
            if (cd && String(cd).toLowerCase().indexOf('attachment') >= 0) return buf;

            var fromHdr = '';
            try {
                fromHdr = tx.header ? (tx.header.get('From') || '') : '';
            } catch(e) {}
            var mailFrom = getAddressString(tx.mail_from);
            var domain = extractDomain(fromHdr, extractDomain(mailFrom, 'localhost'));

            var rcptAddr = '';
            if (tx.rcpt_to && tx.rcpt_to.length > 0) {
                rcptAddr = getAddressString(tx.rcpt_to[0]);
            }
            if (!rcptAddr && tx.header) {
                try {
                    var toHdr = tx.header.get('To') || '';
                    var mTo = toHdr.match(/<([^>]+)>/) || toHdr.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
                    if (mTo) rcptAddr = mTo[1];
                } catch(e) {}
            }

            var queryParam = rcptAddr ? ('?addr=' + encodeURIComponent(rcptAddr)) : '';
            var httpUri = 'http://' + domain + '/unsubscribe' + queryParam;

            var htmlBanner = '<div style="margin-top: 25px; padding-top: 15px; border-top: 1px dashed #d0d7de; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Meiryo, sans-serif; font-size: 12px; color: #57606a; line-height: 1.6;">' +
                '<p style="margin: 0 0 6px 0;">■ 本メールの配信停止をご希望の場合は、以下のリンクよりお手続きをお願いいたします。</p>' +
                '<p style="margin: 0;"><a href="' + httpUri + '" target="_blank" style="color: #0969da; text-decoration: underline;">配信停止の手続きはこちら</a></p>' +
                '</div>';

            var htmlStr = '';
            try {
                htmlStr = buf.toString('utf8');
            } catch(e) {
                return buf;
            }

            // Check if already injected
            if (htmlStr.indexOf('/unsubscribe') >= 0 || htmlStr.indexOf('配信停止') >= 0) {
                return buf;
            }

            var lower = htmlStr.toLowerCase();
            var insertPos = lower.lastIndexOf('</body>');
            if (insertPos === -1) {
                insertPos = lower.lastIndexOf('</html>');
            }

            if (insertPos !== -1) {
                var newHtml = htmlStr.substring(0, insertPos) + htmlBanner + htmlStr.substring(insertPos);
                return Buffer.from(newHtml, 'utf8');
            } else {
                return Buffer.concat([buf, Buffer.from('\r\n'), Buffer.from(htmlBanner, 'utf8')]);
            }
        });
    } catch(err) {
        if (connection && typeof connection.logerror === 'function') {
            connection.logerror('artifact_force body unsub error: ' + err.message);
        }
    }
    next();
}

function normalizeMetadata(next, connection) {
    try {
        if (!connection || !connection.transaction) return next();
        var tx = connection.transaction;

        var mailFrom = getAddressString(tx.mail_from);
        var fromHdr = '';
        try {
            fromHdr = tx.header ? (tx.header.get('From') || '') : '';
        } catch(e) {}
        var domain = extractDomain(fromHdr, extractDomain(mailFrom, 'localhost'));

        // Normalise RFC 5322 Date with JST timezone only if missing
        var hasDate = false;
        try {
            hasDate = !!(tx.header && tx.header.get('Date'));
        } catch(e) {}
        if (!hasDate) {
            var rfcDate = formatRfc2822Date(new Date());
            tx.add_leading_header('Date', rfcDate);
        }

        // Inject RFC 2369 & RFC 8058 headers only if not already provided
        var hasUnsub = false;
        try {
            hasUnsub = !!(tx.header && tx.header.get('List-Unsubscribe'));
        } catch(e) {}
        if (!hasUnsub) {
            var rcptAddr = '';
            if (tx.rcpt_to && tx.rcpt_to.length > 0) {
                rcptAddr = getAddressString(tx.rcpt_to[0]);
            }
            if (!rcptAddr && tx.header) {
                try {
                    var toHdr = tx.header.get('To') || '';
                    var m = toHdr.match(/<([^>]+)>/) || toHdr.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
                    if (m) rcptAddr = m[1];
                } catch(e) {}
            }
            var mailtoUri = 'mailto:unsubscribe@' + domain;
            var queryParam = rcptAddr ? ('?addr=' + encodeURIComponent(rcptAddr)) : '';
            var httpUri = 'http://' + domain + '/unsubscribe' + queryParam;

            tx.add_header('List-Unsubscribe', '<' + mailtoUri + '>, <' + httpUri + '>');
            tx.add_header('List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');
        }
    } catch(err) {
        if (connection && typeof connection.logerror === 'function') {
            connection.logerror('artifact_force normalizeMetadata error: ' + err.message);
        }
    }
    next();
}

exports.hook_data = setupBodyUnsubscribe;
exports.hook_data_post = normalizeMetadata;
