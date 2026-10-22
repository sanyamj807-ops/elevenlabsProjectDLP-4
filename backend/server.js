// ─────────────────────────────────────────────────────────────
//  ElevenLabs Narrator — Backend Server
//  Runs on http://localhost:3000
//
//  Routes
//  ──────
//  GET  /api/health   → liveness check
//  GET  /api/models   → TTS-capable ElevenLabs models (id + name)
//  GET  /api/voices   → available voices (id + name)
//  POST /api/speak    → text → MP3 audio stream (Rate-limited: 10 req / min / IP)
//  POST /api/narrate  → alias to /api/speak
//
//  Security summary (see inline comments for detail)
//  ──────────────────────────────────────────────────
//  [S1] ELEVENLABS_API_KEY is only in process.env; server exits if missing
//  [S2] CORS is restricted to localhost:3000 / 127.0.0.1:3000
//  [S3] safeLog() logs only err.message — never err.config or err.response
//       (those objects carry the xi-api-key header and must never be logged)
//  [S4] classifyElevenLabsError() maps every upstream error to a safe string
//  [S5] Rate limiter on /api/narrate prevents quota abuse
//
//  Static files: ../frontend/ is served at /
// ─────────────────────────────────────────────────────────────

// path is a built-in Node module — load it first so dotenv can use __dirname.
const path = require("path");

// Load ELEVENLABS_API_KEY from backend/.env into process.env.
// We pass an explicit path so this works whether node is invoked from
// inside backend/ or from the project root (via `npm start`).
require("dotenv").config({ path: path.join(__dirname, ".env") });

// ── [S1] Startup key guard ────────────────────────────────────
// Fail fast if the key is missing so the developer gets a clear message.
// We print the name of the variable but NEVER its value.
if (!process.env.ELEVENLABS_API_KEY) {
  console.error(
    "\n❌  ELEVENLABS_API_KEY is not set — server cannot start.\n" +
    "    Fix:\n" +
    "      1. Copy  backend/.env.example  →  backend/.env\n" +
    "      2. Replace the placeholder value with your real key\n" +
    "      3. Restart with  npm start\n"
  );
  process.exit(1); // non-zero exit signals failure to any process manager
}

const express   = require("express");
const cors      = require("cors");
const axios     = require("axios");
const rateLimit = require("express-rate-limit");
// path is already required at the top of this file

const app  = express();
const PORT = 3000;

const ELEVENLABS_API  = "https://api.elevenlabs.io/v1";
const MAX_TEXT_LENGTH = 5000;


// ═════════════════════════════════════════════════════════════
//  [S2] CORS — restrict to our own frontend origin
//
//  Because the Express server also serves the frontend on :3000,
//  normal page usage is same-origin and CORS headers are not
//  even sent.  The restriction below blocks any other origin
//  (e.g. a different port, a third-party site) from calling
//  our API routes.
// ═════════════════════════════════════════════════════════════
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000", // some browsers use 127.0.0.1 instead of localhost
];

app.use(cors({
  // origin can be undefined (same-origin / curl) — allow it.
  // Any other value must be in ALLOWED_ORIGINS.
  origin(requestOrigin, callback) {
    if (!requestOrigin || ALLOWED_ORIGINS.includes(requestOrigin)) {
      return callback(null, true);
    }
    // Do NOT include the rejected origin in the error — no information leak
    callback(new Error("CORS policy: request origin not allowed"));
  },
  methods:        ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

// Parse incoming JSON request bodies
app.use(express.json());

// Serve the frontend/ folder as static files at the root URL
app.use(express.static(path.join(__dirname, "..", "frontend")));


// ═════════════════════════════════════════════════════════════
//  [S5] Rate limiter for POST /api/narrate
//
//  Each narration call consumes ElevenLabs character quota and
//  takes compute time.  We cap at 10 calls per IP per minute.
//  The limit is enforced before the route handler runs.
// ═════════════════════════════════════════════════════════════
const narrateRateLimiter = rateLimit({
  windowMs:        60 * 1000, // 1-minute sliding window
  max:             10,         // max 10 requests per window per IP
  standardHeaders: true,       // add standard RateLimit-* headers to responses
  legacyHeaders:   false,      // omit old X-RateLimit-* headers
  // This object is sent as JSON when the limit is exceeded.
  // It intentionally contains no internal information.
  message: {
    error: "Too many narration requests. Please wait a minute and try again.",
  },
});


// ═════════════════════════════════════════════════════════════
//  HELPERS
// ═════════════════════════════════════════════════════════════

/**
 * Returns auth headers for every ElevenLabs API call.
 * The key lives only here, read from process.env.
 * This function is never called from the frontend — it only runs
 * inside server.js on the Node.js process.
 */
function elevenlabsHeaders() {
  return {
    "xi-api-key":   process.env.ELEVENLABS_API_KEY,
    "Content-Type": "application/json",
  };
}

/**
 * [S3] Safe error logger.
 *
 * IMPORTANT — why this exists:
 *   An axios error object (err) contains err.config, which holds the full
 *   request configuration including all HTTP headers.  That means:
 *
 *     console.error(err)            // ❌ dumps err.config → leaks xi-api-key
 *     console.error(err.response)   // ❌ same — response.config present
 *     console.error(err.stack)      // ✅ safe (stack trace, no headers)
 *     console.error(err.message)    // ✅ safe ("Request failed with status 401")
 *
 *   This helper logs ONLY err.message so there is no accidental key exposure
 *   regardless of how this function is called.
 *
 * @param {string} context - Short label for which route triggered the error
 * @param {Error}  err     - The caught error (typically an axios error)
 */
function safeLog(context, err) {
  // err.message is always a plain string with no headers or config embedded
  console.error(`[${context}] ${err.message}`);
}

/**
 * [S4] Converts an upstream ElevenLabs API error into a safe,
 * user-facing message.  The returned message:
 *   • never contains the API key
 *   • never contains raw response bodies or internal paths
 *   • gives actionable guidance to the developer/user
 *
 * @param {Error} err - axios error from an ElevenLabs call
 * @returns {{ status: number, message: string }}
 */
function classifyElevenLabsError(err) {
  const httpStatus = err.response?.status;

  // ── 401 Unauthorized ──────────────────────────────────────
  if (httpStatus === 401) {
    return {
      status:  401,
      message: "Authentication failed. Please check that a valid ElevenLabs API key is set in backend/.env.",
    };
  }

  // ── 429 Too Many Requests ─────────────────────────────────
  if (httpStatus === 429) {
    // ElevenLabs returns quota exhaustion as 429 with a detail string.
    // We stringify only to check for keywords — this value is never forwarded.
    const detail = JSON.stringify(err.response?.data ?? "").toLowerCase();
    if (detail.includes("quota") || detail.includes("limit")) {
      return {
        status:  429,
        message: "Character quota exhausted for this billing period. Upgrade your ElevenLabs plan or wait for the next billing reset.",
      };
    }
    return {
      status:  429,
      message: "Rate limit reached. Please wait a moment and try again.",
    };
  }

  // ── 422 Unprocessable Entity ──────────────────────────────
  // Typically means a bad voiceId or modelId was sent.
  if (httpStatus === 422) {
    return {
      status:  422,
      message: "Invalid voice or model ID. Please refresh the page and try again.",
    };
  }

  // ── All other errors ──────────────────────────────────────
  // Log safely (err.message only — no config/headers) and return generic text.
  safeLog("ElevenLabs error", err);
  return {
    status:  500,
    message: "An unexpected error occurred. Check the server logs for details.",
  };
}


// ═════════════════════════════════════════════════════════════
//  ROUTE 1 — GET /api/health
//  Quick liveness check: curl http://localhost:3000/api/health
// ═════════════════════════════════════════════════════════════
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", message: "ElevenLabs Narrator is running" });
});


// ═════════════════════════════════════════════════════════════
//  ROUTE 2 — GET /api/models
//  Fetches all ElevenLabs models and returns only those that
//  support text-to-speech, shaped as { id, name }.
// ═════════════════════════════════════════════════════════════
app.get("/api/models", async (_req, res) => {
  try {
    const response = await axios.get(`${ELEVENLABS_API}/models`, {
      headers: elevenlabsHeaders(),
    });

    const models = response.data
      .filter((m) => m.can_do_text_to_speech === true)
      .map((m) => ({ id: m.model_id, name: m.name }));

    res.json({ models });
  } catch (err) {
    const { status, message } = classifyElevenLabsError(err);
    res.status(status).json({ error: message });
  }
});


// ═════════════════════════════════════════════════════════════
//  ROUTE 3 — GET /api/voices
//  Returns all available voices shaped as { id, name }.
//  No voice settings, preview URLs, or account details are
//  forwarded — only what the frontend actually needs.
// ═════════════════════════════════════════════════════════════
app.get("/api/voices", async (_req, res) => {
  try {
    const response = await axios.get(`${ELEVENLABS_API}/voices`, {
      headers: elevenlabsHeaders(),
    });

    const voices = response.data.voices.map((v) => ({
      id:   v.voice_id,
      name: v.name,
    }));

    res.json({ voices });
  } catch (err) {
    const { status, message } = classifyElevenLabsError(err);
    res.status(status).json({ error: message });
  }
});


// ═════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════
//  ROUTE 4 — POST /api/speak (and alias POST /api/narrate)
//  Body: { text: string, modelId: string, voiceId: string }
//  Returns: audio/mpeg stream
//  Rate-limited: 10 requests / min / IP
//
//  voice_settings:
//    stability:        0.50 → natural delivery with slight variation
//    similarity_boost: 0.75 → faithful to the original voice timbre
//    style:            0.15 → expressive nuance
//    use_speaker_boost: true → audio clarity enhancement
// ═════════════════════════════════════════════════════════════
async function handleSpeak(req, res) {
  const { text, modelId, voiceId } = req.body || {};

  // ── Input validation ──────────────────────────────────────
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "Text cannot be empty." });
  }
  if (!modelId || typeof modelId !== "string" || !modelId.trim()) {
    return res.status(400).json({ error: "modelId is required." });
  }
  if (!voiceId || typeof voiceId !== "string" || !voiceId.trim()) {
    return res.status(400).json({ error: "voiceId is required." });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({
      error: `Text must be ${MAX_TEXT_LENGTH.toLocaleString()} characters or fewer (you sent ${text.length.toLocaleString()}).`,
    });
  }

  // ── Call ElevenLabs TTS ───────────────────────────────────
  try {
    const ttsResponse = await axios.post(
      `${ELEVENLABS_API}/text-to-speech/${voiceId}`,
      {
        text,
        model_id: modelId,
        voice_settings: {
          stability:         0.50,
          similarity_boost:  0.75,
          style:             0.15,
          use_speaker_boost: true,
        },
      },
      {
        headers: {
          ...elevenlabsHeaders(),
          Accept: "audio/mpeg",
        },
        responseType: "stream", // receive binary MP3 as a Node.js readable stream
      }
    );

    // Forward audio content-type so the browser can decode it correctly
    res.setHeader("Content-Type", "audio/mpeg");

    // Pipe the ElevenLabs stream directly into the HTTP response.
    // This avoids buffering the whole MP3 in memory.
    ttsResponse.data.pipe(res);

    // Handle mid-stream errors from the ElevenLabs side
    ttsResponse.data.on("error", (streamErr) => {
      safeLog("stream error", streamErr); // [S3] never logs request headers
      if (!res.headersSent) {
        res.status(500).json({ error: "Audio stream interrupted." });
      }
    });

  } catch (err) {
    // Only send a JSON error if we haven't started piping audio yet
    if (!res.headersSent) {
      const { status, message } = classifyElevenLabsError(err);
      res.status(status).json({ error: message });
    }
  }
}

// POST /api/speak is the primary TTS endpoint
app.post("/api/speak", narrateRateLimiter, handleSpeak);

// POST /api/narrate kept as an alias for backwards compatibility
app.post("/api/narrate", narrateRateLimiter, handleSpeak);


// ═════════════════════════════════════════════════════════════
//  START
// ═════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n✅ ElevenLabs Narrator is running`);
  console.log(`   Frontend  → http://localhost:${PORT}`);
  console.log(`   Health    → http://localhost:${PORT}/api/health`);
  console.log(`   CORS      → ${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`   Rate limit → 10 narrations / min / IP\n`);
});
