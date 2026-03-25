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
You have the following tools:
1. earth_engine_query: Execute specific Earth Engine tasks.
2. googleSearch: Built-in grounding tool for Google Search (automatically used when needed).
3. fetch_url_content: Fetch text from a specific URL if you need to read a webpage deeply.
Use deep chain-of-thought recursively by utilizing fetch_url_content on links returned by your knowledge or search.
Always attach all sources as a referenced list at the end of your response. Give comprehensive analysis. Do not hallucinate URLs.`;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const sendStatus = (msg: string) => controller.enqueue(encoder.encode(JSON.stringify({ type: "status", data: msg }) + "\n"));
        const sendText = (chunk: string) => controller.enqueue(encoder.encode(JSON.stringify({ type: "text", data: chunk }) + "\n"));

        sendStatus(`Booting Deep Thinking on ${model}...`);

        let currentMessages = [...messages];
        let maxLoops = 6;
        let loopCount = 0;
        let isDone = false;

        try {
          while (!isDone && loopCount < maxLoops) {
            loopCount++;

            // Context window management: Keep initial system turn + latest history
            if (currentMessages.length > 15) {
              currentMessages = [currentMessages[0], ...currentMessages.slice(-10)];
            }

            let hasFunctionCallThisLoop = false;
            let finalParts: any[] = [];
            let retryCount = 0;
            const maxRetries = 2;
            let success = false;

            while (!success && retryCount < maxRetries) {
              try {
                // @ts-ignore
                const responseStream = await ai.models.generateContentStream({
                  model: model,
                  contents: currentMessages,
                  config: {
                    systemInstruction: systemInstruction,
                    // @ts-ignore
                    tools: loopCount < 5 ? [
                      { googleSearch: {} },
                      {
                        functionDeclarations: [
                          {
                            name: "earth_engine_query",
                            description: "Execute Earth Engine tasks.",
                            parameters: {
                              type: "OBJECT",
                              properties: { taskType: { type: "STRING" }, script: { type: "STRING" } },
                              required: ["taskType"]
                            }
                          },
                          {
                            name: "fetch_url_content",
                            description: "Fetch URL text.",
                            parameters: {
                              type: "OBJECT",
                              properties: { url: { type: "STRING" } },
                              required: ["url"]
                            }
                          }
                        ]
                      }
                    ] : []
                  }
                });

                for await (const chunk of responseStream) {
                  if (chunk.functionCalls && chunk.functionCalls.length > 0) {
                    hasFunctionCallThisLoop = true;
                    for (const call of chunk.functionCalls) {
                      finalParts.push({ functionCall: call });
                      const toolResult = await executeCustomTool(call, sendStatus, sendText);
                      
                      currentMessages.push({ role: "model", parts: [{ functionCall: call }] });
                      currentMessages.push({
                        role: "user",
                        parts: [{ functionResponse: { name: call.name, response: toolResult } }]
                      });
                    }
                  }
                  if (chunk.text) {
                    sendText(chunk.text);
                    finalParts.push({ text: chunk.text });
                  }
                }
                success = true;
              } catch (err: any) {
                if (err.message?.includes("429") || err.message?.includes("quota")) {
                  retryCount++;
                  const delay = 3000 * retryCount;
                  sendStatus(`Pacing... (${delay/1000}s)`);
                  await new Promise(r => setTimeout(r, delay));
                } else {
                  throw err;
                }
              }
            }

            if (!success || !hasFunctionCallThisLoop) {
              isDone = true;
              if (finalParts.length > 0) {
                currentMessages.push({ role: "model", parts: finalParts });
              }
            } else {
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        } catch (e: any) {
          sendText(`\n\n*(Error: ${e.message})*`);
        }

        sendStatus("Processing complete.");
        controller.close();
      }
    });

    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
