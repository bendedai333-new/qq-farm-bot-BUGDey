#!/usr/bin/env node
'use strict';

/**
 * 以薯换福协议冒烟检查。
 *
 *   node core/scripts/inspect-sweet-potato.js
 *       自检：合成 GroupReply / OperateReply，编码后解码，逐字段比对。
 *   node core/scripts/inspect-sweet-potato.js --hex 08c7...
 *       用真实回包十六进制解码，自动试 GroupReply 与 OperateReply。
 *   node core/scripts/inspect-sweet-potato.js --file body.bin
 *       同上，从二进制文件读。
 *   node core/scripts/inspect-sweet-potato.js --hex ... --wire
 *       先打印原始 wire 结构（字段号 + wire 类型），schema 不匹配时用它定位。
 *
 * 不启动应用、不连网关、不读配置，只依赖 protobufjs。
 */

const fs = require('node:fs');
const path = require('node:path');
const protobuf = require('protobufjs');

const PROTO_DIR = path.join(__dirname, '..', 'src', 'proto');
const NAMES = ['SweetPotatoGroupReply', 'SweetPotatoOperateRequest', 'SweetPotatoOperateReply'];

function loadTypes() {
    const root = new protobuf.Root();
    const defaultResolve = root.resolvePath.bind(root);
    root.resolvePath = function (origin, target) {
        const candidate = path.join(PROTO_DIR, target);
        return fs.existsSync(candidate) ? candidate : defaultResolve(origin, target);
    };
    // 只加载 sweet-potato.proto，它会 import corepb.proto；重复加载会报 duplicate name 'Item'。
    root.loadSync(path.join(PROTO_DIR, 'sweet-potato.proto'), { keepCase: true });
    const types = {};
    for (const name of NAMES) types[name] = root.lookupType('gamepb.activitypb.' + name);
    return types;
}

function toNum(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function readVarint(buf, pos) {
    let result = 0n;
    let shift = 0n;
    for (;;) {
        if (pos >= buf.length) throw new Error('varint truncated');
        const byte = buf[pos++];
        result |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return [result, pos];
        shift += 7n;
        if (shift > 63n) throw new Error('varint too long');
    }
}

function tryWalk(buf, depth, maxDepth) {
    const rows = [];
    let pos = 0;
    while (pos < buf.length) {
        let tag;
        [tag, pos] = readVarint(buf, pos);
        const field = Number(tag >> 3n);
        const wire = Number(tag & 7n);
        if (field === 0) throw new Error('field 0');
        if (wire === 0) {
            let value;
            [value, pos] = readVarint(buf, pos);
            rows.push({ depth: depth, field: field, wire: wire, value: value.toString() });
        } else if (wire === 2) {
            let len;
            [len, pos] = readVarint(buf, pos);
            const end = pos + Number(len);
            if (end > buf.length) throw new Error('length out of range');
            const sub = buf.subarray(pos, end);
            pos = end;
            let printable = sub.length > 0;
            for (let i = 0; i < sub.length; i += 1) {
                if (sub[i] < 0x20 || sub[i] > 0x7e) { printable = false; break; }
            }
            rows.push({ depth: depth, field: field, wire: wire, bytes: sub.length, text: printable ? sub.toString('latin1') : '' });
            if (depth < maxDepth) {
                try {
                    const nested = tryWalk(sub, depth + 1, maxDepth);
                    if (nested.length) rows.push.apply(rows, nested);
                } catch (ignored) { void ignored; }
            }
        } else if (wire === 5) {
            pos += 4;
            rows.push({ depth: depth, field: field, wire: wire });
        } else if (wire === 1) {
            pos += 8;
            rows.push({ depth: depth, field: field, wire: wire });
        } else {
            throw new Error('unsupported wire type ' + wire);
        }
        if (pos > buf.length) throw new Error('overflow');
    }
    return rows;
}

function printWire(buf) {
    console.log('--- wire structure (field / wire / value) ---');
    const rows = tryWalk(buf, 0, 3);
    for (const row of rows) {
        const pad = '  '.repeat(row.depth);
        if (row.wire === 0) console.log(pad + '#' + row.field + ' varint = ' + row.value);
        else if (row.wire === 2) console.log(pad + '#' + row.field + ' len(' + row.bytes + ')' + (row.text ? ' "' + row.text + '"' : ''));
        else console.log(pad + '#' + row.field + ' wire' + row.wire);
    }
}

function selftest(types) {
    const failures = [];
    function check(label, actual, expect) {
        const a = String(actual);
        const e = String(expect);
        if (a === e) {
            console.log('  OK  ' + label + ' = ' + a);
        } else {
            console.log('  FAIL ' + label + ': expect ' + e + ', got ' + a);
            failures.push(label);
        }
    }

    function head(extra, id, type) {
        return {
            activity_id: id,
            group_id: '2026111707',
            type: type,
            name: 'yishuhuanfu',
            extra: extra,
            begin_time: 1795572000,
            end_time: 1796831999,
            sort_order: 0,
            field_20: 1,
            field_21: 0,
            field_22: 0,
            field_23: 0,
            settle_start_time: 0,
        };
    }

    console.log('[1/2] SweetPotatoGroupReply round trip');
    const rulesJson = Buffer.from(JSON.stringify({ tips: { txt: ['rule-a', 'rule-b'] } }), 'utf8');
    const groupPayload = {
        group: {
            activity: head(rulesJson, '2026111707', 0),
            children: [{
                activity: head(Buffer.alloc(0), '2026111708', 26),
                children: [],
                maple_market: {
                    daily_state: { seed_claimed: false, shared: true },
                    activity_coin: '154350',
                    red_dots: { seed_unclaimed: true, boost_unread: false, share_unclaimed: false, exchangeable: true, purchase_log_unread: false, commission_unclaimed: false },
                    base_price: '146',
                    boost_value: '99',
                    price_rate_bp: '12500',
                    pending_commission_coin: '0',
                    pending_commission_count: '0',
                },
            }],
        },
    };
    const groupWire = types.SweetPotatoGroupReply.encode(groupPayload).finish();
    console.log('  encoded ' + groupWire.length + ' bytes');
    const group = types.SweetPotatoGroupReply.decode(groupWire);
    check('group.activity.activity_id', group.group.activity.activity_id, '2026111707');
    check('children.length', group.group.children.length, 1);
    const child = group.group.children[0];
    check('child.activity.activity_id', child.activity.activity_id, '2026111708');
    check('child.activity.type', child.activity.type, 26);
    check('child.activity.field_20', child.activity.field_20, 1);
    check('child.maple_market.activity_coin', toNum(child.maple_market.activity_coin), 154350);
    check('child.maple_market.base_price', toNum(child.maple_market.base_price), 146);
    check('child.maple_market.boost_value', toNum(child.maple_market.boost_value), 99);
    check('child.maple_market.price_rate_bp', toNum(child.maple_market.price_rate_bp), 12500);
    check('daily_state.shared', child.maple_market.daily_state.shared, true);
    check('daily_state.seed_claimed', child.maple_market.daily_state.seed_claimed, false);
    check('red_dots.seed_unclaimed', child.maple_market.red_dots.seed_unclaimed, true);
    check('red_dots.exchangeable', child.maple_market.red_dots.exchangeable, true);
    const parsed = JSON.parse(Buffer.from(group.group.activity.extra).toString('utf8'));
    check('extra parse tips count', parsed.tips.txt.length, 2);

    console.log('[2/2] SweetPotatoOperateReply round trip per cmd');
    const cases = [
        ['claim_seed', 'maple_market_claim_seed', 191, { seed: { id: '20307', count: '28' } }],
        ['get_shop', 'maple_market_get_shop', 192, { shop: { base_price: '146', boost_value: '99', remain_quota: '7903', owner: { gid: '10001', name: 'friend-a', avatar: 'https://x/a.png', level: '42' } }, can_sell: true }],
        ['sell', 'maple_market_sell', 193, { sold_count: '95', final_price: '245', activity_coin_income: '23275', remain_quota: '7903', activity_coin: '23765', income_gold: '0' }],
        ['get_purchase_log', 'maple_market_get_purchase_log', 195, { records: [{ timestamp: '1795600000', seller_gid: '10001', sold_count: '2', income: '490', seller_name: 'friend-a', seller_avatar: 'https://x/a.png', seller_level: '42', commission: '24' }] }],
        ['get_goods_list', 'maple_market_get_goods_list', 197, { goods: [{ goods_id: '1', activity_coin_price: '800', limit_type: 1, limit_times: '1', purchased_daily: '0', purchased_total: '0', exchangeable: true }], activity_coin: '154350' }],
        ['exchange', 'maple_market_exchange', 196, { activity_coin_cost: '800', items: [{ id: '204013', count: '1' }], activity_coin: '153550', purchased_daily: '1', purchased_total: '1' }],
        ['claim_commission', 'maple_market_claim_commission', 199, { claimed_coin: '120', claimed_count: '2', activity_coin: '153670' }],
    ];
    for (const row of cases) {
        const label = row[0];
        const field = row[1];
        const cmd = row[2];
        const result = row[3];
        const payload = { id: '2026111708', cmd: cmd };
        payload[field] = result;
        const wire = types.SweetPotatoOperateReply.encode(payload).finish();
        const back = types.SweetPotatoOperateReply.decode(wire);
        if (!back[field]) {
            console.log('  FAIL ' + label + ': decoded ' + field + ' is empty');
            failures.push(label);
            continue;
        }
        console.log('  OK  ' + label + ' (cmd ' + cmd + ', ' + wire.length + ' bytes)');
    }

    const shareReq = types.SweetPotatoOperateRequest.encode({ id: '2026111708', cmd: 98, maple_market_share: {} }).finish();
    const shareBack = types.SweetPotatoOperateRequest.decode(shareReq);
    if (shareBack.maple_market_share !== undefined && shareBack.maple_market_share !== null) {
        console.log('  OK  share request carries field 198 (' + shareReq.length + ' bytes)');
    } else {
        console.log('  FAIL share request lost field 198');
        failures.push('share-198');
    }

    console.log('');
    if (failures.length) {
        console.log('RESULT: ' + failures.length + ' failures -> ' + failures.join(', '));
        process.exitCode = 1;
    } else {
        console.log('RESULT: all passed. schema is self-consistent; next step is real-payload validation.');
    }
}

function decodeReal(types, buf, showWire) {
    if (showWire) {
        printWire(buf);
        console.log('');
    }
    for (const name of ['SweetPotatoGroupReply', 'SweetPotatoOperateReply']) {
        console.log('--- decode as ' + name + ' ---');
        try {
            const decoded = types[name].decode(buf);
            const json = types[name].toObject(decoded, { longs: String, bytes: String, defaults: false });
            console.log(JSON.stringify(json, null, 2));
            const filled = Object.keys(json).filter(function (k) { return k !== 'id' && k !== 'cmd'; });
            if (filled.length) console.log('  hit fields: ' + filled.join(', '));
        } catch (error) {
            console.log('  decode failed: ' + error.message);
        }
        console.log('');
    }
    console.log('tip: if both decode but fields look shifted, run with --wire and compare field numbers.');
}

function main() {
    const argv = process.argv.slice(2);
    const hexIndex = argv.indexOf('--hex');
    const fileIndex = argv.indexOf('--file');
    const showWire = argv.indexOf('--wire') >= 0;

    const types = loadTypes();
    console.log('proto loaded, types registered: ' + NAMES.length);
    console.log('');

    if (hexIndex >= 0) {
        const hex = String(argv[hexIndex + 1] || '').replace(/[^0-9a-fA-F]/g, '');
        if (!hex.length) throw new Error('no hex after --hex');
        decodeReal(types, Buffer.from(hex, 'hex'), showWire);
        return;
    }
    if (fileIndex >= 0) {
        const file = String(argv[fileIndex + 1] || '');
        if (!file) throw new Error('no path after --file');
        decodeReal(types, fs.readFileSync(path.resolve(file)), showWire);
        return;
    }
    selftest(types);
}

try {
    main();
} catch (error) {
    console.error('FAILED: ' + error.message);
    process.exitCode = 1;
}
