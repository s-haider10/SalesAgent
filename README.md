# Sales Agent Simulation

AI-powered sales call practice platform with real-time voice interaction and automated feedback analysis.

## Features

- **Real-time Voice Conversation**: Practice sales calls with AI personas (Joe - Director of Ops, Sam - CEO)
- **Low-Latency Pipeline**: ASR → LLM → TTS with streaming and barge-in support
- **Automated Feedback**: Post-call analysis with 9 evaluation criteria
- **Microsoft AI-Inspired UI**: Warm, approachable design with elegant typography

## Quick Start

### Backend

```bash
cd voice_backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt

# Set up .env file with API keys:
# FENNEC_API_KEY=your_key
# BASETEN_API_KEY=your_key
# BASETEN_BASE_URL=https://inference.baseten.co/v1
# BASETEN_MODEL=meta-llama/Llama-4-Scout-17B-16E-Instruct
# INWORLD_API_KEY=your_key
# INWORLD_MODEL_ID=inworld-tts-1
# INWORLD_VOICE_ID=Olivia

uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### Frontend

```bash
cd voice_frontend
npm install
npm run dev
```

Visit `http://localhost:5173` (Vite dev server proxies `/api` to backend on port 8000)

## Tech Stack

- **Backend**: FastAPI, WebSockets, asyncio
- **Frontend**: React, TypeScript, Vite, AudioWorklet
- **ASR**: Fennec (streaming, VAD-enabled)
- **LLM**: Baseten (Llama-4-Scout-17B)
- **TTS**: Inworld AI (streaming, 48kHz)

## Architecture

```
Frontend (React) ←→ WebSocket ←→ Backend (FastAPI)
                         ↓
              AgentSession (orchestrator)
              ├── FennecWSClient (ASR)
              ├── BasetenChat (LLM)
              └── InworldTTS (TTS)
```

See [DOCUMENTATION.md](DOCUMENTATION.md) for detailed system design and workflow.

## License

See [LICENSE](LICENSE) file.

