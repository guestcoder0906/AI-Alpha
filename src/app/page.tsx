"use client";

import React, { useState, useRef, useEffect } from "react";
import { Send, ImagePlus, User, Bot, Loader2, Sparkles, X } from "lucide-react";

type AttachedMedia = {
  url: string;
  mimeType: string;
  data: string; // base64 without prefix
  name: string;
};

type Message = {
  role: "user" | "model";
  content: string;
  status?: string;
  media?: AttachedMedia[];
};

function parseMarkdown(text: string) {
  let html = text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/\[(.*?)\]\((.*?)\)/g, "<a href='$2' target='_blank' rel='noopener' style='color: var(--accent-color);'>$1</a>")
    .replace(/```(.*?)```/gs, "<pre style='background:#000;padding:10px;border-radius:8px;overflow-x:auto;'><code>$1</code></pre>")
    .replace(/`([^`]+)`/g, "<code style='background:rgba(255,255,255,0.1);padding:2px 4px;border-radius:4px;'>$1</code>");

  html = html.replace(/!\[(.*?)\]\((.*?)\)/g, "<img src='$2' alt='$1' loading='lazy' />");
  html = html.replace(/\n\n/g, "<br/><br/>");

  return html;
}

export default function Home() {
  const [modelType, setModelType] = useState<"Gemini 3.1 Pro" | "Gemini 3 Flash">("Gemini 3.1 Pro");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "model",
      content: "Hello! I am AI-Alpha, your smart research assistant. I can deeply analyze documents, perform Google Deep Searches, check URLs recursively, interact with Google Earth Engine, and process reverse image searches. Attach any media (PDF, Audio, Video, Image) and let's begin!",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [attachments, setAttachments] = useState<AttachedMedia[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const newAttachments: AttachedMedia[] = [];
      for (let i = 0; i < e.target.files.length; i++) {
        const file = e.target.files[i];
        
        const reader = new FileReader();
        reader.onload = (event) => {
          const result = event.target?.result as string;
          const base64Data = result.split(',')[1];
          newAttachments.push({
            url: URL.createObjectURL(file),
            mimeType: file.type || "application/octet-stream",
            data: base64Data,
            name: file.name
          });
          if (newAttachments.length === e.target.files!.length) {
            setAttachments((prev) => [...prev, ...newAttachments]);
          }
        };
        reader.readAsDataURL(file);
      }
    }
    // reset input
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const clearAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const handleSend = async () => {
    if ((!input.trim() && attachments.length === 0) || isLoading) return;

    const userAttachments = [...attachments];
    const userMessage: Message = { role: "user", content: input, media: userAttachments };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setAttachments([]);
    setIsLoading(true);

    const apiMessages = [
      ...messages.map((m) => {
        let parts: any[] = [{ text: m.content }];
        if (m.media) {
          m.media.forEach(md => {
            parts.push({
              inlineData: { mimeType: md.mimeType, data: md.data }
            });
          });
        }
        return { role: m.role, parts };
      }),
      { 
        role: "user", 
        parts: [
          ...userAttachments.map(md => ({ inlineData: { mimeType: md.mimeType, data: md.data } })),
          { text: userMessage.content || "Please analyze these attachments." } 
        ]
      },
    ];

    setMessages((prev) => [
      ...prev,
      { role: "model", content: "", status: "Initializing deep thinking process..." },
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
          last.status = undefined;
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

  const renderMedia = (md: AttachedMedia) => {
    if (md.mimeType.startsWith('image/')) {
       return <img key={md.url} src={md.url} alt="Attached" style={{maxWidth: '200px', borderRadius: '8px', border: '1px solid var(--border-color)', marginTop: '8px'}} />
    }
    if (md.mimeType.startsWith('video/')) {
       return <video key={md.url} src={md.url} controls style={{maxWidth: '250px', borderRadius: '8px', marginTop: '8px'}} />
    }
    if (md.mimeType.startsWith('audio/')) {
       return <audio key={md.url} src={md.url} controls style={{marginTop: '8px'}} />
    }
    // generic file like PDF
    return <div key={md.url} style={{background: 'rgba(255,255,255,0.05)', padding: '8px', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px'}}>📄 {md.name}</div>
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
            className={modelType === "Gemini 3.1 Pro" ? "active" : ""}
            onClick={() => setModelType("Gemini 3.1 Pro")}
          >
            Gemini 3.1 Pro
          </button>
          <button
            className={modelType === "Gemini 3 Flash" ? "active" : ""}
            onClick={() => setModelType("Gemini 3 Flash")}
          >
            Gemini 3 Flash
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
                {msg.media && msg.media.length > 0 && (
                  <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px'}}>
                    {msg.media.map(renderMedia)}
                  </div>
                )}
                {msg.content && (
                  <div
                    className="message-content"
                    dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.content) }}
                  ></div>
                )}
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

        {/* Attachments Preview Area */}
        {attachments.length > 0 && (
          <div style={{padding: '10px 1.5rem', borderTop: '1px solid var(--border-color)', display: 'flex', gap: '10px', overflowX: 'auto'}}>
            {attachments.map((att, i) => (
               <div key={i} style={{position: 'relative', background: 'rgba(0,0,0,0.4)', borderRadius: '8px', padding: '4px'}}>
                 <button onClick={() => clearAttachment(i)} style={{position: 'absolute', top: '-5px', right: '-5px', background: 'red', border: 'none', color: 'white', borderRadius: '50%', cursor: 'pointer', zIndex: 10}}><X size={14}/></button>
                 {att.mimeType.startsWith('image/') ? (
                    <img src={att.url} alt={att.name} style={{height: '50px', borderRadius: '4px'}} />
                 ) : (
                    <div style={{padding: '10px', fontSize: '12px'}}>📁 {att.name}</div>
                 )}
               </div>
            ))}
          </div>
        )}

        <div className="input-area">
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            style={{display: 'none'}} 
            multiple 
            accept="image/*,video/*,audio/*,application/pdf"
          />
          <button className="icon-btn" title="Attach Media (PDF/Audio/Video/Images)" onClick={() => fileInputRef.current?.click()}>
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
              placeholder={isLoading ? "AI is processing deeply..." : "Ask me anything, specify deep URLs, or attach images..."}
              disabled={isLoading}
            />
          </div>

          <button 
            className="send-btn" 
            onClick={handleSend}
            disabled={(!input.trim() && attachments.length === 0) || isLoading}
          >
            <Send size={20} />
          </button>
        </div>
      </main>
    </div>
  );
}
