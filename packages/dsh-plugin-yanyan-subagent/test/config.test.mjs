import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, DEFAULT_TAB_LABEL, CONFIG_DEFAULTS } from '../lib/index.js';

test('normalizeConfig 缺省兜底：undefined / 空对象回落到全套默认值', () => {
  for (const input of [undefined, null, {}, 0, 'x']) {
    const c = normalizeConfig(input);
    assert.equal(c.tabLabel, DEFAULT_TAB_LABEL);
    assert.equal(c.autoCleanEnabled, true);
    assert.equal(c.idleMinutes, CONFIG_DEFAULTS.idleMinutes);
    assert.equal(c.checkIntervalMin, CONFIG_DEFAULTS.checkIntervalMin);
    assert.equal(c.labelMaxLength, 24);
  }
});

test('normalizeConfig tabLabel 清洗：去首尾空白、空回落默认、超长截断', () => {
  assert.equal(normalizeConfig({ tabLabel: '  我的标签  ' }).tabLabel, '我的标签');
  assert.equal(normalizeConfig({ tabLabel: '' }).tabLabel, DEFAULT_TAB_LABEL);
  assert.equal(normalizeConfig({ tabLabel: '   ' }).tabLabel, DEFAULT_TAB_LABEL);
  assert.equal(normalizeConfig({ tabLabel: 123 }).tabLabel, DEFAULT_TAB_LABEL);
  const long = normalizeConfig({ tabLabel: 'x'.repeat(40) }).tabLabel;
  assert.equal(long.length, 24);
  assert.equal(long, 'x'.repeat(24));
});

test('normalizeConfig idleMinutes 越界 / 非法回落，合法值取整保留', () => {
  assert.equal(normalizeConfig({ idleMinutes: 0 }).idleMinutes, 30);
  assert.equal(normalizeConfig({ idleMinutes: -5 }).idleMinutes, 30);
  assert.equal(normalizeConfig({ idleMinutes: 10081 }).idleMinutes, 30);
  assert.equal(normalizeConfig({ idleMinutes: 'abc' }).idleMinutes, 30);
  assert.equal(normalizeConfig({ idleMinutes: null }).idleMinutes, 30);
  assert.equal(normalizeConfig({ idleMinutes: 60 }).idleMinutes, 60);
  assert.equal(normalizeConfig({ idleMinutes: 10080 }).idleMinutes, 10080);
  assert.equal(normalizeConfig({ idleMinutes: 7.9 }).idleMinutes, 7);
});

test('normalizeConfig checkIntervalMin 与 autoCleanEnabled 兜底', () => {
  assert.equal(normalizeConfig({ checkIntervalMin: 0 }).checkIntervalMin, 10);
  assert.equal(normalizeConfig({ checkIntervalMin: 1441 }).checkIntervalMin, 10);
  assert.equal(normalizeConfig({ checkIntervalMin: 'x' }).checkIntervalMin, 10);
  assert.equal(normalizeConfig({ checkIntervalMin: 5 }).checkIntervalMin, 5);
  assert.equal(normalizeConfig({ autoCleanEnabled: 1 }).autoCleanEnabled, false);
  assert.equal(normalizeConfig({ autoCleanEnabled: 'true' }).autoCleanEnabled, false);
  assert.equal(normalizeConfig({ autoCleanEnabled: true }).autoCleanEnabled, true);
});
