import { copyFile, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { build, context, type BuildOptions } from 'esbuild';

const config: BuildOptions = {
  entryPoints: { app: 'src/client/app.ts', api: 'src/client/api.ts' },
  bundle: true,
  outdir: 'dist/public',
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  sourcemap: true,
};
const staticFiles = ['index.html', 'api.html', 'style.css', 'favicon.svg'];
async function copyStatic(): Promise<void> {
  await mkdir('dist/public', { recursive: true });
  await Promise.all(staticFiles.map((file) => copyFile('public/' + file, 'dist/public/' + file)));
}
await copyStatic();
if (process.argv.includes('--watch')) {
  const ctx = await context(config);
  await ctx.watch();
  watch('public', () => {
    void copyStatic().catch((error) => console.error(error));
  });
  console.log('Watching browser TypeScript and static assets');
} else await build(config);
