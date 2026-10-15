/**
 * Programmatic API. Use the interpreter alone to render captured ESC/POS bytes
 * (e.g. in your own tests), or run emulated printers and the viewer in-process.
 */
export { EscPosPrinter, type PrinterOptions } from "./core/interpreter.js";
export { PROFILES, resolveProfile, type ProfileSelector } from "./core/profiles.js";
export type * from "./core/types.js";
export {
  loadConfig,
  parsePrinterSpec,
  type Config,
  type ConfigFile,
  type PrinterConfig,
  type ResolvedPrinterConfig,
} from "./server/config.js";
export { EmulatedPrinter } from "./server/printer-server.js";
export { JobStore } from "./server/store.js";
export { startWebServer, type WebServerOptions } from "./server/web-server.js";
