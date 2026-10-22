'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

// Electron 的工作线程能直接从 app.asar 里加载脚本；sharp 的原生模块按 asarUnpack 自动转到解包目录
const WORKER_PATH = path.join(__dirname, 'worker.js');

function revive(result) {
  if (result && result.data instanceof Uint8Array) {
    return { ...result, data: Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength) };
  }
  return result;
}

class WorkerPool {
  constructor(size) {
    this.size = Math.max(1, size);
    this.workers = [];
    this.queue = [];
    this.nextId = 1;
  }

  run(type, payload) {
    return new Promise((resolve, reject) => {
      this.queue.push({ type, payload, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.queue.length) {
      let worker = this.workers.find(w => !w.task);
      if (!worker) {
        if (this.workers.length >= this.size) return;
        worker = this.spawn();
      }
      const task = this.queue.shift();
      task.id = this.nextId++;
      worker.task = task;
      worker.postMessage({ id: task.id, type: task.type, payload: task.payload });
    }
  }

  spawn() {
    const worker = new Worker(WORKER_PATH);
    worker.task = null;
    worker.on('message', msg => {
      const task = worker.task;
      worker.task = null;
      if (task && task.id === msg.id) {
        if (msg.ok) task.resolve(revive(msg.result));
        else task.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      }
      this.pump();
    });
    const fail = err => {
      this.workers = this.workers.filter(w => w !== worker);
      if (worker.task) worker.task.reject(err instanceof Error ? err : new Error(`处理线程异常退出（${err}）`));
      worker.task = null;
      this.pump();
    };
    worker.on('error', fail);
    worker.on('exit', code => {
      if (this.workers.includes(worker)) fail(code);
    });
    this.workers.push(worker);
    return worker;
  }

  async destroy() {
    const workers = this.workers;
    this.workers = [];
    this.queue.forEach(t => t.reject(new Error('处理线程已关闭')));
    this.queue = [];
    await Promise.all(workers.map(w => w.terminate()));
  }
}

module.exports = { WorkerPool };
