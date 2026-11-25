/**
 * 以薯换福（官方内部名 maple_market）活动服务 —— 只读阶段
 *
 * 协议见 core/src/proto/sweet-potato.proto（独立 Request/Reply，不改共用 activitypb.proto）。
 * 活动参数：组 2026111707 / 主玩法 2026111708 / 红薯种子 20307 / 蜜薯 1032 / 福气币 1033。
 *
 * 当前只实现只读：
 *   getSweetPotatoActivity()      读活动状态 + 背包库存
 *   getSweetPotatoShop(targetGid) 查自家或指定铺子的收购价
 *
 * 不包含任何写操作。后续写操作（领种子/出售/兑换/分享/领佣金）必须沿用
 * “回包校验不过就报 RESULT_UNKNOWN 并停止”的语义，禁止重试。
 */
const { types } = require('../utils/proto');
const { sendMsgAsync, getUserState } = require('../utils/network');
const { toNum, getServerTimeSec } = require('../utils/utils');
const { getBag, getBagItems } = require('./warehouse');

const SERVICE = 'gamepb.activitypb.ActivityService';

const GROUP_ID = '2026111707';
const ACTIVITY_ID = '2026111708';
const SEED_ITEM_ID = 20307;
const CROP_ITEM_ID = 1032;
const COIN_ITEM_ID = 1033;

function fail(code, message) {
    throw Object.assign(new Error(message), { code });
}

function bin(value) {
    if (!value) return Buffer.alloc(0);
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    return Buffer.alloc(0);
}

function parseRules(extra) {
    const raw = bin(extra);
    if (!raw.length) return [];
    try {
        const parsed = JSON.parse(raw.toString('utf8'));
        const txt = parsed && parsed.tips && Array.isArray(parsed.tips.txt) ? parsed.tips.txt : [];
        return txt
            .map((line) => String(line).replace(/<[^>]+>/g, '').trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

function phaseOf(head, now) {
    const begin = toNum(head.begin_time);
    const end = toNum(head.end_time);
    const settle = toNum(head.settle_start_time);
    if (begin > 0 && now < begin) return 'upcoming';
    if (end > 0 && now > end) return 'ended';
    if (settle > 0 && now >= settle) return 'settlement';
    return toNum(head.field_20) === 1 ? 'active' : 'unavailable';
}

async function rpc(method, requestType, requestInput, replyType) {
    const request = types[requestType].encode(types[requestType].create(requestInput)).finish();
    const { body } = await sendMsgAsync(SERVICE, method, request);
    return types[replyType].decode(body);
}

async function readGroup() {
    // 本地 GetGroupRequest 字段名为 id（上游叫 group_id），字段号同为 1，线格式一致。
    const reply = await rpc('GetGroup', 'ActivityGetGroupRequest', { id: GROUP_ID }, 'SweetPotatoGroupReply');
    const group = reply && reply.group;
    const groupIdSeen = group && group.activity ? String(group.activity.activity_id || '') : '';
    if (groupIdSeen !== GROUP_ID) {
        fail('SWEET_POTATO_UNAVAILABLE', `服务端未返回以薯换福活动组（期望 ${  GROUP_ID  }，实际 ${  groupIdSeen || '空'  }）`);
    }
    const children = Array.isArray(group.children) ? group.children : [];
    const entry = children.find((child) => child && child.activity && String(child.activity.activity_id || '') === ACTIVITY_ID);
    if (!entry) {
        fail('SWEET_POTATO_UNAVAILABLE', `活动组存在但缺少主玩法 ${  ACTIVITY_ID}`);
    }
    if (!entry.maple_market) {
        fail('SWEET_POTATO_UNAVAILABLE', '主玩法回包中没有 maple_market 活动体（字段 130 未命中，请先核对协议）');
    }
    return { group, entry, groupIdSeen };
}

function countInBag(items, itemId) {
    return items.reduce((total, item) => (toNum(item && item.id) === itemId ? total + toNum(item.count) : total), 0);
}

async function readBagCounts() {
    const reply = await getBag();
    const items = getBagItems(reply);
    return {
        seed: countInBag(items, SEED_ITEM_ID),
        crop: countInBag(items, CROP_ITEM_ID),
        coin: countInBag(items, COIN_ITEM_ID),
    };
}

async function getSweetPotatoActivity() {
    const { entry, groupIdSeen } = await readGroup();
    const head = entry.activity;
    const body = entry.maple_market;
    const now = getServerTimeSec();
    const phase = phaseOf(head, now);

    let bag = { seed: 0, crop: 0, coin: 0 };
    let bagError = '';
    try {
        bag = await readBagCounts();
    } catch (error) {
        bagError = error && error.message ? error.message : String(error);
    }

    const daily = body.daily_state || {};
    const redDots = body.red_dots || {};
    const basePrice = toNum(body.base_price);
    const boostValue = toNum(body.boost_value);

    return {
        activityId: ACTIVITY_ID,
        groupId: GROUP_ID,
        groupIdSeen,
        name: String(head.name || ''),
        phase,
        active: phase === 'active' || phase === 'settlement',
        serverTime: now * 1000,
        startTime: toNum(head.begin_time) * 1000,
        endTime: toNum(head.end_time) * 1000,
        settleStartTime: toNum(head.settle_start_time) * 1000,
        seedClaimed: daily.seed_claimed === true,
        shared: daily.shared === true,
        coinBalance: toNum(body.activity_coin),
        price: {
            base: basePrice,
            boost: boostValue,
            unit: basePrice + boostValue,
            rateBp: toNum(body.price_rate_bp),
        },
        pendingCommission: {
            coin: toNum(body.pending_commission_coin),
            count: toNum(body.pending_commission_count),
        },
        redDots: {
            seedUnclaimed: redDots.seed_unclaimed === true,
            boostUnread: redDots.boost_unread === true,
            shareUnclaimed: redDots.share_unclaimed === true,
            exchangeable: redDots.exchangeable === true,
            purchaseLogUnread: redDots.purchase_log_unread === true,
            commissionUnclaimed: redDots.commission_unclaimed === true,
        },
        bag,
        bagError,
        rules: parseRules(head.extra),
    };
}

async function getSweetPotatoShop(targetGid) {
    const ownGid = String((getUserState() || {}).gid || '');
    const gid = String(targetGid || ownGid);
    if (!/^[1-9]\d{0,15}$/.test(gid)) {
        fail('INVALID_SWEET_POTATO_GID', '铺子 GID 无效');
    }
    const reply = await rpc('Operate', 'SweetPotatoOperateRequest', {
        id: ACTIVITY_ID,
        cmd: 92,
        maple_market_get_shop: { target_gid: gid },
    }, 'SweetPotatoOperateReply');
    if (toNum(reply.cmd) !== 92) {
        fail('SWEET_POTATO_RESULT_UNKNOWN', `查询铺子回包 cmd 不匹配（期望 92，实际 ${  toNum(reply.cmd)  }）`);
    }
    const result = reply.maple_market_get_shop;
    if (!result) {
        fail('SWEET_POTATO_RESULT_UNKNOWN', '回包缺少 maple_market_get_shop（字段 192 未命中，请核对协议）');
    }
    const shop = result.shop || {};
    const owner = shop.owner || {};
    const ownerGid = String(owner.gid || '');
    if (ownerGid && ownerGid !== gid) {
        fail('SWEET_POTATO_OWNER_MISMATCH', `回包铺主与请求不一致（请求 ${  gid  }，回包 ${  ownerGid  }）`);
    }
    const basePrice = toNum(shop.base_price);
    const boostValue = toNum(shop.boost_value);
    return {
        targetGid: gid,
        ownShop: !targetGid,
        owner: {
            gid: ownerGid,
            name: String(owner.name || ''),
            level: toNum(owner.level),
        },
        basePrice,
        boostValue,
        unitPrice: basePrice + boostValue,
        remainQuota: toNum(shop.remain_quota),
        canSell: result.can_sell === true,
        checkedAt: getServerTimeSec() * 1000,
    };
}

module.exports = { getSweetPotatoActivity, getSweetPotatoShop };
