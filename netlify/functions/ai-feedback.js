// netlify/functions/ai-feedback.js
//
// Secure proxy to the Anthropic API for speaking assessment feedback.
// Updated: adds automatic retry with exponential backoff to handle
// rate-limit (429) and transient overload (529) errors when many
// students submit around the same time.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

// --- Retry configuration ---
const MAX_RETRIES = 4;          // total attempts = 1 initial + 4 retries = 5
const BASE_DELAY_MS = 1000;     // 1s, then 2s, 4s, 8s... (plus jitter)
const MAX_DELAY_MS = 15000;     // never wait longer than 15s between tries

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Decide if an error/status is worth retrying.
// 429 = rate limited, 529 = Anthropic overloaded, plus generic network errors.
function isRetryable(status) {
  return status === 429 || status === 529 || status === 503 || status === 502;
}

// Calculate backoff delay, honoring Anthropic's retry-after header if present.
function getRetryDelay(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const retryAfterMs = parseFloat(retryAfterHeader) * 1000;
    if (!isNaN(retryAfterMs) && retryAfterMs > 0) {
      return Math.min(retryAfterMs, MAX_DELAY_MS);
    }
  }
  // Exponential backoff with jitter: base * 2^attempt + random(0-500ms)
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 500;
  return Math.min(exponential + jitter, MAX_DELAY_MS);
}

async function callAnthropicWithRetry(requestBody, apiKey) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response;
    try {
      response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(requestBody),
      });
    } catch (networkErr) {
      // Network-level failure (DNS, timeout, etc.) — retry these too.
      lastError = networkErr;
      if (attempt < MAX_RETRIES) {
        const delay = getRetryDelay(attempt, null);
        await sleep(delay);
        continue;
      }
      throw new Error(`Network error after ${MAX_RETRIES} retries: ${networkErr.message}`);
    }

    if (response.ok) {
      return await response.json();
    }

    // Non-OK response. Check if retryable.
    if (isRetryable(response.status) && attempt < MAX_RETRIES) {
      const retryAfter = response.headers.get("retry-after");
      const delay = getRetryDelay(attempt, retryAfter);
      console.log(
        `Anthropic API returned ${response.status}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
      );
      await sleep(delay);
      continue;
    }

    // Not retryable, or out of retries — surface the error.
    let errorBody;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = { error: { message: response.statusText } };
    }
    const err = new Error(errorBody?.error?.message || `Anthropic API error ${response.status}`);
    err.status = response.status;
    throw err;
  }

  // Should not reach here, but just in case.
  throw lastError || new Error("Failed to get a response from Anthropic API after retries");
}

exports.handler = async (event) => {
  // CORS / method guard
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  // The live frontend (index.html) sends { prompt: "..." } — a single
  // fully-built prompt string — not separate transcript/speakingPrompt
  // fields. Keep this matching whatever index.html actually sends.
  const { prompt } = payload;

  if (!prompt || typeof prompt !== "string") {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing or invalid 'prompt' field" }),
    };
  }

  const apiKey = process.env.MY_AI_KEY;
  if (!apiKey) {
    console.error("MY_AI_KEY environment variable is not set");
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server misconfiguration: missing API key" }),
    };
  }

  const requestBody = {
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  };

  try {
    const data = await callAnthropicWithRetry(requestBody, apiKey);

    // index.html reads d.content[0].text directly and does its own JSON
    // extraction/parsing on the frontend. So we pass the raw Anthropic
    // response straight through unchanged — do NOT reshape it here.
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error("AI feedback error:", err.message);

    // Distinguish rate-limit errors so the frontend can show a
    // friendlier "lots of students submitting right now" message.
    const isRateLimit = err.status === 429 || err.status === 529;

    return {
      statusCode: isRateLimit ? 429 : 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: isRateLimit
          ? "The AI service is busy right now (lots of students submitting at once). Please wait a moment and click 'Try again'."
          : "Something went wrong generating feedback. Please try again.",
        retryable: true,
      }),
    };
  }
};
