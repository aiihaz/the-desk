// Invite signup: POSTs to the waitlist edge function named in <meta name="desk-waitlist-url">.
// With no URL set it's a demo on this machine only (file or localhost): nothing is sent, the
// form just thanks. Anywhere else a missing URL is an error, so no signup is silently lost.
(() => {
  const form = document.getElementById("invite-form");
  const thanks = document.getElementById("invite-thanks");
  const phoneOut = document.getElementById("invite-phone");
  const errorOut = document.getElementById("invite-error");
  const button = form.querySelector("button");
  const phoneIn = form.elements.phone;
  const url = document.querySelector('meta[name="desk-waitlist-url"]')?.content.trim();
  const local = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);

  const ERRORS = {
    bad_phone: "Enter your 10-digit mobile number, like 98765 43210.",
    bad_handle: "Please add your X or LinkedIn username.",
    rate_limited: "Too many signups just now. Please try again in an hour.",
  };
  const FALLBACK = "Something went wrong on our side. Please try again in a minute.";

  const showError = (msg) => {
    errorOut.textContent = msg;
    errorOut.hidden = false;
  };

  // +91 sits outside the box, so only the 10-digit number goes in it. Whatever is typed,
  // pasted or autofilled ("+91 98765 43210", "0091…", "098765 43210") drops its +91 or 0.
  // Returns the digits kept, uncapped, so the caret can be placed after them.
  const nationalDigits = (raw) => {
    let s = raw.replace(/[^\d+]/g, "").replace(/^00/, "+");
    if (s.startsWith("+91")) s = s.slice(3);
    s = s.replace(/\D/g, "");
    while (s.length > 10 && (s.startsWith("0") || s.startsWith("91"))) s = s.slice(s[0] === "0" ? 1 : 2);
    return s;
  };
  const format = (d) => (d.length > 5 ? `${d.slice(0, 5)} ${d.slice(5)}` : d);
  // Caret after the n-th digit of a formatted number.
  const caretAt = (n) => (n > 5 ? n + 1 : n);

  let prev = "";
  phoneIn.addEventListener("input", (e) => {
    errorOut.hidden = true;
    const raw = phoneIn.value;
    // A pasted or autofilled number from another country would only be mangled into 10 digits.
    if (/^\+(?!91)\d/.test(raw.replace(/[^\d+]/g, "").replace(/^00/, "+"))) {
      phoneIn.value = prev = "";
      return showError("The Desk takes Indian mobile numbers (+91) for now.");
    }
    const caret = phoneIn.selectionStart ?? raw.length;
    const all = raw.replace(/\D/g, "");
    let kept = nationalDigits(raw);
    let before = raw.slice(0, caret).replace(/\D/g, "").length - (all.length - kept.length);
    // A digit typed into a full number is ignored, rather than pushing the last one out.
    if (e.inputType === "insertText" && kept.length > 10 && prev.replace(/\D/g, "").length === 10) {
      phoneIn.value = prev;
      phoneIn.setSelectionRange(caretAt(before - 1), caretAt(before - 1));
      return;
    }
    // Backspace over the space removes only the space; take the digit before it too.
    if (e.inputType === "deleteContentBackward" && kept === prev.replace(/\D/g, "") && before > 0) {
      kept = kept.slice(0, before - 1) + kept.slice(before);
      before -= 1;
    }
    kept = kept.slice(0, 10);
    before = Math.max(0, Math.min(before, kept.length));
    phoneIn.value = prev = format(kept);
    if (document.activeElement === phoneIn) phoneIn.setSelectionRange(caretAt(before), caretAt(before));
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorOut.hidden = true;
    const digits = nationalDigits(phoneIn.value).slice(0, 10);
    if (!/^[6-9][0-9]{9}$/.test(digits)) {
      phoneIn.focus();
      return showError(ERRORS.bad_phone);
    }
    if (!url && !local) {
      console.error("desk-waitlist-url is empty: set it in index.html, or signups have nowhere to go");
      return showError(FALLBACK);
    }
    if (url) {
      button.disabled = true;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            handle: form.elements.handle.value,
            phone: `+91${digits}`,
            hp: form.elements.hp.value,
          }),
        });
        if (!res.ok) {
          const { error } = await res.json().catch(() => ({}));
          return showError(ERRORS[error] ?? FALLBACK);
        }
      } catch {
        return showError(FALLBACK);
      } finally {
        button.disabled = false;
      }
    }
    phoneOut.textContent = `+91 ${format(digits)}`;
    form.hidden = true;
    thanks.hidden = false;
  });
})();
