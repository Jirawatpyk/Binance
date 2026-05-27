import type { TranslatorsConfig, SupportedLanguage } from '../types/index.js';
import { BotError } from '../core/errors.js';

export interface RRReader {
  getRRIndex(key: string): number;
}

export interface PickResult {
  translator: string;
  ruleIndex: number;
  useRoundRobin: boolean;
  rrKey?: string;
}

export class AssignmentEngine {
  constructor(private config: TranslatorsConfig, private rr: RRReader) {}

  pick(language: SupportedLanguage, wordCount: number): PickResult {
    const langConfig = this.config[language];
    if (!langConfig) {
      throw new BotError(`No translator config for language ${language}`);
    }

    // A non-finite or non-positive word count means the detail page selector
    // missed the value. Refuse to guess a tier — silently picking the first or
    // catch-all rule would mis-route the job to the wrong translator on the
    // live system. Failing loudly here surfaces selector drift instead.
    if (!Number.isFinite(wordCount) || wordCount <= 0) {
      throw new BotError(`Invalid wordCount=${wordCount} for ${language}`);
    }

    const ruleIndex = langConfig.rules.findIndex(
      (r) => r.maxWords === null || wordCount <= r.maxWords
    );
    if (ruleIndex < 0) {
      throw new BotError(`No matching rule for ${language} wordCount=${wordCount}`);
    }

    const rule = langConfig.rules[ruleIndex];
    if (rule.translators.length === 1) {
      return { translator: rule.translators[0], ruleIndex, useRoundRobin: false };
    }

    const rrKey = `${language}:rule${ruleIndex}`;
    const idx = this.rr.getRRIndex(rrKey) % rule.translators.length;
    return {
      translator: rule.translators[idx],
      ruleIndex,
      useRoundRobin: true,
      rrKey,
    };
  }
}
