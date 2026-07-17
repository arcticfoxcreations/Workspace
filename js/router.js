// Figures out WHO should answer a message: a specific @mentioned AI,
// or the auto-routing heuristic across whichever AIs are active.

const DEFAULT_NICKNAMES = {
  gemini: 'Gemini',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  githubmodels: 'GitHub Models',
  mistral: 'Mistral',
  cerebras: 'Cerebras',
  anthropic: 'Claude',
  openai: 'GPT',
  deepseek: 'DeepSeek'
};

// Providers that are safe to auto-route to by default (recurring free tiers).
// Claude/GPT/DeepSeek stay opt-in via @mention since their free access is one-time.
const DEFAULT_AUTO_PROVIDERS = ['gemini', 'groq', 'openrouter'];

const Router = {
  // Detects "hey X, from now call you Y" / "call you Y" style rename commands.
  detectRename(text, nicknames) {
    const renameMatch = text.match(/call\s+you\s+([a-zA-Z0-9_ ]{2,20})/i);
    if (!renameMatch) return null;
    // find which provider they were addressing before the rename phrase
    const before = text.slice(0, renameMatch.index);
    const target = Router.findMentionedProvider(before, nicknames) || Router.findMentionedProvider(text, nicknames);
    if (!target) return null;
    return { providerId: target, newNickname: renameMatch[1].trim() };
  },

  // Finds a provider id whose nickname is @mentioned in the text.
  findMentionedProvider(text, nicknames) {
    const atMatch = text.match(/@([a-zA-Z0-9_]+)/);
    const needle = atMatch ? atMatch[1].toLowerCase() : null;

    // also allow "hey <nickname>" without the @ symbol, since that's how
    // people naturally type it
    const heyMatch = text.match(/\bhey[, ]+([a-zA-Z0-9_]+)/i);
    const heyNeedle = heyMatch ? heyMatch[1].toLowerCase() : null;

    for (const [id, nick] of Object.entries(nicknames)) {
      const n = nick.toLowerCase().replace(/\s+/g, '');
      if (needle && n === needle) return id;
      if (heyNeedle && n === heyNeedle) return id;
    }
    return null;
  },

  // Very light heuristic - no extra API call, just keyword matching.
  guessBestForTask(text) {
    const t = text.toLowerCase();
    const codeWords = ['code', 'bug', 'error', 'function', 'python', 'javascript', 'debug',
      'syntax', 'algorithm', 'compile', 'stack trace', 'exception', 'refactor'];
    const researchWords = ['research', 'source', 'cite', 'latest', 'according to', 'news',
      'current', 'study', 'paper', 'statistics'];

    if (codeWords.some(w => t.includes(w))) return ['groq', 'openrouter'];
    if (researchWords.some(w => t.includes(w))) return ['gemini'];
    return ['gemini'];
  },

  // Main entry point: given the raw message + current settings, decide who answers.
  resolveTargets(text, { nicknames, mode, autoProviders }) {
    const mentioned = Router.findMentionedProvider(text, nicknames);
    if (mentioned) return { targets: [mentioned], isManualMention: true };

    const lineup = (autoProviders && autoProviders.length) ? autoProviders : DEFAULT_AUTO_PROVIDERS;

    if (mode === 'auto') {
      const guess = Router.guessBestForTask(text).filter(id => lineup.includes(id));
      return { targets: guess.length ? guess : [lineup[0]], isManualMention: false };
    }
    // manual mode with no mention falls back to whatever's marked active
    return { targets: [lineup[0]], isManualMention: false };
  },

  // A "hard problem" nudge for coding-heavy asks, per the plan we agreed on.
  looksLikeHardProblem(text) {
    const t = text.toLowerCase();
    const hardSignals = ['not working and i don\'t know why', 'architecture', 'refactor the whole',
      'multi-file', 'race condition', 'memory leak', 'been stuck'];
    return hardSignals.some(w => t.includes(w)) || text.length > 600;
  }
};
