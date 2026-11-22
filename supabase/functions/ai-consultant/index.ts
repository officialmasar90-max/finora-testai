// AI Financial Consultant Edge Function
//
// Proxies user messages to an AI provider chosen automatically by the Finora
// AI Hub router: the router classifies the question, picks the best available
// model (secret configured + adapter registered), and falls back to the next
// candidate on transient failures. API keys never reach the browser.
// Authenticates via the Supabase JWT, enforces a per-user daily message
// limit, reads the user's financial data directly from Supabase (Financial
// Context Builder + Financial Engine), and persists all messages to
// ai_conversations/ai_messages so conversation history is maintained.
//
// If no provider secret is configured, or every provider fails, the function
// returns a 502 with aiUnavailable so the frontend can inform the user — it
// never pretends to work.
//
// Rate limiting is atomic and enforced in the database: consume_ai_usage()
// reserves one message (daily quota + 60s burst window) in a single locked
// statement. The RPC runs AFTER the caller's JWT is verified and BEFORE any
// AI provider is contacted — a rejected request never costs provider credit.
// If the rate limiter itself fails, the function fails closed: the request is
// NOT forwarded to any provider.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { AiProviderError } from "../_shared/ai/errors.ts";
import { chatWithRouting } from "../_shared/ai/router.ts";
import type { AiChatResponse, AiMessage } from "../_shared/ai/types.ts";
import { buildFinancialContext, formatFinancialContext } from "../_shared/financial/builder.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Daily quota — unchanged from the previous configuration.
const MAX_DAILY_MESSAGES = 30;
// Burst limit: max requests per rolling 60-second window per user.
const BURST_LIMIT_PER_MINUTE = 5;

interface ConsumeAiUsageResult {
  allowed: boolean;
  reason: string | null;
  daily_used: number;
  daily_remaining: number;
  retry_after_seconds: number;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Rate-limit rejection: 429 with a machine-readable code. */
function rateLimited(
  error: "DAILY_LIMIT_REACHED" | "BURST_LIMIT_REACHED",
  message: string,
  remaining: number,
  retryAfterSeconds: number
): Response {
  const headers = {
    ...corsHeaders,
    "Content-Type": "application/json",
    "Retry-After": String(Math.max(1, retryAfterSeconds)),
  };
  return new Response(
    JSON.stringify({ error, message, remaining, retryAfterSeconds }),
    { status: 429, headers }
  );
}

/** Reserve one AI message via the atomic database rate limiter.
 *  Returns a rejection Response, or null when the reservation succeeded. */
async function consumeAiUsage(
  adminClient: ReturnType<typeof createClient>,
  userId: string
): Promise<Response | null> {
  const { data, error } = await adminClient.rpc("consume_ai_usage", {
    p_user_id: userId,
    p_daily_limit: MAX_DAILY_MESSAGES,
    p_burst_limit: BURST_LIMIT_PER_MINUTE,
  });

  if (error) {
    // Fail closed: a limiter failure must never let a request through.
    console.error("Rate limiter RPC failed (fail-closed):", error.message);
    return json(
      { error: "Terjadi kesalahan sistem. Silakan coba lagi." },
      500
    );
  }

  const result = Array.isArray(data) ? data[0] as ConsumeAiUsageResult | undefined : undefined;
  if (!result || typeof result.allowed !== "boolean") {
    console.error("Rate limiter RPC returned unexpected shape (fail-closed)");
    return json(
      { error: "Terjadi kesalahan sistem. Silakan coba lagi." },
      500
    );
  }

  if (!result.allowed) {
    console.warn(
      `Rate limit: user=${userId} status=${result.reason} used=${result.daily_used} remaining=${result.daily_remaining}`
    );
    if (result.reason === "BURST_LIMIT_REACHED") {
      return rateLimited(
        "BURST_LIMIT_REACHED",
        "Terlalu banyak permintaan dalam waktu singkat. Tunggu sebentar lalu coba lagi.",
        result.daily_remaining ?? 0,
        result.retry_after_seconds ?? 60
      );
    }
    return rateLimited(
      "DAILY_LIMIT_REACHED",
      "Batas penggunaan AI harian Anda telah tercapai. Coba lagi besok.",
      0,
      result.retry_after_seconds ?? 0
    );
  }

  console.log(
    `Rate limit OK: user=${userId} used=${result.daily_used} remaining=${result.daily_remaining}`
  );
  return null;
}
const SYSTEM_PROMPT = `Anda adalah Konsultan Keuangan AI Finora — asisten keuangan pribadi yang membantu pengguna berbahasa Indonesia.

PRINSIP KERJA:
1. Jawab selalu dalam bahasa Indonesia yang natural dan mudah dipahami.
2. Anda adalah pendidik keuangan, BUKAN penasihat keuangan berizin (regulated financial advisor). Selalu klarifikasi: "Ini adalah edukasi keuangan, bukan saran dari penasihat keuangan berizin."
3. JANGAN PERNAH menjamin imbal hasil investasi. Gunakan kata "diperkirakan" atau "berpotensi" untuk proyeksi.
4. JANGAN PERNAH menghitung angka finansial sendiri. Jika pengguna meminta perhitungan, arahkan mereka ke fitur Analisis Keuangan atau Transaksi di Finora. Jika data finansial disertakan dalam pesan atau melalui persetujuan profil, gunakan angka tersebut apa adanya — jangan dibuat-buat angka baru.
5. Jika informasi pengguna tidak lengkap untuk memberikan jawaban relevan, AJUKAN PERTANYAAN KLARIFIKASI terlebih dahulu sebelum memberikan rekomendasi. Jangan berasumsi tentang angka atau situasi yang tidak disebutkan.
6. Berikan rekomendasi langkah demi langkah yang realistis dan dapat ditindaklanjuti.
7. Jika pengguna memberikan data profil finansial (dengan persetujuan), gunakan data tersebut sebagai konteks untuk jawaban yang lebih personal.
8. Ketika membandingkan skenario keuangan (misalnya dua strategi pelunasan utang atau dua pilihan anggaran), gunakan HANYA angka yang telah diverifikasi — yakni angka yang diberikan pengguna atau data profil yang disertakan. Jangan mengarang angka perbandingan. Tampilkan perbandingan dalam struktur yang jelas (tabel atau daftar bersisian) dan jelaskan konsekuensi logis dari masing-masing skenario berdasarkan angka tersebut.
9. Jelaskan masalah keuangan dengan bahasa sederhana sebelum memberikan solusi. Pastikan pengguna memahami akar masalahnya terlebih dahulu.

DATA KEUANGAN PENGGUNA:
- Jika konteks data keuangan disertakan, itu adalah data NYATA yang dibaca langsung dari database Finora. Gunakan angka tersebut apa adanya — JANGAN menghitung ulang, JANGAN mengarang angka baru.
- Nilai "BELUM TERSEDIO (not_provided)" berarti data belum pernah diisi. Data yang belum tersedia BUKAN bernilai nol. JANGAN pernah menyimpulkan bahwa pendapatan, tabungan, utang, atau pengeluaran pengguna bernilai 0 hanya karena datanya tidak ada.
- JANGAN memberikan kesimpulan kesehatan keuangan (sehat/bermasalah) jika data belum mencukupi. Ajukan pertanyaan klarifikasi atau sarankan pengguna mengisi fitur Analisis Keuangan terlebih dahulu.
- Jika pengguna menyebutkan angka sendiri dalam pesan, gunakan angka tersebut untuk diskusi, tetapi tetap arahkan perhitungan resmi ke fitur Analisis Keuangan.

FORMAT JAWABAN:
- Gunakan paragraf singkat dan jelas.
- Untuk langkah-langkah, gunakan penomoran.
- Jika membandingkan skenario, tampilkan dengan struktur yang mudah dibaca (daftar bersisian atau tabel sederhana).
- Jika informasi tidak cukup, mulai dengan pertanyaan klarifikasi sebelum memberikan jawaban.
- Selalu akhiri dengan penegasan bahwa ini adalah edukasi, bukan saran terikat regulasi.`;

interface ChatRequest {
  message: string;
  conversationId?: string;
  /** Consent flag: when true, the backend attaches the user's verified
   *  financial context (read server-side from Supabase). */
  includeProfile?: boolean;
}

const MAX_MESSAGE_LENGTH = 5_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(error: string, status = 400): Response {
  return json({ error }, status);
}
function validateChatRequest(body: unknown): { body: ChatRequest; error: Response } | {
  body: ChatRequest;
  error: null;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { body: {} as ChatRequest, error: badRequest("Format permintaan tidak valid") };
  }
  const raw = body as Record<string, unknown>;

  if (typeof raw.message !== "string" || raw.message.trim().length === 0) {
    return { body: {} as ChatRequest, error: badRequest("Pesan tidak boleh kosong") };
  }
  if (raw.message.length > MAX_MESSAGE_LENGTH) {
    return {
      body: {} as ChatRequest,
      error: badRequest(`Pesan terlalu panjang. Maksimal ${MAX_MESSAGE_LENGTH} karakter.`),
    };
  }

  let conversationId: string | undefined;
  if (raw.conversationId !== undefined && raw.conversationId !== null) {
    if (typeof raw.conversationId !== "string" || !UUID_RE.test(raw.conversationId)) {
      return { body: {} as ChatRequest, error: badRequest("conversationId tidak valid") };
    }
    conversationId = raw.conversationId;
  }

  let includeProfile = false;
  if (raw.includeProfile !== undefined) {
    if (typeof raw.includeProfile !== "boolean") {
      return { body: {} as ChatRequest, error: badRequest("includeProfile harus berupa boolean") };
    }
    includeProfile = raw.includeProfile;
  }

  return {
    body: { message: raw.message, conversationId, includeProfile },
    error: null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }


  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Metode tidak didukung" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // ─── 1. Authenticate via JWT ────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Otorisasi diperlukan" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Create a supabase client with the user's JWT to verify identity
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Sesi tidak valid. Silakan masuk kembali." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Service role client for DB operations (bypasses RLS)
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // ─── 2. Atomic rate limit: reserve one message BEFORE anything else ──
    // Verifies daily quota (30/day, UTC) + burst limit (5/min) in one locked
    // database statement. Rejected requests never reach any AI provider.
    const rateLimitResponse = await consumeAiUsage(adminClient, user.id);
    if (rateLimitResponse) return rateLimitResponse;

    // ─── 3. Parse and validate request body ────────────────────
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return badRequest("Body permintaan harus berupa JSON yang valid");
    }

    const { body: chatRequest, error: validationError } = validateChatRequest(rawBody);
    if (validationError) return validationError;
    const { message, conversationId, includeProfile } = chatRequest;

    // ─── 4. Get or create conversation ─────────────────────────
    let convId = conversationId;
    if (!convId) {
      const title = message.trim().slice(0, 60) + (message.length > 60 ? "..." : "");
      const { data: newConv, error: convError } = await adminClient
        .from("ai_conversations")
        .insert({ user_id: user.id, title })
        .select("id")
        .single();

      if (convError || !newConv) {
        return new Response(
          JSON.stringify({ error: "Gagal membuat percakapan" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      convId = newConv.id;
    } else {
      // Verify ownership (RLS-independent: admin client reads the row, then
      // the user_id is compared against the verified caller explicitly)
      const { data: conv, error: convFetchError } = await adminClient
        .from("ai_conversations")
        .select("id, user_id")
        .eq("id", convId)
        .maybeSingle();

      if (convFetchError) {
        console.error("Conversation lookup failed:", convFetchError.message);
        return badRequest("Gagal memeriksa percakapan", 500);
      }

      if (!conv || conv.user_id !== user.id) {
        return badRequest("Percakapan tidak ditemukan", 404);
      }
    }

    // ─── 5. Save user message ──────────────────────────────────
    const { error: userMsgError } = await adminClient
      .from("ai_messages")
      .insert({
        conversation_id: convId,
        user_id: user.id,
        role: "user",
        content: message.trim(),
      });
    if (userMsgError) {
      console.error("Failed to save user message:", userMsgError.message);
      return badRequest("Gagal menyimpan pesan. Silakan coba lagi.", 500);
    }

    // ─── 6. Fetch conversation history (last 20 messages) ──────
    // Filtered by user_id so history can never span another user's rows
    const { data: history, error: historyError } = await adminClient
      .from("ai_messages")
      .select("role, content")
      .eq("conversation_id", convId)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20);

    if (historyError) {
      console.error("Failed to fetch history:", historyError.message);
      return badRequest("Gagal memuat riwayat percakapan. Silakan coba lagi.", 500);
    }
    // Oldest-first for the AI conversation flow
    const orderedHistory = (history ?? []).slice().reverse();

    // ─── 7. Build messages array for AI API ────────────────────
    const messages: { role: string; content: string }[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    // If user consented, read their verified financial data server-side and
    // run it through the Financial Engine. Frontend-supplied numbers are
    // never used as an analysis source.
    if (includeProfile) {
      const financialContext = await buildFinancialContext(adminClient, user.id);
      messages.push({ role: "system", content: formatFinancialContext(financialContext) });
    }

    // Append conversation history (oldest first)
    for (const msg of orderedHistory) {
      messages.push({ role: msg.role, content: msg.content });
    }

    // ─── 8. Call AI via the router: classify → route → fallback ─
    // Collect which provider secrets exist so the router only considers
    // providers that are actually configured. Keys themselves stay in env —
    // only their presence is recorded here.
    const providerSecrets: Record<string, string | undefined> = {
      openai: Deno.env.get("OPENAI_API_KEY"),
      gemini: Deno.env.get("GEMINI_API_KEY"),
      anthropic: Deno.env.get("ANTHROPIC_API_KEY"),
      groq: Deno.env.get("GROQ_API_KEY"),
      openrouter: Deno.env.get("OPENROUTER_API_KEY"),
      deepseek: Deno.env.get("DEEPSEEK_API_KEY"),
      mistral: Deno.env.get("MISTRAL_API_KEY"),
    };

    const aiResult: AiChatResponse & { fallbackTrail: string[] } =
      await chatWithRouting({
        message,
        secrets: providerSecrets,
        messages: messages as AiMessage[],
        maxOutputTokens: 1200,
        temperature: 0.7,
      });

    if (aiResult.fallbackTrail.length > 0) {
      console.warn(`AI router fallback trail: ${aiResult.fallbackTrail.join(" -> ")}`);
    }

    const reply = aiResult.text;
    console.log(
      `AI request OK: user=${user.id} provider=${aiResult.providerId} model=${aiResult.model} latencyMs=${aiResult.latencyMs} fallback=${aiResult.fallbackTrail.length}`
    );

    // ─── 9. Save assistant message ─────────────────────────────
    const { error: assistantMsgError } = await adminClient
      .from("ai_messages")
      .insert({
        conversation_id: convId,
        user_id: user.id,
        role: "assistant",
        content: reply,
      });
    if (assistantMsgError) {
      console.error("Failed to save assistant message:", assistantMsgError.message);
      // Reply is still returned so the user keeps it, but the failure is
      // signalled: the persisted history will be missing this turn.
      return new Response(
        JSON.stringify({ reply, conversationId: convId, persisted: false }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update conversation timestamp
    const { error: convUpdateError } = await adminClient
      .from("ai_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", convId);
    if (convUpdateError) {
      console.error("Failed to update conversation timestamp:", convUpdateError.message);
    }

    return new Response(
      JSON.stringify({ reply, conversationId: convId }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    // Provider failures get specific, honest user messages — no secrets,
    // no provider details beyond what the user needs to act on.
    if (err instanceof AiProviderError) {
      console.error(`AI provider error (${err.code}):`, err.message);

      if (err.code === "quota" || err.code === "authentication") {
        return new Response(
          JSON.stringify({
            error:
              "Layanan AI sedang tidak tersedia karena masalah konfigurasi atau kuota. Silakan hubungi administrator.",
            aiUnavailable: true,
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const errorMsg =
        err.code === "rate_limit"
          ? "Layanan AI sedang sibuk. Silakan coba lagi dalam beberapa saat."
          : "Terjadi kesalahan saat menghubungi layanan AI. Silakan coba lagi.";

      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.error("Edge function error:", err);
    return new Response(
      JSON.stringify({ error: "Terjadi kesalahan sistem. Silakan coba lagi." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
