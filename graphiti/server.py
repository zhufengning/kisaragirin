"""Graphiti stdio JSON-RPC server.

Communicates with the Node.js bot over stdin/stdout using JSON-RPC 2.0.
Each request is a single JSON line on stdin; each response is a single JSON line on stdout.

Methods:
    initialize   — connect to Neo4j, build indices
    add_episodes — batch-add chat messages as episodes
    search       — semantic search for memories
    get_edges    — list edges for a group (with pagination)
    get_edge     — get a single edge by uuid
    delete_edge  — delete a single edge by uuid
    delete_group — delete all data for a group
    shutdown     — graceful shutdown
"""

from __future__ import annotations

import asyncio
import json
import sys
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from neo4j.time import DateTime as Neo4jDateTime

from graphiti_core import Graphiti
from graphiti_core.nodes import EpisodeType
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_line() -> str | None:
    """Read a single line from stdin. Returns None on EOF."""
    line = sys.stdin.readline()
    if not line:
        return None
    return line.rstrip("\n")


class _JsonEncoder(json.JSONEncoder):
    """Handle Neo4j temporal types and other non-standard objects."""
    def default(self, o: Any) -> Any:
        if isinstance(o, Neo4jDateTime):
            return o.isoformat()
        if hasattr(o, 'isoformat'):
            return o.isoformat()
        if hasattr(o, '__str__'):
            return str(o)
        return super().default(o)


def _write_response(response: dict[str, Any]) -> None:
    """Write a JSON-RPC response to stdout."""
    sys.stdout.write(json.dumps(response, ensure_ascii=False, cls=_JsonEncoder) + "\n")
    sys.stdout.flush()


def _ok(id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id, "result": result}


def _err(id: Any, code: int, message: str, data: Any = None) -> dict[str, Any]:
    resp: dict[str, Any] = {"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}
    if data is not None:
        resp["error"]["data"] = data
    return resp


def _serialize_edge(edge: Any) -> dict[str, Any]:
    """Serialize an EntityEdge to a JSON-friendly dict."""
    return {
        "uuid": str(edge.uuid) if edge.uuid else None,
        "name": edge.name,
        "fact": edge.fact,
        "source_node_uuid": str(edge.source_node_uuid) if edge.source_node_uuid else None,
        "target_node_uuid": str(edge.target_node_uuid) if edge.target_node_uuid else None,
        "group_id": edge.group_id,
        "created_at": edge.created_at.isoformat() if edge.created_at else None,
        "valid_at": edge.valid_at.isoformat() if edge.valid_at else None,
        "invalid_at": edge.invalid_at.isoformat() if edge.invalid_at else None,
        "expired_at": edge.expired_at.isoformat() if edge.expired_at else None,
        "attributes": edge.attributes if edge.attributes else {},
    }


# ---------------------------------------------------------------------------
# Server state
# ---------------------------------------------------------------------------

@dataclass
class ServerState:
    graphiti: Graphiti | None = None
    initialized: bool = False
    config: dict[str, Any] = field(default_factory=dict)


state = ServerState()


# ---------------------------------------------------------------------------
# Method handlers
# ---------------------------------------------------------------------------

async def handle_initialize(params: dict[str, Any]) -> Any:
    """Initialize Graphiti connection and build indices."""
    neo4j_uri = params.get("neo4j_uri", "bolt://localhost:7687")
    neo4j_user = params.get("neo4j_user", "neo4j")
    neo4j_password = params.get("neo4j_password", "password")

    # LLM config
    llm_cfg = params.get("llm", {})
    llm_config = LLMConfig(
        api_key=llm_cfg.get("api_key", ""),
        model=llm_cfg.get("model", "gpt-4o-mini"),
        small_model=llm_cfg.get("small_model", llm_cfg.get("model", "gpt-4o-mini")),
        base_url=llm_cfg.get("base_url"),
        temperature=llm_cfg.get("temperature", 0),
        max_tokens=llm_cfg.get("max_tokens", 8192),
    )
    llm_client = OpenAIGenericClient(config=llm_config)

    # Embedder config
    emb_cfg = params.get("embedder", {})
    embedder = OpenAIEmbedder(
        config=OpenAIEmbedderConfig(
            api_key=emb_cfg.get("api_key", ""),
            embedding_model=emb_cfg.get("model", "text-embedding-3-small"),
            embedding_dim=emb_cfg.get("dimension", 1536),
            base_url=emb_cfg.get("base_url"),
        )
    )

    # Reranker (cross-encoder) config
    reranker_cfg = params.get("reranker", {})
    cross_encoder = None
    if reranker_cfg:
        reranker_llm_config = LLMConfig(
            api_key=reranker_cfg.get("api_key", ""),
            base_url=reranker_cfg.get("base_url"),
            model=reranker_cfg.get("model"),
        )
        cross_encoder = OpenAIRerankerClient(config=reranker_llm_config)

    graphiti_kwargs: dict[str, Any] = {
        "uri": neo4j_uri,
        "user": neo4j_user,
        "password": neo4j_password,
        "llm_client": llm_client,
        "embedder": embedder,
    }
    if cross_encoder is not None:
        graphiti_kwargs["cross_encoder"] = cross_encoder

    state.graphiti = Graphiti(**graphiti_kwargs)
    await state.graphiti.build_indices_and_constraints()
    state.initialized = True
    state.config = params

    return {"status": "ok"}


async def handle_add_episode(params: dict[str, Any]) -> Any:
    """Add a single episode to Graphiti."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    group_id: str = params["group_id"]
    name: str = params["name"]
    content: str = params["content"]
    source_description: str = params.get("source_description", "")
    reference_time_raw = params.get("reference_time")

    if isinstance(reference_time_raw, str):
        ref_dt = datetime.fromisoformat(reference_time_raw)
    elif isinstance(reference_time_raw, (int, float)):
        ref_dt = datetime.fromtimestamp(reference_time_raw, tz=timezone.utc)
    else:
        ref_dt = datetime.now(timezone.utc)

    result = await state.graphiti.add_episode(
        name=name,
        episode_body=content,
        source_description=source_description,
        reference_time=ref_dt,
        source=EpisodeType.json,
        group_id=group_id,
    )

    return {"status": "ok", "episode_uuid": getattr(result, "episode_uuid", None)}


async def handle_search(params: dict[str, Any]) -> Any:
    """Search for memories."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    query: str = params["query"]
    group_id: str = params["group_id"]
    num_results: int = params.get("num_results", 10)

    edges = await state.graphiti.search(
        query=query,
        group_ids=[group_id],
        num_results=num_results,
    )

    return {
        "results": [_serialize_edge(e) for e in edges],
        "count": len(edges),
    }


async def handle_get_edges(params: dict[str, Any]) -> Any:
    """List edges for a group (paginated)."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    group_id: str = params["group_id"]
    limit: int = params.get("limit", 50)
    offset: int = params.get("offset", 0)

    driver = state.graphiti.driver

    query = """
        MATCH (n)-[r]->(m)
        WHERE r.group_id = $group_id
        RETURN r, n.uuid AS source_uuid, m.uuid AS target_uuid
        ORDER BY r.created_at DESC
        SKIP $offset
        LIMIT $limit
    """
    records, _, _ = await driver.execute_query(
        query,
        group_id=group_id,
        offset=offset,
        limit=limit,
    )

    edges = []
    for record in records:
        r = record["r"]
        edges.append({
            "uuid": r.get("uuid"),
            "name": r.get("name"),
            "fact": r.get("fact"),
            "group_id": r.get("group_id"),
            "created_at": r.get("created_at"),
            "valid_at": r.get("valid_at"),
            "invalid_at": r.get("invalid_at"),
            "expired_at": r.get("expired_at"),
            "source_node_uuid": record["source_uuid"],
            "target_node_uuid": record["target_uuid"],
        })

    # Get total count
    count_query = """
        MATCH (n)-[r]->(m)
        WHERE r.group_id = $group_id
        RETURN count(r) AS total
    """
    count_records, _, _ = await driver.execute_query(count_query, group_id=group_id)
    total = count_records[0]["total"] if count_records else 0

    return {"edges": edges, "total": total, "offset": offset, "limit": limit}


async def handle_get_edge(params: dict[str, Any]) -> Any:
    """Get a single edge by uuid."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    edge_uuid: str = params["uuid"]

    driver = state.graphiti.driver
    query = """
        MATCH (n)-[r]->(m)
        WHERE r.uuid = $uuid
        RETURN r, n.uuid AS source_uuid, m.uuid AS target_uuid
    """
    records, _, _ = await driver.execute_query(query, uuid=edge_uuid)

    if not records:
        return None

    r = records[0]["r"]
    return {
        "uuid": r.get("uuid"),
        "name": r.get("name"),
        "fact": r.get("fact"),
        "group_id": r.get("group_id"),
        "created_at": r.get("created_at"),
        "valid_at": r.get("valid_at"),
        "invalid_at": r.get("invalid_at"),
        "expired_at": r.get("expired_at"),
        "source_node_uuid": records[0]["source_uuid"],
        "target_node_uuid": records[0]["target_uuid"],
    }


async def handle_delete_edge(params: dict[str, Any]) -> Any:
    """Delete a single edge by uuid."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    edge_uuid: str = params["uuid"]
    driver = state.graphiti.driver

    query = """
        MATCH ()-[r]->()
        WHERE r.uuid = $uuid
        DELETE r
    """
    await driver.execute_query(query, uuid=edge_uuid)
    return {"deleted": True}


async def handle_delete_group(params: dict[str, Any]) -> Any:
    """Delete all data for a group."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    group_id: str = params["group_id"]
    driver = state.graphiti.driver

    for label in ("Entity", "Episodic", "Community"):
        query = f"""
            MATCH (n:{label})
            WHERE n.group_id = $group_id
            DETACH DELETE n
        """
        await driver.execute_query(query, group_id=group_id)

    return {"deleted": True}


async def handle_shutdown(_params: dict[str, Any]) -> Any:
    """Graceful shutdown."""
    if state.graphiti is not None:
        await state.graphiti.close()
        state.graphiti = None
    state.initialized = False
    return {"status": "shutting_down"}


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

METHODS: dict[str, Any] = {
    "initialize": handle_initialize,
    "add_episode": handle_add_episode,
    "search": handle_search,
    "get_edges": handle_get_edges,
    "get_edge": handle_get_edge,
    "delete_edge": handle_delete_edge,
    "delete_group": handle_delete_group,
    "shutdown": handle_shutdown,
}


async def handle_request(line: str) -> dict[str, Any]:
    """Parse and dispatch a single JSON-RPC request."""
    try:
        request = json.loads(line)
    except json.JSONDecodeError as e:
        return _err(None, -32700, "Parse error", str(e))

    method = request.get("method")
    params = request.get("params", {})
    req_id = request.get("id")

    if method not in METHODS:
        return _err(req_id, -32601, f"Method not found: {method}")

    try:
        result = await METHODS[method](params)
        return _ok(req_id, result)
    except Exception as e:
        tb = traceback.format_exc()
        return _err(req_id, -32000, str(e), tb)


async def main() -> None:
    """Main loop: read JSON-RPC requests from stdin, write responses to stdout."""
    loop = asyncio.get_event_loop()

    while True:
        line = await loop.run_in_executor(None, _read_line)
        if line is None:
            break

        if not line.strip():
            continue

        response = await handle_request(line)
        _write_response(response)

        # Check if this was a shutdown request
        try:
            req = json.loads(line)
            if req.get("method") == "shutdown":
                break
        except (json.JSONDecodeError, AttributeError):
            pass


if __name__ == "__main__":
    asyncio.run(main())
