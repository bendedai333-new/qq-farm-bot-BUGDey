const {
  getAuthorizedAccountId,
  requireConnectedAccount,
} = require("./admin-activity-route-helpers");

function isQingmeiClaimAlreadyHandledError(err) {
  const message = String(err?.message || err || "");
  return message.includes("已领取")
    || message.includes("已经领取")
    || message.includes("重复领取")
    || message.includes("already");
}

function isQingmeiWineBusinessError(err) {
  const message = String(err?.message || err || "");
  return !!err?.qingmeiWine
    || message.includes("青梅酿")
    || message.includes("ActivityService.Operate")
    || message.includes("ShareService");
}

function registerAdminHeluActivityRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  const routeContext = {
    getAccountIdFromRequest,
    canAccessAccount,
  };

  // 以薯换福的业务拒绝（活动未开放 / 库存不足 / 价格变化）是可预期结果，按 400 返回，不当成服务器故障。
  function sendSweetPotatoError(res, err) {
    const code = err && err.code ? String(err.code) : '';
    if (code.startsWith('SWEET_POTATO_') || code.startsWith('INVALID_SWEET_POTATO')) {
      return res.status(400).json({ ok: false, code, error: err.message });
    }
    return sendProviderError(res, err);
  }

  app.get('/api/activity/rain-poem', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取雨落成诗失败: 账号未运行')) return;
      res.json({ ok: true, activity: await provider.getRainPoemActivity(accountId) });
    } catch (err) { sendProviderError(res, err); }
  });

  app.get('/api/activity/charity-flower', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取公益小红花失败: 账号未运行')) return;
      res.json({ ok: true, activity: await provider.getCharityFlowerActivity(accountId) });
    } catch (err) { sendProviderError(res, err); }
  });

  // 以薯换福（只读阶段）：活动状态 + 铺子收购价，不含任何写操作。
  app.get('/api/activity/sweet-potato', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取以薯换福失败: 账号未运行')) return;
      res.json({ ok: true, activity: await provider.getSweetPotatoActivity(accountId) });
    } catch (err) { sendProviderError(res, err); }
  });

  app.get('/api/activity/sweet-potato/shop', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '查询铺子报价失败: 账号未运行')) return;
      const gid = req.query.gid ? String(req.query.gid) : '';
      res.json({ ok: true, shop: await provider.getSweetPotatoShop(accountId, gid || undefined) });
    } catch (err) { sendProviderError(res, err); }
  });

  // 领每日红薯种子（cmd 91）。lead: 已领过会直接 skipped，不会重复提交。
  app.post('/api/activity/sweet-potato/claim-seed', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '领取红薯种子失败: 账号未运行')) return;
      res.json({ ok: true, data: await provider.claimSweetPotatoSeed(accountId) });
    } catch (err) { sendSweetPotatoError(res, err); }
  });

  // 出售蜜薯（cmd 93）。body: { count, targetGid?, expectedUnitPrice? }
  app.post('/api/activity/sweet-potato/sell', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '出售蜜薯失败: 账号未运行')) return;
      const body = req.body || {};
      res.json({
        ok: true,
        data: await provider.sellSweetPotato(accountId, {
          count: body.count,
          targetGid: body.targetGid,
          expectedUnitPrice: body.expectedUnitPrice,
        }),
      });
    } catch (err) { sendSweetPotatoError(res, err); }
  });

  // 把背包里的红薯种子种到空地（cmd 无关，走 PlantService.Plant）
  app.post('/api/activity/sweet-potato/plant', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '种植红薯失败: 账号未运行')) return;
      const body = req.body || {};
      res.json({ ok: true, data: await provider.plantSweetPotato(accountId, { maxCount: body.maxCount, landIds: body.landIds }) });
    } catch (err) { sendSweetPotatoError(res, err); }
  });

  // 收获成熟的红薯（顺带清掉枯死的红薯）
  app.post('/api/activity/sweet-potato/harvest', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '收获红薯失败: 账号未运行')) return;
      res.json({ ok: true, data: await provider.harvestSweetPotato(accountId) });
    } catch (err) { sendSweetPotatoError(res, err); }
  });

  // 兑换商店商品目录（cmd 97）
  app.get('/api/activity/sweet-potato/goods', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取兑换目录失败: 账号未运行')) return;
      res.json({ ok: true, data: await provider.getSweetPotatoGoods(accountId) });
    } catch (err) { sendSweetPotatoError(res, err); }
  });

  // 兑换商品（cmd 96）。body: { goodsId, count }
  app.post('/api/activity/sweet-potato/exchange', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '兑换失败: 账号未运行')) return;
      const body = req.body || {};
      res.json({ ok: true, data: await provider.exchangeSweetPotatoGoods(accountId, { goodsId: body.goodsId, count: body.count }) });
    } catch (err) { sendSweetPotatoError(res, err); }
  });

  // 收购记录（cmd 95）
  app.get('/api/activity/sweet-potato/purchase-log', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取收购记录失败: 账号未运行')) return;
      res.json({ ok: true, data: await provider.getSweetPotatoPurchaseLog(accountId) });
    } catch (err) { sendSweetPotatoError(res, err); }
  });

  // 领取佣金（cmd 99）
  app.post('/api/activity/sweet-potato/claim-commission', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '领取佣金失败: 账号未运行')) return;
      res.json({ ok: true, data: await provider.claimSweetPotatoCommission(accountId) });
    } catch (err) { sendSweetPotatoError(res, err); }
  });

  // 好友铺子收购价（分页，逐个查询）
  app.get('/api/activity/sweet-potato/friend-shops', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '查询好友铺子失败: 账号未运行')) return;
      res.json({
        ok: true,
        data: await provider.getSweetPotatoFriendShops(accountId, { limit: req.query.limit, offset: req.query.offset }),
      });
    } catch (err) { sendSweetPotatoError(res, err); }
  });

  app.get('/api/activity/pet-diary', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取萌宠日记失败: 账号未运行')) return;
      res.json({ ok: true, activity: await provider.getPetDiaryActivity(accountId) });
    } catch (err) { sendProviderError(res, err); }
  });

  // 萌宠成长日记（S3）完整状态与操作。上游为 /api/activity-center/pet-diary，
  // 本地统一挂在 /api/activity/ 前缀下。
  app.get('/api/activity/pet-diary/state', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取萌宠成长日记失败: 账号未运行')) return;
      res.json({ ok: true, data: await provider.getPetDiary(accountId) });
    } catch (err) { sendProviderError(res, err); }
  });

  app.get('/api/activity/pet-diary/records', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取萌宠日记记录失败: 账号未运行')) return;
      res.json({ ok: true, data: await provider.getPetDiaryRecords(accountId, req.query.kind) });
    } catch (err) { sendProviderError(res, err); }
  });

  app.get('/api/activity/pet-diary/friend', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取好友宝藏失败: 账号未运行')) return;
      res.json({ ok: true, data: await provider.getPetDiaryFriend(accountId, req.query.gid) });
    } catch (err) { sendProviderError(res, err); }
  });

  app.post('/api/activity/pet-diary/operate', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '萌宠日记操作失败: 账号未运行')) return;
      res.json({ ok: true, data: await provider.operatePetDiary(accountId, req.body?.action, req.body?.params) });
    } catch (err) { sendProviderError(res, err); }
  });

  app.post('/api/activity/rain-poem/bottle/buy', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '购买天气采集瓶失败: 账号未运行')) return;
      res.json(await provider.buyRainPoemCollectionBottle(accountId));
    } catch (err) { sendProviderError(res, err); }
  });

  app.post('/api/activity/rain-poem/collect', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '采集好友雷雨失败: 账号未运行')) return;
      res.json(await provider.collectRainPoemWeather(accountId));
    } catch (err) { sendProviderError(res, err); }
  });

  app.post('/api/activity/rain-poem/research/unlock', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '解锁气象研究失败: 账号未运行')) return;
      res.json(await provider.unlockRainPoemResearch(accountId));
    } catch (err) { sendProviderError(res, err); }
  });

  app.post('/api/activity/rain-poem/summon/use', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '使用雷雨召唤瓶失败: 账号未运行')) return;
      res.json(await provider.useRainPoemSummonBottle(accountId));
    } catch (err) { sendProviderError(res, err); }
  });

  app.get("/api/activity/star", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "获取心许千灯星垂野失败: 账号未运行"))
        return;
      res.json({ ok: true, activity: await provider.getStarActivity(accountId) });
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  app.post("/api/activity/star/records/claim", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "观星礼录领取失败: 账号未运行"))
        return;
      res.json(await provider.claimStarRecordRewards(accountId));
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  app.post("/api/activity/star/exchange", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "星砂商店兑换失败: 账号未运行"))
        return;

      const slotId = Number(req.body?.slotId) || 0;
      const count = Math.floor(Number(req.body?.count) || 0);
      if (slotId <= 0) {
        return res.status(400).json({ ok: false, error: "缺少有效的星砂商店槽位" });
      }
      if (count <= 0) {
        return res.status(400).json({ ok: false, error: "兑换数量必须大于 0" });
      }
      res.json(await provider.exchangeStarShopItem(accountId, slotId, count));
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  app.get("/api/activity/helu", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "获取奇遇礼莲失败: 账号未运行"))
        return;

      const activity = await provider.getHeluActivity(accountId);
      res.json({
        ok: true,
        activity,
      });
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  app.post("/api/activity/helu/draw", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "奇遇礼莲抽奖失败: 账号未运行"))
        return;

      const result = await provider.drawHeluGiftLotus(accountId, req.body || {});
      res.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  app.post("/api/activity/helu/passport/claim", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "荷风游记领取失败: 账号未运行"))
        return;

      const result = await provider.claimSeasonPassportRewards(accountId);
      const activity = await provider.getHeluActivity(accountId);
      res.json({
        ok: true,
        ...result,
        activity,
      });
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  app.post("/api/activity/star/passport/claim", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "千星游记领取失败: 账号未运行"))
        return;
      const result = await provider.claimSeasonPassportRewards(accountId);
      res.json({ ok: true, ...result, activity: await provider.getStarActivity(accountId) });
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  app.post("/api/activity/helu/solar/claim", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "节令小札领取失败: 账号未运行"))
        return;

      const termId = Number(req.body?.termId) || 0;
      const result = await provider.claimSolarTermsReward(accountId, termId);
      const activity = await provider.getHeluActivity(accountId);
      res.json({
        ok: true,
        ...result,
        activity,
      });
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  app.post("/api/activity/star/solar/claim", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "节令小札领取失败: 账号未运行"))
        return;
      const result = await provider.claimSolarTermsReward(accountId, Number(req.body?.termId) || 0);
      res.json({ ok: true, ...result, activity: await provider.getStarActivity(accountId) });
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  app.post("/api/activity/helu/exchange", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "荷露商店兑换失败: 账号未运行"))
        return;

      const slotId = Number(req.body?.slotId) || 0;
      const count = Math.floor(Number(req.body?.count) || 0);
      if (count <= 0) {
        return res.status(400).json({ ok: false, error: "兑换数量必须大于 0" });
      }
      const result = await provider.exchangeHeluShopItem(accountId, slotId, count);
      res.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  app.post("/api/activity/qingmei/claim", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "领取青梅种子失败: 账号未运行"))
        return;

      const result = await provider.claimQingmeiSeeds(accountId);
      let activity = result.activity || null;
      if (!activity) {
        try {
          activity = await provider.getStarActivity(accountId);
        } catch {
          activity = null;
        }
      }
      res.json({
        ok: true,
        ...result,
        activity,
        qingmei: result.qingmei || activity?.qingmei || null,
      });
    } catch (err) {
      if (isQingmeiClaimAlreadyHandledError(err)) {
        let activity = null;
        try {
          activity = await provider.getStarActivity(accountId);
        } catch {
          activity = null;
        }
        res.json({
          ok: true,
          alreadyClaimed: true,
          claimedCount: 0,
          activity,
          qingmei: activity?.qingmei || {
            claimed: true,
            claimable: false,
          },
        });
        return;
      }
      sendProviderError(res, err);
    }
  });

  app.post("/api/activity/qingmei/wine/sell", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "青梅酿售卖失败: 账号未运行"))
        return;

      const result = await provider.brewAndSellQingmeiWine(accountId, req.body || {});
      res.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      if (isQingmeiWineBusinessError(err)) {
        let activity = null;
        try {
          activity = await provider.getStarActivity(accountId);
        } catch {
          activity = null;
        }
        res.json({
          ok: false,
          stage: err?.stage || '',
          error: err?.message || '青梅酿售卖失败',
          activity,
          qingmei: activity?.qingmei || null,
        });
        return;
      }
      sendProviderError(res, err);
    }
  });

  app.get("/api/activity/qixi", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, "获取鹊桥寄情失败: 账号未运行")) return;
      const [activity, friendReply] = await Promise.all([
        provider.getQixiActivity(accountId),
        provider.getFriends(accountId, false).catch(() => ({ friends: [] })),
      ]);
      const friends = Array.isArray(friendReply) ? friendReply
        : Array.isArray(friendReply?.friends) ? friendReply.friends
        : Array.isArray(friendReply?.game_friends) ? friendReply.game_friends : [];
      res.json({
        ok: true,
        activity,
        friends: friends.map(friend => ({
          gid: Number(friend?.gid) || 0,
          name: String(friend?.name || friend?.nickname || `好友${friend?.gid || ""}`),
          avatar: String(friend?.avatarUrl || friend?.avatar_url || friend?.avatar || ""),
          level: Number(friend?.level) || 0,
        })).filter(friend => friend.gid > 0),
      });
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  app.post("/api/activity/qixi/bridge/build", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, "驻建鹊桥失败: 账号未运行")) return;
      res.json(await provider.buildQixiBridge(accountId));
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  app.post("/api/activity/qixi/dew/use", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, "使用鹊羽灵露失败: 账号未运行")) return;
      res.json(await provider.useQixiDew(accountId, { limit: Number(req.body?.limit) || 0 }));
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  app.post("/api/activity/qixi/gift", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    const friendGid = Number(req.body?.friendGid) || 0;
    const count = Math.max(1, Math.floor(Number(req.body?.count) || 1));
    if (!friendGid) return res.status(400).json({ ok: false, error: "请选择有效好友" });
    try {
      if (!requireConnectedAccount(res, provider, accountId, "香囊赠送失败: 账号未运行")) return;
      res.json(await provider.sendQixiSachet(accountId, friendGid, count));
    } catch (err) {
      sendProviderError(res, err);
    }
  });
}

module.exports = { registerAdminHeluActivityRoutes };
