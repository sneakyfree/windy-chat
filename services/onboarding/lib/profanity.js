/**
 * Windy Chat — Basic Profanity Filter
 * K2.2.1: Name Validation — profanity filter (DNA Strand K)
 *
 * Uses a basic open-source word list to catch obvious profanity
 * in display names. This is intentionally conservative — we'd
 * rather let borderline names through than frustrate legitimate
 * international users.
 *
 * NOT used for message filtering (that's a different concern).
 * ONLY used for display name validation during onboarding.
 */

// Basic profanity word list (English)
// Kept minimal to avoid false positives with international names.
// In production, use a proper library like 'bad-words' or 'leo-profanity'.
const PROFANITY_LIST = new Set([
  'ass', 'asshole', 'bastard', 'bitch', 'bollocks', 'bullshit',
  'cock', 'crap', 'cunt', 'damn', 'dick', 'douche', 'dumbass',
  'fag', 'faggot', 'fuck', 'fucker', 'fucking', 'goddamn',
  'hell', 'jackass', 'motherfucker', 'nigger', 'nigga',
  'piss', 'prick', 'pussy', 'shit', 'shithead', 'slut',
  'twat', 'whore', 'wanker',
]);

// Patterns that should be blocked in display names
const BLOCKED_PATTERNS = [
  /admin/i,          // Impersonation prevention
  /moderator/i,
  /windypro/i,       // Brand impersonation
  /windy\s*chat/i,
  /support/i,
  /official/i,
  /system/i,
  /\bbot\b/i,
];

/**
 * Check if a display name contains profanity or blocked patterns.
 *
 * @param {string} name - The display name to check
 * @returns {boolean} true if profanity/blocked pattern detected
 */
function checkProfanity(name) {
  if (!name || typeof name !== 'string') return false;

  const lower = name.toLowerCase().trim();

  // Check exact word matches
  const words = lower.split(/[\s_\-.]+/);
  for (const word of words) {
    if (PROFANITY_LIST.has(word)) {
      return true;
    }
  }

  // Check for leet-speak common substitutions
  const normalized = lower
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's');

  const normalizedWords = normalized.split(/[\s_\-.]+/);
  for (const word of normalizedWords) {
    if (PROFANITY_LIST.has(word)) {
      return true;
    }
  }

  // Check blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(name)) {
      return true;
    }
  }

  return false;
}

module.exports = { checkProfanity, PROFANITY_LIST, BLOCKED_PATTERNS };
