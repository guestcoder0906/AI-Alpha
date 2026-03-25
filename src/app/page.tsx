"use client";

import React, { useState, useRef, useEffect } from "react";
import { Send, ImagePlus, User, Bot, Loader2, Sparkles } from "lucide-react";

type Message = {
  role: "user" | "model";
  content: string; // The markdown content or text
  status?: string; // Current status if processing
};

function parseMarkdown(text: string) {
  // A basic markdown to HTML parser for simple display.
  // In a real app we would use react-markdown, but to avoid dependencies here, we parse images and bold/links manually.
  let html = text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>") // bold
    .replace(/\*(.*?)\*/g, "<em>$1</em>") // italic
    .replace(/\[(.*?)\]\((.*?)\)/g, "<a href='$2' target='_blank' rel='noopener' style='color: var(--accent-color);'>$1</a>") // links
    .replace(/```(.*?)```/gs, "<pre style='background:#000;padding:10px;border-radius:8px;overflow-x:auto;'><code>$1</code></pre>") // code block
    .replace(/`([^`]+)`/g, "<code style='background:rgba(255,255,255,0.1);padding:2px 4px;border-radius:4px;'>$1</code>"); // inline code

  // Images markdown ![alt](url)
  html = html.replace(/!\[(.*?)\]\((.*?)\)/g, "<img src='$2' alt='$1' loading='lazy' />");

  // Newlines to br
  html = html.replace(/\n\n/g, "<br/><br/>");

  return html;
}

export default function Home() {
  const [modelType, setModelType] = useState<"Pro" | "Flash Lite">("Pro");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "model",
      content: "Hello! I am AI-Alpha, your smart research assistant. I can search the web, execute Google Earth Engine spatial queries, and run multi-step reasoning. How can I help you today?",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { role: "user", content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    const apiMessages = [
      ...messages.map((m) => ({
        role: m.role,
        parts: [{ text: m.content }],
      })),
      { role: "user", parts: [{ text: userMessage.content }] },
    ];

    // Add empty placeholder for AI response
    setMessages((prev) => [
      ...prev,
      { role: "model", content: "", status: "Initializing thinking process..." },
    ]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          modelType,
        }),
      });

      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let aiIndex = messages.length + 1;

      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
          const chunkString = decoder.decode(value, { stream: true });
          const lines = chunkString.split("\n").filter((l) => l.trim() !== "");
          
          for (const line of lines) {
            try {
              const data = JSON.parse(line);
              if (data.type === "status") {
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last.role === "model") {
                    last.status = data.data;
                  }
                  return updated;
                });
              } else if (data.type === "text") {
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last.role === "model") {
                    last.content += data.data;
                  }
                  return updated;
                });
              }
            } catch (e) {
              console.error("Failed to parse NDJSON line:", line);
            }
          }
        }
      }

      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last.role === "model") {
          last.status = undefined; // clear status when done
        }
        return updated;
      });
    } catch (err: any) {
      console.error(err);
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last.role === "model") {
          last.status = "Error occurred: " + err.message;
        }
        return updated;
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-container">
      <header className="header glass-panel">
        <div className="logo">
          <Sparkles className="logo-icon" size={24} color="#00d2ff" />
          AI-Alpha Research
        </div>
        <div className="model-toggle">
          <button
            className={modelType === "Pro" ? "active" : ""}
            onClick={() => setModelType("Pro")}
          >
            Gemini 3.1 Pro
          </button>
          <button
            className={modelType === "Flash Lite" ? "active" : ""}
            onClick={() => setModelType("Flash Lite")}
          >
            Gemini 3.1 Flash Lite
          </button>
        </div>
      </header>

      <main className="chat-container glass-panel">
        <div className="messages-area">
          {messages.map((msg, idx) => (
            <div key={idx} className={`message ${msg.role}`}>
              <div className="avatar">
                {msg.role === "user" ? <User size={20} /> : <Bot size={20} />}
              </div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div
                  className="message-content"
                  dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.content) }}
                ></div>
                {msg.status && (
                  <div className="status-indicator">
                    <Loader2 className="spinner" size={16} />
                    {msg.status}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className="input-area">
          <button className="icon-btn" title="Attach Media">
            <ImagePlus size={22} />
          </button>
          
          <div className="input-wrapper">
            <input
              type="text"
              className="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSend();
              }}
              placeholder={isLoading ? "AI is processing..." : "Ask me anything, specify locations for Earth Engine analysis..."}
              disabled={isLoading}
            />
          </div>

          <button 
            className="send-btn" 
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
          >
            <Send size={20} />
          </button>
        </div>
      </main>
    </div>
  );
}
