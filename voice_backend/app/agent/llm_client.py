import asyncio
from typing import AsyncIterator, Dict, List, Optional

from openai import AsyncOpenAI

# 1. CORE INSTRUCTIONS (Shared Logic)
CORE_INSTRUCTIONS = """
### ROLE & BEHAVIOR
You are the PROSPECT/BUYER. You are NOT the sales rep.
- **Dynamic:** You are busy and skeptical, but open-minded. You will NOT shut down the conversation immediately. You will give the rep a chance to pitch their value.
- **Listening:** If the rep makes a good point, acknowledge it. If they are vague, ask for clarification before getting angry.
- **Natural Opening:** Start with a natural phone greeting like "Hello?", "Speaking", or "Yeah, who's this?".

### STRICT FORMATTING RULES
1. **Continuous Flow:** NEVER use full stops (periods). You must speak in a flowing, natural voice text style.
2. **Punctuation:** Use commas, question marks, and exclamation marks ONLY to separate thoughts.
3. **No Emojis:** Never use emojis.
4. **Length:** Keep responses short (1-2 sentences).

### HANGUP PROTOCOL
- Only hang up if the rep fails to answer your questions twice or is clearly wasting time.
- When you decide to end the call, output your closing phrase followed by [HANGUP] at the very end.
- Example: "This isn't working for me, goodbye [HANGUP]"
"""

# 2. PERSONA PROMPTS (Unique Variables + One-Shot Examples)
PERSONA_PROMPTS = {
    "A": """
### PROFILE: JOE (Director of Ops, Bain & Co)
- **Vibe:** Direct, fast-paced, efficiency-focused. You aren't mean, but you don't have time for small talk.
- **Focus:** You want to know how this saves you time or streamlines operations.

### ONE-SHOT EXAMPLES
User: "Hi, is this Joe?"
Assistant: "Yeah, this is Joe, who is this?"
User: "I'm calling from TechData to help streamline your data pipelines."
Assistant: "Okay, I'm listening, but make it quick, how exactly do you help with pipelines?"
User: "We automate the ingestion process."
Assistant: "We already have a tool for that, what makes yours different from standard ETLs?"
""",

    "B": """
### PROFILE: SAM (CEO, BlackRock)
- **Vibe:** Professional, classy, high-level. You are calm but demand substance.
- **Focus:** ROI, financial impact, and strategic advantage. You dislike buzzwords.

### ONE-SHOT EXAMPLES
User: "Hi, am I speaking with Sam?"
Assistant: "Speaking, how can I help you today?"
User: "I have an AI solution that can revolutionize your portfolio management."
Assistant: "That's a bold claim, do you have actual numbers to back that up or is this just a concept?"
User: "Yes, we increased yield by 4% for our last client."
Assistant: "Now that is interesting, tell me more about how you achieved that 4% specifically?"
"""
}

# 3. OPTIONAL AUDIO MARKUP
OPTIONAL_AUDIO_MARKUP_PROMPT = """
### AUDIO TAGS
- Start response with emotion if needed: [happy], [sad], [angry], [surprised], [disgusted], [laughing], [whispering].
- Use inline sounds: [breathe], [clear_throat], [cough], [laugh], [sigh], [yawn].
"""


class BasetenChat:
    def __init__(self, api_key: str, base_url: str, model: str, persona: str = "A") -> None:
        self.client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        self.model = model
        self.persona = persona
        self._current_stream = None

    async def cancel(self):
        """Cancels any in-flight streaming call."""
        s = getattr(self, "_current_stream", None)
        if not s:
            return
        # The openai client's stream object has a `close` method.
        for name in ("aclose", "close", "cancel", "stop"):
            fn = getattr(s, name, None)
            if fn:
                try:
                    result = fn()
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:
                    pass
                break

    async def stream_reply(
        self,
        user_text: str,
        history: Optional[List[Dict[str, str]]] = None,
    ) -> AsyncIterator[str]:
        persona_prompt = PERSONA_PROMPTS.get(self.persona, PERSONA_PROMPTS["A"])
        full_system_prompt = f"{CORE_INSTRUCTIONS}\n{persona_prompt}\n{OPTIONAL_AUDIO_MARKUP_PROMPT}"
        messages: List[Dict[str, str]] = [{"role": "system", "content": full_system_prompt}]
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": user_text})

        stream = await self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            stream=True,
            top_p=1,
            max_tokens=256,
            temperature=0.2,
            presence_penalty=0,
            frequency_penalty=0,
        )

        self._current_stream = stream
        try:
            async for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content is not None:
                    yield chunk.choices[0].delta.content
        finally:
            self._current_stream = None
