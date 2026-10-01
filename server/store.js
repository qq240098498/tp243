const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

const dataFile = path.join(__dirname, '..', 'data', 'db.json');

const DEFAULT_SETTINGS = {
  lowerLimitC: 2,
  upperLimitC: 8,
  allowExcursionMinutes: 30,
  allowTotalExcursionMinutes: 120,
  chainGapMinutes: 15,
  mktActivationEnergy: 83144,
  gasConstant: 8.314,
  probeCalibrationGraceDays: 0,
  recordIntervalMinutes: 15,
};

function normalize(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  for (const key of ['rooms', 'probes', 'batches', 'records', 'releases']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  return data;
}

function load() {
  let text;
  try {
    text = fs.readFileSync(dataFile, 'utf8');
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件读不出来，请检查 data/db.json 是否还在');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件解析失败，请检查 data/db.json 的内容');
  }
  return normalize(raw);
}

function save(data) {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
}

function nextId(prefix, list) {
  let max = 0;
  for (const item of list || []) {
    const matched = String(item.id || '').match(/(\d+)$/);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

function round(n, digits) {
  const d = digits == null ? 2 : digits;
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(d));
}

function minutesBetween(a, b) {
  const toDate = (s) => new Date(String(s).replace(' ', 'T') + '+08:00');
  return Math.round((toDate(b) - toDate(a)) / 60000);
}

function nowText() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return now.getUTCFullYear() + '-' + p(now.getUTCMonth() + 1) + '-' + p(now.getUTCDate()) + ' ' + p(now.getUTCHours()) + ':' + p(now.getUTCMinutes()) + ':' + p(now.getUTCSeconds());
}

module.exports = { load, save, nextId, normalize, round, minutesBetween, nowText, DEFAULT_SETTINGS, dataFile };
