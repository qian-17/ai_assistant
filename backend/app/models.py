from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from datetime import datetime

from app.database import Base


# 会话表
class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True)

    title = Column(String(255), nullable=False)

    created_at = Column(
        DateTime,
        default=datetime.utcnow,
    )


# 聊天消息表
class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, index=True)

    # 属于哪个会话
    conversation_id = Column(
        Integer,
        ForeignKey("conversations.id"),
        nullable=False,
    )

    role = Column(String(20), nullable=False)

    content = Column(String(5000), nullable=False)

    created_at = Column(
        DateTime,
        default=datetime.utcnow,
    )