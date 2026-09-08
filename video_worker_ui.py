"""Video generation worker v2: UI automation with OpenCV slider puzzle solver."""
import asyncio
import json
import random
import re
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import aiohttp
from patchright.async_api import async_playwright

from gap import find_gap_x

import config
from browser import cookie_value, launch_account_context
from dola_client import CREDIT_FAIL_PATTERN, CreditError
from video_worker import POLL_JS, RiskControlError, _download, extract_unwatermarked_url

# Daily limit pattern matching response text
DAILY_LIMIT_PATTERN = re.compile(
    r"動画生成の\s*1日あたりの上限|每日(?:视频|影片)?生成.*(?:上限|限额|额度)|"
    r"daily.*(?:limit|quota)|(?:limit|quota).*per\s*day",
    re.IGNORECASE,
)

# Content policy / minor safety rejection pattern
POLICY_REJECT_PATTERN = re.compile(
    r"cấm tạo nội dung|"
    r"hạn chế tạo nội dung|"
    r"không thể tạo nội dung theo yêu cầu|"
    r"không thể thực hiện yêu cầu tạo|"
    r"vi phạm chính sách|tiêu chuẩn cộng đồng|"
    r"コンテンツポリシー|利用規約|ガイドライン|ポリシー違反|未成年者?の保護|安全基準|"
    r"生成することができません|生成できません|お応えできません|"
    r"违规|内容安全|无法生成|社区准则|不符合规范|"
    r"content policy|safety guideline|violat|cannot generate|unable to generate|policy restriction",
    re.IGNORECASE,
)


class AccountLimitedError(Exception):
    """Account reached daily video generation limit."""


class CreditInsufficientError(Exception):
    """Insufficient points prior to generation."""


class ContentPolicyViolationError(Exception):
    """Prompt or reference image rejected by Dola content/safety policies."""


VIDEO_BTN = "text=動画を作成"          # Entry point button in ja-JP locale
CAPTCHA_FRAME_KEY = "bdcaptcha.html"   # Captcha verifycenter iframe


# Read-only balance pre-check from recent conversations
BALANCE_JS = r"""
async ({msToken, fp}) => {
  const params = new URLSearchParams({
    version_code: "20800", language: "ja", device_platform: "web",
    doubao_device_platform: "web", aid: "495671", real_aid: "495671",
    pkg_type: "release_version", pc_version: "3.32.62", doubao_pc_version: "3.32.62",
    region: "JP", sys_region: "JP", samantha_web: "1", web_platform: "browser",
    "use-olympus-account": "1", web_tab_id: crypto.randomUUID(),
  });
  if (msToken) params.set("msToken", msToken);
  if (fp) params.set("fp", fp);
  const headers = {
    "Content-Type": "application/json; encoding=utf-8",
    "agw-js-conv": "str", "Accept": "*/*",
  };
  const recent = await fetch("/im/chain/recent_conv?" + params.toString(), {
    method: "POST", headers,
    body: JSON.stringify({
      cmd: 3200,
      uplink_body: {pull_recent_conv_chain_uplink_body: {
        limit: 20, message_count_per_conv: 10, api_version: 1, conv_version: 0,
        direction: 3,
        option: {not_need_message: false, need_complete_conversation: true,
          need_coco_conversation: true, need_coco_bot: true,
          need_pc_pin_chain: true, pc_pin_query_type: 0},
      }},
      sequence_id: crypto.randomUUID(), channel: 2, version: "1",
    }), credentials: "include",
  });
  if (!recent.ok) return {ok: false, texts: []};
  const recentData = await recent.json();
  const body = recentData.downlink_body || {};
  const down = body.pull_recent_conv_chain_downlink_body || {};
  const cells = down.cells || [];
  const ids = cells.map(c => (c.conversation || {}).conversation_id || c.id)
    .filter(Boolean).slice(0, 10);
  if (!ids.length) return {ok: true, texts: []};

  const batch = await fetch("/im/chain/batch_single?" + params.toString(), {
    method: "POST", headers,
    body: JSON.stringify({
      cmd: 3101,
      uplink_body: {batch_pull_singe_chain_uplink_body: {
        conversation_type: 3, direction: 3, limit: 1,
        params: ids.map(conversation_id => ({conversation_id})),
        evaluate_ab_params: "", evaluate_common_params: "", ext: {},
      }},
      sequence_id: crypto.randomUUID(), channel: 2, version: "1",
    }), credentials: "include",
  });
  if (!batch.ok) return {ok: true, texts: []};
  const data = await batch.json();
  const texts = [];
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === "string") {
      if ((v.includes("ポイント") || v.includes("积分") || v.toLowerCase().includes("points")
        || v.includes("上限") || v.includes("limit")) && v.length < 1200 && !seen.has(v)) {
        seen.add(v); texts.push(v);
      }
      try {
        const t = v.trim();
        if (t.startsWith("{") || t.startsWith("[")) walk(JSON.parse(t));
      } catch (e) {}
      return;
    }
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    for (const x of Object.values(v)) walk(x);
  };
  walk(data);
  return {ok: true, texts: texts.slice(-80)};
}
""";


def find_captcha_frame(page):
    for f in page.frames:
        if CAPTCHA_FRAME_KEY in f.url:
            return f
    return None


async def _fetch_bytes(url: str) -> bytes:
    async with aiohttp.ClientSession() as s:
        async with s.get(url, proxy=config.PROXY or None) as r:
            return await r.read()



async def attach_reference_images(page, image_paths: list[str]) -> None:
    """Uploads reference images through Dola's '+' attachment button or native file input, and waits for TOS upload."""
    if not image_paths:
        return

    abs_paths = [str(Path(p).resolve()) for p in image_paths]
    expected = len(abs_paths)
    print(f"[upload] Attaching {expected} reference image(s): {abs_paths}", flush=True)

    events = []

    def on_response(response):
        url = response.url
        if "/alice/resource/prepare_upload" in url or "/upload/v1/" in url:
            events.append((response.status, url))

    page.on("response", on_response)
    try:
        assigned = False
        # Check if file input is already mounted in DOM
        file_input = page.locator('input[type="file"]').first
        if await file_input.count():
            try:
                await file_input.set_input_files(abs_paths)
                assigned = True
                print("[upload] Assigned files via pre-existing input[type='file'] ✓", flush=True)
            except Exception as e:
                print(f"  (Pre-existing input failed: {e})", flush=True)

        if not assigned:
            # Find the visible '+' button in composer to mount file input
            plus_btn = None
            for b in await page.locator("button").all():
                try:
                    if not await b.is_visible():
                        continue
                    path = await b.locator("path").first.get_attribute("d") if await b.locator("path").count() else ""
                    if path and "M12" in path and "2.25" in path:
                        plus_btn = b
                        break
                except Exception:
                    continue

            if plus_btn:
                # 1. Click plus button to trigger Dola's hidden file input mounting
                try:
                    await plus_btn.click(timeout=5000)
                    await page.wait_for_timeout(300)
                except Exception as e:
                    print(f"  (Plus button click: {e})", flush=True)

                # 2. Wait for input[type="file"] to be attached and set files directly
                try:
                    file_input = page.locator('input[type="file"]').first
                    await file_input.wait_for(state="attached", timeout=5000)
                    await file_input.set_input_files(abs_paths)
                    assigned = True
                    print("[upload] Assigned files via mounted input[type='file'] ✓", flush=True)
                except Exception as e:
                    print(f"  (Mounted input set_input_files: {e})", flush=True)

                # 3. Fallback to expect_file_chooser if direct mount didn't assign
                if not assigned:
                    try:
                        async with page.expect_file_chooser(timeout=5000) as fc_info:
                            await plus_btn.click(timeout=3000)
                        file_chooser = await fc_info.value
                        await file_chooser.set_files(abs_paths)
                        assigned = True
                        print("[upload] Assigned files via expect_file_chooser fallback ✓", flush=True)
                    except Exception as e:
                        print(f"  (Plus button file_chooser fallback: {e})", flush=True)

        if not assigned:
            raise RuntimeError("Could not find visible '+' button or input[type='file'] on Dola page to attach image")

        # Wait for TOS upload & thumbnail render
        deadline = time.time() + max(45, expected * 20)
        while time.time() < deadline:
            await page.wait_for_timeout(500)
            prepare_count = sum("/alice/resource/prepare_upload" in url and 200 <= status < 300
                                for status, url in events)
            tos_count = sum("/upload/v1/" in url and 200 <= status < 300
                            for status, url in events)
            has_preview = await page.evaluate(r"""() => {
                const text = document.body.innerText || '';
                const hasChipText = /mô\s*tả\s*hình\s*ảnh|describe\s*image|画像を説明/i.test(text);
                const composer = document.querySelector('textarea, [contenteditable="true"]')?.closest('div');
                const hasImg = !!composer?.parentElement?.querySelector('img');
                return hasChipText || hasImg;
            }""")
            if (prepare_count >= expected and tos_count >= expected) or has_preview:
                await page.wait_for_timeout(1000)
                print(f"[upload] Reference image attached successfully! (preview confirmed: {has_preview})", flush=True)
                return

        print("[upload] Warning: upload deadline reached, proceeding with prompt...", flush=True)
    finally:
        page.remove_listener("response", on_response)


def _gen_track(distance: float):
    """Generates humanized mouse drag trajectory."""
    steps = random.randint(45, 65)
    overshoot = random.uniform(3, 9)
    pts = []
    for i in range(1, steps + 1):
        t = i / steps
        s = 10 * t**3 - 15 * t**4 + 6 * t**5
        x = (distance + overshoot) * s
        y = random.uniform(-1.5, 1.5) if 0.1 < t < 0.95 else 0
        pts.append((x, y, random.randint(8, 22)))
    for i in range(1, random.randint(3, 5) + 1):
        pts.append((distance + overshoot * (1 - i / 5), random.uniform(-0.8, 0.8), random.randint(15, 30)))
    return pts


async def solve_slider(page, frame, attempt: int) -> bool:
    """Solves captcha slider notch within iframe and performs drag."""
    await frame.wait_for_selector("img", timeout=15000)
    await frame.evaluate("""async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 10000) {
            const imgs = [...document.images];
            if (imgs.length >= 2 && imgs.every(im => im.complete && im.naturalWidth > 0)) return;
            await new Promise(r => setTimeout(r, 200));
        }
        throw new Error("captcha images load timeout");
    }""")
    await page.wait_for_timeout(800)

    imgs = await frame.evaluate("""() => [...document.images].map(im => ({
        src: im.src, w: im.naturalWidth, h: im.naturalHeight,
        bw: im.getBoundingClientRect().width,
        left: im.getBoundingClientRect().left,
    }))""")
    bg = next((i for i in imgs if ".jpeg" in i["src"] or "-2." in i["src"]), None)
    piece = next((i for i in imgs if i is not bg and (".png" in i["src"] or "-1." in i["src"])), None)
    if not bg or not piece:
        print("  ✗ Captcha background or puzzle image not found", flush=True)
        return False

    bg_bytes = await _fetch_bytes(bg["src"])
    piece_bytes = await _fetch_bytes(piece["src"])
    Path("dbg_bg.jpg").write_bytes(bg_bytes)
    Path("dbg_piece.png").write_bytes(piece_bytes)

    gap_x, conf = find_gap_x(bg_bytes, piece_bytes)
    scale = bg["bw"] / bg["w"] if bg["w"] else 340 / 552
    distance = (gap_x - (piece["left"] - bg["left"]) / scale) * scale
    print(f"  [solve#{attempt}] gap_x={gap_x} conf={conf:.3f} scale={scale:.2f} distance={distance:.0f}px", flush=True)

    btn = frame.locator(".captcha-slider-btn")
    bb = await btn.bounding_box()
    if not bb:
        print("  ✗ Drag handle .captcha-slider-btn not found", flush=True)
        return False
    sx, sy = bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2
    await page.mouse.move(sx, sy)
    await page.wait_for_timeout(random.randint(150, 350))
    await page.mouse.down()
    await page.wait_for_timeout(random.randint(80, 180))
    for dx, dy, dt in _gen_track(distance):
        await page.mouse.move(sx + dx, sy + dy)
        await asyncio.sleep(dt / 1000)
    await page.wait_for_timeout(random.randint(120, 260))
    await page.mouse.up()

    for _ in range(10):
        await page.wait_for_timeout(700)
        if not find_captcha_frame(page):
            return True
    return False



_BALANCE_PATTERNS = (
    re.compile(r"(?:本日は|今日(?:还剩|剩余)?|今天).*?(\d+)\s*(?:ポイント|积分|points?)", re.I),
    re.compile(r"本日は残り\s*(\d+)", re.I),
    re.compile(r"(?:remaining|left)\s*[:：]?\s*(\d+)\s*(?:points?|credits?)", re.I),
    re.compile(r"(?:还剩|剩余|还有)\s*(\d+)\s*(?:积分|点)", re.I),
)



def _parse_balance_texts(texts: list[str]) -> tuple[int | None, bool, str]:
    for text in texts:
        if DAILY_LIMIT_PATTERN.search(text):
            return None, True, text
    for text in texts:
        for pattern in _BALANCE_PATTERNS:
            match = pattern.search(text)
            if match:
                return int(match.group(1)), False, text
    return None, False, ""


async def _preflight_balance(page, ms_token: str, fp: str, required: int) -> dict:
    """Reads known credit balance from chat history."""
    try:
        result = await asyncio.wait_for(page.evaluate(
            BALANCE_JS, {"msToken": ms_token, "fp": fp}), timeout=30)
        balance, daily_limited, source = _parse_balance_texts(result.get("texts", []))
        if daily_limited:
            raise AccountLimitedError(f"Account daily generation limit: {source[:120]}")
        if balance is not None and balance < required:
            raise CreditInsufficientError(
                f"Insufficient points: current {balance}, required {required} (source: {source[:120]})"
            )
        return {"balance": balance, "source": source}
    except (AccountLimitedError, CreditInsufficientError):
        raise
    except Exception as e:
        print(f"  Balance pre-check indeterminate (proceeding with submit): {str(e)[:120]}", flush=True)
        return {"balance": None, "source": ""}


def format_dola_prompt(prompt: str, ratio: str = "16:9", duration: int = 15, model_key: str = "seedance_v2.0") -> str:
    """Cleans and formats prompt with ratio, duration, model, and direct commands for Dola Pro Chatbot."""
    clean = str(prompt or "").strip()
    if not clean:
        return ""

    # Strip existing chatbot commands, duration, ratio, and model tokens to avoid duplication
    clean = re.sub(r"^(?:tạo\s*video|create\s*videos?)\s*:\s*", "", clean, flags=re.I)
    clean = re.sub(r",?\s*tạo\s*video\s*luôn\s*(?:ko|không)\s*hỏi\s*lại", "", clean, flags=re.I)
    clean = re.sub(r",?\s*gửi\s*dưới\s*dạng\s*human\s*artifact", "", clean, flags=re.I)
    clean = re.sub(r",?\s*(?:ko|không)\s*hỏi\s*lại", "", clean, flags=re.I)
    clean = re.sub(r",?\s*(?:thời\s*lượng|duration)\s*[:\s]*\d+\s*s?", "", clean, flags=re.I)
    clean = re.sub(r",?\s*(?:mô\s*hình|model|seedance)\s*[:\s]*[\w\.\s]+", "", clean, flags=re.I)
    clean = re.sub(r"(?:,\s*)?(?:tỉ\s*lệ|ratio)?\s*[:\s]*\b(16:9|9:16|1:1|4:3|21:9)\b", "", clean, flags=re.I)
    clean = re.sub(r"[,;\s]+$", "", clean).strip()

    clean_ratio = ratio if ratio and ratio.lower() != "none" else "16:9"
    clean_duration = int(duration) if duration else 15
    model_str = str(model_key or "").lower()
    model_label = "Seedance 2.5" if "2.5" in model_str or "25" in model_str else "Seedance 2.0"

    return f"{clean}, tỉ lệ {clean_ratio}, thời lượng {clean_duration}s, mô hình {model_label}, tạo video luôn không hỏi lại, gửi dưới dạng human artifact"


async def trigger_new_chat(page) -> bool:
    """Ensures a clean new chat session is active via shortcut and button click."""
    # 1. Keyboard shortcut
    try:
        await page.keyboard.press("Control+Shift+K")
        await page.wait_for_timeout(800)
    except Exception:
        pass

    # 2. Click button via DOM
    clicked = await page.evaluate(r"""() => {
        const candidates = Array.from(
            document.querySelectorAll('button, a, [role="button"], div[tabindex], span[role="button"]')
        );
        for (const el of candidates) {
            const text = (el.innerText || el.textContent || '').trim();
            const aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
            const blob = `${aria} ${text}`.toLowerCase();
            if (/(collapse|expand|toggle)\s*(sidebar|panel|nav)|thu\s*(gọn|sidebar)|đóng\s*sidebar|mở\s*sidebar/i.test(blob)) {
                continue;
            }
            if (/new\s*chat|cuộc\s*trò\s*chuyện\s*mới|đoạn\s*chat\s*mới|tạo\s*chat\s*mới|新しいチャット/i.test(blob)) {
                el.click();
                return true;
            }
        }
        const directLink = document.querySelector('a[href="/chat"], a[href="/chat/"]');
        if (directLink) {
            directLink.click();
            return true;
        }
        return false;
    }""")
    await page.wait_for_timeout(1200)
    return clicked


async def ensure_normal_chat_mode(page) -> bool:
    """Exits Video Skill mode if active, returning to normal chat mode."""
    exited = await page.evaluate(r"""() => {
        const exitBtn = document.querySelector('[class*="exit-skill"], .bg-g-exit-skill-btn-bg, [data-testid*="exit-skill"], [class*="exit-btn"]');
        if (exitBtn) {
            exitBtn.click();
            return true;
        }
        const chips = Array.from(document.querySelectorAll('button[data-component-type="skill-item"], button, [class*="chip"]'));
        for (const chip of chips) {
            const t = (chip.innerText || chip.textContent || '').trim();
            if (/create\s*videos?|tạo\s*videos?|動画を作成/i.test(t)) {
                const closeIcon = chip.querySelector('svg, [class*="close"], [class*="exit"]');
                if (closeIcon) {
                    closeIcon.click();
                    return true;
                }
            }
        }
        return false;
    }""")
    await page.wait_for_timeout(600)
    return exited


async def ensure_dola_model(page, is_pro: bool = True) -> bool:
    """Ensures Dola is in Pro (Seedance 2.5) or Fast (Seedance 2.0) mode."""
    try:
        model_btn = page.locator('button:has-text("高速"), button:has-text("Fast"), button:has-text("Nhanh"), button:has-text("Pro"), button:has-text("プロ")').first
        if not await model_btn.count():
            return False

        cur_text = (await model_btn.text_content() or '').strip()
        is_current_pro = "pro" in cur_text.lower() or "プロ" in cur_text

        if is_pro == is_current_pro:
            print(f"[mode] Dola model already in desired mode: '{cur_text}'", flush=True)
            return True

        print(f"[mode] Switching Dola model from '{cur_text}' to {'Pro' if is_pro else 'Fast'}...", flush=True)
        await model_btn.click(timeout=5000)
        await page.wait_for_timeout(600)

        if is_pro:
            target_opt = page.locator('div:has-text("プロ"), div:has-text("Pro"), [role="menuitem"]:has-text("Pro"), [role="menuitem"]:has-text("プロ")').last
        else:
            target_opt = page.locator('div:has-text("高速"), div:has-text("Fast"), div:has-text("Nhanh"), [role="menuitem"]:has-text("Fast"), [role="menuitem"]:has-text("Nhanh")').first

        if await target_opt.count():
            await target_opt.click(timeout=5000)
            await page.wait_for_timeout(800)
            new_text = (await model_btn.text_content() or '').strip()
            print(f"[mode] Dola model successfully switched to: '{new_text}' ✓", flush=True)
            return True

        await page.keyboard.press("Escape")
    except Exception as e:
        print(f"[mode] Failed to switch Dola model: {e}", flush=True)
    return False


async def poll_conversation(account: str, page, context, conversation_id: str,
                            timeout: int, on_poll=None, on_balance=None,
                            existing_videos: set | None = None) -> dict:
    """Polls accepted conversation for video completion."""
    cookies = await context.cookies("https://www.dola.com")
    ms_token, fp = cookie_value(cookies, "msToken"), cookie_value(cookies, "s_v_web_id")
    start = time.time()
    last_callback = 0.0
    last_screenshot = 0.0
    known_old = existing_videos or set()
    while time.time() - start < timeout:
        await asyncio.sleep(5)
        now = time.time()

        # Periodically capture current Dola chat screen for monitoring
        if now - last_screenshot >= 15:
            try:
                Path("scratch").mkdir(exist_ok=True)
                await page.screenshot(path="scratch/current_dola_chat.png")
                last_screenshot = now
            except Exception:
                pass

        try:
            poll = await asyncio.wait_for(page.evaluate(
                POLL_JS, {"conversationId": conversation_id, "msToken": ms_token, "fp": fp}), timeout=30)
        except Exception as e:
            print(f"  Polling exception: {e}", flush=True)
            continue

        if on_poll and now - last_callback >= 30:
            on_poll(now)
            last_callback = now

        for text in poll.get("texts", []):
            balance, _, source = _parse_balance_texts([text])
            if balance is not None and on_balance:
                on_balance(balance, source)
            if DAILY_LIMIT_PATTERN.search(text):
                raise AccountLimitedError(f"Account daily limit reached: {text[:120]}")
            if CREDIT_FAIL_PATTERN.search(text):
                raise CreditError(f"Insufficient quota: {text[:80]}")
            if POLICY_REJECT_PATTERN.search(text):
                try:
                    Path("scratch").mkdir(exist_ok=True)
                    await page.screenshot(path="scratch/current_dola_chat.png")
                except Exception:
                    pass
                print(f"[{account}] Content rejected by Dola policy: {text.strip()[:180]}", flush=True)
                raise ContentPolicyViolationError(f"Dola từ chối nội dung: {text.strip()[:180]}")

        # Fallback check on page DOM for safety warnings
        try:
            dom_texts = await page.locator(".error, .warning, [class*='error'], [class*='warning'], [class*='message']").all_text_contents()
            for dt in dom_texts:
                if POLICY_REJECT_PATTERN.search(dt):
                    try:
                        Path("scratch").mkdir(exist_ok=True)
                        await page.screenshot(path="scratch/current_dola_chat.png")
                    except Exception:
                        pass
                    print(f"[{account}] Content rejected by Dola (DOM): {dt.strip()[:180]}", flush=True)
                    raise ContentPolicyViolationError(f"Dola từ chối nội dung: {dt.strip()[:180]}")
        except ContentPolicyViolationError:
            raise
        except Exception:
            pass

        if poll.get("videos"):
            videos = poll["videos"]
            video_models = poll.get("videoModels", [])
            # Filter out any video that was already present in this conversation before prompt submission
            new_candidates = []
            for i, v_url in enumerate(videos):
                if v_url not in known_old:
                    vm = video_models[i] if i < len(video_models) else ""
                    new_candidates.append((v_url, vm))

            if new_candidates:
                v_url, vm = new_candidates[0]
                url = extract_unwatermarked_url(vm, v_url)
                print(f"[{account}] Completed! Downloading (unwatermarked priority)...", flush=True)
                local = await _download(url, account)
                print(f"[{account}] Downloaded {local} ({local.stat().st_size / 1e6:.1f} MB)", flush=True)
                try:
                    Path("scratch").mkdir(exist_ok=True)
                    await page.screenshot(path="scratch/current_dola_chat.png")
                except Exception:
                    pass
                return {"video_url": url, "local_path": str(local),
                        "conversation_id": conversation_id, "account": account}
        print(f"  ...Generating ({int(time.time() - start)}s)", flush=True)
    raise TimeoutError(f"No video generated within {timeout}s (conversation_id={conversation_id})")



async def resume_video(account: str, conversation_id: str, timeout: int,
                       on_poll=None, on_balance=None) -> dict:
    """Recovers accepted session after server restart without re-sending prompt."""
    async with async_playwright() as p:
        context = await launch_account_context(p, account, headless=False, use_extension=True)
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(f"https://www.dola.com/chat/{conversation_id}",
                            timeout=60000, wait_until="domcontentloaded")
            await page.wait_for_timeout(5000)
            return await poll_conversation(account, page, context, conversation_id, timeout, on_poll, on_balance)
        finally:
            await context.close()


async def generate_video(account: str, prompt: str, ratio: str = None,
                         duration: int = None, timeout: int = None,
                         model: str = "seedance_v2.0", use_extension: bool = True,
                         on_conversation_id=None, on_poll=None, on_balance=None,
                         reference_image_paths: list[str] | None = None) -> dict:
    """Full generation flow via UI automation."""
    timeout = timeout or config.VIDEO_TIMEOUT
    model_key = model.lower().replace("-", "_")
    if model_key in ("seedance_2.5", "seedance_v2.5", "seedance_25", "seedance_v25"):
        model_key = "seedance_v2.5"
    elif model_key in ("seedance_2.0", "seedance_v2.0", "seedance_20", "seedance_v20"):
        model_key = "seedance_v2.0"
    else:
        raise ValueError(f"Unsupported model: {model} (supported: seedance-2.0 / seedance-2.5)")
    if duration is not None and duration not in (10, 15, 30):
        raise ValueError("Dola supports durations of 10s, 15s, and 30s via extension")
    if duration == 30 and not use_extension:
        raise ValueError("30s generation requires Dola30 extension enabled")
    # 30s videos require extended generation timeout
    if duration == 30:
        timeout = max(timeout, 1800)
    if reference_image_paths:
        timeout = max(timeout, config.REFERENCE_VIDEO_TIMEOUT)
    async with async_playwright() as p:
        context = await launch_account_context(
            p, account, headless=False if use_extension else None,
            use_extension=use_extension)
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto("https://www.dola.com/chat", timeout=60000, wait_until="domcontentloaded")
            await page.wait_for_timeout(5000)
            cookies = await context.cookies("https://www.dola.com")
            ms_token, fp = cookie_value(cookies, "msToken"), cookie_value(cookies, "s_v_web_id")
            await _preflight_balance(page, ms_token, fp, config.VIDEO_REQUIRED_POINTS)

            # ---- Check pre-existing conversation and video state ----
            old_conv_id = None
            current_tail = page.url.split("?")[0].rstrip("/").split("/")[-1]
            if current_tail.isdigit():
                old_conv_id = current_tail

            existing_videos = set()
            try:
                if old_conv_id:
                    poll_old = await page.evaluate(
                        POLL_JS, {"conversationId": old_conv_id, "msToken": ms_token, "fp": fp}
                    )
                    for v in poll_old.get("videos", []):
                        existing_videos.add(v)
            except Exception:
                pass
            for v_el in await page.locator("video").all():
                try:
                    src = await v_el.get_attribute("src")
                    if src:
                        existing_videos.add(src)
                except Exception:
                    pass

            # ---- Always start fresh chat for each generation ----
            print(f"[{account}] Opening new chat (old_conv={old_conv_id})...", flush=True)
            await trigger_new_chat(page)
            await page.wait_for_timeout(1000)

            # ---- Reference Images ----
            if reference_image_paths:
                await attach_reference_images(page, reference_image_paths)

            # ---- Submission Mode ----
            if duration == 30:
                # 30s credit video mode via Action Bar dropdown (requires Dola30 extension)
                await page.click(VIDEO_BTN)
                await page.wait_for_timeout(1500)
                try:
                    dur_btn = page.locator('[data-input-engine-actionbar-control-key="video-duration"]').first
                    if await dur_btn.count() and await dur_btn.is_visible():
                        cur_text = (await dur_btn.text_content() or "").strip()
                        if "30s" not in cur_text.lower():
                            await dur_btn.click(timeout=3000)
                            await page.wait_for_timeout(500)
                            await page.locator('[role="menuitem"]:has-text("30s"), [role="option"]:has-text("30s"), text="30s"').last.click(timeout=3000)
                except Exception as e:
                    print(f"  (Failed to select 30s: {str(e)[:80]})", flush=True)
                if ratio:
                    try:
                        await page.click("text=比率", timeout=3000)
                        await page.wait_for_timeout(500)
                        await page.click(f"text={ratio}", timeout=3000)
                    except Exception as e:
                        print(f"  (Failed to set ratio: {str(e)[:80]})", flush=True)
                prompt_to_send = prompt
            else:
                # 10s / 15s Normal Pro Chat mode with prompt tail parameter injection
                await ensure_normal_chat_mode(page)
                is_pro = "2.0" not in model_key or "2.5" in model_key or "pro" in model_key
                await ensure_dola_model(page, is_pro=is_pro)
                prompt_to_send = format_dola_prompt(prompt, ratio=ratio or "16:9", duration=duration or 15, model_key=model_key)

            # Type and submit prompt
            box = await page.query_selector("textarea") or await page.query_selector('[contenteditable="true"]')
            if not box:
                raise RuntimeError("Dola input box not found")
            await box.click()
            await page.keyboard.type(prompt_to_send, delay=25)
            await page.wait_for_timeout(800)

            # Click official Dola send button (#flow-end-msg-send) or fallback to Enter
            send_btn = page.locator("button#flow-end-msg-send, button:has-text('Send'), button[aria-label*='Send']").first
            if await send_btn.count() and await send_btn.is_visible():
                await send_btn.click(timeout=5000)
                print(f"[{account}] Clicked official send button (#flow-end-msg-send)", flush=True)
            else:
                await page.keyboard.press("Enter")
                print(f"[{account}] Sent prompt via Enter key", flush=True)

            try:
                print(f"[{account}] UI submitted prompt: {prompt_to_send[:60]}...", flush=True)
            except Exception:
                pass

            # ---- Captcha Solver (up to 3 attempts) ----
            solved_or_absent = False
            for attempt in range(1, 4):
                frame = None
                for _ in range(20):
                    await page.wait_for_timeout(1000)
                    frame = find_captcha_frame(page)
                    if frame:
                        break
                if not frame:
                    solved_or_absent = True
                    break
                print(f"[{account}] Captcha detected, attempt {attempt} solving...", flush=True)
                if await solve_slider(page, frame, attempt):
                    print(f"[{account}] Captcha passed ✓", flush=True)
                    await page.wait_for_timeout(3000)  # Wait for frontend auto-retry
                    solved_or_absent = True
                    break
                print(f"[{account}] Captcha not passed, retrying...", flush=True)
            if not solved_or_absent:
                await page.screenshot(path="solve_fail.png")
                raise RiskControlError("Captcha failed 3 times")

            # ---- Wait for real NEW conversation_id ----
            conv_id = ""
            for _ in range(45):
                await page.wait_for_timeout(1000)
                tail = page.url.split("?")[0].rstrip("/").split("/")[-1]
                if tail.isdigit() and tail != old_conv_id:
                    conv_id = tail
                    break
            if not conv_id:
                tail = page.url.split("?")[0].rstrip("/").split("/")[-1]
                if tail.isdigit():
                    conv_id = tail
                else:
                    await page.screenshot(path="no_conv.png")
                    raise TimeoutError("conversation_id not acquired within 45s")
            print(f"[{account}] conversation_id={conv_id}, polling for new video (ignoring {len(existing_videos)} existing)...", flush=True)

            deadline = time.time() + timeout
            if on_conversation_id:
                on_conversation_id(account, conv_id, deadline)
            return await poll_conversation(account, page, context, conv_id, timeout, on_poll, on_balance, existing_videos=existing_videos)
        finally:
            await context.close()


async def _main():
    account = sys.argv[1] if len(sys.argv) > 1 else "acc1"
    prompt = sys.argv[2] if len(sys.argv) > 2 else "An orange cat napping on a sunny windowsill"
    ratio = sys.argv[3] if len(sys.argv) > 3 else None
    duration = int(sys.argv[4]) if len(sys.argv) > 4 else None
    model = sys.argv[5] if len(sys.argv) > 5 else "seedance_v2.0"
    result = await generate_video(account, prompt, ratio, duration, model=model)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except Exception:
        import traceback
        traceback.print_exc()