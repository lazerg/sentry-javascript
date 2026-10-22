import * as path from 'node:path';
import type { SentryBuildPluginManager, SourceMapDecision } from '../core';
import type { RollupSourceMapSetting, SourceMapHandling } from '../rollup/source-map-handling';
import { sourceMapKindFromRollupSetting } from '../rollup/source-map-handling';

type BundlerOutput = { dir?: string; sourcemap?: RollupSourceMapSetting };
type BundlerOutputOptions = BundlerOutput | BundlerOutput[] | undefined;

type ViteBuildOptions = {
  sourcemap?: RollupSourceMapSetting;
  outDir?: string;
  rollupOptions?: { output?: BundlerOutputOptions };
  rolldownOptions?: { output?: BundlerOutputOptions };
};

export type ViteUserConfig = {
  build?: ViteBuildOptions;
  environments?: Record<string, { build?: ViteBuildOptions } | undefined>;
};

export type ViteResolvedConfig = {
  root: string;
  build: ViteBuildOptions;
  environments?: Record<string, { build: ViteBuildOptions }>;
};

export type ViteSourceMapHooks = {
  config: (userConfig: ViteUserConfig, env: { command: string }) => ViteUserConfig | null;
  configResolved: (config: ViteResolvedConfig) => void;
};

const NO_CHANGE: SourceMapDecision = { enableHidden: false, deleteAfterUpload: false };

type EnvironmentOutput = { destination: string; sourcemap: RollupSourceMapSetting };

/**
 * The outputs an environment writes: `build.outDir` (relative to the root) unless an output in
 * `rollupOptions` or `rolldownOptions` sets its own `dir`, which the bundler resolves from the
 * working directory. An output's own `sourcemap` overrides `build.sourcemap`.
 */
function getOutputs(root: string, build: ViteBuildOptions): EnvironmentOutput[] {
  const configured = build.rolldownOptions?.output ?? build.rollupOptions?.output;
  const outputs = (Array.isArray(configured) ? configured : [configured]).filter(
    (output): output is BundlerOutput => output !== undefined,
  );
  const outputsWithDir = outputs.filter(
    (output): output is BundlerOutput & { dir: string } => typeof output.dir === 'string',
  );

  if (outputsWithDir.length > 0) {
    return outputsWithDir.map(output => ({
      destination: path.resolve(output.dir),
      sourcemap: output.sourcemap ?? build.sourcemap,
    }));
  }

  return [
    {
      destination: path.resolve(root, build.outDir ?? 'dist'),
      sourcemap: outputs.find(output => output.sourcemap !== undefined)?.sourcemap ?? build.sourcemap,
    },
  ];
}

/**
 * Vite warns about `rollupOptions.output.sourcemap`, so the Vite plugin decides on `build.sourcemap`
 * in its `config` hook. The output directories are only known in `configResolved`, which then
 * records the decision for each of them.
 */
export function createViteSourceMapHooks(
  sentryBuildPluginManager: SentryBuildPluginManager,
  sourceMapHandling: SourceMapHandling,
): ViteSourceMapHooks {
  // `'*'` for the top-level setting, otherwise the name of an environment with its own.
  const decisions = new Map<string, SourceMapDecision>();

  return {
    config: (userConfig, env) => {
      if (env.command !== 'build') {
        return null;
      }

      const decision = sentryBuildPluginManager.sourceMaps.decide(
        sourceMapKindFromRollupSetting(userConfig.build?.sourcemap),
      );
      decisions.set('*', decision);

      const result: ViteUserConfig = decision.enableHidden ? { build: { sourcemap: 'hidden' } } : {};

      for (const [name, environment] of Object.entries(userConfig.environments ?? {})) {
        const setting = environment?.build?.sourcemap;
        if (setting === undefined) {
          continue;
        }

        const environmentDecision = sentryBuildPluginManager.sourceMaps.decide(sourceMapKindFromRollupSetting(setting));
        decisions.set(name, environmentDecision);

        if (environmentDecision.enableHidden) {
          result.environments = { ...result.environments, [name]: { build: { sourcemap: 'hidden' } } };
        }
      }

      return result;
    },

    configResolved: config => {
      const environments = config.environments ?? { client: { build: config.build } };

      for (const [name, environment] of Object.entries(environments)) {
        const decision = decisions.get(name) ?? decisions.get('*') ?? NO_CHANGE;

        for (const output of getOutputs(config.root, environment.build)) {
          // A plugin that ran after ours may have changed the setting again,
          // or the output sets its own.
          if (decision.deleteAfterUpload && output.sourcemap !== 'hidden') {
            sentryBuildPluginManager.logger.debug(
              `Source maps of the "${name}" environment are set to ${JSON.stringify(output.sourcemap)}. Not removing them after upload.`,
            );
            sourceMapHandling.setDecision(output.destination, NO_CHANGE);
          } else {
            sourceMapHandling.setDecision(output.destination, decision);
          }
        }
      }
    },
  };
}
