import { ADMIN_MODULES, MODULE_LAYER_OPTIONS, PERMISSION_LAYERS, EXPLICIT_ONLY_LAYERS, PERMISSION_LAYER_MODULES } from "/home/user/CredenceHR/src/types";
const out: string[] = [];
out.push("| মডিউল (Admin Panel) | কী | layer / অনুমতির ধাপ (🔒 = ডিফল্টে বন্ধ, Superadmin টিক দিলে তবেই) |", "|---|---|---|");
for (const m of ADMIN_MODULES) {
  const layers = (MODULE_LAYER_OPTIONS as any)[m.key] || (PERMISSION_LAYER_MODULES.includes(m.key as any) ? PERMISSION_LAYERS : null);
  const txt = layers ? layers.map((l: any) => `${EXPLICIT_ONLY_LAYERS.includes(l.key) ? "🔒" : ""}\`${l.key}\` ${l.label}`).join("<br>") : "শুধু মডিউলের অনুমতি (layer নেই)";
  out.push(`| ${m.label} | \`${m.key}\` | ${txt} |`);
}
console.log(out.join("\n"));
console.error(ADMIN_MODULES.length, "modules");
