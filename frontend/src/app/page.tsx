"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  FormEvent,
} from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Role = "user" | "assistant";

interface Message {
  role: Role;
  content: string;
  id?: number;
}

interface ConversationListItem {
  id: number;
  title: string;
  created_at: string;
}

interface ApiMessageRow {
  id: number;
  role: string;
  content: string;
  created_at: string;
}

const API_CHAT_URL =
  (typeof process !== "undefined" &&
    process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, "")) ||
  "http://127.0.0.1:8000";

const CHAT_ENDPOINT = `${API_CHAT_URL}/deepseek/chat`;
const CONVERSATIONS_URL = `${API_CHAT_URL}/conversations`;

function conversationMessagesUrl(conversationId: number): string {
  return `${API_CHAT_URL}/conversations/${conversationId}/messages`;
}

function deleteConversationUrl(conversationId: number): string {
  return `${API_CHAT_URL}/conversations/${conversationId}`;
}

function mapApiRowToMessage(row: ApiMessageRow): Message | null {
  const role: Role =
    row.role === "user" || row.role === "assistant"
      ? row.role
      : "assistant";
  if (typeof row.content !== "string") return null;
  return { id: row.id, role, content: row.content };
}

function parseSseDataLine(line: string):
  | { kind: "delta"; text: string }
  | { kind: "done" }
  | { kind: "skip" }
  | { kind: "meta"; conversationId: number } {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return { kind: "skip" };
  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return { kind: "done" };
  try {
    const parsed = JSON.parse(data) as {
      content?: string;
      error?: string;
      conversation_id?: number;
    };
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    if (typeof parsed.conversation_id === "number") {
      return { kind: "meta", conversationId: parsed.conversation_id };
    }
    if (typeof parsed.content === "string" && parsed.content.length > 0) {
      return { kind: "delta", text: parsed.content };
    }
  } catch (e) {
    if (e instanceof SyntaxError) {
      return { kind: "delta", text: data };
    }
    throw e;
  }
  return { kind: "skip" };
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");

  const [conversations, setConversations] = useState<ConversationListItem[]>(
    []
  );
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(
    null
  );
  const [selectedConversationId, setSelectedConversationId] = useState<
    number | null
  >(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const conversationIdRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const streamingTextRef = useRef("");
  const streamingRafRef = useRef<number | null>(null);
  const streamingRafQueuedRef = useRef(false);
  const openingConversationRef = useRef(false);

  const resetStreamingVisual = useCallback(() => {
    setStreamingContent("");
    streamingTextRef.current = "";
    if (streamingRafRef.current != null) {
      cancelAnimationFrame(streamingRafRef.current);
      streamingRafRef.current = null;
    }
    streamingRafQueuedRef.current = false;
    setLoading(false);
  }, []);

  const fetchConversationList = useCallback(
    async (options?: { showLoading?: boolean }) => {
      const showLoading = options?.showLoading ?? false;
      if (showLoading) setConversationsLoading(true);
      try {
        const res = await fetch(CONVERSATIONS_URL);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as ConversationListItem[];
        setConversations(Array.isArray(data) ? data : []);
        setConversationsError(null);
      } catch (err) {
        console.error("Conversations list error:", err);
        setConversationsError("加载会话列表失败");
      } finally {
        if (showLoading) setConversationsLoading(false);
      }
    },
    []
  );

  const openConversation = useCallback(
    async (id: number) => {
      if (openingConversationRef.current) return;
      openingConversationRef.current = true;
      resetStreamingVisual();
      setHistoryLoading(true);
      try {
        const res = await fetch(conversationMessagesUrl(id));
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${t}`);
        }
        const rows = (await res.json()) as ApiMessageRow[];
        const mapped: Message[] = [];
        for (const row of Array.isArray(rows) ? rows : []) {
          const m = mapApiRowToMessage(row);
          if (m) mapped.push(m);
        }
        setMessages(mapped);
        conversationIdRef.current = id;
        setSelectedConversationId(id);
      } catch (err) {
        console.error("加载会话消息失败:", err);
        setMessages([]);
      } finally {
        setHistoryLoading(false);
        openingConversationRef.current = false;
      }
    },
    [resetStreamingVisual]
  );

  const startNewChat = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    sendingRef.current = false;
    resetStreamingVisual();
    setMessages([]);
    conversationIdRef.current = null;
    setSelectedConversationId(null);
    setInput("");
  }, [resetStreamingVisual]);

  const deleteConversation = useCallback(
    async (id: number) => {
      if (!confirm("确定要删除这个会话吗？")) {
        return;
      }
      try {
        const res = await fetch(deleteConversationUrl(id), {
          method: "DELETE",
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        await fetchConversationList();
        if (selectedConversationId === id) {
          startNewChat();
        }
      } catch (err) {
        console.error("删除会话失败:", err);
        alert("删除会话失败，请稍后重试");
      }
    },
    [fetchConversationList, selectedConversationId, startNewChat]
  );

  const handleSend = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const text = input.trim();
      if (!text || sendingRef.current || historyLoading) return;
      sendingRef.current = true;

      const hadConversationAtStart = conversationIdRef.current != null;
      const currentConversationIdAtStart = conversationIdRef.current;

      const userMessage: Message = { role: "user", content: text };
      const nextConversation = [...messages, userMessage];
      setMessages(nextConversation);
      setInput("");
      setLoading(true);
      setStreamingContent("");
      streamingTextRef.current = "";
      if (streamingRafRef.current != null) {
        cancelAnimationFrame(streamingRafRef.current);
        streamingRafRef.current = null;
      }
      streamingRafQueuedRef.current = false;

      let aiMessageContent = "";

      try {
        const response = await fetch(CHAT_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: nextConversation,
            stream: true,
            ...(conversationIdRef.current != null
              ? { conversation_id: conversationIdRef.current }
              : {}),
          }),
        });

        if (!response.ok) {
          let detail: unknown;
          try {
            detail = await response.json();
          } catch {
            detail = await response.text().catch(() => "");
          }
          console.error("Chat API error:", response.status, detail);
          const detailStr =
            typeof detail === "object" &&
            detail !== null &&
            "detail" in detail
              ? JSON.stringify((detail as { detail: unknown }).detail)
              : String(detail);
          throw new Error(`HTTP ${response.status}: ${detailStr}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("响应体不可读");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const event = parseSseDataLine(line);
            if (event.kind === "done") {
              buffer = "";
              break;
            }
            if (event.kind === "meta") {
              conversationIdRef.current = event.conversationId;
              if (!hadConversationAtStart) {
                setSelectedConversationId(event.conversationId);
                void fetchConversationList();
              }
              continue;
            }
            if (event.kind === "delta") {
              aiMessageContent += event.text;
              streamingTextRef.current = aiMessageContent;
              if (!streamingRafQueuedRef.current) {
                streamingRafQueuedRef.current = true;
                streamingRafRef.current = requestAnimationFrame(() => {
                  streamingRafRef.current = null;
                  streamingRafQueuedRef.current = false;
                  if (conversationIdRef.current === currentConversationIdAtStart || (!currentConversationIdAtStart && !selectedConversationId)) {
                    setStreamingContent(streamingTextRef.current);
                  }
                });
              }
            }
          }
        }

        if (streamingRafRef.current != null) {
          cancelAnimationFrame(streamingRafRef.current);
          streamingRafRef.current = null;
        }
        streamingRafQueuedRef.current = false;

        if (aiMessageContent) {
          if (conversationIdRef.current === currentConversationIdAtStart || (!currentConversationIdAtStart && !selectedConversationId)) {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: aiMessageContent },
            ]);
          }
          void fetchConversationList();
        }
      } catch (error) {
        console.error("请求失败:", error);
        if (conversationIdRef.current === currentConversationIdAtStart || (!currentConversationIdAtStart && !selectedConversationId)) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: "抱歉，请求失败，请稍后重试。",
            },
          ]);
        }
      } finally {
        sendingRef.current = false;
        if (streamingRafRef.current != null) {
          cancelAnimationFrame(streamingRafRef.current);
          streamingRafRef.current = null;
        }
        streamingRafQueuedRef.current = false;
        if (conversationIdRef.current === currentConversationIdAtStart || (!currentConversationIdAtStart && !selectedConversationId)) {
          setLoading(false);
          setStreamingContent("");
        }
      }
    },
    [input, messages, fetchConversationList, historyLoading]
  );

  useEffect(() => {
    void fetchConversationList({ showLoading: true });
  }, [fetchConversationList]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  useEffect(() => {
    return () => {
      if (streamingRafRef.current != null) {
        cancelAnimationFrame(streamingRafRef.current);
      }
    };
  }, []);

  return (
    <div className="h-screen flex bg-white">
      <aside className="w-64 shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col">
        <div className="p-4">
          <button
            type="button"
            onClick={startNewChat}
            className="w-full px-4 py-2.5 bg-black text-white rounded-md hover:bg-gray-900 transition-colors text-sm font-medium"
          >
            + 新对话
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {conversationsLoading && (
            <p className="text-xs text-gray-400 px-3 py-2">加载中…</p>
          )}
          {conversationsError && (
            <p className="text-xs text-red-500 px-3 py-2">{conversationsError}</p>
          )}
          {!conversationsLoading &&
            !conversationsError &&
            conversations.length === 0 && (
              <p className="text-xs text-gray-400 px-3 py-4 text-center">暂无会话</p>
            )}
          <ul className="space-y-0.5">
            {conversations.map((c) => {
              const selected = selectedConversationId === c.id;
              return (
                <li key={c.id} className="relative group">
                  <button
                    type="button"
                    onClick={() => void openConversation(c.id)}
                    disabled={historyLoading}
                    className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-colors disabled:opacity-50 ${
                      selected
                        ? "bg-gray-200 text-gray-900 font-medium"
                        : "text-gray-700 hover:bg-gray-100"
                    }`}
                  >
                    {c.title || "新对话"}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteConversation(c.id);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity"
                    title="删除会话"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="p-4 border-t border-gray-200">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </div>
            <span>AI Assistant</span>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col">
        <header className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gray-900 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
            <h1 className="text-lg font-semibold text-gray-900">AI Assistant</h1>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-8 py-6">
          {messages.length === 0 && !streamingContent && !loading && (
            <div className="max-w-xl mx-auto text-center pt-24">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-100 flex items-center justify-center">
                <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-gray-800 mb-2">
                How can I help you?
              </h2>
              <p className="text-gray-500 text-sm mb-6">
                Ask me anything
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {["Explain quantum computing", "Write a poem", "Recommend a movie", "Learn programming"].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => setInput(suggestion)}
                    className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm rounded-md transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, index) => (
            <div
              key={msg.id != null ? `db-${msg.id}` : `${msg.role}-${index}`}
              className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"} mb-4`}
            >
              <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center ${
                msg.role === "user" ? "bg-gray-800" : "bg-gray-200"
              }`}>
                {msg.role === "user" ? (
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                )}
              </div>
              <div className={`max-w-[70%]`}>
                <div className={`px-4 py-3 rounded-lg text-sm ${
                  msg.role === "user"
                    ? "bg-gray-800 text-white"
                    : "bg-gray-100 text-gray-800"
                }`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          ))}

          {streamingContent && (
            <div className="flex gap-3 justify-start mb-4">
              <div className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center bg-gray-200">
                <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <div className="max-w-[70%]">
                <div className="px-4 py-3 rounded-lg text-sm bg-gray-100 text-gray-800">
                  <div className="whitespace-pre-wrap">{streamingContent}</div>
                  <span className="inline-block w-1.5 h-4 ml-0.5 bg-gray-400 animate-pulse" />
                </div>
              </div>
            </div>
          )}

          {loading && !streamingContent && (
            <div className="flex gap-3 justify-start">
              <div className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center bg-gray-200">
                <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <div className="px-4 py-3 rounded-lg bg-gray-100">
                <span className="flex space-x-1">
                  <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" />
                  <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-75" />
                  <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-150" />
                </span>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        <div className="px-8 py-4 border-t border-gray-200 bg-gray-50">
          <form onSubmit={handleSend} className="max-w-xl mx-auto">
            <div className="flex items-end gap-3">
              <textarea
                className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent resize-none bg-white"
                rows={2}
                placeholder="Type your message..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <button
                type="submit"
                disabled={loading || !input.trim()}
                className="px-5 py-3 bg-black text-white rounded-lg hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium flex items-center gap-2"
              >
                {loading ? (
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                )}
                <span>{loading ? "Sending..." : "Send"}</span>
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}