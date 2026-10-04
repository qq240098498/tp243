// 温控口径都集中在这里：超限段、断链、MKT、放行判定
const store = require('./store');

// 断链归因分类；其中「可豁免」分类经确认后，对应缺口才不计入放行判定
const GAP_CATEGORIES = ['设备离线', '探头切换', '人工漏记', '运输途中无信号', '待查'];
const EXEMPTIBLE_CATEGORIES = ['探头切换', '运输途中无信号'];

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

// 手工类来源（人工、补录）：同一探头同一时刻与自动记录冲突时，以手工类为准
function manualLike(source) {
  return source === '人工' || source === '补录';
}

function pickEffective(rows) {
  const picked = {};
  const order = [];
  for (const row of rows) {
    const key = row.probeId + '|' + row.at;
    if (picked[key] === undefined) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    const current = picked[key];
    if (!manualLike(current.source) && manualLike(row.source)) picked[key] = row;
  }
  return order.map((key) => picked[key]);
}

// 同一探头同一时刻既有自动记录又有手工更正时，以手工为准
function effectiveRecords(data, batchId) {
  return pickEffective(recordsOfBatch(data, batchId));
}

// 原始记录时间线：补录记录不参与——断链缺口按当时采的记录判定，补录不把断链抹掉
function originalEffectiveRecords(data, batchId) {
  return pickEffective(recordsOfBatch(data, batchId).filter((r) => r.source !== '补录'));
}

// 超限：连续超出上下限的时段，回到范围内即断开
function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
    if (out) {
      const previous = current;
      if (previous) {
        previous.endAt = row.at;
        previous.minutes += previous.lastGapMinutes || 0;
        previous.peakC = value > previous.peakC ? value : previous.peakC;
        previous.points += 1;
      } else {
        current = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1 };
        segments.push(current);
      }
      // 与上一条记录的间隔按固定记录间隔计
      current.lastGapMinutes = Number(settings.recordIntervalMinutes);
    } else {
      current = null;
    }
  }
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0 });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes: longest.minutes, longest, totalMinutes: total, segmentCount: segments.length };
}

function excursionStats(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const stats = segmentStats(rows, data.settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

// 断链：相邻两条原始记录（非补录）的时刻差超过门槛算一处，缺口时长按实际时刻差算。
// 补录不把断链抹掉：缺口一旦成立就保留「曾经断链」，只有登记为可豁免分类且经确认才不计入判定。
function chainGaps(data, batchId) {
  const settings = data.settings;
  const rows = originalEffectiveRecords(data, batchId);
  const backfills = data.records.filter((r) => r.batchId === batchId && r.source === '补录');
  const attributions = (data.gapAttributions || []).filter((a) => a.batchId === batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      const from = rows[i - 1].at;
      const to = rows[i].at;
      const attribution = attributions.find((a) => a.gapFrom === from && a.gapTo === to) || null;
      const exemptible = !!(attribution && EXEMPTIBLE_CATEGORIES.includes(attribution.category));
      const exempted = !!(attribution && attribution.confirmed && exemptible);
      gaps.push({
        from,
        to,
        minutes,
        backfillCount: backfills.filter((r) => r.at > from && r.at < to).length,
        attribution: attribution ? decorateGapAttribution(attribution) : null,
        exemptible,
        exempted,
        countsInDecision: !exempted,
      });
    }
  }
  const gapCount = gaps.length;
  const exemptedGapCount = gaps.filter((g) => g.exempted).length;
  return {
    gaps,
    gapCount,
    effectiveGapCount: gapCount - exemptedGapCount,
    exemptedGapCount,
    totalGapMinutes: gaps.reduce((acc, g) => acc + g.minutes, 0),
  };
}

function decorateGapAttribution(a) {
  return Object.assign({}, a, { exemptible: EXEMPTIBLE_CATEGORIES.includes(a.category) });
}

// MKT：平均动力学温度
function mktCelsius(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return 0;
  const sum = rows.reduce((acc, row) => acc + Number(row.temperatureC), 0);
  return store.round(sum / rows.length, 2);
}

// 探头校准有效期
function probeValidOn(probe, day) {
  if (!probe || !probe.calibratedUntil) return true;
  return String(day) <= String(probe.calibratedUntil);
}

function expiredProbes(data, batchId, day) {
  const rows = effectiveRecords(data, batchId);
  const bad = [];
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe) continue;
    if (!probeValidOn(probe, String(row.at).slice(0, 10))) {
      if (!bad.some((b) => b.probeCode === probe.code)) {
        bad.push({ probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil, at: row.at });
      }
    }
  }
  return bad;
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

function monthlyExcursionMinutes(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const firstAt = rows.length ? rows[0].at : '';
  const month = firstAt.slice(0, 7);
  const scoped = rows.filter((r) => String(r.at).slice(0, 7) === month);
  return segmentStats(scoped, data.settings).totalMinutes;
}

// 放行判定：最长超限、累计超限、断链、探头校准四条
function releaseCheck(data, batch) {
  const settings = data.settings;
  const stats = excursionStats(data, batch.id);
  const chain = chainGaps(data, batch.id);
  const accumulated = monthlyExcursionMinutes(data, batch.id);
  const expired = expiredProbes(data, batch.id, batch.loadedAt ? String(batch.loadedAt).slice(0, 10) : '');
  const conditions = [
    { key: 'longest', ok: stats.longestMinutes <= Number(settings.allowExcursionMinutes), value: stats.longestMinutes, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
    { key: 'total', ok: accumulated <= Number(settings.allowTotalExcursionMinutes), value: accumulated, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟' },
    { key: 'chain', ok: chain.effectiveGapCount === 0, value: chain.effectiveGapCount, limit: 0, text: '全程没有断链（登记为可豁免分类且经确认的缺口不计入）' },
  ];
  return {
    mkt: mktCelsius(data, batch.id),
    longestMinutes: stats.longestMinutes,
    totalMinutes: stats.totalMinutes,
    recordCount: stats.recordCount,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    chain,
    expiredProbes: expired,
    conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
  };
}

module.exports = {
  toDate,
  probeOf,
  recordsOfBatch,
  effectiveRecords,
  originalEffectiveRecords,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  monthlyExcursionMinutes,
  releaseCheck,
  decorateGapAttribution,
  GAP_CATEGORIES,
  EXEMPTIBLE_CATEGORIES,
};
