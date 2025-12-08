import React, { useEffect, useRef, useState } from "react";
import { connectAndRecord, primePlayer } from "./lib/ws";

type ChatItem = {
  role: "user" | "assistant";
  content: string;
  timestamp?: Date;
};
// Define precise UI states for accurate labeling
type UIStatus =
  | "idle"
  | "connecting"
  | "initializing"
  | "ready"
  | "speaking"
  | "thinking"
  | "error"
  | "stopping";

function useTheme() {
  const init = (): "light" | "dark" => {
    const saved = localStorage.getItem("theme") as "light" | "dark" | null;
    if (saved) return saved;
    return matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  };
  const [theme, setTheme] = useState<"light" | "dark">(init);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);
  return {
    theme,
    toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
  };
}

const Sun = () => (
  <svg
    className="icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);
const Moon = () => (
  <svg className="icon" viewBox="0 0 24 24" fill="currentColor">
    <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 1 0 9.79 9.79Z" />
  </svg>
);

export default function App() {
  const { theme, toggle } = useTheme();

  const [status, setStatus] = useState<UIStatus>("idle");
  const [active, setActive] = useState(false); // True if session is ongoing
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [persona, setPersona] = useState<"A" | "B">("A");
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [selectedCriterion, setSelectedCriterion] = useState<{
    category: string;
    criterion: string;
  } | null>(null);

  const [isThinking, setIsThinking] = useState(false); // Tracks if LLM is active

  const assistantDraftRef = useRef(assistantDraft);
  useEffect(() => {
    assistantDraftRef.current = assistantDraft;
  }, [assistantDraft]);

  // Playback mechanism (supports fallback WAV stitching if AudioWorklet fails)
  const audioRef = useRef<HTMLAudioElement>(null);
  const queueRef = useRef<Blob[]>([]);
  const playingRef = useRef(false); // Tracks fallback playback state
  const workletPlayingRef = useRef(false); // Tracks worklet playback state

  // Phone ringing audio
  const ringAudioRef = useRef<{
    context: AudioContext;
    oscillator1: OscillatorNode;
    oscillator2: OscillatorNode;
    gainNode: GainNode;
    interval: number | null;
  } | null>(null);

  const wsRef = useRef<Awaited<ReturnType<typeof connectAndRecord>> | null>(
    null
  );

  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chat, assistantDraft]);

  const stopFallbackPlayback = () => {
    playingRef.current = false;
    queueRef.current = [];
    if (audioRef.current) {
      audioRef.current.pause();
      if (audioRef.current.src) URL.revokeObjectURL(audioRef.current.src);
      audioRef.current.src = "";
    }
  };

  const playNext = async () => {
    if (!audioRef.current) return;
    if (playingRef.current) return;
    const next = queueRef.current.shift();
    if (!next) {
      return;
    }
    playingRef.current = true;
    audioRef.current.src = URL.createObjectURL(next);
    try {
      await audioRef.current.play();
    } catch {}
  };

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onEnded = () => {
      playingRef.current = false;
      void playNext();
    };
    a.addEventListener("ended", onEnded);
    return () => a.removeEventListener("ended", onEnded);
  }, []);

  useEffect(() => {
    const isPlaying = workletPlayingRef.current || playingRef.current;

    if (
      ["idle", "connecting", "initializing", "stopping", "error"].includes(
        status
      )
    ) {
      return;
    }

    if (active) {
      if (isPlaying) {
        setStatus("speaking");
      } else if (isThinking) {
        setStatus("thinking");
      } else {
        setStatus("ready");
      }
    } else if (status !== "idle" && status !== "error") {
      setStatus("idle");
    }
  }, [
    isThinking,
    JSON.stringify(workletPlayingRef.current),
    JSON.stringify(playingRef.current),
    active,
    status,
  ]);

  async function start() {
    try {
      await primePlayer();
    } catch (e) {
      console.error("Failed to prime audio player:", e);
      setStatus("error");
      return;
    }

    // Collapse panel when starting call
    setPanelCollapsed(true);

    // Reset UI and connect streams
    setChat([]);
    setAssistantDraft("");
    setIsThinking(false);
    setStatus("connecting");

    const onAsr = (t: string) => {
      setIsThinking(true);

      stopFallbackPlayback();

      setChat((prev) => {
        const newChat = [...prev];
        if (assistantDraftRef.current) {
          newChat.push({
            role: "assistant",
            content: assistantDraftRef.current,
            timestamp: new Date(),
          });
        }
        newChat.push({ role: "user", content: t, timestamp: new Date() });
        return newChat;
      });
      setAssistantDraft("");
    };

    const onStatus = (s: string) => {
      if (s === "connected") setStatus("connecting");
      else if (s === "initializing") setStatus("initializing");
      else if (s === "ready") setStatus("ready");
      else if (s === "error") setStatus("error");
    };

    const onToken = (tok: string) => {
      setIsThinking(true);
      setAssistantDraft((prev) => prev + tok);
    };

    const onSegment = (blob: Blob) => {
      if (blob && blob.size > 0) {
        console.warn("Using fallback audio element playback.");
        queueRef.current.push(blob);
        void playNext();
      }
    };

    const onTurnDone = () => {
      setIsThinking(false);
    };

    const onPlaybackState = (isPlaying: boolean) => {
      workletPlayingRef.current = isPlaying;
      setIsThinking((prev) => prev);
    };

    const onDone = () => {
      setChat((prev) => {
        if (assistantDraftRef.current) {
          return [
            ...prev,
            {
              role: "assistant",
              content: assistantDraftRef.current,
              timestamp: new Date(),
            },
          ];
        }
        return prev;
      });
      setAssistantDraft("");

      stopFallbackPlayback();
      setIsThinking(false);

      const currentStatus =
        document.documentElement.getAttribute("data-status") || status;

      if (currentStatus !== "error") {
        setStatus("idle");
      }
      wsRef.current = null;
      setActive(false);
      setPanelCollapsed(false); // Expand panel when call ends
      setShowFeedback(true); // Show feedback by default when call ends
    };

    assistantDraftRef.current = "";
    try {
      wsRef.current = await connectAndRecord(
        {
          onAsr,
          onStatus,
          onToken,
          onSegment,
          onDone,
          onPlaybackState,
          onTurnDone,
        },
        persona
      );
      setActive(true);
    } catch (e) {
      console.error("Failed to connect or record:", e);
      setStatus("error");
      setActive(false);
      setPanelCollapsed(false); // Expand panel on error
    }
  }

  async function stop() {
    if (!wsRef.current) return;
    setStatus("stopping");
    await wsRef.current.stop();
  }

  async function toggleMic() {
    if (["connecting", "initializing", "stopping", "error"].includes(status)) {
      return;
    }
    if (active) await stop();
    else await start();
  }

  // Updated labels to match the actual activity
  const badgeText = (() => {
    switch (status) {
      case "idle":
        return "Idle";
      case "connecting":
        return "Connecting…"; // WS connection
      case "initializing":
        return "Initializing…"; // Waiting for Fennec/VAD
      case "ready":
        return "Listening…"; // Actively listening (VAD on)
      case "thinking":
        return "Thinking…"; // Waiting for LLM
      case "speaking":
        return "Speaking…"; // AI is talking
      case "stopping":
        return "Stopping…";
      case "error":
        return "Error";
      default:
        return "Waiting…";
    }
  })();

  useEffect(() => {
    document.documentElement.setAttribute("data-status", status);
  }, [status]);

  // Mock scorecard data (to be replaced with real analysis later)
  const mockScorecard = {
    overallScore: { correct: 2, total: 9 },
    categories: [
      {
        name: "Opener",
        score: { correct: 1, total: 2 },
        criteria: [
          { name: "Permission based opener?", passed: true },
          { name: "Used research on prospect?", passed: false },
        ],
      },
      {
        name: "Social Proof",
        score: { correct: 1, total: 2 },
        criteria: [
          { name: "Provided social proof?", passed: true },
          { name: "Asked if social proof was relevant?", passed: false },
        ],
      },
      {
        name: "Discovery",
        score: { correct: 0, total: 1 },
        criteria: [
          { name: "SDR asked for preconceptions of product?", passed: false },
        ],
      },
      {
        name: "Closing",
        score: { correct: 0, total: 2 },
        criteria: [
          { name: "Next steps agreed upon?", passed: false },
          { name: "Follow-up meeting booked?", passed: false },
        ],
      },
      {
        name: "Takeaway",
        score: { correct: 0, total: 2 },
        criteria: [
          {
            name: "Re-confirmed that the time works for the prospect?",
            passed: false,
          },
          { name: "Asked for success criteria for next call?", passed: false },
        ],
      },
    ],
  };

  const getCriterionDetails = (categoryName: string, criterionName: string) => {
    // Mock detailed feedback (to be replaced with real analysis)
    return {
      why: `After reviewing the transcript, the sales rep did not meet this criterion. This is a key aspect of effective sales communication.`,
      suggestion: `Next time, focus on this aspect earlier in the conversation. Be more direct and clear about your intentions.`,
      transcriptSnippets: chat.slice(0, 2).map((m, i) => ({
        index: i + 1,
        timestamp:
          m.timestamp?.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }) || "0:00",
        role: m.role,
        content:
          m.content.substring(0, 100) + (m.content.length > 100 ? "..." : ""),
      })),
    };
  };

  // Phone ringing effect
  useEffect(() => {
    const shouldRing =
      (status === "connecting" || status === "initializing") && active;

    if (shouldRing) {
      // Create phone ring audio programmatically
      const audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)();

      const createRingTone = () => {
        const oscillator1 = audioContext.createOscillator();
        const oscillator2 = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator1.type = "sine";
        oscillator1.frequency.value = 440;
        oscillator2.type = "sine";
        oscillator2.frequency.value = 480;

        gainNode.gain.value = 0;
        gainNode.gain.setValueAtTime(0.08, audioContext.currentTime);

        oscillator1.connect(gainNode);
        oscillator2.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator1.start();
        oscillator2.start();

        return { oscillator1, oscillator2, gainNode };
      };

      const tone = createRingTone();

      // Create ring pattern (ring for 400ms, pause for 200ms, ring for 400ms, pause for 2000ms)
      let ringTime = 0;
      const ringInterval = setInterval(() => {
        const cycleTime = ringTime % 3000;
        if (cycleTime < 400) {
          tone.gainNode.gain.setValueAtTime(0.08, audioContext.currentTime);
        } else if (cycleTime < 600) {
          tone.gainNode.gain.setValueAtTime(0, audioContext.currentTime);
        } else if (cycleTime < 1000) {
          tone.gainNode.gain.setValueAtTime(0.08, audioContext.currentTime);
        } else {
          tone.gainNode.gain.setValueAtTime(0, audioContext.currentTime);
        }
        ringTime += 100;
      }, 100);

      ringAudioRef.current = {
        context: audioContext,
        oscillator1: tone.oscillator1,
        oscillator2: tone.oscillator2,
        gainNode: tone.gainNode,
        interval: ringInterval,
      };

      return () => {
        if (ringAudioRef.current) {
          clearInterval(ringAudioRef.current.interval!);
          try {
            ringAudioRef.current.oscillator1.stop();
            ringAudioRef.current.oscillator2.stop();
            ringAudioRef.current.context.close();
          } catch (e) {
            // Already stopped
          }
          ringAudioRef.current = null;
        }
      };
    } else {
      // Stop ringing
      if (ringAudioRef.current) {
        clearInterval(ringAudioRef.current.interval!);
        try {
          ringAudioRef.current.oscillator1.stop();
          ringAudioRef.current.oscillator2.stop();
          ringAudioRef.current.context.close();
        } catch (e) {
          // Already stopped
        }
        ringAudioRef.current = null;
      }
    }
  }, [status, active]);

  // Waveform component
  const Waveform = () => {
    const bars = Array.from({ length: 12 }, (_, i) => i);
    return (
      <div className="waveform-container">
        {bars.map((_, i) => (
          <div
            key={i}
            className="waveform-bar"
            style={{
              animationDelay: `${i * 0.1}s`,
            }}
          />
        ))}
      </div>
    );
  };

  // Scorecard component
  const Scorecard = () => {
    if (selectedCriterion) {
      const details = getCriterionDetails(
        selectedCriterion.category,
        selectedCriterion.criterion
      );
      return (
        <div className="analysis-view">
          <button
            className="back-button"
            onClick={() => setSelectedCriterion(null)}
          >
            ← View full scorecard
          </button>
          <div className="criterion-detail">
            <div className="criterion-header">
              <span
                className={`criterion-status ${
                  mockScorecard.categories
                    .find((c) => c.name === selectedCriterion.category)
                    ?.criteria.find(
                      (c) => c.name === selectedCriterion.criterion
                    )?.passed
                    ? "passed"
                    : "failed"
                }`}
              >
                {mockScorecard.categories
                  .find((c) => c.name === selectedCriterion.category)
                  ?.criteria.find((c) => c.name === selectedCriterion.criterion)
                  ?.passed
                  ? "✓"
                  : "✗"}
              </span>
              <h3 className="criterion-title">{selectedCriterion.criterion}</h3>
            </div>
            <div className="criterion-section">
              <h4 className="section-title">Why were you scored this way?</h4>
              <p className="section-content">{details.why}</p>
              {details.transcriptSnippets.length > 0 && (
                <div className="transcript-snippets">
                  {details.transcriptSnippets.map((snippet, i) => (
                    <div key={i} className="snippet">
                      <span className="snippet-index">{snippet.index}</span>
                      <span className="snippet-timestamp">
                        ({snippet.timestamp})
                      </span>
                      <span className="snippet-role">{snippet.role}:</span>
                      <span className="snippet-content">
                        "{snippet.content}"
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="criterion-section">
              <h4 className="section-title">
                What could you do differently next time?
              </h4>
              <p className="section-content">{details.suggestion}</p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="analysis-view">
        <div className="scorecard-header">
          <div className="overall-score">
            <span className="score-number">
              {mockScorecard.overallScore.correct}/
              {mockScorecard.overallScore.total}
            </span>
            <span className="score-label">criteria correct</span>
          </div>
          <div className="scorecard-feedback">
            <p>Just the beginning, you'll get there!</p>
            <p className="caption">
              You got {mockScorecard.overallScore.correct}/
              {mockScorecard.overallScore.total} criteria correct. For this
              call, the scorecard is the best resource to understand what went
              right and what went wrong. Dive into each criteria to check out
              detailed feedback.
            </p>
          </div>
        </div>
        <div className="scorecard-categories">
          <h3 className="scorecard-title">Scorecard</h3>
          {mockScorecard.categories.map((category, catIdx) => (
            <div key={catIdx} className="scorecard-category">
              <div className="category-header">
                <h4 className="category-name">{category.name}</h4>
                <span className="category-score">
                  ({category.score.correct}/{category.score.total})
                </span>
              </div>
              <div className="category-criteria">
                {category.criteria.map((criterion, critIdx) => (
                  <button
                    key={critIdx}
                    className={`criterion-item ${
                      criterion.passed ? "passed" : "failed"
                    }`}
                    onClick={() =>
                      setSelectedCriterion({
                        category: category.name,
                        criterion: criterion.name,
                      })
                    }
                  >
                    <span className="criterion-status-icon">
                      {criterion.passed ? "✓" : "✗"}
                    </span>
                    <span className="criterion-name">{criterion.name}</span>
                    <span className="criterion-arrow">→</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="container">
      <div className={`persona-panel ${panelCollapsed ? "collapsed" : ""}`}>
        <div className="persona-panel-content">
          <h3 className="persona-title">Select Persona</h3>
          <div className="persona-options">
            <button
              className={`persona-option ${persona === "A" ? "selected" : ""}`}
              onClick={() => setPersona("A")}
              disabled={active}
            >
              <img
                src="/persona_joe.png"
                alt="Joe - Director of Operations at Bain & Co."
                className="persona-image"
              />
              <div className="persona-name">Persona A: The Rusher</div>
              <div className="persona-desc">
                Joe, Director of Operations at Bain & Co.
              </div>
              <div className="persona-desc-small">
                Time-constrained, rude. Selling: Data Solution
              </div>
            </button>
            <button
              className={`persona-option ${persona === "B" ? "selected" : ""}`}
              onClick={() => setPersona("B")}
              disabled={active}
            >
              <img
                src="/persona_sam.png"
                alt="Sam - CEO of BlackRock"
                className="persona-image"
              />
              <div className="persona-name">Persona B: The Executive</div>
              <div className="persona-desc">Sam, CEO of BlackRock</div>
              <div className="persona-desc-small">
                ROI-focused, hates buzzwords. Selling: AI Solution
              </div>
            </button>
          </div>
          <button
            className="call-button"
            onClick={start}
            disabled={
              active ||
              ["connecting", "initializing", "stopping"].includes(status)
            }
          >
            Start Call
          </button>
        </div>
      </div>

      <div
        className={`main-content ${panelCollapsed ? "panel-collapsed" : ""}`}
      >
        <header className="header">
          <div className="brand">
            <div>
              <div className="title">SalesAgent</div>
              <div className="caption">
                <span className="connection-status">
                  <span
                    className={`status-indicator status-${
                      active ? "ready" : "idle"
                    }`}
                  ></span>
                  {active ? "CONNECTED" : "STANDBY"}
                </span>
                {" • "}
                Fennec ASR → Baseten Qwen → Inworld TTS
              </div>
            </div>
          </div>
          <button
            className="icon-btn"
            onClick={toggle}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </button>
        </header>

        <section className="hero">
          <div className="card main-card">
            <div className="controls">
              <button
                className={["mic", active ? "active" : ""].join(" ")}
                onClick={toggleMic}
                aria-pressed={active}
                title={active ? "Click to stop" : "Click to start"}
                disabled={[
                  "connecting",
                  "initializing",
                  "stopping",
                  "error",
                ].includes(status)}
              >
                🎤
              </button>
              <div className="badge">
                <span className={`status-indicator status-${status}`}></span>
                {badgeText}
              </div>
            </div>
            {!active && chat.length > 0 && (
              <div className="view-toggle">
                <button
                  className={`toggle-btn ${!showFeedback ? "active" : ""}`}
                  onClick={() => setShowFeedback(false)}
                >
                  Transcript
                </button>
                <button
                  className={`toggle-btn ${showFeedback ? "active" : ""}`}
                  onClick={() => setShowFeedback(true)}
                >
                  Feedback
                </button>
              </div>
            )}
            <div className="content-area" ref={transcriptRef}>
              {active &&
              (status === "connecting" ||
                status === "initializing" ||
                status === "ready" ||
                status === "thinking" ||
                status === "speaking") ? (
                <Waveform />
              ) : !active && chat.length > 0 && showFeedback ? (
                <Scorecard />
              ) : (
                <>
                  {chat.length === 0 && !assistantDraft ? (
                    <span className="caption">
                      Transcript will appear here…
                    </span>
                  ) : (
                    <div className="chat-messages">
                      {chat.map((m, i) => {
                        const isUser = m.role === "user";
                        const personaImage =
                          persona === "A"
                            ? "/persona_joe.png"
                            : "/persona_sam.png";
                        return (
                          <div
                            key={i}
                            className={`message-bubble ${
                              isUser ? "message-user" : "message-assistant"
                            }`}
                          >
                            <div className="message-header">
                              {!isUser && (
                                <img
                                  src={personaImage}
                                  alt={persona === "A" ? "Joe" : "Sam"}
                                  className="message-avatar"
                                />
                              )}
                              <div className="message-meta">
                                <span className="message-role">
                                  {isUser
                                    ? "You"
                                    : persona === "A"
                                    ? "Joe"
                                    : "Sam"}
                                  {!isUser && (
                                    <span className="ai-badge">AI</span>
                                  )}
                                </span>
                                {m.timestamp && (
                                  <span className="timestamp">
                                    {m.timestamp.toLocaleTimeString("en-US", {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                      second: "2-digit",
                                    })}
                                  </span>
                                )}
                              </div>
                              {isUser && (
                                <div className="message-avatar user-avatar">
                                  <span>U</span>
                                </div>
                              )}
                            </div>
                            <div className="message-content">{m.content}</div>
                          </div>
                        );
                      })}
                      {assistantDraft && (
                        <div className="message-bubble message-assistant message-draft">
                          <div className="message-header">
                            <img
                              src={
                                persona === "A"
                                  ? "/persona_joe.png"
                                  : "/persona_sam.png"
                              }
                              alt={persona === "A" ? "Joe" : "Sam"}
                              className="message-avatar"
                            />
                            <div className="message-meta">
                              <span className="message-role">
                                {persona === "A" ? "Joe" : "Sam"}
                                <span className="ai-badge">AI</span>
                              </span>
                            </div>
                          </div>
                          <div className="message-content">
                            {assistantDraft}
                            <span className="typing-cursor"></span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <audio ref={audioRef} />
        </section>
      </div>
    </div>
  );
}
