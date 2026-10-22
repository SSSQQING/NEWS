'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { compressImage } = require('./processor');
const { pathKey } = require('./scan');
const { renderName, sanitizeFileName } = require('../shared/naming');

const UNIT = { KB: 1024, MB: 1024 * 1024 };

function normalizeSettings(s = {}) {
  const output = { mode: 'subfolder', subfolder: 'compressed', dir: '', keepStructure: true, trashOriginal: true, conflict: 'rename', ...(s.output || {}) };
  if (output.mode === 'folder' && !output.dir) output.mode = 'subfolder';
  // 覆盖模式下只有“换了扩展名撞上别的文件”这一种冲突，永远自动改名，绝不误伤
  if (output.mode === 'overwrite') output.conflict = 'rename';
  const maxSize = Number(s.maxSize);
  return {
    process: {
      format: s.format || 'original',
      quality: Number(s.quality) || 80,
      maxBytes: s.limitSize && maxSize > 0 ? Math.floor(maxSize * (UNIT[s.sizeUnit] || UNIT.KB)) : 0,
      allowDownscale: s.allowDownscale !== false,
      keepMetadata: !!s.keepMetadata,
      keepSmaller: s.keepSmaller !== false,
      resize: s.resize || { mode: 'none' },
    },
    output,
    naming: s.naming || { mode: 'original' },
  };
}

function outputDirFor(file, output) {
  const srcDir = path.dirname(file.path);
  if (output.mode === 'overwrite') return srcDir;
  if (output.mode === 'folder' && output.dir) {
    if (output.keepStructure && file.baseDir) {
      const rel = path.relative(file.baseDir, srcDir);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return path.join(output.dir, rel);
    }
    return output.dir;
  }
  return path.join(srcDir, sanitizeFileName(output.subfolder, 'compressed'));
}

// 同步分配输出路径：JS 单线程，所以并发任务之间不会抢到同一个名字
class OutputAllocator {
  constructor(inputPaths) {
    this.reserved = new Set();
    this.inputs = new Set(inputPaths.map(pathKey));
  }

  busy(p) {
    const k = pathKey(p);
    return this.reserved.has(k) || this.inputs.has(k) || fs.existsSync(p);
  }

  take(p) {
    this.reserved.add(pathKey(p));
    return p;
  }

  allocate(target, { policy, source, overwriteMode }) {
    const k = pathKey(target);
    if (overwriteMode && k === pathKey(source)) return { path: this.take(target), replaceSource: true };
    if (!this.busy(target)) return { path: this.take(target) };

    // 撞上本批次别的输出或待处理的源图：一律改名，策略只管磁盘上已有的旧文件
    const internal = this.reserved.has(k) || this.inputs.has(k);
    if (!internal && policy === 'skip') return null;
    if (!internal && policy === 'overwrite') return { path: this.take(target) };

    const { dir, name, ext } = path.parse(target);
    for (let i = 1; ; i++) {
      const candidate = path.join(dir, `${name} (${i})${ext}`);
      if (!this.busy(candidate)) return { path: this.take(candidate) };
    }
  }
}

async function writeOutput(target, data, { source, overwriteMode, trashOriginal, trash }) {
  const dir = path.dirname(target);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  await fsp.writeFile(tmp, data);

  const replacingSelf = overwriteMode && pathKey(target) === pathKey(source);
  let sourceGone = false;
  try {
    if (replacingSelf && trashOriginal) {
      await trash(source);
      sourceGone = true;
    }
    await fsp.rename(tmp, target);
  } catch (err) {
    if (sourceGone) throw new Error(`原图已移入回收站，但新文件没能写入，临时文件保留在：${tmp}`);
    await fsp.rm(tmp, { force: true });
    throw err;
  }

  // 覆盖模式下换了格式：新文件落盘成功后再处理掉原图
  if (overwriteMode && !replacingSelf) {
    if (trashOriginal) await trash(source);
    else await fsp.unlink(source);
  }
}

function friendlyError(err) {
  const msg = String((err && err.message) || err);
  if (/unsupported image format|VipsForeignLoad|corrupt|premature end|bad seek|Input buffer/i.test(msg)) return '无法解码：格式不支持或文件已损坏';
  if (/EBUSY/.test(msg)) return '文件正被其他程序占用';
  if (/EACCES|EPERM/.test(msg)) return '没有写入权限（文件只读或被占用）';
  if (/ENOSPC/.test(msg)) return '磁盘空间不足';
  if (/ENOENT/.test(msg)) return '文件不存在或已被移走';
  if (/trash/i.test(msg)) return '无法移入回收站，原图未改动';
  return msg.length > 140 ? `${msg.slice(0, 140)}…` : msg;
}

/**
 * files: [{ id, path, baseDir, index }]
 * onProgress 事件：working / done / skipped / error
 */
async function runJob({ files, settings, onProgress = () => {}, isCancelled = () => false, trash, concurrency = 2, now = new Date() }) {
  const s = normalizeSettings(settings);
  const overwriteMode = s.output.mode === 'overwrite';
  const allocator = new OutputAllocator(files.map(f => f.path));
  const summary = { total: files.length, done: 0, failed: 0, skipped: 0, inBytes: 0, outBytes: 0, cancelled: false, outDirs: [] };
  const dirs = new Set();
  const moveToTrash = trash || (p => fsp.unlink(p));

  async function processOne(file, i) {
    onProgress({ id: file.id, status: 'working' });
    try {
      const r = await compressImage(file.path, s.process);
      const parsed = path.parse(file.path);
      const name = overwriteMode
        ? parsed.name
        : renderName(s.naming, {
          name: parsed.name,
          index: Number.isInteger(file.index) ? file.index : i,
          width: r.width,
          height: r.height,
          date: now,
          folder: path.basename(parsed.dir),
          fmt: r.ext.slice(1).toLowerCase(),
        });
      const target = path.join(outputDirFor(file, s.output), name + r.ext);
      const slot = allocator.allocate(target, { policy: s.output.conflict, source: file.path, overwriteMode });
      if (!slot) {
        summary.skipped++;
        onProgress({ id: file.id, status: 'skipped', reason: '同名文件已存在，已跳过' });
        return;
      }
      // 原图本身就是最优解，并且是原地覆盖：什么都不用写
      if (!(slot.replaceSource && r.kept)) {
        await writeOutput(slot.path, r.data, { source: file.path, overwriteMode, trashOriginal: s.output.trashOriginal, trash: moveToTrash });
      }
      summary.done++;
      summary.inBytes += r.inputSize;
      summary.outBytes += r.data.length;
      dirs.add(path.dirname(slot.path));
      onProgress({
        id: file.id,
        status: 'done',
        outPath: slot.path,
        outSize: r.data.length,
        inSize: r.inputSize,
        width: r.width,
        height: r.height,
        quality: r.quality,
        format: r.format,
        ok: r.ok,
        kept: r.kept,
        replaced: overwriteMode,
      });
    } catch (err) {
      summary.failed++;
      onProgress({ id: file.id, status: 'error', error: friendlyError(err) });
    }
  }

  let next = 0;
  const worker = async () => {
    while (next < files.length && !isCancelled()) {
      const i = next++;
      await processOne(files[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, files.length)) }, worker));

  summary.cancelled = next < files.length;
  summary.outDirs = [...dirs];
  return summary;
}

module.exports = { runJob, normalizeSettings, outputDirFor, OutputAllocator, friendlyError };
