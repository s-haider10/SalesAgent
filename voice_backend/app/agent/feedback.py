"""Sales call feedback evaluator using LLM."""

import json
import logging
from typing import Any, Dict, List

from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

# Concise evaluation prompt
FEEDBACK_PROMPT = """You are a sales coach evaluating a cold call transcript. Be strict but fair.

PERSONA CONTEXT:
{persona_context}

TRANSCRIPT:
{transcript}

Evaluate against these 9 criteria. For each, return true ONLY if clearly demonstrated:

OPENER (2 criteria):
1. permission_opener: Asked for permission or time before pitching
2. used_research: Referenced specific info about prospect/company

SOCIAL_PROOF (2 criteria):
3. provided_proof: Gave concrete example/case study/metric
4. checked_relevance: Asked if the proof resonated or was relevant

DISCOVERY (1 criterion):
5. asked_preconceptions: Asked what prospect already knows/thinks about the space

CLOSING (2 criteria):
6. next_steps: Proposed clear next action
7. meeting_booked: Got commitment for follow-up

TAKEAWAY (2 criteria):
8. confirmed_time: Re-confirmed availability/timing works
9. success_criteria: Asked what would make next call successful

Also provide:
- summary: One short phrase (max 5 words) capturing main advice
- strengths: Array of 1-2 short strength tags (max 3 words each)
- improvements: Array of 1-2 short improvement tags (max 3 words each)

Return ONLY valid JSON:
{{
  "criteria": {{
    "permission_opener": bool,
    "used_research": bool,
    "provided_proof": bool,
    "checked_relevance": bool,
    "asked_preconceptions": bool,
    "next_steps": bool,
    "meeting_booked": bool,
    "confirmed_time": bool,
    "success_criteria": bool
  }},
  "summary": "string",
  "strengths": ["string"],
  "improvements": ["string"]
}}"""

PERSONA_CONTEXTS = {
    "A": "Joe - Director of Operations at Bain & Co. Time-constrained, direct, efficiency-focused.",
    "B": "Sam - CEO of BlackRock. Professional, high-level, ROI-focused, dislikes buzzwords."
}


def format_transcript(messages: List[Dict[str, str]]) -> str:
    """Format chat messages into readable transcript."""
    lines = []
    for msg in messages:
        role = "Sales Rep" if msg["role"] == "user" else "Prospect"
        lines.append(f"{role}: {msg['content']}")
    return "\n".join(lines)


def build_scorecard(result: Dict[str, Any]) -> Dict[str, Any]:
    """Convert LLM result to scorecard format."""
    criteria = result.get("criteria", {})
    
    categories = [
        {
            "name": "Opener",
            "criteria": [
                {"name": "Permission based opener?", "passed": criteria.get("permission_opener", False)},
                {"name": "Used research on prospect?", "passed": criteria.get("used_research", False)},
            ]
        },
        {
            "name": "Social Proof",
            "criteria": [
                {"name": "Provided social proof?", "passed": criteria.get("provided_proof", False)},
                {"name": "Asked if social proof was relevant?", "passed": criteria.get("checked_relevance", False)},
            ]
        },
        {
            "name": "Discovery",
            "criteria": [
                {"name": "SDR asked for preconceptions?", "passed": criteria.get("asked_preconceptions", False)},
            ]
        },
        {
            "name": "Closing",
            "criteria": [
                {"name": "Next steps agreed upon?", "passed": criteria.get("next_steps", False)},
                {"name": "Follow-up meeting booked?", "passed": criteria.get("meeting_booked", False)},
            ]
        },
        {
            "name": "Takeaway",
            "criteria": [
                {"name": "Re-confirmed time works?", "passed": criteria.get("confirmed_time", False)},
                {"name": "Asked for success criteria?", "passed": criteria.get("success_criteria", False)},
            ]
        },
    ]
    
    # Calculate scores
    total_correct = 0
    total_criteria = 0
    for cat in categories:
        cat_correct = sum(1 for c in cat["criteria"] if c["passed"])
        cat_total = len(cat["criteria"])
        cat["score"] = {"correct": cat_correct, "total": cat_total}
        total_correct += cat_correct
        total_criteria += cat_total
    
    return {
        "overallScore": {"correct": total_correct, "total": total_criteria},
        "categories": categories,
        "summary": result.get("summary", "Keep improving"),
        "strengths": result.get("strengths", []),
        "improvements": result.get("improvements", [])
    }


async def evaluate_call(
    api_key: str,
    base_url: str,
    model: str,
    transcript: List[Dict[str, str]],
    persona: str
) -> Dict[str, Any]:
    """Evaluate a sales call transcript and return structured feedback."""
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    
    formatted_transcript = format_transcript(transcript)
    persona_context = PERSONA_CONTEXTS.get(persona, PERSONA_CONTEXTS["A"])
    
    prompt = FEEDBACK_PROMPT.format(
        persona_context=persona_context,
        transcript=formatted_transcript
    )
    
    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=500,
        )
        
        content = response.choices[0].message.content.strip()
        
        # Extract JSON from response
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0].strip()
        elif "```" in content:
            content = content.split("```")[1].split("```")[0].strip()
        
        result = json.loads(content)
        return build_scorecard(result)
        
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse LLM response: {e}")
        # Return empty scorecard on parse error
        return build_scorecard({"criteria": {}, "summary": "Analysis failed", "strengths": [], "improvements": []})
    except Exception as e:
        logger.exception(f"Feedback evaluation error: {e}")
        raise

