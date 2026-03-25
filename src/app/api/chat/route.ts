import "./polyfill";
import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { executeEarthEngineTask } from "../../../lib/earth-engine";
import * as cheerio from "cheerio";

const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey });

// ── Global request lock: ensures only ONE Gemini call is active at a time ──
let isProcessing = false;
async function waitForLock(): Promise<void> {
  while (isProcessing) {
    await new Promise(r => setTimeout(r, 500));
  }
  isProcessing = true;
}
function releaseLock() {
  isProcessing = false;
}

// ── Minimum gap between consecutive Gemini API calls ──
const MIN_CALL_GAP_MS = 3000;
let lastCallTimestamp = 0;

async function enforceRateGap(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallTimestamp;
  if (elapsed < MIN_CALL_GAP_MS) {
    await new Promise(r => setTimeout(r, MIN_CALL_GAP_MS - elapsed));
  }
  lastCallTimestamp = Date.now();
}

// ── Tool execution (no Gemini calls here, just local/fetch work) ──
async function executeCustomTool(
  call: any,
  sendStatus: (msg: string) => void,
  sendText: (msg: string) => void
) {
  if (call.name === "earth_engine_query") {
    const args = call.args as any;
    sendStatus(`🌍 Earth Engine: running "${args.taskType}"...`);
    try {
      const result = await executeEarthEngineTask(args.taskType, args);
      if (result.urlFormat) {
        sendText(`\n\n![Earth Engine Result](${result.urlFormat})\n\n`);
      }
      return { url: result.urlFormat || "completed", metadata: result.metadata || "", success: true };
    } catch (e: any) {
      return { error: e.message, success: false };
    }
  }

  if (call.name === "fetch_url_content") {
    const url = (call.args as any).url;
    sendStatus(`🔍 Reading: ${url.substring(0, 60)}...`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AI-Alpha/1.0)" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const html = await res.text();
      const $ = cheerio.load(html);
      $("script, style, nav, footer, iframe, img, svg, meta, noscript, link").remove();
      let text = $("body").text().replace(/\s+/g, " ").trim();
      text = text.substring(0, 12000);
      return { content: text || "No readable text found.", success: true };
    } catch (e: any) {
      return { error: "Failed to fetch: " + e.message, success: false };
    }
  }

  return { error: "Unknown tool: " + call.name, success: false };
}

// ── Tool declarations (defined once, reused) ──
const toolDeclarations: any[] = [
  { googleSearch: {} },
  {
    functionDeclarations: [
      {
        name: "earth_engine_query",
        description:
          "Execute a Google Earth Engine query. Supports taskType: 'generate_dem' (global DEM), 'get_satellite_image' (requires lon, lat, startDate, endDate, dataset), or 'run_custom_script' (requires script field with EE JavaScript code using `ee` object). Returns map tile URLs.",
        parameters: {
          type: "OBJECT",
          properties: {
            taskType: {
              type: "STRING",
              description: "One of: 'generate_dem', 'get_satellite_image', 'run_custom_script'",
            },
            lon: { type: "STRING", description: "Longitude for satellite image" },
            lat: { type: "STRING", description: "Latitude for satellite image" },
            startDate: { type: "STRING", description: "Start date YYYY-MM-DD" },
            endDate: { type: "STRING", description: "End date YYYY-MM-DD" },
            dataset: { type: "STRING", description: "Dataset: 'landsat8' or 'sentinel2'" },
            script: {
              type: "STRING",
              description:
                "Custom Earth Engine JavaScript code. Use the `ee` object. Must return a value or promise. Example: `const img = ee.Image('USGS/SRTMGL1_003'); return new Promise((ok,err) => img.getMap({min:0,max:4000}, (m,e) => e?err(e):ok({urlFormat:m.urlFormat})));`",
            },
          },
          required: ["taskType"],
        },
      },
      {
        name: "fetch_url_content",
        description: "Fetch and read the text content of a webpage URL for deep research.",
        parameters: {
          type: "OBJECT",
          properties: {
            url: { type: "STRING", description: "The URL to fetch" },
          },
          required: ["url"],
        },
      },
    ],
  },
];

const systemInstruction = `You are AI-Alpha, a powerful AI research assistant with deep multi-step reasoning capabilities.

CAPABILITIES:
• Google Search (built-in grounding) for web research
• fetch_url_content tool to deeply read any webpage
• earth_engine_query tool for satellite imagery, DEM generation, and custom geospatial scripts
• Media analysis for attached PDFs, images, audio, video

BEHAVIOR RULES:
• Think step-by-step. Use tools ONE AT A TIME sequentially.
• For complex research: first search, then read specific URLs for depth.
• For geospatial questions: use earth_engine_query with appropriate taskType.
  - Use 'generate_dem' for elevation/terrain maps
  - Use 'get_satellite_image' for satellite photos of specific coordinates
  - Use 'run_custom_script' to write and execute custom EE JavaScript for advanced analysis
• For reverse image search: analyze attached images visually and search for matching descriptions.
• Always list all sources at the end of your response.
• Give comprehensive, well-structured responses.`;

// ── Single Gemini API call with retry ──
async function callGeminiWithRetry(
  model: string,
  contents: any[],
  useTools: boolean,
  sendStatus: (msg: string) => void
): Promise<any> {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await enforceRateGap();

      // @ts-ignore
      const response = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction,
          // @ts-ignore
          tools: useTools ? toolDeclarations : [],
          // @ts-ignore
          toolConfig: useTools ? undefined : { functionCallingConfig: { mode: "NONE" } },
        },
      });
      return response;
    } catch (err: any) {
      const is429 = err.message?.includes("429") || err.message?.includes("Quota") || err.message?.includes("RESOURCE_EXHAUSTED");
      if (is429 && attempt < maxRetries) {
        const delay = 5000 * attempt;
        sendStatus(`⏳ API limit hit. Waiting ${delay / 1000}s before retry ${attempt}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ── Main POST handler ──
export async function POST(req: NextRequest) {
  // If another request is already processing, return immediately
  if (isProcessing) {
    return NextResponse.json(
      { error: "Another request is being processed. Please wait." },
      { status: 429 }
    );
  }

  try {
    await waitForLock();

    const { messages, modelType } = await req.json();
    const model = modelType === "Gemini 3 Flash" ? "gemini-3-flash-preview" : "gemini-3.1-pro-preview";

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const sendStatus = (msg: string) =>
          controller.enqueue(encoder.encode(JSON.stringify({ type: "status", data: msg }) + "\n"));
        const sendText = (chunk: string) =>
          controller.enqueue(encoder.encode(JSON.stringify({ type: "text", data: chunk }) + "\n"));

        sendStatus(`Connecting to ${model}...`);

        let currentMessages = [...messages];
        const maxSteps = 5;
        let step = 0;
        let done = false;

        try {
          while (!done && step < maxSteps) {
            step++;
            const isLastStep = step === maxSteps;
            sendStatus(step === 1 ? "Thinking..." : `Reasoning step ${step}/${maxSteps}...`);

            // Make exactly ONE Gemini call, wait for it to fully complete
            const responseStream = await callGeminiWithRetry(
              model,
              currentMessages,
              !isLastStep, // disable tools on last step to force a text answer
              sendStatus
            );

            // Drain the entire stream before doing anything else
            let functionCallFound: any = null;
            let textParts: string[] = [];

            for await (const chunk of responseStream) {
              if (chunk.functionCalls && chunk.functionCalls.length > 0 && !functionCallFound) {
                // Take only the FIRST function call
                functionCallFound = chunk.functionCalls[0];
              }
              if (chunk.text) {
                textParts.push(chunk.text);
                sendText(chunk.text);
              }
            }

            // ── Stream is now fully consumed ──

            if (functionCallFound) {
              // Process ONE tool call, then loop back for the model to interpret the result
              currentMessages.push({
                role: "model",
                parts: [{ functionCall: functionCallFound }],
              });

              const toolResult = await executeCustomTool(functionCallFound, sendStatus, sendText);

              currentMessages.push({
                role: "user",
                parts: [
                  {
                    functionResponse: {
                      name: functionCallFound.name,
                      response: toolResult,
                    },
                  },
                ],
              });

              // Don't set done — loop back for next step
            } else {
              // No function call — the model gave a text response. We're done.
              done = true;
            }
          }
        } catch (e: any) {
          sendText("\n\n⚠️ " + e.message);
        }

        sendStatus("Complete.");
        controller.close();
        releaseLock();
      },
    });

    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
  } catch (error: any) {
    releaseLock();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
