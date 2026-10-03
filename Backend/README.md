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
