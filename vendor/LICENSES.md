# Vendored libraries

These two browser builds are copied from the Reader project's `node_modules` so
the extension works without a build step. They are third-party code, unchanged.

| 文件 | 包 | 版本 | 许可证 |
| --- | --- | --- | --- |
| `marked.umd.js` | [marked](https://github.com/markedjs/marked) | 18.0.14 | MIT |
| `purify.min.js` | [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.16 | MPL-2.0 OR Apache-2.0 |

`marked` turns assistant replies into HTML; `DOMPurify` sanitises that HTML
before it is injected into the panel. See `src/shared/markdown.js`.

To refresh them, copy the same files from a checkout of the Reader:

```sh
cp ../apreader/node_modules/marked/lib/marked.umd.js vendor/marked.umd.js
cp ../apreader/node_modules/dompurify/dist/purify.min.js vendor/purify.min.js
```
