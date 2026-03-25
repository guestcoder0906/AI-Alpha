import "./polyfill";
import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { executeEarthEngineTask } from "../../../lib/earth-engine";
import * as cheerio from "cheerio";

const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey });

async function executeCustomTool(call: any, sendStatus: (msg: string) => void, sendText: (msg: string) => void) {
  if (call.name === "earth_engine_query") {
    sendStatus("Executing Earth Engine Query...");
    try {
      const args = call.args as any;
      const result = await executeEarthEngineTask(args.taskType, args);
      // We also send the embedded image directly to the user UI
      sendText(`\n\n![Earth Engine Map Tile](${result.urlFormat || result})\n\n`);
      return { url: result.urlFormat || result, success: true };
    } catch (e: any) {
      return { error: e.message, success: false };
    }
  } else if (call.name === "fetch_url_content") {
    const url = (call.args as any).url;
    sendStatus(`Deep Searching URL: ${url}...`);
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const html = await res.text();
      const $ = cheerio.load(html);
      $("script, style, nav, footer, iframe, img, svg, meta").remove();
      let text = $("body").text().replace(/\s+/g, ' ').trim();
      text = text.substring(0, 15000); // Send up to 15k chars to limit context bloat
      return { content: text || "No readable text found.", success: true };
    } catch (e: any) {
      return { error: "Failed to fetch: " + e.message, success: false };
    }
  }
  return { error: "Unknown tool", success: false };
}

export async function POST(req: NextRequest) {
  try {
    const { messages, modelType } = await req.json();
    const model = modelType === "Gemini 3 Flash" ? "gemini-3.1-flash-lite-preview" : "gemini-3.1-pro-preview";

    const systemInstruction = `You are AI-Alpha, a smart AI research assistant. 
You support smart deep custom multistep thinking, reading multi-page Google search results via URL checking, Google Maps, and Earth Engine integration.
For reverse image search, deeply analyze the attached image visually and form conclusions. 
You have the following tools available in reasoninig phases:
1. earth_engine_query: Execute specific Earth Engine tasks.
2. googleSearch: Built-in grounding tool for Google Search.
3. fetch_url_content: Fetch text from a specific URL.
If you find results, summarize them clearly at the end. Use your search tools sequentially to avoid quota errors.`;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const sendStatus = (msg: string) => controller.enqueue(encoder.encode(JSON.stringify({ type: "status", data: msg }) + "\n"));
        const sendText = (chunk: string) => controller.enqueue(encoder.encode(JSON.stringify({ type: "text", data: chunk }) + "\n"));

        sendStatus(`Connecting to AI-Alpha Engine (${model})...`);

        let currentMessages = [...messages];
        let maxLoops = 6;
        let loopCount = 0;
        let isDone = false;
        
        // Tool definition shared
        const tools: any[] = [
          { googleSearch: {} },
          {
            functionDeclarations: [
              {
                name: "earth_engine_query",
                description: "Execute a Google Earth Engine query to generate map tiles or perform geospatial analysis.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    taskType: { type: "STRING", description: "'generate_dem' or 'run_custom_script'" },
                    script: { type: "STRING", description: "Node.js Earth Engine code here stringified. Must evaluate to promise/value." }
                  },
                  required: ["taskType"]
                }
              },
              {
                name: "fetch_url_content",
                description: "Fetch and parse the readable text content of a specific URL.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    url: { type: "STRING", description: "The specific http/https URL to parse." }
                  },
                  required: ["url"]
                }
              }
            ]
          }
        ];

        try {
          while (!isDone && loopCount < maxLoops) {
            loopCount++;

            if (loopCount > 1) {
              sendStatus("Analyzing discoveries...");
              await new Promise(r => setTimeout(r, 1500));
            }

            let hasFunctionCallThisLoop = false;
            let finalParts: any[] = [];
            let retryCount = 0;
            const maxRetries = 2;
            let success = false;

            while (!success && retryCount < maxRetries) {
              try {
                // To save quota/tokens, if it's the first loop we encourage tools.
                // If it's the last loop possible, we block tools to get a final answer.
                const isFinalAttempt = (loopCount === maxLoops);
                
                // @ts-ignore
                const responseStream = await ai.models.generateContentStream({
                  model: model,
                  contents: currentMessages,
                  config: {
                    systemInstruction: systemInstruction,
                    // Only provide tools if we aren't at the limit
                    // @ts-ignore
                    tools: isFinalAttempt ? [] : tools,
                    // If we are on final attempt, force it to answer as text
                    // @ts-ignore
                    toolConfig: isFinalAttempt ? { functionCallingConfig: { mode: "NONE" } } : undefined
                  }
                });

                for await (const chunk of responseStream) {
                  if (chunk.functionCalls && chunk.functionCalls.length > 0) {
                    hasFunctionCallThisLoop = true;
                    // For rate limit safety, we only process the FIRST function call if multiple returned
                    const call = chunk.functionCalls[0];
                    finalParts.push({ functionCall: call });
                    
                    const toolResult = await executeCustomTool(call, sendStatus, sendText);
                    
                    currentMessages.push({ role: "model", parts: [{ functionCall: call }] });
                    currentMessages.push({
                      role: "user",
                      parts: [{
                        functionResponse: {
                          name: call.name,
                          response: toolResult
                        }
                      }]
                    });
                    // Break out of chunk processing to re-verify with model sequentially
                    break;
                  }
                  if (chunk.text) {
                    sendText(chunk.text);
                    finalParts.push({ text: chunk.text });
                  }
                }
                success = true;
              } catch (err: any) {
                if (err.message?.includes("429") || err.message?.includes("Quota")) {
                  retryCount++;
                  const delay = 5000 * retryCount;
                  sendStatus(`Engine busy, retrying in ${delay / 1000}s...`);
                  await new Promise(r => setTimeout(r, delay));
                } else {
                  throw err;
                }
              }
            }

            if (!success) throw new Error("API Limit Reached");

            if (!hasFunctionCallThisLoop) {
              isDone = true;
            }
          }
        } catch (e: any) {
          sendStatus("Error: " + e.message);
          sendText("\n\n(AI-Alpha Engine Error: " + e.message + ". Please try again in 30 seconds)");
        }

        sendStatus("Research task completed.");
        controller.close();
      }
    });

    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
