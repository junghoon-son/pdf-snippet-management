// Group templates — pre-defined sets of groups for common reading domains.
// Each template references palette slots (0..7) rather than hex colors so the
// applied groups inherit the active theme's palette and stay legible across
// theme switches.
//
// Adding a template is just a matter of dropping a new entry into this array.
// The slot numbers cycle 0..7 deterministically; ordering matters for visual
// distinctness within a template.

export const GROUP_TEMPLATES = [
  {
    id: "academic",
    name: "Academic / Research",
    description: "Lit review, paper reading, thesis writing",
    groups: [
      { name: "Hypothesis",      slot: 0 },
      { name: "Method",          slot: 1 },
      { name: "Result",          slot: 2 },
      { name: "Discussion",      slot: 3 },
      { name: "Limitation",      slot: 6 },
      { name: "Citation",        slot: 4 },
      { name: "Counter-evidence",slot: 7 },
      { name: "Future work",     slot: 5 },
    ],
  },
  {
    id: "medical-writing",
    name: "Medical Writing",
    description: "Clinical study reports, regulatory submissions",
    groups: [
      { name: "Endpoint",            slot: 1 },
      { name: "Inclusion criteria",  slot: 5 },
      { name: "Exclusion criteria",  slot: 6 },
      { name: "Adverse event",       slot: 0 },
      { name: "Efficacy",            slot: 2 },
      { name: "Safety",              slot: 7 },
      { name: "Dose / PK",           slot: 3 },
      { name: "Statistics",          slot: 4 },
    ],
  },
  {
    id: "regulatory",
    name: "Regulatory Affairs",
    description: "FDA / EMA submissions, compliance reviews",
    groups: [
      { name: "Guidance reference", slot: 2 },
      { name: "Compliance issue",   slot: 0 },
      { name: "Safety signal",      slot: 6 },
      { name: "Manufacturing / CMC",slot: 3 },
      { name: "Quality",            slot: 5 },
      { name: "Submission item",    slot: 1 },
      { name: "Open question",      slot: 7 },
    ],
  },
  {
    id: "legal",
    name: "Legal / Case Reading",
    description: "Case law, statutes, contracts",
    groups: [
      { name: "Holding",          slot: 1 },
      { name: "Reasoning",        slot: 4 },
      { name: "Dicta",            slot: 5 },
      { name: "Precedent cited",  slot: 2 },
      { name: "Statute",          slot: 3 },
      { name: "Counter-argument", slot: 0 },
      { name: "Issue",            slot: 6 },
      { name: "Rule",             slot: 7 },
    ],
  },
  {
    id: "software",
    name: "Software / Engineering",
    description: "RFCs, design docs, code reviews",
    groups: [
      { name: "Bug",          slot: 0 },
      { name: "Feature",      slot: 1 },
      { name: "Performance",  slot: 4 },
      { name: "Security",     slot: 6 },
      { name: "API",          slot: 2 },
      { name: "Architecture", slot: 5 },
      { name: "TODO",         slot: 3 },
      { name: "Question",     slot: 7 },
    ],
  },
  {
    id: "investment",
    name: "Investment / Analysis",
    description: "10-Ks, research reports, memos",
    groups: [
      { name: "Thesis",         slot: 1 },
      { name: "Risk",           slot: 0 },
      { name: "Catalyst",       slot: 5 },
      { name: "Comparable",     slot: 2 },
      { name: "Cash flow",      slot: 3 },
      { name: "Management",     slot: 4 },
      { name: "Macro",          slot: 6 },
      { name: "Counter-thesis", slot: 7 },
    ],
  },
  {
    id: "journalism",
    name: "Journalism / Reporting",
    description: "Source vetting, story building",
    groups: [
      { name: "Source",        slot: 1 },
      { name: "Quote",         slot: 4 },
      { name: "Background",    slot: 5 },
      { name: "Conflict",      slot: 0 },
      { name: "Timeline",      slot: 2 },
      { name: "Verification",  slot: 3 },
      { name: "Lead",          slot: 7 },
    ],
  },
  {
    id: "general",
    name: "General Reading",
    description: "Books, blogs, mixed reading",
    groups: [
      { name: "Quote",        slot: 4 },
      { name: "Question",     slot: 7 },
      { name: "Insight",      slot: 1 },
      { name: "Disagreement", slot: 0 },
      { name: "Connection",   slot: 5 },
      { name: "Reference",    slot: 2 },
    ],
  },
];

export function findTemplate(id) {
  return GROUP_TEMPLATES.find((t) => t.id === id) || null;
}
