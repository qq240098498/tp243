const express = require('express');
const store = require('./store');
const { AppError } = require('./errors');
const res = require('./resources');
const coldlib = require('./coldlib');

const router = express.Router();

function withData(handler) {
  return (req, reqRes, next) => {
    try {
      const data = store.load();
      const result = handler(data, req);
      if (result && result.__save === true) store.save(data);
      if (result && typeof result === 'object' && '__body' in result) reqRes.json(result.__body);
      else reqRes.json(result);
    } catch (err) {
      next(err);
    }
  };
}

function overview(data) {
  const settings = data.settings;
  const batches = data.batches.map((b) => res.listBatches.length ? Object.assign({}, b) : b);
  const decorated = data.batches.map((b) => {
    const detail = coldlib.releaseCheck(data, b);
    return { batch: b, check: detail };
  });
  const statusCount = {};
  for (const b of data.batches) statusCount[b.status] = (statusCount[b.status] || 0) + 1;
  const open = data.batches.filter((b) => b.status === '在库' || b.status === '待放行');
  const readyToRelease = decorated.filter((d) => (d.batch.status === '在库' || d.batch.status === '待放行') && d.check.pass).length;
  const blockedCount = decorated.filter((d) => (d.batch.status === '在库' || d.batch.status === '待放行') && !d.check.pass).length;
  const noRecordBatches = data.batches.filter((b) => !data.records.some((r) => r.batchId === b.id)).length;
  const expiredProbes = data.probes.filter((p) => !coldlib.probeValidOn(p, store.nowText().slice(0, 10))).length;
  const mktValues = decorated.map((d) => d.check.mkt).filter((v) => v > 0);
  return {
    today: store.nowText().slice(0, 10),
    roomCount: data.rooms.length,
    runningRoomCount: data.rooms.filter((r) => r.status === '运行').length,
    probeCount: data.probes.length,
    runningProbeCount: data.probes.filter((p) => p.status === '在用').length,
    expiredProbeCount: expiredProbes,
    batchCount: data.batches.length,
    statusCount,
    openBatchCount: open.length,
    recordCount: data.records.length,
    manualRecordCount: data.records.filter((r) => r.source === '人工').length,
    releaseCount: data.releases.length,
    releasedCount: data.releases.filter((r) => r.decision === '放行').length,
    rejectedCount: data.releases.filter((r) => r.decision === '拒收').length,
    readyToRelease,
    blockedCount,
    noRecordBatches,
    maxMkt: mktValues.length ? store.round(Math.max.apply(null, mktValues)) : 0,
    averageMkt: mktValues.length ? store.round(mktValues.reduce((a, b) => a + b, 0) / mktValues.length) : 0,
    settings: {
      lowerLimitC: Number(settings.lowerLimitC),
      upperLimitC: Number(settings.upperLimitC),
      allowExcursionMinutes: Number(settings.allowExcursionMinutes),
      allowTotalExcursionMinutes: Number(settings.allowTotalExcursionMinutes),
      chainGapMinutes: Number(settings.chainGapMinutes),
      recordIntervalMinutes: Number(settings.recordIntervalMinutes),
    },
    rooms: data.rooms.map((r) => {
      const probes = data.probes.filter((p) => p.roomId === r.id);
      const batches = data.batches.filter((b) => b.roomId === r.id);
      return {
        id: r.id, code: r.code, name: r.name, type: r.type, status: r.status,
        probeCount: probes.length, batchCount: batches.length,
        openBatchCount: batches.filter((b) => b.status === '在库' || b.status === '待放行').length,
      };
    }),
  };
}

router.get('/health', (req, r) => r.json({ ok: true, service: '冷链温控与批次放行台', time: new Date().toISOString() }));
router.get('/summary', withData((data) => overview(data)));
router.get('/settings', withData((data) => data.settings));
router.patch('/settings', withData((data, req) => {
  const patch = req.body || {};
  for (const key of Object.keys(store.DEFAULT_SETTINGS)) if (patch[key] !== undefined) data.settings[key] = patch[key];
  return { __save: true, __body: data.settings };
}));

router.get('/rooms', withData((data, req) => res.listRooms(data, req.query)));
router.post('/rooms', withData((data, req) => ({ __save: true, __body: res.createRoom(data, req.body || {}) })));
router.get('/rooms/:id', withData((data, req) => res.roomDetail(data, req.params.id)));
router.patch('/rooms/:id', withData((data, req) => ({ __save: true, __body: res.updateRoom(data, req.params.id, req.body || {}) })));
router.delete('/rooms/:id', withData((data, req) => ({ __save: true, __body: res.removeRoom(data, req.params.id) })));

router.get('/probes', withData((data, req) => res.listProbes(data, req.query)));
router.post('/probes', withData((data, req) => ({ __save: true, __body: res.createProbe(data, req.body || {}) })));
router.patch('/probes/:id', withData((data, req) => ({ __save: true, __body: res.updateProbe(data, req.params.id, req.body || {}) })));
router.delete('/probes/:id', withData((data, req) => ({ __save: true, __body: res.removeProbe(data, req.params.id) })));

router.get('/batches', withData((data, req) => res.listBatches(data, req.query)));
router.post('/batches', withData((data, req) => ({ __save: true, __body: res.createBatch(data, req.body || {}) })));
router.get('/batches/:id', withData((data, req) => res.batchDetail(data, req.params.id)));
router.patch('/batches/:id', withData((data, req) => ({ __save: true, __body: res.updateBatch(data, req.params.id, req.body || {}) })));
router.delete('/batches/:id', withData((data, req) => ({ __save: true, __body: res.removeBatch(data, req.params.id) })));
router.get('/batches/:id/release-check', withData((data, req) => {
  const batch = data.batches.find((b) => b.id === req.params.id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  return coldlib.releaseCheck(data, batch);
}));
router.post('/batches/:id/decision', withData((data, req) => ({ __save: true, __body: res.decide(data, req.params.id, req.body || {}) })));

router.get('/records', withData((data, req) => res.listRecords(data, req.query)));
router.post('/records', withData((data, req) => ({ __save: true, __body: res.createRecord(data, req.body || {}) })));
router.delete('/records/:id', withData((data, req) => ({ __save: true, __body: res.removeRecord(data, req.params.id) })));

router.get('/releases', withData((data, req) => res.listReleases(data, req.query)));

router.use((req, r, next) => next(new AppError(404, 'NOT_FOUND', '这个地址没有对应功能：' + req.method + ' ' + req.originalUrl)));

module.exports = router;
