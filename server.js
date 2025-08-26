require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { createClient } = require("redis");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// --- Configurable CORS (default: all origins, but restrict for production) ---
const allowedOrigins = (process.env.CORS_ORIGIN || "*").split(",");
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// Redis client
let redisClient;
const connectRedis = async () => {
  try {
    redisClient = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    });

    redisClient.on("error", (err) => console.error("Redis Client Error:", err));
    await redisClient.connect();
    console.log("✅ Connected to Redis");
  } catch (error) {
    console.error("❌ Failed to connect to Redis:", error);
  }
};
connectRedis();

// ML Service configuration
const ML_SERVICE_URL = process.env.ML_SERVICE_URL;
const ML_SERVICE_API_KEY = process.env.ML_SERVICE_API_KEY;
if (!ML_SERVICE_URL || !ML_SERVICE_API_KEY) {
  console.warn("⚠️ ML_SERVICE_URL or ML_SERVICE_API_KEY is not set.");
}

// Configurable Redis TTL
const CHAT_TTL_SECONDS = parseInt(process.env.CHAT_TTL_SECONDS || "86400", 10); // default 24 hours

// ─────────────────────────── ROUTES ───────────────────────────

// Health
app.get("/health", (req, res) => {
  const redisReady = redisClient && redisClient.isReady;
  res.json({
    status: "ok",
    message: "Proxy API is running",
    redis_status: redisReady ? "connected" : "disconnected_or_error",
  });
});

// Session creation
app.post("/session/new", (req, res) => {
  const sessionId = uuidv4();
  res.json({ session_id: sessionId, message: "New session created." });
});

// Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId) {
      return res.status(400).json({ error: "X-Session-Id header is required" });
    }

    const { query } = req.body;
    if (!query || typeof query !== "string" || query.trim() === "") {
      return res
        .status(400)
        .json({ error: "Query is required and must be a non-empty string" });
    }

    const userMessageKey = `chat_history:${sessionId}`;

    // ▸ Save user query in Redis
    if (redisClient && redisClient.isReady) {
      try {
        await redisClient.rPush(
          userMessageKey,
          JSON.stringify({ role: "user", content: query })
        );
      } catch (e) {
        console.error("Redis store user message error:", e);
      }
    }

    // ▸ Forward to ML service
    const mlPayload = { query, session_id: sessionId };
    const mlServiceResponse = await axios.post(
      `${ML_SERVICE_URL}/generate`,
      mlPayload,
      {
        headers: {
          Authorization: `Bearer ${ML_SERVICE_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    let assistantContent =
      mlServiceResponse.data?.response ||
      "⚠️ No response generated. Please try again.";
    let relevantSources = Array.isArray(
      mlServiceResponse.data?.relevant_sources
    )
      ? mlServiceResponse.data.relevant_sources
      : [];

    // ▸ Save assistant response (with sources) in Redis
    if (redisClient && redisClient.isReady) {
      try {
        await redisClient.rPush(
          userMessageKey,
          JSON.stringify({
            role: "assistant",
            content: assistantContent,
            sources: relevantSources,
          })
        );
        await redisClient.expire(userMessageKey, CHAT_TTL_SECONDS);
      } catch (e) {
        console.error("Redis store assistant response error:", e);
      }
    }

    // ▸ Return to frontend (message + sources)
    const frontendResponse = {
      response: assistantContent,
      sources: relevantSources,
    };
    return res.json(frontendResponse);
  } catch (error) {
    const status = error.response?.status || 500;
    const details =
      error.response?.data ||
      error.message ||
      "Unexpected error in proxy /chat";
    console.error("Error in /chat:", details);
    return res.status(status).json({ error: "ML Service Error", details });
  }
});

// Chat history
app.get("/chat/history/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!redisClient || !redisClient.isReady) {
      return res
        .status(503)
        .json({ error: "Chat history service unavailable" });
    }
    const key = `chat_history:${sessionId}`;
    const historyJsonList = await redisClient.lRange(key, 0, -1);
    const history = historyJsonList
      .map((item) => {
        try {
          return JSON.parse(item);
        } catch {
          return null;
        }
      })
      .filter((i) => i);
    res.json({ session_id: sessionId, history });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Error retrieving chat history", details: e.message });
  }
});

// Clear chat
app.post("/chat/session/:sessionId/clear", async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!redisClient || !redisClient.isReady) {
      return res
        .status(503)
        .json({ error: "Chat history service unavailable" });
    }
    const key = `chat_history:${sessionId}`;
    await redisClient.del(key);
    res.json({ session_id: sessionId, message: "Chat history cleared" });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Error clearing chat history", details: e.message });
  }
});

// ─────────────────────────── SERVER ───────────────────────────
app.listen(port, () => {
  console.log(`🚀 Proxy server running on port ${port}`);
});

process.on("SIGINT", async () => {
  console.log("🛑 Shutting down proxy...");
  if (redisClient?.isReady) await redisClient.quit();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("🛑 Shutting down proxy (SIGTERM)...");
  if (redisClient?.isReady) await redisClient.quit();
  process.exit(0);
});
