// @ts-check
//
// We ran into some issues trying to make this file actually be TypeScript
// (https://github.com/rollup/plugins/issues/1662) so we're leaving it as JS and just
// using `@ts-check` to make VSCode more helpful. See:

import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

/** @type {import('rollup').RollupOptions} */
const config = {
  input: 'src/index.ts',
  output: {
    esModule: true,
    dir: 'dist',
    format: 'cjs',
    sourcemap: true,
    chunkFileNames: '[name]-[hash].cjs',
    entryFileNames: '[name].cjs',
  },
  plugins: [
    typescript(),
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
    json(),
  ],
  // Filter out warnings in our dependencies that we can't control and which
  // don't seem to break things. Note that we run rollup with
  // --failAfterWarnings to avoid warning creep.
  onwarn(warning, warn) {
    // We don't care about
    if (
      warning.code === 'CIRCULAR_DEPENDENCY' &&
      warning.ids?.every((path) => path.includes('/node_modules/'))
    ) {
      return;
    }
    if (
      warning.code === 'EVAL' &&
      warning.id?.includes('node_modules/@protobufjs/inquire/index.js')
    ) {
      return;
    }
    warn(warning);
  },
};

export default config;
