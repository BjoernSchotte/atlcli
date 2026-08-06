import { SystemMessage } from "@langchain/core/messages";
import { createMiddleware, type AgentMiddleware } from "langchain";
import { projectPromptCacheSystemContentV1 } from "../quality-policy.js";

/**
 * Replace DeepAgentsJS' moving message cache with one static Chat-system
 * breakpoint. User turns, retained summaries, evidence bodies, steering, and
 * credentials remain outside the cached prefix for every provider.
 */
export function createChatPromptCacheMiddlewareV1(): AgentMiddleware[] {
  return [
    createMiddleware({
      name: "PromptCachingMiddleware",
      wrapModelCall: (request, handler) => {
        const settings = {
          ...(request.modelSettings ?? {}),
        } as Record<string, unknown>;
        delete settings.cache_control;
        return handler({ ...request, modelSettings: settings });
      },
    }),
    createMiddleware({
      name: "CacheBreakpointMiddleware",
      wrapModelCall: (request, handler) => {
        const content = projectPromptCacheSystemContentV1({
          existingContent: request.systemMessage.content,
          privateSegments: [],
          cacheStablePrefix: request.model.getName() === "ChatAnthropic",
          ttl: "5m",
        });
        if (content.length === 0) return handler(request);
        return handler({
          ...request,
          systemMessage: new SystemMessage({ content }),
        });
      },
    }),
  ];
}
