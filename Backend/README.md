# Backend

Requires Java 21 or newer and Maven 3.9 or newer.

From the project root, run:

```powershell
mvn -f Backend/pom.xml compile exec:java
```

Open `http://localhost:8080`. The Java server serves the frontend and exposes:

- `GET /api/lesson` to load the saved lesson
- `PUT /api/lesson` to validate and save the current lesson
- `GET /api/ai/status` to check whether an API key is configured
- `POST /api/ai/recognize` to transcribe handwriting from a board image
- `POST /api/ai/solve` to solve a problem from a board image
- `POST /api/ai/chat` to chat using `{ "messages": [{ "role": "user", "text": "..." }] }`

To enable AI, create a Gemini API key at https://aistudio.google.com/apikey.
Set the key in the same PowerShell session that starts the backend:

```powershell
$env:GEMINI_API_KEY = "YOUR_API_KEY"
$env:GEMINI_MODEL = "gemini-3.8-flash" # Optional; this is the default
mvn -f Backend/pom.xml compile exec:java
```

Restart the backend after changing these variables. Keep the key on the backend;
do not put it in frontend JavaScript or commit it to the repository.
Open `http://localhost:8080`, select the AI tab and type a question to chat.
The image recognition/solve endpoints remain available for API clients but
are not exposed as buttons in the chat interface. These endpoints accept PNG,
JPEG or WebP data URLs up to 8 MB
and returns `{ "text": "..." }`; errors return `{ "error": "..." }`.
The configured status checks key presence; a successful request confirms API access.

The AI panel contains only chat messages and the message form: Enter sends and Shift+Enter inserts a
newline. Chat keeps the latest 10 exchanges in memory, clears on refresh, and
starts over on page refresh. When the board has objects, each sent message includes
a PNG snapshot of the visible board, without selection overlays or toolbars.
The UI explains this beside the empty conversation. Pan/zoom to show the complete
question before sending. Chat accepts an optional `image` data URL (up to 8 MB)
with a total request limit of 12 MB. Answers are requested
in Vietnamese plain text with short paragraphs and readable math symbols instead
of raw LaTeX. Chat history must
alternate user/assistant roles and end in a user message (maximum 21 messages,
20,000 characters per message).

Provider errors include the Google HTTP status and a redacted error message.
For 400/403 check the API key and project access; for 404 choose an available
`GEMINI_MODEL`; for 429 check quota/billing. Restart the backend after any
configuration change. A configured API key is not proof that it has API access.
On Windows the HTTP client combines standard Java trusted certificates with
Windows trusted roots to support local HTTPS proxies/antivirus. Certificate
and hostname verification remain enabled. SSL failures are reported separately.

After updating source code, stop the old running Java server with Ctrl+C in
its terminal, then run `mvn -f Backend/pom.xml compile exec:java` in that same
terminal to retain session environment variables. Refresh the browser. The API
status endpoint includes the backend version for diagnostics.
Compiling files alone does not update a running Java process.

The server stores one shared lesson in `Backend/data/lesson.json`, accepts JSON
documents up to 32 MB, and binds to loopback only. This is local persistence,
not multi-user or cloud storage.

The insert image/document button opens PDFs in a document view using
the locally bundled PDF.js library. Pen, highlight, undo, lesson saving, and
the existing PDF export work with these pages. Erasing preserves PDF page
backgrounds. Pages are arranged vertically on a soft gray background; scroll to
reach subsequent pages and zoom with the controls below. Opening a PDF replaces the current
board contents; undo restores the preceding board. Import accepts PDFs
up to 50 MB and 50 pages, with a 24 MB rendered lesson limit. Password-protected
PDFs must be unlocked first. Imported pages are raster images, so PDF text
selection and editing the original PDF are not supported.


The drawing workspace uses portrait A4 sheets (210 × 297 mm), initially cream
with a full-sheet square grid, on a soft gray background. All four edges are writable.
Open **Giấy & trang** to choose blank, dotted, narrow/wide ruled, squared, or
ruled paper with a decorative margin. Select a paper color or use the custom
color picker, then **Áp dụng** to update all A4 sheets. The **Các trang** tab
shows thumbnails for navigation and adding pages; imported PDF pages keep their
original appearance. Use **Thêm trang** or scroll toward the bottom to keep extending the
document. Page count, paper appearance, and view are saved within the login session;
undo/redo also restores page additions and paper settings. Zoom with **+ / −** (5% steps),
**Ctrl/Cmd + wheel**, or a gentle two-finger pinch (10–400%). Drag with the hand tool
or Space to pan; Shift + wheel scrolls horizontally. Click the percentage to fit the
sheet width and return to the first page. Only visible sheets are painted on the viewport
canvas. Opening an existing lesson without A4 metadata fits its contents into
these pages while retaining all objects.

**Lưu PDF** exports one A4 PDF page per sheet containing content, preserves
intermediate blank sheets, and omits trailing empty sheets. Imported PDF pages
retain their page boundaries and are fitted proportionally onto A4 when exported.
**Xuất ảnh** downloads the complete current sheet as PNG, including offscreen
content. Exports include the selected paper pattern and color but omit
selection outlines, toolbars, and the gray space around the paper.


Every successful login starts a new blank A4 board, with no drawings or uploaded
files from the previous login. Autosave and reload recovery apply only to the
current login session: a sessionStorage cache and a matching session ID on the
server copy prevent old lessons from being restored after logging in again.
The legacy localStorage lesson cache is no longer read. Download a PDF to keep
work across logins.

The left toolbar actions are **Xóa nét viết** (all pen/highlight strokes on all
pages), **Gỡ ảnh / file** (all uploaded images and document pages, retaining other
content), and **Xóa tất cả** (all content and pages, returning to one blank A4
sheet). These actions support undo. Repeated scratch gestures remove only pen
and highlight strokes; they never remove images, document pages, typed text or
shapes. Both eraser modes also preserve uploaded assets. Use the explicit removal
buttons to remove files. Clearing the board or files cancels pending insertions.
