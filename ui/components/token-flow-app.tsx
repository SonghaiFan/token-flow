"use client";

import { useEffect, useState } from "react";
import { ConversationsView } from "./views/conversations-view";
import { WorkspaceView } from "./views/workspace-view";

function routeFromPathname(pathname: string): { kind: "dashboard" } | { kind: "session"; id: string } {
  const match = pathname.match(/^\/dashboard\/session\/([^/]+)/);
  return match ? { kind: "session", id: decodeURIComponent(match[1]) } : { kind: "dashboard" };
}

export function TokenFlowApp() {
  const [route, setRoute] = useState<{ kind: "dashboard" } | { kind: "session"; id: string }>({ kind: "dashboard" });

  useEffect(() => {
    const savedTheme = localStorage.getItem("token-flow-theme") ?? localStorage.getItem("packlite-theme");
    if (savedTheme === "light" || savedTheme === "dark") document.documentElement.dataset.theme = savedTheme;
    const syncRoute = () => setRoute(routeFromPathname(window.location.pathname));
    syncRoute();
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  function navigate(path: string) {
    window.history.pushState({}, "", path);
    setRoute(routeFromPathname(path));
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  if (route.kind === "session") {
    return <WorkspaceView key={route.id} sessionId={route.id} onBack={() => navigate("/dashboard")} />;
  }
  return <ConversationsView onOpen={(id) => navigate(`/dashboard/session/${encodeURIComponent(id)}`)} />;
}
