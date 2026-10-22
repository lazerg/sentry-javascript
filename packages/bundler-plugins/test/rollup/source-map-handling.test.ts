import * as path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSentryBuildPluginManager } from '../../src/core/build-plugin-manager';
import { createSourceMapHandling } from '../../src/rollup/source-map-handling';
import type { OutputBundle } from '../../src/rollup/debug-id-stamping';

vi.mock('sentry', () => ({
  createSentrySDK: () => ({
    release: { create: vi.fn(), finalize: vi.fn(), 'set-commits': vi.fn(), deploy: vi.fn() },
    sourcemap: { upload: vi.fn(), inject: vi.fn() },
    run: vi.fn(),
  }),
}));

const DEBUG_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_DEBUG_ID = '11111111-2222-3333-4444-555555555555';
const MAP = JSON.stringify({ version: 3, sources: ['index.ts'], mappings: 'AAAA' });

function chunk(debugId: string): string {
  return `console.log(1);\n;!function(){try{var e={},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="${debugId}",e._sentryDebugIdIdentifier="sentry-dbid-${debugId}")}catch(e){}}();`;
}

function bundleWith(debugId: string): OutputBundle {
  return {
    'index.js': { type: 'chunk', fileName: 'index.js', code: chunk(debugId) },
    'index.js.map': { type: 'asset', fileName: 'index.js.map', source: MAP },
  };
}

describe('createSourceMapHandling', () => {
  const outputOptions = { dir: 'out' };
  let handling: ReturnType<typeof createSourceMapHandling>;

  beforeEach(() => {
    const manager = createSentryBuildPluginManager(
      {
        authToken: 't',
        org: 'o',
        project: 'p',
        release: { name: 'r', create: false, finalize: false },
        telemetry: false,
        silent: true,
      },
      { buildTool: 'rollup', loggerPrefix: '[test]' },
    );
    handling = createSourceMapHandling(manager);
    handling.setDecision(path.resolve('out'), { enableHidden: true, deleteAfterUpload: true });
  });

  it('hands the oldest staging to a writeBundle call without a bundle', async () => {
    const bundle = bundleWith(DEBUG_ID);
    await handling.stageSourceMaps(outputOptions, bundle, true);
    expect(Object.keys(bundle)).toEqual(['index.js']);

    const staging = await handling.takeStaging(outputOptions, undefined);

    expect(staging?.count).toBe(1);
    await staging?.discard();
    expect(await handling.takeStaging(outputOptions, undefined)).toBeUndefined();
  });

  it('discards a staging whose chunks differ from the written bundle', async () => {
    const stale = bundleWith(OTHER_DEBUG_ID);
    await handling.stageSourceMaps(outputOptions, stale, true);
    const current = bundleWith(DEBUG_ID);
    await handling.stageSourceMaps(outputOptions, current, true);

    const staging = await handling.takeStaging(outputOptions, current);

    expect(staging?.count).toBe(1);
    await staging?.discard();
    expect(await handling.takeStaging(outputOptions, current)).toBeUndefined();
  });
});
