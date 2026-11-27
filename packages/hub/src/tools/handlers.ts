import type { ToolName } from '@luady/shared';
import type { ToolHandler } from '../core/contracts.js';
import { fleetStatusTool } from './fleet-status.js';
import { OWNER_TOOLS } from './owner-tools.js';
import { SERVER_TOOLS } from './server-tools.js';
import { SESSION_TOOLS } from './session-tools.js';
import { UPLOAD_TOOLS } from './upload-tool.js';
import { MISSION_TOOLS } from './mission-tools.js';
import { TODO_TOOLS } from './todo-tools.js';
import { GOOGLE_TOOLS } from './google-tools.js';
import { MEETING_TOOLS } from './meeting-tools.js';
import { AGENCY_TOOLS } from './agency-tools.js';
import { KB_TOOLS } from './kb-tools.js';
import { JIRA_TOOLS } from './jira-tools.js';
import { ROOM_TOOLS } from './room-tools.js';

/** One handler per TOOL_DEFS key. TypeScript rejects the build if a tool is missing. */
export function createToolHandlers(): Record<ToolName, ToolHandler> {
  return { fleet_status: fleetStatusTool, ...SESSION_TOOLS, ...SERVER_TOOLS, ...OWNER_TOOLS, ...UPLOAD_TOOLS, ...MISSION_TOOLS, ...TODO_TOOLS, ...GOOGLE_TOOLS, ...MEETING_TOOLS, ...AGENCY_TOOLS,
    ...KB_TOOLS, ...JIRA_TOOLS, ...ROOM_TOOLS };
}
