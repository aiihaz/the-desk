// Invite signup. Demo only for now: nothing is sent or stored, the form just thanks the visitor.
(() => {
  const form = document.getElementById("invite-form");
  const thanks = document.getElementById("invite-thanks");
  const phoneOut = document.getElementById("invite-phone");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    phoneOut.textContent = form.elements.phone.value.trim();
    form.hidden = true;
    thanks.hidden = false;
  });
})();
