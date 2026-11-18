"""Read one DSH v4 session. Report direct tool receipts without page or screenshot content."""
import argparse
import contextlib
import io
import json
import pathlib
import re
import sys


@contextlib.contextmanager
def open_session(path):
    with contextlib.ExitStack() as stack:
        raw = stack.enter_context(path.open("rb"))
        if path.suffix == ".zstd":
            try:
                from compression import zstd
                raw = stack.enter_context(zstd.open(raw, "rb"))
            except ImportError:
                import zstandard
                raw = stack.enter_context(zstandard.ZstdDecompressor().stream_reader(raw))
        yield stack.enter_context(io.TextIOWrapper(raw, encoding="utf-8"))


def inspect(lines):
    header = json.loads(next(lines))
    if header.get("type") != "session" or header.get("version") != 4 or not header.get("id"):
        raise ValueError("Expected a DSH v4 session header")
    records, waiting, shots, latest, checks = [], {}, {}, {}, {}
    last_shot = None
    last_seq = -1
    for line in lines:
        event = json.loads(line)
        seq, kind, data = event["seq"], event["type"], event["data"]
        if seq != last_seq + 1:
            raise ValueError("Incomplete or unordered session history")
        last_seq = seq
        if kind == "step/start":
            for item in waiting.values():
                item["newStepsDuringWait"] += 1
        elif kind == "tool/call":
            name, call = data["name"], data["callId"]
            for item in waiting.values():
                item["directCallsDuringWait"].append(name)
            if name == "computer_shot":
                shots[call] = seq
            if name not in ("bsk_tabs", "bsk_assist"):
                continue
            args = data["arguments"]
            if isinstance(args, str):
                args = json.loads(args)
            session = args.get("session")
            if name == "bsk_tabs" and args.get("action") == "borrow":
                item = dict(browserSkillSession=session, tabId=args.get("tabId"), callSeq=seq,
                            startedAtMs=event["time"], outcome="result-unobserved", lastDirectShot=last_shot,
                            newStepsDuringWait=0, directCallsDuringWait=[])
                records.append(item)
                waiting[call] = item
                if session:
                    latest[session] = item
            if name == "bsk_assist" and args.get("action") == "dialog-status" and session in latest:
                checks[call] = latest[session]
        elif kind == "tool/result":
            message = data["message"]
            call = message["toolCallId"]
            if call in shots:
                start = shots.pop(call)
                parts = message.get("content", [])
                has_image = any(p.get("type") == "image" for p in parts)
                for part in parts:
                    if part.get("type") != "text":
                        continue
                    try:
                        artifact = json.loads(part.get("text", ""))
                    except ValueError:
                        continue
                    if isinstance(artifact, dict) and isinstance(artifact.get("path"), str) and artifact["path"]:
                        has_image = True
                if not message.get("isError") and has_image:
                    last_shot = dict(callSeq=start, resultSeq=seq, returnedAtMs=event["time"])
            item, check = waiting.pop(call, None), checks.pop(call, None)
            if item is None and check is None:
                continue
            receipt = "\n".join(c["text"] for c in message["content"] if c.get("type") == "text")
            if item is not None:
                item.update(resultSeq=seq, returnedAtMs=event["time"], elapsedMs=event["time"]-item["startedAtMs"])
                match = re.fullmatch(r"\[session ([^\]\s]+)\] borrowed tab (\d+) from window \d+ into Agent Window \d+", receipt)
                if message.get("isError"):
                    item["outcome"] = "error"
                elif match and item["browserSkillSession"] in (None, match[1]) and int(match[2]) == item["tabId"]:
                    item.update(outcome="borrowed", approver="absent-from-receipt")
                else:
                    item["outcome"] = "unrecognized-receipt"
            if check and check.get("resultSeq", seq) < seq and not message.get("isError") and "firstLaterJsDialogStatus" not in check:
                try:
                    status = json.loads(receipt)
                except ValueError:
                    continue
                if isinstance(status, dict) and status.get("session_id") == check["browserSkillSession"] and isinstance(status.get("dialogs"), list):
                    check["firstLaterJsDialogStatus"] = dict(seq=seq, afterResultMs=event["time"]-check["returnedAtMs"],
                        count=len(status["dialogs"]), scope="page-js-dialogs")
    return dict(sessionId=header["id"], throughSeq=last_seq, borrows=records)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=pathlib.Path)
    args = parser.parse_args()
    try:
        with open_session(args.session) as lines:
            print(json.dumps(inspect(iter(lines)), indent=2))
    except (ValueError, KeyError, OSError, ImportError, StopIteration) as error:
        sys.exit(f"Could not read the session: {error}")
