const express = require("express");

const app = express();
const PORT = process.env.PORT || 8080;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const GREETING =
  "Hi, thanks for calling. Someone from the FlowSync team will be with you shortly.";

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

async function handleTelnyxEvent(eventType, payload) {
  const callControlId = payload?.call_control_id;

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
      await sendTelnyxAction(callControlId, "speak", {
        payload: GREETING,
        voice: "female",
        language: "en-US",
      });
      break;
    case "call.hangup":
      // Nothing to do beyond logging.
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`FlowSync voice v5 listening on port ${PORT}`);
});
