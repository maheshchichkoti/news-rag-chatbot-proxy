from fastapi import FastAPI, HTTPException, Request, Header
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import httpx
import os
import uuid
import redis.asyncio as redis
from typing import Dict, List, Optional, Any
import json

# Create minimal app without heavy imports
app = FastAPI(title="News RAG Chatbot API (Proxy)")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Replace with your frontend URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Redis for session management only
redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
redis_client = redis.from_url(redis_url, decode_responses=True)

# External service URL (Hugging Face Spaces, Replicate, etc.)
ML_SERVICE_URL = os.getenv("ML_SERVICE_URL")
ML_SERVICE_API_KEY = os.getenv("ML_SERVICE_API_KEY")

@app.get("/health")
async def health_check():
    return {"status": "ok", "message": "Proxy API is running"}

@app.post("/session/new")
async def create_new_session():
    session_id = str(uuid.uuid4())
    return {"session_id": session_id, "message": "New session created."}

@app.post("/chat")
async def proxy_chat(request: Request, x_session_id: Optional[str] = Header(None)):
    if not x_session_id:
        raise HTTPException(status_code=400, detail="X-Session-Id header is required")
    
    # Get request body
    body = await request.json()
    
    # Store in Redis
    key = f"chat_history:{x_session_id}"
    await redis_client.rpush(key, json.dumps({"role": "user", "content": body.get("query", "")}))
    
    # Forward to ML service
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{ML_SERVICE_URL}/generate",
                json={"query": body.get("query", ""), "session_id": x_session_id},
                headers={"Authorization": f"Bearer {ML_SERVICE_API_KEY}"}
            )
            
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail="ML service error")
            
            result = response.json()
            
            # Store response in Redis
            await redis_client.rpush(key, json.dumps({"role": "assistant", "content": result.get("response", "")}))
            await redis_client.expire(key, 3600)  # 1 hour TTL
            
            return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error communicating with ML service: {str(e)}")

@app.get("/chat/history/{session_id}")
async def get_session_history(session_id: str):
    key = f"chat_history:{session_id}"
    history_json_list = await redis_client.lrange(key, 0, -1)
    history = [json.loads(item_json) for item_json in history_json_list]
    return {"session_id": session_id, "history": history}

@app.post("/chat/session/{session_id}/clear")
async def clear_session_history(session_id: str):
    key = f"chat_history:{session_id}"
    await redis_client.delete(key)
    return {"session_id": session_id, "message": "Chat history cleared successfully."}