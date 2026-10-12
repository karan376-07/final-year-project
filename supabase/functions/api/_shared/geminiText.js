/**
 * Raw Gemini text generation, shared by the OCR path.
 *
 * Kept separate from gemini.ts because that module deals only in structured
 * output while the document summariser needs prose. Both funnel through the
 * same client and the same failure handling: null means "unavailable", and
 * every caller has a deterministic fallback.
 */
// deno-lint-ignore no-import-prefix
import { GoogleGenAI } from "npm:@google/genai@1";
import { config } from "./config.js";
import { logger } from "./log.js";
let client = null;
export async function askGeminiForText(prompt) {
    if (!config.GEMINI_API_KEY)
        return null;
    if (!client)
        client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    try {
        const res = await client.models.generateContent({
            model: config.GEMINI_MODEL,
            contents: prompt,
        });
        const text = res.text?.trim();
        return text && text.length ? text : null;
    }
    catch (err) {
        logger.warn({ msg: "gemini text failed", error: err.message });
        return null;
    }
}
