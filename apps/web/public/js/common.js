// Tasees workspace: common module (split from app.js in O12; plain ES modules, no build step).
import { $app, act, api, dateTime, esc, isClient, state } from "./core.js";
import { chrome } from "./shell.js";

export async function renderNotifications() {
  const n = await api("GET", "/api/notifications");
  state.unread = n.unread ?? 0;
  chrome();
  $app.innerHTML = `
  <div class="row between"><h1>Notifications</h1>${n.unread ? `<button class="sm" data-act="read-all">Mark all as read</button>` : ""}</div>
  <p class="muted">${isClient() ? "Notices from Tasees, by MKW Advisors." : "Notices from MKW Advisors."} ${n.unread ? `${n.unread} unread.` : "All read."} The same notices are sent to your email.</p>
  <div class="stack">${
    n.items.length
      ? n.items
          .map(
            (i) => `<div class="card notice-item ${i.readAt ? "" : "unread"}" data-act="read-one" data-id="${i.id}">
            <div class="row between"><b data-no-i18n>${esc(i.subject)}</b><span class="small muted">${dateTime(i.createdAt)}</span></div>
            <div class="small" style="white-space:pre-wrap;margin-top:6px" data-no-i18n>${linkify(i.body)}</div></div>`,
          )
          .join("")
      : `<p class="empty">Nothing yet.</p>`
  }</div>`;
}

/** Turn in-app links to this workspace into anchors; everything else stays escaped text. */
export function linkify(text) {
  return esc(text).replace(/(https?:\/\/[^\s]+#\/[^\s]*?)([.,;:]?)(?=\s|$)/g, (_m, url, tail) => {
    const hash = url.slice(url.indexOf("#"));
    return `<a href="${esc(hash)}">${esc(hash)}</a>${tail}`;
  });
}
