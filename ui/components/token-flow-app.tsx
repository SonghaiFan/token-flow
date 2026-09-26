"use client";

import { useEffect, useState } from "react";
import { CompareView } from "./views/compare-view";
import { ConversationsView } from "./views/conversations-view";
import { WorkspaceView } from "./views/workspace-view";

type Route = { kind: "dashboard" } | { kind: "session"; id: string } | { kind: "compare"; ids: string[] };

function routeFromLocation(pathname: string, search: string): Route {
  const match = pathname.match(/^\/dashboard\/session\/([^/]+)/);
  if (match) return { kind: "session", id: decodeURIComponent(match[1]) };
  if (/^\/dashboard\/compare\/?$/.test(pathname)) {
    const ids = (new URLSearchParams(search).get("ids") || "").split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.length) return { kind: "compare", ids };
  }
  return { kind: "dashboard" };
}

export function TokenFlowApp() {
  const [route, setRoute] = useState<Route>({ kind: "dashboard" });

  useEffect(() => {
    const savedTheme = localStorage.getItem("token-flow-theme") ?? localStorage.getItem("packlite-theme");
    if (savedTheme === "light" || savedTheme === "dark") document.documentElement.dataset.theme = savedTheme;
    const syncRoute = () => setRoute(routeFromLocation(window.location.pathname, window.location.search));
    syncRoute();
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  function navigate(path: string) {
    window.history.pushState({}, "", path);
    setRoute(routeFromLocation(window.location.pathname, window.location.search));
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  if (route.kind === "session") {
    return <WorkspaceView key={route.id} sessionId={route.id} onBack={() => navigate("/dashboard")} />;
  }
  const open = (id: string) => navigate(`/dashboard/session/${encodeURIComponent(id)}`);
  if (route.kind === "compare") {
    return <CompareView ids={route.ids} key={route.ids.join(",")} onBack={() => navigate("/dashboard")} onOpen={open} />;
  }
  return <ConversationsView onCompare={(ids) => navigate(`/dashboard/compare?ids=${ids.map(encodeURIComponent).join(",")}`)} onOpen={open} />;
}
