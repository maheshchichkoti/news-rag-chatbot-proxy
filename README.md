# 🧠 news-rag-proxy-service

A Node.js (Express) proxy service for the news-rag-chatbot ecosystem that manages sessions, routes queries, and stores chat history.

## 🧩 Architecture

```
Frontend ↔ news-rag-proxy-service ↔ news-rag-ml-service ↔ Qdrant, Gemini API, Transformers
                      │
            Redis (sessions + chat history)
```

## 🚀 Features

- **REST API** with clean routing and separation of concerns
- **Stateless Query Forwarding** to the ML service
- **Session Management** via Redis-backed sessions
- **Persistent Chat History** stored per user/session
- **Rate Limiting Ready** infrastructure for future API throttling

## 📦 Tech Stack

- Node.js
- Express.js
- Redis (via connect-redis and express-session)
- Axios for backend communication
- Dotenv for environment configuration

## ⚙️ Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/joshmathewsdev/news-rag-chatbot.git
   cd news-rag-chatbot/news-rag-proxy-service
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment**
   Create a `.env` file based on `.env.example`:

   ```
   PORT=3001
   SESSION_SECRET=yourSecretKey
   REDIS_URL=redis://localhost:6379
   ML_SERVICE_URL=http://localhost:8000
   ```

4. **Start the service**
   ```bash
   npm start
   ```

## 📘 API Reference

### POST /chat

Forwards user queries to the ML service.

**Request:**

```json
{
  "query": "Tell me the latest news about quantum computing."
}
```

**Response:**

```json
{
  "response": "Here's the latest on quantum computing..."
}
```

### GET /history

Retrieves the current session's chat history.

**Response:**

```json
{
  "history": [
    { "role": "user", "content": "Tell me about AI." },
    { "role": "assistant", "content": "Sure, here's what's happening in AI..." }
  ]
}
```

## 🧪 Development Notes

- This proxy handles no AI logic - all NLP/LLM operations are handled by news-rag-ml-service
- Use Postman or Insomnia for endpoint testing
- Consider adding request logging (e.g., morgan) for debugging

## 📌 Roadmap

- ✅ Initial version with Redis session store
- ⏳ Authentication middleware
- ⏳ Per-user rate limiting
- ⏳ Streaming response support

## 🔗 Related Projects

- **news-rag-ml-service** — FastAPI backend for vector search, Gemini API calls, and embedding logic
