package vn.bangtrang.backend;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Base64;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.Set;
import java.util.concurrent.Executors;

public final class Main {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String AI_API_VERSION = "chat-v2";
    private static final String DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
    private static final int MAX_BODY_BYTES = 32 * 1024 * 1024;
    private static final int MAX_AI_BODY_BYTES = 12 * 1024 * 1024;
    private static final int MAX_AI_IMAGE_BYTES = 8 * 1024 * 1024;
    private static final HttpClient HTTP = createHttpClient();
    private static final Set<String> OBJECT_TYPES = Set.of(
            "pen", "highlight", "text", "image", "document", "graph",
            "line", "circle", "rectangle", "square", "rightTriangle",
            "isoscelesTriangle", "equilateralTriangle", "trapezoid", "triangle",
            "cone", "tetrahedron", "quadrilateralPyramid", "cube", "cuboid",
            "cylinder", "ruler", "protractor");
    private static final Path PROJECT_ROOT = findProjectRoot();
    private static final Path FRONTEND = PROJECT_ROOT.resolve("Frontend").normalize();
    private static final Path LESSON_FILE = PROJECT_ROOT.resolve("Backend/data/lesson.json");

    private Main() {
    }

    private static HttpClient createHttpClient() {
        HttpClient.Builder builder = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10));
        // Include Windows trusted roots for HTTPS inspected by a local proxy or antivirus.
        // Keep the standard Java roots and normal hostname/certificate verification.
        if (System.getProperty("os.name", "").startsWith("Windows")) {
            try {
                var factory = javax.net.ssl.TrustManagerFactory.getInstance(
                        javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm());
                factory.init((java.security.KeyStore) null);
                var roots = java.security.KeyStore.getInstance("JKS");
                roots.load(null, null);
                int index = 0;
                for (var manager : factory.getTrustManagers()) {
                    if (manager instanceof javax.net.ssl.X509TrustManager trust) {
                        for (var certificate : trust.getAcceptedIssuers()) {
                            roots.setCertificateEntry("java-" + index++, certificate);
                        }
                    }
                }
                var windows = java.security.KeyStore.getInstance("Windows-ROOT");
                windows.load(null, null);
                var aliases = windows.aliases();
                while (aliases.hasMoreElements()) {
                    var certificate = windows.getCertificate(aliases.nextElement());
                    if (certificate != null) roots.setCertificateEntry("windows-" + index++, certificate);
                }
                factory.init(roots);
                var context = javax.net.ssl.SSLContext.getInstance("TLS");
                context.init(null, factory.getTrustManagers(), null);
                builder.sslContext(context);
            } catch (java.security.GeneralSecurityException | IOException exception) {
                System.err.println("Không đọc được kho chứng chỉ Windows; dùng chứng chỉ Java mặc định ("
                        + exception.getClass().getSimpleName() + ").");
            }
        }
        return builder.build();
    }

    public static void main(String[] args) throws IOException {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
        HttpServer server = HttpServer.create(
            new InetSocketAddress(InetAddress.getByName(
                    System.getenv().getOrDefault("HOST", "127.0.0.1")), port), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/api/lesson", Main::handleLesson);
        server.createContext("/api/ai/recognize", exchange -> handleAI(exchange, false));
        server.createContext("/api/ai/solve", exchange -> handleAI(exchange, true));
        server.createContext("/api/ai/status", Main::handleAIStatus);
        server.createContext("/api/ai/chat", Main::handleChat);
        server.createContext("/", Main::serveFrontend);
        server.start();
        System.out.printf("Bảng Trắng đang chạy tại http://localhost:%d%n", port);
        System.out.println("AI API: " + AI_API_VERSION + " · model: "
                + System.getenv().getOrDefault("GEMINI_MODEL", DEFAULT_GEMINI_MODEL));
    }

    private static void handleLesson(HttpExchange exchange) throws IOException {
        try (exchange) {
            String method = exchange.getRequestMethod();
            if ("GET".equals(method)) {
                if (!Files.exists(LESSON_FILE)) {
                    send(exchange, 404, "application/json; charset=utf-8", "{\"error\":\"Chưa có bài giảng được lưu.\"}");
                    return;
                }
                send(exchange, 200, "application/json; charset=utf-8", Files.readAllBytes(LESSON_FILE));
                return;
            }
            if (!"PUT".equals(method)) {
                exchange.getResponseHeaders().set("Allow", "GET, PUT");
                sendError(exchange, 405, "Phương thức không được hỗ trợ.");
                return;
            }

            byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY_BYTES + 1);
            if (body.length > MAX_BODY_BYTES) {
                sendError(exchange, 413, "Bài giảng vượt quá giới hạn 32 MB.");
                return;
            }

            JsonNode document;
            try {
                document = JSON.readTree(body);
                validateDocument(document);
            } catch (IllegalArgumentException exception) {
                sendError(exchange, 400, exception.getMessage());
                return;
            } catch (IOException exception) {
                sendError(exchange, 400, "Dữ liệu JSON không hợp lệ.");
                return;
            }

            Files.createDirectories(LESSON_FILE.getParent());
            Path temporaryFile = Files.createTempFile(LESSON_FILE.getParent(), "lesson-", ".json.tmp");
            try {
                JSON.writeValue(temporaryFile.toFile(), document);
                try {
                    Files.move(temporaryFile, LESSON_FILE, StandardCopyOption.ATOMIC_MOVE,
                            StandardCopyOption.REPLACE_EXISTING);
                } catch (AtomicMoveNotSupportedException exception) {
                    Files.move(temporaryFile, LESSON_FILE, StandardCopyOption.REPLACE_EXISTING);
                }
            } finally {
                Files.deleteIfExists(temporaryFile);
            }

            send(exchange, 200, "application/json; charset=utf-8", "{\"saved\":true}");
        } catch (IOException exception) {
            if (exchange.getResponseCode() == -1) {
                sendError(exchange, 500, "Không thể đọc hoặc lưu bài giảng.");
            }
        }
    }

    private static void handleAIStatus(HttpExchange exchange) throws IOException {
        try (exchange) {
            if (!"GET".equals(exchange.getRequestMethod())) {
                exchange.getResponseHeaders().set("Allow", "GET");
                sendError(exchange, 405, "Chỉ hỗ trợ GET.");
                return;
            }
            String key = System.getenv("GEMINI_API_KEY");
            send(exchange, 200, "application/json; charset=utf-8",
                    JSON.writeValueAsBytes(java.util.Map.of("configured", key != null && !key.isBlank(),
                            "model", System.getenv().getOrDefault("GEMINI_MODEL", DEFAULT_GEMINI_MODEL),
                            "version", AI_API_VERSION)));
        }
    }

    private static void handleAI(HttpExchange exchange, boolean solve) throws IOException {
        try {
            if (!"POST".equals(exchange.getRequestMethod())) {
                exchange.getResponseHeaders().set("Allow", "POST");
                sendError(exchange, 405, "Phương thức không được hỗ trợ.");
                return;
            }

            String apiKey = System.getenv("GEMINI_API_KEY");
            if (apiKey == null || apiKey.isBlank()) {
                sendError(exchange, 503, "AI chưa được cấu hình. Hãy đặt GEMINI_API_KEY rồi khởi động lại backend.");
                return;
            }

            byte[] body = exchange.getRequestBody().readNBytes(MAX_AI_BODY_BYTES + 1);
            if (body.length > MAX_AI_BODY_BYTES) {
                sendError(exchange, 413, "Ảnh gửi lên quá lớn.");
                return;
            }

            JsonNode request;
            try {
                request = JSON.readTree(body);
            } catch (IOException exception) {
                sendError(exchange, 400, "Dữ liệu yêu cầu không hợp lệ.");
                return;
            }

            String dataUrl = request == null ? null : request.path("image").asText(null);
            if (dataUrl == null || !dataUrl.matches("^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$")) {
                sendError(exchange, 400, "Cần gửi ảnh PNG, JPEG hoặc WebP hợp lệ.");
                return;
            }

            int comma = dataUrl.indexOf(',');
            byte[] image;
            try {
                image = Base64.getDecoder().decode(dataUrl.substring(comma + 1));
            } catch (IllegalArgumentException exception) {
                sendError(exchange, 400, "Dữ liệu ảnh không hợp lệ.");
                return;
            }
            if (image.length == 0 || image.length > MAX_AI_IMAGE_BYTES) {
                sendError(exchange, 413, "Ảnh phải nhỏ hơn 8 MB.");
                return;
            }

            String model = System.getenv().getOrDefault("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).trim();
            if (!model.matches("[A-Za-z0-9._-]+")) {
                sendError(exchange, 500, "Tên model Gemini không hợp lệ.");
                return;
            }

            String prompt = solve
                    ? "Đọc đề toán trong ảnh và giải bằng tiếng Việt. Trình bày các bước ngắn gọn, "
                        + "giữ đúng ký hiệu toán học; nếu ảnh không phải bài toán, mô tả nội dung chính."
                    : "Nhận diện và chép lại chính xác chữ viết cùng công thức trong ảnh. "
                        + "Giữ nguyên thứ tự dòng và ký hiệu; không giải bài. Nếu không đọc được, hãy nói rõ. ";

            ObjectNode payload = JSON.createObjectNode();
            ArrayNode parts = payload.putArray("contents").addObject().putArray("parts");
            parts.addObject().put("text", prompt);
            ObjectNode inlineImage = parts.addObject().putObject("inlineData");
            inlineImage.put("mimeType", dataUrl.substring("data:".length(), comma));
            inlineImage.put("data", Base64.getEncoder().encodeToString(image));
            payload.putObject("generationConfig")
                    .put("maxOutputTokens", 8192);

            sendGemini(exchange, payload, apiKey, model);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            sendError(exchange, 503, "Yêu cầu AI bị gián đoạn.");
        } catch (IOException exception) {
            if (exchange.getResponseCode() == -1) sendAIConnectionError(exchange, exception);
        } finally {
            exchange.close();
        }
    }

    private static void handleChat(HttpExchange exchange) throws IOException {
        try {
            if (!"POST".equals(exchange.getRequestMethod())) {
                exchange.getResponseHeaders().set("Allow", "POST");
                sendError(exchange, 405, "Chỉ hỗ trợ POST.");
                return;
            }
            byte[] body = exchange.getRequestBody().readNBytes(MAX_AI_BODY_BYTES + 1);
            if (body.length > MAX_AI_BODY_BYTES) {
                sendError(exchange, 413, "Tin nhắn và ảnh bảng quá lớn.");
                return;
            }
            JsonNode request;
            try {
                request = JSON.readTree(body);
            } catch (IOException exception) {
                sendError(exchange, 400, "Dữ liệu JSON không hợp lệ.");
                return;
            }
            JsonNode messages = request == null ? JSON.createObjectNode().path("messages") : request.path("messages");
            if (!messages.isArray() || messages.isEmpty() || messages.size() > 21 || messages.size() % 2 == 0) {
                sendError(exchange, 400, "Cần 1–21 tin nhắn, kết thúc bằng câu hỏi của bạn.");
                return;
            }
            ObjectNode payload = JSON.createObjectNode();
            payload.putObject("systemInstruction").putArray("parts").addObject().put("text",
                    "Bạn là trợ lý giảng dạy. Luôn trả lời bằng tiếng Việt tự nhiên, đúng dấu, dễ hiểu cho học sinh. "
                    + "Đi thẳng vào câu trả lời, không chép lại toàn bộ đề hoặc mọi phương án nếu không cần. "
                    + "Với câu trắc nghiệm, nêu đáp án trước rồi giải thích ngắn gọn. Với bài toán, trình bày từng bước rõ ràng. "
                    + "Chia thành các đoạn ngắn, mỗi đoạn một ý; dùng danh sách đánh số khi có nhiều bước. "
                    + "Chỉ dùng văn bản thuần: không Markdown, không dấu **, không bảng, không khối mã và tuyệt đối không dùng LaTeX. "
                    + "Viết công thức bằng ký hiệu đọc được trực tiếp như x², y², √, ≤, ≥, ×, ÷; phân số viết (a + b)/(c + d). "
                    + "Hệ phương trình viết mỗi phương trình trên một dòng; không dùng lệnh begin, cases, frac hoặc dấu đô la. "
                    + "Ảnh đính kèm là phần bảng hiện tại của người dùng. Khi người dùng hỏi câu trên bảng, hãy đọc ảnh và trả lời đúng câu đó. "
                    + "Nếu chữ trong ảnh không rõ hoặc thiếu đề, hãy yêu cầu phóng to hoặc gửi đủ đề; không đoán nội dung. "
                    + "Bạn có thể đề xuất bản sửa chữ trong câu trả lời, nhưng không được nói đã sửa trực tiếp bảng vì chưa có công cụ sửa bảng. "
                    + "Nếu thiếu thông tin, hỏi lại ngắn gọn. Chỉ dùng từ ngoại ngữ khi đó là tên riêng hoặc thuật ngữ cần thiết.");
            ArrayNode contents = payload.putArray("contents");
            int index = 0;
            for (JsonNode message : messages) {
                String expected = index++ % 2 == 0 ? "user" : "assistant";
                if (!message.isObject() || !expected.equals(message.path("role").asText())
                        || !message.path("text").isTextual() || message.path("text").asText().isBlank()
                        || message.path("text").asText().length() > 20000) {
                    sendError(exchange, 400, "Tin nhắn không hợp lệ hoặc quá dài (tối đa 20.000 ký tự).");
                    return;
                }
                contents.addObject().put("role", expected.equals("assistant") ? "model" : "user")
                        .putArray("parts").addObject().put("text", message.path("text").asText());
            }
            JsonNode boardImage = request.path("image");
            if (!boardImage.isMissingNode() && !boardImage.isNull()) {
                String dataUrl = boardImage.asText("");
                if (!boardImage.isTextual() || !dataUrl.matches("^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$")) {
                    sendError(exchange, 400, "Ảnh bảng không hợp lệ.");
                    return;
                }
                int comma = dataUrl.indexOf(',');
                byte[] image;
                try { image = Base64.getDecoder().decode(dataUrl.substring(comma + 1)); }
                catch (IllegalArgumentException exception) {
                    sendError(exchange, 400, "Dữ liệu ảnh bảng không hợp lệ.");
                    return;
                }
                if (image.length == 0 || image.length > MAX_AI_IMAGE_BYTES) {
                    sendError(exchange, 413, "Ảnh bảng phải nhỏ hơn 8 MB.");
                    return;
                }
                ArrayNode parts = (ArrayNode) contents.get(contents.size() - 1).path("parts");
                parts.addObject().putObject("inlineData")
                        .put("mimeType", dataUrl.substring(5, comma))
                        .put("data", Base64.getEncoder().encodeToString(image));
            }
            String apiKey = System.getenv("GEMINI_API_KEY");
            if (apiKey == null || apiKey.isBlank()) {
                sendError(exchange, 503, "AI chưa được cấu hình. Đặt GEMINI_API_KEY rồi khởi động lại backend.");
                return;
            }
            String model = System.getenv().getOrDefault("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).trim();
            if (!model.matches("[A-Za-z0-9._-]+")) {
                sendError(exchange, 500, "Tên GEMINI_MODEL không hợp lệ.");
                return;
            }
            payload.putObject("generationConfig").put("maxOutputTokens", 8192);
            sendGemini(exchange, payload, apiKey, model);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            sendError(exchange, 503, "Yêu cầu AI bị gián đoạn.");
        } catch (IOException exception) {
            if (exchange.getResponseCode() == -1) sendAIConnectionError(exchange, exception);
        } finally {
            exchange.close();
        }
    }

    private static void sendGemini(HttpExchange exchange, ObjectNode payload, String apiKey, String model)
            throws IOException, InterruptedException {

            URI endpoint = URI.create("https://generativelanguage.googleapis.com/v1beta/models/"
                    + model + ":generateContent");
            HttpRequest upstreamRequest = HttpRequest.newBuilder(endpoint)
                    .timeout(Duration.ofSeconds(60))
                    .header("Content-Type", "application/json")
                    .header("x-goog-api-key", apiKey.trim())
                    .POST(HttpRequest.BodyPublishers.ofByteArray(JSON.writeValueAsBytes(payload)))
                    .build();

            HttpResponse<String> upstream = HTTP.send(upstreamRequest,
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (upstream.statusCode() < 200 || upstream.statusCode() >= 300) {
                int status = upstream.statusCode() == 429 ? 429 : 502;
                JsonNode error;
                try {
                    JsonNode errorBody = JSON.readTree(upstream.body());
                    error = errorBody == null ? JSON.createObjectNode() : errorBody.path("error");
                }
                catch (IOException exception) { error = JSON.createObjectNode(); }
                String detail = error.path("message").asText("").replace(apiKey.trim(), "[ẩn key]");
                detail = detail.replaceAll("AIza[A-Za-z0-9_-]+", "[ẩn key]");
                if (detail.length() > 1500) detail = detail.substring(0, 1500);
                String hint = switch (upstream.statusCode()) {
                    case 400 -> "Yêu cầu hoặc API key không hợp lệ. Kiểm tra GEMINI_API_KEY.";
                    case 401, 403 -> "API key không có quyền truy cập, bị chặn hoặc đã hết hiệu lực. Kiểm tra key trong Google AI Studio.";
                    case 404 -> "Không tìm thấy model " + model + ". Đặt GEMINI_MODEL thành model có sẵn cho tài khoản rồi khởi động lại backend.";
                    case 429 -> "Đã hết hạn mức Gemini. Kiểm tra quota/billing trong Google AI Studio hoặc thử lại sau.";
                    default -> "Dịch vụ Gemini đang gặp lỗi. Hãy thử lại sau.";
                };
                send(exchange, status, "application/json; charset=utf-8", JSON.writeValueAsBytes(java.util.Map.of(
                        "error", hint + (detail.isBlank() ? "" : "\nChi tiết Google (HTTP " + upstream.statusCode() + "): " + detail),
                        "upstreamStatus", upstream.statusCode())));
                return;
            }

            JsonNode result = JSON.readTree(upstream.body());
            StringBuilder text = new StringBuilder();
            for (JsonNode part : result.path("candidates").path(0).path("content").path("parts")) {
                if (part.path("text").isTextual() && !part.path("thought").asBoolean(false)) {
                    if (!text.isEmpty()) text.append('\n');
                    text.append(part.path("text").asText());
                }
            }
            if (text.isEmpty()) {
                String reason = result.path("promptFeedback").path("blockReason").asText(
                        result.path("candidates").path(0).path("finishReason").asText("UNKNOWN"));
                sendError(exchange, 502, "Gemini không trả về nội dung (" + reason + "). Hãy diễn đạt lại hoặc thử ảnh rõ hơn.");
                return;
            }

            send(exchange, 200, "application/json; charset=utf-8",
                    JSON.writeValueAsBytes(java.util.Map.of("text", text.toString())));
    }

    private static void sendAIConnectionError(HttpExchange exchange, IOException exception) throws IOException {
        String hint = exception instanceof java.net.http.HttpTimeoutException
                ? "Gemini phản hồi quá lâu. Hãy thử lại."
                : exception instanceof javax.net.ssl.SSLException
                    ? "Không xác thực được kết nối HTTPS với Gemini. Kiểm tra chứng chỉ Java, proxy hoặc phần mềm chặn HTTPS."
                    : "Không kết nối được với Gemini. Hãy kiểm tra mạng, DNS, proxy và thử lại.";
        sendError(exchange, 502, hint + " (" + exception.getClass().getSimpleName() + ")");
    }

    private static void validateDocument(JsonNode document) {
        if (document == null || !document.isObject()
                || !document.path("version").canConvertToInt()
                || document.path("version").intValue() != 1
                || !document.path("objects").isArray()
                || document.path("objects").size() > 5000) {
            throw new IllegalArgumentException("Tệp không đúng định dạng bài giảng.");
        }

        for (JsonNode object : document.path("objects")) {
            if (!object.isObject() || !OBJECT_TYPES.contains(object.path("type").asText())) {
                throw new IllegalArgumentException("Đối tượng không hợp lệ.");
            }

            JsonNode points = object.path("points");
            if (!points.isMissingNode() && !points.isNull()) {
                if (!points.isArray() || points.size() > 100_000) {
                    throw new IllegalArgumentException("Nét vẽ không hợp lệ.");
                }
                points.forEach(Main::validateCoordinates);
            } else {
                validateCoordinates(object);
            }

            JsonNode vertices = object.path("vertices");
            if (!vertices.isMissingNode() && !vertices.isNull()) {
                int expected = expectedVertexCount(object.path("type").asText());
                if (!vertices.isArray() || expected == 0 || vertices.size() != expected) {
                    throw new IllegalArgumentException("Các đỉnh hình học không hợp lệ.");
                }
                vertices.forEach(Main::validateCoordinates);
            }

            String type = object.path("type").asText();
            if (("pen".equals(type) || "highlight".equals(type))
                    && (!points.isArray() || points.isEmpty())) {
                throw new IllegalArgumentException("Nét vẽ trống.");
            }
            if ("text".equals(type)
                    && (!object.path("text").isTextual() || object.path("text").asText().length() > 20_000)) {
                throw new IllegalArgumentException("Văn bản không hợp lệ.");
            }
            if ("image".equals(type)
                    && (!object.path("src").isTextual()
                    || !object.path("src").asText().matches("^data:image/(png|jpeg|webp|gif);base64,.*"))) {
                throw new IllegalArgumentException("Ảnh không hợp lệ.");
            }
            if ("document".equals(type)
                    && (!object.path("name").isTextual() || object.path("name").asText().isEmpty())) {
                throw new IllegalArgumentException("Tài liệu không hợp lệ.");
            }
            if (!points.isArray() && !"text".equals(type)
                    && (!isFiniteNumber(object.path("w")) || !isFiniteNumber(object.path("h")))) {
                throw new IllegalArgumentException("Kích thước không hợp lệ.");
            }
        }
    }

    private static void validateCoordinates(JsonNode point) {
        if (!point.isObject() || !isFiniteNumber(point.path("x")) || !isFiniteNumber(point.path("y"))) {
            throw new IllegalArgumentException("Tọa độ không hợp lệ.");
        }
    }

    private static boolean isFiniteNumber(JsonNode value) {
        return value.isNumber() && Double.isFinite(value.doubleValue());
    }

    private static int expectedVertexCount(String type) {
        return switch (type) {
            case "line" -> 2;
            case "circle", "cylinder", "ruler", "protractor", "rectangle", "square", "trapezoid" -> 4;
            case "cone", "rightTriangle", "isoscelesTriangle", "equilateralTriangle", "triangle" -> 3;
            case "tetrahedron" -> 4;
            case "quadrilateralPyramid" -> 5;
            case "cube", "cuboid" -> 8;
            default -> 0;
        };
    }

    private static void serveFrontend(HttpExchange exchange) throws IOException {
        try (exchange) {
            if (!"GET".equals(exchange.getRequestMethod())) {
                sendError(exchange, 405, "Phương thức không được hỗ trợ.");
                return;
            }
            String requestPath = exchange.getRequestURI().getPath();
            Path file = FRONTEND.resolve(requestPath.substring(1)).normalize();
            if (requestPath.endsWith("/") || requestPath.isEmpty()) {
                file = file.resolve("index.html");
            }
            if (!file.startsWith(FRONTEND) || !Files.isRegularFile(file)) {
                sendError(exchange, 404, "Không tìm thấy tệp.");
                return;
            }
            String contentType = switch (extension(file)) {
                case "html" -> "text/html; charset=utf-8";
                case "css" -> "text/css; charset=utf-8";
                case "js" -> "text/javascript; charset=utf-8";
                case "svg" -> "image/svg+xml";
                default -> "application/octet-stream";
            };
            send(exchange, 200, contentType, Files.readAllBytes(file));
        }
    }

    private static String extension(Path file) {
        String name = file.getFileName().toString();
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase();
    }

    private static Path findProjectRoot() {
        Path current = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize();
        if (Files.isDirectory(current.resolve("Frontend"))) return current;
        if (Files.isDirectory(current.getParent().resolve("Frontend"))) return current.getParent();
        throw new IllegalStateException("Hãy chạy backend từ thư mục gốc dự án hoặc Backend.");
    }

    private static void sendError(HttpExchange exchange, int status, String message) throws IOException {
        send(exchange, status, "application/json; charset=utf-8", JSON.writeValueAsBytes(java.util.Map.of("error", message)));
    }

    private static void send(HttpExchange exchange, int status, String contentType, String body) throws IOException {
        send(exchange, status, contentType, body.getBytes(StandardCharsets.UTF_8));
    }

    private static void send(HttpExchange exchange, int status, String contentType, byte[] body) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", contentType);
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, body.length);
        exchange.getResponseBody().write(body);
    }
}
