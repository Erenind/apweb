// Used by `web-ext lint` / `web-ext build`: the test harness and the docs are
// part of the repo but not part of the add-on, so keep them out of the package
// and out of the linter's way.
export default {
  ignoreFiles: [
    'test/**',
    'README.md',
    'web-ext-config.mjs',
    'vendor/LICENSES.md',
    'vendor/*.map',
  ],
}
