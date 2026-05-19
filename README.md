# AI Assistant

一个基于 Next.js、FastAPI 与 MySQL 构建的全栈 AI 对话系统，采用前后端分离架构，实现多轮对话、会话管理与聊天记录持久化等核心功能。

项目重点关注接口设计、模块化开发与工程化实践，支持后续功能扩展与部署。

---

## Tech Stack

### Frontend
- Next.js 15
- React
- TypeScript
- Tailwind CSS

### Backend
- FastAPI
- SQLAlchemy
- Pydantic

### Database
- MySQL

### AI Service
- DeepSeek API

---

## Features

- 支持 AI 多轮对话
- 会话列表管理
- 聊天记录持久化
- RESTful API 设计
- 前后端分离开发
- 数据校验与异常处理
- 支持后续模块扩展

---

## Project Structure

```bash
ai_assistant/
├── backend/
│   ├── app/
│   │   ├── api/
│   │   ├── database.py
│   │   ├── models.py
│   │   └── main.py
│   └── requirements.txt
│
├── frontend/
│   ├── src/
│   ├── public/
│   ├── package.json
│   └── next.config.ts
│
└── README.md
```


## Local Development


1. Clone Repository

```bash
git clone https://github.com/qian-17/ai_assistant.git
cd ai_assistant
```


2. Start Backend

```bash
cd backend

pip install -r requirements.txt

uvicorn app.main:app --reload
```

Backend default address:

```
http://127.0.0.1:8000
```


3. Start Frontend

```bash
cd frontend

npm install

npm run dev
```

Frontend default address:

```
http://localhost:3000
```


## Engineering Highlights
- 基于 FastAPI 构建异步接口服务
- 使用 SQLAlchemy 管理数据库模型与数据操作
- 使用 TypeScript 提升前端代码可维护性
- 前后端完全分离，便于独立开发与部署
- 支持 AI 对话数据持久化存储
- 具备基础工程化目录结构与模块拆分


## Future Improvements
- 用户登录与权限管理
- Markdown 消息渲染
- 文件上传与知识库功能
- AI 流式输出
- Docker 容器化部署
- Linux + Nginx 生产环境部署
