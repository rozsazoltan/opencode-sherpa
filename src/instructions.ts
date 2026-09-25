const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const LANGUAGE_NAME = /^[\p{L}\p{M}]+(?:[ '-][\p{L}\p{M}]+)*$/u;

export function validateLanguage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const language = value.trim();
  if (language.length < 2 || language.length > 64) return undefined;
  if (!LANGUAGE_TAG.test(language) && !LANGUAGE_NAME.test(language)) return undefined;

  return language;
}

export function createEngineeringInstructions(languageOption: unknown): string {
  const language = validateLanguage(languageOption);
  const conversationRule = language
    ? `Use ${language} for conversation, unless the user explicitly requests translation or established project conventions call for otherwise.`
    : "Do not force a conversation language; follow the user's language unless established project conventions call for otherwise.";

  return [
    "Write new code identifiers, code comments, Git commit messages, issues, and pull requests in English.",
    `${conversationRule} Honor explicit translation requests.`,
  ].join(" ");
}
