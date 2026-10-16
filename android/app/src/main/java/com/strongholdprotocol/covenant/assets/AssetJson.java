package com.strongholdprotocol.covenant.assets;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON reader and writer for the runtime asset files.
 *
 * <p>The asset store runs offline and on every page request, so it must not depend on anything the
 * platform may change: no {@code org.json} (which is only present on Android, and whose behaviour
 * differs between releases) and no reflection. This parser accepts exactly the data the release
 * tooling writes (objects, arrays, strings, numbers, booleans, null) and rejects everything else.
 * The semantics that matter for safety are checked by {@link AssetConfig}, {@link AssetPackage} and
 * {@link AssetIndex} rather than here.
 */
public final class AssetJson {
    private AssetJson() {
    }

    /** Parse a complete JSON document. Throws {@link IllegalArgumentException} on malformed input. */
    public static Object parse(String text) {
        if (text == null) throw new IllegalArgumentException("empty JSON document");
        Parser parser = new Parser(text);
        Object value = parser.value();
        parser.skipWhitespace();
        if (!parser.done()) throw new IllegalArgumentException("trailing JSON after offset " + parser.at);
        return value;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> object(Object value) {
        if (value instanceof Map) return (Map<String, Object>) value;
        throw new IllegalArgumentException("expected a JSON object, found " + describe(value));
    }

    @SuppressWarnings("unchecked")
    public static List<Object> array(Object value) {
        if (value instanceof List) return (List<Object>) value;
        throw new IllegalArgumentException("expected a JSON array, found " + describe(value));
    }

    public static Map<String, Object> objectOrNull(Object value) {
        if (value instanceof Map) return object(value);
        return null;
    }

    public static List<Object> arrayOrEmpty(Object value) {
        if (value instanceof List) return array(value);
        return new ArrayList<>();
    }

    /** Member of an object, or null when the object has no such key. */
    public static Object get(Map<String, Object> object, String key) {
        return object == null ? null : object.get(key);
    }

    public static String string(String value, String fallback) {
        return value == null ? fallback : value;
    }

    public static String string(Object value, String fallback) {
        return value instanceof String ? (String) value : fallback;
    }

    public static long number(Object value, long fallback) {
        if (value instanceof Number) return ((Number) value).longValue();
        if (value instanceof String) {
            try {
                return Long.parseLong(((String) value).trim());
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    public static boolean bool(Object value, boolean fallback) {
        if (value instanceof Boolean) return (Boolean) value;
        return fallback;
    }

    /** Serialise a value built from Map / List / String / Number / Boolean / null. */
    public static String stringify(Object value) {
        StringBuilder out = new StringBuilder(256);
        write(value, out);
        return out.toString();
    }

    private static void write(Object value, StringBuilder out) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof String) {
            writeString((String) value, out);
        } else if (value instanceof Boolean) {
            out.append(((Boolean) value) ? "true" : "false");
        } else if (value instanceof Number) {
            Number number = (Number) value;
            if (number instanceof Double || number instanceof Float) {
                double raw = number.doubleValue();
                if (raw == Math.rint(raw) && !Double.isInfinite(raw)) out.append((long) raw);
                else out.append(raw);
            } else {
                out.append(number.longValue());
            }
        } else if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (!first) out.append(',');
                first = false;
                writeString(String.valueOf(entry.getKey()), out);
                out.append(':');
                write(entry.getValue(), out);
            }
            out.append('}');
        } else if (value instanceof Iterable) {
            out.append('[');
            boolean first = true;
            for (Object item : (Iterable<?>) value) {
                if (!first) out.append(',');
                first = false;
                write(item, out);
            }
            out.append(']');
        } else {
            throw new IllegalArgumentException("cannot serialise " + describe(value));
        }
    }

    private static void writeString(String text, StringBuilder out) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        out.append('"');
    }

    private static String describe(Object value) {
        return value == null ? "null" : value.getClass().getSimpleName();
    }

    private static final class Parser {
        private final String text;
        private int at;

        Parser(String text) {
            this.text = text;
        }

        boolean done() {
            return at >= text.length();
        }

        void skipWhitespace() {
            while (at < text.length()) {
                char c = text.charAt(at);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') at++;
                else break;
            }
        }

        Object value() {
            skipWhitespace();
            if (done()) throw new IllegalArgumentException("unexpected end of JSON");
            char c = text.charAt(at);
            switch (c) {
                case '{': return objectValue();
                case '[': return arrayValue();
                case '"': return stringValue();
                case 't': expect("true"); return Boolean.TRUE;
                case 'f': expect("false"); return Boolean.FALSE;
                case 'n': expect("null"); return null;
                default: return numberValue();
            }
        }

        private Map<String, Object> objectValue() {
            Map<String, Object> map = new LinkedHashMap<>();
            at++;
            skipWhitespace();
            if (!done() && text.charAt(at) == '}') {
                at++;
                return map;
            }
            while (true) {
                skipWhitespace();
                if (done() || text.charAt(at) != '"') throw new IllegalArgumentException("expected a key at offset " + at);
                String key = stringValue();
                skipWhitespace();
                if (done() || text.charAt(at) != ':') throw new IllegalArgumentException("expected ':' at offset " + at);
                at++;
                map.put(key, value());
                skipWhitespace();
                if (done()) throw new IllegalArgumentException("unterminated object");
                char c = text.charAt(at);
                if (c == ',') {
                    at++;
                    continue;
                }
                if (c == '}') {
                    at++;
                    return map;
                }
                throw new IllegalArgumentException("expected ',' or '}' at offset " + at);
            }
        }

        private List<Object> arrayValue() {
            List<Object> list = new ArrayList<>();
            at++;
            skipWhitespace();
            if (!done() && text.charAt(at) == ']') {
                at++;
                return list;
            }
            while (true) {
                list.add(value());
                skipWhitespace();
                if (done()) throw new IllegalArgumentException("unterminated array");
                char c = text.charAt(at);
                if (c == ',') {
                    at++;
                    continue;
                }
                if (c == ']') {
                    at++;
                    return list;
                }
                throw new IllegalArgumentException("expected ',' or ']' at offset " + at);
            }
        }

        private String stringValue() {
            at++;
            int start = at;
            boolean escaped = false;
            while (at < text.length()) {
                char c = text.charAt(at);
                if (c == '\\') {
                    escaped = true;
                    at += 2;
                    continue;
                }
                if (c == '"') break;
                at++;
            }
            if (at >= text.length()) throw new IllegalArgumentException("unterminated string");
            String raw = text.substring(start, at);
            at++;
            return escaped ? unescape(raw) : raw;
        }

        private static String unescape(String raw) {
            StringBuilder out = new StringBuilder(raw.length());
            for (int i = 0; i < raw.length(); i++) {
                char c = raw.charAt(i);
                if (c != '\\') {
                    out.append(c);
                    continue;
                }
                i++;
                if (i >= raw.length()) throw new IllegalArgumentException("unterminated escape");
                char next = raw.charAt(i);
                switch (next) {
                    case '"': out.append('"'); break;
                    case '\\': out.append('\\'); break;
                    case '/': out.append('/'); break;
                    case 'b': out.append('\b'); break;
                    case 'f': out.append('\f'); break;
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case 'u':
                        if (i + 4 >= raw.length()) throw new IllegalArgumentException("truncated \\u escape");
                        out.append((char) Integer.parseInt(raw.substring(i + 1, i + 5), 16));
                        i += 4;
                        break;
                    default: throw new IllegalArgumentException("invalid escape \\" + next);
                }
            }
            return out.toString();
        }

        private Object numberValue() {
            int start = at;
            while (at < text.length()) {
                char c = text.charAt(at);
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') at++;
                else break;
            }
            if (start == at) throw new IllegalArgumentException("unexpected character '" + text.charAt(at) + "' at offset " + at);
            String slice = text.substring(start, at);
            try {
                if (slice.indexOf('.') < 0 && slice.indexOf('e') < 0 && slice.indexOf('E') < 0) {
                    return Long.parseLong(slice);
                }
                return Double.parseDouble(slice);
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException("invalid number " + slice);
            }
        }

        private void expect(String literal) {
            if (!text.startsWith(literal, at)) throw new IllegalArgumentException("expected " + literal + " at offset " + at);
            at += literal.length();
        }
    }
}
