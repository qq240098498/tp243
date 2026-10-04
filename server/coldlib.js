// 温控口径都集中在这里：超限段、断链、MKT、放行判定
const store = require('./store');

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

// 同一探头同一时刻既有自动记录又有手工更正时，以手工为准
function effectiveRecords(data, batchId) {
  const rows = recordsOfBatch(data, batchId);
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
    if (current.source === '人工' && row.source === '自动') picked[key] = row;
  }
  return order.map((key) => picked[key]);
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

// 断链归因分类：五选一；其中「探头切换、运输途中无信号」属可豁免分类，
// 登记依据并经确认之后该缺口不再参与放行判定，其余分类登记了也仍然参与
const GAP_CATEGORIES = ['设备离线', '探头切换', '人工漏记', '运输途中无信号', '待查'];
const EXEMPTABLE_CATEGORIES = ['探头切换', '运输途中无信号'];

// 断链：相邻记录的时刻差超过门槛
function rawGaps(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({ from: rows[i - 1].at, to: rows[i].at, minutes, countedMinutes: Number(settings.recordIntervalMinutes) });
    }
  }
  return gaps;
}

// 归因按 批次+缺口起止 关联，一个缺口最多一条
function attributionFor(data, batchId, from, to) {
  return (data.gapAttributions || []).find((a) => a.batchId === batchId && a.gapFrom === from && a.gapTo === to) || null;
}

function attributionExempts(attribution) {
  return !!(attribution && EXEMPTABLE_CATEGORIES.indexOf(attribution.category) >= 0 && attribution.confirmed);
}

function decorateGap(data, batchId, gap) {
  const attribution = attributionFor(data, batchId, gap.from, gap.to);
  return Object.assign({}, gap, { attribution: attribution, exempted: attributionExempts(attribution) });
}

// 补录落点（from < at < to）覆盖到的当前缺口，补录时用来固化「曾经断链」
function gapsCovering(data, batchId, at) {
  return rawGaps(data, batchId).filter((g) => g.from < at && at < g.to);
}

// 断链全貌：当前缺口 + 曾经断链（补录时固化的事件，不随记录增删撤销），都带归因与豁免状态；
// counted 是参与放行判定的断链数 = 未豁免的当前缺口 + 未豁免的历史事件
function chainStatus(data, batchId) {
  const gaps = rawGaps(data, batchId).map((g) => decorateGap(data, batchId, g));
  const events = (data.chainEvents || [])
    .filter((e) => e.batchId === batchId)
    .map((e) => {
      const attribution = attributionFor(data, batchId, e.gapFrom, e.gapTo);
      return Object.assign({}, e, { attribution: attribution, exempted: attributionExempts(attribution) });
    })
    .sort((a, b) => (a.gapFrom < b.gapFrom ? -1 : a.gapFrom > b.gapFrom ? 1 : 0));
  const exemptedCount = gaps.filter((g) => g.exempted).length + events.filter((e) => e.exempted).length;
  const counted = gaps.filter((g) => !g.exempted).length + events.filter((e) => !e.exempted).length;
  return {
    gaps: gaps,
    gapCount: gaps.length,
    events: events,
    eventCount: events.length,
    exemptedCount: exemptedCount,
    counted: counted,
    totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0),
  };
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
  const chain = chainStatus(data, batch.id);
  const accumulated = monthlyExcursionMinutes(data, batch.id);
  const expired = expiredProbes(data, batch.id, batch.loadedAt ? String(batch.loadedAt).slice(0, 10) : '');
  const conditions = [
    { key: 'longest', ok: stats.longestMinutes <= Number(settings.allowExcursionMinutes), value: stats.longestMinutes, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
    { key: 'total', ok: accumulated <= Number(settings.allowTotalExcursionMinutes), value: accumulated, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟' },
    { key: 'chain', ok: chain.counted === 0, value: chain.counted, limit: 0, text: '全程没有断链（当前缺口与曾经断链，登记为可豁免分类并经确认的除外）' },
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
  excursionStats,
  rawGaps,
  gapsCovering,
  chainStatus,
  attributionFor,
  attributionExempts,
  GAP_CATEGORIES,
  EXEMPTABLE_CATEGORIES,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  monthlyExcursionMinutes,
  releaseCheck,
};
