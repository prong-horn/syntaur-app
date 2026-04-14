import { app, BrowserWindow, dialog } from 'electron';
import { resolve, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { createDashboardServer } from 'syntaur/dist/dashboard/server.js';
import { buildMenu } from './menu.js';

// ── Path utilities (reimplemented locally to avoid importing syntaur CLI entry) ──

function syntaurRoot(): string {
  return resolve(homedir(), '.syntaur');
}

function defaultMissionDir(): string {
  return resolve(syntaurRoot(), 'missions');
}

function serversDir(): string {
  return resolve(syntaurRoot(), 'servers');
}

function assignmentsDir(): string {
  return resolve(syntaurRoot(), 'assignments');
}

function playbooksDir(): string {
  return resolve(syntaurRoot(), 'playbooks');
}

function todosDir(): string {
  return resolve(syntaurRoot(), 'todos');
}

// ── Config reading ──
// Replicates parseFrontmatter() from src/utils/config.ts:71-96 and
// readConfig() from src/utils/config.ts:442-463.

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  const lines = match[1].split('\n');
  let currentParent: string | null = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const colonIndex = line.indexOf(':');
    if (colonIndex < 0) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (indent === 0) {
      if (value === '' || value === undefined) {
        currentParent = key;
      } else {
        currentParent = null;
        result[key] = value.replace(/^["']|["']$/g, '');
      }
    } else if (indent > 0 && currentParent) {
      result[`${currentParent}.${key}`] = value.replace(/^["']|["']$/g, '');
    }
  }
  return result;
}

async function readMissionsDir(): Promise<string> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  try {
    const content = await readFile(configPath, 'utf-8');
    const fm = parseFrontmatter(content);

    if (Object.keys(fm).length === 0) {
      console.warn(
        'Warning: ~/.syntaur/config.md has malformed frontmatter, using defaults',
      );
      return defaultMissionDir();
    }

    if (fm['defaultMissionDir']) {
      let dir = fm['defaultMissionDir'];
      if (dir.startsWith('~/')) {
        dir = resolve(homedir(), dir.slice(2));
      }
      if (!isAbsolute(dir)) {
        console.warn(
          `Config defaultMissionDir is not absolute ("${dir}"), using default`,
        );
        return defaultMissionDir();
      }
      return dir;
    }
  } catch {
    // Config file doesn't exist, use default
  }
  return defaultMissionDir();
}

// ── Port discovery ──

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    const tester = createNetServer();
    tester.once('error', () => resolveAvailability(false));
    tester.once('listening', () => {
      tester.close(() => resolveAvailability(true));
    });
    tester.listen(port);
  });
}

async function findAvailablePort(
  startPort: number,
  maxAttempts: number = 20,
): Promise<number | null> {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = startPort + offset;
    if (candidate > 65535) break;
    if (await isPortAvailable(candidate)) return candidate;
  }
  return null;
}

// ── Application state ──

let mainWindow: BrowserWindow | null = null;
let dashboardServer: ReturnType<typeof createDashboardServer> | null = null;
let serverPort: number = 4800;

// ── Single instance lock ──

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await launchApp();
    } catch (err) {
      dialog.showErrorBox(
        'Syntaur failed to start',
        `The dashboard server could not be started.\n\n${err instanceof Error ? err.message : String(err)}\n\nMake sure ~/.syntaur/ is initialized (run 'npx syntaur init' in a terminal).`,
      );
      app.quit();
      return;
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', async () => {
    if (dashboardServer) {
      await dashboardServer.stop();
      dashboardServer = null;
    }
  });
}

// ── Launch sequence ──

async function launchApp(): Promise<void> {
  // 0. Full first-run bootstrap (replicates syntaur init behavior)
  const configPath = resolve(syntaurRoot(), 'config.md');
  const isFirstRun = !existsSync(configPath);

  const requiredDirs = [
    syntaurRoot(),
    defaultMissionDir(),
    assignmentsDir(),
    serversDir(),
    playbooksDir(),
    todosDir(),
  ];
  for (const dir of requiredDirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  if (isFirstRun) {
    // Write default config.md (exact output from src/templates/config.ts:5-24)
    const { writeFile: writeFileAsync } = await import('node:fs/promises');
    const defaultConfig = `---
version: "1.0"
defaultMissionDir: ${defaultMissionDir()}
onboarding:
  completed: false
agentDefaults:
  trustLevel: medium
  autoApprove: false
sync:
  enabled: false
  endpoint: null
  interval: 300
---

# Syntaur Configuration

Global configuration for the Syntaur CLI.
`;
    await writeFileAsync(configPath, defaultConfig, 'utf-8');

    // Seed default playbooks from syntaur package examples (best-effort)
    try {
      const { createRequire } = await import('node:module');
      const req = createRequire(import.meta.url);
      const syntaurPkgRoot = resolve(dirname(req.resolve('syntaur/package.json')));
      const examplesDir = resolve(syntaurPkgRoot, 'examples', 'playbooks');
      if (existsSync(examplesDir)) {
        const {
          readdir,
          readFile: readFileAsync,
          writeFile: writeFileAsync2,
        } = await import('node:fs/promises');
        const entries = await readdir(examplesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const targetPath = resolve(playbooksDir(), entry.name);
          if (!existsSync(targetPath)) {
            const content = await readFileAsync(
              resolve(examplesDir, entry.name),
              'utf-8',
            );
            await writeFileAsync2(targetPath, content, 'utf-8');
          }
        }
      }

      // Rebuild playbook manifest (matches init.ts:58)
      try {
        const playbooksMod = await import(
          resolve(syntaurPkgRoot, 'dist', 'utils', 'playbooks.js')
        );
        if (playbooksMod.rebuildPlaybookManifest) {
          await playbooksMod.rebuildPlaybookManifest(playbooksDir());
        }
      } catch {
        // Manifest rebuild is best-effort
      }
    } catch {
      // Playbook seeding is best-effort; dashboard works without them
    }
  }

  // 1. Find available port
  const port = await findAvailablePort(4800);
  if (port === null) {
    throw new Error('Could not find an available port starting at 4800.');
  }
  serverPort = port;

  // 2. Read missions directory from config and ensure it exists
  const missionsDir = await readMissionsDir();
  if (!existsSync(missionsDir)) {
    mkdirSync(missionsDir, { recursive: true });
  }

  // 3. Create and start the dashboard server
  dashboardServer = createDashboardServer({
    port: serverPort,
    missionsDir,
    serversDir: serversDir(),
    playbooksDir: playbooksDir(),
    todosDir: todosDir(),
    serveStaticUi: true,
  });

  await dashboardServer.start();
  console.log(`Syntaur Dashboard server running on port ${serverPort}`);

  // 4. Set up native menu
  buildMenu(serverPort);

  // 5. Create the main window
  createWindow();

  // 6. Set up auto-updates (imported dynamically to avoid issues in dev)
  try {
    const { updateElectronApp } = await import('update-electron-app');
    updateElectronApp();
  } catch {
    // update-electron-app may not work in development
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Syntaur',
    webPreferences: {
      // Electron Forge Vite plugin builds main and preload to the same output directory.
      // __dirname is available because the plugin builds main process as CJS.
      preload: resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}
