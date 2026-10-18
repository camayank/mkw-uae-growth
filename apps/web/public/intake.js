// Public intake page (O5): posts the lead to the platform. Served with the same content-security policy as the app.
import { translateTree } from "./i18n-ar.js";
// Arabic (O9): ?lang=ar once the reviewer's sign-off is recorded (the health endpoint says so).
(async () => {
  const want = new URLSearchParams(location.search).get("lang") === "ar";
  if (!want) return;
  try {
    const h = await (await fetch("/api/health")).json();
    if (!h.arabic) return;
    document.documentElement.lang = "ar";
    document.documentElement.dir = "rtl";
    translateTree(document.body);
  } catch {}
})();
    const form = document.getElementById("intake");
    const msg = document.getElementById("msg");
    const params = new URLSearchParams(location.search);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      if (!form.reportValidity()) return;
      const body = {
        company: String(fd.get("company")), name: String(fd.get("name")), email: String(fd.get("email")), phone: String(fd.get("phone") || "") || undefined,
        consent: fd.get("consent") === "on", consentVersion: String(fd.get("consentVersion")), website: String(fd.get("website") || ""),
        campaign: params.get("utm_campaign") || params.get("campaign") || undefined, referrer: document.referrer || undefined,
        answers: {
          mode: "new_company", emirate: String(fd.get("emirate")), jurisdiction: String(fd.get("jurisdiction")), visas: Number(fd.get("visas") || 0),
          ...(fd.get("activity") ? { activity: String(fd.get("activity")) } : {}), ...(fd.get("customers") ? { customers: String(fd.get("customers")) } : {}),
          ...(fd.get("budgetAed") ? { budgetAed: Number(fd.get("budgetAed")) } : {}), ...(String(fd.get("description") || "").trim() ? { description: String(fd.get("description")).trim() } : {}),
        },
      };
      msg.hidden = false; msg.textContent = "Sending…";
      try {
        const res = await fetch("/api/public/intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Something went wrong");
        form.querySelector("button[type=submit]").disabled = true;
        msg.textContent = "Thank you. We have your request; check your email for how to sign in and follow progress.";
      } catch (e) { msg.textContent = e.message; }
    });
