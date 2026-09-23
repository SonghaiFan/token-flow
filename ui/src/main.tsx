import { createRoot } from "react-dom/client";
import { TokenFlowApp } from "@/components/token-flow-app";
import "@/styles/globals.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing React root element");

createRoot(rootElement).render(<TokenFlowApp />);
