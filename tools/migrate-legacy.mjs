/**
 * One-off migration of the Foundry v9 / WFRP4e 5.x NeDB packs (legacy/*.db)
 * into Foundry v14 / WFRP4e 10.x JSON sources (src/packs/<pack>/*.json).
 *
 * Usage:
 *   node tools/migrate-legacy.mjs <core-ref-dir>
 *
 * <core-ref-dir> holds JSON extracted (with @foundryvtt/foundryvtt-cli extractPack)
 * from the installed WFRP4e system and wfrp4e-core module:
 *   core-items/ core-actors/ core-journals/  (wfrp4e-core packs)
 * It is used to (a) replace legacy trait/talent effects with the current core
 * versions where the module's item is a copy of a core item, and (b) resolve
 * links into core content. It is not committed (it's Cubicle 7 content).
 */
import fs from "node:fs";
import path from "node:path";

const MODULE_ID = "wfrp4e-laws-pet-shoppe";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const LEGACY = path.join(ROOT, "legacy");
const OUT = path.join(ROOT, "src", "packs");
const CORE = process.argv[2];
if (!CORE) throw new Error("usage: node tools/migrate-legacy.mjs <core-ref-dir>");

// legacy file -> [pack name, document type]
const PACKS = {
  "pet-bestiary.db": ["pet_bestiary", "Actor"],
  "pet-bestiary-pure.db": ["pet_bestiary_breeds", "Actor"],
  "pet-bestiary-beasts.db": ["pet_bestiary_beasts", "Actor"],
  "pet-bestiary-oceanic.db": ["pet_bestiary_oceanic", "Actor"],
  "pet-careers.db": ["pet_careers", "Item"],
  "pet-talents.db": ["pet_talents", "Item"],
  "pet-traits.db": ["pet_traits", "Item"],
  "pet-trappings.db": ["pet_trappings", "Item"],
  "pet-trappings-pure.db": ["pet_trappings_breeds", "Item"],
  "pet-rules.db": ["pet-rules", "JournalEntry"],
  "pet-career-description.db": ["pet-career-description", "JournalEntry"],
  "pet-tables.db": ["pet-tables", "RollTable"],
};
const OLD_PACK_NAME = { "pet-tables": "pet-tables", "pet_careers": "pet_careers", "pet_talents": "pet_talents" };

const warnings = [];
const warn = (m) => warnings.push(m);

/* ------------------------------------------------------------------ */
/*  Reference data                                                     */
/* ------------------------------------------------------------------ */

const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".json") ? [path.join(d, e.name)] : []);
const loadDir = (d) => walk(path.join(CORE, d)).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));

const coreItems = loadDir("core-items");
const coreActors = loadDir("core-actors");
const coreJournals = loadDir("core-journals");
const coreItemIds = new Set(coreItems.map((i) => i._id));
const coreActorIds = new Set(coreActors.map((a) => a._id));
const coreActorByName = new Map(coreActors.map((a) => [a.name.toLowerCase(), a]));
const corePageByName = new Map();
for (const j of coreJournals) {
  for (const p of j.pages ?? []) {
    const k = p.name.toLowerCase();
    if (!corePageByName.has(k)) corePageByName.set(k, `Compendium.wfrp4e-core.journals.JournalEntry.${j._id}.JournalEntryPage.${p._id}`);
  }
}
const coreJournalByName = new Map(coreJournals.map((j) => [j.name.toLowerCase(), `Compendium.wfrp4e-core.journals.JournalEntry.${j._id}`]));

const baseName = (n) => n.split("(")[0].trim().toLowerCase();

// Core trait/talent effects keyed by "type:basename". Prefer the variant core embeds
// in its own bestiary actors (that's what a pre-built creature should carry), else the item pack.
const coreEffects = new Map();
const embeddedVariants = new Map();
for (const a of coreActors) {
  for (const i of a.items ?? []) {
    if (!["trait", "talent"].includes(i.type)) continue;
    const k = `${i.type}:${baseName(i.name)}`;
    const sig = JSON.stringify(i.effects?.map((e) => [e.name, e.system?.scriptData?.map((s) => s.script), e.system?.changes]));
    const m = embeddedVariants.get(k) ?? new Map();
    const v = m.get(sig) ?? { n: 0, effects: i.effects ?? [] };
    v.n++; m.set(sig, v); embeddedVariants.set(k, m);
  }
}
for (const i of coreItems) {
  if (!["trait", "talent"].includes(i.type)) continue;
  const k = `${i.type}:${baseName(i.name)}`;
  if (!coreEffects.has(k)) coreEffects.set(k, { item: i.effects ?? [] });
}
for (const [k, m] of embeddedVariants) {
  const best = [...m.values()].sort((a, b) => b.n - a.n)[0];
  const e = coreEffects.get(k) ?? {};
  e.embedded = best.effects;
  coreEffects.set(k, e);
}

/* ------------------------------------------------------------------ */
/*  Legacy NeDB reader                                                 */
/* ------------------------------------------------------------------ */

function readNeDB(file) {
  const docs = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    if (d.$$deleted) docs.delete(d._id); else docs.set(d._id, d);
  }
  return [...docs.values()];
}

/* ------------------------------------------------------------------ */
/*  Links in HTML                                                      */
/* ------------------------------------------------------------------ */

const CORE_PACK_MAP = {
  bestiary: ["actors", "Actor"], careers: ["items", "Item"], criticals: ["items", "Item"], skills: ["items", "Item"],
  talents: ["items", "Item"], traits: ["items", "Item"], psychologies: ["items", "Item"], mutations: ["items", "Item"],
  injuries: ["items", "Item"], diseases: ["items", "Item"], spells: ["items", "Item"], prayers: ["items", "Item"],
  trappings: ["items", "Item"], "journal-entries": ["journals", "JournalEntry"],
};
const MODULE_PACK_TYPE = Object.fromEntries(Object.values(PACKS).map(([n, t]) => [n, t]));

const JOURNAL_ALIASES = { climbing: "climb" };

function migrateLinks(html, where) {
  if (typeof html !== "string" || !html.includes("@")) return html;
  return html
    .replace(/@Compendium\[([\w-]+)\.([\w-]+)\.(\w{16})\]/g, (m, mod, pack, id) => {
      if (mod === "wfrp4e-core" && CORE_PACK_MAP[pack]) {
        const [p, t] = CORE_PACK_MAP[pack];
        const ok = t === "Actor" ? coreActorIds.has(id) : t === "Item" ? coreItemIds.has(id) : true;
        if (!ok) warn(`${where}: core ${pack}.${id} no longer exists in wfrp4e-core.${p}`);
        return `@UUID[Compendium.wfrp4e-core.${p}.${t}.${id}]`;
      }
      if (mod === MODULE_ID && MODULE_PACK_TYPE[pack]) return `@UUID[Compendium.${MODULE_ID}.${pack}.${MODULE_PACK_TYPE[pack]}.${id}]`;
      warn(`${where}: unresolved ${m}`);
      return m;
    })
    .replace(/@Actor\[([^\]]+)\]/g, (m, name) => {
      const a = coreActorByName.get(name.toLowerCase());
      if (a) return `@UUID[Compendium.wfrp4e-core.actors.Actor.${a._id}]{${name}}`;
      // Not in core (other sourcebooks): keep the name as plain bold text rather than a dead link.
      warn(`${where}: ${m} not in core, left as text`); return `<strong>${name}</strong>`;
    })
    .replace(/@JournalEntry\[([^\]]+)\](\{([^}]*)\})?/g, (m, ref, _l, label) => {
      // Named refs resolve against core journal pages; bare IDs were world-only links,
      // so resolve them by their label instead.
      let key = (/^\w{16}$/.test(ref) ? label : ref)?.toLowerCase();
      key = JOURNAL_ALIASES[key] ?? key;
      const uuid = key && (corePageByName.get(key) ?? coreJournalByName.get(key));
      if (uuid) return `@UUID[${uuid}]{${label ?? ref}}`;
      warn(`${where}: unresolved ${m}`); return m;
    });
}

function migrateHtmlDeep(obj, where) {
  if (typeof obj === "string") return migrateLinks(obj, where);
  if (Array.isArray(obj)) return obj.map((v) => migrateHtmlDeep(v, where));
  if (obj && typeof obj === "object") {
    for (const k of Object.keys(obj)) obj[k] = migrateHtmlDeep(obj[k], where);
  }
  return obj;
}

/* ------------------------------------------------------------------ */
/*  Active effects                                                     */
/* ------------------------------------------------------------------ */

const CHANGE_TYPES = ["custom", "multiply", "add", "downgrade", "upgrade", "override"];
const TRIGGERS = { invoke: "manual", oneTime: "immediate", addItems: "immediate", dialogChoice: "dialog", prefillDialog: "dialog", targetPrefillDialog: "dialog" };

const emptyOpts = () => ({});

/**
 * Translate a legacy prefillDialog script of the shape
 *   if (args.type == "skill" && args.item.name.includes("X")) { args.prefillModifiers.Y += Z }
 * into a modern dialog script with activate/hide conditions.
 */
function translateDialogScript(script, label, targeter) {
  const fieldBody = (s) => s
    .replace(/args\.prefillModifiers\./g, "args.fields.")
    .replace(/this\.item\.specification\.value/g, "this.item.system.specification.value");

  const skill = script.match(/args\.type == "skill"\s*&&\s*\(?\s*args\.item\.name(?:\.includes\("([^"]+)"\)| == "([^"]+)")\s*\)?\s*\)/);
  if (skill) {
    const name = skill[1] ?? skill[2];
    const exact = !!skill[2];
    const body = script.slice(script.indexOf(skill[0]) + skill[0].length).trim().replace(/^\{|\}$/g, "").trim();
    const baseSkill = name.split(" (")[0];
    return {
      label, trigger: "dialog", script: fieldBody(body),
      options: {
        activateScript: exact ? `return args.skill?.name == "${name}"` : `return !!args.skill?.name.includes("${name}")`,
        hideScript: `return !args.skill?.name.includes("${baseSkill}")`,
        submissionScript: "", targeter,
      },
    };
  }
  const weapon = script.match(/if \(args\.type == "weapon" && args\.item\.attackType == "(\w+)"\)\s*([\s\S]+)/);
  if (weapon) {
    const t = weapon[1];
    return {
      label, trigger: "dialog", script: fieldBody(weapon[2].trim()),
      options: {
        activateScript: `return args.item?.system.attackType == "${t}"`,
        hideScript: `return args.item?.system.attackType != "${t}"`,
        submissionScript: "", targeter,
      },
    };
  }
  const cast = script.match(/if \(args\.type == "cast"\)\s*([\s\S]+)/);
  if (cast) {
    return {
      label, trigger: "dialog", script: fieldBody(cast[1].trim()),
      options: { activateScript: `return args.type == "cast"`, hideScript: `return args.type != "cast"`, submissionScript: "", targeter },
    };
  }
  return null;
}

const SCRIPT_REWRITES = [
  // v9 document data paths
  [/args\.actor\.data\.data\./g, "args.actor.system."],
  [/this\.actor\.data\.token\.name/g, "this.actor.prototypeToken.name"],
  [/\.data\.characteristic\.value/g, ".system.characteristic.value"],
  [/this\.item\.specification\.value/g, "this.item.system.specification.value"],
  [/game\.user\.updateTokenTargets\(\[\]\)/g, "game.canvas.tokens.setTargets([])"],
  [/args\.test\.preData\.canReverse = true/g, `args.test.preData.reversal = {allowed: true, if: "better"}`],
  [/@Compendium\[wfrp4e-core\.diseases\.(\w{16})\]/g, "@UUID[Compendium.wfrp4e-core.items.Item.$1]"],
];

function migrateLegacyScript(flags, effectName, where) {
  const trigger = TRIGGERS[flags.effectTrigger] ?? flags.effectTrigger;
  let script = flags.script;
  if (!trigger || (!script && flags.effectTrigger !== "dialogChoice")) return [];

  if (flags.effectTrigger === "dialogChoice") {
    const d = flags.effectData ?? {};
    return [{ label: d.description || effectName, trigger: "dialog", script: `args.fields.modifier += ${d.modifier || 0};\nargs.fields.slBonus += ${d.SLBonus || 0};\nargs.fields.successBonus += ${d.successBonus || 0};`, options: {} }];
  }

  // Special case: "Fated" granted Fate/Fortune with a v9 update call.
  if (/status\.fate\.value/.test(script) && flags.effectTrigger === "oneTime") {
    return [{
      label: effectName, trigger: "immediate",
      script: `await this.actor.update({\n  "system.status.fate.value": this.actor.system.status.fate.value + 1,\n  "system.status.fortune.value": this.actor.system.status.fortune.value + 1\n});`,
      options: { deleteEffect: false },
    }];
  }

  if (["prefillDialog", "targetPrefillDialog"].includes(flags.effectTrigger)) {
    const t = translateDialogScript(script, effectName, flags.effectTrigger === "targetPrefillDialog");
    if (t) return [t];
    warn(`${where}: could not translate dialog script, kept as always-active: ${script.slice(0, 80)}`);
  }

  for (const [re, rep] of SCRIPT_REWRITES) script = script.replace(re, rep);
  if (/\.data\.|prefillModifiers|args\.item\.name/.test(script)) warn(`${where}: script may still use legacy API: ${script.slice(0, 100)}`);
  const s = { label: effectName, trigger, script, options: {} };
  if (flags.effectTrigger === "prefillDialog") s.options.activateScript = "return true";
  if (flags.effectTrigger === "targetPrefillDialog") s.options.targeter = true;
  return [s];
}

const APPLICATION = {
  actor: { type: "document", documentType: "Actor", equipTransfer: false },
  item: { type: "document", documentType: "Item" },
  equipped: { type: "document", documentType: "Actor", equipTransfer: true },
  apply: { type: "target" },
  damage: { type: "document", documentType: "Item" },
};

function migrateEffect(e, where) {
  const flags = foundry_clone(e.flags ?? {});
  const legacy = flags.wfrp4e ?? {};
  const name = e.name ?? e.label ?? "Effect";
  const scriptData = migrateLegacyScript(legacy, name, `${where} > ${name}`);
  const transferData = { ...(APPLICATION[legacy.effectApplication] ?? { type: "document", documentType: "Actor", equipTransfer: false }) };
  if (legacy.itemChoice) transferData.filter = legacy.itemChoice;
  if (legacy.promptChoice) transferData.prompt = true;

  const wf = { ...legacy };
  for (const k of ["effectApplication", "effectTrigger", "preventDuplicateEffects", "script", "effectData", "itemChoice", "promptChoice"]) delete wf[k];
  flags.wfrp4e = wf;

  return {
    _id: e._id,
    name,
    img: e.img ?? e.icon ?? "icons/svg/aura.svg",
    type: "base",
    disabled: !!e.disabled,
    transfer: e.transfer ?? true,
    duration: { value: null, units: "seconds", expiry: null, expired: false },
    description: "",
    origin: null,
    statuses: [],
    tint: e.tint || "#ffffff",
    flags,
    system: {
      transferData,
      scriptData,
      zone: {},
      sourceData: {},
      changes: (e.changes ?? []).map((c) => ({ key: c.key.replace(/^data\./, "system."), value: Number.isNumeric?.(c.value) || /^-?\d+(\.\d+)?$/.test(String(c.value)) ? Number(c.value) : c.value, priority: c.priority ?? null, type: CHANGE_TYPES[c.mode] ?? "add" })),
    },
  };
}

function foundry_clone(o) { return JSON.parse(JSON.stringify(o)); }

/** Fresh copy of core effects for an item, re-using the legacy effect IDs where possible. */
function coreEffectsFor(item, embedded) {
  const k = `${item.type}:${baseName(item.name)}`;
  const c = coreEffects.get(k);
  if (!c) return null;
  const src = (embedded ? c.embedded : null) ?? c.item;
  return src.map((e, idx) => {
    const n = foundry_clone(e);
    delete n._key; delete n._stats; delete n.folder; delete n.sort;
    n._id = item.effects?.[idx]?._id ?? n._id;
    return n;
  });
}

// Legacy scripts that are *not* plain copies of the core trait (custom pet-breed values).
// For these we migrate the module's own script instead of swapping in core's effect.
const NON_STANDARD = [
  /args\.multiplier\.tb \+= [23]/,          // Hardy (x2 / x3) on donkeys / ponies
  /bonus\*\(this\.item\.specification/,      // Tracker scaled by rating (pure-bred hounds)
];

// The original "Swim Speed (N)" effect overwrote the creature's *land* Move/Walk/Run with its
// swimming speed (a swan walking at 3, a seal moving 5 on land). WFRP4e has no separate swim
// movement, so the trait becomes descriptive: no effect, speeds recorded in its description.
function swimSpeedDescription(item) {
  const script = (item.effects ?? []).map((e) => e.flags?.wfrp4e?.script ?? "").join("\n");
  const get = (k) => script.match(new RegExp(`move\\.${k} = (\\d+)`))?.[1];
  const [move, walk, run] = [get("value"), get("walk"), get("run")];
  if (!move) return null;
  return `<p>Swimming Movement ${move} (Walk ${walk ?? move * 2} yards, Run ${run ?? move * 4} yards). `
    + `Use these values instead of the creature's normal Movement while it is swimming; its movement on land is unchanged.</p>`;
}

function migrateEmbeddedEffects(item, embedded, where) {
  if (/^Swim Speed/.test(item.name)) return [];
  const legacyScripts = (item.effects ?? []).map((e) => e.flags?.wfrp4e?.script ?? "").join("\n");
  const custom = NON_STANDARD.some((re) => re.test(legacyScripts));
  if (!custom) {
    const core = coreEffectsFor(item, embedded);
    if (core) return core;
  }
  return (item.effects ?? []).map((e) => migrateEffect(e, where));
}

/* ------------------------------------------------------------------ */
/*  Documents                                                          */
/* ------------------------------------------------------------------ */

function ownership(p) {
  return { default: p?.default ?? 0 };
}

function stats(d, type) {
  const src = d.flags?.core?.sourceId;
  return {
    // Stamp the versions this data targets, or Foundry re-migrates every record on first load.
    coreVersion: "14.370", systemId: "wfrp4e", systemVersion: "10.1.2",
    compendiumSource: typeof src === "string" && src.startsWith("Compendium.") ? src : null,
    duplicateSource: null, exportSource: null,
  };
}

function cleanFlags(flags) {
  const f = foundry_clone(flags ?? {});
  if (f.core) { delete f.core.sourceId; if (!Object.keys(f.core).length) delete f.core; }
  delete f.exportSource;
  // v9 WFRP stored sheet settings as unscoped flags (flags.autoCalcRun etc.). Flags must be
  // namespaced by package now and Foundry strips these on load (core's own bestiary has none).
  for (const k of Object.keys(f)) if (f[k] === null || typeof f[k] !== "object" || Array.isArray(f[k])) delete f[k];
  delete f._sheetTab;
  return f;
}

function migrateItem(i, embedded, where) {
  const w = `${where}${embedded ? "/" : ""}${i.name}`;
  const out = {
    _id: i._id,
    name: i.name,
    type: i.type,
    img: i.img,
    system: foundry_clone(i.system ?? i.data ?? {}),
    effects: migrateEmbeddedEffects(i, embedded, w),
    flags: cleanFlags(i.flags),
    _stats: stats(i),
    sort: i.sort ?? 0,
  };
  if (!embedded) { out.folder = null; out.ownership = ownership(i.permission); }
  if (/^Swim Speed/.test(i.name)) {
    const desc = swimSpeedDescription(i);
    if (desc) out.system.description = { ...(out.system.description ?? {}), value: (out.system.description?.value || "") + desc };
  }
  // Magic Resistance trait now reads its rating from the specification.
  if (i.type === "trait" && baseName(i.name) === "magic resistance" && !out.system.specification?.value) {
    const n = (i.effects ?? []).map((e) => e.flags?.wfrp4e?.script?.match(/slBonus -= (\d+)/)?.[1]).find(Boolean);
    if (n) out.system.specification = { ...(out.system.specification ?? {}), value: n };
  }
  migrateHtmlDeep(out.system, w);
  return out;
}

function migrateToken(t, actor) {
  t ??= {};
  const scale = t.scale ?? 1;
  return {
    name: t.name ?? actor.name,
    displayName: t.displayName ?? 0,
    actorLink: !!t.actorLink,
    width: t.width ?? 1,
    height: t.height ?? 1,
    texture: {
      src: t.img ?? actor.img,
      scaleX: scale * (t.mirrorX ? -1 : 1),
      scaleY: scale * (t.mirrorY ? -1 : 1),
      tint: t.tint || "#ffffff",
    },
    lockRotation: !!t.lockRotation,
    rotation: t.rotation ?? 0,
    alpha: t.alpha ?? 1,
    disposition: t.disposition ?? -1,
    displayBars: t.displayBars ?? 0,
    bar1: { attribute: t.bar1?.attribute ?? "status.wounds" },
    bar2: { attribute: t.bar2?.attribute ?? null },
    randomImg: !!t.randomImg,
    sight: { enabled: !!t.vision, range: t.dimSight ?? 0, angle: t.sightAngle || 360 },
    light: {
      dim: t.dimLight ?? 0, bright: t.brightLight ?? 0, angle: t.lightAngle || 360,
      color: t.lightColor || null, alpha: t.lightAlpha ?? 0.5,
    },
    flags: t.flags ?? {},
  };
}

function migrateActor(a, where) {
  const w = `${where}:${a.name}`;
  const out = {
    _id: a._id,
    name: a.name,
    type: a.type,
    img: a.img,
    system: foundry_clone(a.system ?? a.data ?? {}),
    prototypeToken: migrateToken(a.token, a),
    items: (a.items ?? []).map((i) => migrateItem(i, true, w + " ")),
    // v9 copied every transferred item effect onto the actor (origin "Actor.x.Item.y").
    // Since v11 effects apply straight from items, so those copies would double-count.
    effects: (a.effects ?? []).filter((e) => !/\.Item\./.test(e.origin ?? "")).map((e) => migrateEffect(e, w)),
    folder: null,
    sort: a.sort ?? 0,
    ownership: ownership(a.permission),
    flags: cleanFlags(a.flags),
    _stats: stats(a),
  };
  migrateHtmlDeep(out.system, w);
  return out;
}

function migrateJournal(j, where) {
  const content = migrateLinks(j.content ?? "", `${where}:${j.name}`);
  return {
    _id: j._id,
    name: j.name,
    pages: [{
      _id: j._id, // single page per legacy entry; same id is fine (different collection)
      name: j.name,
      type: "text",
      title: { show: false, level: 1 },
      text: { format: 1, content },
      sort: 0,
      ownership: { default: -1 },
      flags: {},
    }],
    folder: null,
    sort: j.sort ?? 0,
    ownership: ownership(j.permission),
    flags: cleanFlags(j.flags),
    _stats: stats(j),
  };
}

const TABLE_KEYS = { cat: "cat-traits", dog: "dog-traits", horse: "horse-traits" };

function migrateTable(t, where) {
  const w = `${where}:${t.name}`;
  const kind = t.name.match(/:\s*(\w+)/)?.[1]?.toLowerCase();
  const flags = cleanFlags(t.flags);
  flags.wfrp4e = { ...(flags.wfrp4e ?? {}), key: flags.wfrp4e?.key || TABLE_KEYS[kind] || "" };
  if (!flags.wfrp4e.key) warn(`${w}: no table key`);
  return {
    _id: t._id,
    name: t.name,
    img: t.img,
    description: migrateLinks(t.description ?? "", w),
    formula: t.formula,
    replacement: t.replacement ?? true,
    displayRoll: t.displayRoll ?? true,
    results: (t.results ?? []).map((r) => {
      const res = {
        _id: r._id, weight: r.weight ?? 1, range: r.range, drawn: !!r.drawn, flags: r.flags ?? {},
        img: r.img ?? r.icon ?? null, name: r.text ?? "", description: "",
      };
      if (r.type === 2 || r.type === 1) {
        const [mod, pack] = (r.collection ?? "").split(".");
        let uuid = null;
        if (r.type === 2 && mod === "wfrp4e-core" && CORE_PACK_MAP[pack]) {
          const [p, ty] = CORE_PACK_MAP[pack];
          if (!(ty === "Item" ? coreItemIds : coreActorIds).has(r.resultId)) warn(`${w}: table result ${r.text} -> ${r.resultId} missing from core`);
          uuid = `Compendium.wfrp4e-core.${p}.${ty}.${r.resultId}`;
        } else if (mod === MODULE_ID && MODULE_PACK_TYPE[pack]) {
          uuid = `Compendium.${MODULE_ID}.${pack}.${MODULE_PACK_TYPE[pack]}.${r.resultId}`;
        } else warn(`${w}: unhandled result collection ${r.collection}`);
        Object.assign(res, { type: "document", documentUuid: uuid });
      } else {
        Object.assign(res, { type: "text", description: migrateLinks(r.text ?? "", w) });
      }
      return res;
    }),
    folder: null,
    sort: t.sort ?? 0,
    ownership: ownership(t.permission),
    flags,
    _stats: stats(t),
  };
}

/* ------------------------------------------------------------------ */
/*  Run                                                                */
/* ------------------------------------------------------------------ */

// foundryvtt-cli source format: every (embedded) document carries its LevelDB key.
const COLLECTION = { Actor: "actors", Item: "items", JournalEntry: "journal", RollTable: "tables" };
const EMBEDDED = { actors: ["items", "effects"], items: ["effects"], journal: ["pages"], tables: ["results"] };
function assignKeys(doc, collection, idPath = [doc._id]) {
  doc._key = `!${collection}!${idPath.join(".")}`;
  for (const field of EMBEDDED[collection.split(".").pop()] ?? []) {
    for (const child of doc[field] ?? []) assignKeys(child, `${collection}.${field}`, [...idPath, child._id]);
  }
  return doc;
}

const slug = (s) => s.replace(/[^\w-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");

fs.rmSync(OUT, { recursive: true, force: true });
for (const [file, [pack, type]] of Object.entries(PACKS)) {
  const docs = readNeDB(path.join(LEGACY, file));
  const dir = path.join(OUT, pack);
  fs.mkdirSync(dir, { recursive: true });
  for (const d of docs) {
    const m = type === "Actor" ? migrateActor(d, pack)
      : type === "Item" ? migrateItem(d, false, `${pack}:`)
      : type === "JournalEntry" ? migrateJournal(d, pack)
      : migrateTable(d, pack);
    assignKeys(m, COLLECTION[type]);
    fs.writeFileSync(path.join(dir, `${slug(m.name)}_${m._id}.json`), JSON.stringify(m, null, 2) + "\n");
  }
  console.log(`${pack.padEnd(24)} ${docs.length} ${type}`);
}
const uniq = [...new Set(warnings)];
console.log(`\n${uniq.length} warnings`);
for (const w of uniq) console.log(" - " + w);
