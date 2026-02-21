import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const config = {
  entryPoints: [
    'src/content/audio-analyzer.ts',
    'src/content/content.ts',
    'src/content/player-ui.ts',
    'src/background/service-worker.ts',
  ],
  bundle: true,
  outdir: 'dist',
  outbase: 'src',
  format: 'iife',
  target: 'es2020',
  minify: false,
  sourcemap: false,
};

if (isWatch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(config);
  console.log('Build complete.');
}
