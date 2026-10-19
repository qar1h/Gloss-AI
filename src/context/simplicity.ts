// The "Simpler" button (v9): the same prompt with a simpler instruction. Only the last section
// (`task`) is swapped; every section before it, and so every excerpt and message number, is the
// level-0 prompt byte for byte. Retrieval and assembly are not re-run, and the budget is not
// re-applied: a longer instruction may take the prompt a few tokens over it, which the report says.
// Pure.

import { MAX_SIMPLICITY_LEVEL, SIMPLICITY_LEVELS } from './levels';
import { joinSections } from './render';
import { estimateTokens } from './tokens';
import type { AssembledPrompt } from './types';

export function promptAtLevel(base: AssembledPrompt, level: number): AssembledPrompt {
  if (!Number.isInteger(level) || level < 0 || level > MAX_SIMPLICITY_LEVEL) {
    throw new RangeError(`simplicity level must be a whole number from 0 to ${MAX_SIMPLICITY_LEVEL}, got ${level}`);
  }
  if (base.report.simplicityLevel !== 0) {
    throw new Error('promptAtLevel takes the level-0 prompt, so levels never stack');
  }
  const taskIndex = base.sections.findIndex((s) => s.name === 'task');
  if (taskIndex === -1) throw new Error('the prompt has no task section to swap');
  if (level === 0) return base;

  const sections = base.sections.map((s, i) =>
    i === taskIndex ? { name: s.name, text: SIMPLICITY_LEVELS[level]!.instruction } : s,
  );
  const prompt = joinSections(sections);
  const totalEstTokens = estimateTokens(prompt);
  const extra = totalEstTokens - base.report.totalEstTokens;
  const { budgetTokens } = base.report;

  const warnings = [...base.report.warnings];
  if (totalEstTokens > budgetTokens && base.report.totalEstTokens <= budgetTokens) {
    warnings.push(
      `level ${level} instruction adds ≈${extra} est. tokens, so the prompt (≈${totalEstTokens}) is over the ${budgetTokens} budget; allowed on purpose: the excerpts are kept exactly as chosen at level 0`,
    );
  }

  return {
    prompt,
    sections,
    report: {
      ...base.report,
      totalEstTokens,
      // The instruction is part of the always-include material, so its extra length counts there too.
      fixedEstTokens: base.report.fixedEstTokens + extra,
      sections: sections.map((s) => ({ name: s.name, estTokens: estimateTokens(s.text) })),
      warnings,
      simplicityLevel: level,
      levelExtraTokens: extra,
    },
  };
}
