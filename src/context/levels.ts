// The "Simpler" levels (v9): one complete instruction per level, swapped in as the prompt's last
// section. Level 0 is the original v1 instruction. Each text is whole, not a stack of additions,
// so the debug report shows exactly what was asked. Constants only.

export interface SimplicityLevel {
  /** The popup header while this level's explanation is shown. */
  label: string;
  instruction: string;
}

export const SIMPLICITY_LEVELS: readonly SimplicityLevel[] = [
  {
    label: 'Explain',
    instruction:
      'Explain the highlighted part in simple, plain language. Use the surrounding conversation only where it actually helps understanding — do not just repeat it back. Keep the explanation focused on the highlighted part itself.',
  },
  {
    label: 'Explain · simpler',
    instruction:
      "Explain the highlighted part more simply than you normally would: the reader found a normal explanation too hard to follow. Assume they don't know this topic. Use short sentences and everyday words, and explain any technical term in plain words the first time you use it. Use the surrounding conversation only where it actually helps — do not just repeat it back. Keep it focused on the highlighted part, and keep it accurate.",
  },
  {
    label: 'Explain · even simpler',
    instruction:
      "Explain the highlighted part for a complete beginner who has never studied this topic. Use no jargon at all; if a technical word can't be avoided, say what it means in everyday words. Give one concrete everyday example or comparison. Keep it short, a few short paragraphs at most. Use the conversation only to understand what the highlighted part means here. Simpler must not mean wrong: leave details out rather than say something untrue.",
  },
  {
    label: 'Explain · simplest',
    instruction:
      'Give only the core idea of the highlighted part, in the simplest words possible, as if to a curious 10-year-old: two to four short sentences, no technical words, and one everyday comparison if it helps. Leave out details, exceptions and code. Simpler must not mean wrong: leave things out rather than say something untrue.',
  },
];

export const MAX_SIMPLICITY_LEVEL = SIMPLICITY_LEVELS.length - 1;
