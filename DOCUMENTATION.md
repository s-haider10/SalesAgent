# Sales Agent Simulation - Technical Documentation

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Workflow & Data Flow](#workflow--data-flow)
3. [Component Details](#component-details)
4. [Latency Analysis](#latency-analysis)
5. [WebSocket Protocol](#websocket-protocol)
6. [Hangup Mechanism](#hangup-mechanism)
7. [Feedback System](#feedback-system)

---

## System Architecture

### High-Level Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (React/TS)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ AudioWorklet │  │  WebSocket   │  │   UI State   │      │
│  │   (Mic/TTS)  │  │   Client     │  │  Management  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└───────────────────────────┬─────────────────────────────────┘
                            │ WebSocket (ws://localhost:8000/ws/agent)
                            │ HTTP (http://localhost:8000/api/feedback)
                            ↓
┌─────────────────────────────────────────────────────────────┐
│              Backend (FastAPI + asyncio)                    │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              WebSocket Handler                        │  │
│  │  (main.py: ws_agent)                                  │  │
│  └───────────────────┬──────────────────────────────────┘  │
│                      ↓                                       │
│  ┌──────────────────────────────────────────────────────┐  │
│  │            AgentSession (session.py)                  │  │
│  │  • Orchestrates ASR → LLM → TTS pipeline             │  │
│  │  • Manages conversation history                       │  │
│  │  • Handles barge-in interrupts                       │  │
│  │  • Detects [HANGUP] tokens                           │  │
│  └──────┬──────────────┬──────────────┬──────────────────┘  │
│         ↓              ↓              ↓                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│  │ Fennec   │  │ Baseten  │  │ Inworld  │                   │
│  │   ASR    │  │   LLM    │  │   TTS    │                   │
│  └──────────┘  └──────────┘  └──────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

- **Frontend**: Audio capture/playback, WebSocket communication, UI state, transcript display
- **Backend WebSocket Handler**: Connection management, event routing, hangup coordination
- **AgentSession**: Core orchestration, pipeline management, history tracking
- **ASR (Fennec)**: Real-time speech-to-text with VAD (Voice Activity Detection)
- **LLM (Baseten)**: Conversational AI with persona-specific prompts
- **TTS (Inworld)**: Text-to-speech synthesis with streaming audio

---

## Workflow & Data Flow

### 1. Call Initialization

```
User clicks "Start Call"
    ↓
Frontend: connectAndRecord()
    ↓
WebSocket: ws://localhost:8000/ws/agent
    ↓
Backend: ws_agent() accepts connection
    ↓
Frontend sends: {"type": "start", "persona": "A"}
    ↓
Backend: Creates AgentSession with selected persona
    ↓
AgentSession.start() initializes:
    • Fennec ASR connection
    • Conversation history (empty)
    • Callback handlers
    ↓
Backend sends: {"type": "status", "message": "ready"}
    ↓
Frontend: Starts microphone capture
```

### 2. User Speaks → AI Responds

```
┌─────────────────────────────────────────────────────────────┐
│ Step 1: Audio Capture (Frontend)                           │
│  • AudioWorklet captures mic @ 48kHz                       │
│  • Resamples to 16kHz (Fennec requirement)                 │
│  • Sends PCM16 bytes via WebSocket                          │
└───────────────────────┬─────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 2: ASR Processing (Fennec)                             │
│  • Receives PCM16 @ 16kHz                                   │
│  • VAD detects speech activity                              │
│  • Streaming transcription (interim + final)                │
│  • Final transcript triggers callback                       │
└───────────────────────┬─────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 3: LLM Generation (Baseten)                            │
│  • AgentSession receives final transcript                   │
│  • Adds to conversation history                             │
│  • Streams tokens from LLM                                 │
│  • Segments text by punctuation (250 char budget)           │
│  • Detects [HANGUP] tokens                                  │
└───────────────────────┬─────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 4: TTS Synthesis (Inworld)                             │
│  • Receives text segments                                   │
│  • Synthesizes audio @ 48kHz                                │
│  • Streams PCM16 chunks to frontend                        │
│  • Signals segment completion                               │
└───────────────────────┬─────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 5: Audio Playback (Frontend)                          │
│  • AudioWorklet receives PCM16 @ 48kHz                     │
│  • Low-latency playback (< 50ms)                           │
│  • Updates UI state (speaking/thinking)                     │
└─────────────────────────────────────────────────────────────┘
```

### 3. Barge-In (Interrupt Handling)

```
User starts speaking while AI is talking
    ↓
Fennec VAD detects speech → on_vad() callback
    ↓
AgentSession.barge_in() called
    ↓
• Cancels current LLM stream (if active)
• Cancels current TTS synthesis (if active)
• Clears segment queue
    ↓
User's speech processed → New LLM response generated
```

### 4. Hangup Flow

```
LLM outputs: "This isn't working for me, goodbye [HANGUP]"
    ↓
AgentSession detects [HANGUP] in token stream
    ↓
• Extracts closing phrase: "This isn't working for me, goodbye"
• Sends final segment with is_final=True flag
• Filters out [HANGUP] from text sent to TTS
    ↓
TTS synthesizes closing phrase
    ↓
Backend: on_segment_done(is_final=True)
    ↓
• Sets hangup_requested = True
• Sends HangupEvent to frontend (stops mic input)
• Starts 6-second timeout
    ↓
Frontend: Receives HangupEvent
    ↓
• Stops accepting new mic input
• Waits for audio playback to finish
    ↓
Frontend: Audio finishes → sends final_audio_complete
    ↓
Backend: Receives final_audio_complete
    ↓
• Calls on_hangup()
• Stops AgentSession
• Sends DoneEvent
    ↓
Frontend: Receives DoneEvent
    ↓
• Closes WebSocket
• Triggers feedback API call
• Shows post-call view
```

---

## Component Details

### ASR (Fennec)

**Technology**: Fennec WebSocket API  
**Sample Rate**: 16kHz, mono  
**Features**:

- Streaming transcription (interim + final results)
- VAD (Voice Activity Detection) with configurable thresholds
- Low latency (~400-500ms for final results)
- Automatic punctuation and capitalization

**VAD Events**:

- `{"type": "vad", "state": "speech"}` - User is speaking
- `{"type": "vad", "state": "silence"}` - User stopped speaking
- `{"type": "utterance", "phase": "begin"}` - New utterance detected

**Integration**:

- `FennecWSClient` manages WebSocket connection
- `send_pcm()` sends raw PCM16 bytes
- Callbacks: `on_final(text)`, `on_vad(event)`

### LLM (Baseten)

**Model**: Deepseek3
**API**: OpenAI-compatible (Baseten inference endpoint)  
**Configuration**:

- `temperature=0.8` (balanced responses)
- `max_tokens=256` (concise responses)
- `stream=True` (token-by-token streaming)

**Persona System**:

- **Persona A (Joe)**: Director of Ops, time-constrained, efficiency-focused
- **Persona B (Sam)**: CEO, ROI-focused, dislikes buzzwords

**Prompt Structure**:

```
CORE_INSTRUCTIONS (role, formatting, hangup protocol)
+ PERSONA_PROMPTS (unique profile + one-shot examples)
+ OPTIONAL_AUDIO_MARKUP_PROMPT (emotion/sound tags)
```

**Token Streaming**:

- Tokens streamed in real-time to frontend
- Segmented by punctuation (`.`, `!`, `?`, `…`) or 250-char limit
- `[HANGUP]` detection triggers hangup flow

### TTS (Inworld)

**Technology**: Inworld AI TTS API  
**Sample Rate**: 48kHz, mono  
**Voice**: Mark (configurable)  
**Features**:

- Streaming audio synthesis
- Natural prosody and intonation
- Low latency (~500-1000ms first audio)

**Integration**:

- `InworldTTS` manages HTTP streaming requests
- Receives text segments from LLM
- Streams PCM16 audio chunks to frontend
- Signals completion via `on_segment_done()`

### Frontend Audio Pipeline

**Microphone Capture**:

- AudioWorklet processor (`pcm-processor.js`)
- Captures at 48kHz, resamples to 16kHz
- Sends 32ms chunks (512 samples @ 16kHz)

**Audio Playback**:

- AudioWorklet processor (`pcm-player.js`)
- Receives PCM16 @ 48kHz
- Low-latency playback (< 50ms)
- Tracks playback state for UI updates

**Why AudioWorklet?**

- Runs on separate thread (non-blocking)
- Sub-50ms latency (vs 100-200ms for HTML5 Audio)
- Direct PCM streaming (no encoding/decoding)

---

## Latency Analysis

### End-to-End Latency Breakdown

```
User stops speaking
    ↓
ASR final result: ~200-500ms
    ↓
LLM first token: ~600-1200ms (from ASR final)
    ↓
TTS first audio: ~500-1000ms (from segment ready)
    ↓
Audio playback start: ~50ms (AudioWorklet)
    ↓
Total: ~1.35-2.75 seconds (first audio)
```

### Optimization Strategies

1. **Streaming**: LLM tokens streamed as generated (not waiting for full response)
2. **Segmentation**: Text split by punctuation, TTS starts on first segment
3. **Barge-in**: User can interrupt AI immediately (no wait for full response)
4. **AudioWorklet**: Sub-50ms playback latency (vs 100-200ms for HTML5 Audio)
5. **Debouncing**: ASR final results debounced (220ms) to prevent duplicates

### Measured Latencies

From backend logs:

- `llm first_token`: ~0.6-1.5s
- `tts(first_audio, seg)`: ~0.5-1.7s

**Typical Conversation Flow**:

- User speaks → ASR final (300ms) → LLM first token (700ms) → TTS first audio (600ms) → Playback (50ms)
- **Total**: ~1.65 seconds to first audio

---

## WebSocket Protocol

### Client → Server Messages

**Start Call**:

```json
{
  "type": "start",
  "persona": "A" | "B"
}
```

**Stop Call**:

```json
{
  "type": "stop"
}
```

**Audio Data**:

- Binary WebSocket message (PCM16 bytes, 16kHz, mono)

**Final Audio Complete** (after hangup):

```json
{
  "type": "final_audio_complete"
}
```

### Server → Client Events

**Status Events**:

```json
{"type": "status", "message": "connected" | "initializing" | "ready" | "error"}
```

**ASR Final**:

```json
{ "type": "asr_final", "text": "Hello, this is Joe" }
```

**LLM Tokens** (streaming):

```json
{ "type": "llm_token", "text": "Yeah" }
```

**Audio Chunks**:

- Binary WebSocket message (PCM16 bytes, 48kHz, mono)

**Segment Done**:

```json
{ "type": "segment_done", "is_final": false }
```

**Hangup Event**:

```json
{ "type": "hangup" }
```

**Done Event**:

```json
{ "type": "done" }
```

**Turn Done**:

```json
{ "type": "turn_done" }
```

**VAD Events** (raw):

```json
{"type": "vad", "state": "speech" | "silence"}
{"type": "utterance", "phase": "begin" | "end"}
```

---

## Hangup Mechanism

### AI-Initiated Hangup

The LLM can end the call by outputting `[HANGUP]` in its response:

1. **Detection**: `AgentSession` monitors token stream for `[HANGUP]` (case-insensitive)
2. **Extraction**: Closing phrase extracted (text before `[HANGUP]`)
3. **Final Segment**: Closing phrase sent to TTS with `is_final=True` flag
4. **Frontend Signal**: `HangupEvent` sent immediately (stops mic input)
5. **Audio Completion**: Frontend waits for audio playback to finish
6. **Cleanup**: `final_audio_complete` signal → backend cleanup → `DoneEvent`

### User-Initiated Hangup

User clicks stop button:

1. Frontend sends `{"type": "stop"}`
2. Backend stops `AgentSession`
3. Backend sends `DoneEvent`
4. Frontend triggers feedback API call

### Robustness Features

- **6-second timeout**: If `final_audio_complete` never arrives, backend forces hangup
- **Empty closing phrase**: Handles case where LLM outputs only `[HANGUP]`
- **Race condition handling**: Checks if audio already finished when `is_final` flag arrives

---

## Feedback System

### Post-Call Analysis

After call ends, frontend automatically calls `/api/feedback`:

**Request**:

```json
{
  "transcript": [
    { "role": "user", "content": "Hi, is this Joe?" },
    { "role": "assistant", "content": "Yeah, this is Joe, who is this?" }
  ],
  "persona": "A"
}
```

**Response**:

```json
{
  "overallScore": {"correct": 5, "total": 9},
  "categories": [
    {
      "name": "Opener",
      "score": {"correct": 1, "total": 2},
      "criteria": [
        {"name": "Permission based opener?", "passed": true},
        {"name": "Used research on prospect?", "passed": false}
      ]
    },
    ...
  ],
  "summary": "Stay concise, push for proof",
  "strengths": ["Clear opener"],
  "improvements": ["Ask for ROI specifics"]
}
```

### Evaluation Criteria

**9 Total Criteria**:

1. **Opener** (2): Permission-based opener, Used research
2. **Social Proof** (2): Provided proof, Checked relevance
3. **Discovery** (1): Asked for preconceptions
4. **Closing** (2): Next steps, Meeting booked
5. **Takeaway** (2): Confirmed time, Success criteria

### LLM Evaluation

- Uses same Baseten LLM with specialized prompt
- Strict evaluation (returns `true` only if clearly demonstrated)
- Persona-aware (considers context of Joe vs Sam)
- Returns structured JSON with scores and feedback

---

## Error Handling

### Network Failures

- **WebSocket disconnect**: Frontend reconnects automatically
- **ASR failure**: Session stops, error status sent
- **LLM failure**: Error logged, graceful degradation
- **TTS failure**: Error logged, text shown in transcript

### Timeouts

- **6-second hangup timeout**: Prevents infinite wait for audio completion
- **ASR drop_dead**: 20 seconds (Fennec config)

### Queue Management

- **Input queue full**: Oldest frame dropped (prevents memory buildup)
- **Segment queue**: Bounded to prevent memory issues

---

## Performance Considerations

### Memory Management

- **History truncation**: Last 64 messages kept
- **Queue bounds**: Input queue maxsize=6
- **Segment buffering**: Minimal (streaming-first design)

### Concurrency

- **asyncio tasks**: Separate tasks for PCM pump, LLM streaming, TTS consumption
- **Locks**: History access protected by `_hist_lock`
- **Barge-in lock**: Prevents race conditions during interrupts

### Scalability

- **Stateless design**: Each WebSocket connection is independent
- **No shared state**: Sessions don't interfere with each other
- **Resource cleanup**: Proper cleanup on disconnect/hangup

---

## Development Notes

### Key Design Decisions

1. **AudioWorklet over HTML5 Audio**: Lower latency, better control
2. **Streaming-first**: LLM and TTS stream data (not batch)
3. **Barge-in support**: User can interrupt AI naturally
4. **Persona system**: Flexible prompt structure for different characters
5. **Hangup detection**: Pattern matching in token stream (robust)

### Future Improvements

- **Caching**: Cache common LLM responses
- **Adaptive latency**: Adjust based on network conditions
- **Multi-turn optimization**: Batch processing for faster responses
- **Analytics**: Track latency metrics, success rates

---

## API Keys Required

- **FENNEC_API_KEY**: Fennec ASR service
- **BASETEN_API_KEY**: Baseten LLM inference
- **INWORLD_API_KEY**: Inworld TTS service

All keys stored in `.env` file (not committed to git).
