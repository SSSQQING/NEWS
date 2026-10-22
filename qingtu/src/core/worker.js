'use strict';

// 工作线程：压缩、缩略图、预览都在这里跑，主进程只管调度，界面不会卡

const { parentPort } = require('worker_threads');
const { compressImage, makeThumbnail, previewBuffer } = require('./processor');

const TASKS = {
  compress: ({ input, opts }) => compressImage(input, opts),
  thumbnail: ({ input }) => makeThumbnail(input),
  preview: async ({ input }) => ({ data: await previewBuffer(input) }),
};

// Buffer 可能借用 Node 的共享内存池，单独拷一份 ArrayBuffer 才能零拷贝转移给主线程
function detach(result) {
  if (!result || !(result.data instanceof Uint8Array)) return { result, transfer: [] };
  const ab = result.data.buffer.slice(result.data.byteOffset, result.data.byteOffset + result.data.byteLength);
  return { result: { ...result, data: new Uint8Array(ab) }, transfer: [ab] };
}

parentPort.on('message', async ({ id, type, payload }) => {
  try {
    const task = TASKS[type];
    if (!task) throw new Error(`未知任务：${type}`);
    const { result, transfer } = detach(await task(payload));
    parentPort.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: { message: String((err && err.message) || err), code: err && err.code } });
  }
});
