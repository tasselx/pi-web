// The demo only ships Pi Web's browser code. A few copied modules keep
// type-only (or server-only) imports from the pi SDK; declare the
// names they use loosely so the demo typechecks without the agent runtime.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "@earendil-works/pi-coding-agent" {
  export type AgentSessionEvent = any;
  export type BashOperations = any;
  export type JsonAgentSessionEvent = any;
  // 下面三个不能写成 any：拷贝来的 lib/subagents.ts、lib/mcp-import*.ts 在它们上调用
  // .filter()/.some()/.map()，类型是 any 时回调参数没有上下文类型，noImplicitAny 会报错。
  // 所以按 SDK 的真实形状写：McpExposure / McpServerConfig 与 SDK 的 core/mcp-servers.d.ts 一致，
  // LoadExtensionsResult 只留 lib/subagents.ts 读写的成员（真实类型牵涉整个扩展运行时）。
  export interface LoadExtensionsResult {
    extensions: Array<{ path: string; sourceInfo?: { source?: string; origin?: string }; tools: Map<string, unknown> }>;
    runtime: {
      pendingProviderRegistrations: Array<{ extensionPath: string }>;
      pendingNativeProviderRegistrations: Array<{ extensionPath: string }>;
      pendingVirtualModelRegistrations: Array<{ extensionPath: string }>;
    };
  }
  export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
  interface McpServerConfigBase {
    exposure?: McpExposure;
    description?: string;
    toolExposure?: Record<string, McpExposure>;
    enabled?: boolean;
    timeout?: number;
  }
  export interface McpStdioServerConfig extends McpServerConfigBase {
    type?: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  }
  export interface McpOAuthConfig {
    clientId?: string;
    clientSecret?: string;
    callbackPort?: number;
    callbackUrl?: string;
    scope?: string;
    clientName?: string;
    clientRegistration?: "auto" | "dcr" | "cimd";
    authServerMetadataUrl?: string;
  }
  export interface McpHttpServerConfig extends McpServerConfigBase {
    type?: "http";
    url: string;
    headers?: Record<string, string>;
    oauth?: McpOAuthConfig;
    auth?: { provider: string };
  }
  export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
  export type ResourceDiagnostic = any;
  export type SessionManager = any;
  export type SettingsManager = any;
  export type SlashCommandInfo = any;
  export type Theme = any;
  export function getAgentDir(): string;
}
declare module "@earendil-works/pi-agent-core" {
  export type AgentMessage = any;
  export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
declare module "@earendil-works/pi-ai" {
  export type ImageContent = any;
  export type TextContent = any;
}
