import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('syntaurDesktop', {
  version: () => process.env.npm_package_version ?? 'dev',
  platform: () => process.platform,
  arch: () => process.arch,
  electronVersion: () => process.versions.electron,
});
