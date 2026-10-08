import { setTimeout as sleep } from "node:timers/promises";

const CORDIS =
  "file:///C:/Users/\u5f90\u6bc5\u9633/AppData/Local/Programs/DSH NEXT/resources/app/node_modules/@deepseek-ai/cordis/lib/index.js";
const cordis = await import(CORDIS);
const Context = cordis.Context;

const root = new Context();

console.log("=== 1. bare root ===");
console.log("  root.on:", typeof root.on, "| root.emit:", typeof root.emit, "| root.waterfall:", typeof root.waterfall);

const child = root.extend({});
console.log("\n=== 2. root.extend({}) (what the loader gives each plugin) ===");
console.log("  child.on:", typeof child.on, "| child.events:", typeof child.events, "| child.logger:", typeof child.logger);

const observed = {};
const plugin = {
  name: "cordis-local-test",
  apply(ctx) {
    observed.on = typeof ctx.on;
    observed.emit = typeof ctx.emit;
    observed.waterfall = typeof ctx.waterfall;
    observed.events = typeof ctx.events;
    observed.eventsOn = typeof ctx.events?.on;
    observed.logger = typeof ctx.logger;
    observed.ownKeys = Object.keys(ctx).slice(0, 10);
  },
};

console.log("\n=== 3. loading a plugin and awaiting its fiber ===");
let reg;
try {
  reg = root.registry.plugin(plugin, {}, () => []);
  await reg.ctx.fiber.await();
} catch (error) {
  console.log("  load error:", error.message);
}
await sleep(10);
console.log(JSON.stringify(observed, null, 2));

console.log("\n=== 4. the plugin fiber's ctx ===");
if (reg) {
  const pctx = reg.ctx.fiber.ctx;
  console.log("  fiber.ctx.on:", typeof pctx?.on, "| fiber.ctx.events:", typeof pctx?.events);
}
