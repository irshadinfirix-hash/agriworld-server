const express = require("express");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");
const os = require("os");
const fs = require("fs");
const path = require("path");

dotenv.config();

const app = express();

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const MODEL = process.env.MODEL || "google/gemini-2.5-flash";
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "openai/gpt-4o-mini";
const RESPONSE_LANG = (process.env.LANG || "ur").toLowerCase();
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90000;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

// ==========================================
// MIDDLEWARE
// ==========================================

app.use(cors());
app.use(express.json());

// ==========================================
// UPLOAD FOLDER
// ==========================================

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ==========================================
// MULTER CONFIGURATION
// ==========================================

const imageFilter = (req, file, cb) => {
    const allowed = [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/bmp",
        "image/gif"
    ];

    const ext = path.extname(file.originalname || "").toLowerCase();
    const allowedExt = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"];

    if (allowed.includes(file.mimetype) || allowedExt.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error("Only image files are accepted."));
    }
};

const upload = multer({
    dest: UPLOAD_DIR,
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: 1
    },
    fileFilter: imageFilter
});

// ==========================================
// CLEANUP OLD UPLOADS
// ==========================================

function cleanupOldUploads() {
    try {
        const now = Date.now();

        fs.readdirSync(UPLOAD_DIR).forEach((file) => {
            const filePath = path.join(UPLOAD_DIR, file);

            try {
                const stat = fs.statSync(filePath);

                if (stat.isFile() && (now - stat.mtimeMs) > UPLOAD_MAX_AGE_MS) {
                    fs.unlinkSync(filePath);
                    console.log(`Cleaned up old upload: ${file}`);
                }
            } catch (e) {
                // skip files that disappear
            }
        });
    } catch (e) {
        console.error("Upload cleanup error:", e.message);
    }
}

// ==========================================
// LAN ADDRESS HELPERS
// ==========================================

function getLanAddresses() {
    const addresses = [];
    const interfaces = os.networkInterfaces();

    Object.keys(interfaces).forEach((name) => {
        (interfaces[name] || []).forEach((net) => {
            if (net.family === "IPv4" && !net.internal) {
                addresses.push({ name, address: net.address });
            }
        });
    });

    return addresses;
}

// ==========================================
// HOME / SERVER TEST
// ==========================================

app.get("/", (req, res) => {
    res.json({
        status: "online",
        message: "Agri World AI Server is running",
        endpoint: "/analyze-crop",
        model: MODEL,
        language: RESPONSE_LANG === "ur" ? "urdu" : "english"
    });
});

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/health", (req, res) => {
    const apiKey = process.env.OPENROUTER_API_KEY;

    res.json({
        status: "ok",
        uptime: Math.round(process.uptime()),
        uploadCount: fs.existsSync(UPLOAD_DIR)
            ? fs.readdirSync(UPLOAD_DIR).filter((f) => path.extname(f)).length
            : 0,
        aiConfigured: Boolean(apiKey),
        model: MODEL,
        language: RESPONSE_LANG === "ur" ? "urdu" : "english"
    });
});

// ==========================================
// AI CROP ANALYSIS
// ==========================================

app.post("/analyze-crop", (req, res) => {
    upload.single("image")(req, res, async (uploadError) => {
        let imagePath = null;

        try {
            console.log("");
            console.log("=================================");
            console.log("NEW CROP ANALYSIS REQUEST");
            console.log("=================================");

            if (uploadError) {
                console.log("UPLOAD ERROR:", uploadError.message);

                return res.status(400).json({
                    success: false,
                    error: uploadError.message
                });
            }

            if (!req.file) {
                console.log("ERROR: No image received.");

                return res.status(400).json({
                    success: false,
                    error: "No crop image received."
                });
            }

            imagePath = req.file.path;

            console.log("Image received:", req.file.originalname);
            console.log("Image size:", req.file.size, "bytes");

            const apiKey = process.env.OPENROUTER_API_KEY;

            if (!apiKey) {
                console.log("ERROR: OPENROUTER_API_KEY missing.");

                return res.status(500).json({
                    success: false,
                    error: "OpenRouter API key is missing."
                });
            }

            const imageBuffer = fs.readFileSync(imagePath);
            const base64Image = imageBuffer.toString("base64");
            const mimeType = req.file.mimetype || "image/jpeg";
            const imageDataUrl = `data:${mimeType};base64,${base64Image}`;

            // --------------------------------------
            // LANGUAGE (form field "lang" or LANG env)
            // --------------------------------------

            const requestedLang = String(
                req.body?.lang || req.query?.lang || RESPONSE_LANG
            ).toLowerCase();

            const lang = requestedLang.startsWith("en") ? "en" : "ur";

            console.log("Response language:", lang);

            // --------------------------------------
            // AI PROMPT
            // --------------------------------------

            const languageRules =
                lang === "en"
                    ? `LANGUAGE: Respond in ENGLISH.`
                    : `LANGUAGE: Respond in URDU (اردو) only. Write every field value in URDU script (Arabic letters).

Guidance for Urdu output:
- "crop": use the common local Urdu name, e.g. "گندم" (wheat), "چاول" (rice), "ٹماٹر" (tomato), "کپاس" (cotton). If you are unsure of the Urdu name, keep the English crop name.
- "disease": Urdu disease name, e.g. "زنگ", "پاؤڈری پھپھوندی", "جھلساؤ".
- "severity": use "کم", "درمیانہ", or "شدید".
- "confidence": a short Urdu phrase or percentage, e.g. "95% اعتماد".
- "symptoms", "treatment", "prevention", "warning": simple, farmer-friendly URDU sentences.`;

            const prompt = `
You are Agri World AI, an agricultural crop analysis assistant.

Analyze the uploaded crop or plant image carefully.

Identify:

1. Crop name
2. Disease, pest, nutrient deficiency, or healthy condition
3. Severity
4. Confidence
5. Visible symptoms
6. Treatment guidance
7. Prevention advice

${languageRules}

IMPORTANT RULES:

- Do not claim certainty when the image is unclear.
- If the crop cannot be identified, use "Unknown".
- If disease cannot be identified reliably, use "Unable to determine".
- Do not invent symptoms.
- Keep advice simple and farmer-friendly.
- For pesticide or fungicide recommendations, advise the farmer to use only locally registered products and follow the product label.
- If the image quality is poor, clearly mention that a clearer image is needed.
- Respond with ONLY the JSON object. Do not use markdown code fences, comments, or extra text.

Return exactly this JSON format:

{
  "crop": "",
  "disease": "",
  "severity": "",
  "confidence": "",
  "symptoms": "",
  "treatment": "",
  "prevention": "",
  "warning": ""
}
`;

            // --------------------------------------
            // OPENROUTER REQUEST (WITH FALLBACK)
            // --------------------------------------

            let data;
            let usedModel;

            try {
                usedModel = MODEL;
                data = await analyzeWithModel(apiKey, usedModel, prompt, imageDataUrl);
            } catch (primaryError) {
                console.log("Primary model failed, trying fallback...");
                console.log("Primary error:", primaryError.message);

                try {
                    usedModel = FALLBACK_MODEL;
                    data = await analyzeWithModel(apiKey, usedModel, prompt, imageDataUrl);
                } catch (fallbackError) {
                    deleteTemporaryImage(imagePath);

                    return res.status(500).json({
                        success: false,
                        error: "AI provider is unavailable. Please try again later.",
                        detail: fallbackError.message
                    });
                }
            }

            // --------------------------------------
            // GET AI RESPONSE
            // --------------------------------------

            let aiText =
                data?.choices?.[0]?.message?.content ||
                "";

            if (Array.isArray(aiText)) {
                aiText = aiText.map((block) => block?.text || "").join("");
            }

            console.log("");
            console.log("AI RESPONSE (" + usedModel + "):");
            console.log(String(aiText).slice(0, 4000));
            console.log("");

            // --------------------------------------
            // CLEAN MARKDOWN
            // --------------------------------------

            aiText = String(aiText)
                .replace(/```json/gi, "")
                .replace(/```/g, "")
                .replace(/^\{/, "{")
                .split("```")[0]
                .trim();

            // --------------------------------------
            // PARSE JSON
            // --------------------------------------

            let result;

            try {
                result = JSON.parse(aiText);
            } catch (error) {
                console.error("JSON Parse Error:", error.message);
                console.error("Raw text:", aiText);

                const fallback = extractJson(aiText);

                if (fallback) {
                    result = fallback;
                } else {
                    result = {
                        crop: "Unknown",
                        disease: "Unable to determine",
                        severity: "Unknown",
                        confidence: "Low",
                        symptoms: "AI returned an unexpected response.",
                        treatment: "Please try again with a clearer crop image.",
                        prevention: "Take a clear photo of the affected plant.",
                        warning: "The AI response could not be interpreted."
                    };
                }
            }

            deleteTemporaryImage(imagePath);

            console.log("Sending AI result to Unity...");

            res.json({
                success: true,
                result: {
                    crop: result.crop || "Unknown",
                    disease: result.disease || "Unable to determine",
                    severity: result.severity || "Unknown",
                    confidence: result.confidence || "Unknown",
                    symptoms: result.symptoms || "No symptoms available.",
                    treatment: result.treatment || "Please consult an agricultural expert.",
                    prevention: result.prevention || "Regularly inspect the crop.",
                    warning: result.warning || ""
                }
            });

            console.log("Analysis completed successfully.");
            console.log("=================================");
        } catch (error) {
            console.error("");
            console.error("SERVER ERROR:");
            console.error(error);
            console.error("");

            if (imagePath) {
                deleteTemporaryImage(imagePath);
            }

            res.status(500).json({
                success: false,
                error: error.message || "Internal server error."
            });
        }
    });
});

// ==========================================
// OPENROUTER REQUEST
// ==========================================

async function analyzeWithModel(apiKey, model, prompt, imageDataUrl) {
    const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://localhost:3000",
                "X-Title": "Agri World AI"
            },
            body: JSON.stringify({
                model: model,
                max_tokens: 1000,
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: prompt },
                            { type: "image_url", image_url: { url: imageDataUrl } }
                        ]
                    }
                ]
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        }
    );

    const data = await response.json();

    console.log("OpenRouter status:", response.status, "model:", model);

    if (!response.ok) {
        const message =
            data?.error?.message ||
            "OpenRouter request failed.";

        throw new Error(`${message} (${data?.error?.code || response.status})`);
    }

    if (!data?.choices?.length) {
        throw new Error("AI returned no choices.");
    }

    return data;
}

// ==========================================
// EXTRACT JSON FROM NOISY TEXT
// ==========================================

function extractJson(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
        return null;
    }

    try {
        return JSON.parse(text.substring(start, end + 1));
    } catch (e) {
        return null;
    }
}

// ==========================================
// DELETE TEMPORARY IMAGE
// ==========================================

function deleteTemporaryImage(filePath) {
    if (!filePath) {
        return;
    }

    fs.unlink(filePath, (error) => {
        if (error) {
            console.log("Could not delete temporary image:", error.message);
        }
    });
}

// ==========================================
// START SERVER
// ==========================================

cleanupOldUploads();
setInterval(cleanupOldUploads, CLEANUP_INTERVAL_MS);

app.listen(PORT, HOST, () => {
    console.log("");
    console.log("=================================");
    console.log("       AGRI WORLD AI SERVER");
    console.log("=================================");
    console.log("");
    console.log("Server running:");
    console.log(`http://localhost:${PORT}`);
    console.log("");
    console.log("=== MOBILE (LAN) ACCESS ===");
    console.log("Use these URLs on your phone (same Wi-Fi):");
    const lan = getLanAddresses();

    if (lan.length === 0) {
        console.log("  No LAN IP found. Connect to Wi-Fi first.");
    } else {
        lan.forEach((n) => {
            console.log(`  App Server URL : http://${n.address}:${PORT}`);
            console.log(`  Health check   : http://${n.address}:${PORT}/health`);
        });
    }

    console.log("");
    console.log("Health check:");
    console.log(`http://localhost:${PORT}/health`);
    console.log("");
    console.log("AI endpoint:");
    console.log(`http://localhost:${PORT}/analyze-crop`);
    console.log("");
    console.log("Primary model:", MODEL);
    console.log("Fallback model:", FALLBACK_MODEL);
    console.log("Response language:", RESPONSE_LANG === "ur" ? "Urdu" : "English");
    console.log("");
    console.log("Waiting for crop images...");
    console.log("");
});