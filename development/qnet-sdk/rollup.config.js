import typescript  from '@rollup/plugin-typescript';
import resolve     from '@rollup/plugin-node-resolve';
import dts         from 'rollup-plugin-dts';

const external = ['axios', 'bs58'];

export default [
  // ── ESM build ──────────────────────────────────────────────────────────────
  {
    input:    'src/index.ts',
    external,
    output: {
      file:      'dist/index.esm.js',
      format:    'esm',
      sourcemap: true,
    },
    plugins: [resolve(), typescript({ tsconfig: './tsconfig.json' })],
  },

  // ── CommonJS build ─────────────────────────────────────────────────────────
  {
    input:    'src/index.ts',
    external,
    output: {
      file:      'dist/index.js',
      format:    'cjs',
      sourcemap: true,
      exports:   'named',
    },
    plugins: [resolve(), typescript({ tsconfig: './tsconfig.json' })],
  },

  // ── Type declarations ──────────────────────────────────────────────────────
  {
    input:  'src/index.ts',
    output: { file: 'dist/index.d.ts', format: 'esm' },
    plugins: [dts()],
  },
];
