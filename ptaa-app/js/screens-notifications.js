// ---------------------------------------------------------------------------
// screens-notifications.js — in-app notifications (brief §14.2).
//
// In-app only, on purpose. The brief says not to build a fake email path, so
// there isn't one.
// ---------------------------------------------------------------------------

import { h, mount, fmtLogTime, friendlyError } from "./core.js";
import { card, button, badge, loading, errorBox, noticeBox, toast } from "./ui.js";
import { listMyNotifications, unreadCount, markRead, markAllRead } from "./notifications.js";

export function notificationsScreen(navigate) {
  const root = h("div", { class: "screen" });
  const host = h("div", {});

  async function open(n) {
    if (!n.readAt) { try { await markRead(n.id); } catch { /* not fatal */ } }
    if (n.requestId) navigate("request:" + n.requestId);
    else await load();
  }

  async function load() {
    mount(root,
      h("h1", { class: "screen-title" }, "Notifications"),
      h("p", { class: "screen-sub" },
        "In-app only. Email is not configured, so nothing is sent by email — ",
        "the brief asks for that to be stated plainly rather than faked."),
      host);
    mount(host, loading());
    try {
      const items = await listMyNotifications();
      const unread = unreadCount(items);

      if (!items.length) {
        mount(host, card(null, h("p", { class: "empty" }, "Nothing yet.")));
        return;
      }

      mount(host,
        unread
          ? h("div", { class: "actions" },
              button(`Mark all ${unread} as read`, {
                variant: "quiet",
                onClick: async () => {
                  try { await markAllRead(items); toast("Marked as read."); await load(); }
                  catch (err) { toast(friendlyError(err), "error"); }
                },
              }))
          : null,
        card(null,
          h("ul", { class: "notices" }, items.map(n =>
            h("li", { class: "notice-row" + (n.readAt ? "" : " unread") },
              h("button", {
                class: "notice-link",
                onClick: () => open(n),
              },
                h("span", { class: "notice-text" }, n.text),
                h("span", { class: "notice-meta" },
                  fmtLogTime(n.createdAt),
                  n.requestId ? " · " + n.requestId : "",
                  n.readAt ? "" : " · unread"),
              ),
            ))),
        ),
      );
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }

  load();
  return root;
}

/**
 * The header's unread count. Loads itself, and refreshes whenever the route
 * changes, so acting on a notification updates the badge without a reload.
 */
export function notificationBell(navigate) {
  const node = h("a", {
    class: "bell", href: "#/notifications", title: "Notifications",
  }, h("span", { class: "bell-label" }, "Notifications"));
  const count = h("span", { class: "bell-count hidden" }, "");
  node.append(count);

  async function refresh() {
    try {
      const items = await listMyNotifications({ max: 200 });
      const n = unreadCount(items);
      count.textContent = n > 99 ? "99+" : String(n);
      count.classList.toggle("hidden", n === 0);
    } catch {
      count.classList.add("hidden");      // never let the header break the app
    }
  }

  refresh();
  window.addEventListener("hashchange", refresh);
  return node;
}
