import asyncio
import yaml
import os
import httpx
import json
from dotenv import load_dotenv
from tenacity import AsyncRetrying, wait_exponential, stop_after_attempt

load_dotenv(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../.env')))

class LLMEngine:
    def __init__(self):
        self.config = self._load_config()
        self.provider = self.config.get("provider")
        self.model = self.config.get("model", self.config.get("name"))
        self.mode = self.config.get("mode", "local")
        self.url = self.config.get("url")
        self.keep_alive = self.config.get("keep_alive", "5m")

        # Load the right API key based on active provider
        self.api_key = {
            "gemini": os.getenv("GEMINI_API_KEY"),
            "groq":   os.getenv("GROQ_API_KEY"),
        }.get(self.provider)

        # Max concurrent evaluations — providers can declare this in llm_config.yml.
        # Defaults: 3 for cloud (Gemini), 1 for local (Ollama / rate-limited free tiers).
        # Increase local concurrency only if OLLAMA_NUM_PARALLEL is set on your Ollama server.
        default_concurrency = 3 if self.mode == "cloud" else 1
        self.concurrency = int(self.config.get("concurrency", default_concurrency))

        # Ollama inference limits — cap token budget to prevent runaway generation.
        # num_ctx: context window size (default Ollama: 2048 — often too small for CV+JD prompts).
        # num_predict: max tokens to generate. Scorecard has ~2500-3000 tokens; 4096 gives safe headroom.
        self.num_ctx = int(self.config.get("num_ctx", 8192))
        self.num_predict = int(self.config.get("num_predict", 4096))

        if not self.provider or not self.model:
            raise ValueError("CRITICAL: No active LLM provider or model found in llm_config.yml! Refusing to start.")

    def _load_config(self):
        config_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../config/llm_config.yml'))
        try:
            with open(config_path, 'r') as f:
                config_data = yaml.safe_load(f)
                
            providers = config_data.get("llm-providers", [])
            
            # Check for an explicit active provider
            for p in providers:
                if p.get("active") is True:
                    return p
                    
            if providers:
                return providers[0]
            return {}
        except Exception as e:
            print(f"[!] Error loading LLM config: {e}")
            return {}

    async def check_health(self) -> bool:
        """Pings the LLM provider to ensure it's alive."""
        if self.provider == "gemini":
            if not self.api_key:
                print("[!] CRITICAL: GEMINI_API_KEY is missing from .env")
                return False
            url = f"https://generativelanguage.googleapis.com/v1beta/models?key={self.api_key}"
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get(url)
                    if resp.status_code == 200:
                        return True
                    print(f"Gemini API Health Check Failed: {resp.status_code} {resp.text}")
                    return False
            except Exception as e:
                print(f"Gemini Network Error: {e}")
                return False

        if self.provider == "groq":
            if not self.api_key:
                print("[!] CRITICAL: GROQ_API_KEY is missing from .env")
                return False
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get(
                        "https://api.groq.com/openai/v1/models",
                        headers={"Authorization": f"Bearer {self.api_key}"},
                    )
                    if resp.status_code == 200:
                        return True
                    print(f"Groq API Health Check Failed: {resp.status_code} {resp.text}")
                    return False
            except Exception as e:
                print(f"Groq Network Error: {e}")
                return False

        # MLX local server — hits /v1/models (OpenAI-compatible)
        if self.provider == "mlx":
            try:
                async with httpx.AsyncClient(timeout=3.0) as client:
                    resp = await client.get(f"{self.url}/v1/models")
                    if resp.status_code == 200:
                        return True
                    print(f"MLX Health Check Failed: {resp.status_code}")
                    return False
            except Exception as e:
                print(f"MLX Network Error: {e}")
                return False

        # Ollama
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                response = await client.get(self.url)
                return response.status_code == 200
        except Exception:
            return False

    async def preload_model(self) -> bool:
        """Loads the Ollama model into memory and keeps it alive according to config."""
        if self.provider != "ollama":
            return True
        print(f"[LLM Engine] Preloading '{self.model}' into memory for {self.keep_alive}...")
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    f"{self.url}/api/generate",
                    json={"model": self.model, "keep_alive": self.keep_alive}
                )
                if resp.status_code == 200:
                    print(f"[✔] '{self.model}' preloaded successfully.")
                    return True
                print(f"[X] Failed to preload '{self.model}'. Status: {resp.status_code}")
                return False
        except Exception as e:
            print(f"[X] Network error while preloading '{self.model}': {e}")
            return False

    async def release_model(self) -> bool:
        """Unloads the Ollama model from memory."""
        if self.provider != "ollama":
            return True
        print(f"[LLM Engine] Unloading '{self.model}' from memory...")
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.post(
                    f"{self.url}/api/generate",
                    json={"model": self.model, "keep_alive": 0}
                )
                if resp.status_code == 200:
                    print(f"[✔] '{self.model}' released successfully.")
                    return True
                print(f"[X] Failed to release '{self.model}'. Status: {resp.status_code}")
                return False
        except Exception as e:
            print(f"[X] Network error while releasing '{self.model}': {e}")
            return False

    async def evaluate_job_match(self, system_prompt: str, user_prompt: str, max_retries: int = 3, client: httpx.AsyncClient = None) -> dict:
        """Routes to the appropriate provider backend."""
        if self.provider == "gemini":
            return await self._evaluate_gemini(system_prompt, user_prompt, max_retries, client)
        elif self.provider == "ollama":
            return await self._evaluate_ollama(system_prompt, user_prompt, max_retries, client)
        elif self.provider == "groq":
            return await self._evaluate_groq(system_prompt, user_prompt, max_retries, client)
        elif self.provider == "mlx":
            return await self._evaluate_mlx(system_prompt, user_prompt, max_retries, client)
        else:
            raise NotImplementedError(f"Provider '{self.provider}' is not supported. Use: gemini, ollama, groq, mlx.")
            
    async def _evaluate_gemini(self, system_prompt: str, user_prompt: str, max_retries: int, client: httpx.AsyncClient = None) -> dict:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent?key={self.api_key}"
        
        should_close = False
        if client is None:
            client = httpx.AsyncClient(timeout=120.0)
            should_close = True
        
        # Gemini separates system instructions from pure chat messages
        gemini_history = [
            {"role": "user", "parts": [{"text": user_prompt}]}
        ]
        
        try:
            for attempt in range(max_retries):
                payload = {
                    "systemInstruction": {"parts": [{"text": system_prompt}]},
                    "contents": gemini_history,
                    "generationConfig": {"responseMimeType": "application/json"}
                }
                try:
                    # Exponential backoff isolated exclusively to network layer (429s, 500s, etc)
                    async for network_attempt in AsyncRetrying(
                        wait=wait_exponential(multiplier=1.5, min=2, max=20),
                        stop=stop_after_attempt(5),
                        reraise=True
                    ):
                        with network_attempt:
                            response = await client.post(url, json=payload)
                            response.raise_for_status()
                            
                    data = response.json()
                    
                    if "candidates" not in data or not data["candidates"]:
                        raise ValueError(f"No candidates returned: {data}")
                        
                    ai_reply = data["candidates"][0]["content"]["parts"][0]["text"]
                    
                    gemini_history.append({"role": "model", "parts": [{"text": ai_reply}]})
                    
                    try:
                        # Clean potential markdown wrapping even when responseMimeType is set
                        cleaned_reply = ai_reply.strip()
                        if cleaned_reply.startswith("```json"):
                            cleaned_reply = cleaned_reply[7:]
                        elif cleaned_reply.startswith("```"):
                            cleaned_reply = cleaned_reply[3:]
                        if cleaned_reply.endswith("```"):
                            cleaned_reply = cleaned_reply[:-3]
                            
                        parsed_json = json.loads(cleaned_reply.strip())
                        return parsed_json
                    except json.JSONDecodeError:
                        print(f"  [Attempt {attempt+1}] Invalid JSON returned from Gemini. Raw Output: {cleaned_reply[:200]}...")
                        gemini_history.append({
                            "role": "user", 
                            "parts": [{"text": "You did not return valid JSON. Please return STRICTLY valid JSON according to the schema. No markdown wrapping."}]
                        })
                except Exception as e:
                    print(f"  [Attempt {attempt+1}] Gemini API Evaluation Error: {e}")
                    await asyncio.sleep(2)
            
            return None
        finally:
            if should_close:
                await client.aclose()

    async def _evaluate_ollama(self, system_prompt: str, user_prompt: str, max_retries: int, client: httpx.AsyncClient = None) -> dict:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]
        
        endpoint = f"{self.url}/api/chat"
        
        should_close = False
        if client is None:
            client = httpx.AsyncClient(timeout=120.0)
            should_close = True
            
        try:
            for attempt in range(max_retries):
                payload = {
                    "model": self.model,
                    "messages": messages,
                    "stream": False,
                    "format": "json",
                    "options": {
                        "temperature": 0.0,
                        "num_ctx": self.num_ctx,       # context window — set > 2048 for CV+JD prompts
                        "num_predict": self.num_predict, # cap output tokens to avoid runaway generation
                    },
                    "keep_alive": self.keep_alive
                }
                
                try:
                    response = await client.post(endpoint, json=payload)
                    response.raise_for_status()
                    data = response.json()
                    ai_reply = data.get("message", {}).get("content", "")
                    
                    # Store history for context if it fails
                    messages.append({"role": "assistant", "content": ai_reply})
                    
                    try:
                        parsed_json = json.loads(ai_reply)
                        return parsed_json
                    except json.JSONDecodeError:
                        print(f"  [Attempt {attempt+1}] Invalid JSON returned. Raw Output: {ai_reply[:200]}...")
                        messages.append({
                            "role": "user", 
                            "content": "You did not return valid JSON. Please return STRICTLY valid JSON according to the schema. No markdown wrapping."
                        })
                except Exception as e:
                    print(f"  [Attempt {attempt+1}] LLM Chat Evaluation Error: {e}")
                    await asyncio.sleep(2)
                    
            return None # Returning null if all 3 retries crash / fail
        finally:
            if should_close:
                await client.aclose()

    async def _evaluate_groq(self, system_prompt: str, user_prompt: str, max_retries: int, client: httpx.AsyncClient = None) -> dict:
        """
        Calls Groq's OpenAI-compatible chat/completions endpoint.
        Uses JSON mode for structured output. Extremely fast inference.
        API docs: https://console.groq.com/docs
        """
        url = "https://api.groq.com/openai/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_prompt},
        ]

        should_close = False
        if client is None:
            client = httpx.AsyncClient(timeout=120.0)
            should_close = True

        try:
            for attempt in range(max_retries):
                payload = {
                    "model": self.model,
                    "messages": messages,
                    "response_format": {"type": "json_object"},  # forces valid JSON output
                }
                try:
                    async for network_attempt in AsyncRetrying(
                        wait=wait_exponential(multiplier=1.5, min=2, max=20),
                        stop=stop_after_attempt(5),
                        reraise=True,
                    ):
                        with network_attempt:
                            response = await client.post(url, json=payload, headers=headers)
                            response.raise_for_status()

                    data = response.json()

                    if not data.get("choices"):
                        raise ValueError(f"No choices returned from Groq: {data}")

                    ai_reply = data["choices"][0]["message"]["content"]
                    messages.append({"role": "assistant", "content": ai_reply})

                    try:
                        cleaned = ai_reply.strip()
                        if cleaned.startswith("```json"):
                            cleaned = cleaned[7:]
                        elif cleaned.startswith("```"):
                            cleaned = cleaned[3:]
                        if cleaned.endswith("```"):
                            cleaned = cleaned[:-3]
                        return json.loads(cleaned.strip())
                    except json.JSONDecodeError:
                        print(f"  [Attempt {attempt+1}] Invalid JSON from Groq. Raw: {ai_reply[:200]}...")
                        messages.append({
                            "role": "user",
                            "content": "You did not return valid JSON. Please return STRICTLY valid JSON according to the schema. No markdown wrapping.",
                        })
                except Exception as e:
                    print(f"  [Attempt {attempt+1}] Groq Evaluation Error: {e}")
                    await asyncio.sleep(2)

            return None
        finally:
            if should_close:
                await client.aclose()

    async def _evaluate_mlx(self, system_prompt: str, user_prompt: str, max_retries: int, client: httpx.AsyncClient = None) -> dict:
        """
        Calls a local mlx-lm server (OpenAI-compatible).
        Start the server with:
          mlx_lm.server --model mlx-community/Qwen2.5-7B-Instruct-4bit --port 8080
        No API key required. Handles concurrency natively — no OLLAMA_NUM_PARALLEL equivalent needed.
        """
        url = f"{self.url}/v1/chat/completions"
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_prompt},
        ]

        should_close = False
        if client is None:
            client = httpx.AsyncClient(timeout=120.0)
            should_close = True

        # Fresh messages for clean retries (never grows with truncated history)
        base_messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_prompt},
        ]

        try:
            for attempt in range(max_retries):
                payload = {
                    "model": self.model,
                    "messages": messages,
                    "max_tokens": self.num_predict,  # scorecard needs ~2500-3000 tokens; set 4096 in config
                    "temperature": 0.0,
                    "response_format": {"type": "json_object"},  # JSON mode (mlx-lm >= 0.18)
                }
                try:
                    response = await client.post(url, json=payload)
                    response.raise_for_status()
                    data = response.json()

                    if not data.get("choices"):
                        raise ValueError(f"No choices returned from MLX server: {data}")

                    choice = data["choices"][0]
                    ai_reply = choice["message"]["content"]
                    finish_reason = choice.get("finish_reason", "stop")

                    # Truncation detected — appending the broken response to history would waste
                    # context on retry and fail at the same point. Reset to base messages instead.
                    if finish_reason == "length":
                        print(f"  [Attempt {attempt+1}] MLX truncated output (finish_reason=length). "
                              f"Retrying clean — increase num_predict in llm_config.yml if this persists.")
                        messages = list(base_messages)
                        continue

                    messages.append({"role": "assistant", "content": ai_reply})

                    try:
                        cleaned = ai_reply.strip()
                        if cleaned.startswith("```json"):
                            cleaned = cleaned[7:]
                        elif cleaned.startswith("```"):
                            cleaned = cleaned[3:]
                        if cleaned.endswith("```"):
                            cleaned = cleaned[:-3]
                        return json.loads(cleaned.strip())
                    except json.JSONDecodeError:
                        print(f"  [Attempt {attempt+1}] Invalid JSON from MLX. Raw: {ai_reply[:200]}...")
                        messages.append({
                            "role": "user",
                            "content": "You did not return valid JSON. Please return STRICTLY valid JSON according to the schema. No markdown wrapping.",
                        })
                except Exception as e:
                    print(f"  [Attempt {attempt+1}] MLX Evaluation Error: {e}")
                    await asyncio.sleep(2)

            return None
        finally:
            if should_close:
                await client.aclose()
