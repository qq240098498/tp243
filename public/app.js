'use strict';

/* 冷链温控与批次放行台 —— 原生 JS，无框架、无构建、无外部依赖。
   显示纪律：超限段、断链、MKT、放行判定、各类计数一律直接显示接口返回值，前端不自行计算与重排。 */

const RECORD_PAGE = 200;
const BATCH_STATUS = ['在库', '待放行', '已放行', '已拒收'];
const ROOM_STATUS = ['运行', '检修', '停用'];
const ROOM_TYPE = ['冷藏库', '冷藏车', '冷冻库'];
const PROBE_STATUS = ['在用', '停用', '送检'];
const SOURCE_LIST = ['自动', '人工'];

const state = {
  view: 'overview',
  summary: null,
  settings: null,
  rooms: [],
  probes: [],
  batches: [],
  batchesView: [],
  recordsView: [],
  releasesView: [],
  roomDetail: {},
  batchDetail: {},
  batchOut: {},
  batchDetailError: {},
  expandedRooms: new Set(),
  expandedBatches: new Set(),
  filters: {
    rooms: { status: '', type: '', keyword: '', probeStatus: '', probeCal: 'all' },
    batches: { status: '', roomId: '', product: '', noRecord: false },
    records: { batchId: '', probeId: '', source: '', from: '', to: '' },
    releases: { decision: '' }
  }
};

/* ---------- 基础工具 ---------- */

function $(id) { return document.getElementById(id); }

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* 接口报错统一是 {error:{code,message,details}}，这里把它抛成普通对象保留 details */
async function api(method, path, body) {
  const opts = { method: method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const raw = await res.text();
  let data = null;
  if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
  if (!res.ok) {
    const err = (data && data.error) ? data.error : { code: 'HTTP_' + res.status, message: '请求失败（' + res.status + '）', details: null };
    throw { code: err.code, message: err.message, details: err.details, status: res.status };
  }
  return data;
}

let errorTimer = null;
function showError(err) {
  const banner = $('errorBanner');
  let msg = (err && err.message) ? err.message : '出错了';
  if (err && err.details && typeof err.details === 'object' && !Array.isArray(err.details)) {
    const parts = Object.keys(err.details).map(function (k) { return k + '：' + err.details[k]; });
    if (parts.length) msg += '（' + parts.join('；') + '）';
  }
  banner.textContent = msg;
  banner.hidden = false;
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(function () { banner.hidden = true; }, 7000);
  markErrorFields(err && err.details);
}

function markErrorFields(details) {
  document.querySelectorAll('.field-error').forEach(function (n) { n.classList.remove('field-error'); });
  if (!details || typeof details !== 'object' || Array.isArray(details)) return;
  Object.keys(details).forEach(function (k) {
    const input = document.querySelector('[data-field="' + k + '"]');
    if (input) {
      const wrap = input.closest('.field');
      if (wrap) wrap.classList.add('field-error');
    }
  });
}

function pill(text, cls) {
  return '<span class="pill ' + (cls || '') + '">' + esc(text) + '</span>';
}

function okPill(ok) {
  return ok ? pill('满足', 'pill-ok') : pill('不满足', 'pill-bad');
}

function roomOptions(selected) {
  return ['<option value="">请选择冷库</option>'].concat(state.rooms.map(function (r) {
    return '<option value="' + esc(r.id) + '"' + (r.id === selected ? ' selected' : '') + '>' + esc(r.code + ' ' + r.name) + '</option>';
  })).join('');
}

function batchOptions(selected) {
  return ['<option value="">请选择批次</option>'].concat(state.batches.map(function (b) {
    return '<option value="' + esc(b.id) + '"' + (b.id === selected ? ' selected' : '') + '>' + esc(b.code + ' ' + b.product) + '</option>';
  })).join('');
}

function probeOptions(selected) {
  return ['<option value="">请选择探头</option>'].concat(state.probes.map(function (p) {
    return '<option value="' + esc(p.id) + '"' + (p.id === selected ? ' selected' : '') + '>' + esc(p.code + '（' + (p.roomCode || '') + '）') + '</option>';
  })).join('');
}

/* ---------- 弹层 ---------- */

let modalOnOk = null;

function openModal(title, bodyHtml, okText, onOk) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  $('modalOk').textContent = okText || '保存';
  modalOnOk = onOk || null;
  $('modalMask').hidden = false;
  const first = $('modalBody').querySelector('input,select,textarea');
  if (first) setTimeout(function () { first.focus(); }, 20);
}

function closeModal() {
  $('modalMask').hidden = true;
  modalOnOk = null;
  $('modalBody').innerHTML = '';
  markErrorFields(null);
}

function formValues() {
  const out = {};
  $('modalBody').querySelectorAll('[data-field]').forEach(function (n) { out[n.dataset.field] = n.value; });
  return out;
}

/* 删除两步确认：第一次点把按钮变成「确认删除」，再点一次才真正执行 */
function armDelete(btn, fn) {
  if (btn.dataset.armed === '1') {
    btn.dataset.armed = '0';
    btn.classList.remove('armed');
    btn.textContent = '删除';
    fn();
    return;
  }
  btn.dataset.armed = '1';
  btn.classList.add('armed');
  btn.textContent = '确认删除';
  if (btn._armTimer) clearTimeout(btn._armTimer);
  btn._armTimer = setTimeout(function () {
    btn.dataset.armed = '0';
    btn.classList.remove('armed');
    btn.textContent = '删除';
  }, 4000);
}

/* ---------- 标签与视图切换 ---------- */

async function switchView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('is-active', t.dataset.view === view); });
  document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('is-active', v.dataset.view === view); });
  renderFilters();
  await loadView(view);
}

async function loadView(view) {
  try {
    if (view === 'overview') await loadOverview();
    else if (view === 'rooms') await loadRoomsView();
    else if (view === 'batches') await loadBatchesView();
    else if (view === 'records') await loadRecordsView();
    else if (view === 'releases') await loadReleasesView();
  } catch (err) { showError(err); }
}

/* ---------- 概览 ---------- */

async function loadOverview() {
  const s = await api('GET', '/api/summary');
  state.summary = s;
  $('todayText').textContent = s.today;
  renderOverview();
}

function statusSummaryText(sc) {
  return BATCH_STATUS.map(function (k) { return k + ' ' + num(sc[k]); }).join(' / ');
}

function renderOverview() {
  const s = state.summary;
  if (!s) return;
  const sc = s.statusCount || {};
  const cards = [
    { title: '冷库', value: s.roomCount, sub: '运行中 ' + s.runningRoomCount, go: { view: 'rooms' } },
    { title: '探头', value: s.probeCount, sub: '在用 ' + s.runningProbeCount, go: { view: 'rooms' } },
    { title: '已过校准期探头', value: s.expiredProbeCount, sub: '需送检', go: { view: 'rooms', probeCal: 'expired' } },
    { title: '批次', value: s.batchCount, sub: statusSummaryText(sc), go: { view: 'batches' } },
    { title: '在办批次', value: s.openBatchCount, sub: '在库与待放行', go: { view: 'batches' } },
    { title: '温度记录', value: s.recordCount, sub: '人工 ' + s.manualRecordCount, go: { view: 'records' } },
    { title: '放行 / 拒收', value: s.releasedCount + ' / ' + s.rejectedCount, sub: '台账 ' + s.releaseCount + ' 条', go: { view: 'releases' } },
    { title: '满足放行条件', value: s.readyToRelease, sub: '被挡下 ' + s.blockedCount, go: { view: 'batches' } },
    { title: '没有温度记录', value: s.noRecordBatches, sub: '个批次', go: { view: 'batches', noRecord: true } },
    { title: 'MKT', value: s.maxMkt, sub: '平均 ' + s.averageMkt, go: { view: 'batches' } }
  ];
  $('overviewCards').innerHTML = cards.map(function (c) {
    return '<div class="card" data-action="card-go" data-go=\'' + JSON.stringify(c.go) + '\'>' +
      '<div class="card-title">' + esc(c.title) + '</div>' +
      '<div class="card-value">' + esc(c.value) + '</div>' +
      '<div class="card-sub">' + esc(c.sub) + '</div>' +
      '</div>';
  }).join('');

  const rows = (s.rooms || []).map(function (r) {
    return '<tr class="row-main" data-rowkind="overview-room" data-id="' + esc(r.id) + '" data-action="goto-room" data-room-id="' + esc(r.id) + '">' +
      '<td>' + esc(r.code) + '</td>' +
      '<td>' + esc(r.name) + '</td>' +
      '<td>' + esc(r.type) + '</td>' +
      '<td>' + esc(r.status) + '</td>' +
      '<td class="num">' + num(r.probeCount) + '</td>' +
      '<td class="num">' + num(r.batchCount) + '</td>' +
      '<td class="num">' + num(r.openBatchCount) + '</td>' +
      '</tr>';
  }).join('');
  $('overviewRows').innerHTML = rows;
}

/* ---------- 冷库与探头 ---------- */

async function loadRoomsView() {
  const f = state.filters.rooms;
  const rp = new URLSearchParams();
  if (f.status) rp.set('status', f.status);
  if (f.type) rp.set('type', f.type);
  if (f.keyword) rp.set('keyword', f.keyword);
  const rooms = await api('GET', '/api/rooms' + (rp.toString() ? '?' + rp.toString() : ''));
  state.roomsView = rooms;
  renderRoomRows();
  renderProbeRows();
}

function visibleProbes() {
  const f = state.filters.rooms;
  return state.probes.filter(function (p) {
    if (f.probeStatus && p.status !== f.probeStatus) return false;
    if (f.probeCal === 'expired' && !p.expired) return false;
    if (f.probeCal === 'valid' && p.expired) return false;
    return true;
  });
}

function renderRoomRows() {
  const rows = state.roomsView || [];
  const tbody = $('roomRows');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">没有符合条件的冷库</td></tr>';
    return;
  }
  const html = rows.map(function (r) {
    const main = '<tr class="row-main" data-rowkind="room" data-id="' + esc(r.id) + '">' +
      '<td>' + esc(r.code) + '</td>' +
      '<td>' + esc(r.name) + '</td>' +
      '<td>' + esc(r.type) + '</td>' +
      '<td>' + esc(r.location) + '</td>' +
      '<td class="num">' + num(r.capacityPlt) + '</td>' +
      '<td>' + esc(r.status) + '</td>' +
      '<td class="num">' + num(r.probeCount) + '</td>' +
      '<td class="num">' + num(r.batchCount) + '</td>' +
      '<td class="num">' + num(r.openBatchCount) + '</td>' +
      '<td class="cell-actions">' +
      '<button type="button" class="btn btn-sm" data-action="room-edit" data-id="' + esc(r.id) + '">修改</button>' +
      '<button type="button" class="btn btn-sm btn-danger" data-action="room-del" data-id="' + esc(r.id) + '">删除</button>' +
      '</td></tr>';
    if (!state.expandedRooms.has(r.id)) return main;
    return main + roomDetailRow(r);
  }).join('');
  tbody.innerHTML = html;
}

function roomDetailRow(r) {
  const d = state.roomDetail[r.id];
  if (!d) return '<tr class="row-detail"><td colspan="10"><div class="detail-note">正在读取冷库详情…</div></td></tr>';
  const probes = (d.probes || []).map(function (p) {
    return '<tr' + (p.expired ? ' class="row-danger"' : '') + '><td>' + esc(p.code) + '</td><td>' + esc(p.position) + '</td>' +
      '<td>' + esc(p.status) + '</td><td>' + esc(p.calibratedUntil) + '</td>' +
      '<td class="num">' + num(p.recordCount) + '</td><td>' + (p.expired ? '已过期' : '有效') + '</td></tr>';
  }).join('') || '<tr><td colspan="6" class="empty">没有探头</td></tr>';
  const openBatches = (d.batches || []).filter(function (b) { return b.status === '在库' || b.status === '待放行'; });
  const batches = openBatches.map(function (b) {
    return '<tr><td>' + esc(b.code) + '</td><td>' + esc(b.product) + '</td><td class="num">' + num(b.units) + '</td>' +
      '<td>' + esc(b.status) + '</td><td class="num">' + num(b.recordCount) + '</td></tr>';
  }).join('') || '<tr><td colspan="5" class="empty">没有在办批次</td></tr>';
  return '<tr class="row-detail"><td colspan="10"><div class="detail-grid">' +
    '<div class="detail-block"><h4>探头清单（' + (d.probes || []).length + '）</h4>' +
    '<table class="mini-table"><thead><tr><th>编号</th><th>位置</th><th>状态</th><th>校准有效期</th><th class="num">记录数</th><th>是否过期</th></tr></thead><tbody>' + probes + '</tbody></table></div>' +
    '<div class="detail-block"><h4>在办批次（' + openBatches.length + '）</h4>' +
    '<table class="mini-table"><thead><tr><th>批次号</th><th>品名</th><th class="num">件数</th><th>状态</th><th class="num">记录数</th></tr></thead><tbody>' + batches + '</tbody></table></div>' +
    '</div></td></tr>';
}

function renderProbeRows() {
  const rows = visibleProbes();
  const tbody = $('probeRows');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">没有符合条件的探头</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function (p) {
    return '<tr class="row-main' + (p.expired ? ' row-danger' : '') + '" data-rowkind="probe" data-id="' + esc(p.id) + '">' +
      '<td>' + esc(p.code) + '</td>' +
      '<td>' + esc(p.roomCode) + '</td>' +
      '<td>' + esc(p.position) + '</td>' +
      '<td>' + esc(p.status) + '</td>' +
      '<td>' + esc(p.calibratedUntil) + '</td>' +
      '<td class="num">' + num(p.recordCount) + '</td>' +
      '<td class="num">' + num(p.manualCount) + '</td>' +
      '<td>' + (p.expired ? pill('已过期', 'pill-bad') : pill('有效', 'pill-mute')) + '</td>' +
      '<td class="cell-actions">' +
      '<button type="button" class="btn btn-sm" data-action="probe-edit" data-id="' + esc(p.id) + '">修改</button>' +
      '<button type="button" class="btn btn-sm btn-danger" data-action="probe-del" data-id="' + esc(p.id) + '">删除</button>' +
      '</td></tr>';
  }).join('');
}

async function expandRoom(id) {
  if (!state.roomDetail[id]) {
    state.roomDetail[id] = await api('GET', '/api/rooms/' + encodeURIComponent(id));
  }
  state.expandedRooms.add(id);
  renderRoomRows();
}

/* ---------- 批次 ---------- */

async function loadBatchesView() {
  const f = state.filters.batches;
  const params = new URLSearchParams();
  if (f.status) params.set('status', f.status);
  if (f.roomId) params.set('roomId', f.roomId);
  if (f.product) params.set('product', f.product);
  let rows = await api('GET', '/api/batches' + (params.toString() ? '?' + params.toString() : ''));
  if (f.noRecord) rows = rows.filter(function (b) { return num(b.recordCount) === 0; });
  state.batchesView = rows;
  renderBatchRows();
}

function releaseSituation(b) {
  if (num(b.releaseCount) > 0 && b.lastDecision) {
    return b.lastDecision === '放行' ? pill('已放行', 'pill-ok') : pill('已拒收', 'pill-bad');
  }
  const pass = b.releaseCheck && b.releaseCheck.pass;
  return pass ? pill('满足放行条件', 'pill-ok') : pill('未满足放行条件', 'pill-bad');
}

function renderBatchRows() {
  const rows = state.batchesView || [];
  const tbody = $('batchRows');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty">没有符合条件的批次</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function (b) {
    const main = '<tr class="row-main" data-rowkind="batch" data-id="' + esc(b.id) + '">' +
      '<td>' + esc(b.code) + '</td>' +
      '<td>' + esc(b.product) + '</td>' +
      '<td>' + esc(b.spec) + '</td>' +
      '<td class="num">' + num(b.units) + '</td>' +
      '<td>' + esc(b.roomCode) + '</td>' +
      '<td>' + esc(b.loadedAt) + '</td>' +
      '<td>' + esc(b.status) + '</td>' +
      '<td class="num">' + num(b.recordCount) + '</td>' +
      '<td class="num">' + num(b.longestExcursionMinutes) + '</td>' +
      '<td class="num">' + num(b.totalExcursionMinutes) + '</td>' +
      '<td class="num">' + num(b.mkt) + '</td>' +
      '<td class="num">' + num(b.chainGapCount) + '</td>' +
      '<td>' + releaseSituation(b) + '</td>' +
      '</tr>';
    if (!state.expandedBatches.has(b.id)) return main;
    return main + batchDetailRow(b);
  }).join('');
}

function batchDetailRow(b) {
  const d = state.batchDetail[b.id];
  if (!d) return '<tr class="row-detail"><td colspan="13"><div class="detail-note">正在读取批次详情…</div></td></tr>';
  const out = state.batchOut[b.id] || {};

  const records = (d.records || []).map(function (r) {
    const oor = out[r.id];
    return '<tr><td>' + esc(r.at) + '</td><td>' + esc(r.probeCode) + '</td><td class="num">' + num(r.temperatureC) + '</td>' +
      '<td>' + esc(r.source) + '</td>' +
      '<td>' + (oor ? pill('超限', 'pill-bad') : pill('正常', 'pill-mute')) + '</td>' +
      '<td>' + (r.probeExpired ? pill('已过期', 'pill-bad') : pill('有效', 'pill-mute')) + '</td></tr>';
  }).join('') || '<tr><td colspan="6" class="empty">没有温度记录</td></tr>';

  let segmentsHtml;
  if (d.segmentsUnavailable) {
    const emsg = (state.batchDetailError[b.id] && state.batchDetailError[b.id].message) || '批次详情接口报错';
    segmentsHtml = '<div class="detail-note">读不到超限段：' + esc(emsg) + '（服务端 /api/batches/:id 报错，已退回其他接口）</div>';
  } else {
    const segRows = (d.segments || []).map(function (s) {
      return '<tr><td>' + esc(s.startAt) + '</td><td>' + esc(s.endAt) + '</td><td class="num">' + num(s.minutes) + '</td>' +
        '<td class="num">' + num(s.peakC) + '</td><td class="num">' + num(s.points) + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty">没有超限段</td></tr>';
    segmentsHtml = '<table class="mini-table"><thead><tr><th>起</th><th>止</th><th class="num">时长(分)</th><th class="num">峰值(℃)</th><th class="num">点数</th></tr></thead><tbody>' + segRows + '</tbody></table>';
  }

  const gaps = (d.chainGaps || []).map(function (g) {
    return '<tr><td>' + esc(g.from) + '</td><td>' + esc(g.to) + '</td><td class="num">' + num(g.minutes) + '</td>' +
      '<td class="num">' + num(g.countedMinutes) + '</td></tr>';
  }).join('') || '<tr><td colspan="4" class="empty">没有断链缺口</td></tr>';

  const check = d.releaseCheck || {};
  const conds = (check.conditions || []).slice();
  const expired = check.expiredProbes || [];
  conds.push({ key: 'calibration', ok: expired.length === 0, value: expired.length, limit: 0, text: '参与判定的探头都在校准有效期内' });
  const condHtml = conds.map(function (c) {
    return '<li><span class="cond-text">' + okPill(c.ok) + ' ' + esc(c.text) + '</span>' +
      '<span class="cond-meta">实际 ' + esc(c.value) + '，阈值 ' + esc(c.limit) + '</span></li>';
  }).join('');

  const expiredProbes = expired.map(function (p) {
    return '<tr><td>' + esc(p.probeCode) + '</td><td>' + esc(p.calibratedUntil) + '</td><td>' + esc(p.at) + '</td></tr>';
  }).join('') || '<tr><td colspan="3" class="empty">没有已过校准期的探头</td></tr>';

  const releases = (d.releases || []).map(function (r) {
    return '<tr><td>' + esc(r.decision) + '</td><td>' + esc(r.decidedAt) + '</td><td>' + esc(r.decider) + '</td>' +
      '<td class="num">' + num(r.mkt) + '</td><td>' + esc(r.basis) + '</td></tr>';
  }).join('') || '<tr><td colspan="5" class="empty">没有放行记录</td></tr>';

  const decisionBtns = '<div class="detail-actions">' +
    '<button type="button" class="btn btn-primary" data-action="batch-release" data-id="' + esc(b.id) + '">放行</button>' +
    '<button type="button" class="btn" data-action="batch-reject" data-id="' + esc(b.id) + '">拒收</button>' +
    '<button type="button" class="btn btn-danger" data-action="batch-del" data-id="' + esc(b.id) + '">删除</button>' +
    '</div>';

  return '<tr class="row-detail"><td colspan="13">' +
    '<div class="detail-grid">' +
    '<div class="detail-block"><h4>温度记录（' + (d.records || []).length + '）</h4>' +
    '<table class="mini-table"><thead><tr><th>时刻</th><th>探头</th><th class="num">温度(℃)</th><th>来源</th><th>是否超限</th><th>探头是否过期</th></tr></thead><tbody>' + records + '</tbody></table></div>' +
    '<div class="detail-block"><h4>超限段（' + (d.segments || []).length + '）</h4>' + segmentsHtml +
    '<h4>断链缺口（' + (d.chainGaps || []).length + '）</h4>' +
    '<table class="mini-table"><thead><tr><th>起</th><th>止</th><th class="num">实际(分)</th><th class="num">计入(分)</th></tr></thead><tbody>' + gaps + '</tbody></table></div>' +
    '<div class="detail-block"><h4>放行判定</h4><ul class="cond-list">' + condHtml + '</ul>' +
    '<h4>已过校准期的探头（' + expired.length + '）</h4>' +
    '<table class="mini-table"><thead><tr><th>探头</th><th>校准有效期</th><th>记录时刻</th></tr></thead><tbody>' + expiredProbes + '</tbody></table></div>' +
    '<div class="detail-block"><h4>放行记录（' + (d.releases || []).length + '）</h4>' +
    '<table class="mini-table"><thead><tr><th>决定</th><th>时刻</th><th>经办人</th><th class="num">MKT</th><th>依据</th></tr></thead><tbody>' + releases + '</tbody></table>' +
    decisionBtns + '</div>' +
    '</div></td></tr>';
}

async function expandBatch(id) {
  if (!state.batchDetail[id]) {
    let detail = null;
    let detailError = null;
    let records = [];
    try {
      const results = await Promise.all([
        api('GET', '/api/batches/' + encodeURIComponent(id)),
        api('GET', '/api/records?batchId=' + encodeURIComponent(id))
      ]);
      detail = results[0];
      records = results[1] || [];
    } catch (err) {
      /* 服务端 /api/batches/:id 在有记录时会 500（coldlib.probeOf 未导出），
         这里退回可用的接口拼出详情，保证页面不空着、并如实显示报错。 */
      detailError = err;
      const fallback = await Promise.all([
        api('GET', '/api/batches/' + encodeURIComponent(id) + '/release-check'),
        api('GET', '/api/records?batchId=' + encodeURIComponent(id)),
        api('GET', '/api/releases?batchId=' + encodeURIComponent(id))
      ]);
      const check = fallback[0];
      records = fallback[1] || [];
      const base = findBatch(id) || {};
      detail = Object.assign({}, base, {
        records: records.map(function (r) {
          const probe = state.probes.find(function (p) { return p.id === r.probeId; });
          return Object.assign({}, r, { probeCode: r.probeCode, probeExpired: probe ? !!probe.expired : false });
        }),
        effectiveRecords: [],
        segments: [],
        segmentsUnavailable: true,
        chainGaps: (check.chain && check.chain.gaps) || [],
        releases: fallback[2] || [],
        releaseCheck: check,
        __fallback: true
      });
    }
    const map = {};
    records.forEach(function (r) { map[r.id] = r.outOfRange; });
    state.batchDetail[id] = detail;
    state.batchOut[id] = map;
    state.batchDetailError[id] = detailError;
  }
  state.expandedBatches.add(id);
  renderBatchRows();
}

/* ---------- 温度记录 ---------- */

async function loadRecordsView() {
  const f = state.filters.records;
  const params = new URLSearchParams();
  if (f.batchId) params.set('batchId', f.batchId);
  if (f.probeId) params.set('probeId', f.probeId);
  if (f.source) params.set('source', f.source);
  if (f.from) params.set('from', toApiTime(f.from));
  if (f.to) params.set('to', toApiTime(f.to));
  const rows = await api('GET', '/api/records' + (params.toString() ? '?' + params.toString() : ''));
  state.recordsView = rows;
  const batchSelected = !!f.batchId;
  const shown = batchSelected ? rows : rows.slice(0, RECORD_PAGE);
  $('recordsNote').textContent = batchSelected
    ? ('共 ' + rows.length + ' 条，已全部显示')
    : ('共 ' + rows.length + ' 条，已显示前 ' + Math.min(RECORD_PAGE, rows.length) + ' 条');
  const tbody = $('recordRows');
  if (!shown.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">没有符合条件的温度记录</td></tr>';
    return;
  }
  tbody.innerHTML = shown.map(function (r) {
    return '<tr class="row-main" data-rowkind="record" data-id="' + esc(r.id) + '">' +
      '<td>' + esc(r.batchCode) + '</td>' +
      '<td>' + esc(r.probeCode) + '</td>' +
      '<td>' + esc(r.at) + '</td>' +
      '<td class="num">' + num(r.temperatureC) + '</td>' +
      '<td>' + esc(r.source) + '</td>' +
      '<td>' + esc(r.operator) + '</td>' +
      '<td>' + (r.outOfRange ? pill('超限', 'pill-bad') : pill('正常', 'pill-mute')) + '</td>' +
      '<td class="cell-actions"><button type="button" class="btn btn-sm btn-danger" data-action="record-del" data-id="' + esc(r.id) + '">删除</button></td>' +
      '</tr>';
  }).join('');
}

function toApiTime(v) {
  if (!v) return '';
  return String(v).replace('T', ' ') + ':00';
}

/* ---------- 放行台账 ---------- */

async function loadReleasesView() {
  const f = state.filters.releases;
  const params = new URLSearchParams();
  if (f.decision) params.set('decision', f.decision);
  const rows = await api('GET', '/api/releases' + (params.toString() ? '?' + params.toString() : ''));
  state.releasesView = rows;
  const s = state.summary;
  if (s) {
    $('releasesNote').textContent = '放行 ' + num(s.releasedCount) + ' 条，拒收 ' + num(s.rejectedCount) + ' 条';
  } else {
    const rel = rows.filter(function (r) { return r.decision === '放行'; }).length;
    const rej = rows.filter(function (r) { return r.decision === '拒收'; }).length;
    $('releasesNote').textContent = '放行 ' + rel + ' 条，拒收 ' + rej + ' 条';
  }
  const tbody = $('releaseRows');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">没有符合条件的放行记录</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function (r) {
    return '<tr class="row-main" data-rowkind="release" data-id="' + esc(r.id) + '">' +
      '<td>' + esc(r.batchCode) + '</td>' +
      '<td>' + (r.decision === '放行' ? pill('放行', 'pill-ok') : pill('拒收', 'pill-bad')) + '</td>' +
      '<td>' + esc(r.decidedAt) + '</td>' +
      '<td>' + esc(r.decider) + '</td>' +
      '<td class="num">' + num(r.mkt) + '</td>' +
      '<td class="num">' + num(r.longestExcursionMinutes) + '</td>' +
      '<td class="num">' + num(r.totalExcursionMinutes) + '</td>' +
      '<td class="num">' + num(r.chainGapCount) + '</td>' +
      '<td>' + esc(r.basis) + '</td>' +
      '<td>' + esc(r.remark) + '</td>' +
      '</tr>';
  }).join('');
}

/* ---------- 左侧筛选栏 ---------- */

function selectHtml(name, options, value) {
  const opts = options.map(function (o) {
    return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(value) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
  }).join('');
  return '<select data-filter="' + name + '">' + opts + '</select>';
}

function textHtml(name, value, placeholder) {
  return '<input type="text" data-filter="' + name + '" value="' + esc(value) + '" placeholder="' + esc(placeholder || '') + '">';
}

function renderFilters() {
  const host = $('filters');
  const v = state.view;
  let html = '';
  if (v === 'overview') {
    html = '<h3>概览</h3><div class="filter-hint">点指标卡跳到对应标签并带上筛选；点冷库行跳到冷库标签并展开。</div>';
  } else if (v === 'rooms') {
    const f = state.filters.rooms;
    html = '<h3>冷库筛选</h3>' +
      '<div class="filter-field"><label>状态</label>' + selectHtml('status', [{ value: '', label: '全部' }].concat(ROOM_STATUS.map(function (s) { return { value: s, label: s }; })), f.status) + '</div>' +
      '<div class="filter-field"><label>类型</label>' + selectHtml('type', [{ value: '', label: '全部' }].concat(ROOM_TYPE.map(function (s) { return { value: s, label: s }; })), f.type) + '</div>' +
      '<div class="filter-field"><label>关键字</label>' + textHtml('keyword', f.keyword, '编码/名称/位置') + '</div>' +
      '<h3>探头筛选</h3>' +
      '<div class="filter-field"><label>状态</label>' + selectHtml('probeStatus', [{ value: '', label: '全部' }].concat(PROBE_STATUS.map(function (s) { return { value: s, label: s }; })), f.probeStatus) + '</div>' +
      '<div class="filter-field"><label>校准</label>' + selectHtml('probeCal', [{ value: 'all', label: '全部' }, { value: 'expired', label: '已过期' }, { value: 'valid', label: '有效' }], f.probeCal) + '</div>';
  } else if (v === 'batches') {
    const f = state.filters.batches;
    const roomSel = [{ value: '', label: '全部' }].concat(state.rooms.map(function (r) { return { value: r.id, label: r.code + ' ' + r.name }; }));
    html = '<h3>批次筛选</h3>' +
      '<div class="filter-field"><label>状态</label>' + selectHtml('status', [{ value: '', label: '全部' }].concat(BATCH_STATUS.map(function (s) { return { value: s, label: s }; })), f.status) + '</div>' +
      '<div class="filter-field"><label>所在冷库</label>' + selectHtml('roomId', roomSel, f.roomId) + '</div>' +
      '<div class="filter-field"><label>品名</label>' + textHtml('product', f.product, '品名关键字') + '</div>' +
      '<div class="filter-field"><label>只看无记录</label><input type="checkbox" data-filter="noRecord"' + (f.noRecord ? ' checked' : '') + '></div>';
  } else if (v === 'records') {
    const f = state.filters.records;
    const batchSel = [{ value: '', label: '全部' }].concat(state.batches.map(function (b) { return { value: b.id, label: b.code }; }));
    const probeSel = [{ value: '', label: '全部' }].concat(state.probes.map(function (p) { return { value: p.id, label: p.code }; }));
    html = '<h3>记录筛选</h3>' +
      '<div class="filter-field"><label>批次</label>' + selectHtml('batchId', batchSel, f.batchId) + '</div>' +
      '<div class="filter-field"><label>探头</label>' + selectHtml('probeId', probeSel, f.probeId) + '</div>' +
      '<div class="filter-field"><label>来源</label>' + selectHtml('source', [{ value: '', label: '全部' }].concat(SOURCE_LIST.map(function (s) { return { value: s, label: s }; })), f.source) + '</div>' +
      '<div class="filter-field"><label>起</label><input type="datetime-local" data-filter="from" value="' + esc(f.from) + '"></div>' +
      '<div class="filter-field"><label>止</label><input type="datetime-local" data-filter="to" value="' + esc(f.to) + '"></div>' +
      '<div class="filter-hint">不选批次时只渲染前 ' + RECORD_PAGE + ' 条；选定批次后显示该批次全部记录。</div>';
  } else if (v === 'releases') {
    const f = state.filters.releases;
    html = '<h3>台账筛选</h3>' +
      '<div class="filter-field"><label>决定</label>' + selectHtml('decision', [{ value: '', label: '全部' }, { value: '放行', label: '放行' }, { value: '拒收', label: '拒收' }], f.decision) + '</div>';
  }
  host.innerHTML = html;
}

let filterTimer = null;
function onFilterInput(e) {
  const key = e.target.dataset.filter;
  if (!key) return;
  const f = state.filters[state.view];
  if (!f) return;
  if (e.target.type === 'checkbox') f[key] = e.target.checked;
  else f[key] = e.target.value;
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(function () { loadView(state.view); }, 250);
}

/* ---------- 表单弹层 ---------- */

function openSettings() {
  const s = state.settings || {};
  const body =
    '<div class="field"><label>温度带下限（℃）</label><input type="number" step="0.1" data-field="lowerLimitC" value="' + esc(s.lowerLimitC) + '"></div>' +
    '<div class="field"><label>温度带上限（℃）</label><input type="number" step="0.1" data-field="upperLimitC" value="' + esc(s.upperLimitC) + '"></div>' +
    '<div class="field"><label>单次允许超限（分钟）</label><input type="number" step="1" data-field="allowExcursionMinutes" value="' + esc(s.allowExcursionMinutes) + '"></div>' +
    '<div class="field"><label>累计允许超限（分钟）</label><input type="number" step="1" data-field="allowTotalExcursionMinutes" value="' + esc(s.allowTotalExcursionMinutes) + '"></div>' +
    '<div class="field"><label>断链门槛（分钟）</label><input type="number" step="1" data-field="chainGapMinutes" value="' + esc(s.chainGapMinutes) + '"></div>' +
    '<div class="field"><label>记录间隔（分钟）</label><input type="number" step="1" data-field="recordIntervalMinutes" value="' + esc(s.recordIntervalMinutes) + '"></div>';
  openModal('设置', body, '保存', async function () {
    const v = formValues();
    const payload = {
      lowerLimitC: Number(v.lowerLimitC),
      upperLimitC: Number(v.upperLimitC),
      allowExcursionMinutes: Number(v.allowExcursionMinutes),
      allowTotalExcursionMinutes: Number(v.allowTotalExcursionMinutes),
      chainGapMinutes: Number(v.chainGapMinutes),
      recordIntervalMinutes: Number(v.recordIntervalMinutes)
    };
    try {
      state.settings = await api('PATCH', '/api/settings', payload);
      closeModal();
      await refreshAfterMutation();
    } catch (err) { showError(err); }
  });
}

function openRoomForm(room) {
  const isEdit = !!room;
  const r = room || { code: '', name: '', type: '冷藏库', location: '', capacityPlt: 0, status: '运行', remark: '' };
  const body =
    '<div class="field"><label>编码</label><input type="text" data-field="code" value="' + esc(r.code) + '"' + (isEdit ? ' disabled' : '') + '></div>' +
    '<div class="field"><label>名称</label><input type="text" data-field="name" value="' + esc(r.name) + '"></div>' +
    '<div class="field"><label>类型</label><select data-field="type">' + ROOM_TYPE.map(function (t) { return '<option value="' + esc(t) + '"' + (t === r.type ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>位置</label><input type="text" data-field="location" value="' + esc(r.location) + '"></div>' +
    '<div class="field"><label>库位</label><input type="number" step="1" data-field="capacityPlt" value="' + esc(r.capacityPlt) + '"></div>' +
    '<div class="field"><label>状态</label><select data-field="status">' + ROOM_STATUS.map(function (t) { return '<option value="' + esc(t) + '"' + (t === r.status ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>备注</label><textarea data-field="remark">' + esc(r.remark) + '</textarea></div>';
  openModal(isEdit ? '修改冷库' : '新增冷库', body, isEdit ? '保存' : '新增', async function () {
    const v = formValues();
    const payload = {
      code: v.code, name: v.name, type: v.type, location: v.location,
      capacityPlt: Number(v.capacityPlt), status: v.status, remark: v.remark
    };
    try {
      if (isEdit) await api('PATCH', '/api/rooms/' + encodeURIComponent(room.id), payload);
      else await api('POST', '/api/rooms', payload);
      closeModal();
      await refreshAfterMutation();
    } catch (err) { showError(err); }
  });
}

function openProbeForm(probe) {
  const isEdit = !!probe;
  const p = probe || { code: '', roomId: state.rooms.length ? state.rooms[0].id : '', position: '', status: '在用', calibratedUntil: '', remark: '' };
  const body =
    '<div class="field"><label>编号</label><input type="text" data-field="code" value="' + esc(p.code) + '"' + (isEdit ? ' disabled' : '') + '></div>' +
    '<div class="field"><label>所属冷库</label><select data-field="roomId">' + roomOptions(p.roomId) + '</select></div>' +
    '<div class="field"><label>位置</label><input type="text" data-field="position" value="' + esc(p.position) + '"></div>' +
    '<div class="field"><label>状态</label><select data-field="status">' + PROBE_STATUS.map(function (t) { return '<option value="' + esc(t) + '"' + (t === p.status ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>校准有效期</label><input type="text" data-field="calibratedUntil" value="' + esc(p.calibratedUntil) + '" placeholder="2026-12-31"><div class="field-hint">格式：2026-12-31</div></div>' +
    '<div class="field"><label>备注</label><textarea data-field="remark">' + esc(p.remark) + '</textarea></div>';
  openModal(isEdit ? '修改探头' : '新增探头', body, isEdit ? '保存' : '新增', async function () {
    const v = formValues();
    const payload = {
      code: v.code, roomId: v.roomId, position: v.position,
      status: v.status, calibratedUntil: v.calibratedUntil, remark: v.remark
    };
    try {
      if (isEdit) await api('PATCH', '/api/probes/' + encodeURIComponent(probe.id), payload);
      else await api('POST', '/api/probes', payload);
      closeModal();
      await refreshAfterMutation();
    } catch (err) { showError(err); }
  });
}

function openDecisionModal(batch, decision) {
  const body =
    '<div class="field"><label>经办人</label><input type="text" data-field="decider" value=""></div>' +
    '<div class="field"><label>依据</label><input type="text" data-field="basis" value=""></div>' +
    '<div class="field"><label>备注</label><textarea data-field="remark"></textarea></div>' +
    '<div class="field-hint">批次 ' + esc(batch.code) + '，本次决定：' + esc(decision) + '</div>';
  openModal(decision === '放行' ? '放行' : '拒收', body, decision, async function () {
    const v = formValues();
    try {
      await api('POST', '/api/batches/' + encodeURIComponent(batch.id) + '/decision', {
        decision: decision, decider: v.decider, basis: v.basis, remark: v.remark
      });
      closeModal();
      delete state.batchDetail[batch.id];
      delete state.batchOut[batch.id];
      await refreshAfterMutation();
    } catch (err) { showError(err); }
  });
}

function openRecordForm() {
  const now = state.summary && state.summary.today ? state.summary.today + ' 00:00:00' : '';
  const body =
    '<div class="field"><label>批次</label><select data-field="batchId">' + batchOptions('') + '</select></div>' +
    '<div class="field"><label>探头</label><select data-field="probeId">' + probeOptions('') + '</select></div>' +
    '<div class="field"><label>时刻</label><input type="text" data-field="at" value="' + esc(now) + '" placeholder="2026-09-01 08:00:00"></div>' +
    '<div class="field"><label>温度（℃）</label><input type="number" step="0.1" data-field="temperatureC" value=""></div>' +
    '<div class="field"><label>来源</label><select data-field="source">' + SOURCE_LIST.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>登记人</label><input type="text" data-field="operator" value=""></div>' +
    '<div class="field"><label>备注</label><textarea data-field="remark"></textarea></div>';
  openModal('新增温度记录', body, '新增', async function () {
    const v = formValues();
    const payload = {
      batchId: v.batchId, probeId: v.probeId, at: v.at,
      temperatureC: Number(v.temperatureC), source: v.source, operator: v.operator, remark: v.remark
    };
    try {
      await api('POST', '/api/records', payload);
      closeModal();
      await refreshAfterMutation();
    } catch (err) { showError(err); }
  });
}

/* ---------- 变更后刷新 ---------- */

async function loadBase() {
  const results = await Promise.all([
    api('GET', '/api/rooms'),
    api('GET', '/api/probes'),
    api('GET', '/api/batches')
  ]);
  state.rooms = results[0];
  state.probes = results[1];
  state.batches = results[2];
}

async function refreshAfterMutation() {
  try { await loadBase(); } catch (err) { showError(err); }
  try {
    const s = await api('GET', '/api/summary');
    state.summary = s;
    $('todayText').textContent = s.today;
    renderOverview();
  } catch (err) { showError(err); }
  const exRooms = Array.from(state.expandedRooms);
  const exBatches = Array.from(state.expandedBatches);
  state.roomDetail = {};
  state.batchDetail = {};
  state.batchOut = {};
  state.batchDetailError = {};
  await loadView(state.view);
  for (let i = 0; i < exRooms.length; i += 1) {
    if (state.expandedRooms.has(exRooms[i])) {
      try { await expandRoom(exRooms[i]); } catch (err) { showError(err); }
    }
  }
  for (let j = 0; j < exBatches.length; j += 1) {
    if (state.expandedBatches.has(exBatches[j])) {
      try { await expandBatch(exBatches[j]); } catch (err) { showError(err); }
    }
  }
}

/* ---------- 交互总入口 ---------- */

function findRoom(id) { return state.rooms.find(function (r) { return r.id === id; }) || null; }
function findProbe(id) { return state.probes.find(function (p) { return p.id === id; }) || null; }
function findBatch(id) {
  return state.batches.find(function (b) { return b.id === id; }) ||
    (state.batchesView || []).find(function (b) { return b.id === id; }) || null;
}

async function handleAction(action, el) {
  try {
    if (action === 'open-settings') { openSettings(); return; }
    if (action === 'card-go') {
      const go = JSON.parse(el.dataset.go || '{}');
      if (go.view === 'rooms' && go.probeCal) state.filters.rooms.probeCal = go.probeCal;
      if (go.view === 'batches' && go.noRecord) state.filters.batches.noRecord = true;
      await switchView(go.view);
      return;
    }
    if (action === 'goto-room') {
      const id = el.dataset.roomId || el.dataset.id;
      await switchView('rooms');
      await expandRoom(id);
      return;
    }
    if (action === 'room-add') { openRoomForm(null); return; }
    if (action === 'room-edit') { openRoomForm(findRoom(el.dataset.id)); return; }
    if (action === 'room-del') {
      const id = el.dataset.id;
      armDelete(el, async function () {
        try {
          await api('DELETE', '/api/rooms/' + encodeURIComponent(id));
          delete state.roomDetail[id];
          state.expandedRooms.delete(id);
          await refreshAfterMutation();
        } catch (err) { showError(err); }
      });
      return;
    }
    if (action === 'probe-add') { openProbeForm(null); return; }
    if (action === 'probe-edit') { openProbeForm(findProbe(el.dataset.id)); return; }
    if (action === 'probe-del') {
      const id = el.dataset.id;
      armDelete(el, async function () {
        try {
          await api('DELETE', '/api/probes/' + encodeURIComponent(id));
          await refreshAfterMutation();
        } catch (err) { showError(err); }
      });
      return;
    }
    if (action === 'batch-release' || action === 'batch-reject') {
      const batch = findBatch(el.dataset.id);
      if (batch) openDecisionModal(batch, action === 'batch-release' ? '放行' : '拒收');
      return;
    }
    if (action === 'batch-del') {
      const id = el.dataset.id;
      armDelete(el, async function () {
        try {
          await api('DELETE', '/api/batches/' + encodeURIComponent(id));
          delete state.batchDetail[id];
          state.expandedBatches.delete(id);
          await refreshAfterMutation();
        } catch (err) { showError(err); }
      });
      return;
    }
    if (action === 'record-add') { openRecordForm(); return; }
    if (action === 'record-del') {
      const id = el.dataset.id;
      armDelete(el, async function () {
        try {
          await api('DELETE', '/api/records/' + encodeURIComponent(id));
          await refreshAfterMutation();
        } catch (err) { showError(err); }
      });
      return;
    }
  } catch (err) { showError(err); }
}

async function toggleExpand(kind, id) {
  try {
    if (kind === 'room') {
      if (state.expandedRooms.has(id)) { state.expandedRooms.delete(id); renderRoomRows(); }
      else await expandRoom(id);
      return;
    }
    if (kind === 'batch') {
      if (state.expandedBatches.has(id)) { state.expandedBatches.delete(id); renderBatchRows(); }
      else await expandBatch(id);
    }
  } catch (err) { showError(err); }
}

document.body.addEventListener('click', function (e) {
  const tab = e.target.closest('.tab');
  if (tab && tab.dataset.view) { switchView(tab.dataset.view); return; }

  const actionEl = e.target.closest('[data-action]');
  if (actionEl) { handleAction(actionEl.dataset.action, actionEl); return; }

  const row = e.target.closest('tr.row-main');
  if (row && row.dataset.rowkind) { toggleExpand(row.dataset.rowkind, row.dataset.id); }
});

$('filters').addEventListener('change', onFilterInput);
$('filters').addEventListener('input', onFilterInput);

$('modalClose').addEventListener('click', closeModal);
$('modalCancel').addEventListener('click', closeModal);
$('modalOk').addEventListener('click', function () {
  if (modalOnOk) modalOnOk();
});
$('modalMask').addEventListener('click', function (e) {
  if (e.target === $('modalMask')) closeModal();
});

/* ---------- 启动 ---------- */

async function boot() {
  try {
    const results = await Promise.all([
      api('GET', '/api/summary'),
      api('GET', '/api/settings'),
      api('GET', '/api/rooms'),
      api('GET', '/api/probes'),
      api('GET', '/api/batches')
    ]);
    state.summary = results[0];
    state.settings = results[1];
    state.rooms = results[2];
    state.probes = results[3];
    state.batches = results[4];
    $('todayText').textContent = state.summary.today;
    renderOverview();
  } catch (err) { showError(err); }

  renderFilters();
  await loadView(state.view);
}

boot();
