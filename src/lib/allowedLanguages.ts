// Explicit whitelist of supported BCP-47 codes.
// Prevents prompt injection via crafted language strings and keeps the set
// to languages the underlying STT and LLM models actually handle well.
// Add codes here when a new locale is supported by the Android app.
export const ALLOWED_LANGUAGES = new Set([
  // English
  'en', 'en-US', 'en-GB', 'en-AU', 'en-NZ', 'en-IN',
  // Dutch
  'nl', 'nl-NL', 'nl-BE',
  // German
  'de', 'de-DE', 'de-AT', 'de-CH',
  // French
  'fr', 'fr-FR', 'fr-BE', 'fr-CA', 'fr-CH',
  // Spanish
  'es', 'es-ES', 'es-MX', 'es-AR', 'es-US', 'es-419',
  // Italian
  'it', 'it-IT',
  // Portuguese
  'pt', 'pt-PT', 'pt-BR',
  // Japanese
  'ja', 'ja-JP',
  // Chinese
  'zh', 'zh-CN', 'zh-TW', 'zh-HK',
  // Korean
  'ko', 'ko-KR',
  // Russian
  'ru', 'ru-RU',
  // Polish
  'pl', 'pl-PL',
  // Turkish
  'tr', 'tr-TR',
  // Swedish
  'sv', 'sv-SE',
  // Danish
  'da', 'da-DK',
  // Finnish
  'fi', 'fi-FI',
  // Norwegian
  'nb', 'nb-NO', 'no',
  // Arabic
  'ar', 'ar-SA', 'ar-AE',
  // Hindi
  'hi', 'hi-IN',
  // Indonesian
  'id', 'id-ID',
  // Malay
  'ms', 'ms-MY',
  // Thai
  'th', 'th-TH',
  // Ukrainian
  'uk', 'uk-UA',
  // Czech
  'cs', 'cs-CZ',
  // Slovak
  'sk', 'sk-SK',
  // Romanian
  'ro', 'ro-RO',
  // Hungarian
  'hu', 'hu-HU',
  // Bulgarian
  'bg', 'bg-BG',
  // Croatian
  'hr', 'hr-HR',
  // Greek
  'el', 'el-GR',
  // Hebrew
  'he', 'he-IL',
  // Vietnamese
  'vi', 'vi-VN',
  // Catalan
  'ca', 'ca-ES',
]);
