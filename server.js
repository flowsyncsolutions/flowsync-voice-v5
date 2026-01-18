const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const PORT = process.env.PORT || 8080;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const FLOWSYNC_BASE_URL = process.env.FLOWSYNC_BASE_URL;
const FLOWSYNC_API_KEY = process.env.FLOWSYNC_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const MEDIA_WS_URL = process.env.MEDIA_WS_URL;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const GREETING =
  "Hi, thanks for calling. Someone from the FlowSync team will be with you shortly.";
const SILENCE_REPROMPT_MS = 9000;
const SILENCE_REPROMPT_TEXT = "How can I help you today?";
const CALLBACK_OFFER = "Would you like someone to call you back?";
const DEEPGRAM_WS_URL =
  "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000";

const silenceTimers = new Map();
const sttSessions = new Map();
const contextCache = new Map();

app.use(express.json({ type: "*/*" }));

function logEvent(eventType, payload) {
  const entry = {
    event_type: eventType,
    call_control_id: payload?.call_control_id || null,
    from_number: payload?.from || null,
    to_number: payload?.to || null,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(entry));
}

async function sendTelnyxAction(callControlId, action, body) {
  if (!TELNYX_API_KEY) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "TELNYX_API_KEY is not set; skipping Call Control action",
        action,
        call_control_id: callControlId,
      })
    );
    return;
  }

  const url = `${TELNYX_API_BASE}/calls/${callControlId}/actions/${action}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        JSON.stringify({
          level: "error",
          message: "Telnyx action failed",
          action,
          call_control_id: callControlId,
          status: response.status,
          body: errorBody,
        })
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Telnyx action threw",
        action,
        call_control_id: callControlId,
        error: error?.message || String(error),
      })
    );
  }
}

function scheduleSilenceTimer(callControlId) {
  if (silenceTimers.has(callControlId)) {
    return;
  }

  const timer = setTimeout(() => {
    console.log(`[v5 Silence] fired call_control_id=${callControlId}`);
    silenceTimers.delete(callControlId);
    sendTelnyxAction(callControlId, "speak", {
      payload: SILENCE_REPROMPT_TEXT,
      voice: "female",
      language: "en-US",
    }).catch((error) => {
      console.error(
        JSON.stringify({
          level: "error",
          message: "Silence reprompt failed",
          call_control_id: callControlId,
          error: error?.message || String(error),
        })
      );
    });
  }, SILENCE_REPROMPT_MS);

  silenceTimers.set(callControlId, timer);
  console.log(
    `[v5 Silence] scheduled call_control_id=${callControlId} timeout_ms=${SILENCE_REPROMPT_MS}`
  );
}

function cancelSilenceTimer(callControlId, reason) {
  const timer = silenceTimers.get(callControlId);
  if (!timer) return;
  clearTimeout(timer);
  silenceTimers.delete(callControlId);
  console.log(
    `[v5 Silence] canceled call_control_id=${callControlId} reason=${reason}`
  );
}

function cleanupStt(callControlId) {
  const session = sttSessions.get(callControlId);
  if (!session) return;

  if (session.deepgramWs && session.deepgramWs.readyState === WebSocket.OPEN) {
    try {
      session.deepgramWs.close();
    } catch (_e) {
      // ignore
    }
  }

  sttSessions.delete(callControlId);
  contextCache.delete(callControlId);
}

async function fetchGreeting(toNumber, callControlId) {
  if (!toNumber || !FLOWSYNC_BASE_URL || !FLOWSYNC_API_KEY) {
    console.log(
      `[v5 Config] to=${toNumber || "unknown"} http_status=skipped greeting_source=fallback`
    );
    return { greeting: GREETING, source: "fallback" };
  }

  const url = `${FLOWSYNC_BASE_URL}/api/voice/context?phoneNumber=${encodeURIComponent(
    toNumber
  )}`;

  try {
    const response = await fetch(url, {
      headers: {
        "x-api-key": FLOWSYNC_API_KEY,
      },
    });

    const status = response.status;
    let greetingText = null;

    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      const context = data?.context || data;
      if (callControlId) {
        contextCache.set(callControlId, context);
      }
      greetingText = context?.greeting || context?.greeting_line || null;
    }

    const source = greetingText ? "dashboard" : "fallback";
    console.log(
      `[v5 Config] to=${toNumber} http_status=${status} greeting_source=${source}`
    );

    return { greeting: greetingText || GREETING, source };
  } catch (error) {
    console.log(
      `[v5 Config] to=${toNumber} http_status=error greeting_source=fallback`
    );
    return { greeting: GREETING, source: "fallback" };
  }
}

function resolveToNumber(payload) {
  if (!payload) return null;
  if (typeof payload.to_number === "string" && payload.to_number.trim()) {
    return payload.to_number;
  }
  if (
    typeof payload.to_phone_number === "string" &&
    payload.to_phone_number.trim()
  ) {
    return payload.to_phone_number;
  }
  if (payload.to && typeof payload.to === "object") {
    if (typeof payload.to.phone_number === "string" && payload.to.phone_number.trim()) {
      return payload.to.phone_number;
    }
    if (typeof payload.to.number === "string" && payload.to.number.trim()) {
      return payload.to.number;
    }
  }
  if (typeof payload.to === "string" && payload.to.trim()) {
    return payload.to;
  }
  return null;
}

async function startTelnyxStreaming(callControlId, reqHost) {
  if (!DEEPGRAM_API_KEY) {
    console.log(
      `[v5 STT] streaming_start skipped call_control_id=${callControlId} reason=missing_config`
    );
    return;
  }

  const baseWs =
    MEDIA_WS_URL ||
    (reqHost ? `wss://${reqHost}/media` : null);

  if (!baseWs) {
    console.log(
      `[v5 STT] streaming_start skipped call_control_id=${callControlId} reason=missing_host`
    );
    return;
  }

  const streamUrl = `${baseWs}?call_control_id=${encodeURIComponent(callControlId)}`;

  await sendTelnyxAction(callControlId, "streaming_start", {
    stream_url: streamUrl,
    stream_track: "inbound_track",
  });
}

function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countSentences(text) {
  return (text || "")
    .split(/[.!?]+/g)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

function isShortAnswer(answer) {
  const text = (answer || "").trim();
  return text.length > 0 && text.length <= 280;
}

function findFaqMatch(transcript, faqs) {
  if (!transcript || !Array.isArray(faqs) || faqs.length === 0) return null;
  const normTranscript = normalizeText(transcript);
  if (!normTranscript) return null;

  const transcriptTokens = new Set(normTranscript.split(" ").filter(Boolean));
  let best = null;

  faqs.forEach((faq, index) => {
    const questionNorm = normalizeText(faq?.question || "");
    const keywords = Array.isArray(faq?.keywords) ? faq.keywords : [];
    let score = 0;

    if (questionNorm && normTranscript.includes(questionNorm)) {
      score += 5;
    } else {
      const qTokens = questionNorm.split(" ").filter(Boolean);
      qTokens.forEach((tok) => {
        if (transcriptTokens.has(tok)) score += 1;
      });
    }

    keywords.forEach((kw) => {
      const kwNorm = normalizeText(kw);
      if (kwNorm && normTranscript.includes(kwNorm)) {
        score += 2;
      }
    });

    if (score > 0 && (!best || score > best.score)) {
      best = { faq, score, index };
    }
  });

  if (!best || best.score < 3) return null;
  return best;
}

async function handleFaqResponse(callControlId, transcript) {
  const session = sttSessions.get(callControlId);
  const context = session?.context || contextCache.get(callControlId) || {};
  const faqs = Array.isArray(context?.faqs) ? context.faqs : [];
  const contextCached = Boolean(session?.context || contextCache.get(callControlId));

  console.log(
    `[v5 FAQ] call_control_id=${callControlId} context_cached=${contextCached} faqs=${faqs.length}`
  );

  const match = findFaqMatch(transcript, faqs);

  if (!match || !match.faq?.answer) {
    console.log(
      `[v5 FAQ] call_control_id=${callControlId} match=none answer_len=0 action=callback`
    );
    await sendTelnyxAction(callControlId, "speak", {
      payload: CALLBACK_OFFER,
      voice: "female",
      language: "en-US",
    });
    return;
  }

  const answer = match.faq.answer || "";
  const short = isShortAnswer(answer);
  const action = short ? "speak_answer" : "callback";

  console.log(
    `[v5 FAQ] call_control_id=${callControlId} match=${match.index} answer_len=${answer.length} action=${action}`
  );

  if (short) {
    await sendTelnyxAction(callControlId, "speak", {
      payload: answer,
      voice: "female",
      language: "en-US",
    });
  } else {
    await sendTelnyxAction(callControlId, "speak", {
      payload: CALLBACK_OFFER,
      voice: "female",
      language: "en-US",
    });
  }
}

async function handleTelnyxEvent(eventType, payload) {
  const callControlId = payload?.call_control_id;
  const toNumber = resolveToNumber(payload);

  if (!callControlId) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Missing call_control_id on event",
        event_type: eventType,
      })
    );
    return;
  }

  switch (eventType) {
    case "call.initiated":
      await sendTelnyxAction(callControlId, "answer");
      break;
    case "call.answered":
      const { greeting } = await fetchGreeting(toNumber, callControlId);
      await sendTelnyxAction(callControlId, "speak", {
        payload: greeting,
        voice: "female",
        language: "en-US",
      });
      scheduleSilenceTimer(callControlId);
      startTelnyxStreaming(callControlId, payload?.req_host).catch((error) => {
        console.error(
          JSON.stringify({
            level: "error",
            message: "streaming_start failed",
            call_control_id: callControlId,
            error: error?.message || String(error),
          })
        );
      });
      break;
    case "call.hangup":
      cancelSilenceTimer(callControlId, "hangup");
      cleanupStt(callControlId);
      break;
    default:
      // Unknown or unhandled event; logged already.
      break;
  }
}

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

app.post("/telnyx/call", (req, res) => {
  const eventType = req.body?.data?.event_type || "unknown";
  const payload = req.body?.data?.payload || {};
  payload.req_host = req.headers["host"];

  logEvent(eventType, payload);
  res.status(200).json({ status: "ok" });

  handleTelnyxEvent(eventType, payload).catch((error) => {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Unhandled error in event handler",
        error: error?.message || String(error),
        event_type: eventType,
      })
    );
  });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`FlowSync voice v5 listening on port ${PORT}`);
});

const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const callControlId = url.searchParams.get("call_control_id");

  if (!callControlId) {
    ws.close();
    return;
  }

  if (!DEEPGRAM_API_KEY) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Missing DEEPGRAM_API_KEY; closing media socket",
        call_control_id: callControlId,
      })
    );
    ws.close();
    return;
  }

  const session = {
    callControlId,
    telnyxWs: ws,
    deepgramWs: null,
    finalized: false,
    context: contextCache.get(callControlId) || null,
  };
  sttSessions.set(callControlId, session);

  const dgWs = new WebSocket(DEEPGRAM_WS_URL, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  session.deepgramWs = dgWs;

  dgWs.on("message", (data) => {
    if (session.finalized) return;
    let message = null;
    try {
      message = JSON.parse(data.toString());
    } catch (_e) {
      return;
    }

    const alt = message?.channel?.alternatives?.[0];
    const isFinal = Boolean(message?.is_final);

    if (!isFinal || !alt?.transcript) return;

    session.finalized = true;
    cancelSilenceTimer(callControlId, "stt_final");
    const conf =
      typeof alt.confidence === "number"
        ? alt.confidence.toFixed(2)
        : "n/a";
    console.log(
      `[v5 STT] call_control_id=${callControlId} conf=${conf} text="${alt.transcript}"`
    );

    handleFaqResponse(callControlId, alt.transcript).catch((error) => {
      console.error(
        JSON.stringify({
          level: "error",
          message: "FAQ handling failed",
          call_control_id: callControlId,
          error: error?.message || String(error),
        })
      );
    });

    try {
      dgWs.close();
    } catch (_e) {
      // ignore
    }
  });

  dgWs.on("close", () => {
    session.deepgramWs = null;
  });

  dgWs.on("error", () => {
    session.deepgramWs = null;
  });

  ws.on("message", (data) => {
    if (session.finalized) return;
    if (!session.deepgramWs || session.deepgramWs.readyState !== WebSocket.OPEN) {
      return;
    }

    let message = null;
    try {
      message = JSON.parse(data.toString());
    } catch (_e) {
      return;
    }

    if (!session.loggedFirstMessage) {
      console.log(
        `[v5 STT] telnyx_ws_message event=${message.event} has_payload=${Boolean(
          message.payload
        )} has_media_payload=${Boolean(message.media?.payload)}`
      );
      session.loggedFirstMessage = true;
    }

    const mediaPayload = message.payload || message.media?.payload;

    if (message.event !== "media" || !mediaPayload) return;

    try {
      const audio = Buffer.from(mediaPayload, "base64");
      session.deepgramWs.send(audio);
    } catch (_e) {
      // ignore bad media
    }
  });

  ws.on("close", () => {
    cleanupStt(callControlId);
  });

  ws.on("error", () => {
    cleanupStt(callControlId);
  });
});
