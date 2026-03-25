import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { executeEarthEngineTask } from "../../../lib/earth-engine";

const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey });

export async function POST(req: NextRequest) {
  try {
    const { messages, modelType } = await req.json();

    // Map the user's toggle selection to actual model names
    const model = modelType === "Flash Lite" ? "gemini-1.5-flash" : "gemini-1.5-pro";

    const systemInstruction = `You are AI-Alpha, a smart AI research assistant. 
You support smart deep custom multistep thinking, Google searching, Google Maps searching, and Earth Engine integration.
When analyzing locations, you can write custom Earth Engine JS code that interacts with the 'ee' object to be executed, or request DEMs.
You have the following tools at your disposal:
1. earth_engine_query: Execute specific Earth Engine tasks.
2. googleSearch: Built-in grounding tool for answering queries from Google Search.
If you need to show an Earth Engine map, use the earth_engine_query tool to get a tile URL and embed it in your response as an image: ![Map](url).
Always attach all sources at the end of your response.
Be thorough and use chain-of-thought deeply. Break down complex requests.`;

    const encoder = new TextEncoder();
    
    // We stream a custom JSON protocol to support real-time status updates and markdown
    const stream = new ReadableStream({
      async start(controller) {
        let isComplete = false;
        
        const sendStatus = (msg: string) => {
          controller.enqueue(encoder.encode(JSON.stringify({ type: "status", data: msg }) + "\n"));
        };
        const sendText = (chunk: string) => {
          controller.enqueue(encoder.encode(JSON.stringify({ type: "text", data: chunk }) + "\n"));
        };
        
        sendStatus("Initializing thinking process...");

        // Combine system instruction into the config
        const responseStream = await ai.models.generateContentStream({
          model: model,
          contents: messages,
          config: {
            systemInstruction: systemInstruction,
            // @ts-ignore - The underlying genai SDK schema types have strict enums
            tools: [
              {
                googleSearch: {}
              },
              {
                functionDeclarations: [
                  {
                    name: "earth_engine_query",
                    description: "Execute a Google Earth Engine query to generate map tiles or perform geospatial analysis.",
                    parameters: {
                      type: "OBJECT",
                      properties: {
                        taskType: {
                          type: "STRING",
                          description: "The type of task: 'generate_dem' for simple elevation maps, or 'run_custom_script' to execute an arbitrary Earth Engine script."
                        },
                        script: {
                          type: "STRING",
                          description: "If taskType is 'run_custom_script', provide the exact Node.js Earth Engine code here stringified. It must evaluate to a promise or value. Example: 'return new Promise((resolve, reject) => ee.Image(\"USGS/SRTMGL1_003\").getMap({min:0,max:3000}, (m,e) => e ? reject(e) : resolve(m.urlFormat)));'"
                        }
                      },
                      required: ["taskType"]
                    }
                  }
                ]
              }
            ]
          }
        });

        for await (const chunk of responseStream) {
          if (chunk.functionCalls && chunk.functionCalls.length > 0) {
            for (const call of chunk.functionCalls) {
              if (call.name === "earth_engine_query") {
                sendStatus("Executing Earth Engine Query...");
                try {
                  const args = call.args as any;
                  const result = await executeEarthEngineTask(args.taskType, args);
                  
                  // In a robust implementation, we would send the tool result back to the model.
                  // For simplicity in this stream, we will just output the map URL if it exists natively in our response stream.
                  sendText(`\n![Earth Engine Map Tile](${result.urlFormat || result})\n`);
                  sendStatus("Earth Engine Tool Call Complete");
                } catch (e: any) {
                  sendStatus("Earth Engine Error: " + e.message);
                }
              }
            }
          }
          if (chunk.text) {
            sendText(chunk.text);
          }
        }
        
        sendStatus("Processing complete.");
        controller.close();
      }
    });

    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson" }
    });
  } catch (error: any) {
    console.error("Chat API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
