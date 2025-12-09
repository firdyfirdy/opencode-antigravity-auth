import crypto from "node:crypto";
import { 
  ANTIGRAVITY_HEADERS, 
  ANTIGRAVITY_ENDPOINT,
} from "../constants";
import { logAntigravityDebugResponse, type AntigravityDebugContext } from "./debug";
import {
  extractUsageFromSsePayload,
  extractUsageMetadata,
  normalizeThinkingConfig,
  parseAntigravityApiBody,
  rewriteAntigravityPreviewAccessError,
  type AntigravityApiBody,
} from "./request-helpers";

function generateSyntheticProjectId(): string {
  const adjectives = ["useful", "bright", "swift", "calm", "bold"];
  const nouns = ["fuze", "wave", "spark", "flow", "core"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const randomPart = crypto.randomUUID().slice(0, 5).toLowerCase();
  return `${adj}-${noun}-${randomPart}`;
}

const STREAM_ACTION = "streamGenerateContent";
const MODEL_FALLBACKS: Record<string, string> = {
  "gemini-2.5-flash-image": "gemini-2.5-flash",
  "gemini-2.5-flash": "gemini-3-pro-preview",
  "models/gemini-2.5-flash": "gemini-3-pro-preview",
  "gemini-3-pro-high": "gemini-3-pro-preview",
  "gemini-3-pro-low": "gemini-3-pro-preview",
  "claude-sonnet-4-5": "claude-4-5-sonnet",
  "claude-sonnet-4-5-thinking": "claude-4-5-sonnet-thinking",
  "claude-opus-4-5-thinking": "claude-4-5-opus-thinking",
  "gpt-oss-120b-medium": "gpt-oss-120b-medium",
};

// Maps friendly/alias names to the upstream model IDs Antigravity expects.
const MODEL_UPSTREAM_ALIASES: Record<string, string> = {
  "gemini-2.5-computer-use-preview-10-2025": "rev19-uic3-1p",
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
  "gemini-3-pro-preview": "gemini-3-pro-high",
  "gemini-claude-sonnet-4-5": "claude-sonnet-4-5",
  "gemini-claude-sonnet-4-5-thinking": "claude-sonnet-4-5-thinking",
  "gemini-claude-opus-4-5-thinking": "claude-opus-4-5-thinking",
  // Anthropic model name normalization (order expected by Antigravity)
  "claude-4-5-sonnet": "claude-sonnet-4-5",
  "claude-4-5-sonnet-thinking": "claude-sonnet-4-5-thinking",
  "claude-4-5-opus-thinking": "claude-opus-4-5-thinking",
};

/**
 * Endpoint fallback order (daily → autopush → prod)
 * Matches CLIProxy and Vibeproxy behavior
 */
export function isGenerativeLanguageRequest(input: RequestInfo): input is string {
  return typeof input === "string" && input.includes("generativelanguage.googleapis.com");
}

/**
 * Rewrites SSE payloads so downstream consumers see only the inner `response` objects.
 */
function transformStreamingPayload(payload: string): string {
  return payload
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) {
        return line;
      }
      const json = line.slice(5).trim();
      if (!json) {
        return line;
      }
      try {
        const parsed = JSON.parse(json) as { response?: unknown };
        if (parsed.response !== undefined) {
          return `data: ${JSON.stringify(parsed.response)}`;
        }
      } catch (_) {}
      return line;
    })
    .join("\n");
}

/**
 * Rewrites OpenAI-style requests into Antigravity shape, normalizing model, headers,
 * optional cached_content, and thinking config. Also toggles streaming mode for SSE actions.
 */
export function prepareAntigravityRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
  endpointOverride?: string,
): { request: RequestInfo; init: RequestInit; streaming: boolean; requestedModel?: string; effectiveModel?: string; projectId?: string; endpoint?: string; toolDebugMissing?: number; toolDebugSummary?: string; toolDebugPayload?: string } {
  const baseInit: RequestInit = { ...init };
  const headers = new Headers(init?.headers ?? {});
  let resolvedProjectId = projectId?.trim() || "";
  let toolDebugMissing = 0;
  const toolDebugSummaries: string[] = [];
  let toolDebugPayload: string | undefined;

  if (!isGenerativeLanguageRequest(input)) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
    };
  }

  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");

  const match = input.match(/\/models\/([^:]+):(\w+)/);
  if (!match) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
    };
  }

  const [, rawModel = "", rawAction = ""] = match;
  const effectiveModel = MODEL_FALLBACKS[rawModel] ?? rawModel;
  const upstreamModel = MODEL_UPSTREAM_ALIASES[effectiveModel] ?? effectiveModel;
  const streaming = rawAction === STREAM_ACTION;
  const baseEndpoint = endpointOverride ?? ANTIGRAVITY_ENDPOINT;
  const transformedUrl = `${baseEndpoint}/v1internal:${rawAction}${
    streaming ? "?alt=sse" : ""
  }`;
  const isClaudeModel = upstreamModel.toLowerCase().includes("claude");

  let body = baseInit.body;
  if (typeof baseInit.body === "string" && baseInit.body) {
    try {
      const parsedBody = JSON.parse(baseInit.body) as Record<string, unknown>;
      const isWrapped = typeof parsedBody.project === "string" && "request" in parsedBody;

      if (isWrapped) {
        const wrappedBody = {
          ...parsedBody,
          model: effectiveModel,
        } as Record<string, unknown>;
        body = JSON.stringify(wrappedBody);
      } else {
        const requestPayload: Record<string, unknown> = { ...parsedBody };

        const rawGenerationConfig = requestPayload.generationConfig as Record<string, unknown> | undefined;
        const normalizedThinking = normalizeThinkingConfig(rawGenerationConfig?.thinkingConfig);
        if (normalizedThinking) {
          if (rawGenerationConfig) {
            rawGenerationConfig.thinkingConfig = normalizedThinking;
            requestPayload.generationConfig = rawGenerationConfig;
          } else {
            requestPayload.generationConfig = { thinkingConfig: normalizedThinking };
          }
        } else if (rawGenerationConfig?.thinkingConfig) {
          delete rawGenerationConfig.thinkingConfig;
          requestPayload.generationConfig = rawGenerationConfig;
        }

        if ("system_instruction" in requestPayload) {
          requestPayload.systemInstruction = requestPayload.system_instruction;
          delete requestPayload.system_instruction;
        }

        const cachedContentFromExtra =
          typeof requestPayload.extra_body === "object" && requestPayload.extra_body
            ? (requestPayload.extra_body as Record<string, unknown>).cached_content ??
              (requestPayload.extra_body as Record<string, unknown>).cachedContent
            : undefined;
        const cachedContent =
          (requestPayload.cached_content as string | undefined) ??
          (requestPayload.cachedContent as string | undefined) ??
          (cachedContentFromExtra as string | undefined);
        if (cachedContent) {
          requestPayload.cachedContent = cachedContent;
        }

        delete requestPayload.cached_content;
        delete requestPayload.cachedContent;
        if (requestPayload.extra_body && typeof requestPayload.extra_body === "object") {
          delete (requestPayload.extra_body as Record<string, unknown>).cached_content;
          delete (requestPayload.extra_body as Record<string, unknown>).cachedContent;
          if (Object.keys(requestPayload.extra_body as Record<string, unknown>).length === 0) {
            delete requestPayload.extra_body;
          }
        }

        // Normalize tools. For Claude models, send functionDeclarations with parameters (no custom).
        if (Array.isArray(requestPayload.tools)) {
          if (isClaudeModel) {
            // Use functionDeclarations with parameters (mirrors CLIProxy path that Antigravity accepts).
            const claudeTools: any[] = requestPayload.tools.map((tool: any, idx: number) => {
              const schema =
                tool.function?.parameters ||
                tool.function?.input_schema ||
                tool.function?.inputSchema ||
                tool.parameters ||
                tool.input_schema ||
                tool.inputSchema ||
                tool.custom?.parameters ||
                tool.custom?.input_schema ||
                { type: "object", properties: {} };
              const name =
                tool.name ||
                tool.function?.name ||
                tool.custom?.name ||
                `tool-${idx}`;
              const description =
                tool.description || tool.function?.description || tool.custom?.description || "";

              return {
                functionDeclarations: [
                  {
                    name,
                    description,
                    parameters: schema,
                  },
                ],
              };
            });

            requestPayload.tools = claudeTools;
          } else {
            // Default normalization for non-Claude models
            requestPayload.tools = requestPayload.tools.map((tool: any, toolIndex: number) => {
              const newTool = { ...tool };

              const schemaCandidates = [
                newTool.function?.input_schema,
                newTool.function?.parameters,
                newTool.function?.inputSchema,
                newTool.custom?.input_schema,
                newTool.custom?.parameters,
                newTool.parameters,
                newTool.input_schema,
                newTool.inputSchema,
              ].filter(Boolean);
              const schema = schemaCandidates[0];

              const nameCandidate =
                newTool.name ||
                newTool.function?.name ||
                newTool.custom?.name ||
                `tool-${toolIndex}`;

              if (newTool.function && !newTool.function.input_schema && schema) {
                newTool.function.input_schema = schema;
              }
              if (newTool.custom && !newTool.custom.input_schema && schema) {
                newTool.custom.input_schema = schema;
              }
              if (!newTool.custom && newTool.function) {
                newTool.custom = {
                  name: newTool.function.name || nameCandidate,
                  description: newTool.function.description,
                  input_schema: schema ?? { type: "object", properties: {} },
                };
              }
              if (!newTool.custom && !newTool.function) {
                newTool.custom = {
                  name: nameCandidate,
                  description: newTool.description,
                  input_schema: schema ?? { type: "object", properties: {} },
                };
              }
              if (newTool.custom && !newTool.custom.input_schema) {
                newTool.custom.input_schema = { type: "object", properties: {} };
                toolDebugMissing += 1;
              }

              toolDebugSummaries.push(
                `idx=${toolIndex}, hasCustom=${!!newTool.custom}, customSchema=${!!newTool.custom?.input_schema}, hasFunction=${!!newTool.function}, functionSchema=${!!newTool.function?.input_schema}`,
              );

              // Strip custom wrappers for Gemini; only function-style is accepted.
              if (newTool.custom) {
                delete newTool.custom;
              }

              return newTool;
            });
          }

          try {
            toolDebugPayload = JSON.stringify(requestPayload.tools);
          } catch {
            toolDebugPayload = undefined;
          }
        }

        if ("model" in requestPayload) {
          delete requestPayload.model;
        }

        const effectiveProjectId = projectId?.trim() || generateSyntheticProjectId();
        resolvedProjectId = effectiveProjectId;

        const wrappedBody = {
          project: effectiveProjectId,
          model: upstreamModel,
          request: requestPayload,
        };

        // Add additional Antigravity fields
        Object.assign(wrappedBody, {
             userAgent: "antigravity",
             requestId: "agent-" + crypto.randomUUID(), 
        });
        if (wrappedBody.request && typeof wrappedBody.request === 'object') {
             (wrappedBody.request as any).sessionId = "-" + Math.floor(Math.random() * 9000000000000000000).toString();
        }

        body = JSON.stringify(wrappedBody);
        
        if (wrappedBody.request && typeof wrappedBody.request === 'object') {
             (wrappedBody.request as any).sessionId = "-" + Math.floor(Math.random() * 9000000000000000000).toString();
        }

        body = JSON.stringify(wrappedBody);
      }
    } catch (error) {
      throw error;
    }
  }

  if (streaming) {
    headers.set("Accept", "text/event-stream");
  }

  headers.set("User-Agent", ANTIGRAVITY_HEADERS["User-Agent"]);
  headers.set("X-Goog-Api-Client", ANTIGRAVITY_HEADERS["X-Goog-Api-Client"]);
  headers.set("Client-Metadata", ANTIGRAVITY_HEADERS["Client-Metadata"]);
  // Optional debug header to observe tool normalization on the backend if surfaced
  if (toolDebugMissing > 0) {
    headers.set("X-Opencode-Tools-Debug", String(toolDebugMissing));
  }

  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body,
    },
    streaming,
    requestedModel: rawModel,
    effectiveModel: upstreamModel,
    projectId: resolvedProjectId,
    endpoint: transformedUrl,
    toolDebugMissing,
    toolDebugSummary: toolDebugSummaries.slice(0, 20).join(" | "),
    toolDebugPayload,
  };
}

/**
 * Normalizes Antigravity responses: applies retry headers, extracts cache usage into headers,
 * rewrites preview errors, flattens streaming payloads, and logs debug metadata.
 */
export async function transformAntigravityResponse(
  response: Response,
  streaming: boolean,
  debugContext?: AntigravityDebugContext | null,
  requestedModel?: string,
  projectId?: string,
  endpoint?: string,
  effectiveModel?: string,
  toolDebugMissing?: number,
  toolDebugSummary?: string,
  toolDebugPayload?: string,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStreamResponse = contentType.includes("text/event-stream");

  if (!isJsonResponse && !isEventStreamResponse) {
    logAntigravityDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)",
    });
    return response;
  }

  try {
    const text = await response.text();
    const headers = new Headers(response.headers);
    
    if (!response.ok) {
       let errorBody;
       try {
         errorBody = JSON.parse(text);
       } catch {
         errorBody = { error: { message: text } };
       }

       // Inject Debug Info
       if (errorBody?.error) {
          const debugInfo = `\n\n[Debug Info]\nRequested Model: ${requestedModel || "Unknown"}\nEffective Model: ${effectiveModel || "Unknown"}\nProject: ${projectId || "Unknown"}\nEndpoint: ${endpoint || "Unknown"}\nStatus: ${response.status}\nRequest ID: ${headers.get('x-request-id') || "N/A"}${toolDebugMissing !== undefined ? `\nTool Debug Missing: ${toolDebugMissing}` : ""}${toolDebugSummary ? `\nTool Debug Summary: ${toolDebugSummary}` : ""}${toolDebugPayload ? `\nTool Debug Payload: ${toolDebugPayload}` : ""}`;
          errorBody.error.message = (errorBody.error.message || "Unknown error") + debugInfo;
          
          return new Response(JSON.stringify(errorBody), {
             status: response.status,
             statusText: response.statusText,
             headers
          });
       }
       
      if (errorBody?.error?.details && Array.isArray(errorBody.error.details)) {
          const retryInfo = errorBody.error.details.find(
            (detail: any) => detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
          );
          
          if (retryInfo?.retryDelay) {
            const match = retryInfo.retryDelay.match(/^([\d.]+)s$/);
            if (match && match[1]) {
              const retrySeconds = parseFloat(match[1]);
              if (!isNaN(retrySeconds) && retrySeconds > 0) {
                const retryAfterSec = Math.ceil(retrySeconds).toString();
                const retryAfterMs = Math.ceil(retrySeconds * 1000).toString();
                headers.set('Retry-After', retryAfterSec);
                headers.set('retry-after-ms', retryAfterMs);
              }
            }
          }
        }
    }
    
    const init = {
      status: response.status,
      statusText: response.statusText,
      headers,
    };

    const usageFromSse = streaming && isEventStreamResponse ? extractUsageFromSsePayload(text) : null;
    const parsed: AntigravityApiBody | null = !streaming || !isEventStreamResponse ? parseAntigravityApiBody(text) : null;
    const patched = parsed ? rewriteAntigravityPreviewAccessError(parsed, response.status, requestedModel) : null;
    const effectiveBody = patched ?? parsed ?? undefined;

    const usage = usageFromSse ?? (effectiveBody ? extractUsageMetadata(effectiveBody) : null);
    if (usage?.cachedContentTokenCount !== undefined) {
      headers.set("x-antigravity-cached-content-token-count", String(usage.cachedContentTokenCount));
      if (usage.totalTokenCount !== undefined) {
        headers.set("x-antigravity-total-token-count", String(usage.totalTokenCount));
      }
      if (usage.promptTokenCount !== undefined) {
        headers.set("x-antigravity-prompt-token-count", String(usage.promptTokenCount));
      }
      if (usage.candidatesTokenCount !== undefined) {
        headers.set("x-antigravity-candidates-token-count", String(usage.candidatesTokenCount));
      }
    }

    logAntigravityDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload" : undefined,
      headersOverride: headers,
    });

    if (streaming && response.ok && isEventStreamResponse) {
      return new Response(transformStreamingPayload(text), init);
    }

    if (!parsed) {
      return new Response(text, init);
    }

    if (effectiveBody?.response !== undefined) {
      return new Response(JSON.stringify(effectiveBody.response), init);
    }

    if (patched) {
      return new Response(JSON.stringify(patched), init);
    }

    return new Response(text, init);
  } catch (error) {
    logAntigravityDebugResponse(debugContext, response, {
      error,
      note: "Failed to transform Antigravity response",
    });
    return response;
  }
}
