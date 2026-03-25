import "./polyfill";
import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { executeEarthEngineTask } from "../../../lib/earth-engine";
import * as cheerio from "cheerio";

const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey });

// ── Global sequential lock: only ONE active Gemini session at a time ──
let activeLock: Promise<void> = Promise.resolve();
function acquireLock(): { ready: Promise<void>; release: () => void } {
  let release: () => void;
  const prev = activeLock;
  activeLock = new Promise(r => { release = r; });
  return { ready: prev, release: release! };
}

// ── Minimum 4s between Gemini API calls ──
let lastGeminiCall = 0;
async function rateWait() {
  const gap = 4000 - (Date.now() - lastGeminiCall);
  if (gap > 0) await new Promise(r => setTimeout(r, gap));
  lastGeminiCall = Date.now();
}

// ── Tool execution (local work only, no Gemini calls) ──
async function runTool(call: any, sendStatus: (s: string) => void, sendText: (s: string) => void) {
  if (call.name === "earth_engine_query") {
    const args = call.args as any;
    sendStatus(`🌍 Earth Engine: ${args.taskType}...`);
    try {
      const result = await executeEarthEngineTask(args.taskType, args);
      if (result.urlFormat) sendText(`\n\n![Earth Engine](${result.urlFormat})\n\n`);
      return { success: true, url: result.urlFormat || "done", metadata: result.metadata || "" };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }
  if (call.name === "fetch_url_content") {
    const url = (call.args as any).url;
    sendStatus(`🔗 Reading: ${url.substring(0, 50)}...`);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal });
      clearTimeout(t);
      const $ = cheerio.load(await res.text());
      $("script,style,nav,footer,iframe,svg,meta,noscript,link,header").remove();
      let text = $("body").text().replace(/\s+/g, " ").trim().substring(0, 6000);
      return { success: true, content: text || "Empty page." };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: "Unknown tool" };
}

// ── Shared tool declarations ──
const customTools = {
  functionDeclarations: [
    {
      name: "earth_engine_query",
      description: "Run Google Earth Engine analysis. Only use when the user explicitly asks for satellite imagery, elevation maps, or geospatial data.",
      parameters: {
        type: "OBJECT",
        properties: {
          taskType: { type: "STRING", description: "'generate_dem', 'get_satellite_image', or 'run_custom_script'" },
          lon: { type: "STRING", description: "Longitude" },
          lat: { type: "STRING", description: "Latitude" },
          startDate: { type: "STRING", description: "YYYY-MM-DD" },
          endDate: { type: "STRING", description: "YYYY-MM-DD" },
          dataset: { type: "STRING", description: "'landsat8' or 'sentinel2'" },
          script: { type: "STRING", description: "Custom EE JavaScript using the `ee` object" },
        },
        required: ["taskType"],
      },
    },
    {
      name: "fetch_url_content",
      description: "Fetch text from a specific URL. Only use when the user provides a URL or when you need to verify a specific claim from a specific source.",
      parameters: {
        type: "OBJECT",
        properties: { url: { type: "STRING", description: "URL to read" } },
        required: ["url"],
      },
    },
  ],
};

const SYSTEM = `You are AI-Alpha, an efficient AI research assistant.

KEY PRINCIPLE: Be efficient with API calls. The Google Search grounding tool runs WITHIN your response automatically — it does NOT require a separate step. For most questions, just answer using your knowledge + built-in Google Search grounding. That is usually sufficient.

TOOLS (use sparingly):
• Google Search: BUILT-IN. Works automatically within your response. No extra steps needed.
• fetch_url_content: ONLY use when the user gives you a specific URL to read, or you absolutely must verify a specific page. Do NOT chain-crawl multiple URLs.
• earth_engine_query: ONLY use when the user asks for maps, satellite images, or geospatial analysis.

RULES:
1. For general knowledge questions: just answer directly. Google Search grounding enriches your response automatically.
2. Do NOT call fetch_url_content unless strictly necessary. Google Search grounding already gives you search results.
3. Do NOT call multiple tools in sequence unless the user's question genuinely requires it.
4. For media analysis: analyze attached files directly — no tools needed for that.
5. Always cite sources at the end if you used web information.`;

// ── Single Gemini call with retry ──
async function geminiCall(model: string, contents: any[], useTools: boolean, sendStatus: (s: string) => void) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await rateWait();
      // @ts-ignore
      return await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: SYSTEM,
          // @ts-ignore - Google Search grounding is always available (zero extra cost)
          tools: useTools ? [{ googleSearch: {} }, customTools] : [{ googleSearch: {} }],
          // @ts-ignore
          toolConfig: useTools ? undefined : { functionCallingConfig: { mode: "NONE" } },
        },
      });
    } catch (err: any) {
      if ((err.message?.includes("429") || err.message?.includes("Quota")) && attempt < 2) {
        sendStatus(`⏳ Rate limited, waiting 8s...`);
        await new Promise(r => setTimeout(r, 8000));
        continue;
      }
      throw err;
    }
  }
}

// ── POST handler ──
export async function POST(req: NextRequest) {
  const lock = acquireLock();
  await lock.ready; // wait for any previous request to finish

  try {
    const { messages, modelType } = await req.json();
    const model = modelType === "Gemini 3 Flash" ? "gemini-3-flash-preview" : "gemini-3.1-pro-preview";

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (type: string, data: string) =>
          controller.enqueue(encoder.encode(JSON.stringify({ type, data }) + "\n"));
        const sendStatus = (s: string) => send("status", s);
        const sendText = (s: string) => send("text", s);

        sendStatus(`Connected to ${model}`);

        let conv = [...messages];
        // Max 3 steps: initial response + up to 2 tool follow-ups
        const MAX_STEPS = 3;
        let done = false;

        try {
          for (let step = 0; step < MAX_STEPS && !done; step++) {
            const allowTools = step < MAX_STEPS - 1; // last step = no tools, force text
            if (step > 0) sendStatus("Processing tool result...");

            const stream = await geminiCall(model, conv, allowTools, sendStatus);
            if (!stream) throw new Error("No response from model");

            let toolCall: any = null;
            for await (const chunk of stream) {
              if (chunk.functionCalls?.length && !toolCall) {
                toolCall = chunk.functionCalls[0]; // take first only
              }
              if (chunk.text) {
                sendText(chunk.text);
              }
            }

            if (toolCall) {
              // Append model's function call
              conv.push({ role: "model", parts: [{ functionCall: toolCall }] });
              // Execute tool locally (no Gemini call)
              const result = await runTool(toolCall, sendStatus, sendText);
              // Append tool result
              conv.push({
                role: "user",
                parts: [{ functionResponse: { name: toolCall.name, response: result } }],
              });
              // Loop back for model to interpret — but enforced rate gap will apply
            } else {
              done = true;
            }
          }
        } catch (e: any) {
          sendText("\n\n⚠️ " + e.message);
        }

        sendStatus("Complete.");
        controller.close();
        lock.release();
      },
    });

    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
  } catch (error: any) {
    lock.release();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
