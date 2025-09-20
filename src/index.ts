import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import path, { join } from "path";
import { initConfig, initDir, cleanupLogFiles } from "./utils";
import { createServer } from "./server";
import { router } from "./utils/router";
import { apiKeyAuth } from "./middleware/auth";
import {
  cleanupPidFile,
  isServiceRunning,
  savePid,
} from "./utils/processCheck";
import { CONFIG_FILE } from "./constants";
import { createStream } from 'rotating-file-stream';
import { HOME_DIR } from "./constants";
import { sessionUsageCache } from "./utils/cache";
import {SSEParserTransform} from "./utils/SSEParser.transform";
import {SSESerializerTransform} from "./utils/SSESerializer.transform";
import {rewriteStream} from "./utils/rewriteStream";
import JSON5 from "json5";
import { IAgent } from "./agents/type";
import agentsManager from "./agents";
import { EventEmitter } from "node:events";
import { selectKeyForProvider, advanceOnSuccess, markKeyDisabled, shouldDisableForStatus } from "./utils/keyRotation";


const event = new EventEmitter()


async function initializeClaudeConfig() {
  const homeDir = homedir();
  const configPath = join(homeDir, ".claude.json");
  if (!existsSync(configPath)) {
    const userID = Array.from(
      { length: 64 },
      () => Math.random().toString(16)[2]
    ).join("");
    const configContent = {
      numStartups: 184,
      autoUpdaterStatus: "enabled",
      userID,
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "1.0.17",
      projects: {},
    };
    await writeFile(configPath, JSON.stringify(configContent, null, 2));
  }
}

interface RunOptions {
  port?: number;
}

async function run(options: RunOptions = {}) {
  // Check if service is already running
  const isRunning = await isServiceRunning()
  if (isRunning) {
    console.log("✅ Service is already running in the background.");
    return;
  }

  await initializeClaudeConfig();
  await initDir();
  // Clean up old log files, keeping only the 10 most recent ones
  await cleanupLogFiles();
  const config = await initConfig();


  let HOST = config.HOST || "127.0.0.1";

  if (config.HOST && !config.APIKEY) {
    HOST = "127.0.0.1";
    console.warn("⚠️ API key is not set. HOST is forced to 127.0.0.1.");
  }

  const port = config.PORT || 3456;

  // Save the PID of the background process
  savePid(process.pid);

  // Handle SIGINT (Ctrl+C) to clean up PID file
  process.on("SIGINT", () => {
    console.log("Received SIGINT, cleaning up...");
    cleanupPidFile();
    process.exit(0);
  });

  // Handle SIGTERM to clean up PID file
  process.on("SIGTERM", () => {
    cleanupPidFile();
    process.exit(0);
  });

  // Use port from environment variable if set (for background process)
  const servicePort = process.env.SERVICE_PORT
    ? parseInt(process.env.SERVICE_PORT)
    : port;

  // Configure logger based on config settings
  const pad = num => (num > 9 ? "" : "0") + num;
  const generator = (time, index) => {
    if (!time) {
      time = new Date()
    }

    var month = time.getFullYear() + "" + pad(time.getMonth() + 1);
    var day = pad(time.getDate());
    var hour = pad(time.getHours());
    var minute = pad(time.getMinutes());

    return `./logs/ccr-${month}${day}${hour}${minute}${pad(time.getSeconds())}${index ? `_${index}` : ''}.log`;
  };
  const loggerConfig =
    config.LOG !== false
      ? {
          level: config.LOG_LEVEL || "debug",
          stream: createStream(generator, {
            path: HOME_DIR,
            maxFiles: 3,
            interval: "1d",
            compress: false,
            maxSize: "50M"
          }),
        }
      : false;


  // Normalize providers: if api_keys present, use the first key as api_key
  const rawProviders = (config.Providers || config.providers) as any[];
  const normalizedProviders = Array.isArray(rawProviders)
    ? rawProviders.map((p: any) => {
        const first = Array.isArray(p?.api_keys) && p.api_keys.length > 0 ? p.api_keys[0] : null;
        if (first?.key) {
          return { ...p, api_key: first.key };
        }
        return p;
      })
    : rawProviders;

  const server = createServer({
    jsonPath: CONFIG_FILE,
    initialConfig: {
      // ...config,
      providers: normalizedProviders,
      HOST: HOST,
      PORT: servicePort,
      LOG_FILE: join(
        homedir(),
        ".claude-code-router",
        "claude-code-router.log"
      ),
    },
    logger: loggerConfig,
  });

  // Add global error handlers to prevent the service from crashing
  process.on("uncaughtException", (err) => {
    server.log.error("Uncaught exception:", err);
  });


  // Log default provider and model at startup
  try {
    const def = (config?.Router && (config.Router as any).default) as any;
    let providerName = "unknown";
    let modelName = "unknown";
    if (typeof def === "string" && def.trim()) {
      if (def.includes(",")) {
        const [prov, mod] = def.split(",").map(s => s.trim());
        providerName = prov || providerName;
        modelName = mod || modelName;
      } else {
        modelName = def.trim();
        // infer provider from Providers list
        const prov = (config.Providers || config.providers || []).find((p: any) =>
          Array.isArray(p?.models) && p.models.some((m: any) => String(m).toLowerCase() === String(modelName).toLowerCase())
        );
        if (prov?.name) providerName = prov.name;
      }
    }
    const _startupMsg = `Using provider: ${providerName}, model: ${modelName}`;
    try { (server as any)?.app?.log?.info?.({ provider: providerName, model: modelName }, _startupMsg); } catch {}
    console.log(_startupMsg);
  } catch {}

  // Log provider api_key names (do NOT log keys)
  try {
    const providers = (config.Providers || config.providers || []) as any[];
    for (const p of providers) {
      const names = Array.isArray(p?.api_keys)
        ? p.api_keys.map((k: any) => k?.name).filter(Boolean)
        : [];
      if (p?.name && names.length) {
        const msg = `Provider ${p.name} api_keys: ${names.join(", ")}`;
        try { (server as any)?.app?.log?.info?.({ provider: p.name, api_key_names: names }, msg); } catch {}
        console.log(msg);
      }
    }
  } catch {}


  process.on("unhandledRejection", (reason, promise) => {
    server.log.error("Unhandled rejection at:", promise, "reason:", reason);
  });
  // Add async preHandler hook for authentication
  server.addHook("preHandler", async (req, reply) => {
    return new Promise((resolve, reject) => {
      const done = (err?: Error) => {
        if (err) reject(err);
        else resolve();
      };
      // Call the async auth function
      apiKeyAuth(config)(req, reply, done).catch(reject);

    });
  });
  server.addHook("preHandler", async (req, reply) => {
    if (req.url.startsWith("/v1/messages")) {
      const useAgents = []

      for (const agent of agentsManager.getAllAgents()) {
        if (agent.shouldHandle(req, config)) {
          // 设置agent标识
          useAgents.push(agent.name)

          // change request body
          agent.reqHandler(req, config);

          // append agent tools
          if (agent.tools.size) {
            if (!req.body?.tools?.length) {
              req.body.tools = []
            }
            req.body.tools.unshift(...Array.from(agent.tools.values()).map(item => {
              return {
                name: item.name,
                description: item.description,
                input_schema: item.input_schema
              }
            }))
          }
        }
      }

      if (useAgents.length) {
        req.agents = useAgents;
      }
      await router(req, reply, {
        config,
        event
      });
    }
  });
  // Round-robin api_keys per provider on each /v1/messages request
  server.addHook("preHandler", async (req, _reply) => {
    try {
      if (!req.url.startsWith("/v1/messages")) return;
      const providersList = (config.Providers || config.providers || []) as any[];

      // Determine provider name for this request
      const bodyModel: string | undefined = req.body?.model;
      const def: string | undefined = (config?.Router && (config.Router as any).default) as any;
      const getProviderByModel = (model: string | undefined) => {
        if (!model) return undefined;
        if (model.includes(",")) {
          const [prov] = model.split(",").map((s: string) => s.trim());
          return providersList.find((p: any) => String(p?.name).toLowerCase() === prov.toLowerCase());
        }
        return providersList.find(
          (p: any) => Array.isArray(p?.models) && p.models.some((m: any) => String(m).toLowerCase() === String(model).toLowerCase())
        );
      };

      let provider = getProviderByModel(bodyModel) || getProviderByModel(def);
      if (!provider) return; // unknown provider

      if (Array.isArray(provider.api_keys) && provider.api_keys.length > 0) {
        const provName: string = provider.name;
        const { selected, chosenIndex, total, usedKeyId, allDisabled } = selectKeyForProvider(provider as any);

        // Track which key we used for this request (for error handling)
        (req as any)._ccrProviderName = provName;
        (req as any)._ccrUsedKeyId = usedKeyId;
        (req as any)._ccrChosenIndex = chosenIndex;
        (req as any)._ccrKeyTotal = total;

        // Update live provider apiKey in providerService
        try {
          server.app._server?.providerService?.updateProvider(provName, { apiKey: (selected as any)?.key });
          // Log only the name (never the key)
          server.app.log.info({ provider: provName, api_key_name: (selected as any)?.name }, "Using rotated api_key for provider");
          if (allDisabled) {
            server.app.log.warn({ provider: provName }, "All api_keys appear disabled for this provider; using next in rotation anyway.");
          }
        } catch {}
      }
    } catch {}
  });

  server.addHook("onError", async (request, reply, error) => {
    try {
      if ((request as any).url?.startsWith("/v1/messages")) {
        const status = (reply as any)?.statusCode || (error as any)?.statusCode || (error as any)?.status;
        // Simplified policy: allow 429 (rate limits); for any other 4xx, disable this key in router and surface error for manual handling
        const shouldDisable = shouldDisableForStatus(status);
        if (shouldDisable) {
          const prov = (request as any)._ccrProviderName;
          const keyId = (request as any)._ccrUsedKeyId;
          if (prov && keyId) {
            markKeyDisabled(prov, String(keyId));
            server.app.log.warn({ provider: prov, api_key_id: keyId, status }, "Disabled api_key due to non-429 4xx error (onError)");
          }
        }
      }
    } catch {}

    event.emit('onError', request, reply, error);
  })
  server.addHook("onSend", (req, reply, payload, done) => {
    if (req.sessionId && req.url.startsWith("/v1/messages")) {
      if (payload instanceof ReadableStream) {
        if (req.agents) {
          const abortController = new AbortController();
          const eventStream = payload.pipeThrough(new SSEParserTransform())
          let currentAgent: undefined | IAgent;
          let currentToolIndex = -1
          let currentToolName = ''
          let currentToolArgs = ''
          let currentToolId = ''
          const toolMessages: any[] = []
          const assistantMessages: any[] = []
          // 存储Anthropic格式的消息体，区分文本和工具类型
          return done(null, rewriteStream(eventStream, async (data, controller) => {
            try {
              // 检测工具调用开始
              if (data.event === 'content_block_start' && data?.data?.content_block?.name) {
                const agent = req.agents.find((name: string) => agentsManager.getAgent(name)?.tools.get(data.data.content_block.name))
                if (agent) {
                  currentAgent = agentsManager.getAgent(agent)
                  currentToolIndex = data.data.index
                  currentToolName = data.data.content_block.name
                  currentToolId = data.data.content_block.id
                  return undefined;
                }
              }

              // 收集工具参数
              if (currentToolIndex > -1 && data.data.index === currentToolIndex && data.data?.delta?.type === 'input_json_delta') {
                currentToolArgs += data.data?.delta?.partial_json;
                return undefined;
              }

              // 工具调用完成，处理agent调用
              if (currentToolIndex > -1 && data.data.index === currentToolIndex && data.data.type === 'content_block_stop') {
                try {
                  const args = JSON5.parse(currentToolArgs);
                  assistantMessages.push({
                    type: "tool_use",
                    id: currentToolId,
                    name: currentToolName,
                    input: args
                  })
                  const toolResult = await currentAgent?.tools.get(currentToolName)?.handler(args, {
                    req,
                    config
                  });
                  toolMessages.push({
                    "tool_use_id": currentToolId,
                    "type": "tool_result",
                    "content": toolResult
                  })
                  currentAgent = undefined
                  currentToolIndex = -1
                  currentToolName = ''
                  currentToolArgs = ''
                  currentToolId = ''
                } catch (e) {
                  console.log(e);
                }
                return undefined;
              }

              if (data.event === 'message_delta' && toolMessages.length) {
                req.body.messages.push({
                  role: 'assistant',
                  content: assistantMessages
                })
                req.body.messages.push({
                  role: 'user',
                  content: toolMessages
                })
                const response = await fetch(`http://127.0.0.1:${config.PORT}/v1/messages`, {
                  method: "POST",
                  headers: {
                    'x-api-key': config.APIKEY,
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify(req.body),
                })
                if (!response.ok) {
                  return undefined;
                }
                const stream = response.body!.pipeThrough(new SSEParserTransform())
                const reader = stream.getReader()
                while (true) {
                  try {
                    const {value, done} = await reader.read();
                    if (done) {
                      break;
                    }
                    if (['message_start', 'message_stop'].includes(value.event)) {
                      continue
                    }

                    // 检查流是否仍然可写
                    if (!controller.desiredSize) {
                      break;
                    }

                    controller.enqueue(value)
                  }catch (readError: any) {
                    if (readError.name === 'AbortError' || readError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                      abortController.abort(); // 中止所有相关操作
                      break;
                    }
                    throw readError;
                  }

                }
                return undefined
              }
              return data
            }catch (error: any) {
              console.error('Unexpected error in stream processing:', error);

              // 处理流提前关闭的错误
              if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                abortController.abort();
                return undefined;
              }

              // 其他错误仍然抛出
              throw error;
            }
          }).pipeThrough(new SSESerializerTransform()))
        }

        const [originalStream, clonedStream] = payload.tee();
        const read = async (stream: ReadableStream) => {
          const reader = stream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              // Process the value if needed
              const dataStr = new TextDecoder().decode(value);
              if (!dataStr.startsWith("event: message_delta")) {
                continue;
              }
              const str = dataStr.slice(27);
              try {
                const message = JSON.parse(str);
                sessionUsageCache.put(req.sessionId, message.usage);
              } catch {}
            }
          } catch (readError: any) {
            if (readError.name === 'AbortError' || readError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
              console.error('Background read stream closed prematurely');
            } else {
              console.error('Error in background stream reading:', readError);
            }
          } finally {
            reader.releaseLock();
          }
        }
        read(clonedStream);
        // Advance rotation index only on successful responses
        try {
          const prov = (req as any)._ccrProviderName;
          const chosen = (req as any)._ccrChosenIndex;
          const total = (req as any)._ccrKeyTotal;
          advanceOnSuccess(prov, chosen, total);
        } catch {}
        return done(null, originalStream)
      }
      sessionUsageCache.put(req.sessionId, payload.usage);
      if (typeof payload === 'object') {
        if ((payload as any).error) {
          try {
            const status = reply.statusCode;
            const err = (payload as any).error;
            // Simplified policy: allow 429 (rate limits); for any other 4xx, disable this key in router and surface error for manual handling
            const shouldDisable = shouldDisableForStatus(status);
            if (shouldDisable) {
              const prov = (req as any)._ccrProviderName;
              const keyId = (req as any)._ccrUsedKeyId;
              if (prov && keyId) {
                markKeyDisabled(prov, String(keyId));
                server.app.log.warn({ provider: prov, api_key_id: keyId, status }, "Disabled api_key due to non-429 4xx error");
                if (err?.message && typeof err.message === 'string') {
                  err.message += ` [CCR hint] The API key (${keyId}) encountered a non-429 4xx error and has been temporarily disabled in the router. Please remove or fix this key in your configuration.`;
                }
              }
            }
          } catch {}
          return done((payload as any).error, null);
        } else {
          // Advance rotation index only on successful responses
          try {
            const prov = (req as any)._ccrProviderName;
            const chosen = (req as any)._ccrChosenIndex;
            const total = (req as any)._ccrKeyTotal;
            advanceOnSuccess(prov, chosen, total);
          } catch {}
          return done(payload, null);
        }
      }
    }
    if (typeof payload === 'object' && (payload as any).error) {
      return done((payload as any).error, null);
    }
    done(null, payload)
  });
  server.addHook("onSend", async (req, reply, payload) => {
    event.emit('onSend', req, reply, payload);
    return payload;
  })


  server.start();
}

export { run };
// run();
