import type { Metadata } from "next";
import { McpLogsClient } from "./client";

export const metadata: Metadata = { title: "MCP 日志" };

export default function McpLogsPage() {
  return <McpLogsClient />;
}