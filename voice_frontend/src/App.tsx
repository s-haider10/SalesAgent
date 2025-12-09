import React, { useEffect, useRef, useState } from "react";
import { connectAndRecord, primePlayer } from "./lib/ws";

type ChatItem = {
  role: "user" | "assistant";
  content: string;
  timestamp?: Date;
};

type UIStatus =
  | "idle"
  | "connecting"
  | "initializing"
  | "ready"
  | "speaking"
  | "thinking"
  | "error"
  | "stopping";

type Criterion = {
  name: string;
  passed: boolean;
};

type Category = {
  name: string;
  score: { correct: number; total: number };
  criteria: Criterion[];
};

type ScorecardData = {
  overallScore: { correct: number; total: number };
  categories: Category[];
  summary: string;
  strengths: string[];
  improvements: string[];
} | null;

export default function App() {
  const [status, setStatus] = useState<UIStatus>("idle");
  const [active, setActive] = useState(false);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [persona, setPersona] = useState<"A" | "B">("A");
  const [showFeedback, setShowFeedback] = useState(false);
  const [selectedCriterion, setSelectedCriterion] = useState<{
    category: string;
    criterion: string;
  } | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [scorecard, setScorecard] = useState<ScorecardData>(null);
  const [feedbackLoading, setFeedbackLoading] = useState(false);

  const assistantDraftRef = useRef(assistantDraft);
  useEffect(() => {
    assistantDraftRef.current = assistantDraft;
  }, [assistantDraft]);

  const audioRef = useRef<HTMLAudioElement>(null);
  const queueRef = useRef<Blob[]>([]);
  const playingRef = useRef(false);
  const workletPlayingRef = useRef(false);

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

  // Connection and end call sounds
  const playConnectionSound = () => {
    try {
      const audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(
        1200,
        audioContext.currentTime + 0.2
      );

      gainNode.gain.setValueAtTime(0, audioContext.currentTime);
      gainNode.gain.linearRampToValueAtTime(
        0.1,
        audioContext.currentTime + 0.05
      );
      gainNode.gain.exponentialRampToValueAtTime(
        0.01,
        audioContext.currentTime + 0.2
      );

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.2);

      oscillator.onended = () => {
        audioContext.close();
      };
    } catch (e) {
      console.warn("Failed to play connection sound:", e);
    }
  };

  const playEndCallSound = () => {
    try {
      const audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(600, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(
        400,
        audioContext.currentTime + 0.15
      );

      gainNode.gain.setValueAtTime(0, audioContext.currentTime);
      gainNode.gain.linearRampToValueAtTime(
        0.15,
        audioContext.currentTime + 0.05
      );
      gainNode.gain.exponentialRampToValueAtTime(
        0.01,
        audioContext.currentTime + 0.15
      );

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.15);

      oscillator.onended = () => {
        audioContext.close();
      };
    } catch (e) {
      console.warn("Failed to play end call sound:", e);
    }
  };

  const stopFallbackPlayback = () => {
    playingRef.current = false;
    queueRef.current = [];
    if (audioRef.current) {
      audioRef.current.pause();
      if (audioRef.current.src) URL.revokeObjectURL(audioRef.current.src);
      audioRef.current.src = "";
    }
  };

  const fetchFeedback = async (transcript: ChatItem[], selectedPersona: string) => {
    console.log("[fetchFeedback] Starting feedback request for", transcript.length, "messages");
    setFeedbackLoading(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: transcript.map((m) => ({ role: m.role, content: m.content })),
          persona: selectedPersona,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        console.log("[fetchFeedback] Received feedback:", data);
        setScorecard(data);
      } else {
        console.error("[fetchFeedback] Error response:", res.status, res.statusText);
      }
    } catch (e) {
      console.error("[fetchFeedback] Failed to fetch feedback:", e);
    } finally {
      setFeedbackLoading(false);
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

    setChat([]);
    setAssistantDraft("");
    setIsThinking(false);
    setStatus("connecting");
    setScorecard(null);
    setFeedbackLoading(false);

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
      else if (s === "ready") {
        setStatus("ready");
        // Connection sound removed - only ringing and end call beep
      } else if (s === "error") setStatus("error");
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
        const finalChat = assistantDraftRef.current
          ? [
              ...prev,
              {
                role: "assistant" as const,
                content: assistantDraftRef.current,
                timestamp: new Date(),
              },
            ]
          : prev;
        
        // Trigger feedback fetch after state update with the final chat
        if (finalChat.length > 0) {
          console.log("[onDone] Triggering feedback for", finalChat.length, "messages");
          setTimeout(() => {
            fetchFeedback(finalChat, persona);
          }, 50);
        }
        
        return finalChat;
      });
      setAssistantDraft("");

      stopFallbackPlayback();
      setIsThinking(false);

      playEndCallSound();

      const currentStatus =
        document.documentElement.getAttribute("data-status") || status;

      if (currentStatus !== "error") {
        setStatus("idle");
      }
      wsRef.current = null;
      setActive(false);
      setShowFeedback(true);
    };

    const onHangup = () => {
      setChat((prev) => {
        const newChat = [...prev];
        if (assistantDraftRef.current) {
          newChat.push({
            role: "assistant",
            content: assistantDraftRef.current,
            timestamp: new Date(),
          });
        }
        newChat.push({
          role: "assistant",
          content: `[${persona === "A" ? "Joe" : "Sam"} ended the call]`,
          timestamp: new Date(),
        });
        return newChat;
      });
      setAssistantDraft("");
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
          onHangup,
        },
        persona
      );
      setActive(true);
    } catch (e) {
      console.error("Failed to connect or record:", e);
      setStatus("error");
      setActive(false);
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

  const badgeText = (() => {
    switch (status) {
      case "idle":
        return "Idle";
      case "connecting":
        return "Connecting…";
      case "initializing":
        return "Initializing…";
      case "ready":
        return "Listening…";
      case "thinking":
        return "Thinking…";
      case "speaking":
        return "Speaking…";
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

  // Fallback: Fetch feedback when call ends (backup for onDone trigger)
  useEffect(() => {
    if (!active && chat.length > 0 && !scorecard && !feedbackLoading) {
      fetchFeedback(chat, persona);
    }
  }, [active, chat, scorecard, feedbackLoading, persona]);

  // Phone ringing effect
  useEffect(() => {
    const shouldRing =
      (status === "connecting" || status === "initializing") && active;

    if (shouldRing) {
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
          <div key={i} className="waveform-bar" />
        ))}
      </div>
    );
  };

  // Scorecard component
  const Scorecard = () => {
    if (feedbackLoading) {
      return (
        <div className="scorecard-view">
          <div className="scorecard-loading">
            <div className="loading-spinner" />
            <p>Analyzing your call...</p>
          </div>
        </div>
      );
    }

    if (!scorecard) {
      return (
        <div className="scorecard-view">
          <div className="scorecard-loading">
            <p>No feedback available</p>
          </div>
        </div>
      );
    }

    return (
      <div className="scorecard-view">
        <div className="scorecard-header">
          <div className="overall-score">
            {scorecard.overallScore.correct}/{scorecard.overallScore.total}
          </div>
          <div className="score-label">criteria met</div>
          <div className="scorecard-feedback">
            <p className="score-highlight">{scorecard.summary}</p>
            <div className="score-chips">
              {scorecard.strengths.map((s, i) => (
                <span key={`s-${i}`} className="chip positive">{s}</span>
              ))}
              {scorecard.improvements.map((s, i) => (
                <span key={`i-${i}`} className="chip negative">{s}</span>
              ))}
            </div>
          </div>
        </div>
        <div className="scorecard-categories">
          {scorecard.categories.map((category, catIdx) => (
            <div key={catIdx} className="scorecard-category">
              <div className="category-header">
                <h4 className="category-name">{category.name}</h4>
                <span className="category-score">
                  {category.score.correct}/{category.score.total}
                </span>
              </div>
              <div className="category-criteria">
                {category.criteria.map((criterion, critIdx) => (
                  <div
                    key={critIdx}
                    className={`criterion-item ${criterion.passed ? "passed" : "failed"}`}
                  >
                    <span className="criterion-status-icon">
                      {criterion.passed ? "✓" : "✗"}
                    </span>
                    <span className="criterion-name">{criterion.name}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Determine which view to show
  const showPersonaSelection = !active && chat.length === 0;
  const showCallView = active;
  const showPostCallView = !active && chat.length > 0;

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="app-title">Sales Agent Simulation</div>
      </header>

      <main className="app-main">
        {showPersonaSelection && (
          <div className="view-container">
            <div className="persona-selection">
              <h1 className="persona-selection-title">Approaching Sales Calls Intelligently</h1>
              <p className="persona-selection-subtitle">
                AI-powered practice for better conversations
              </p>
              <div className="persona-grid">
                <div
                  className={`persona-card ${
                    persona === "A" ? "selected" : ""
                  }`}
                  onClick={() => setPersona("A")}
                >
                  <img
                    src="/persona_joe.png"
                    alt="Joe"
                    className="persona-image"
                  />
                  <h3 className="persona-name">Joe - The Rusher</h3>
                  <p className="persona-role">
                    Director of Operations at Bain & Co.
                  </p>
                  <p className="persona-description">
                    Time-constrained and direct. Selling: Data Solution
                  </p>
                </div>
                <div
                  className={`persona-card ${
                    persona === "B" ? "selected" : ""
                  }`}
                  onClick={() => setPersona("B")}
                >
                  <img
                    src="/persona_sam.png"
                    alt="Sam"
                    className="persona-image"
                  />
                  <h3 className="persona-name">Sam - The Executive</h3>
                  <p className="persona-role">CEO of BlackRock</p>
                  <p className="persona-description">
                    ROI-focused, hates buzzwords. Selling: AI Solution
                  </p>
                </div>
              </div>
              <button
                className="start-call-button"
                onClick={start}
                disabled={["connecting", "initializing", "stopping"].includes(
                  status
                )}
              >
                Start Call
              </button>
            </div>
          </div>
        )}

        {showCallView && (
          <div className="view-container">
            <div className="call-view">
              <div className="call-status-card">
                <Waveform />
                <p className="call-status-text">{badgeText}</p>
                <p className="call-status-subtitle">
                  {persona === "A" ? "Joe" : "Sam"} is on the line
                </p>
                <button
                  className={`mic-button ${active ? "active" : ""}`}
                  onClick={toggleMic}
                  disabled={[
                    "connecting",
                    "initializing",
                    "stopping",
                    "error",
                  ].includes(status)}
                >
                  🎤
                </button>
              </div>
            </div>
          </div>
        )}

        {showPostCallView && (
          <div className="view-container">
            <div className="post-call-view">
              <div className="post-call-header">
                <h2 className="post-call-title">Your Call Summary</h2>
                <div className="view-tabs">
                  <button
                    className={`tab-button ${!showFeedback ? "active" : ""}`}
                    onClick={() => setShowFeedback(false)}
                  >
                    Transcript
                  </button>
                  <button
                    className={`tab-button ${showFeedback ? "active" : ""}`}
                    onClick={() => setShowFeedback(true)}
                  >
                    Feedback
                  </button>
                </div>
              </div>
              <div className="content-card" ref={transcriptRef}>
                {showFeedback ? (
                  <Scorecard />
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
                          {!isUser && (
                            <img
                              src={personaImage}
                              alt={persona === "A" ? "Joe" : "Sam"}
                              className="message-avatar"
                            />
                          )}
                          <div className="message-content-wrapper">
                            <div className="message-meta">
                              <span className="message-role">
                                {isUser
                                  ? "You"
                                  : persona === "A"
                                  ? "Joe"
                                  : "Sam"}
                              </span>
                              {!isUser && <span className="ai-badge">AI</span>}
                              {m.timestamp && (
                                <span className="timestamp">
                                  {m.timestamp.toLocaleTimeString("en-US", {
                                    hour: "numeric",
                                    minute: "2-digit",
                                  })}
                                </span>
                              )}
                            </div>
                            <div className="message-content">{m.content}</div>
                          </div>
                          {isUser && (
                            <div className="message-avatar user-avatar">
                              <span>U</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <button
                className="new-call-button"
                onClick={() => {
                  setChat([]);
                  setShowFeedback(false);
                  setStatus("idle");
                  setScorecard(null);
                }}
              >
                New Call
              </button>
            </div>
          </div>
        )}
      </main>

      <audio ref={audioRef} />
    </div>
  );
}
