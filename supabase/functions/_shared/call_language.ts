// The language the voice agent opens a call in: the business's local language, from the
// state Google Maps gives for it, except in the four metros where English is the norm.
// The agent still follows the business if they answer in another language
// (agent/instructions.md); this only picks its first words. A business with no known
// state (a web number, one the user gave) opens in the Sarvam app's default.
import type { Language } from "./sarvam.ts";

// Places locality names, lower case. Delhi is a state too (see below).
const METROS = new Set(["mumbai", "bengaluru", "bangalore", "delhi", "new delhi", "pune"]);

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

export function openingLanguage(city: string | null, state: string | null): Language | undefined {
  const c = norm(city);
  const s = norm(state);
  if (METROS.has(c) || s === "delhi") return "English";
  return STATE_LANGUAGE[s];
}

const norm = (v: string | null) => (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
