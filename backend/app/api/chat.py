from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from typing import Any

import httpx

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, model_validator

from app.database import SessionLocal
from app.models import ChatMessage, Conversation

router = APIRouter()

DEEPSEEK_CHAT_URL = "https://api.deepseek.com/v1/chat/completions"
DEEPSEEK_MODEL_ID = "deepseek-chat"


def _extract_delta_content(chunk: dict[str, Any]) -> str:
    choices = chunk.get("choices") or []

    if not choices:
        return ""

    delta = choices[0].get("delta") or {}

    piece = delta.get("content")

    return piece if isinstance(piece, str) else ""


class DeepseekChatRequest(BaseModel):
    message: str | None = None

    messages: list[dict[str, Any]] | None = None

    stream: bool = False

    # 多轮对话：首次省略，后续请求带上服务端返回的 id
    conversation_id: int | None = None

    @model_validator(mode="after")
    def require_message_or_messages(self):
        has_message = (
            self.message is not None
            and str(self.message).strip() != ""
        )

        has_messages = (
            self.messages is not None
            and len(self.messages) > 0
        )

        if not has_message and not has_messages:
            raise ValueError("必须提供 message 或 messages")

        return self

    def to_api_messages(self):
        if self.message:
            return [
                {
                    "role": "user",
                    "content": self.message,
                }
            ]

        return list(self.messages or [])


async def _upstream_sse_lines(
    client: httpx.AsyncClient,
    payload: dict[str, Any],
    headers: dict[str, str],
) -> AsyncIterator[str]:

    async with client.stream(
        "POST",
        DEEPSEEK_CHAT_URL,
        json=payload,
        headers=headers,
    ) as response:

        if response.status_code >= 400:
            raw = (await response.aread()).decode(
                errors="replace"
            )

            raise HTTPException(
                status_code=response.status_code,
                detail=raw,
            )

        async for line in response.aiter_lines():
            if line is None:
                continue

            stripped = line.strip()

            if not stripped:
                continue

            yield stripped

@router.get("/conversations")
async def get_conversations():

    db = SessionLocal()

    conversations = (
        db.query(Conversation)
        .order_by(Conversation.created_at.desc())
        .all()
    )

    result = []

    for item in conversations:
        result.append(
            {
                "id": item.id,
                "title": item.title,
                "created_at": item.created_at,
            }
        )

    db.close()

    return result


@router.get("/conversations/{conversation_id}/messages")
async def get_conversation_messages(
    conversation_id: int
):

    db = SessionLocal()

    messages = (
        db.query(ChatMessage)
        .filter(
            ChatMessage.conversation_id
            == conversation_id
        )
        .order_by(ChatMessage.created_at)
        .all()
    )

    result = []

    for msg in messages:
        result.append(
            {
                "id": msg.id,
                "role": msg.role,
                "content": msg.content,
                "created_at": msg.created_at,
            }
        )

    db.close()

    return result


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id: int):
    db = SessionLocal()

    conversation = db.get(Conversation, conversation_id)

    if conversation is None:
        db.close()
        raise HTTPException(status_code=404, detail="会话不存在")

    db.query(ChatMessage).filter(
        ChatMessage.conversation_id == conversation_id
    ).delete()

    db.delete(conversation)

    db.commit()

    db.close()

    return {"message": "会话已删除"}


@router.post("/deepseek/chat")
async def deepseek_chat(body: DeepseekChatRequest):

    api_key = os.getenv("DEEPSEEK_API_KEY")

    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="DEEPSEEK_API_KEY 未设置",
        )

    messages = body.to_api_messages()

    db = SessionLocal()

    if body.conversation_id is not None:
        conversation = db.get(Conversation, body.conversation_id)
        if conversation is None:
            db.close()
            raise HTTPException(status_code=404, detail="会话不存在")
    else:
        first_text = str(messages[0].get("content", ""))[:255]
        conversation = Conversation(title=first_text or "新对话")
        db.add(conversation)
        db.commit()
        db.refresh(conversation)

    payload = {
        "model": DEEPSEEK_MODEL_ID,
        "messages": messages,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


    # 保存用户消息
    last_user_message = messages[-1]

    db.add(
        ChatMessage(
            conversation_id=conversation.id,
            role=last_user_message["role"],
            content=last_user_message["content"],
        )
    )

    db.commit()

    # =========================
    # 流式模式
    # =========================
    if body.stream:

        payload["stream"] = True

        async def normalize_stream():

            full_content = ""

            meta = json.dumps(
                {"conversation_id": conversation.id},
                ensure_ascii=False,
            )
            yield f"data: {meta}\n\n"

            async with httpx.AsyncClient(
                timeout=120.0
            ) as client:

                try:
                    async for stripped in _upstream_sse_lines(
                        client,
                        payload,
                        headers,
                    ):

                        if not stripped.startswith("data:"):
                            continue

                        raw = stripped[5:].strip()

                        if raw == "[DONE]":

                            # 保存 AI 回复
                            if full_content:
                                db.add(
                                    ChatMessage(
                                        conversation_id=conversation.id,
                                        role="assistant",
                                        content=full_content,
                                    )
                                )

                                db.commit()

                            yield "data: [DONE]\n\n"

                            return

                        try:
                            upstream_obj = json.loads(raw)

                        except json.JSONDecodeError:
                            continue

                        piece = _extract_delta_content(
                            upstream_obj
                        )

                        if piece:

                            full_content += piece

                            out = json.dumps(
                                {"content": piece},
                                ensure_ascii=False,
                            )

                            yield f"data: {out}\n\n"

                except httpx.RequestError as exc:

                    err = json.dumps(
                        {"error": str(exc)},
                        ensure_ascii=False,
                    )

                    yield f"data: {err}\n\n"

                finally:
                    db.close()

        return StreamingResponse(
            normalize_stream(),
            media_type="text/event-stream",
        )

    # =========================
    # 非流式模式
    # =========================
    try:
        async with httpx.AsyncClient(
            timeout=120.0
        ) as client:

            response = await client.post(
                DEEPSEEK_CHAT_URL,
                json=payload,
                headers=headers,
            )

        if response.status_code >= 400:
            try:
                detail = response.json()
            except Exception:
                detail = response.text
            raise HTTPException(
                status_code=response.status_code,
                detail=detail,
            )

        data = response.json()

        content = (
            data.get("choices", [{}])[0]
            .get("message", {})
            .get("content")
        )

        if content:
            db.add(
                ChatMessage(
                    conversation_id=conversation.id,
                    role="assistant",
                    content=content,
                )
            )
            db.commit()

        return {
            "reply": content,
            "conversation_id": conversation.id,
        }
    finally:
        db.close()