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
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { getFriendsList } = require('./friend');
const farmApi = require('./farm-api');
const { analyzeLands } = require('./farm-land-analyzer');
const { plantSeeds } = require('./planting-service');

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

// ---------- 写操作 ----------
// 所有写操作串行执行，且“回包认不出结果”一律报 RESULT_UNKNOWN 并停止，禁止自动重试。

let mutationTail = Promise.resolve();
function withMutationLock(fn) {
    const run = mutationTail.then(fn, fn);
    mutationTail = run.then(() => undefined, () => undefined);
    return run;
}

async function claimSweetPotatoSeed() {
    return withMutationLock(async () => {
        const before = await getSweetPotatoActivity();
        if (!before.active) {
            fail('SWEET_POTATO_INACTIVE', `领种子失败：活动当前阶段 ${  before.phase}`);
        }
        if (before.seedClaimed) {
            return { status: 'skipped', reason: 'already_claimed', activity: before };
        }
        const reply = await rpc('Operate', 'SweetPotatoOperateRequest', {
            id: ACTIVITY_ID,
            cmd: 91,
            maple_market_claim_seed: {},
        }, 'SweetPotatoOperateReply');
        if (toNum(reply.cmd) !== 91) {
            fail('SWEET_POTATO_RESULT_UNKNOWN', `领种子回包 cmd 不匹配（期望 91，实际 ${  toNum(reply.cmd)  }）`);
        }
        const result = reply.maple_market_claim_seed;
        if (!result || !result.seed) {
            fail('SWEET_POTATO_RESULT_UNKNOWN', '领种子回包缺少 seed（字段 191 未命中，请核对协议）');
        }
        const seedId = toNum(result.seed.id);
        const seedCount = toNum(result.seed.count);
        const body = reply.data && reply.data.maple_market ? reply.data.maple_market : null;
        const claimed = !!(body && body.daily_state && body.daily_state.seed_claimed === true);
        if (seedId !== SEED_ITEM_ID || seedCount <= 0 || !claimed) {
            fail('SWEET_POTATO_RESULT_UNKNOWN',
                `领种子结果待核对（种子 ${  seedId  } x${  seedCount  }，claimed=${  claimed  }），请刷新活动状态，不要重复提交`);
        }
        const after = await getSweetPotatoActivity();
        return { status: 'confirmed', seed: { id: seedId, count: seedCount }, bag: after.bag, activity: after };
    });
}

async function sellSweetPotato(input) {
    const options = input || {};
    const count = toNum(options.count);
    const targetGid = options.targetGid ? String(options.targetGid) : '';
    const expectedUnitPrice = options.expectedUnitPrice === undefined || options.expectedUnitPrice === null
        ? 0
        : toNum(options.expectedUnitPrice);
    if (!Number.isSafeInteger(count) || count < 1) {
        fail('INVALID_SWEET_POTATO_SALE', '出售数量无效（需要 ≥1 的整数）');
    }
    return withMutationLock(async () => {
        const before = await getSweetPotatoActivity();
        if (!before.active) {
            fail('SWEET_POTATO_INACTIVE', `出售失败：活动当前阶段 ${  before.phase}`);
        }
        const quote = await getSweetPotatoShop(targetGid || undefined);
        if (!quote.canSell) {
            fail('SWEET_POTATO_SALE_UNAVAILABLE', '该铺子当前不接受蜜薯');
        }
        if (expectedUnitPrice > 0 && quote.unitPrice !== expectedUnitPrice) {
            fail('SWEET_POTATO_PRICE_CHANGED',
                `收购价已变化（提交时 ${  expectedUnitPrice  }，当前 ${  quote.unitPrice  }），请刷新后重新确认`);
        }
        if (targetGid && count > quote.remainQuota) {
            fail('SWEET_POTATO_QUOTA_CHANGED', `好友铺子剩余接收额度不足（剩余 ${  quote.remainQuota  }）`);
        }
        // 写前重新读背包：活动状态里的 bag 可能因缓存/失败而为 0，不能作为唯一依据
        const bag = await readBagCounts();
        if (count > bag.crop) {
            fail('SWEET_POTATO_STOCK_CHANGED', `可用蜜薯不足（背包 ${  bag.crop  }，本次 ${  count  }）`);
        }
        const reply = await rpc('Operate', 'SweetPotatoOperateRequest', {
            id: ACTIVITY_ID,
            cmd: 93,
            maple_market_sell: { target_gid: quote.targetGid, sell_count: count },
        }, 'SweetPotatoOperateReply');
        if (toNum(reply.cmd) !== 93) {
            fail('SWEET_POTATO_RESULT_UNKNOWN', `出售回包 cmd 不匹配（期望 93，实际 ${  toNum(reply.cmd)  }）`);
        }
        const result = reply.maple_market_sell;
        if (!result) {
            fail('SWEET_POTATO_RESULT_UNKNOWN', '出售回包缺少结果（字段 193 未命中，请核对协议）');
        }
        const sold = toNum(result.sold_count);
        const unitPrice = toNum(result.final_price);
        const income = toNum(result.activity_coin_income);
        const coinBalance = toNum(result.activity_coin);
        const body = reply.data && reply.data.maple_market ? reply.data.maple_market : null;
        const consistent = sold === count
            && unitPrice > 0
            && income === sold * unitPrice
            && !!body
            && toNum(body.activity_coin) === coinBalance;
        if (!consistent) {
            fail('SWEET_POTATO_RESULT_UNKNOWN',
                `出售结果待核对（成交 ${  sold  }，单价 ${  unitPrice  }，收入 ${  income  }），请刷新活动状态后再决定是否重试`);
        }
        const after = await getSweetPotatoActivity();
        return {
            status: 'confirmed',
            sold,
            unitPrice,
            income,
            coinBalance,
            remainQuota: targetGid ? toNum(result.remain_quota) : null,
            bag: after.bag,
            activity: after,
        };
    });
}

// 红薯作物 ID（抓包确认：seed 20307 → plant 1020307）
const SWEET_POTATO_PLANT_ID = 1020307;

async function plantSweetPotato(input) {
    const options = input || {};
    const maxCount = options.maxCount ? Math.max(1, toNum(options.maxCount)) : 0;
    return withMutationLock(async () => {
        const before = await getSweetPotatoActivity();
        if (!before.active) {
            fail('SWEET_POTATO_INACTIVE', `种植失败：活动当前阶段 ${  before.phase}`);
        }
        if (before.bag.seed <= 0) {
            return { status: 'skipped', reason: 'no_seed', activity: before };
        }
        const { lands } = await farmApi.getAllLands();
        const list = Array.isArray(lands) ? lands : [];
        const analysis = analyzeLands(list);
        let emptyIds = analysis.empty.slice();
        if (Array.isArray(options.landIds) && options.landIds.length) {
            const allowed = new Set(emptyIds);
            emptyIds = options.landIds.map((id) => toNum(id)).filter((id) => allowed.has(id));
        }
        if (!emptyIds.length) {
            return { status: 'skipped', reason: 'no_empty_land', activity: before };
        }
        const want = Math.min(maxCount > 0 ? maxCount : emptyIds.length, before.bag.seed);
        const result = await plantSeeds(SEED_ITEM_ID, emptyIds.slice(0, want), { maxPlantCount: want });
        if (!result.planted) {
            fail('SWEET_POTATO_PLANT_FAILED', '红薯播种未确认（0 块成功），请刷新土地状态后再试');
        }
        const after = await getSweetPotatoActivity();
        return {
            status: 'confirmed',
            planted: result.planted,
            landIds: result.plantedLandIds,
            seedLeft: after.bag.seed,
            activity: after,
        };
    });
}

async function harvestSweetPotato() {
    return withMutationLock(async () => {
        const before = await getSweetPotatoActivity();
        if (!before.active) {
            fail('SWEET_POTATO_INACTIVE', `收获失败：活动当前阶段 ${  before.phase}`);
        }
        const { lands } = await farmApi.getAllLands();
        const list = Array.isArray(lands) ? lands : [];
        const ownIds = new Set(
            list.filter((land) => land && land.plant && toNum(land.plant.id) === SWEET_POTATO_PLANT_ID)
                .map((land) => toNum(land.id)),
        );
        const analysis = analyzeLands(list);
        const targets = analysis.harvestable.filter((id) => ownIds.has(toNum(id)));
        const deadIds = analysis.dead.filter((id) => ownIds.has(toNum(id)));
        let removed = 0;
        if (deadIds.length) {
            await farmApi.removePlant(deadIds);
            removed = deadIds.length;
        }
        if (!targets.length) {
            return {
                status: 'skipped',
                reason: removed ? 'only_dead_removed' : 'nothing_mature',
                removed,
                activity: before,
            };
        }
        // 不用 farmApi.harvest：它硬编码 is_all=true，可能把全部成熟作物一起收掉。
        // 这里显式 is_all=false + 只传红薯地块，避免动到其他作物。
        // 用 farmApi.harvest：现网验证过的写法（is_all=true + 明确 land_ids）。
        // 之前用 is_all=false，服务端不认，地块原样保留。
        const harvestReply = await farmApi.harvest(targets);
        const replyLands = Array.isArray(harvestReply && harvestReply.land) ? harvestReply.land : [];
        const replyIds = new Set(replyLands.map((land) => toNum(land && land.id)).filter(Boolean));
        const covered = targets.every((id) => replyIds.has(toNum(id)));
        // 以服务端最新土地状态确认收获，不依赖回包结构
        // 收获后服务端常保留空壳植物，要再铲一次才真正腾出地块（自动化里也是这么做的）
        let cleaned = 0;
        try {
            const latest = await farmApi.getAllLands();
            const latestList = Array.isArray(latest && latest.lands) ? latest.lands : [];
            const leftovers = latestList
                .filter((land) => land && land.plant && toNum(land.plant.id) === SWEET_POTATO_PLANT_ID)
                .map((land) => toNum(land.id))
                .filter((id) => targets.includes(id));
            if (leftovers.length) {
                await farmApi.removePlant(leftovers);
                cleaned = leftovers.length;
            }
        } catch {
            cleaned = 0;
        }
        const after = await getSweetPotatoActivity();
        const cropGain = after.bag.crop - before.bag.crop;
        // 判定：蜜薯有增加，或回包覆盖了全部目标地块；两者都不成立才算未确认
        if (cropGain <= 0 && !covered) {
            fail('SWEET_POTATO_RESULT_UNKNOWN',
                `红薯收获状态未确认（蜜薯未增加；回包地块 ${  [...replyIds].join(',')  }，目标 ${  targets.join(',')  }），请刷新后再决定是否重试`);
        }
        return {
            status: 'confirmed',
            harvested: targets.length,
            landIds: targets,
            removed,
            cleaned,
            cropGain,
            bag: after.bag,
            activity: after,
        };
    });
}

// ---------- 兑换商店 / 收购记录 / 佣金 ----------

function itemDto(row) {
    const id = toNum(row && row.id);
    const info = getItemById(id) || {};
    return {
        id,
        count: toNum(row && row.count),
        name: String(info.name || ''),
        image: getItemImageById(id) || '',
    };
}

// 商品名提示：来自另一份实现的抓包配置（1~6），仅用于展示用；
// 真实获得物以兑换回包的 items 为准。
const GOODS_HINTS = {
    1: { name: '盆栽·七色花弦', items: [{ id: 204013, count: 1 }] },
    2: { name: '福气金豆礼包', items: [{ id: 101627, count: 1 }] },
    3: { name: '金币果种子', items: [{ id: 20522, count: 1 }] },
    4: { name: '经验蘑菇种子', items: [{ id: 20523, count: 1 }] },
    5: { name: '有机化肥(1小时)', items: [{ id: 80011, count: 1 }] },
    6: { name: '南瓜种子礼包', items: [{ id: 101620, count: 1 }] },
};

async function getGoodsCatalog() {
    const reply = await rpc('Operate', 'SweetPotatoOperateRequest', {
        id: ACTIVITY_ID,
        cmd: 97,
        maple_market_get_goods_list: {},
    }, 'SweetPotatoOperateReply');
    if (toNum(reply.cmd) !== 97) {
        fail('SWEET_POTATO_RESULT_UNKNOWN', `商品目录回包 cmd 不匹配（期望 97，实际 ${  toNum(reply.cmd)  }）`);
    }
    const result = reply.maple_market_get_goods_list;
    if (!result) {
        fail('SWEET_POTATO_RESULT_UNKNOWN', '回包缺少 maple_market_get_goods_list（字段 197 未命中，请核对协议）');
    }
    const goods = (Array.isArray(result.goods) ? result.goods : []).map((row) => {
        const limitType = toNum(row.limit_type);
        const purchased = toNum(limitType === 1 ? row.purchased_daily : row.purchased_total);
        const limitTimes = limitType > 0 ? toNum(row.limit_times) : null;
        const goodsId = toNum(row.goods_id);
        const hint = GOODS_HINTS[goodsId] || null;
        return {
            id: goodsId,
            name: hint ? hint.name : '',
            items: hint ? hint.items.map(itemDto) : [],
            price: toNum(row.activity_coin_price),
            limitType,
            limitTimes,
            purchased,
            remaining: limitTimes === null ? null : Math.max(0, limitTimes - purchased),
            exchangeable: row.exchangeable === true,
        };
    });
    return { goods, coinBalance: toNum(result.activity_coin) };
}

async function exchangeSweetPotatoGoods(input) {
    const options = input || {};
    const goodsId = toNum(options.goodsId);
    const count = toNum(options.count);
    if (!goodsId) fail('INVALID_SWEET_POTATO_GOODS', '商品 ID 无效');
    if (!Number.isSafeInteger(count) || count < 1) fail('INVALID_SWEET_POTATO_GOODS', '兑换数量无效（需要 ≥1 的整数）');
    return withMutationLock(async () => {
        const before = await getSweetPotatoActivity();
        if (!before.active) fail('SWEET_POTATO_INACTIVE', `兑换失败：活动当前阶段 ${  before.phase}`);
        const catalog = await getGoodsCatalog();
        const goods = catalog.goods.find((row) => row.id === goodsId);
        if (!goods) fail('SWEET_POTATO_GOODS_NOT_FOUND', `商品 ${  goodsId  } 不在当前目录中`);
        // 不把 exchangeable 当硬门禁：该位由服务端按余额/限购即时计算，可能滞后。
        // 余额与限购在下面本地预检，真正的拒绝交给服务端。
        if (goods.remaining !== null && count > goods.remaining) {
            fail('SWEET_POTATO_GOODS_LIMIT', `兑换数量超出限购（剩余 ${  goods.remaining  }）`);
        }
        const cost = goods.price * count;
        if (cost > catalog.coinBalance) {
            fail('SWEET_POTATO_COIN_NOT_ENOUGH', `福气币不足（需要 ${  cost  }，当前 ${  catalog.coinBalance  }）`);
        }
        const reply = await rpc('Operate', 'SweetPotatoOperateRequest', {
            id: ACTIVITY_ID,
            cmd: 96,
            maple_market_exchange: { goods_id: goodsId, exchange_count: count },
        }, 'SweetPotatoOperateReply');
        if (toNum(reply.cmd) !== 96) {
            fail('SWEET_POTATO_RESULT_UNKNOWN', `兑换回包 cmd 不匹配（期望 96，实际 ${  toNum(reply.cmd)  }）`);
        }
        const result = reply.maple_market_exchange;
        if (!result) {
            fail('SWEET_POTATO_RESULT_UNKNOWN', '回包缺少 maple_market_exchange（字段 196 未命中，请核对协议）');
        }
        const paid = toNum(result.activity_coin_cost);
        const items = (Array.isArray(result.items) ? result.items : []).map(itemDto);
        const balance = toNum(result.activity_coin);
        const consistent = paid === cost && items.length > 0 && balance === catalog.coinBalance - cost;
        if (!consistent) {
            fail('SWEET_POTATO_RESULT_UNKNOWN',
                `兑换结果待核对（花费 ${  paid  }，期望 ${  cost  }，余额 ${  balance  }），请刷新活动状态后再决定是否重试`);
        }
        return { status: 'confirmed', goodsId, count, cost: paid, items, coinBalance: balance };
    });
}

async function getSweetPotatoPurchaseLog() {
    const reply = await rpc('Operate', 'SweetPotatoOperateRequest', {
        id: ACTIVITY_ID,
        cmd: 95,
        maple_market_get_purchase_log: {},
    }, 'SweetPotatoOperateReply');
    if (toNum(reply.cmd) !== 95) {
        fail('SWEET_POTATO_RESULT_UNKNOWN', `收购记录回包 cmd 不匹配（期望 95，实际 ${  toNum(reply.cmd)  }）`);
    }
    const result = reply.maple_market_get_purchase_log;
    if (!result) {
        fail('SWEET_POTATO_RESULT_UNKNOWN', '回包缺少 maple_market_get_purchase_log（字段 195 未命中，请核对协议）');
    }
    const records = (Array.isArray(result.records) ? result.records : []).map((row) => ({
        timestamp: toNum(row.timestamp) * 1000,
        sellerGid: String(row.seller_gid || ''),
        sellerName: String(row.seller_name || ''),
        sellerLevel: toNum(row.seller_level),
        soldCount: toNum(row.sold_count),
        income: toNum(row.income),
        commission: toNum(row.commission),
    }));
    return { records };
}

async function claimSweetPotatoCommission() {
    return withMutationLock(async () => {
        const before = await getSweetPotatoActivity();
        if (!before.active) fail('SWEET_POTATO_INACTIVE', `领取佣金失败：活动当前阶段 ${  before.phase}`);
        if (before.pendingCommission.coin <= 0) {
            return { status: 'skipped', reason: 'nothing_pending', activity: before };
        }
        const pendingCoin = before.pendingCommission.coin;
        const pendingCount = before.pendingCommission.count;
        const reply = await rpc('Operate', 'SweetPotatoOperateRequest', {
            id: ACTIVITY_ID,
            cmd: 99,
        }, 'SweetPotatoOperateReply');
        if (toNum(reply.cmd) !== 99) {
            fail('SWEET_POTATO_RESULT_UNKNOWN', `领取佣金回包 cmd 不匹配（期望 99，实际 ${  toNum(reply.cmd)  }）`);
        }
        const result = reply.maple_market_claim_commission;
        if (!result) {
            fail('SWEET_POTATO_RESULT_UNKNOWN', '回包缺少 maple_market_claim_commission（字段 199 未命中，请核对协议）');
        }
        const claimed = toNum(result.claimed_coin);
        const balance = toNum(result.activity_coin);
        const consistent = claimed > 0 && claimed <= pendingCoin && balance >= before.coinBalance + claimed;
        if (!consistent) {
            fail('SWEET_POTATO_RESULT_UNKNOWN',
                `佣金领取结果待核对（claimed ${  claimed  }，待领 ${  pendingCoin  }，余额 ${  balance  }），请刷新后再决定是否重试`);
        }
        const after = await getSweetPotatoActivity();
        return { status: 'confirmed', claimed, claimedCount: toNum(result.claimed_count), pendingCount, coinBalance: after.coinBalance, activity: after };
    });
}

async function getSweetPotatoFriendShops(input) {
    const options = input || {};
    const limit = Math.min(Math.max(1, toNum(options.limit) || 5), 10);
    const offset = Math.max(0, toNum(options.offset) || 0);
    const raw = await getFriendsList();
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw && raw.friends) ? raw.friends : []);
    const selfGid = String((getUserState() || {}).gid || '');
    const seen = new Set();
    const friends = [];
    for (const row of list) {
        const gid = String((row && (row.gid || row.gid_str)) || '');
        if (!gid || gid === selfGid || seen.has(gid)) continue;
        seen.add(gid);
        friends.push({ gid, name: String((row && (row.name || row.nick)) || ''), avatar: String((row && (row.avatar_url || row.avatar)) || '') });
    }
    const page = friends.slice(offset, offset + limit);
    const shops = [];
    for (const friend of page) {
        try {
            const quote = await getSweetPotatoShop(friend.gid);
            shops.push({ ...quote, name: friend.name || quote.owner.name || '', avatar: friend.avatar });
        } catch (error) {
            shops.push({
                targetGid: friend.gid,
                name: friend.name,
                avatar: friend.avatar,
                unitPrice: null,
                canSell: false,
                available: false,
                error: (error && error.message) || '无法读取该铺子',
            });
        }
    }
    shops.sort((left, right) => (right.unitPrice || 0) - (left.unitPrice || 0));
    return { shops, total: friends.length, offset, limit, hasMore: offset + limit < friends.length };
}

// ---------- 自动化（默认全关，需显式开启 sweet_potato 才生效） ----------

const AUTO_SELL_INTERVAL_MS = 5 * 60 * 1000;
let lastAutoSellAt = 0;

function autoPartEnabled(part) {
    const store = require('../models/store');
    const automation = (typeof store.getAutomation === 'function' ? store.getAutomation() : {}) || {};
    if (automation.sweet_potato !== true) return false;
    if (part && automation[`sweet_potato_${  part}`] === false) return false;
    return true;
}

async function autoPlantSweetPotato(emptyLandIds) {
    const list = Array.isArray(emptyLandIds) ? emptyLandIds.map((id) => toNum(id)).filter(Boolean) : [];
    const skipped = { planted: 0, plantedLandIds: [], remainingLandIds: list };
    if (!list.length || !autoPartEnabled('plant')) return skipped;
    const activity = await getSweetPotatoActivity();
    if (!activity.active || activity.bag.seed <= 0) return skipped;
    const want = Math.min(list.length, activity.bag.seed);
    const result = await plantSeeds(SEED_ITEM_ID, list.slice(0, want), { maxPlantCount: want });
    const plantedIds = (result.plantedLandIds || []).map((id) => toNum(id));
    return {
        planted: result.planted || 0,
        plantedLandIds: plantedIds,
        remainingLandIds: list.filter((id) => !plantedIds.includes(id)),
    };
}

async function autoClaimSweetPotatoSeed() {
    if (!autoPartEnabled('claim')) return null;
    const activity = await getSweetPotatoActivity();
    if (!activity.active || activity.seedClaimed) return null;
    return claimSweetPotatoSeed();
}

// 好友铺子报价缓存：自动化每 5 分钟才查一次，避免频繁打 92
let bestShopCache = null;

/** 从好友铺子里挑一个「单价高于自家 + 额度够」的最优铺子；没有就返回 null。 */
async function pickBestShop(count, ownUnitPrice) {
    const now = getServerTimeSec() * 1000;
    if (bestShopCache && now - bestShopCache.at < 5 * 60 * 1000) {
        const cached = bestShopCache.shop;
        if (!cached) return null;
        if (cached.unitPrice > ownUnitPrice && (cached.remainQuota == null || cached.remainQuota >= count)) return cached;
        return null;
    }
    let best = null;
    try {
        const page = await getSweetPotatoFriendShops({ limit: 10, offset: 0 });
        for (const shop of page.shops) {
            if (!shop || shop.available === false) continue;
            if (shop.unitPrice === null || shop.unitPrice === undefined) continue;
            if (shop.canSell !== true) continue;
            if (shop.unitPrice <= ownUnitPrice) continue;
            if (shop.remainQuota !== null && shop.remainQuota !== undefined && shop.remainQuota < count) continue;
            if (!best || shop.unitPrice > best.unitPrice) best = shop;
        }
    } catch {
        best = null;
    }
    bestShopCache = { at: now, shop: best };
    return best;
}

async function autoSellSweetPotato() {
    if (!autoPartEnabled('sell')) return null;
    const now = getServerTimeSec() * 1000;
    if (now - lastAutoSellAt < AUTO_SELL_INTERVAL_MS) return null;
    const activity = await getSweetPotatoActivity();
    if (!activity.active || activity.bag.crop <= 0) return null;
    lastAutoSellAt = now;
    const count = activity.bag.crop;
    // 先找好友高价铺子；找不到或不如自家，就卖自家（不限量）
    let best = null;
    try {
        best = await pickBestShop(count, activity.price.unit);
    } catch {
        best = null;
    }
    if (best) {
        try {
            return await sellSweetPotato({ count, targetGid: best.targetGid, expectedUnitPrice: best.unitPrice });
        } catch {
            // 好友铺子失败就退回自家，别让一轮失败卡住
            return sellSweetPotato({ count });
        }
    }
    return sellSweetPotato({ count });
}

/** 供农场巡田周期调用：领种子 + 卖蜜薯（内部有节流，失败不影响主流程）。 */
async function runSweetPotatoAutomation() {
    const result = { claim: null, sell: null, errors: [] };
    try {
        result.claim = await autoClaimSweetPotatoSeed();
    } catch (error) {
        result.errors.push(`claim: ${  error && error.message}`);
    }
    try {
        result.sell = await autoSellSweetPotato();
    } catch (error) {
        result.errors.push(`sell: ${  error && error.message}`);
    }
    return result;
}

module.exports = {
    getSweetPotatoActivity,
    getSweetPotatoShop,
    claimSweetPotatoSeed,
    sellSweetPotato,
    plantSweetPotato,
    harvestSweetPotato,
    getGoodsCatalog,
    exchangeSweetPotatoGoods,
    getSweetPotatoPurchaseLog,
    claimSweetPotatoCommission,
    getSweetPotatoFriendShops,
    autoPlantSweetPotato,
    runSweetPotatoAutomation,
    pickBestShop,
    autoPartEnabled,
};

