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
app.use(cors());

// Redis client
let redisClient;
const connectRedis = async () => {
  try {
    redisClient = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    });

    redisClient.on("error", (err) => console.log("Redis Client Error", err));
    await redisClient.connect();
    console.log("Connected to Redis");
  } catch (error) {
    console.error("Failed to connect to Redis:", error);
  }
};
connectRedis();

// ML Service configuration
const ML_SERVICE_URL = process.env.ML_SERVICE_URL;
const ML_SERVICE_API_KEY = process.env.ML_SERVICE_API_KEY;

// Routes
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Proxy API is running" });
});

app.post("/session/new", (req, res) => {
  const sessionId = uuidv4();
  res.json({ session_id: sessionId, message: "New session created." });
});

app.post("/chat", async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId) {
      return res.status(400).json({ error: "X-Session-Id header is required" });
    }

    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }

    // Store user message in Redis
    const key = `chat_history:${sessionId}`;
    await redisClient.rPush(
      key,
      JSON.stringify({ role: "user", content: query })
    );

    // Forward to ML service
    const response = await axios.post(
      `${ML_SERVICE_URL}/generate`,
      { query, session_id: sessionId },
      {
        headers: {
          Authorization: `Bearer ${ML_SERVICE_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Store assistant response in Redis
    await redisClient.rPush(
      key,
      JSON.stringify({
        role: "assistant",
        content: response.data.response,
      })
    );

    // Set TTL for the chat history
    await redisClient.expire(key, 3600); // 1 hour

    res.json({ response: response.data.response });
  } catch (error) {
    console.error("Error in /chat endpoint:", error);
    res.status(500).json({
      error: "Error processing chat request",
      details: error.message,
    });
  }
});

app.get("/chat/history/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const key = `chat_history:${sessionId}`;

    const historyJsonList = await redisClient.lRange(key, 0, -1);
    const history = historyJsonList.map((item) => JSON.parse(item));

    res.json({ session_id: sessionId, history });
  } catch (error) {
    console.error("Error getting chat history:", error);
    res.status(500).json({ error: "Error retrieving chat history" });
  }
});

app.post("/chat/session/:sessionId/clear", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const key = `chat_history:${sessionId}`;

    await redisClient.del(key);

    res.json({
      session_id: sessionId,
      message: "Chat history cleared successfully.",
    });
  } catch (error) {
    console.error("Error clearing chat history:", error);
    res.status(500).json({ error: "Error clearing chat history" });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Proxy server running on port ${port}`);
});

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  if (redisClient) await redisClient.quit();
  process.exit(0);
});
