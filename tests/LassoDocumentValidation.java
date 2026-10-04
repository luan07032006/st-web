import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.lang.reflect.InvocationTargetException;
import java.nio.file.Path;

// Validates a fixture saved by test_lasso_browser.py against the server schema.
public class LassoDocumentValidation {
    public static void main(String[] args) throws Exception {
        var mapper = new ObjectMapper();
        JsonNode fixture = mapper.readTree(Path.of(args[0]).toFile());
        var validate = Class.forName("vn.bangtrang.backend.Main")
                .getDeclaredMethod("validateDocument", JsonNode.class);
        validate.setAccessible(true);
        validate.invoke(null, fixture);
        for (String key : new String[]{"clipRegions", "cutouts"}) {
            for (String invalid : new String[]{"null", "{}", "[[{\"x\":0,\"y\":0}]]",
                    "[[{\"x\":0,\"y\":0},{\"x\":1,\"y\":1},{\"x\":2,\"y\":\"invalid\"}]]"}) {
                JsonNode modified = fixture.deepCopy();
                ((ObjectNode) modified.path("objects").get(0)).set(key, mapper.readTree(invalid));
                try {
                    validate.invoke(null, modified);
                    throw new AssertionError("Accepted invalid " + key + ": " + invalid);
                } catch (InvocationTargetException error) {
                    if (!(error.getCause() instanceof IllegalArgumentException)) throw error;
                }
            }
        }
        System.out.println("PASS server accepts saved crops and rejects invalid masks");
    }
}
