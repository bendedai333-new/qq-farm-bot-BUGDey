<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import { useToastStore } from '@/stores/toast'

interface SweetPotatoPrice {
  base: number
  boost: number
  unit: number
  rateBp: number
}

interface SweetPotatoActivity {
  name: string
  phase: string
  active: boolean
  startTime: number
  endTime: number
  seedClaimed: boolean
  shared: boolean
  coinBalance: number
  price: SweetPotatoPrice
  pendingCommission: { coin: number, count: number }
  bag: { seed: number, crop: number, coin: number }
  rules: string[]
}

interface SweetPotatoGoods {
  id: number
  name?: string
  items?: Array<{ id: number, name?: string, count: number }>
  price: number
  limitType: number
  limitTimes: number | null
  purchased: number
  remaining: number | null
  exchangeable: boolean
}

interface SweetPotatoShop {
  targetGid: string
  name?: string
  unitPrice: number | null
  basePrice?: number
  boostValue?: number
  remainQuota?: number | null
  canSell: boolean
  available?: boolean
  error?: string
}

interface PurchaseRecord {
  timestamp: number
  sellerName: string
  soldCount: number
  income: number
  commission: number
}

const toast = useToastStore()
const loading = ref(false)
const busy = ref('')
const activity = ref<SweetPotatoActivity | null>(null)
const goods = ref<SweetPotatoGoods[]>([])
const shops = ref<SweetPotatoShop[]>([])
const shopsTotal = ref(0)
const records = ref<PurchaseRecord[]>([])

const phaseText = computed(() => {
  const phase = activity.value?.phase || ''
  const map: Record<string, string> = { active: '进行中', upcoming: '未开始', settlement: '结算中', ended: '已结束' }
  return map[phase] || phase || '—'
})

const windowText = computed(() => {
  const a = activity.value
  if (!a || !a.startTime)
    return '—'
  const fmt = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false })
  return `${fmt(a.startTime)} ~ ${fmt(a.endTime)}`
})

async function run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  busy.value = label
  try {
    return await fn()
  }
  catch (error) {
    const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error
      || (error as Error)?.message || '请求失败'
    toast.error(message)
    return null
  }
  finally {
    busy.value = ''
  }
}

async function loadActivity() {
  const data = await run('status', async () => (await api.get('/api/activity/sweet-potato')).data)
  if (!data)
    return
  if (!data.ok) {
    toast.error(data.error || '读取失败')
    return
  }
  activity.value = data.activity as SweetPotatoActivity
}

async function loadGoods() {
  const data = await run('goods', async () => (await api.get('/api/activity/sweet-potato/goods')).data)
  if (data?.ok)
    goods.value = (data.data?.goods || []) as SweetPotatoGoods[]
}

async function loadShops() {
  const data = await run('shops', async () => (await api.get('/api/activity/sweet-potato/friend-shops', { params: { limit: 10, offset: 0 } })).data)
  if (!data?.ok)
    return
  shops.value = (data.data?.shops || []) as SweetPotatoShop[]
  shopsTotal.value = Number(data.data?.total || 0)
}

async function loadRecords() {
  const data = await run('records', async () => (await api.get('/api/activity/sweet-potato/purchase-log')).data)
  if (data?.ok)
    records.value = (data.data?.records || []) as PurchaseRecord[]
}

async function post(path: string, body: Record<string, unknown> = {}) {
  return run(path, async () => (await api.post(`/api/activity/sweet-potato${path}`, body)).data)
}

async function claimSeed() {
  const data = await post('/claim-seed')
  if (data?.ok) {
    toast.success(data.data?.status === 'confirmed' ? '已领取红薯种子' : '今日已领过')
    await loadActivity()
  }
  else if (data?.error) {
    toast.error(data.error)
  }
}

async function plantPotato() {
  const data = await post('/plant', { maxCount: 4 })
  if (data?.ok) {
    const detail = data.data
    if (detail?.status === 'confirmed')
      toast.success(`已种下 ${detail.planted} 块红薯`)
    else if (detail?.reason === 'no_empty_land')
      toast.warning('没有空地，先收一茬再来')
    else if (detail?.reason === 'no_seed')
      toast.warning('背包里没有红薯种子')
    else toast.info('没有可种的地块')
    await loadActivity()
  }
  else if (data?.error) {
    toast.error(data.error)
  }
}

async function harvestPotato() {
  const data = await post('/harvest')
  if (data?.ok) {
    const detail = data.data
    if (detail?.status === 'confirmed')
      toast.success(`收获 ${detail.harvested} 块，蜜薯 +${detail.cropGain || 0}`)
    else toast.info('没有成熟的红薯')
    await loadActivity()
  }
  else if (data?.error) {
    toast.error(data.error)
  }
}

// 当前可用的最高价好友铺子（单价高于自家且额度够卖完手里所有蜜薯）
const bestShop = computed(() => {
  const own = activity.value?.price?.unit ?? 0
  const count = activity.value?.bag?.crop ?? 0
  return shops.value
    .filter(shop => shop.canSell && typeof shop.unitPrice === 'number' && shop.unitPrice > own && (shop.remainQuota == null || shop.remainQuota >= count))
    .sort((left, right) => (right.unitPrice || 0) - (left.unitPrice || 0))[0] || null
})

async function sellToBest() {
  const count = activity.value?.bag?.crop || 0
  const shop = bestShop.value
  if (count <= 0) {
    toast.warning('没有蜜薯可卖')
    return
  }
  if (!shop) {
    toast.warning('没有比自家更划算的好友铺子')
    return
  }
  const data = await post('/sell', { count, targetGid: shop.targetGid, expectedUnitPrice: shop.unitPrice })
  if (data?.ok) {
    toast.success(`卖给 ${shop.name || '好友'} ${data.data.sold} 个，+${data.data.income} 福气币`)
    await loadActivity()
  }
  else if (data?.error) {
    toast.error(data.error)
  }
}

async function sellAll() {
  const count = activity.value?.bag?.crop || 0
  if (count <= 0) {
    toast.warning('没有蜜薯可卖')
    return
  }
  const data = await post('/sell', { count })
  if (data?.ok) {
    toast.success(`卖出 ${data.data.sold} 个，+${data.data.income} 福气币`)
    await loadActivity()
  }
  else if (data?.error) {
    toast.error(data.error)
  }
}

async function exchangeGoods(item: SweetPotatoGoods) {
  const label = item.name ? item.name : (`商品 #${item.id}`)
  const maxCount = item.remaining ?? 1
  const input = window.prompt(`兑换「${label}」数量（单价 ${item.price} 福气币，剩余 ${maxCount}）：`, '1')
  if (input === null)
    return
  const count = Number(input)
  if (!Number.isInteger(count) || count < 1) {
    toast.warning('请输入 ≥1 的整数')
    return
  }
  const cost = item.price * count
  if (!window.confirm(`确认花费 ${cost} 福气币兑换 ${count} 个「${label}」？`))
    return
  const data = await post('/exchange', { goodsId: item.id, count })
  if (data?.ok) {
    const items = (data.data?.items || []).map((row: { name?: string, id: number, count: number }) => `${row.name || (`#${row.id}`)} ×${row.count}`).join('、')
    toast.success(`兑换成功：${items || '已到账'}，花费 ${data.data?.cost}`)
    await Promise.all([loadActivity(), loadGoods()])
  }
  else if (data?.error) {
    toast.error(data.error)
  }
}

async function claimCommission() {
  const data = await post('/claim-commission')
  if (data?.ok) {
    toast.success(data.data?.status === 'confirmed' ? `已领取佣金 ${data.data.claimed}` : '没有待领佣金')
    await loadActivity()
  }
  else if (data?.error) {
    toast.error(data.error)
  }
}

onMounted(async () => {
  loading.value = true
  await loadActivity()
  await Promise.all([loadGoods(), loadShops(), loadRecords()])
  loading.value = false
})
</script>

<template>
  <div class="flex flex-col gap-4 p-4">
    <section class="border rounded-xl p-4" style="background: var(--theme-card, #ffffff)">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-semibold">
            {{ activity?.name || '以薯换福' }}
            <span class="ml-2 rounded px-2 py-0.5 text-xs" style="background: #e8f5e9; color: #2e7d32">{{ phaseText }}</span>
          </h1>
          <p class="mt-1 text-xs opacity-60">
            {{ windowText }}
          </p>
        </div>
        <div class="flex gap-2">
          <button class="border rounded-lg px-3 py-1.5 text-sm" :disabled="!!busy" @click="loadActivity">
            刷新
          </button>
          <button class="rounded-lg px-3 py-1.5 text-sm text-white" style="background: #2e7d32" :disabled="!!busy" @click="claimSeed">
            领种子
          </button>
        </div>
      </div>

      <div class="grid grid-cols-2 mt-4 gap-3 text-sm md:grid-cols-4">
        <div class="rounded-lg p-3" style="background: #f6f8f6">
          <div class="text-xs opacity-60">
            自家收购价
          </div>
          <div class="text-lg font-semibold">
            {{ activity?.price?.unit ?? '—' }}
          </div>
          <div class="text-xs opacity-60">
            基础 {{ activity?.price?.base ?? 0 }} + 暴击 {{ activity?.price?.boost ?? 0 }}
          </div>
        </div>
        <div class="rounded-lg p-3" style="background: #f6f8f6">
          <div class="text-xs opacity-60">
            福气币
          </div>
          <div class="text-lg font-semibold">
            {{ activity?.coinBalance ?? 0 }}
          </div>
          <div class="text-xs opacity-60">
            待领佣金 {{ activity?.pendingCommission?.coin ?? 0 }}
          </div>
        </div>
        <div class="rounded-lg p-3" style="background: #f6f8f6">
          <div class="text-xs opacity-60">
            红薯种子
          </div>
          <div class="text-lg font-semibold">
            {{ activity?.bag?.seed ?? 0 }}
          </div>
          <div class="text-xs opacity-60">
            {{ activity?.seedClaimed ? '今日已领' : '今日未领' }}
          </div>
        </div>
        <div class="rounded-lg p-3" style="background: #f6f8f6">
          <div class="text-xs opacity-60">
            蜜薯
          </div>
          <div class="text-lg font-semibold">
            {{ activity?.bag?.crop ?? 0 }}
          </div>
          <div class="text-xs opacity-60">
            {{ activity?.shared ? '今日已分享' : '今日未分享' }}
          </div>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap gap-2">
        <button class="border rounded-lg px-3 py-1.5 text-sm" :disabled="!!busy" @click="plantPotato">
          种植红薯（最多 4 块）
        </button>
        <button class="border rounded-lg px-3 py-1.5 text-sm" :disabled="!!busy" @click="harvestPotato">
          收获红薯
        </button>
        <button class="border rounded-lg px-3 py-1.5 text-sm" :disabled="!!busy" @click="sellAll">
          出售全部蜜薯（自家）
        </button>
        <button
          v-if="bestShop"
          class="rounded-lg px-3 py-1.5 text-sm text-white"
          style="background: #1565c0"
          :disabled="!!busy"
          @click="sellToBest"
        >
          卖最高价 {{ bestShop.name || '好友' }}（{{ bestShop.unitPrice }}）
        </button>
        <button class="border rounded-lg px-3 py-1.5 text-sm" :disabled="!!busy" @click="claimCommission">
          领取佣金
        </button>
      </div>
      <p v-if="busy" class="mt-2 text-xs opacity-60">
        正在执行：{{ busy }}…
      </p>
      <p v-if="loading" class="mt-2 text-xs opacity-60">
        加载中…
      </p>
    </section>

    <section class="border rounded-xl p-4" style="background: var(--theme-card, #ffffff)">
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">
          好友铺子收购价
        </h2>
        <button class="border rounded px-2 py-1 text-xs" :disabled="!!busy" @click="loadShops">
          重新查询（共 {{ shopsTotal }} 位好友）
        </button>
      </div>
      <table class="mt-3 w-full text-sm">
        <thead class="text-xs opacity-60">
          <tr>
            <th class="py-1 text-left">
              好友
            </th>
            <th class="text-right">
              基础
            </th>
            <th class="text-right">
              暴击
            </th>
            <th class="text-right">
              单价
            </th>
            <th class="text-right">
              剩余额度
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="shop in shops" :key="shop.targetGid" class="border-t">
            <td class="py-1">
              {{ shop.name || shop.targetGid }}
              <span v-if="shop.error" class="text-xs" style="color: #d32f2f">（{{ shop.error }}）</span>
            </td>
            <td class="text-right">
              {{ shop.basePrice ?? '—' }}
            </td>
            <td class="text-right">
              {{ shop.boostValue ?? '—' }}
            </td>
            <td class="text-right font-medium">
              {{ shop.unitPrice ?? '—' }}
            </td>
            <td class="text-right">
              {{ shop.remainQuota ?? '—' }}
            </td>
          </tr>
          <tr v-if="!shops.length">
            <td colspan="5" class="py-3 text-center text-xs opacity-60">
              暂无数据
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="border rounded-xl p-4" style="background: var(--theme-card, #ffffff)">
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">
          兑换商店
        </h2>
        <button class="border rounded px-2 py-1 text-xs" :disabled="!!busy" @click="loadGoods">
          刷新目录
        </button>
      </div>
      <table class="mt-3 w-full text-sm">
        <thead class="text-xs opacity-60">
          <tr>
            <th class="py-1 text-left">
              商品
            </th>
            <th class="text-right">
              价格
            </th>
            <th class="text-right">
              限购
            </th>
            <th class="text-right">
              剩余
            </th>
            <th class="text-right">
              状态
            </th>
            <th class="text-right">
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in goods" :key="item.id" class="border-t">
            <td class="py-1">
              {{ item.name || (`#${item.id}`) }}
            </td>
            <td class="text-right">
              {{ item.price }}
            </td>
            <td class="text-right">
              {{ item.limitTimes ?? '—' }}
            </td>
            <td class="text-right">
              {{ item.remaining ?? '—' }}
            </td>
            <td class="text-right text-xs">
              {{ item.exchangeable ? '可兑换' : '不可兑换' }}
            </td>
            <td class="text-right">
              <button
                class="border rounded px-2 py-0.5 text-xs"
                :disabled="!!busy || (item.remaining !== null && item.remaining <= 0)"
                @click="exchangeGoods(item)"
              >
                兑换
              </button>
            </td>
          </tr>
          <tr v-if="!goods.length">
            <td colspan="6" class="py-3 text-center text-xs opacity-60">
              暂无数据
            </td>
          </tr>
        </tbody>
      </table>
      <p class="mt-2 text-xs opacity-50">
        兑换会真实消耗福气币，点击后会先确认数量与总价；实际获得物以服务端回包为准，展示的商品名来自抓包提示（1~6），7 号以后只显示编号。
      </p>
    </section>

    <section class="border rounded-xl p-4" style="background: var(--theme-card, #ffffff)">
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">
          收购记录
        </h2>
        <button class="border rounded px-2 py-1 text-xs" :disabled="!!busy" @click="loadRecords">
          刷新
        </button>
      </div>
      <table class="mt-3 w-full text-sm">
        <thead class="text-xs opacity-60">
          <tr>
            <th class="py-1 text-left">
              时间
            </th>
            <th class="text-left">
              买家
            </th>
            <th class="text-right">
              数量
            </th>
            <th class="text-right">
              收入
            </th>
            <th class="text-right">
              分红
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in records" :key="index" class="border-t">
            <td class="py-1 text-xs">
              {{ new Date(row.timestamp).toLocaleString('zh-CN', { hour12: false }) }}
            </td>
            <td>{{ row.sellerName || '—' }}</td>
            <td class="text-right">
              {{ row.soldCount }}
            </td>
            <td class="text-right">
              {{ row.income }}
            </td>
            <td class="text-right">
              {{ row.commission }}
            </td>
          </tr>
          <tr v-if="!records.length">
            <td colspan="5" class="py-3 text-center text-xs opacity-60">
              还没有收购记录
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="activity?.rules?.length" class="border rounded-xl p-4" style="background: var(--theme-card, #ffffff)">
      <h2 class="mb-2 font-semibold">
        活动规则
      </h2>
      <p v-for="(line, index) in activity.rules" :key="index" class="text-xs leading-6 opacity-80">
        {{ line }}
      </p>
    </section>
  </div>
</template>
