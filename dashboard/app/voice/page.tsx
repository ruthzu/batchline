"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const MCP_SERVER_URL =
  process.env.NEXT_PUBLIC_MCP_SERVER_URL ?? "http://localhost:3001";

// ---------------------------------------------------------------------------
// Minimal typings for the Web Speech Recognition API. TypeScript's DOM lib
// does not ship types for webkitSpeechRecognition, so we describe only the
// surface this page uses.
// ---------------------------------------------------------------------------

type RecognitionEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type RecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type RecognitionConstructor = new () => RecognitionInstance;

// ---------------------------------------------------------------------------
// Types for the /api/voice-command response
// ---------------------------------------------------------------------------

type VoiceCommandResponse = {
  transcript: string;
  toolCalled: string | null;
  toolArgs: object | null;
  spokenResponse: string;
  raw?: object;
};

type Turn =
  | { id: number; speaker: "baker"; text: string }
  | { id: number; speaker: "alexa"; text: string; pending?: boolean; toolCalled?: string | null };

let nextTurnId = 1;

// ---------------------------------------------------------------------------
// Conversation session id
//
// The server keeps per-conversation context (the last trace, the pending
// draft) in memory keyed by sessionId, so one browser tab is one conversation.
// Generated once and kept in sessionStorage: a page refresh re-enters the SAME
// conversation, "New conversation" starts a fresh one.
// ---------------------------------------------------------------------------

const SESSION_STORAGE_KEY = "batchline.voice.sessionId";

function readOrCreateSessionId(): string {
  const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
  return fresh;
}

export default function VoicePage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [speechEnabled, setSpeechEnabled] = useState(true);
  const [micSupported, setMicSupported] = useState<boolean | null>(null);
  const recognitionRef = useRef<RecognitionInstance | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Feature-detect SpeechRecognition once on mount.
  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: RecognitionConstructor;
      webkitSpeechRecognition?: RecognitionConstructor;
    };
    setMicSupported(Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition));
  }, []);

  // Keep the chat scrolled to the latest turn.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const speak = useCallback(
    (text: string) => {
      if (!speechEnabled || typeof window === "undefined" || !window.speechSynthesis) {
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      window.speechSynthesis.speak(utterance);
    },
    [speechEnabled]
  );

  const submitTranscript = useCallback(
    async (text: string) => {
      const transcript = text.trim();
      if (!transcript) return;

      const bakerTurn: Turn = { id: nextTurnId++, speaker: "baker", text: transcript };
      const pendingTurn: Turn = {
        id: nextTurnId++,
        speaker: "alexa",
        text: "…",
        pending: true,
      };
      setTurns((prev) => [...prev, bakerTurn, pendingTurn]);

      try {
        const response = await fetch(`${MCP_SERVER_URL}/api/voice-command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript, sessionId: readOrCreateSessionId() }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { message?: string };
          throw new Error(body.message ?? `Request failed with status ${response.status}`);
        }

        const data = (await response.json()) as VoiceCommandResponse;
        setTurns((prev) =>
          prev.map((turn) =>
            turn.id === pendingTurn.id
              ? { ...turn, text: data.spokenResponse, pending: false, toolCalled: data.toolCalled }
              : turn
          )
        );
        speak(data.spokenResponse);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to reach the Batchline server";
        setTurns((prev) =>
          prev.map((turn) =>
            turn.id === pendingTurn.id
              ? { ...turn, text: `I couldn't reach the ledger: ${message}`, pending: false }
              : turn
          )
        );
      }
    },
    [MCP_SERVER_URL, speak]
  );

  const startListening = useCallback(() => {
    const w = window as unknown as {
      SpeechRecognition?: RecognitionConstructor;
      webkitSpeechRecognition?: RecognitionConstructor;
    };
    const RecognitionCtor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!RecognitionCtor) return;

    // Restart cleanly if a previous session is still around.
    recognitionRef.current?.stop();
    window.speechSynthesis?.cancel();

    const recognition = new RecognitionCtor();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      if (transcript) {
        void submitTranscript(transcript);
      }
    };
    recognition.onerror = (event) => {
      setListening(false);
      if (event.error && event.error !== "aborted" && event.error !== "no-speech") {
        setTurns((prev) => [
          ...prev,
          { id: nextTurnId++, speaker: "alexa", text: `Microphone error: ${event.error}. You can type your command below instead.` },
        ]);
      }
    };
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, [submitTranscript]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  // Fresh sessionId + empty transcript: the server-side state for the old
  // conversation is left to expire, the browser starts a clean one.
  const startNewConversation = useCallback(() => {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, crypto.randomUUID());
    window.speechSynthesis?.cancel();
    setTurns([]);
  }, []);

  const handleTextSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const text = input;
      setInput("");
      void submitTranscript(text);
    },
    [input, submitTranscript]
  );

  return (
    <div className="flex min-h-screen flex-col bg-[var(--cream)]">
      <header className="border-b border-[var(--line)] bg-[var(--paper)] px-6 py-5">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <h1 className="display-font text-2xl font-semibold text-[var(--ink)]">
            Simulated Alexa+ Interface
          </h1>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={startNewConversation}
              className="rounded-xl border border-[var(--line)] bg-[var(--paper)] px-4 py-2 text-sm font-semibold text-[var(--ink)] shadow-sm transition-colors hover:border-[var(--terracotta)] hover:text-[var(--terracotta)]"
            >
              New conversation
            </button>
            <a href="/" className="text-sm font-semibold text-[var(--muted)] hover:text-[var(--terracotta)]">
              Back to Home
            </a>
          </div>
        </div>
      </header>

      {/* Honest labeling: this stands in for real Alexa+ per the documented
          fallback plan, and that must be visible, not hidden. */}
      <div className="border-b border-[var(--amber)] bg-[var(--amber-soft)] px-6 py-3">
        <p className="mx-auto max-w-3xl text-xs leading-relaxed text-[#805825]">
          <span className="font-semibold">SIMULATION —</span> This page is a
          browser-based stand-in for Alexa+ (the project&apos;s documented
          fallback plan). Speech is captured in the browser, routed through the
          Batchline voice-command API, and spoken back with browser speech
          synthesis. No real Alexa+ device is involved.
        </p>
      </div>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-6">
        {/* Chat transcript */}
        <div className="flex-1 space-y-4 overflow-y-auto rounded-3xl border border-[var(--line)] bg-[var(--paper)] p-6 shadow-[var(--shadow)]">
          {turns.length === 0 && (
            <div className="py-10 text-center">
              <p className="text-sm text-[var(--muted)]">
                Tap the microphone or type a command below.
              </p>
              <p className="mt-1 text-xs text-[var(--muted)] opacity-80">
                Try: &ldquo;Trace flour lot F17&rdquo; or &ldquo;Batch 24 used
                flour lot F17, size 50, product sourdough, produced today&rdquo;
              </p>
            </div>
          )}

          {turns.map((turn) =>
            turn.speaker === "baker" ? (
              <div key={turn.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-[var(--terracotta)] px-4 py-2.5 text-sm text-white shadow-sm">
                  <p className="mb-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--terracotta-soft)]">
                    Baker
                  </p>
                  {turn.text}
                </div>
              </div>
            ) : (
              <div key={turn.id} className="flex justify-start">
                <div
                  className={`max-w-[80%] rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm shadow-sm ${
                    turn.pending
                      ? "bg-[var(--paper-deep)] text-[var(--muted)]"
                      : "bg-[var(--ink)] text-[var(--cream)]"
                  }`}
                >
                  <p className="mb-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--amber)]">
                    Alexa+
                    {turn.toolCalled ? ` · ${turn.toolCalled}` : ""}
                  </p>
                  {turn.text}
                </div>
              </div>
            )
          )}
          <div ref={bottomRef} />
        </div>

        {/* Mic + speech controls */}
        <div className="mt-6 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={listening ? stopListening : startListening}
            disabled={micSupported !== true}
            title={
              micSupported
                ? listening
                  ? "Stop listening"
                  : "Start listening"
                : "Voice input isn't supported in this browser"
            }
            className={`flex h-20 w-20 items-center justify-center rounded-full text-white shadow-lg transition-colors focus:outline-none focus:ring-4 disabled:cursor-not-allowed disabled:bg-[var(--line)] ${
              listening
                ? "bg-[var(--rose)] hover:bg-[#8e413c] focus:ring-[var(--rose-soft)]"
                : "bg-[var(--terracotta)] hover:bg-[var(--terracotta-dark)] focus:ring-[var(--terracotta-soft)]"
            }`}
          >
            {listening ? (
              // Stop square
              <span className="block h-6 w-6 rounded-sm bg-white" aria-label="Stop" />
            ) : (
              // Microphone glyph
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-8 w-8"
                aria-label="Microphone"
              >
                <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
                <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.08A7 7 0 0 0 19 11Z" />
              </svg>
            )}
          </button>

          <p className="text-xs text-[var(--muted)]">
            {micSupported === null
              ? "Checking microphone support…"
              : micSupported
                ? listening
                  ? "Listening… speak your command."
                  : "Tap to speak"
                : "Voice input isn't supported in this browser, try Chrome. You can still type commands below."}
          </p>

          <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <input
              type="checkbox"
              checked={speechEnabled}
              onChange={(e) => {
                setSpeechEnabled(e.target.checked);
                if (!e.target.checked) window.speechSynthesis?.cancel();
              }}
              className="h-3.5 w-3.5 rounded border-[var(--line)] accent-[var(--terracotta)]"
            />
            Speak replies out loud
          </label>
        </div>

        {/* Text fallback input */}
        <form onSubmit={handleTextSubmit} className="mt-4 flex gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a command instead (e.g. Trace flour lot F17)…"
            className="flex-1 rounded-xl border border-[var(--line)] bg-[var(--paper)] px-4 py-3 text-sm text-[var(--ink)] placeholder-[var(--muted)] focus:border-[var(--amber)] focus:outline-none focus:ring-2 focus:ring-[var(--amber-soft)]"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="rounded-xl bg-[var(--terracotta)] px-6 py-3 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[var(--terracotta-dark)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </main>
    </div>
  );
}
