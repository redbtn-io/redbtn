import { afterEach, describe, expect, it } from 'vitest';
import { CopilotClient } from '@github/copilot-sdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const temporaryHomes: string[] = [];
afterEach(() => {
  for (const home of temporaryHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function packageRoot(entryPoint: string, expectedName: string): string {
  let current = path.dirname(entryPoint);
  while (current !== path.dirname(current)) {
    const packageJsonPath = path.join(current, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const metadata = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { name?: string };
      if (metadata.name === expectedName) return current;
    }
    current = path.dirname(current);
  }
  throw new Error(`Could not locate installed package root for ${expectedName}`);
}

describe('pinned Copilot SDK runtime packaging', () => {
  it('ships the pinned platform runtime files matching the SDK package', () => {
    const sdkRoot = packageRoot(require.resolve('@github/copilot-sdk'), '@github/copilot-sdk');
    const sdkPackage = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')) as {
      version: string;
      copilotCliVersion: string;
      optionalDependencies?: Record<string, string>;
    };
    const enginePackage = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const linuxMusl = process.platform === 'linux' && !process.report?.getReport().header.glibcVersionRuntime;
    const runtimeVariant = process.platform === 'linux'
      ? `linux${linuxMusl ? 'musl' : ''}-${process.arch}`
      : `${process.platform}-${process.arch}`;
    const supportedVariants = new Set([
      'linux-x64', 'linux-arm64', 'linuxmusl-x64', 'linuxmusl-arm64',
      'win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64',
    ]);
    expect(supportedVariants.has(runtimeVariant), `Copilot SDK runtime platform ${runtimeVariant} is unsupported`).toBe(true);
    const runtimePackageName = `@github/copilot-sdk-${runtimeVariant}`;
    const runtimePackagePath = require.resolve(`${runtimePackageName}/package.json`);
    const runtimePackage = JSON.parse(fs.readFileSync(runtimePackagePath, 'utf8')) as { version: string };
    const runtimeRoot = path.dirname(runtimePackagePath);

    expect(enginePackage.dependencies?.['@github/copilot-sdk']).toBe('1.0.14');
    expect(sdkPackage.version).toBe('1.0.14');
    expect(sdkPackage.copilotCliVersion).toBe('1.0.85');
    expect(sdkPackage.optionalDependencies?.[runtimePackageName]).toBe('1.0.14');
    expect(runtimePackage.version).toBe('1.0.14');
    const runtimeDir = path.join(runtimeRoot, 'prebuilds', runtimeVariant);
    const runtimeFiles = fs.readdirSync(runtimeDir);
    expect(runtimeFiles.some((name) => name.startsWith('copilot-runtime')), `${runtimeVariant} runtime executable must be installed`).toBe(true);
    expect(fs.statSync(path.join(runtimeDir, 'runtime.node')).isFile()).toBe(true);
    if (process.platform !== 'win32') {
      const executable = runtimeFiles.find((name) => name.startsWith('copilot-runtime'))!;
      expect(fs.statSync(path.join(runtimeDir, executable)).mode & 0o111).not.toBe(0);
    }
  });

  it.skipIf(process.env.COPILOT_SDK_RUNTIME_SMOKE !== '1')(
    'starts and stops the bundled runtime without authentication or a model prompt',
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-sdk-runtime-smoke-'));
      temporaryHomes.push(home);
      const runtimeEnv = {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: home,
        TMPDIR: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
        LANG: 'C.UTF-8',
        TZ: 'UTC',
        TERM: 'dumb',
        NO_COLOR: '1',
      };
      const client = new CopilotClient({
        mode: 'empty',
        baseDirectory: home,
        workingDirectory: home,
        env: runtimeEnv,
        useLoggedInUser: false,
        enableRemoteSessions: false,
        logLevel: 'none',
      });
      try {
        await client.start();
        expect(await client.stop()).toEqual([]);
      } catch (error) {
        await client.forceStop().catch(() => undefined);
        throw error;
      }
    },
    20_000,
  );
});
