import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';

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
