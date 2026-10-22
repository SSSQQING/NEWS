'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runJob, normalizeSettings } = require('../src/core/job');
const { expandPaths } = require('../src/core/scan');
const { renderName, sanitizeFileName } = require('../src/shared/naming');
const { tmpDir, writePhoto } = require('./helpers');

const base = { format: 'jpeg', quality: 75, limitSize: false, resize: { mode: 'none' }, naming: { mode: 'original' } };

async function setup(names) {
  const dir = tmpDir();
  for (const n of names) {
    fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true });
    await writePhoto(path.join(dir, n), 320, 240);
  }
  return dir;
}

async function run(dir, settings, extra = {}) {
  const entries = await expandPaths([dir]);
  const files = entries.map((e, i) => ({ id: i + 1, path: e.path, baseDir: e.baseDir, index: i }));
  const events = [];
  const summary = await runJob({ files, settings, onProgress: e => events.push(e), ...extra });
  return { summary, done: events.filter(e => e.status === 'done'), events };
}

test('默认导出到原图旁的子文件夹，可用默认命名', async () => {
  const dir = await setup(['a.jpg', 'b.png']);
  const { summary, done } = await run(dir, { ...base, output: { mode: 'subfolder', subfolder: 'out' }, naming: { mode: 'default' } });
  assert.equal(summary.done, 2);
  assert.deepEqual(done.map(d => path.relative(dir, d.outPath)).sort(), [path.join('out', 'a_compressed.jpg'), path.join('out', 'b_compressed.jpg')]);
  assert.ok(fs.existsSync(path.join(dir, 'a.jpg')));
});

test('自定义命名：序号补零、起始值、尺寸变量', async () => {
  const dir = await setup(['x.jpg', 'y.jpg', 'z.jpg']);
  const out = tmpDir();
  const { done } = await run(dir, { ...base, output: { mode: 'folder', dir: out }, naming: { mode: 'custom', template: '商品图_{n}_{w}x{h}', start: 9, digits: 3 } });
  assert.deepEqual(done.map(d => path.basename(d.outPath)).sort(), ['商品图_009_320x240.jpg', '商品图_010_320x240.jpg', '商品图_011_320x240.jpg']);
});

test('模板里没序号时，同批次重名自动加 (1)(2)', async () => {
  const dir = await setup(['1.jpg', '2.jpg', '3.jpg']);
  const out = tmpDir();
  const { done } = await run(dir, { ...base, output: { mode: 'folder', dir: out, conflict: 'skip' }, naming: { mode: 'custom', template: 'same' } });
  assert.deepEqual(done.map(d => path.basename(d.outPath)).sort(), ['same (1).jpg', 'same (2).jpg', 'same.jpg']);
});

test('磁盘上已有同名文件：改名 / 跳过 / 覆盖', async () => {
  const dir = await setup(['p.jpg']);
  const out = tmpDir();
  fs.writeFileSync(path.join(out, 'p.jpg'), 'old');

  let r = await run(dir, { ...base, output: { mode: 'folder', dir: out, conflict: 'rename' } });
  assert.equal(path.basename(r.done[0].outPath), 'p (1).jpg');

  r = await run(dir, { ...base, output: { mode: 'folder', dir: out, conflict: 'skip' } });
  assert.equal(r.summary.skipped, 1);
  assert.equal(fs.readFileSync(path.join(out, 'p.jpg'), 'utf8'), 'old');

  r = await run(dir, { ...base, output: { mode: 'folder', dir: out, conflict: 'overwrite' } });
  assert.equal(r.done[0].outPath, path.join(out, 'p.jpg'));
  assert.notEqual(fs.readFileSync(path.join(out, 'p.jpg'), 'utf8'), 'old');
});

test('导出到同一文件夹时绝不覆盖待处理的源图', async () => {
  const dir = await setup(['q.jpg']);
  const before = fs.readFileSync(path.join(dir, 'q.jpg'));
  const { done } = await run(dir, { ...base, output: { mode: 'folder', dir, conflict: 'overwrite' } });
  assert.equal(path.basename(done[0].outPath), 'q (1).jpg');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'q.jpg')), before);
});

test('统一导出时保留子目录结构', async () => {
  const dir = await setup(['top.jpg', path.join('sub', 'deep', 'in.jpg')]);
  const out = tmpDir();
  const { done } = await run(dir, { ...base, output: { mode: 'folder', dir: out, keepStructure: true } });
  assert.deepEqual(done.map(d => path.relative(out, d.outPath)).sort(), [path.join('sub', 'deep', 'in.jpg'), 'top.jpg']);

  const flat = tmpDir();
  const r = await run(dir, { ...base, output: { mode: 'folder', dir: flat, keepStructure: false } });
  assert.deepEqual(r.done.map(d => path.relative(flat, d.outPath)).sort(), ['in.jpg', 'top.jpg']);
});

test('覆盖源文件：同格式原地替换，原图进回收站', async () => {
  const dir = await setup(['o.jpg']);
  const src = path.join(dir, 'o.jpg');
  const trashed = [];
  const trash = async p => { trashed.push(p); fs.renameSync(p, `${p}.trashed`); };
  const { done } = await run(dir, { ...base, quality: 30, output: { mode: 'overwrite', trashOriginal: true } }, { trash });
  assert.equal(done[0].outPath, src);
  assert.deepEqual(trashed, [src]);
  assert.ok(fs.statSync(src).size < fs.statSync(`${src}.trashed`).size);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['o.jpg', 'o.jpg.trashed']);
});

test('覆盖源文件：换格式后写新文件并移走原图', async () => {
  const dir = await setup(['c.png']);
  const trashed = [];
  const { done } = await run(dir, { ...base, format: 'webp', output: { mode: 'overwrite', trashOriginal: true } }, { trash: async p => { trashed.push(p); fs.unlinkSync(p); } });
  assert.equal(done[0].outPath, path.join(dir, 'c.webp'));
  assert.deepEqual(fs.readdirSync(dir), ['c.webp']);
  assert.equal(trashed.length, 1);
});

test('覆盖源文件且不进回收站：直接替换', async () => {
  const dir = await setup(['d.jpg']);
  const { done } = await run(dir, { ...base, quality: 30, output: { mode: 'overwrite', trashOriginal: false } }, { trash: () => assert.fail('不该调用回收站') });
  assert.equal(done[0].outPath, path.join(dir, 'd.jpg'));
  assert.deepEqual(fs.readdirSync(dir), ['d.jpg']);
});

test('取消后不再派发新任务', async () => {
  const dir = await setup(['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg']);
  let count = 0;
  const { summary } = await run(dir, { ...base, output: { mode: 'subfolder' } }, { concurrency: 1, onProgress: e => { if (e.status === 'done') count++; }, isCancelled: () => count >= 2 });
  assert.equal(summary.cancelled, true);
  assert.equal(count, 2);
});

test('坏文件报错但不影响其他文件', async () => {
  const dir = await setup(['good.jpg']);
  fs.writeFileSync(path.join(dir, 'bad.jpg'), 'not an image');
  const { summary, events } = await run(dir, { ...base, output: { mode: 'subfolder' } });
  assert.equal(summary.done, 1);
  assert.equal(summary.failed, 1);
  assert.match(events.find(e => e.status === 'error').error, /无法解码/);
});

test('扫描文件夹时跳过隐藏目录和上次的输出目录', async () => {
  const dir = await setup(['a.jpg', path.join('compressed', 'a.jpg'), path.join('.cache', 'x.jpg'), path.join('more', 'b.webp')]);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi');
  const entries = await expandPaths([dir], { skipDirNames: ['compressed'] });
  assert.deepEqual(entries.map(e => path.relative(dir, e.path)), ['a.jpg', path.join('more', 'b.webp')]);
  assert.ok(entries.every(e => e.baseDir === dir));
});

test('体积单位换算与非法输入兜底', () => {
  assert.equal(normalizeSettings({ limitSize: true, maxSize: 1.5, sizeUnit: 'MB' }).process.maxBytes, 1572864);
  assert.equal(normalizeSettings({ limitSize: true, maxSize: 200, sizeUnit: 'KB' }).process.maxBytes, 204800);
  assert.equal(normalizeSettings({ limitSize: false, maxSize: 200 }).process.maxBytes, 0);
  assert.equal(normalizeSettings({ output: { mode: 'folder', dir: '' } }).output.mode, 'subfolder');
});

test('文件名清洗', () => {
  assert.equal(sanitizeFileName('a/b:c*?"<>|'), 'a_b_c______');
  assert.equal(sanitizeFileName('CON'), 'CON_');
  assert.equal(sanitizeFileName('  name.. '), 'name');
  assert.equal(renderName({ mode: 'custom', template: '' }, { name: 'orig' }), 'orig');
  assert.equal(renderName({ mode: 'custom', template: '{date}' }, { name: 'o', date: new Date(2026, 0, 5, 7, 8, 9) }), '20260105');
  assert.equal(renderName({ mode: 'custom', template: '{folder}-{n}', start: 0, digits: 2 }, { name: 'o', folder: '春游', index: 4 }), '春游-04');
});
