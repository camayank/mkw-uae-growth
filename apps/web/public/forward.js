// E14 (D96): the workspace moved from / to /app/. A link sent before that (an email's /#/engagement/…, a payment link's
// /#/pay/…, a bookmark) opens the homepage at /, so it is forwarded to the same place in the workspace. The homepage's
// own anchors (#quick, #start, #review) never start with "#/".
if (location.hash.startsWith("#/")) location.replace("/app/" + location.hash);
