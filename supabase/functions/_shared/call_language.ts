// The language the voice agent opens a call in: the business's local language, from the
// state Google Maps gives for it, except in the four metros where English is the norm.
// The agent still follows the business if they answer in another language
// (agent/instructions.md); this only picks its first words. A business with no known
// state (a web number, one the user gave) opens in the Sarvam app's default.
//
// The state is read by its code (Places' shortText for administrative_area_level_1, the
// ISO 3166-2:IN code), which stays the same when a state's name changes: Google now says
// "Keralam", and the code is still KL. The name is the fallback, for businesses saved before
// codes were kept (0030). A state in India that matches neither is a gap, which dial.ts
// reports rather than silently opening in the default.
import type { Language } from "./sarvam.ts";

// Places locality names, lower case. Delhi is a state too (see below).
const METROS = new Set(["mumbai", "bengaluru", "bangalore", "delhi", "new delhi", "pune"]);

// ISO 3166-2:IN codes, with the earlier code where ISO changed one (TS, OR, UT, CT), since
// Google may give either. Delhi (DL) is a metro.
const STATE_CODE_LANGUAGE: Record<string, Language> = {
  AP: "Telugu",
  TG: "Telugu",
  TS: "Telugu",
  AS: "Assamese",
  WB: "Bengali",
  TR: "Bengali",
  GJ: "Gujarati",
  DH: "Gujarati",
  KA: "Kannada",
  KL: "Malayalam",
  LD: "Malayalam",
  MH: "Marathi",
  OD: "Odia",
  OR: "Odia",
  PB: "Punjabi",
  TN: "Tamil",
  PY: "Tamil",
  BR: "Hindi",
  CH: "Hindi",
  CG: "Hindi",
  CT: "Hindi",
  HR: "Hindi",
  HP: "Hindi",
  JH: "Hindi",
  MP: "Hindi",
  RJ: "Hindi",
  UP: "Hindi",
  UK: "Hindi",
  UT: "Hindi",
  JK: "Hindi",
  AN: "Hindi",
};

// Places administrative_area_level_1 names, lower case, with older spellings. States
// whose language Sarvam doesn't speak (Goa, most of the North East) are left out.
const STATE_LANGUAGE: Record<string, Language> = {
  "andhra pradesh": "Telugu",
  "telangana": "Telugu",
  "assam": "Assamese",
  "west bengal": "Bengali",
  "tripura": "Bengali",
  "gujarat": "Gujarati",
  "dadra and nagar haveli and daman and diu": "Gujarati",
  "karnataka": "Kannada",
  "kerala": "Malayalam",
  "lakshadweep": "Malayalam",
  "maharashtra": "Marathi",
  "odisha": "Odia",
  "orissa": "Odia",
  "punjab": "Punjabi",
  "tamil nadu": "Tamil",
  "puducherry": "Tamil",
  "pondicherry": "Tamil",
  "bihar": "Hindi",
  "chandigarh": "Hindi",
  "chhattisgarh": "Hindi",
  "haryana": "Hindi",
  "himachal pradesh": "Hindi",
  "jharkhand": "Hindi",
  "madhya pradesh": "Hindi",
  "rajasthan": "Hindi",
  "uttar pradesh": "Hindi",
  "uttarakhand": "Hindi",
  "jammu and kashmir": "Hindi",
  "andaman and nicobar islands": "Hindi",
};

export function openingLanguage(
  city: string | null,
  state: string | null,
  stateCode: string | null = null,
): Language | undefined {
  const c = norm(city);
  const s = norm(state);
  const code = (stateCode ?? "").trim().toUpperCase();
  if (METROS.has(c) || code === "DL" || s === "delhi") return "English";
  return STATE_CODE_LANGUAGE[code] ?? STATE_LANGUAGE[s];
}

// Sarvam speaks no language of these, so the app's default is the intended opening there,
// not a gap: Goa and the North East apart from Assam and Tripura.
const NO_SARVAM_LANGUAGE = new Set(["GA", "AR", "MN", "ML", "MZ", "NL", "SK", "LA"]);

// A state was given but the call opens in the default anyway, not because Sarvam lacks the
// language: a state code nothing knows, or a name-only row (saved before 0030) that didn't
// match. Reported (dial.ts), never guessed at.
export function languageGap(city: string | null, state: string | null, stateCode: string | null): boolean {
  const code = (stateCode ?? "").trim().toUpperCase();
  if (!norm(state) && !code) return false;
  if (openingLanguage(city, state, stateCode)) return false;
  return !NO_SARVAM_LANGUAGE.has(code);
}

const norm = (v: string | null) => (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
