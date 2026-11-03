// E14 (D96): the workspace moved from / to /app/. A link sent before that (an email's /#/engagement/…, a payment link's
// /#/pay/…, a bookmark) opens the homepage at /, so it is forwarded to the same place in the workspace. While it
// forwards, the homepage stays hidden and its script never loads: no visit is counted in the funnel, no request is
// made, and a partner never sees the homepage. The homepage's own anchors (#quick, #start, #review) never start
// with "#/". Otherwise this loads the homepage's script once the page is parsed, as a deferred module would run.
if (location.hash.startsWith("#/")) {
  document.documentElement.hidden = true;
  location.replace("/app/" + location.hash);
} else {
  document.addEventListener("DOMContentLoaded", () => {
    const s = document.createElement("script");
    s.type = "module";
    s.src = "selector.js";
    document.body.append(s);
  });
}
