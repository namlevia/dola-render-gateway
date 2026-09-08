"""Video worker: in-page fetch submission and /im/chain/single polling."""
import asyncio
import base64
import hashlib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
except ImportError:
    Cipher = None

import aiohttp
from patchright.async_api import async_playwright

import config
from browser import cookie_value, launch_account_context
from dola_client import CREDIT_FAIL_PATTERN, CreditError
from video_probe import SUBMIT_JS

# Poll /im/chain/single for video status
POLL_JS = r"""
async ({conversationId, msToken, fp}) => {
  // Current protocol: uplink_body.pull_singe_chain_uplink_body
  const params = new URLSearchParams({
    version_code: "20800", language: "ja", device_platform: "web",
    doubao_device_platform: "web", aid: "495671", real_aid: "495671",
    pkg_type: "release_version", pc_version: "3.32.61", doubao_pc_version: "3.32.61",
    region: "JP", sys_region: "JP", samantha_web: "1", web_platform: "browser",
    "use-olympus-account": "1", web_tab_id: crypto.randomUUID(),
  });

  const resp = await fetch("/im/chain/single?" + params.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json; encoding=utf-8",
      "agw-js-conv": "str",
      "Accept": "*/*",
    },
    body: JSON.stringify({
      cmd: 3100,
      uplink_body: {
        pull_singe_chain_uplink_body: {
          conversation_id: conversationId,
          anchor_index: Number.MAX_SAFE_INTEGER,
          conversation_type: 3,
          direction: 1,
          limit: 20,
          ext: {},
          filter: {index_list: []},
          evaluate_ab_params: "",
          evaluate_common_params: "",
        },
      },
      sequence_id: crypto.randomUUID(),
      channel: 2,
      version: "1",
    }),
    credentials: "include",
  });
  if (!resp.ok) return {ok: false, status: resp.status, texts: [], videos: []};

  const data = await resp.json();
  const messages =
    (((data.downlink_body || {}).pull_singe_chain_downlink_body) || {}).messages || [];
  const texts = [];
  const videos = [];
  const videoModels = [];
  for (const msg of messages) {
    let content = msg.content;
    if (typeof content === "string") {
      try { content = JSON.parse(content); } catch (e) { continue; }
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const text = (((block.content || {}).text_block) || {}).text || "";
      if (text) texts.push(text.slice(0, 120));
      if (block.block_type !== 2074) continue;
      const creations = (((block.content || {}).creation_block) || {}).creations || [];
      for (const cre of creations) {
        if (cre.type !== 2) continue;
        const url = ((cre.video || {}).download_url) || "";
        if (url.startsWith("http")) {
          videos.push(url);
          videoModels.push((cre.video || {}).video_model || "");
        }
      }
    }
  }
  return {ok: true, status: resp.status, texts, videos, videoModels};
}
"""


QAAB_SALT_HEX = (
    "4dd4c2e6b83162090e52b3c7a6733ba4"
    "1cb2462b829ab58a196b39db57177524"
    "f49baf7f08e8d68d26a72e37c1a95a2f"
    "1f05a51892aef2949732b62a38aadd58"
)


def is_watermarked_media_url(url: str) -> bool:
    """Checks if video URL contains watermark markers."""
    if not url:
        return True
    u = str(url)
    if re.search(r"video_gen_watermark", u, re.I):
        return True
    if re.search(r"[?&]lr=watermarked\b", u, re.I):
        return True
    if re.search(r"[?&]logo_type=(?:watermarked|wm)\b", u, re.I):
        return True
    if re.search(r"/(?:wm|watermark)(?:/|_)", u, re.I):
        return True
    return False


def _base64_decode_loose(s: str) -> bytes:
    s = str(s or "").strip().replace("-", "+").replace("_", "/")
    pad = (4 - len(s) % 4) % 4
    return base64.b64decode(s + "=" * pad)


def decode_qaab_token(token: str, key_seed: str) -> str:
    """Decrypts AES-CBC qAAB video URL tokens from ByteDance fallback_api."""
    if not Cipher:
        return ""
    try:
        data = _base64_decode_loose(token)
        seed = _base64_decode_loose(key_seed)
        if not data or not seed:
            return ""
        digest1 = hashlib.sha512(seed[:32]).digest()
        salt = bytes.fromhex(QAAB_SALT_HEX)
        digest2 = hashlib.sha512(digest1 + salt).digest()
        key = digest2[:16]
        iv = digest2[16:32]

        attempts = []
        if len(data) >= 4 and data[:4] == b"\xa8\x00\x01\x00":
            attempts.append((data[4:], key, iv))
            attempts.append((data[4:], iv, key))
            if len(data) > 36:
                attempts.append((data[36:], key, data[20:36]))
                attempts.append((data[36:], key, iv))
        else:
            attempts.append((data, key, iv))

        for payload, k, v in attempts:
            if len(payload) % 16 != 0:
                continue
            try:
                cipher = Cipher(algorithms.AES(k), modes.CBC(v))
                decryptor = cipher.decryptor()
                plain = decryptor.update(payload) + decryptor.finalize()
                pad_len = plain[-1]
                if 1 <= pad_len <= 16 and plain.endswith(bytes([pad_len]) * pad_len):
                    unpadded = plain[:-pad_len]
                else:
                    unpadded = plain
                text = unpadded.decode("latin1")
                if text.startswith("http://") or text.startswith("https://"):
                    return text
            except Exception:
                pass
    except Exception:
        pass
    return ""


def resolve_fallback_api_unwatermarked(fallback_api: str, key_seed: str = "") -> str:
    """Queries fallback_api with logo_type=unwatermarked and extracts clean URL."""
    try:
        parsed = urllib.parse.urlparse(fallback_api)
        qs = urllib.parse.parse_qs(parsed.query)
        qs["channel"] = ["no"]
        qs["codec_type"] = ["8"]
        qs["logo_type"] = ["unwatermarked"]
        new_url = urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(qs, doseq=True)))

        if not key_seed:
            seed_param = qs.get("key_seed")
            if seed_param:
                key_seed = seed_param[0]

        req = urllib.request.Request(
            new_url,
            headers={"Accept": "application/json,text/plain,*/*", "User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8", "ignore"))

        video_info = data.get("video_info") or data.get("data", {}).get("video_info") or data
        vdata = video_info.get("data") or video_info
        vlist = vdata.get("video_list") or {}

        if not key_seed:
            key_seed = vdata.get("key_seed") or data.get("key_seed") or ""

        candidates = []
        entries = list(vlist.values()) if isinstance(vlist, dict) else [vdata]
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            token = entry.get("main_url") or entry.get("play_url") or ""
            if not token:
                continue
            score = int(entry.get("bitrate") or entry.get("real_bitrate") or 0)
            candidates.append((score, token))

        candidates.sort(key=lambda x: x[0], reverse=True)
        for _, token in candidates:
            if token.startswith("http"):
                url = token
            elif token.startswith("qAAB") and key_seed:
                url = decode_qaab_token(token, key_seed)
            else:
                try:
                    url = _base64_decode_loose(token).decode("latin1", "ignore")
                except Exception:
                    url = ""
            if url.startswith("http") and not is_watermarked_media_url(url):
                return url
            elif url.startswith("http"):
                return url
    except Exception as e:
        print(f"[video_worker] Failed to resolve fallback_api unwatermarked: {e}", flush=True)
    return ""


def extract_unwatermarked_url(video_model_str: str, fallback_url: str) -> str:
    """Extracts unwatermarked video URL (fallback_api priority + qAAB decryption, or video_list)."""
    try:
        vm = json.loads(video_model_str or "{}") if isinstance(video_model_str, str) else (video_model_str or {})
        fallback_api = vm.get("fallback_api") or ""
        key_seed = vm.get("key_seed") or ""
        if fallback_api:
            clean_url = resolve_fallback_api_unwatermarked(fallback_api, key_seed)
            if clean_url and not is_watermarked_media_url(clean_url):
                return clean_url
            if clean_url:
                return clean_url

        video_list = vm.get("video_list") or {}
        candidates = []
        for v in video_list.values():
            if not isinstance(v, dict):
                continue
            main_url = v.get("main_url") or ""
            if not main_url:
                continue
            try:
                decoded = _base64_decode_loose(main_url).decode("utf-8", "ignore")
            except Exception:
                continue
            if decoded.startswith("http"):
                candidates.append((int(v.get("bitrate") or v.get("real_bitrate") or 0), decoded))
        if candidates:
            candidates.sort(key=lambda x: x[0], reverse=True)
            clean_candidates = [c for c in candidates if not is_watermarked_media_url(c[1])]
            if clean_candidates:
                return clean_candidates[0][1]
            return candidates[0][1]
    except Exception:
        pass
    return fallback_url


class RiskControlError(Exception):
    """Risk control triggered (slide / rate limit)."""


def _check_submit(result: dict) -> str:
    """Validates submission result and returns conversation_id."""
    status = result.get("status")
    if status != 200:
        raise RiskControlError(f"Submission failed HTTP {status}: {json.dumps(result.get('events', []), ensure_ascii=False)[:300]}")

    for err in result.get("errors", []):
        if "710022004" in err or "slide" in err or "shark" in err:
            raise RiskControlError(f"Captcha risk control triggered: {err[:300]}")
        if "710022002" in err:
            raise RiskControlError(f"Rate limited: {err[:300]}")
        raise Exception(f"Submission returned error event: {err[:300]}")

    conv_id = result.get("convId") or ""
    if not conv_id:
        raise Exception(
            "Video accepted but no conversation_id returned: "
            + json.dumps(result.get("events", []), ensure_ascii=False)[:300]
        )
    return conv_id


async def _download(url: str, account: str) -> Path:
    """Downloads video to DOWNLOAD_DIR and returns local path."""
    dl_dir = Path(config.DOWNLOAD_DIR)
    dl_dir.mkdir(parents=True, exist_ok=True)
    fname = dl_dir / f"{account}_{time.strftime('%Y%m%d_%H%M%S')}.mp4"
    timeout = aiohttp.ClientTimeout(total=300)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url, proxy=config.PROXY or None) as resp:
            resp.raise_for_status()
            with open(fname, "wb") as f:
                async for chunk in resp.content.iter_chunked(1 << 16):
                    f.write(chunk)
    return fname


async def generate_video(account: str, prompt: str, ratio: str = "9:16",
                         duration: int = 5, timeout: int = None) -> dict:
    """Complete generation flow: submit -> poll -> download.

    Returns {"video_url": cdn_url, "local_path": local_file, "conversation_id": ...}
    Exceptions: RiskControlError, CreditError, TimeoutError, FileNotFoundError
    """
    timeout = timeout or config.VIDEO_TIMEOUT
    async with async_playwright() as p:
        context = await launch_account_context(p, account)
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto("https://www.dola.com/chat", timeout=60000, wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)

            cookies = await context.cookies("https://www.dola.com")
            sessionid = cookie_value(cookies, "sessionid")
            if not sessionid:
                raise CreditError(f"{account} session expired (no sessionid), please re-login {account}")
            ms_token = cookie_value(cookies, "msToken")
            fp = cookie_value(cookies, "s_v_web_id")

            print(f"[{account}] Submitting video generation: {prompt[:40]} | {ratio} | {duration}s", flush=True)
            # Evaluate with wait_for timeout
            result = await asyncio.wait_for(page.evaluate(
                SUBMIT_JS,
                {"prompt": prompt, "ratio": ratio, "duration": duration,
                 "msToken": ms_token, "fp": fp},
            ), timeout=180)
            conv_id = _check_submit(result)
            print(f"[{account}] Accepted conversation_id={conv_id}, polling for video...", flush=True)

            start = time.time()
            while time.time() - start < timeout:
                await asyncio.sleep(5)
                try:
                    poll = await asyncio.wait_for(page.evaluate(
                        POLL_JS,
                        {"conversationId": conv_id, "msToken": ms_token, "fp": fp},
                    ), timeout=30)
                except Exception as e:
                    print(f"[{account}] Polling exception (retrying): {e}", flush=True)
                    continue
                if not poll.get("ok"):
                    continue

                for text in poll.get("texts", []):
                    if CREDIT_FAIL_PATTERN.search(text):
                        raise CreditError(f"Insufficient quota: {text[:80]}")

                videos = poll.get("videos", [])
                if videos:
                    video_models = poll.get("videoModels", [])
                    url = extract_unwatermarked_url(
                        video_models[0] if video_models else "", videos[0]
                    )
                    print(f"[{account}] Video completed download_url={url[:100]}...", flush=True)
                    local = await _download(url, account)
                    print(f"[{account}] Downloaded {local} ({local.stat().st_size / 1e6:.1f} MB)", flush=True)
                    return {
                        "video_url": url,
                        "local_path": str(local),
                        "conversation_id": conv_id,
                        "account": account,
                    }
                print(f"[{account}] ...Generating ({int(time.time() - start)}s elapsed)", flush=True)

            raise TimeoutError(f"No video generated within {timeout}s (conversation_id={conv_id})")
        finally:
            await context.close()


async def _main():
    account = sys.argv[1] if len(sys.argv) > 1 else "acc1"
    prompt = sys.argv[2] if len(sys.argv) > 2 else "A cat chasing a butterfly on green grass"
    ratio = sys.argv[3] if len(sys.argv) > 3 else "9:16"
    duration = int(sys.argv[4]) if len(sys.argv) > 4 else 5

    try:
        result = await generate_video(account, prompt, ratio, duration)
    except (RiskControlError, CreditError, TimeoutError) as e:
        print(f"\nFailed: {e}")
        sys.exit(1)
    print("\n=== Result ===")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(_main())