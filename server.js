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
app.use(cors()); // Allows all origins by default

// Redis client
let redisClient;
const connectRedis = async () => {
  try {
    redisClient = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    });

    redisClient.on("error", (err) => console.error("Redis Client Error:", err)); // Changed to console.error
    await redisClient.connect();
    console.log("Connected to Redis");
  } catch (error) {
    console.error("Failed to connect to Redis:", error);
    // Consider if the app should exit or run in a degraded state if Redis is critical
  }
};
connectRedis();

// ML Service configuration
const ML_SERVICE_URL = process.env.ML_SERVICE_URL;
const ML_SERVICE_API_KEY = process.env.ML_SERVICE_API_KEY;

if (!ML_SERVICE_URL || !ML_SERVICE_API_KEY) {
  console.warn(
    "ML_SERVICE_URL or ML_SERVICE_API_KEY is not set. /chat endpoint will likely fail."
  );
}

// Routes
app.get("/health", (req, res) => {
  const redisReady = redisClient && redisClient.isReady;
  res.json({
    status: "ok",
    message: "Proxy API is running",
    redis_status: redisReady ? "connected" : "disconnected_or_error",
  });
});

app.post("/session/new", (req, res) => {
  const sessionId = uuidv4();
  res.json({ session_id: sessionId, message: "New session created." });
});

app.post("/chat", async (req, res) => {
  try {
    // console.log("Received chat request:", req.body); // Good for debugging, can be verbose
    // console.log("Session ID:", req.headers["x-session-id"]);

    const sessionId = req.headers["x-session-id"];
    if (!sessionId) {
      return res.status(400).json({ error: "X-Session-Id header is required" });
    }

    const { query } = req.body;
    if (!query || typeof query !== "string" || query.trim() === "") {
      // Added more validation
      return res
        .status(400)
        .json({ error: "Query is required and must be a non-empty string" });
    }

    // Store user message in Redis
    const userMessageKey = `chat_history:${sessionId}`;
    if (redisClient && redisClient.isReady) {
      // Check if Redis client is connected
      try {
        await redisClient.rPush(
          userMessageKey,
          JSON.stringify({ role: "user", content: query })
        );
        console.log("Stored user message in Redis");
      } catch (redisError) {
        console.error("Redis error storing user message:", redisError);
        // Continue even if Redis fails for this operation
      }
    } else {
      console.warn("Redis not connected. User message not stored in history.");
    }

    // Forward to ML service
    console.log("Forwarding to ML service:", ML_SERVICE_URL);
    // session_id is marked as optional in the ML service QueryRequest, so sending it is fine.
    // If your ML service strictly doesn't use it, you could omit it.
    const mlPayload = { query, session_id: sessionId };
    console.log("Request payload to ML service:", mlPayload);

    const mlServiceResponse = await axios.post(
      `${ML_SERVICE_URL}/generate`,
      mlPayload,
      {
        headers: {
          Authorization: `Bearer ${ML_SERVICE_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000, // 30 second timeout for the ML service call
      }
    );

    console.log("ML service response status:", mlServiceResponse.status);
    // console.log("ML service response data:", mlServiceResponse.data); // Good for debugging

    let assistantContent = "";
    if (
      mlServiceResponse.data &&
      typeof mlServiceResponse.data.response === "string"
    ) {
      assistantContent = mlServiceResponse.data.response;
    } else {
      console.warn(
        "ML service response did not contain a 'response' string field. Using empty string for assistant content."
      );
      // Potentially return an error or a default message to frontend if this is unexpected
      // For now, we'll let it proceed, and it will store an empty assistant message.
    }

    // Store assistant response in Redis
    if (redisClient && redisClient.isReady) {
      // Check if Redis client is connected
      try {
        await redisClient.rPush(
          userMessageKey, // Use the same key
          JSON.stringify({
            role: "assistant",
            content: assistantContent,
          })
        );
        await redisClient.expire(userMessageKey, 3600); // 1 hour TTL
        console.log("Stored assistant response in Redis");
      } catch (redisError) {
        console.error("Redis error storing assistant response:", redisError);
        // Continue even if Redis fails
      }
    } else {
      console.warn(
        "Redis not connected. Assistant response not stored in history."
      );
    }

    // Return the response to the frontend.
    // App.tsx (non-streaming version) expects an object like { response: "text" }
    // The ML service returns { response: "text", relevant_sources: [] }
    // We will forward only the 'response' field as per App.tsx expectation.
    const frontendResponse = { response: assistantContent };
    console.log("Sending response to frontend:", frontendResponse);
    return res.json(frontendResponse);
  } catch (error) {
    console.error(
      "Error in /chat endpoint. Full error object:",
      JSON.stringify(error, Object.getOwnPropertyNames(error))
    ); // More detailed log
    let status = 500;
    let responseJson = {
      error: "Error processing chat request",
      details: error.message,
    };

    if (error.isAxiosError && error.response) {
      // Check if it's an Axios error with a response from ML service
      console.error("Axios error response from ML service:", {
        status: error.response.status,
        headers: error.response.headers,
        data: error.response.data,
      });
      status = error.response.status || 500;
      // Try to use the error structure from the ML service if it's JSON
      if (
        typeof error.response.data === "object" &&
        error.response.data !== null
      ) {
        responseJson = {
          error:
            error.response.data.detail ||
            error.response.data.error ||
            "ML Service Error",
          details: error.response.data, // Send the whole data object as details
          ml_service_status: error.response.status,
        };
      } else {
        // ML service error was not JSON or empty
        responseJson.details = `ML service responded with status ${
          error.response.status
        }: ${error.response.data || error.message}`;
      }
    } else if (error.code === "ECONNABORTED") {
      console.error("ML Service call timed out.");
      status = 504; // Gateway Timeout
      responseJson.error = "Request to ML service timed out.";
      responseJson.details = error.message;
    }

    // Ensure details are a string if they are not already an object for the final response
    if (
      typeof responseJson.details !== "string" &&
      typeof responseJson.details !== "object"
    ) {
      responseJson.details = String(responseJson.details);
    }

    console.error("Responding to client with error:", { status, responseJson });
    res.status(status).json(responseJson);
  }
});

app.get("/chat/history/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!redisClient || !redisClient.isReady) {
      console.warn("Redis not connected. Cannot fetch chat history.");
      return res
        .status(503)
        .json({ error: "Chat history service temporarily unavailable." });
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
      .filter((item) => item !== null); // Filter out any parsing errors

    res.json({ session_id: sessionId, history });
  } catch (error) {
    console.error("Error getting chat history:", error);
    res
      .status(500)
      .json({ error: "Error retrieving chat history", details: error.message });
  }
});

app.post("/chat/session/:sessionId/clear", async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!redisClient || !redisClient.isReady) {
      console.warn("Redis not connected. Cannot clear chat history.");
      return res
        .status(503)
        .json({ error: "Chat history service temporarily unavailable." });
    }
    const key = `chat_history:${sessionId}`;

    await redisClient.del(key);

    res.json({
      session_id: sessionId,
      message: "Chat history cleared successfully.",
    });
  } catch (error) {
    console.error("Error clearing chat history:", error);
    res
      .status(500)
      .json({ error: "Error clearing chat history", details: error.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Proxy server running on port ${port}`);
});

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down proxy server...");
  if (redisClient && redisClient.isReady) {
    // Check if connected before trying to quit
    try {
      await redisClient.quit();
      console.log("Redis client disconnected.");
    } catch (err) {
      console.error("Error quitting Redis client during shutdown:", err);
    }
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  // Also handle SIGTERM for graceful shutdown
  console.log("Shutting down proxy server (SIGTERM)...");
  if (redisClient && redisClient.isReady) {
    try {
      await redisClient.quit();
      console.log("Redis client disconnected.");
    } catch (err) {
      console.error(
        "Error quitting Redis client during shutdown (SIGTERM):",
        err
      );
    }
  }
  process.exit(0);
});
