'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, protocol, net, Menu } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { INPUT_EXTS, makeThumbnail, previewBuffer } = require('./core/processor');
const { expandPaths, pathKey } = require('./core/scan');
const { runJob } = require('./core/job');

protocol.registerSchemesAsPrivileged([
  { scheme: 'qingtu', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// 与 styles.css 里 --titlebar 的颜色保持一致
const TITLEBAR = {
  light: { color: '#f3f4f7', symbolColor: '#4a5160' },
  dark: { color: '#0d0f13', symbolColor: '#c3c9d4' },
};
const BROWSER_IMAGE = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.webp', '.avif', '.gif', '.svg']);
const IMAGE_FILTER = [{ name: '图片', extensions: [...INPUT_EXTS].map(e => e.slice(1)) }];
const isMac = process.platform === 'darwin';

// 渲染进程只能读用户亲手添加过的文件和本软件的输出，防止被诱导去读任意路径
const knownFiles = new Set();
const knownDirs = new Set();
let win = null;
let job = null;

const statePath = () => path.join(app.getPath('userData'), 'state.json');
const titlebarColors = () => (nativeTheme.shouldUseDarkColors ? TITLEBAR.dark : TITLEBAR.light);

function remember(entries) {
  for (const e of entries) {
    knownFiles.add(pathKey(e.path));
    knownDirs.add(pathKey(path.dirname(e.path)));
  }
  return entries;
}

function assertKnown(p) {
  if (typeof p !== 'string' || !knownFiles.has(pathKey(p))) throw new Error('未授权的文件路径');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: '轻图',
    backgroundColor: titlebarColors().color,
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 16 } } : { titleBarOverlay: { ...titlebarColors(), height: 48 } }),
    icon: path.join(__dirname, 'renderer/assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('closed', () => {
    win = null;
  });
}

function filesFromArgv(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter(a => !a.startsWith('-') && fs.existsSync(a));
}

async function sendExternal(argv) {
  const paths = filesFromArgv(argv);
  if (!paths.length || !win) return;
  const entries = remember(await expandPaths(paths));
  win.webContents.send('external-files', entries);
}

function registerProtocol() {
  protocol.handle('qingtu', async req => {
    try {
      const p = new URL(req.url).searchParams.get('p');
      assertKnown(p);
      if (BROWSER_IMAGE.has(path.extname(p).toLowerCase())) return net.fetch(pathToFileURL(p).toString());
      return new Response(await previewBuffer(p), { headers: { 'content-type': 'image/png' } });
    } catch (err) {
      return new Response(String(err.message || err), { status: 403 });
    }
  });
}

function registerIpc() {
  ipcMain.handle('pick-files', async () => {
    const r = await dialog.showOpenDialog(win, { title: '选择图片', properties: ['openFile', 'multiSelections'], filters: IMAGE_FILTER });
    return r.canceled ? [] : remember(await expandPaths(r.filePaths));
  });

  ipcMain.handle('pick-folder', async (_e, opts) => {
    const r = await dialog.showOpenDialog(win, { title: '选择包含图片的文件夹', properties: ['openDirectory', 'multiSelections'] });
    return r.canceled ? [] : remember(await expandPaths(r.filePaths, opts));
  });

  ipcMain.handle('expand-paths', async (_e, paths, opts) => remember(await expandPaths(Array.isArray(paths) ? paths : [], opts)));

  ipcMain.handle('pick-output-dir', async (_e, current) => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择导出文件夹',
      defaultPath: current || app.getPath('pictures'),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    knownDirs.add(pathKey(r.filePaths[0]));
    return r.filePaths[0];
  });

  ipcMain.handle('thumbnail', (_e, p) => {
    assertKnown(p);
    return makeThumbnail(p);
  });

  ipcMain.handle('start-job', async (e, { files, settings }) => {
    if (job) throw new Error('已经有任务在跑了');
    files.forEach(f => assertKnown(f.path));
    job = { cancelled: false };
    const sender = e.sender;
    try {
      return await runJob({
        files,
        settings,
        concurrency: Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))),
        isCancelled: () => job.cancelled,
        trash: p => shell.trashItem(p),
        onProgress: ev => {
          if (ev.outPath) remember([{ path: ev.outPath }]);
          if (!sender.isDestroyed()) sender.send('job-progress', ev);
        },
      });
    } finally {
      job = null;
    }
  });

  ipcMain.handle('cancel-job', () => {
    if (job) job.cancelled = true;
  });

  ipcMain.handle('open-path', (_e, p) => {
    if (typeof p !== 'string' || !knownDirs.has(pathKey(p))) return '未授权的路径';
    return shell.openPath(p);
  });

  ipcMain.handle('reveal', (_e, p) => {
    assertKnown(p);
    shell.showItemInFolder(p);
  });

  ipcMain.handle('load-state', () => {
    try {
      return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    } catch {
      return null;
    }
  });

  ipcMain.handle('save-state', async (_e, data) => {
    const file = statePath();
    const tmp = `${file}.tmp`;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.promises.rename(tmp, file);
  });

  ipcMain.handle('set-theme', (_e, mode) => {
    nativeTheme.themeSource = ['light', 'dark'].includes(mode) ? mode : 'system';
  });

  ipcMain.handle('app-info', () => ({ platform: process.platform, version: app.getVersion() }));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    sendExternal(argv);
  });

  app.whenReady().then(() => {
    // Windows / Linux 用自绘标题栏，不需要菜单栏；macOS 保留默认菜单，否则输入框里复制粘贴会失灵
    if (!isMac) Menu.setApplicationMenu(null);
    registerProtocol();
    registerIpc();
    createWindow();
    win.webContents.once('did-finish-load', () => sendExternal(process.argv));

    nativeTheme.on('updated', () => {
      if (!win) return;
      win.setBackgroundColor(titlebarColors().color);
      if (!isMac) win.setTitleBarOverlay(titlebarColors());
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}
