import json
import os
import sys
import time
import uuid

CONFIG_PATH = os.environ["GRAPHITI_FAKE_CONFIG"]
RECORD_PATH = os.environ["GRAPHITI_FAKE_RECORD"]
GATE_DIR = os.environ["GRAPHITI_FAKE_DIR"]

with open(CONFIG_PATH, "r", encoding="utf-8") as config_file:
    CONFIG = json.load(config_file)

sequence = 0


def record(phase, method, params, rpc_id):
    global sequence
    sequence += 1
    entry = {
        "phase": phase,
        "seq": sequence,
        "rpc_id": rpc_id,
        "method": method,
        "params": params,
        "at": time.time(),
    }
    with open(RECORD_PATH, "a", encoding="utf-8") as record_file:
        record_file.write(json.dumps(entry, ensure_ascii=False) + "\n")
        record_file.flush()


def wait_gate(gate):
    started_path = os.path.join(GATE_DIR, gate + ".started")
    release_path = os.path.join(GATE_DIR, gate + ".release")
    with open(started_path, "a", encoding="utf-8"):
        pass
    while not os.path.exists(release_path):
        time.sleep(0.01)


def apply_behavior(method, params, rpc_id):
    errors = CONFIG.get("errors", {})
    if method in errors:
        error = errors[method]
        return {"error": {"code": error.get("code", -32000), "message": error["message"]}}

    gate = CONFIG.get("gates", {}).get(method)
    if gate:
        wait_gate(gate)

    behavior = CONFIG.get(method, {})
    delay_ms = behavior.get("delay_ms", 0)
    if delay_ms:
        time.sleep(delay_ms / 1000)

    if method == "search":
        facts = behavior.get("facts", [])
        results = []
        for index, fact in enumerate(facts):
            results.append({
                "uuid": fact.get("uuid", "edge-%d" % index),
                "name": fact.get("name", "FACT"),
                "fact": fact["fact"],
                "source_node_uuid": fact.get("source_node_uuid"),
                "target_node_uuid": fact.get("target_node_uuid"),
                "group_id": params.get("group_id", ""),
                "created_at": fact.get("created_at"),
                "valid_at": fact.get("valid_at"),
                "invalid_at": fact.get("invalid_at"),
                "expired_at": fact.get("expired_at"),
                "attributes": fact.get("attributes", {}),
            })
        return {"result": {"results": results, "count": len(results)}}

    if method == "search_nodes":
        nodes = behavior.get("nodes", [])
        mapped = []
        for index, node in enumerate(nodes):
            mapped.append({
                "uuid": node.get("uuid", "node-%d" % index),
                "name": node["name"],
                "summary": node.get("summary"),
                "group_id": params.get("group_id"),
                "created_at": node.get("created_at"),
            })
        return {"result": {"nodes": mapped, "count": len(mapped)}}

    if method == "add_episode":
        return {"result": {"status": "ok", "episode_uuid": str(uuid.uuid4())}}

    return {"result": {}}


def respond(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    rpc_id = request.get("id")
    method = request.get("method")
    params = request.get("params", {})
    record("start", method, params, rpc_id)

    if method == "initialize":
        respond({"jsonrpc": "2.0", "id": rpc_id, "result": {"status": "ok"}})
        record("end", method, params, rpc_id)
        continue

    if method == "shutdown":
        respond({"jsonrpc": "2.0", "id": rpc_id, "result": {"status": "ok"}})
        record("end", method, params, rpc_id)
        sys.exit(0)

    if method not in ("search", "search_nodes", "add_episode"):
        respond({
            "jsonrpc": "2.0",
            "id": rpc_id,
            "error": {"code": -32601, "message": "Method not found: %s" % method},
        })
        record("end", method, params, rpc_id)
        continue

    outcome = apply_behavior(method, params, rpc_id)
    if "error" in outcome:
        respond({"jsonrpc": "2.0", "id": rpc_id, "error": outcome["error"]})
    else:
        respond({"jsonrpc": "2.0", "id": rpc_id, "result": outcome["result"]})
    record("end", method, params, rpc_id)
