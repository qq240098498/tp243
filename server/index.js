const path = require('path');
const express = require('express');
const api = require('./api');
const store = require('./store');

const app = express();
const port = Number(Number(process.env.PORT || 5243));

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', api);

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || '服务端出错了',
      details: err.details || null,
    },
  });
});

app.listen(port, () => {
  let info = '';
  try {
    const data = store.load();
    info = '冷库或者车厢 ' + data.rooms.length + ' 个、探头 ' + data.probes.length + ' 个、批次 ' + data.batches.length + ' 条、温度记录 ' + data.records.length + ' 条';
  } catch (err) {
    info = '数据文件还没准备好：' + err.message;
  }
  console.log('冷链温控与批次放行台已启动：http://localhost:' + port + '（' + info + '）');
});
