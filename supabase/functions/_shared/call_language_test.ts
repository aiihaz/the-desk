import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { openingLanguage } from "./call_language.ts";

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
