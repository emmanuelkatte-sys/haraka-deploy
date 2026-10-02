/**
 * Haraka Advanced Received Header & Relay Topology Engine
 * Supports NTT Docomo, KDDI Telehouse, SoftBank Mailsv, AWS Tokyo VPC, and Japanese Commercial IDC.
 * Compliant with RFC 5321 and RFC 6409. Zero emoji policy.
 */
var crypto = require('crypto');
var dns = require('dns');

var _mailCounter = 0;
var _mxCache = {};

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
           pad(jstDate.getUTCSeconds()) + ' +0900 (JST)';
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

function strHash(str) {
    var h = 0;
    if (!str) return 12345;
    for (var i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h);
}

function getRndInt(min, max, seed) {
    if (seed !== undefined && seed !== null && !isNaN(seed)) {
        var x = Math.sin(Number(seed)) * 10000;
        var r = x - Math.floor(x);
        return Math.floor(r * (max - min + 1)) + min;
    }
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRootDomain(d, fallback) {
    if (!d) return fallback || 'example.com';
    var parts = d.toLowerCase().split('.');
    if (parts.length <= 2) return d;
    var sld = parts[parts.length - 2];
    if (parts.length >= 3 && ['co', 'ne', 'or', 'ac', 'go', 'com', 'net', 'org'].indexOf(sld) >= 0) {
        return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
}

function getRandomRelayHost(dom, style, seed, tpl) {
    var s = seed;
    var rootDom = getRootDomain(dom);
    var targetDom = (dom !== rootDom && getRndInt(0, 99, s) < 65) ? rootDom : dom;
    var st = (style || 'dynamic').toLowerCase();

    var prefixes = ['mailgw', 'relay', 'mta', 'smtp', 'gateway', 'outbound', 'mx-out', 'mail', 'dispatch', 'post'];
    if (st === 'japan_telecom' || tpl === 'carrier_docomo' || tpl === 'carrier_softbank' || tpl === 'carrier_kddi') {
        prefixes = ['sub-gw', 'edge-mta', 'telehouse-relay', 'gw-relay', 'mail-gw', 'core-mta', 'relay'];
    } else if (st === 'cloud_vpc' || tpl === 'aws_tokyo') {
        prefixes = ['app-relay', 'ingress-out', 'cluster-gw', 'node-mta', 'egress-proxy', 'outbound-gw'];
    } else if (st === 'bound_domain') {
        prefixes = ['relay', 'mta', 'mail', 'gw', 'smtp', 'out'];
    }

    var p = prefixes[getRndInt(0, prefixes.length - 1, s)];
    var n = getRndInt(1, 24, s ? s + 1 : null);
    var numStr = (n < 10 && getRndInt(0, 1, s ? s + 2 : null) === 0) ? ('0' + n) : String(n);
    var sep = (getRndInt(0, 2, s ? s + 3 : null) === 0) ? '-' : '';
    return p + sep + numStr + '.' + targetDom;
}

function getRandomInternalHost(dom, style, seed, tpl) {
    var s = seed;
    var rootDom = getRootDomain(dom);
    var st = (style || 'dynamic').toLowerCase();

    var roles = ['app-node', 'worker', 'core-worker', 'job-runner', 'batch-srv', 'dispatch', 'queue-worker', 'mail-backend', 'relay-node', 'agent', 'mail'];
    var role = roles[getRndInt(0, roles.length - 1, s)];
    var n = getRndInt(1, 32, s ? s + 4 : null);
    var numStr = (n < 10) ? ('0' + n) : String(n);
    var sep = (role.endsWith('-') || getRndInt(0, 1, s ? s + 5 : null) === 0) ? '' : '-';
    var hostPrefix = role + sep + numStr;

    var regions = ['tokyo', 'kanto', 'osaka', 'tyo', 'osa', 'jp-east', 'shinjuku', 'core', 'dc1', 'vpc'];
    var reg = regions[getRndInt(0, regions.length - 1, s ? s + 6 : null)];

    var suffixes = ['.internal', '.tokyo.internal.jp', '.kanto.internal.jp', '.corp', '.intra', '.vpc.internal', '.internal.net', '.cluster.local'];
    if (st === 'japan_telecom' || tpl === 'carrier_docomo' || tpl === 'carrier_softbank' || tpl === 'carrier_kddi') {
        suffixes = ['.tokyo.internal.jp', '.kanto.internal.jp', '.tokyo.internal', '.internal'];
    } else if (st === 'cloud_vpc' || tpl === 'aws_tokyo') {
        suffixes = ['.ap-northeast-1.internal', '.vpc.internal', '.cluster.local', '.internal'];
    } else if (st === 'enterprise') {
        suffixes = ['.tokyo.internal.jp', '.corp', '.intra', '.internal', '.internal.net'];
    } else if (st === 'bound_domain') {
        suffixes = ['.internal.' + rootDom, '.corp.' + rootDom, '.vpc.' + rootDom];
    }

    var suf = suffixes[getRndInt(0, suffixes.length - 1, s ? s + 8 : null)];
    if (suf.indexOf('.') === 0 && !suf.includes('tokyo') && !suf.includes('kanto') && !suf.includes('northeast') && getRndInt(0, 1, s ? s + 9 : null) === 0) {
        return hostPrefix + '.' + reg + suf;
    }
    return hostPrefix + suf;
}

function getJapanCommercialNode(targetType, seed, dom) {
    var s = seed;
    if (targetType === 'carrier_docomo') {
        var docomoSubnets = ['210.150.', '211.125.', '210.140.', '203.138.'];
        var dBase = docomoSubnets[getRndInt(0, docomoSubnets.length - 1, s)];
        var ip = dBase + getRndInt(1, 254, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null);
        var host = 'mail-gw' + String(getRndInt(1, 16, s ? s + 3 : null)).padStart(2, '0') + '.' + dom;
        return { ip: ip, host: host };
    } else if (targetType === 'carrier_kddi') {
        var kddiSubnets = ['106.187.', '118.159.', '202.214.'];
        var kBase = kddiSubnets[getRndInt(0, kddiSubnets.length - 1, s)];
        var ip = kBase + getRndInt(1, 254, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null);
        var host = 'telehouse-relay' + String(getRndInt(1, 16, s ? s + 3 : null)).padStart(2, '0') + '.' + dom;
        return { ip: ip, host: host };
    } else if (targetType === 'carrier_softbank') {
        var sbSubnets = ['101.110.', '126.140.', '126.240.', '210.130.'];
        var sBase = sbSubnets[getRndInt(0, sbSubnets.length - 1, s)];
        var ip = sBase + getRndInt(1, 254, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null);
        var host = (sBase === '101.110.') ? ('imsa' + getRndInt(4001, 4099, s ? s + 3 : null) + '.mailsv.softbank.jp') : ('ty3-core' + String(getRndInt(1, 16, s ? s + 3 : null)).padStart(2, '0') + '.' + dom);
        return { ip: ip, host: host };
    } else if (targetType === 'aws_tokyo') {
        var awsSubnets = ['52.68.', '54.64.', '13.112.', '13.230.', '54.150.'];
        var aBase = awsSubnets[getRndInt(0, awsSubnets.length - 1, s)];
        var a2 = getRndInt(1, 254, s ? s + 1 : null);
        var a3 = getRndInt(1, 254, s ? s + 2 : null);
        var ip = aBase + a2 + '.' + a3;
        var host = 'ec2-' + aBase.replace(/\./g, '-') + a2 + '-' + a3 + '.ap-northeast-1.compute.amazonaws.com';
        return { ip: ip, host: host };
    } else if (targetType === 'japan_idc' || targetType === 'enterprise') {
        var idcSubnets = ['133.242.', '160.16.', '153.120.'];
        var iBase = idcSubnets[getRndInt(0, idcSubnets.length - 1, s)];
        var ip = iBase + getRndInt(1, 254, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null);
        var host = 'mail-dc' + String(getRndInt(1, 16, s ? s + 3 : null)).padStart(2, '0') + '.' + dom;
        return { ip: ip, host: host };
    } else {
        var corpSubnets = ['210.150.', '106.187.', '202.214.', '133.242.'];
        var cBase = corpSubnets[getRndInt(0, corpSubnets.length - 1, s)];
        var ip = cBase + getRndInt(1, 254, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null);
        var host = 'mailgw' + String(getRndInt(1, 16, s ? s + 3 : null)).padStart(2, '0') + '.' + dom;
        return { ip: ip, host: host };
    }
}

function resolveTargetType(rcptDomain, callback) {
    if (!rcptDomain) return callback('aws_tokyo');
    rcptDomain = rcptDomain.toLowerCase().trim();

    if (rcptDomain.indexOf('docomo.ne.jp') >= 0 || rcptDomain.indexOf('spmode.ne.jp') >= 0 || rcptDomain.indexOf('mopera.net') >= 0) {
        return callback('carrier_docomo');
    }
    if (rcptDomain.indexOf('ezweb.ne.jp') >= 0 || rcptDomain.indexOf('au.com') >= 0 || rcptDomain.indexOf('uqmobile.jp') >= 0) {
        return callback('carrier_kddi');
    }
    if (rcptDomain.indexOf('softbank.ne.jp') >= 0 || rcptDomain.indexOf('i.softbank.jp') >= 0 || rcptDomain.indexOf('vodafone.ne.jp') >= 0 || rcptDomain.indexOf('ymobile.ne.jp') >= 0) {
        return callback('carrier_softbank');
    }
    if (rcptDomain.indexOf('gmail.com') >= 0 || rcptDomain.indexOf('googlemail.com') >= 0) {
        return callback('aws_tokyo');
    }
    if (rcptDomain.indexOf('outlook.com') >= 0 || rcptDomain.indexOf('outlook.jp') >= 0 || rcptDomain.indexOf('hotmail.com') >= 0) {
        return callback('enterprise');
    }
    if (rcptDomain.endsWith('.co.jp') || rcptDomain.endsWith('.or.jp') || rcptDomain.endsWith('.ac.jp') || rcptDomain.endsWith('.go.jp') || rcptDomain.endsWith('.jp')) {
        return callback('japan_idc');
    }

    if (_mxCache[rcptDomain]) {
        return callback(_mxCache[rcptDomain]);
    }

    var finished = false;
    var timer = setTimeout(function() {
        if (!finished) {
            finished = true;
            _mxCache[rcptDomain] = 'enterprise';
            callback('enterprise');
        }
    }, 300);

    try {
        dns.resolveMx(rcptDomain, function(err, addresses) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);

            if (err || !addresses || addresses.length === 0) {
                _mxCache[rcptDomain] = 'enterprise';
                return callback('enterprise');
            }

            addresses.sort(function(a, b) { return (a.priority || 0) - (b.priority || 0); });
            var topMx = ((addresses[0] && addresses[0].exchange) || '').toLowerCase();
            var detected = 'enterprise';
            if (topMx.indexOf('google') >= 0 || topMx.indexOf('aspmx') >= 0) {
                detected = 'aws_tokyo';
            } else if (topMx.indexOf('docomo') >= 0 || topMx.indexOf('ntt') >= 0) {
                detected = 'carrier_docomo';
            } else if (topMx.indexOf('kddi') >= 0 || topMx.indexOf('ezweb') >= 0) {
                detected = 'carrier_kddi';
            } else if (topMx.indexOf('softbank') >= 0 || topMx.indexOf('bbtec') >= 0) {
                detected = 'carrier_softbank';
            } else if (topMx.indexOf('sakura') >= 0 || rcptDomain.endsWith('.jp')) {
                detected = 'japan_idc';
            }

            _mxCache[rcptDomain] = detected;
            return callback(detected);
        });
    } catch(dnsErr) {
        if (!finished) {
            finished = true;
            clearTimeout(timer);
            _mxCache[rcptDomain] = 'enterprise';
            callback('enterprise');
        }
    }
}

function genHexHashId(seed, len) {
    var hexChars = '0123456789ABCDEF';
    var targetLen = len || 10;
    var res = '';
    for (var i = 0; i < targetLen; i++) {
        res += hexChars[getRndInt(0, 15, seed ? (seed * 17 + i * 31 + 7) : null)];
    }
    return res;
}

function buildChainAndApply(tx, connection, cfg, chosenType, dom, id1, id2, forPart, origDate, prevDate, baseSeed) {
    var hop1 = '';
    var hop2 = '';
    var s = baseSeed;
    var hopsCount = cfg.hops || 1;
    var ipPool = cfg.ip_pool || 'smart_pool';
    var mtaFlavor = cfg.mta_flavor || 'dynamic';
    var domainStyle = cfg.domain_style || 'dynamic';

    var usePublic = (ipPool === 'japan_public');
    var isHybrid = (ipPool === 'hybrid_mix');
    if (ipPool === 'smart_pool') {
        if (hopsCount === 2) {
            isHybrid = true;
            usePublic = true;
        } else {
            usePublic = (chosenType === 'carrier_docomo' || chosenType === 'carrier_softbank' || chosenType === 'carrier_kddi' || chosenType === 'aws_tokyo' || chosenType === 'japan_idc');
        }
    }

    if (chosenType === 'custom' && cfg.custom_template) {
        var cIp = (usePublic || isHybrid) ?
            ('211.125.' + getRndInt(10, 230, s) + '.' + getRndInt(1, 254, s ? s + 1 : null)) :
            ('10.' + getRndInt(10, 230, s) + '.' + getRndInt(1, 254, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null));
        var subH = 'gw-relay' + String(getRndInt(1, 16, s ? s + 3 : null)).padStart(2, '0') + '.' + dom;
        var rendered = cfg.custom_template
            .split('{client_ip}').join(cIp)
            .split('{client_host}').join(subH)
            .split('{sub_host}').join(subH)
            .split('{domain}').join(dom)
            .split('{id}').join(id1)
            .split('{for_part}').join(forPart)
            .split('{to}').join(forPart ? forPart.replace(/^[ \t]*for[ \t]*</i, '').replace(/>[ \t]*$/, '') : '')
            .split('{date}').join(origDate);

        tx.remove_header('Received');
        var rawLines = rendered.split('\n');
        for (var i = rawLines.length - 1; i >= 0; i--) {
            var h = rawLines[i].replace(/^Received:/i, '').trim();
            if (h) tx.add_leading_header('Received', h);
        }
        return;
    }

    var chainFamily = mtaFlavor.toLowerCase();
    if (chainFamily === 'dynamic') {
        var roll = getRndInt(1, 100, s);
        if (roll <= 50) chainFamily = 'pure_rfc';
        else if (roll <= 85) chainFamily = 'postfix';
        else chainFamily = 'sendmail';
    } else if (chainFamily === 'smart_match') {
        if (chosenType === 'carrier_kddi') chainFamily = 'sendmail';
        else if (chosenType === 'carrier_softbank') chainFamily = 'pure_rfc';
        else chainFamily = 'postfix';
    }

    var sw2 = '';
    if (chainFamily === 'postfix') {
        sw2 = '(Postfix) ';
    } else if (chainFamily === 'sendmail') {
        sw2 = '(8.15.2/8.15.2) ';
    }

    if (chosenType === 'official_std') {
        var stdId = (id1 && id1.length >= 8) ? id1 : genHexHashId(s, 10);
        hop1 = 'from [127.0.0.1] (localhost [127.0.0.1]) by ' + dom + ' with ESMTPSA id ' + stdId + forPart + '; ' + origDate;
        hop2 = '';
    } else if (chosenType === 'aws_tokyo') {
        var clientIp = '';
        var clientHost = '';
        if (usePublic || isHybrid) {
            var awsSubnets = ['52.68.', '54.64.', '13.112.', '13.230.'];
            var base = awsSubnets[getRndInt(0, awsSubnets.length - 1, s)];
            var a2 = getRndInt(1, 254, s ? s + 1 : null);
            var a3 = getRndInt(1, 254, s ? s + 2 : null);
            clientIp = base + a2 + '.' + a3;
            clientHost = 'ec2-' + base.split('.').join('-') + a2 + '-' + a3 + '.ap-northeast-1.compute.amazonaws.com';
        } else {
            var a1 = getRndInt(100, 235, s);
            clientIp = '10.' + a1 + '.' + getRndInt(1, 254, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null);
            clientHost = 'ip-' + clientIp.replace(/\./g, '-') + '.ap-northeast-1.compute.internal';
        }
        var mtaHost = 'sdmmta' + String(getRndInt(1, 32, s ? s + 6 : null)).padStart(2, '0') + '.mail.internal';
        var postfixId = genHexHashId(s, 10);
        hop1 = 'from ' + clientHost + ' (' + clientHost + ' [' + clientIp + ']) by ' + mtaHost + ' with ESMTP id ' + postfixId + forPart + '; ' + origDate;
        var appHost = getRandomInternalHost(dom, domainStyle, s ? s + 7 : null, 'aws_tokyo');
        var appIp = usePublic ? ('54.64.' + getRndInt(1, 254, s ? s + 8 : null) + '.' + getRndInt(1, 254, s ? s + 9 : null)) : ('10.' + getRndInt(10, 80, s ? s + 8 : null) + '.' + getRndInt(1, 254, s ? s + 9 : null) + '.' + getRndInt(1, 254, s ? s + 10 : null));
        var appQueueId = genHexHashId(s ? s + 9 : null, 10);
        hop2 = 'from ' + appHost + ' ([' + appIp + ']) by ' + clientHost + ' ' + sw2 + 'with ESMTPA id ' + appQueueId + forPart + '; ' + prevDate;
    } else if (chosenType === 'carrier_docomo') {
        var subgwHost = getRandomRelayHost(dom, domainStyle, s, 'carrier_docomo');
        var subgwIp = '';
        if (usePublic || isHybrid) {
            var docomoSubnets = ['210.150.', '211.125.', '210.140.', '203.138.'];
            subgwIp = docomoSubnets[getRndInt(0, docomoSubnets.length - 1, s)] + getRndInt(1, 254, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null);
        } else {
            subgwIp = '10.136.' + getRndInt(10, 235, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null);
        }
        var docomoId1 = (id1 && id1.length >= 8) ? id1 : genHexHashId(s, 10);
        var docomoId2 = genHexHashId(s ? s + 4 : null, 10);
        hop1 = 'from ' + subgwHost + ' ([' + subgwIp + ']) by ' + dom + ' with ESMTPS id ' + docomoId1 + forPart + '; ' + origDate;
        var docomoInternalHost = getRandomInternalHost(dom, domainStyle, s ? s + 3 : null, 'carrier_docomo');
        var relayIp = usePublic ? ('210.140.' + getRndInt(1, 254, s ? s + 4 : null) + '.' + getRndInt(1, 254, s ? s + 5 : null)) : ('10.136.' + getRndInt(1, 254, s ? s + 4 : null) + '.' + getRndInt(1, 254, s ? s + 5 : null));
        hop2 = 'from ' + docomoInternalHost + ' ([' + relayIp + ']) by ' + subgwHost + ' ' + sw2 + 'with ESMTPA id ' + docomoId2 + forPart + '; ' + prevDate;
    } else if (chosenType === 'carrier_softbank') {
        var sbHost = getRandomRelayHost(dom, domainStyle, s, 'carrier_softbank');
        var sbIp = '';
        if (usePublic || isHybrid) {
            var sbSubnets = ['101.110.', '126.140.', '126.240.', '210.130.'];
            sbIp = sbSubnets[getRndInt(0, sbSubnets.length - 1, s)] + getRndInt(1, 254, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null);
        } else {
            sbIp = '10.198.' + getRndInt(10, 235, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null);
        }
        var sbEdgeId = genHexHashId(s, 10);
        var nowDigits = new Date().toISOString().replace(/[-:T.Z]/g, '').substring(0, 14) + String(getRndInt(100, 999, s ? s + 5 : null));
        var randTag = crypto.randomBytes(2).toString('hex').toUpperCase();
        var pid = getRndInt(40000, 49999, s ? s + 6 : null);
        var sbMailsvId = '<' + nowDigits + '.' + randTag + '.' + pid + '.' + sbHost + '@mailsv.softbank.jp>';
        hop1 = 'from ' + sbHost + ' ([' + sbIp + ']) by ' + dom + ' with ESMTPS id ' + sbEdgeId + forPart + '; ' + origDate;
        var sbInternalHost = getRandomInternalHost(dom, domainStyle, s ? s + 3 : null, 'carrier_softbank');
        var mIp = usePublic ? ('126.140.' + getRndInt(1, 254, s ? s + 4 : null) + '.' + getRndInt(1, 254, s ? s + 5 : null)) : ('10.198.' + getRndInt(1, 254, s ? s + 4 : null) + '.' + getRndInt(1, 254, s ? s + 5 : null));
        hop2 = 'from ' + sbInternalHost + ' ([' + mIp + ']) by ' + sbHost + ' with ESMTP id ' + sbMailsvId + forPart + '; ' + prevDate;
    } else if (chosenType === 'carrier_kddi') {
        var kHost = getRandomRelayHost(dom, domainStyle, s, 'carrier_kddi');
        var kIp = '';
        if (usePublic || isHybrid) {
            var kddiSubnets = ['106.187.', '118.159.', '202.214.'];
            kIp = kddiSubnets[getRndInt(0, kddiSubnets.length - 1, s)] + getRndInt(1, 254, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null);
        } else {
            kIp = '10.148.' + getRndInt(10, 235, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null);
        }
        var sendmailId = genHexHashId(s, 10);
        var kddiAppId = genHexHashId(s ? s + 7 : null, 10);
        hop1 = 'from ' + kHost + ' ([' + kIp + ']) by ' + dom + ' with ESMTP id ' + sendmailId + forPart + '; ' + origDate;
        var kddiInternalHost = getRandomInternalHost(dom, domainStyle, s ? s + 3 : null, 'carrier_kddi');
        var kRelayIp = usePublic ? ('202.214.' + getRndInt(1, 254, s ? s + 3 : null) + '.' + getRndInt(1, 254, s ? s + 4 : null)) : ('10.148.' + getRndInt(1, 254, s ? s + 3 : null) + '.' + getRndInt(1, 254, s ? s + 4 : null));
        var kddiSw2 = (chainFamily === 'sendmail') ? '(8.15.2/8.15.2) ' : sw2;
        hop2 = 'from ' + kddiInternalHost + ' ([' + kRelayIp + ']) by ' + kHost + ' ' + kddiSw2 + 'with ESMTPA id ' + kddiAppId + forPart + '; ' + prevDate;
    } else {
        // Japanese commercial IDC / Enterprise
        var corpHost = getRandomRelayHost(dom, domainStyle, s, 'enterprise');
        var corpIp = '';
        if (usePublic || isHybrid) {
            var idcSubnets = ['133.242.', '160.16.', '153.120.'];
            corpIp = idcSubnets[getRndInt(0, idcSubnets.length - 1, s)] + getRndInt(1, 254, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null);
        } else {
            corpIp = '10.24.' + getRndInt(10, 235, s ? s + 1 : null) + '.' + getRndInt(1, 254, s ? s + 2 : null);
        }
        var id1Long = genHexHashId(s, 10);
        var id2Long = genHexHashId(s ? s + 8 : null, 10);
        hop1 = 'from ' + corpHost + ' ([' + corpIp + ']) by ' + dom + ' with ESMTPS id ' + id1Long + forPart + '; ' + origDate;
        var corpInternalHost = getRandomInternalHost(dom, domainStyle, s ? s + 3 : null, 'enterprise');
        var svrIp = usePublic ? ('160.16.' + getRndInt(1, 254, s ? s + 4 : null) + '.' + getRndInt(1, 254, s ? s + 5 : null)) : ('10.10.' + getRndInt(1, 254, s ? s + 4 : null) + '.' + getRndInt(1, 254, s ? s + 5 : null));
        hop2 = 'from ' + corpInternalHost + ' ([' + svrIp + ']) by ' + corpHost + ' ' + sw2 + 'with ESMTPA id ' + id2Long + forPart + '; ' + prevDate;
    }

    tx.remove_header('Received');
    var effHops = (chosenType === 'official_std') ? 1 : hopsCount;
    if (effHops === 2 && hop2) {
        tx.add_leading_header('Received', hop2);
    }
    if (hop1) {
        tx.add_leading_header('Received', hop1);
    }
}

exports.hook_data_post = function(next, connection) {
    try {
        if (!connection || !connection.transaction) return next();
        var tx = connection.transaction;

        // Strip client leaking headers
        var ipHeaders = ['X-Originating-IP', 'X-Forwarded-For', 'X-Remote-IP', 'X-Sender-IP', 'X-Client-IP', 'X-Real-IP'];
        for (var i = 0; i < ipHeaders.length; i++) {
            tx.remove_header(ipHeaders[i]);
        }
        tx.remove_header('Authentication-Results');
        tx.remove_header('ARC-Authentication-Results');

        // Check if message already contains a genuine relay chain (e.g. from injector 1-hop or 2-hop)
        var existingRcvd = tx.header ? tx.header.get_all('Received') : [];
        var genuineRcvd = [];
        for (var r = 0; r < existingRcvd.length; r++) {
            var rLine = String(existingRcvd[r] || '');
            var rLower = rLine.toLowerCase();
            // Ignore Haraka's local submission / loopback lines (127.0.0.1, localhost, ::1, or (Haraka))
            if (rLower.indexOf('127.0.0.1') >= 0 || rLower.indexOf('localhost') >= 0 || rLower.indexOf('::1') >= 0 || rLower.indexOf('(haraka)') >= 0) {
                continue;
            }
            genuineRcvd.push(rLine);
        }

        // If genuine relay chain is already present from injector, preserve it and strip any loopback headers
        if (genuineRcvd.length >= 1) {
            tx.remove_header('Received');
            for (var g = genuineRcvd.length - 1; g >= 0; g--) {
                var cleanH = genuineRcvd[g].replace(/^Received:\s*/i, '').trim();
                if (cleanH) tx.add_leading_header('Received', cleanH);
            }
            return next();
        }

        var fromHdr = tx.header ? (tx.header.get('From') || '') : '';
        var mailFrom = getAddressString(tx.mail_from);
        var dom = extractDomain(fromHdr, extractDomain(mailFrom, 'localhost'));

        var rcptAddr = '';
        if (tx.rcpt_to && tx.rcpt_to.length > 0 && tx.rcpt_to[0]) {
            rcptAddr = getAddressString(tx.rcpt_to[0]);
        }
        var forPart = rcptAddr ? (' for <' + rcptAddr + '>') : '';
        var rcptDomain = extractDomain(rcptAddr, '');

        var origDate = formatRfc2822Date(new Date());
        var prevDate = formatRfc2822Date(new Date(Date.now() - 2000));
        var baseSeed = strHash(dom + rcptAddr) + (_mailCounter++);
        var id1 = genHexHashId(baseSeed, 10);
        var id2 = genHexHashId(baseSeed + 7, 10);

        var cfg = {
            hops: 1,
            ip_pool: 'smart_pool',
            mta_flavor: 'dynamic',
            domain_style: 'dynamic'
        };

        resolveTargetType(rcptDomain, function(detectedType) {
            buildChainAndApply(tx, connection, cfg, detectedType, dom, id1, id2, forPart, origDate, prevDate, baseSeed);
            return next();
        });
        return;
    } catch(err) {
        if (connection && typeof connection.logerror === 'function') {
            connection.logerror('custom_received_header error: ' + err.message);
        }
    }
    next();
};
