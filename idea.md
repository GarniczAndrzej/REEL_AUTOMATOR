To successfully pull off this project, you are asking an AI to do three heavy-lifting tasks simultaneously: handle a massive input file (long context window), understand what makes video content engaging and cohesive (creative reasoning), and output a massive, structured list of 150 total segments (high output token limit).
If you feed 700 segments into a standard model, it will either forget half of them, mix up the order, or cut off halfway through its response.
Here are the best OpenRouter models for this specific workflow, categorized by their superpower, followed by the best strategy to execute it.
Top OpenRouter Models for the Job

1. The Context & Value King: Google Gemini Series
• Specific Models: google/gemini-3.1-flash, google/gemini-2.5-flash, or google/gemini-1.5-pro
• Context Window: 1M to 2M tokens
• Why they fit: Gemini models are the undisputed champions of "Needle-in-a-Haystack" tasks. They can swallow your entire list of 700 segments without breaking a sweat or suffering from memory degradation. Flash is incredibly cheap and fast, while Pro offers slightly better creative judgment for what makes a Reel "good."
• Best for: The initial heavy lifting—reading all 700 segments and sorting them into thematic piles.
2. The Creative & Viral Director: Anthropic Claude Series
• Specific Models: anthropic/claude-3.5-sonnet or anthropic/claude-opus-4.8
• Context Window: Up to 1M tokens (on OpenRouter's updated architecture)
• Why they fit: Claude understands nuance, humor, narrative hooks, and audience retention better than almost any other model. If your segments rely on emotional beats, comedic timing, or marketing angles, Claude will write the most engaging sequences for your 10 final Reels.
• Best for: Curation and narrative flow. It excels at choosing which 15 segments actually tell a gripping story together.
3. The Logical Organizer: DeepSeek R1 or DeepSeek V4 Pro
• Specific Models: deepseek/deepseek-r1 or deepseek/deepseek-v4-pro
• Context Window: 1M tokens
• Why they fit: These are deep "reasoning" models. Because they think through a problem via a hidden chain-of-thought before answering, they are phenomenal at complex data sorting. If your 700 segments have overlapping topics and you need a model to meticulously mathematically divide them into exactly 10 distinct, non-repetitive themes, DeepSeek will handle the logic flawlessly.

The Golden Strategy: Don't Do It in One Prompt
Even the best models will struggle if you paste 700 segments and say, "Give me 10 Reels of 15 segments right now." The model will likely hit its output limit and cut off around Reel 4 or 5, or it will get lazy and give you generic choices.
Instead, build a two-step pipeline using OpenRouter:
Step 1: Filter and Cluster (Use Gemini 3.1 Flash or DeepSeek V4 Pro)
Format your input file so every segment has a unique ID (e.g., [SEG-001], [SEG-002]). Paste the whole file and ask the model to do a high-level sort:
"I have 700 video segments. Based on their topics and hook potential, I need you to identify the top 10 most cohesive narrative themes for a 10-part Reel series. For each theme, give me a catchy title and a list of 25 candidate segment IDs that fit that theme. Do not write out the full text, just the IDs."
Step 2: Curate the Final Reels (Use Claude 3.5 Sonnet)
Now that you have 10 distinct buckets of ~25 segments, pass one bucket at a time to Claude to build the final masterfully edited Reels:
"Here are 25 candidate segments for a Reel themed around [Insert Theme]. I need you to pick the absolute best 15 segments from this list and arrange them into a high-retention narrative flow for a 90-second Reel. Explain the transition logic between each segment so it feels seamless."
By splitting the task, you leverage Gemini's massive memory to organize the data, and Claude's elite storytelling ability to craft the final viral Reels without ever hitting token limits.