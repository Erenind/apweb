# Vendored libraries

These two browser builds are copied from the Reader project's `node_modules` so
the extension works without a build step. They are third-party code, unchanged.

| 文件 | 包 | 版本 | 许可证 |
| --- | --- | --- | --- |
| `marked.umd.js` | [marked](https://github.com/markedjs/marked) | 18.0.14 | MIT |
| `purify.min.js` | [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.16 | MPL-2.0 OR Apache-2.0 |
| `katex.min.js` | [KaTeX](https://katex.org) | 0.19.0 | MIT（全文见 `KATEX-LICENSE.txt`） |

`marked` turns assistant replies into HTML; `DOMPurify` sanitises that HTML
before it is injected into the panel; `katex` renders LaTeX maths to MathML
(only the JS build is vendored — MathML needs no KaTeX CSS or fonts, and Firefox
renders it natively). See `src/shared/markdown.js` and `src/shared/math.js`.

To refresh them, copy the same files from a checkout of the Reader:

```sh
cp ../apreader/node_modules/marked/lib/marked.umd.js vendor/marked.umd.js
cp ../apreader/node_modules/dompurify/dist/purify.min.js vendor/purify.min.js
```

KaTeX is not in the Reader's `node_modules`; fetch it with
`npm pack katex` and copy `package/dist/katex.min.js` plus `package/LICENSE`.
