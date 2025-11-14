// See: https://rollupjs.org/introduction/

import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import nodeResolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

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
};

export default config;
