import { BuildConfig, nodeTarget, panic, run, watcher } from './util';
import { build, Plugin, transform } from 'esbuild';
import { join } from 'path';
import { readPackageJson, writePackageJson } from './package-json';
import { checkExistingNpmVersion, releaseVersionPrompt } from './release';
import semver from 'semver';
import mri from 'mri';
import { execa } from 'execa';
import { fileURLToPath } from 'url';
import { readFile, copyFile } from 'fs/promises';
import { rollup } from 'rollup';

const PACKAGE = 'qwik-city';
const __dirname = fileURLToPath(new URL('.', import.meta.url));

export async function buildQwikCity(config: BuildConfig) {
  const inputDir = join(config.packagesDir, PACKAGE);
  const outputDir = join(inputDir, 'lib');

  await Promise.all([
    buildServiceWorker(config, inputDir, outputDir),
    buildVite(config, inputDir, outputDir),
    buildAdaptorCloudflarePagesVite(config, inputDir, outputDir),
    buildMiddlewareCloudflarePages(config, inputDir, outputDir),
    buildMiddlewareNetlifyEdge(config, inputDir, outputDir),
    buildMiddlewareNode(config, inputDir, outputDir),
    buildStatic(config, inputDir, outputDir),
    buildStaticNode(config, inputDir, outputDir),
    buildStaticDeno(config, inputDir, outputDir),
  ]);

  await buildRuntime(inputDir);

  const loaderPkg = {
    ...(await readPackageJson(inputDir)),
    main: './index.qwik.cjs',
    qwik: './index.qwik.mjs',
    types: './index.d.ts',
    type: 'module',
    exports: {
      '.': {
        import: './index.qwik.mjs',
        require: './index.qwik.cjs',
      },
      './adaptors/cloudflare-pages/vite': {
        import: './adaptors/cloudflare-pages/vite/index.mjs',
        require: './adaptors/cloudflare-pages/vite/index.cjs',
      },
      './middleware/cloudflare-pages': {
        import: './middleware/cloudflare-pages/index.mjs',
      },
      './middleware/node': {
        import: './middleware/node/index.mjs',
        require: './middleware/node/index.cjs',
      },
      './middleware/netlify-edge': {
        import: './middleware/netlify-edge/index.mjs',
      },
      './static': {
        import: './static/index.mjs',
        require: './static/index.cjs',
      },
      './static/node': {
        import: './static/node.mjs',
      },
      './vite': {
        import: './vite/index.mjs',
        require: './vite/index.cjs',
      },
      './service-worker': {
        import: './service-worker.mjs',
        require: './service-worker.cjs',
      },
    },
    files: [
      'index.d.ts',
      'index.qwik.mjs',
      'index.qwik.cjs',
      'service-worker.mjs',
      'service-worker.cjs',
      'service-worker.d.ts',
      'modules.d.ts',
      'middleware',
      'static',
      'vite',
    ],
    publishConfig: {
      access: 'public',
    },
    private: undefined,
    devDependencies: undefined,
    scripts: undefined,
  };
  await writePackageJson(outputDir, loaderPkg);

  const srcReadmePath = join(inputDir, 'README.md');
  const distReadmePath = join(outputDir, 'README.md');
  await copyFile(srcReadmePath, distReadmePath);

  console.log(`🏙  ${PACKAGE}`);
}

async function buildRuntime(input: string) {
  const result = await execa('yarn', ['build.runtime'], {
    stdout: 'inherit',
    cwd: input,
  });
  if (result.failed) {
    panic(`tsc failed`);
  }
}

async function buildVite(config: BuildConfig, inputDir: string, outputDir: string) {
  const entryPoints = [join(inputDir, 'buildtime', 'vite', 'index.ts')];

  const external = [
    'fs',
    'path',
    'url',
    'vite',
    'source-map',
    'vfile',
    '@mdx-js/mdx',
    'typescript',
  ];

  const swRegisterPath = join(inputDir, 'runtime', 'src', 'library', 'sw-register.ts');
  let swRegisterCode = await readFile(swRegisterPath, 'utf-8');

  const swResult = await transform(swRegisterCode, { loader: 'ts', minify: true });
  swRegisterCode = swResult.code.trim();
  if (swRegisterCode.endsWith(';')) {
    swRegisterCode = swRegisterCode.slice(0, swRegisterCode.length - 1);
  }

  await build({
    entryPoints,
    outfile: join(outputDir, 'vite', 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: nodeTarget,
    format: 'esm',
    external,
    watch: watcher(config),
    plugins: [serviceWorkerRegisterBuild(swRegisterCode)],
  });

  await build({
    entryPoints,
    outfile: join(outputDir, 'vite', 'index.cjs'),
    bundle: true,
    platform: 'node',
    target: nodeTarget,
    format: 'cjs',
    external,
    watch: watcher(config),
    plugins: [serviceWorkerRegisterBuild(swRegisterCode)],
  });
}

function serviceWorkerRegisterBuild(swRegisterCode: string) {
  const filter = /\@qwik-city-sw-register-build/;

  const plugin: Plugin = {
    name: 'serviceWorkerRegisterBuild',
    setup(build) {
      build.onResolve({ filter }, (args) => ({
        path: args.path,
        namespace: 'sw-reg',
      }));
      build.onLoad({ filter: /.*/, namespace: 'sw-reg' }, () => ({
        contents: swRegisterCode,
        loader: 'text',
      }));
    },
  };
  return plugin;
}

async function buildServiceWorker(config: BuildConfig, inputDir: string, outputDir: string) {
  const build = await rollup({
    input: join(
      config.tscDir,
      'packages',
      'qwik-city',
      'runtime',
      'src',
      'library',
      'service-worker',
      'index.js'
    ),
  });

  await build.write({
    file: join(outputDir, 'service-worker.mjs'),
    format: 'es',
  });

  await build.write({
    file: join(outputDir, 'service-worker.cjs'),
    format: 'cjs',
  });
}

async function buildAdaptorCloudflarePagesVite(
  config: BuildConfig,
  inputDir: string,
  outputDir: string
) {
  const entryPoints = [join(inputDir, 'adaptors', 'cloudflare-pages', 'vite', 'index.ts')];

  const external = ['vite', 'fs', 'path', '@builder.io/qwik-city/static'];

  await build({
    entryPoints,
    outfile: join(outputDir, 'adaptors', 'cloudflare-pages', 'vite', 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: nodeTarget,
    format: 'esm',
    watch: watcher(config),
    external,
  });

  await build({
    entryPoints,
    outfile: join(outputDir, 'adaptors', 'cloudflare-pages', 'vite', 'index.cjs'),
    bundle: true,
    platform: 'node',
    target: nodeTarget,
    format: 'cjs',
    watch: watcher(config),
    external,
  });
}

async function buildMiddlewareCloudflarePages(
  config: BuildConfig,
  inputDir: string,
  outputDir: string
) {
  const entryPoints = [join(inputDir, 'middleware', 'cloudflare-pages', 'index.ts')];

  const external = ['@qwik-city-plan'];

  await build({
    entryPoints,
    outfile: join(outputDir, 'middleware', 'cloudflare-pages', 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: nodeTarget,
    format: 'esm',
    watch: watcher(config),
    external,
  });
}

async function buildMiddlewareNode(config: BuildConfig, inputDir: string, outputDir: string) {
  const entryPoints = [join(inputDir, 'middleware', 'node', 'index.ts')];

  const external = ['node-fetch', 'path', '@qwik-city-plan'];

  await build({
    entryPoints,
    outfile: join(outputDir, 'middleware', 'node', 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: nodeTarget,
    format: 'esm',
    external,
    watch: watcher(config),
  });

  await build({
    entryPoints,
    outfile: join(outputDir, 'middleware', 'node', 'index.cjs'),
    bundle: true,
    platform: 'node',
    target: nodeTarget,
    format: 'cjs',
    external,
    watch: watcher(config),
  });
}

async function buildMiddlewareNetlifyEdge(
  config: BuildConfig,
  inputDir: string,
  outputDir: string
) {
  const entryPoints = [join(inputDir, 'middleware', 'netlify-edge', 'index.ts')];

  const external = ['@qwik-city-plan'];

  await build({
    entryPoints,
    outfile: join(outputDir, 'middleware', 'netlify-edge', 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: nodeTarget,
    format: 'esm',
    watch: watcher(config),
    external,
  });
}

async function buildStatic(config: BuildConfig, inputDir: string, outputDir: string) {
  const entryPoints = [join(inputDir, 'static', 'index.ts')];

  await build({
    entryPoints,
    outfile: join(outputDir, 'static', 'index.mjs'),
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    watch: watcher(config),
  });

  await build({
    entryPoints,
    outfile: join(outputDir, 'static', 'index.cjs'),
    bundle: true,
    platform: 'node',
    target: nodeTarget,
    format: 'cjs',
    watch: watcher(config),
  });
}

async function buildStaticDeno(config: BuildConfig, inputDir: string, outputDir: string) {
  const entryPoints = [join(inputDir, 'static', 'deno', 'index.ts')];

  await build({
    entryPoints,
    outfile: join(outputDir, 'static', 'deno.mjs'),
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    watch: watcher(config),
  });
}

async function buildStaticNode(config: BuildConfig, inputDir: string, outputDir: string) {
  const entryPoints = [join(inputDir, 'static', 'node', 'index.ts')];

  const external = ['fs', 'node-fetch', 'os', 'path', 'url', 'worker_threads'];

  await build({
    entryPoints,
    outfile: join(outputDir, 'static', 'node.mjs'),
    bundle: true,
    platform: 'node',
    target: nodeTarget,
    format: 'esm',
    external,
    watch: watcher(config),
  });

  await build({
    entryPoints,
    outfile: join(outputDir, 'static', 'node.cjs'),
    bundle: true,
    platform: 'node',
    target: nodeTarget,
    format: 'cjs',
    external,
    watch: watcher(config),
  });
}

export async function prepareReleaseQwikCity() {
  const pkgRootDir = join(__dirname, '..');
  const pkg = await readPackageJson(pkgRootDir);

  console.log(`⛴ preparing ${pkg.name} ${pkg.version} release`);

  const answers = await releaseVersionPrompt(pkg.name, pkg.version);
  if (!semver.valid(answers.version)) {
    panic(`Invalid version`);
  }

  pkg.version = answers.version;

  await checkExistingNpmVersion(pkg.name, pkg.version);

  await writePackageJson(pkgRootDir, pkg);

  // git add the changed package.json
  const gitAddArgs = ['add', join(pkgRootDir, 'package.json')];
  await run('git', gitAddArgs);

  // git commit the changed package.json
  const commitMessage = `qwik-city ${pkg.version}`;
  const gitCommitArgs = ['commit', '--message', commitMessage];
  await run('git', gitCommitArgs);

  console.log(``);
  console.log(`Next:`);
  console.log(` - Submit a PR to main with the package.json update`);
  console.log(` - Once merged, run the "Release Qwik City" workflow`);
  console.log(` - https://github.com/BuilderIO/qwik/actions/workflows/release-qwik-city.yml`);
  console.log(``);
}

export async function releaseQwikCity() {
  const args = mri(process.argv.slice(2));

  const distTag = args['set-dist-tag'];

  const pkgRootDir = join(__dirname, '..');
  const pkg = await readPackageJson(pkgRootDir);

  console.log(`🚢 publishing ${pkg.name} ${pkg.version}`);

  const npmPublishArgs = ['publish', '--tag', distTag, '--access', 'public'];
  await run('npm', npmPublishArgs, false, false, { cwd: pkgRootDir });
}
