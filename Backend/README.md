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
document. Page count, paper appearance, and position are saved within the login session;
undo/redo also restores page additions and paper settings. Pages automatically fit
the available width with at most 100% magnification. Scroll between pages; drag
with the hand tool or Space to pan. Two-finger gestures pan without changing
magnification, and Shift + wheel scrolls horizontally. Only visible sheets are painted on the viewport
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

New pen/highlighter strokes use `Frontend/js/rope-ink.js` and
`Frontend/js/ink-engine.js` with the locally
bundled MIT-licensed **perfect-freehand 1.2.3**. Its continuous stroke outlines
are painted with quadratic curves on Canvas. Version 8 captures every confirmed
sample in `rawPoints` (`x`, `y`, original pressure, tilt and timestamp), separately
from the filtered vector `points`. Each display point links back through
`rawIndex`. An adaptive One Euro position filter runs before fitting the elastic
string to spatial guide pegs. It uses a 12 Hz minimum cutoff, beta 0.20 and an
8 Hz derivative cutoff, tuned in CSS coordinates: slow writing suppresses tremor,
while sustained faster motion raises the cutoff. A 0.9 CSS-pixel lag bound keeps
acceleration responsive. Pressure and stroke width have separate temporal filters.
The algorithm follows https://gery.casiez.net/1euro/.
The automatic handwriting profile uses charcoal ink and a fine
1.6 CSS-pixel nominal diameter, captured in document coordinates when a stroke
begins. Width varies subtly with pressure, tilt and speed, within 0.86–1.14 times
the base diameter. Mouse/touch use the same bounded profile without extra
pressure simulation. Highlighters retain constant width and
are filled once so joins/crossings do not accumulate opacity. Coalesced Pointer
Events retain stylus samples; rendering is batched to animation frames with a
cached background and cached completed paths. Palm events cannot interrupt a
pen stroke, and cancelled strokes are discarded. Pressure/tilt require browser
and stylus support.

Open **Công cụ / AI → Màu nét** to choose a color. Width, stability, pressure,
handwriting scale and zoom controls are removed. Old saved pen/scale preferences
are no longer read. Coordinates use the page's existing scale, with no additional
handwriting magnification, so separate strokes and Vietnamese accents stay aligned.

The first pen-down guide is pinned. New filtered input creates guide pegs every
0.75 CSS pixel along the traveled path, independently of event/frame frequency.
A stronger local bending-energy fit relaxes the last 32 pegs, keeping ordinary
displacement within 2 CSS pixels of their filtered attachments. Older pegs are locked as the pen
moves on. An approximating quadratic B-spline wraps the string around the relaxed
pegs with continuous tangents and rounded turns. Completed spans whose supporting
pegs are locked stay fixed; only the recent tail is corrected. Every guide crossing
is replayed in order, so batched input and restored vector samples produce the
same fit. The first position remains exact; the tail follows the latest filtered
nib position. Raw acquisition coordinates remain available in the saved stroke.

Versions 7 and 8 also detect concentrated sharp turns over spatial supports rather
than only between adjacent samples. Isolated peaks are replaced with circular
fillets targeting a 2.2 CSS-pixel radius, with local corner displacement capped
at 4 CSS pixels. Existing gradual curves and small closed loops keep the normal
elastic fit. This provides a visible round apex instead of merely adding more
samples to a tight corner. Corner supports and radii scale with the vector stroke.

Pen strokes gently narrow over the first/last 3 CSS pixels to a
minimum of 82% width, retaining round caps. Short accents and dots stay untapered,
and highlighters retain their uniform width. Taper activates gradually as a stroke
grows, with no separate reshaping pass on pen-up.

Writing previews use `getPredictedEvents()` where available, with a conservative
velocity fallback. Adaptive input also filters the forecast on a temporary copy
of its state. Prediction requires steady motion, advances at most 2 CSS
pixels, and expires after 32 ms. Stopping, sharp turns, long sampling gaps,
pen-up and cancellation clear it. Forecasts copy confirmed pressure/tilt and add
temporary guide pegs ahead of the real nib on a copy of the recent string. The
temporary guides are replaced as real input arrives and never lock actual pegs,
enter saved lessons,
undo history or eraser/lasso geometry. Mouse and single-touch writing use the same
short guide forecast; highlighters and pan gestures do not predict.
The browser API follows https://www.w3.org/TR/pointerevents3/#predicted-events.

Autosave stores both raw acquisition samples and filtered mathematical points,
pressure, tilt, timestamps and the stroke's render settings with `inkVersion: 8`.
Fitting, undo/redo, erasing, lasso cuts and AI captures use the same vector painter.
Movement/scaling transform both point arrays; erasing slices the matching raw
samples and rebases their links. A stationary pen-up is recorded in raw history
while preserving the last displayed point to avoid a final hook. New pen-up
movement passes through the same position filter. No whole-stroke smoothing is
applied at pen-up. Canvas resizes and changing display DPR redraw vector paths at
the current backing resolution, including display changes with unchanged CSS size.
Every normal and live ink render also checks the backing size and rebuilds the
background if needed, covering browsers that omit a resolution-change event.
Earlier inkVersion 2/3/4/5/6/7 strokes retain their original painter. PNG and the
existing PDF export remain raster.
The implementation follows perfect-freehand's documented Canvas integration
and publicly documented Goodnotes pen/stabilization behavior:
https://github.com/steveruizok/perfect-freehand
https://support.goodnotes.com/hc/en-us/articles/7353756785679-Write-and-customize-ink-with-the-Pen-tool
https://www.goodnotes.com/blog/features-fixes-updates-march-2025

Run `python tests/test_input_pipeline_browser.py` for raw capture, adaptive input,
prediction, editing and DPR checks, `python tests/test_round_ink_browser.py`
for sharp-corner and small-loop checks,
`python tests/test_rope_browser.py` for the elastic-guide geometry checks,
`python tests/test_ink_browser.py` for the ink input/rendering checks
and `python tests/test_lasso_browser.py` for lasso regression checks. These use
Python Playwright and Chrome with mocked HTTP requests and lesson saves.
