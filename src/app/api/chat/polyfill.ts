import { File as NodeFile } from "node:buffer";

if (typeof globalThis.File === "undefined") {
  globalThis.File = NodeFile as any;
}
