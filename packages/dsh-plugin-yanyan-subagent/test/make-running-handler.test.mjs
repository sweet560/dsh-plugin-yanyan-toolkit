// dsh-plugin-yanyan-subagent / test/make-running-handler.test.mjs
//
// 回归：清理全部空闲误删运行中子智能体的 host 侧数据源。
// makeRunningHandler 用现成的 isRunningSubagent（读 ctx.get('agents').get(id).status）
// 对 client 传来的 ids 逐个判定，返回真正运行中的核心 id 集合。
// 不 hack 内部函数：通过 import 拿导出的 makeRunningHandler，用可控 ctx/req/res
// 真实跑一遍 handler（req 用 EventEmitter 喂 data/end，res 捕获 writeHead/end）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href);
const { makeRunningHandler, RUNNING_ROUTE } = mod;

function makeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(payload) { this.body = payload; },
  };
}

function makeReq(body, method = 'POST') {
  const req = new EventEmitter();
  req.method = method;
  // handler 同步注册完监听后再喂数据。
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeCtx(agents) {
  return {
    connection: { requestRejection() { return undefined; } },
    get(name) {
      if (name === 'agents') return { get: (id) => agents[id] };
      return undefined;
    },
  };
}

async function invoke(agents, body, method) {
  const ctx = makeCtx(agents);
  const handler = makeRunningHandler(ctx);
  const req = makeReq(body, method);
  const res = makeRes();
  await handler(req, res);
  return { res, json: JSON.parse(res.body || '{}') };
}

test('RUNNING_ROUTE 常量指向 /running', () => {
  assert.equal(RUNNING_ROUTE, '/__dsh-plugin-yanyan-subagent/running');
});

test('makeRunningHandler：只返回真正 running 的核心 id（含 session- 归一化）', async () => {
  const agents = {
    a: { status: 'running' },
    b: { status: 'idle' },
    c: { status: 'running' },
  };
  const { res, json } = await invoke(agents, { ids: ['session-a', 'b', 'c', 'missing'] });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.deepEqual(json.runningIds, ['a', 'c'], '运行中的核心 id 才返回；idle/缺失排除');
});

test('makeRunningHandler：拼写兼容——agents 里只有 session- 拼写也算运行中', async () => {
  const agents = {
    'session-x': { status: 'running' },
  };
  const { json } = await invoke(agents, { ids: ['x'] });
  assert.deepEqual(json.runningIds, ['x'], 'core id 查不到时应尝试 session- 拼写');
});

test('makeRunningHandler：非法 ids 被过滤、空体安全', async () => {
  const agents = { a: { status: 'running' } };
  const withBad = await invoke(agents, { ids: ['a', null, 3, {}, ''] });
  assert.deepEqual(withBad.json.runningIds, ['a'], '数字/空串虽通过类型过滤，但未命中 agents 不算运行中');
  const empty = await invoke(agents, {});
  assert.deepEqual(empty.json.runningIds, []);
});

test('makeRunningHandler：非 POST 返回 405', async () => {
  const { res, json } = await invoke({ a: { status: 'running' } }, { ids: ['a'] }, 'GET');
  assert.equal(res.status, 405);
  assert.equal(json.ok, false);
});

test('makeRunningHandler：服务缺失时保守返回空（不误标运行中）', async () => {
  const ctx = {
    connection: { requestRejection() { return undefined; } },
    get() { return undefined; },
  };
  const handler = makeRunningHandler(ctx);
  const req = makeReq({ ids: ['a'] });
  const res = makeRes();
  await handler(req, res);
  assert.deepEqual(JSON.parse(res.body).runningIds, []);
});
