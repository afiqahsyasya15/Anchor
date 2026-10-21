// ---------------------------------------------------------------------------
// app.js — application shell and router.
//
// Routing is hash-based (#/users) on purpose: it needs no server rewrite rules,
// so the app can be dropped onto Cloudflare Pages as plain files and every URL
// works, including on refresh.
// ---------------------------------------------------------------------------

import { h, mount, company, configLooksUnset, soloMode } from "./core.js";
import { badge, button } from "./ui.js";
import {
  session, PHASE, startAuthWatch, onSessionChange,
  signOutNow, isAdmin, profileRequired,
} from "./auth.js";
import {
  setupScreen, signInScreen, deniedScreen, profileScreen,
  usersScreen, activityScreen, dashboardScreen, notBuiltScreen,
} from "./screens.js";
import { newRequestScreen, requestDetailScreen } from "./screens-request.js";
import { requestQueueScreen, myRequestsScreen, propertiesScreen } from "./screens-queue.js";
import { templatesScreen } from "./screens-templates.js";
import { signaturesScreen } from "./screens-signatures.js";
import { searchScreen, reportScreen, globalSearchBox } from "./screens-search.js";
import { notificationsScreen, notificationBell } from "./screens-notifications.js";
import { soloDashboard, soloListScreen, agentsScreen, settingsScreen } from "./screens-solo.js";
import { signPdfScreen } from "./screens-sign.js";
import { agentHome } from "./screens-agent.js";

// Shown in the footer, so it is easy to tell whether the browser has the
// latest upload. Change it on every deploy.
export const BUILD = "2026-10-21a";

const root = document.getElementById("root");

// --- Routing ----------------------------------------------------------------

function currentRoute() {
  const raw = (location.hash || "").replace(/^#\/?/, "").trim();
  return raw || "dashboard";
}

export function navigate(route) {
  if (currentRoute() === route) { render(); return; }
  location.hash = "#/" + route;
}

window.addEventListener("hashchange", render);

// --- Shell ------------------------------------------------------------------

const NAV_ADMIN = [
  { route: "dashboard",  label: "Dashboard" },
  { route: "requests",   label: "Requests" },
  { route: "properties", label: "Properties" },
  { route: "signatures", label: "Signatures" },
  { route: "reports",    label: "Reporting" },
  { route: "users",      label: "Users" },
  { route: "activity",   label: "Activity" },
  { route: "notifications", label: "Notifications" },
  { route: "profile",    label: "My profile" },
];

// One person doing everything: no queue of other people's work, no
// notifications, and the agents are a list rather than accounts.
const NAV_SOLO = [
  { route: "dashboard",   label: "PTAAs" },
  { route: "new-request", label: "New PTAA" },
  { route: "requests",    label: "All PTAAs" },
  { route: "sign",        label: "Sign PDF" },
  { route: "properties",  label: "Condos" },
  { route: "agents",      label: "Agents" },
  { route: "signatures",  label: "Signatures" },
  { route: "settings",    label: "Settings" },
  { route: "users",       label: "Users" },
  { route: "activity",    label: "Activity" },
  { route: "profile",     label: "My profile" },
];

const NAV_AGENT = [
  { route: "dashboard",   label: "Dashboard" },
  { route: "requests",    label: "My requests" },
  { route: "new-request", label: "New request" },
  { route: "notifications", label: "Notifications" },
  { route: "profile",     label: "My profile" },
];

// A Sales Agent while the admin runs the solo workflow: submit, save drafts,
// download the finished PDF.
const NAV_AGENT_SOLO = [
  { route: "dashboard",     label: "My PTAAs" },
  { route: "new-request",   label: "New PTAA" },
  { route: "notifications", label: "Notifications" },
  { route: "profile",       label: "My profile" },
];

function shell(content) {
  const solo = soloMode && isAdmin();
  const nav = solo ? NAV_SOLO : isAdmin() ? NAV_ADMIN : soloMode ? NAV_AGENT_SOLO : NAV_AGENT;
  const route = currentRoute();

  return h("div", { class: "app" },
    h("header", { class: "topbar" },
      h("div", { class: "brand" },
        company.logoUrl
          ? h("img", { class: "brand-logo", src: company.logoUrl, alt: company.name })
          : h("span", { class: "brand-name" }, company.name),
        h("span", { class: "brand-sep" }, "/"),
        h("span", { class: "brand-system" }, company.systemName),
      ),
      soloMode && !isAdmin() ? null : globalSearchBox(navigate),
      h("div", { class: "whoami" },
        solo ? null : notificationBell(navigate),
        h("span", { class: "whoami-email" }, session.email || ""),
        badge(isAdmin() ? "Admin" : "Sales Agent", isAdmin() ? "info" : "neutral"),
        button("Sign out", { variant: "quiet", onClick: () => signOutNow() }),
      ),
    ),
    h("nav", { class: "nav" },
      nav.map(item => {
        const active = route === item.route || (item.route === "profile" && route.startsWith("profile-of:"));
        if (item.built === false) {
          return h("span", { class: "nav-item nav-disabled", title: item.note },
            item.label, h("span", { class: "nav-flag" }, "not built"));
        }
        return h("a", {
          class: "nav-item" + (active ? " nav-active" : ""),
          href: "#/" + item.route,
        }, item.label);
      }),
    ),
    h("main", { class: "main" }, content),
    h("footer", { class: "foot" },
      h("span", {}, company.systemName, soloMode
        ? (solo ? " — agents submit, you draft, print and file." : "")
        : " — phases 1–11 and 13. The AI cross-check (phase 12) is deliberately not built."),
      h("span", { class: "muted small" }, " · Build " + BUILD),
    ),
  );
}

// --- Render -----------------------------------------------------------------

function screenFor(route) {
  if (route.startsWith("profile-of:")) {
    const target = route.slice("profile-of:".length);
    if (!isAdmin()) return notBuiltScreen("Not available", "Only an administrator can open another user's profile.");
    return profileScreen({ targetEmail: target, onDone: () => navigate("users") });
  }
  if (route.startsWith("request:")) {
    return requestDetailScreen(route.slice("request:".length), navigate);
  }
  if (route === "search" || route.startsWith("search:")) {
    const q = route.startsWith("search:")
      ? decodeURIComponent(route.slice("search:".length)) : "";
    return searchScreen(q, navigate);
  }
  if (route.startsWith("new-request:")) {
    return newRequestScreen(navigate, { draftId: route.slice("new-request:".length) });
  }
  if (soloMode && !isAdmin()) {
    switch (route) {
      case "dashboard":
      case "requests":      return agentHome(navigate);
      case "new-request":   return newRequestScreen(navigate);
      case "notifications": return notificationsScreen(navigate);
      case "profile":       return profileScreen({});
      default:              return agentHome(navigate);
    }
  }
  if (soloMode && isAdmin()) {
    switch (route) {
      case "requests":    return soloListScreen(navigate);
      case "new-request": return newRequestScreen(navigate);
      case "agents":      return agentsScreen();
      case "settings":    return settingsScreen();
      case "sign":        return signPdfScreen(navigate);
      case "dashboard":   return soloDashboard(navigate);
      default: break;
    }
  }
  switch (route) {
    case "users":       return isAdmin() ? usersScreen(navigate) : notBuiltScreen("Not available", "Administrators only.");
    case "activity":    return isAdmin() ? activityScreen()      : notBuiltScreen("Not available", "Administrators only.");
    case "properties":  return isAdmin() ? propertiesScreen()    : notBuiltScreen("Not available", "Administrators only.");
    case "notifications": return notificationsScreen(navigate);
    case "profile":     return profileScreen({});
    case "new-request": return isAdmin()
                          ? notBuiltScreen("New PTAA Request",
                              "Requests are submitted by Sales Agents, so that the agent's details on the " +
                              "document always come from the account that submitted it (rule #1). " +
                              "An admin can edit any request from the queue.")
                          : newRequestScreen(navigate);
    case "requests":    return isAdmin() ? requestQueueScreen(navigate) : myRequestsScreen(navigate);
    case "templates":   return isAdmin() ? templatesScreen() : notBuiltScreen("Not available", "Administrators only.");
    case "signatures":  return isAdmin() ? signaturesScreen() : notBuiltScreen("Not available", "Administrators only.");
    case "reports":     return isAdmin() ? reportScreen(navigate) : notBuiltScreen("Not available", "Administrators only.");
    case "dashboard":
    default:            return dashboardScreen(navigate);
  }
}

function render() {
  if (configLooksUnset) { mount(root, setupScreen()); return; }

  switch (session.phase) {
    case PHASE.LOADING:
      mount(root, h("div", { class: "boot" },
        h("div", { class: "boot-inner" }, h("div", { class: "spinner" }), h("p", {}, "Checking your access…"))));
      return;

    case PHASE.SIGNED_OUT:
      mount(root, signInScreen());
      return;

    case PHASE.DENIED:
      mount(root, deniedScreen());
      return;

    case PHASE.READY: {
      // An agent with an incomplete profile is held on the profile screen —
      // brief §6: the profile must be complete before anything can be submitted.
      if (profileRequired()) {
        mount(root, shell(profileScreen({ forced: true, onDone: () => navigate("dashboard") })));
        return;
      }
      mount(root, shell(screenFor(currentRoute())));
      return;
    }
  }
}

onSessionChange(render);
startAuthWatch();
render();

document.title = company.systemName;
