/**
 * Windy Chat — Social Post Profanity Filter
 * K10: Content moderation for social posts (DNA Strand K)
 *
 * Extended version of the onboarding profanity filter, tuned for post content.
 * Checks post text for profanity and returns filtered results.
 */

const PROFANITY_LIST = new Set([
  'ass', 'asshole', 'bastard', 'bitch', 'bollocks', 'bullshit',
  'cock', 'crap', 'cunt', 'damn', 'dick', 'douche', 'dumbass',
  'fag', 'faggot', 'fuck', 'fucker', 'fucking', 'goddamn',
  'hell', 'jackass', 'motherfucker', 'nigger', 'nigga',
  'piss', 'prick', 'pussy', 'shit', 'shithead', 'slut',
  'twat', 'whore', 'wanker',
]);

/**
 * Check if text contains profanity.
 * @param {string} text
 * @returns {{ hasProfanity: boolean, matched: string[] }}
 */
function checkProfanity(text) {
  if (!text || typeof text !== 'string') return { hasProfanity: false, matched: [] };

  const lower = text.toLowerCase();
  const words = lower.split(/[\s_\-.,!?;:'"()\[\]{}]+/).filter(Boolean);
  const matched = [];

  for (const word of words) {
    if (PROFANITY_LIST.has(word)) matched.push(word);
  }

  // Leet-speak normalization pass
  if (matched.length === 0) {
    const normalized = lower
      .replace(/0/g, 'o')
      .replace(/1/g, 'i')
      .replace(/3/g, 'e')
      .replace(/4/g, 'a')
      .replace(/5/g, 's')
      .replace(/7/g, 't')
      .replace(/@/g, 'a')
      .replace(/\$/g, 's');

    const normalizedWords = normalized.split(/[\s_\-.,!?;:'"()\[\]{}]+/).filter(Boolean);
    for (const word of normalizedWords) {
      if (PROFANITY_LIST.has(word)) matched.push(word);
    }
  }

  return { hasProfanity: matched.length > 0, matched: [...new Set(matched)] };
}

module.exports = { checkProfanity, PROFANITY_LIST };
