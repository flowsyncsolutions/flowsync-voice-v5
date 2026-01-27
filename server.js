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
const ISSUE_SILENCE_FINALIZE_MS = 2000;
const ISSUE_MAX_LISTEN_MS = 20000;
const ISSUE_APPEND_DEDUP_WINDOW_MS = 800;
const FLOW_CONFIG = {
  flow: "apartment_maintenance_intake_v1",
  steps: [
    {
      step_id: "greeting",
      prompt:
        "Thanks for calling apartment maintenance. I’m here to help with your maintenance request.",
      expected_input_type: "none",
      field_name: null,
    },
    {
      step_id: "unit_number",
      prompt: "To get this started, what is your unit number?",
      expected_input_type: "text",
      field_name: "unit_number",
    },
    {
      step_id: "issue_description",
      prompt: "Please briefly describe the maintenance issue you’re experiencing.",
      expected_input_type: "text",
      field_name: "issue_description",
    },
    {
      step_id: "emergency_detection",
      type: "compute",
      source_field: "issue_description",
      field_name: "is_emergency",
      emergency_keywords: [
        "fire",
        "smoke",
        "gas",
        "flood",
        "water leak",
        "no heat",
        "sparks",
      ],
    },
    {
      step_id: "emergency_ack",
      prompt:
        "I understand this sounds urgent. If you’re in danger, please call 911 now. I’ll log this as an emergency for maintenance.",
      expected_input_type: "none",
      field_name: null,
      only_if_emergency: true,
    },
    {
      step_id: "permission_to_enter",
      prompt: "Do we have permission to enter your unit if you’re not home? Please say yes or no.",
      expected_input_type: "yes_no",
      field_name: "permission_to_enter",
      max_retries: 1,
    },
    {
      step_id: "pets_present",
      prompt: "Are there any pets in the unit? Please say yes or no.",
      expected_input_type: "yes_no",
      field_name: "pets_present",
      max_retries: 1,
    },
    {
      step_id: "confirmation",
      prompt: "Got it. I’ll submit this maintenance ticket now.",
      expected_input_type: "none",
      field_name: null,
    },
    {
      step_id: "end_call",
      prompt: "Thank you for calling. Goodbye.",
      expected_input_type: "none",
      field_name: null,
    },
  ],
};
const DEEPGRAM_WS_URL =
  "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000";

const silenceTimers = new Map();
const sttSessions = new Map();
const contextCache = new Map();
const flowState = new Map();

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
  const state = flowState.get(callControlId);
  if (state?.issueFinalizeTimer) {
    clearTimeout(state.issueFinalizeTimer);
  }
  if (state?.issueMaxTimer) {
    clearTimeout(state.issueMaxTimer);
  }
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
  flowState.delete(callControlId);
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

function resolveFromNumber(payload) {
  if (!payload) return null;
  if (typeof payload.from === "string" && payload.from.trim()) {
    return payload.from;
  }
  if (typeof payload.from_number === "string" && payload.from_number.trim()) {
    return payload.from_number;
  }
  if (payload.from && typeof payload.from === "object") {
    if (typeof payload.from.phone_number === "string" && payload.from.phone_number.trim()) {
      return payload.from.phone_number;
    }
    if (typeof payload.from.number === "string" && payload.from.number.trim()) {
      return payload.from.number;
    }
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

function normalizeIssueText(text) {
  return (text || "")
    .trim()
    .replace(/\s+/g, " ");
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

function isTooShortIssue(text) {
  const clean = normalizeIssueText(text);
  const wordCount = clean ? clean.split(/\s+/).filter(Boolean).length : 0;
  const charCount = clean.length;
  return wordCount < 2 || charCount < 10;
}

function parseYesNo(text) {
  const norm = normalizeText(text);
  if (!norm) return null;
  if (/\b(yes|yeah|yep|sure|ok|okay|affirmative)\b/.test(norm)) return true;
  if (/\b(no|nope|nah|negative)\b/.test(norm)) return false;
  return null;
}

function computeEmergency(issueText, keywords) {
  const norm = normalizeText(issueText || "");
  if (!norm) return false;
  const lowerKeywords = (keywords || []).map((k) => normalizeText(k)).filter(Boolean);
  return lowerKeywords.some((kw) => kw && norm.includes(kw));
}

function clearIssueTimers(state) {
  if (state.issueFinalizeTimer) {
    clearTimeout(state.issueFinalizeTimer);
    state.issueFinalizeTimer = null;
  }
  if (state.issueMaxTimer) {
    clearTimeout(state.issueMaxTimer);
    state.issueMaxTimer = null;
  }
}

async function finalizeIssue(callControlId) {
  const state = flowState.get(callControlId);
  if (!state || state.step !== "issue_description" || !state.issueListeningActive) return;

  clearIssueTimers(state);
  state.issueListeningActive = false;

  const issue = normalizeIssueText(state.issueBuffer);
  const words = issue ? issue.split(/\s+/).filter(Boolean).length : 0;
  const chars = issue.length;

  console.log(
    `[apt flow] issue_finalize call_control_id=${callControlId} buffer="${issue}" chars=${chars} words=${words}`
  );

  state.data.issue_description = issue;
  console.log(
    `[apt flow] captured issue_description="${issue}" call_control_id=${callControlId}`
  );

  const keywords = [
    "fire",
    "smoke",
    "gas",
    "flood",
    "leak",
    "water leak",
    "no heat",
    "sparks",
  ];
  const normIssue = normalizeText(issue);
  const hits = keywords.filter((kw) => normIssue.includes(normalizeText(kw)));
  const isEmergency = hits.length > 0;
  state.data.is_emergency = isEmergency;
  console.log(
    `[apt flow] emergency=${isEmergency} keywords_hit=[${hits.join(",")}] call_control_id=${callControlId}`
  );

  if (isEmergency) {
    console.log(
      `[apt flow] emergency_ack spoken=true call_control_id=${callControlId}`
    );
    await sendTelnyxAction(callControlId, "speak", {
      payload:
        "I understand this sounds urgent. If you’re in danger, please call 911 now. I’ll log this as an emergency for maintenance.",
      voice: "female",
      language: "en-US",
    });
  }

  state.step = "permission_to_enter";
  await sendTelnyxAction(callControlId, "speak", {
    payload:
      "Do we have permission to enter your unit if you're not home? Please say yes or no.",
    voice: "female",
    language: "en-US",
  });
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

async function initializeFlow(callControlId, toNumber, fromNumber) {
  cancelSilenceTimer(callControlId, "apt_flow_start");
  flowState.set(callControlId, {
    step: "unit_number",
    data: { to_number: toNumber || "", from_number: fromNumber || "" },
    issueRetryUsed: false,
    issueBuffer: "",
    issueLastHeardAt: 0,
    issueFinalizeTimer: null,
    issueMaxTimer: null,
    issueListeningActive: false,
    lastIssueChunk: "",
    lastIssueChunkAt: 0,
    ingested: false,
  });
  console.log(`[apt flow] started call_control_id=${callControlId}`);
  await sendTelnyxAction(callControlId, "speak", {
    payload: "To get this started, what is your unit number?",
    voice: "female",
    language: "en-US",
  });
}

async function handleFlowTranscript(callControlId, transcript) {
  const state = flowState.get(callControlId);
  if (!state) return;

  if (state.step === "unit_number") {
    const unit = (transcript || "").trim();
    state.data.unit_number = unit;
    state.step = "issue_description";
    console.log(
      `[apt flow] captured unit_number="${unit}" call_control_id=${callControlId}`
    );
    console.log(`[apt flow] prompting issue_description call_control_id=${callControlId}`);
    clearIssueTimers(state);
    state.issueListeningActive = true;
    state.issueBuffer = "";
    state.lastIssueChunk = "";
    state.lastIssueChunkAt = 0;
    state.issueLastHeardAt = Date.now();
    state.issueMaxTimer = setTimeout(
      () => finalizeIssue(callControlId),
      ISSUE_MAX_LISTEN_MS
    );
    console.log(
      `[apt flow] issue_listen_start call_control_id=${callControlId} silence_finalize_ms=${ISSUE_SILENCE_FINALIZE_MS} max_listen_ms=${ISSUE_MAX_LISTEN_MS}`
    );
    await sendTelnyxAction(callControlId, "speak", {
      payload: "Please briefly describe the maintenance issue you’re experiencing.",
      voice: "female",
      language: "en-US",
    });
    return;
  }

  if (state.step === "issue_description") {
    const issueChunk = normalizeIssueText(transcript);
    if (!issueChunk) {
      return;
    }

    const now = Date.now();
    if (
      state.lastIssueChunk &&
      issueChunk === state.lastIssueChunk &&
      now - state.lastIssueChunkAt < ISSUE_APPEND_DEDUP_WINDOW_MS
    ) {
      return;
    }

    state.lastIssueChunk = issueChunk;
    state.lastIssueChunkAt = now;

    if (!state.issueBuffer) {
      state.issueBuffer = issueChunk;
    } else {
      state.issueBuffer = `${state.issueBuffer} ${issueChunk}`.trim();
    }

    console.log(
      `[apt flow] issue_chunk call_control_id=${callControlId} text="${issueChunk}" buffer_chars=${state.issueBuffer.length}`
    );

    state.issueLastHeardAt = now;
    clearIssueTimers(state);
    state.issueFinalizeTimer = setTimeout(
      () => finalizeIssue(callControlId),
      ISSUE_SILENCE_FINALIZE_MS
    );
    state.issueMaxTimer = setTimeout(
      () => finalizeIssue(callControlId),
      ISSUE_MAX_LISTEN_MS
    );
    console.log(
      `[apt flow] issue_finalize_scheduled call_control_id=${callControlId} in_ms=${ISSUE_SILENCE_FINALIZE_MS}`
    );
    return;
  }

  if (state.step === "permission_to_enter") {
    const parsed = parseYesNo(transcript);
    if (parsed === null) {
      const tries = state.retries_permission || 0;
      if (tries < 1) {
        state.retries_permission = tries + 1;
        await sendTelnyxAction(callControlId, "speak", {
          payload:
            "Do we have permission to enter your unit if you're not home? Please say yes or no.",
          voice: "female",
          language: "en-US",
        });
        return;
      }
    }
    state.data.permission_to_enter = parsed;
    console.log(
      `[apt flow] captured permission_to_enter=${parsed} call_control_id=${callControlId}`
    );
    state.step = "pets_present";
    await sendTelnyxAction(callControlId, "speak", {
      payload: "Are there any pets in the unit? Please say yes or no.",
      voice: "female",
      language: "en-US",
    });
    return;
  }

  if (state.step === "pets_present") {
    const parsed = parseYesNo(transcript);
    if (parsed === null) {
      const tries = state.retries_pets || 0;
      if (tries < 1) {
        state.retries_pets = tries + 1;
        await sendTelnyxAction(callControlId, "speak", {
          payload: "Are there any pets in the unit? Please say yes or no.",
          voice: "female",
          language: "en-US",
        });
        return;
      }
    }
    state.data.pets_present = parsed;
    console.log(
      `[apt flow] captured pets_present=${parsed} call_control_id=${callControlId}`
    );
    await sendTelnyxAction(callControlId, "speak", {
      payload: "Got it. I'll submit this maintenance ticket now.",
      voice: "female",
      language: "en-US",
    });
    await sendTelnyxAction(callControlId, "speak", {
      payload: "Thank you for calling. Goodbye.",
      voice: "female",
      language: "en-US",
    });
    const summaryLines = [
      `Unit: ${state.data.unit_number || ""}`,
      `Issue: ${state.data.issue_description || ""}`,
      `Emergency: ${state.data.is_emergency === undefined ? "" : state.data.is_emergency}`,
      `Permission to enter: ${
        state.data.permission_to_enter === undefined ? "" : state.data.permission_to_enter
      }`,
      `Pets present: ${
        state.data.pets_present === undefined ? "" : state.data.pets_present
      }`,
      `Caller: ${state.data.from_number || ""}`,
    ];
    const ticketSummary = summaryLines.join("\n");

    const fieldsLog = {
      unit_number: state.data.unit_number,
      issue_description: state.data.issue_description,
      is_emergency: state.data.is_emergency,
      permission_to_enter: state.data.permission_to_enter,
      pets_present: state.data.pets_present,
    };
    console.log(
      `[apt flow] completed fields=${JSON.stringify(
        fieldsLog
      )} call_control_id=${callControlId}`
    );
    if (!state.ingested) {
      state.ingested = true;
      const payload = {
        call_control_id: callControlId,
        to_number: state.data.to_number || "",
        from_number: state.data.from_number || "",
        unit_number: state.data.unit_number || "",
        issue_description: state.data.issue_description || "",
        is_emergency: Boolean(state.data.is_emergency),
        permission_to_enter:
          state.data.permission_to_enter === undefined ? null : state.data.permission_to_enter,
        pets_present:
          state.data.pets_present === undefined ? null : state.data.pets_present,
        transcript: ticketSummary,
        created_at: new Date().toISOString(),
      };
      postMaintenanceEvent(callControlId, payload);
    }

    state.step = "complete";
    const session = sttSessions.get(callControlId);
    if (session) {
      session.flowComplete = true;
    }
    return;
  }
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

async function handleTelnyxEvent(eventType, payload, reqHost) {
  const callControlId = payload?.call_control_id;
  const toNumber = resolveToNumber(payload);
  const fromNumber = resolveFromNumber(payload);

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
      startTelnyxStreaming(callControlId, reqHost).catch((error) => {
        console.error(
          JSON.stringify({
            level: "error",
            message: "streaming_start failed",
            call_control_id: callControlId,
            error: error?.message || String(error),
          })
        );
      });
      initializeFlow(callControlId, toNumber, fromNumber).catch((error) => {
        console.error(
          JSON.stringify({
            level: "error",
            message: "flow start failed",
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
  const reqHost = req.headers["host"];

  logEvent(eventType, payload);
  res.status(200).json({ status: "ok" });

  handleTelnyxEvent(eventType, payload, reqHost).catch((error) => {
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

const HOST = "0.0.0.0";
const server = app.listen(PORT, HOST, () => {
  console.log(`[v5] listening on http://${HOST}:${PORT}`);
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
    flowComplete: false,
    sttFinalCount: 0,
    context: contextCache.get(callControlId) || null,
  };
  sttSessions.set(callControlId, session);

  const dgWs = new WebSocket(DEEPGRAM_WS_URL, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  session.deepgramWs = dgWs;

  dgWs.on("message", (data) => {
    if (session.flowComplete) return;
    session.sttFinalCount += 1;
    let message = null;
    try {
      message = JSON.parse(data.toString());
    } catch (_e) {
      return;
    }

    const alt = message?.channel?.alternatives?.[0];
    const isFinal = Boolean(message?.is_final);

    if (!isFinal || !alt?.transcript) return;

    cancelSilenceTimer(callControlId, "stt_final");
    const conf =
      typeof alt.confidence === "number"
        ? alt.confidence.toFixed(2)
        : "n/a";
    console.log(
      `[v5 STT] call_control_id=${callControlId} n=${session.sttFinalCount} conf=${conf} text="${alt.transcript}"`
    );

    const hasFlow = flowState.has(callControlId);
    if (hasFlow) {
      handleFlowTranscript(callControlId, alt.transcript).catch((error) => {
        console.error(
          JSON.stringify({
            level: "error",
            message: "Flow handling failed",
            call_control_id: callControlId,
            error: error?.message || String(error),
          })
        );
      });
    } else {
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
async function postMaintenanceEvent(callControlId, payload) {
  if (!FLOWSYNC_BASE_URL || !FLOWSYNC_API_KEY) {
    console.log(
      `[v5 Ingest] call_control_id=${callControlId} http_status=skipped bytes=0`
    );
    return;
  }

  const url = `${FLOWSYNC_BASE_URL}/api/ingest/maintenance-event`;
  const body = JSON.stringify(payload);
  const size = Buffer.byteLength(body, "utf8");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": FLOWSYNC_API_KEY,
      },
      body,
    });

    const status = response.status;
    await response.text().catch(() => "");
    console.log(
      `[v5 Ingest] call_control_id=${callControlId} http_status=${status} bytes=${size}`
    );
  } catch (error) {
    console.log(
      `[v5 Ingest] call_control_id=${callControlId} http_status=error bytes=${size} msg=${
        error?.message || String(error)
      }`
    );
  }
}
