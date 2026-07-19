/**
 * windy.panel.v1 — slider metadata for the Type-B cloud agent.
 *
 * The 8 supported sliders are the subset of windy-agent's 19 that can
 * honestly act on a prompt+params midwife (DASHBOARD_API_CONTRACT.md §2.4).
 * label/description/impact strings are copied VERBATIM from windy-agent
 * src/windyfly/control_panel.py SLIDER_INFO — grandma-facing copy is not
 * rewritten here. cost_per_point is 0 for all: midwife compute is
 * house-borne.
 *
 * Slider values are ints 0–10. 5 is the default everywhere; only
 * non-default values are stored (a missing key = today's exact midwife
 * behavior, the zero-risk default).
 */
'use strict';

const DEFAULT_VALUE = 5;

const SLIDER_INFO = {
  personality: {
    label: 'Personality',
    description: 'How much warmth, character, and soul the agent puts into responses.',
    impact_low: 'Robotic, clinical responses. Zero flair. Saves ~3% of tokens.',
    impact_high: 'Full SOUL.md personality, warm, human-like. Costs ~3% more tokens on personality injection.',
  },
  humor: {
    label: 'Humor',
    description: 'How much humor, wit, and playfulness the agent brings.',
    impact_low: 'Stick-in-the-mud. No jokes, no riffing. Pure business.',
    impact_high: 'Jim Carrey energy. Cracks jokes, riffs on your style, keeps it fun. Minimal extra token cost.',
  },
  warmth: {
    label: 'Warmth',
    description: 'How emotionally warm and supportive the agent is.',
    impact_low: 'Clinical, detached. Facts only.',
    impact_high: 'Warm, caring, empathetic. Like a close friend.',
  },
  formality: {
    label: 'Formality',
    description: 'Tone register — from casual texting to boardroom professional.',
    impact_low: '"yo what\'s good" — relaxed, slang-friendly, abbreviations.',
    impact_high: '"Dear esteemed colleague" — proper grammar, no contractions, corporate-ready.',
  },
  verbosity: {
    label: 'Verbosity',
    description: 'Response style — from terse one-liners to thorough explanations.',
    impact_low: 'Bullet points and one-liners. Maximum density.',
    impact_high: 'Rich, detailed responses with examples and context. ~30% more tokens.',
  },
  proactivity: {
    label: 'Proactivity',
    description: "Whether the agent volunteers ideas or only answers what's asked.",
    impact_low: 'Only answers your exact question. Never suggests, never nudges.',
    impact_high: 'Actively suggests ideas, flags things you might have missed, anticipates your needs.',
  },
  creativity: {
    label: 'Creativity',
    description: 'Controls LLM temperature — how predictable vs. imaginative responses are.',
    impact_low: 'Precise, deterministic. Same question = same answer. Best for code and facts.',
    impact_high: 'Wild, varied, surprising responses. Great for brainstorming. May hallucinate more.',
  },
  response_length: {
    label: 'Response Length',
    description: 'Hard cap on how long each response can be (token limit).',
    impact_low: '250 token cap (~2 paragraphs max). Fast and cheap.',
    impact_high: '4,000 token cap (~3 pages). Full essays when needed. Directly scales cost.',
  },
};

const SUPPORTED_SLIDERS = Object.keys(SLIDER_INFO);

// The gateway backend's real 8 presets (windy-agent control_panel.py
// PRESETS), restricted to the supported sliders. Kept server-side only to
// compute /summary's personality.preset label — presets are APPLIED
// client-side as sequential PUTs (§2.5), there is no preset endpoint.
const PRESETS = {
  buddy:      { personality: 8, humor: 7, warmth: 7, formality: 4, verbosity: 6, proactivity: 7, creativity: 6, response_length: 5 },
  engineer:   { personality: 3, humor: 1, warmth: 3, formality: 5, verbosity: 4, proactivity: 3, creativity: 3, response_length: 7 },
  powerhouse: { personality: 9, humor: 7, warmth: 7, formality: 5, verbosity: 7, proactivity: 8, creativity: 7, response_length: 9 },
  coder:      { personality: 1, humor: 0, warmth: 1, formality: 2, verbosity: 3, proactivity: 3, creativity: 4, response_length: 10 },
  friend:     { personality: 10, humor: 3, warmth: 10, formality: 2, verbosity: 7, proactivity: 8, creativity: 5, response_length: 6 },
  writer:     { personality: 7, humor: 5, warmth: 6, formality: 5, verbosity: 9, proactivity: 6, creativity: 10, response_length: 9 },
  researcher: { personality: 2, humor: 0, warmth: 2, formality: 7, verbosity: 7, proactivity: 5, creativity: 3, response_length: 8 },
  silent:     { personality: 1, humor: 0, warmth: 3, formality: 5, verbosity: 1, proactivity: 1, creativity: 3, response_length: 2 },
};

/** Fill defaults so callers always see all 8 sliders. */
function withDefaults(stored) {
  const out = {};
  for (const name of SUPPORTED_SLIDERS) {
    const v = stored && Number.isInteger(stored[name]) ? stored[name] : DEFAULT_VALUE;
    out[name] = v;
  }
  return out;
}

/** Which preset (if any) exactly matches the current values. */
function matchPreset(sliders) {
  const full = withDefaults(sliders);
  for (const [name, values] of Object.entries(PRESETS)) {
    if (SUPPORTED_SLIDERS.every((k) => full[k] === values[k])) return name;
  }
  return 'custom';
}

module.exports = {
  DEFAULT_VALUE,
  SLIDER_INFO,
  SUPPORTED_SLIDERS,
  PRESETS,
  withDefaults,
  matchPreset,
};
