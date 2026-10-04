PDF.js 6.4.299, vendored from the official `pdfjs-dist` npm package.
Source: https://github.com/mozilla/pdf.js
License: Apache-2.0 (see LICENSE).

Keep the main module, worker, fonts, CMaps, and WASM assets on the same version.
These assets are served locally; opening a PDF requires no CDN connection.
The two build modules use `.js` filenames so older running Java servers also
serve them with a JavaScript MIME type. They remain ES modules.
