// Compile src/packs/<pack>/*.json into LevelDB compendia at packs/<pack>.
// Usage: npm run build   (close Foundry, or at least the world, first: LevelDB is locked while open)
import fs from "node:fs";
import path from "node:path";
import { compilePack } from "@foundryvtt/foundryvtt-cli";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "module.json"), "utf8"));

fs.rmSync(path.join(root, "packs"), { recursive: true, force: true });
let total = 0;
for (const { name } of manifest.packs) {
  let n = 0;
  await compilePack(path.join(root, "src", "packs", name), path.join(root, "packs", name), {
    log: false,
    transformEntry: () => { n++; },
  });
  total += n;
  console.log(`built packs/${name} (${n})`);
}
console.log(`${total} documents`);
