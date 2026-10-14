// Used by `web-ext lint` / `web-ext build`: the test harness, the demo pages and
// the docs live in the repo but are not part of the add-on, so keep them out of
// both the package and the linter's way.
export default {
  ignoreFiles: [
    'test/**',
    'demo/**',
    'docs/**',
    'README.md',
    'web-ext-config.mjs',
    'vendor/LICENSES.md',
    'vendor/*.map',
  ],
}
