import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { languageGap, openingLanguage } from "./call_language.ts";

Deno.test("the four metros open in English", () => {
  assertEquals(openingLanguage("Mumbai", "Maharashtra"), "English");
  assertEquals(openingLanguage("Pune", "Maharashtra"), "English");
  assertEquals(openingLanguage("Bengaluru", "Karnataka"), "English");
  assertEquals(openingLanguage("Bangalore", "Karnataka"), "English");
  assertEquals(openingLanguage("New Delhi", "Delhi"), "English");
  // Any locality inside Delhi's own state counts as Delhi.
  assertEquals(openingLanguage("Dwarka", "Delhi"), "English");
});

Deno.test("everywhere else opens in the state's language", () => {
  assertEquals(openingLanguage("Mysuru", "Karnataka"), "Kannada");
  assertEquals(openingLanguage("Nagpur", "Maharashtra"), "Marathi");
  assertEquals(openingLanguage("Kozhikode", "Kerala"), "Malayalam");
  assertEquals(openingLanguage("Chennai", "Tamil Nadu"), "Tamil");
  assertEquals(openingLanguage("Hyderabad", "Telangana"), "Telugu");
  assertEquals(openingLanguage("Kolkata", "West Bengal"), "Bengali");
  assertEquals(openingLanguage("Gurugram", "Haryana"), "Hindi");
  assertEquals(openingLanguage("  navi   mumbai ", " MAHARASHTRA "), "Marathi");
});

Deno.test("no known state, or one Sarvam can't speak, keeps the app's default", () => {
  assertEquals(openingLanguage(null, null), undefined);
  assertEquals(openingLanguage("Kozhikode", null), undefined);
  assertEquals(openingLanguage("Panaji", "Goa"), undefined);
  assertEquals(openingLanguage("Shillong", "Meghalaya"), undefined);
});

Deno.test("the state's code decides, so a renamed state keeps its language", () => {
  // Google gives "Keralam" for Kerala now; the code is still KL.
  assertEquals(openingLanguage("Thiruvananthapuram", "Keralam", "KL"), "Malayalam");
  assertEquals(openingLanguage("Mysuru", "Karnataka", "KA"), "Kannada");
  assertEquals(openingLanguage("Hyderabad", "Telangana", "TS"), "Telugu");
  assertEquals(openingLanguage("Bhubaneswar", "Odisha", "OR"), "Odia");
  // The metros still open in English, Delhi by its code too.
  assertEquals(openingLanguage("Bengaluru", "Karnataka", "KA"), "English");
  assertEquals(openingLanguage("Dwarka", "Delhi", "DL"), "English");
  // Without a code, the name is the fallback.
  assertEquals(openingLanguage("Kozhikode", "Kerala", null), "Malayalam");
});

Deno.test("a gap is a state given that matched nothing, not a state Sarvam can't speak", () => {
  assertEquals(languageGap("Thiruvananthapuram", "Keralam", null), true);
  assertEquals(languageGap("Somewhere", "Newstate", "NS"), true);
  assertEquals(languageGap("Thiruvananthapuram", "Keralam", "KL"), false);
  assertEquals(languageGap("Panaji", "Goa", "GA"), false);
  assertEquals(languageGap("Bengaluru", "Karnataka", "KA"), false);
  assertEquals(languageGap(null, null, null), false);
});
