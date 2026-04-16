import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: '{**/node_modules/syntaur/**,**/*.node}',
    },
    icon: './assets/icon',
    name: 'Syntaur',
    executableName: 'syntaur',
    ...(process.env.MAC_CODESIGN_IDENTITY
      ? {
          osxSign: {
            identity: process.env.MAC_CODESIGN_IDENTITY,
          },
        }
      : {}),
    ...(process.env.APPLE_API_KEY
      ? {
          osxNotarize: {
            appleApiKey: process.env.APPLE_API_KEY,
            appleApiKeyId: process.env.APPLE_API_KEY_ID!,
            appleApiIssuer: process.env.APPLE_API_ISSUER!,
          },
        }
      : {}),
  },
  makers: [
    new MakerDMG(
      {
        format: 'ULFO',
      },
      ['darwin'],
    ),
    new MakerZIP({}, ['darwin', 'win32']),
    new MakerSquirrel(
      {
        name: 'Syntaur',
        ...(process.env.WINDOWS_CERTIFICATE_FILE
          ? {
              certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
              certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
            }
          : {}),
      },
      ['win32'],
    ),
  ],
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      // @electron-forge/plugin-vite excludes node_modules (it expects Vite to
      // bundle everything). syntaur is marked external because its server
      // resolves static assets relative to its package directory at runtime, so
      // we copy the full package and all its transitive dependencies manually.
      const nmSrc = resolve(__dirname, 'node_modules');
      const nmDest = join(buildPath, 'node_modules');

      // Get every production dependency path from npm
      const lsOutput = execSync('npm ls --all --prod --parseable', {
        cwd: __dirname,
        encoding: 'utf-8',
      });
      for (const line of lsOutput.trim().split('\n')) {
        if (!line.includes('node_modules')) continue;
        // Extract the path relative to the top-level node_modules, preserving
        // nested node_modules (e.g. "syntaur/node_modules/commander")
        const rel = line.slice(nmSrc.length + 1);
        if (!rel) continue;
        cpSync(join(nmSrc, rel), join(nmDest, rel), { recursive: true });
      }
    },
  },
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
