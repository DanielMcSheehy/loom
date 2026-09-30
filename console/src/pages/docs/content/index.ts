// slug → static page body. Imported only by Docs.tsx (lazy), so the docs
// content stays out of the main bundle.
import type { ReactNode } from "react";
import api from "./api";
import configuration from "./configuration";
import data from "./data";
import functions from "./functions";
import isolation from "./isolation";
import mcp from "./mcp";
import notebooks from "./notebooks";
import overview from "./overview";
import quickstart from "./quickstart";
import runs from "./runs";
import sdkPython from "./sdk-python";
import sdkTypescript from "./sdk-typescript";
import security from "./security";
import sql from "./sql";
import workflows from "./workflows";

export const BODIES: Record<string, ReactNode> = {
  overview,
  quickstart,
  workflows,
  runs,
  functions,
  data,
  sql,
  notebooks,
  mcp,
  "sdk-python": sdkPython,
  "sdk-typescript": sdkTypescript,
  api,
  configuration,
  isolation,
  security,
};
