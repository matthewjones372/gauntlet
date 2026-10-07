// Minimal stand-in for POST /v1/messages so the compiled binary's Anthropic
// request and response decoding can be exercised without a real API key.
Bun.serve({
  port: 8787,
  async fetch(req) {
    const body = await req.json()
    console.error("stub got", req.method, new URL(req.url).pathname, "model=" + body.model,
      "key=" + (req.headers.get("x-api-key") ? "present" : "missing"))
    return Response.json({
      id: "msg_1", type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "pong", citations: null }],
      stop_reason: "end_turn", stop_sequence: null, container: null, context_management: null,
      usage: {
        input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        server_tool_use: null, service_tier: "standard", inference_geo: null, iterations: null,
      },
    })
  },
})
